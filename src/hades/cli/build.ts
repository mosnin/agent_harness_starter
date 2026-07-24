import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HadesCli } from "./cli";
import type { CliResult } from "./cli";
import type { HadesConfig } from "../config/config";
import { defaultModelRegistry } from "../models/defaults";
import { ModelCommand } from "../models/command";
import { InMemoryModelSelection, FileModelSelection } from "../models/selection";
import { defaultPluginRegistry } from "../plugins/registry";
import { builtinSkillPackCatalog } from "../skill-packs/builtin";
import { InMemoryMemoryStore, FileMemoryStore, type MemoryStore } from "../memory/store";
import { InMemorySessionStore, FileSessionStore, type SessionStore } from "../memory/session-store";
import { GuardedMemoryStore, type FlaggedWrite } from "../memory/guard";
import { SessionSummarizer } from "../memory/summarizer";
import { UserModelStore, ProfileMemoryBridge } from "../memory/user-model-store";
import type { ProfileCommandDeps } from "./profile-command";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTrajectoryStore } from "../research/recorder";
import { defaultRoleRegistry } from "../teams/role";
import { defaultToolsetManager } from "../tools/default-catalog";
import type { ToolsetManager } from "../tools/manager";
import type { BackendsCommandDeps, BanditStateStore } from "./backends-command";
import type { RouteBanditState } from "../backends/route-bandit";
import { BackendManager } from "../backends/manager";
import type { BackendDescriptor } from "../backends/descriptor";
import { LocalProcessBackend } from "../backends/local";
import { DockerBackend } from "../backends/docker";
import { BackendProvenanceLedger, ledgerEventSink } from "../backends/provenance";
import { HandleStore } from "../backends/handle-store";

export const HADES_VERSION = "0.1.0";

/**
 * A {@link GuardedMemoryStore} whose quarantine flags survive across
 * processes: every raised flag and every resolution is written (atomically —
 * temp file + rename, matching FileMemoryStore/FileSessionStore) to
 * `<dataDir>/memory-flags.json` and rehydrated on construction. Without
 * this, the CLI's "resolve with: hades memory flags resolve <id>" hint would
 * be a lie — each `hades` invocation is a fresh process, so an in-memory
 * flag raised by `memory add` would already be gone.
 */
class FileGuardedMemoryStore extends GuardedMemoryStore {
  constructor(inner: MemoryStore, private readonly path: string) {
    super(inner, { restoreFlags: FileGuardedMemoryStore.load(path) });
  }

  private static load(path: string): FlaggedWrite[] {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Shape-check each entry; a malformed file degrades to "no flags"
      // rather than crashing the CLI (same leniency as FileMemoryStore).
      return parsed.filter(
        (f): f is FlaggedWrite =>
          typeof f === "object" &&
          f !== null &&
          typeof (f as FlaggedWrite).id === "string" &&
          typeof (f as FlaggedWrite).at === "number" &&
          typeof (f as FlaggedWrite).candidate === "object" &&
          typeof (f as FlaggedWrite).verdict === "object",
      );
    } catch {
      return []; // absent or unreadable -> fresh
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* exists */
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.flags()));
    renameSync(tmp, this.path);
  }

  override addChecked(input: Parameters<MemoryStore["add"]>[0]): ReturnType<GuardedMemoryStore["addChecked"]> {
    const result = super.addChecked(input);
    if (result.flagged) this.persist();
    return result;
  }

  override resolve(flagId: string, resolution: "accept-new" | "keep-existing" | "supersede"): boolean {
    const ok = super.resolve(flagId, resolution);
    if (ok) this.persist();
    return ok;
  }
}

/**
 * File-backed persistence for the routing bandit's learned history
 * (`hades backends route`). Atomic write (temp file + rename, same
 * convention as every other store in this file); an absent or unreadable
 * file loads as `undefined`, which `CostAwareRouteBandit.fromState`
 * treats as a fresh, empty history.
 */
function fileBanditStore(path: string): BanditStateStore {
  return {
    load(): unknown {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as unknown;
      } catch {
        return undefined; // absent or unreadable -> fresh history
      }
    },
    save(state: RouteBanditState): void {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch {
        /* exists */
      }
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, path);
    },
  };
}

export interface BuildCliOptions {
  /** Override the memory store (default: file-backed at config.memoryPath).
   *  The store is always wrapped in the STYX {@link GuardedMemoryStore} so
   *  every write passes the contradiction gate. */
  memory?: MemoryStore;
  /** Override the session store (default: file-backed at `<dataDir>/sessions.json`). */
  sessions?: SessionStore;
  /** Optional LLM summarize hook for `hades memory summarize`. Absent, the
   *  summarizer runs its real extractive algorithm and says so (`mode:
   *  extractive`) — no LLM output is ever faked. */
  llmSummarize?: (prompt: string) => Promise<string>;
  /** Persist model selection + memory + tool state to disk (default true).
   *  Off for tests. */
  persist?: boolean;
  /** Override the toolset manager (default: the full shipped catalog with
   *  enable/disable state at `<dataDir>/tools.json` when persisting). */
  toolset?: ToolsetManager;
  onChat?: (args: string[]) => Promise<CliResult> | CliResult;
  onGateway?: (args: string[]) => Promise<CliResult> | CliResult;
}

