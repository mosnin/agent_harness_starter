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
import { defaultScheduleDeps } from "./schedule-command";
import type { ScheduleCommandDeps } from "./schedule-command";
import type { StateCommandDeps } from "./state-command";
import { defaultMigrateDeps } from "./migrate-command";
import type { MigrateCommandDeps } from "./migrate-command";
import { defaultTrustDeps } from "./trust-command";
import type { TrustCommandDeps } from "./trust-command";
import { defaultMarketDeps } from "./market-command";
import type { MarketCommandDeps } from "./market-command";
import { defaultRouteDeps } from "./route-command";
import type { RouteCommandDeps } from "./route-command";
import { SecretVault } from "../migrate/secrets";
import { fileConfigAccess, resolveWorkspaceActor, workspaceRoot } from "../state/wiring";
import { allAdapters } from "../state/domains";
import type { RouteBanditState } from "../backends/route-bandit";
import { BackendManager } from "../backends/manager";
import type { BackendDescriptor } from "../backends/descriptor";
import { LocalProcessBackend } from "../backends/local";
import { DockerBackend } from "../backends/docker";
import { BackendProvenanceLedger, ledgerEventSink } from "../backends/provenance";
import { HandleStore } from "../backends/handle-store";
import { FileLearningStatusStore } from "../backends/learning-status-store";

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
      // `hades backends learn` reads the SAME durable snapshot the desktop
      // sidecar's learning loop persists (<dataDir>/learning-status.json) —
      // one learning history, two surfaces. A `hades` invocation has no live
      // in-process loop, so `learn` reports the snapshot (or, honestly,
      // nothing). Without persistence there is no store to read; the command
      // reports it as unconfigured rather than fabricating an empty status.
      ...(persist
        ? { learn: { store: new FileLearningStatusStore({ path: `${config.dataDir}/learning-status.json` }) } }
        : {}),
    };
  };

  // Phase-9 scheduler (`hades schedule`). Lazy: the on-disk job store is only
  // opened when a schedule subcommand actually runs. The store lives at
  // <dataDir>/schedule.json (the resolved config's data dir, not a second
  // env-only convention); without persistence it lives in a fresh temp dir
  // for the life of the process — real files, real atomic saves + corruption
  // quarantine, but nothing written into the user's data dir (same pattern
  // as the profile store above). Executor/deliverer wiring stays exactly
  // `defaultScheduleDeps()`'s honest defaults: the builtin `note` executor
  // (no verification evidence, so nothing is ever delivered as "verified")
  // and a zero-sender VerifiedDeliveryRouter — `hades schedule status`
  // reports both facts truthfully until gateway connectors are attached.
  const schedule = (): ScheduleCommandDeps =>
    defaultScheduleDeps({
      ...process.env,
      HADES_DATA_DIR: persist ? config.dataDir : mkdtempSync(join(tmpdir(), "hades-schedule-")),
    });

  // The shared workspace store (`hades state`). Lazy: `<dataDir>/state` is
  // only opened — and its cross-process lock only taken — when a state
  // subcommand actually runs. This is the SAME root the desktop sidecar's
  // `state.*` IPC lane opens, under a STABLE persisted `cli` actor identity
  // (see ../state/wiring.ts), so a `hades state set` in a terminal and the
  // desktop app are genuinely two writers on one CRDT journal, not two
  // copies. Adapters are bound to the REAL stores built above — the same
  // `memory`/`sessions` instances every other subcommand uses — so
  // `hades state export` mirrors what the agent actually remembers, never a
  // fresh empty engine. Without persistence the workspace lives in a throwaway
  // temp dir (real files, real locking, nothing in the user's data dir),
  // matching the profile/schedule stores above.
  // Resolved on first use, not at build time: a non-persisting build must not
  // create a temp dir on every `buildHadesCli` call (every test does one),
  // only when a state subcommand actually runs. Memoized so repeated
  // subcommands in one process share the same throwaway workspace.
  let stateDataDir: string | undefined;
  const resolveStateDataDir = (): string => {
    if (stateDataDir === undefined) {
      stateDataDir = persist ? config.dataDir : mkdtempSync(join(tmpdir(), "hades-state-"));
    }
    return stateDataDir;
  };
  const state = (): StateCommandDeps => {
    const dir = resolveStateDataDir();
    const root = workspaceRoot(dir);
    const deps = {
      dataDir: dir,
      sessions,
      memory,
      config: fileConfigAccess(dir, process.env),
      skillsDir: process.env.HADES_SKILLS_DIR ?? `${dir}/skills`,
    };
    return {
      root,
      actor: resolveWorkspaceActor({ root, kind: "cli", env: process.env }),
      deps,
      adapters: allAdapters(deps),
    };
  };

  // Migration off a real Hermes/OpenClaw install (`hades migrate`). Lazy: no
  // filesystem probing for foreign installs happens until a migrate
  // subcommand actually runs. Crucially, the applier is bound to THE SAME
  // engine handles every other subcommand uses — the guarded memory store
  // (so imported facts go through the STYX contradiction gate and land in
  // `hades memory flags` when quarantined, never force-written), the same
  // session store, the same file-backed config/model selection, and the same
  // skill library `hades skill`/`hades skills hub` manage. Without
  // persistence everything is redirected into a throwaway temp data dir
  // (real files, real receipts, nothing in the user's data dir), matching the
  // profile/schedule/state stores above.
  let migrateDataDir: string | undefined;
  const resolveMigrateDataDir = (): string => {
    if (migrateDataDir === undefined) {
      migrateDataDir = persist ? config.dataDir : mkdtempSync(join(tmpdir(), "hades-migrate-"));
    }
    return migrateDataDir;
  };
  const migrate = (): MigrateCommandDeps => {
    const dataDir = resolveMigrateDataDir();
    const now = () => Date.now();
    return {
      ...defaultMigrateDeps(process.env),
      dataDir,
      deps: () => ({
        dataDir,
        memory,
        guard: memory,
        sessions,
        config: fileConfigAccess(dataDir, process.env),
        modelSelection: selection,
        skillsDir: process.env.HADES_SKILLS_DIR ?? `${dataDir}/skills`,
        contextFilesDir: `${dataDir}/context-files`,
        secretsPath: `${dataDir}/secrets.env`,
        secrets: new SecretVault(),
        now,
        knownModelIds: registry.list().map((m) => m.id),
      }),
    };
  };

  // The unified trust gate (`hades trust`). Lazy: the ed25519 signing key is
  // neither read nor minted, the hash-chained budget ledger is not opened,
  // and the persisted per-domain conformal calibration is not loaded until a
  // trust subcommand actually runs. Everything lives under
  // `<dataDir>/trust/` — the SAME data dir every other surface uses, and the
  // SAME root the desktop `trust.*` sidecar lane opens — so a certificate
  // issued by `hades trust admit` in a terminal verifies in the desktop app,
  // and both spend from one budget chain rather than two private copies.
  // Without persistence the whole stack is redirected into a throwaway temp
  // data dir (real key file, real ledger, real calibration file — just not in
  // the user's data dir), matching the profile/schedule/state/migrate stores
  // above. Memoized so `calibrate` then `admit` in one process share it.
  let trustDataDir: string | undefined;
  const resolveTrustDataDir = (): string => {
    if (trustDataDir === undefined) {
      trustDataDir = persist ? config.dataDir : mkdtempSync(join(tmpdir(), "hades-trust-"));
    }
    return trustDataDir;
  };
  const trust = (): TrustCommandDeps => defaultTrustDeps(process.env, { dataDir: resolveTrustDataDir() });

  // The verified-work market (`hades market`). Rooted at the SAME data dir —
  // deliberately, because `<dataDir>/trust/signing-key` is the identity whose
  // certificates this market accepts. Sharing the dir is what makes a
  // certificate minted by `hades trust admit` spend as real money here (and
  // in the desktop `market.*` lane) instead of being re-derived or trusted on
  // a boolean. Lazy for the same reason as `trust`: no ledger is deserialized
  // and no key is read until a market subcommand actually runs. Without
  // persistence it is redirected into the same throwaway temp dir the trust
  // stack uses, so the two still agree on the key inside one process.
  const market = (): MarketCommandDeps => defaultMarketDeps(process.env, { dataDir: resolveTrustDataDir() });

  // The budget-constrained router (`hades route`). Rooted at the SAME data
  // dir as the trust gate and the market, so a routing decision recorded in a
  // terminal is the same decision the desktop `route.*` lane and the TUI
  // ROUTE pane read: one arm catalog, one measured cost model, one budget,
  // one hash-chained routing ledger. Lazy for the same reason as `market`:
  // nothing under `<dataDir>/routing` is read until a route subcommand runs.
  const route = (): RouteCommandDeps => defaultRouteDeps(process.env, { dataDir: resolveTrustDataDir() });

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
    schedule,
    state,
    migrate,
    trust,
    market,
    route,
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