/**
 * Wire a fully-featured {@link HadesCli} from resolved config: the built-in model
 * catalog (with the config's default marked), the plugin + skill-pack catalogs,
 * a memory store (file-backed by default, in-memory when `persist` is false),
 * and a trajectory store. This is what the `hades` bin calls; tests call it with
 * `persist: false` to avoid touching disk.
 */
export function buildHadesCli(config: HadesConfig, opts: BuildCliOptions = {}): HadesCli {
  const persist = opts.persist ?? true;

  const registry = defaultModelRegistry(config.model);
  const selection = persist
    ? new FileModelSelection(`${config.dataDir}/model.json`)
    : new InMemoryModelSelection();
  const models = new ModelCommand(registry, selection);

  const baseMemory =
    opts.memory ??
    (persist && config.memoryPath ? new FileMemoryStore(config.memoryPath) : new InMemoryMemoryStore());
  // Every write goes through the STYX contradiction gate; contradicted facts
  // are quarantined as flags (surfaced via `hades memory flags`), never
  // silently overwriting existing memory. When persisting, flags survive
  // across processes so a quarantine raised by one `hades` invocation can be
  // resolved by a later one.
  const memory = persist
    ? new FileGuardedMemoryStore(baseMemory, `${config.dataDir}/memory-flags.json`)
    : new GuardedMemoryStore(baseMemory);

  const sessions =
    opts.sessions ??
    (persist ? new FileSessionStore(`${config.dataDir}/sessions.json`) : new InMemorySessionStore());

  const summarizer = new SessionSummarizer({ llm: opts.llmSummarize });

  const toolset =
    opts.toolset ??
    defaultToolsetManager({
      statePath: persist ? `${config.dataDir}/tools.json` : undefined,
    });

  // Phase-5 dialectic user model (`hades profile`). Lazy: the store (and its
  // on-disk profile at <dataDir>/user-model.json) is only opened when a
  // profile subcommand actually runs. Without persistence the profile lives
  // in a fresh temp dir for the life of the process — real files, real
  // atomic saves, but nothing written into the user's data dir.
  const profile = (): ProfileCommandDeps => {
    const profilePath = persist
      ? `${config.dataDir}/user-model.json`
      : join(mkdtempSync(join(tmpdir(), "hades-profile-")), "user-model.json");
    const store = new UserModelStore({ path: profilePath });
    const bridge = new ProfileMemoryBridge({
      store,
      memory,
      // MEMORY.md write-back only when persisting into a real data dir.
      ...(persist ? { dataDir: config.dataDir } : {}),
    });
    return { store, bridge, sessions };
  };

  // Phase-6 remote-compute fleet (`hades backends`). Lazy: the BackendManager,
  // the STYX provenance ledger, and both real backend classes are only
  // constructed when a backends subcommand actually runs (`hades help` never
  // touches them). Both backends are REAL adapters — local spawns genuine OS
  // child processes; docker shells out to the real `docker` CLI, and its live
  // availability is decided by `probe`'s real `docker version` call, never
  // assumed. Cost rates are all-zero and tagged `source: "configured"` (your
  // own machine — no fabricated prices). Every manager lifecycle event is
  // appended to the hash-chained ledger `hades backends verify` re-walks.
  const backends = (): BackendsCommandDeps => {
    const ledger = new BackendProvenanceLedger();
    const manager = new BackendManager({ onEvent: ledgerEventSink(ledger) });
    const zeroCost = {
      perRunningHourUsd: 0,
      perHibernatedHourUsd: 0,
      perProvisionUsd: 0,
      source: "configured" as const,
    };
    const localDescriptor: BackendDescriptor = {
      name: "local",
      kind: "local",
      capabilities: ["shell", "local", "node"],
      cost: zeroCost,
      supportsHibernate: true,
      locality: "local",
    };
    const dockerDescriptor: BackendDescriptor = {
      name: "docker",
      kind: "container",
      capabilities: ["docker", "container"],
      cost: zeroCost,
      supportsHibernate: true,
      locality: "local",
    };
    manager.register(new LocalProcessBackend({ name: "local" }), localDescriptor);
    manager.register(new DockerBackend({ name: "docker" }), dockerDescriptor);
    return {
      manager,
      ledger,
      ...(persist ? { store: new HandleStore({ path: `${config.dataDir}/fleet.json` }) } : {}),
      ...(persist ? { banditStore: fileBanditStore(`${config.dataDir}/route-bandit.json`) } : {}),
    };
  };

  return new HadesCli({
    version: HADES_VERSION,
    models,
    plugins: defaultPluginRegistry(),
    skillPacks: builtinSkillPackCatalog(),
    memory,
    sessions,
    memoryGuard: memory,
    profile,
    backends,
    // `hades skills hub` reads/writes the same on-disk skill library
    // `hades skill` manages ($HADES_SKILLS_DIR wins, matching skills-command).
    skillsDir: process.env.HADES_SKILLS_DIR ?? `${config.dataDir}/skills`,
    summarizeSession: async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`No such session: ${sessionId}`);
      const { summary, mode } = await summarizer.summarize(session);
      return { summary, mode };
    },
    trajectories: new InMemoryTrajectoryStore(),
    roles: defaultRoleRegistry(),
    toolset,
    onChat: opts.onChat,
    onGateway: opts.onGateway,
  });
}
