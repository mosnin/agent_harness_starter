/**
 * Central wiring for the shared workspace store.
 *
 * `record.ts`/`store.ts`/`feed.ts`/`sync.ts`/`domains.ts` are deliberately
 * dependency-light building blocks. This module is the one place that
 * assembles them into the concrete stack every SURFACE uses, so the
 * `hades state` CLI, the desktop sidecar, and anything added later all open
 * the SAME `<dataDir>/state` root, under a STABLE per-surface actor
 * identity, over the SAME real engine adapters. Without this, each surface
 * would hand-roll its own root/actor and the "one shared workspace" claim
 * would be a coincidence rather than a guarantee.
 *
 * ## Why the actor id is persisted
 *
 * A `WorkspaceRecord`'s vector clock is keyed by actor. If every `hades
 * state set` invocation minted a fresh actor id (a pid, a uuid), the clock
 * on a hot key would grow without bound and two writes from the same
 * terminal would look causally concurrent to each other. So each surface
 * gets ONE durable identity per workspace root, minted once and persisted
 * at `<root>/actors/<kind>.json`; the clock then carries at most one entry
 * per (surface, machine). `HADES_STATE_ACTOR_ID` overrides it for anyone
 * who wants to pin an identity explicitly (CI, a shared NFS root, tests).
 */

import { hostname, userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DRAFT_ACTOR_KIND,
  isActorKind,
  type ActorId,
  type ActorKind,
} from "./record";
import { WorkspaceStore } from "./store";
import { WorkspaceFeed } from "./feed";
import { InMemoryMirror, SyncEngine, type ConflictPolicy } from "./sync";
import { allAdapters, workspaceRoot, type DomainAdapter, type WorkspaceDeps } from "./domains";
import { loadConfig, type HadesConfig } from "../config/config";

export { workspaceRoot } from "./domains";

// ---------------------------------------------------------------------------
// Actor identity
// ---------------------------------------------------------------------------

/** Filesystem-safe, bounded slug for the machine/user part of a minted actor id. */
function hostSlug(): string {
  let raw = "";
  try {
    raw = `${hostname()}-${userInfo().username}`;
  } catch {
    raw = "";
  }
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug.length > 0 ? slug : "host";
}

function actorFilePath(root: string, kind: ActorKind): string {
  return join(root, "actors", `${kind}.json`);
}

/**
 * The subset of an environment this module reads. Deliberately the same
 * shape `loadConfig`/`configFromEnv` accept (`Record<string, string |
 * undefined>`) rather than `NodeJS.ProcessEnv`, so a caller can pass a small
 * literal for a deterministic test without having to fabricate `NODE_ENV`.
 */
export type WorkspaceEnv = Record<string, string | undefined>;

export interface ResolveActorOptions {
  /** The workspace root (see {@link workspaceRoot}). */
  root: string;
  /** Which surface is asking. Never `"draft"` — that kind is non-persistable. */
  kind: Exclude<ActorKind, typeof DRAFT_ACTOR_KIND>;
  env?: WorkspaceEnv;
  /** Injectable id source, for deterministic tests. */
  mintId?: () => string;
}

/**
 * Resolve this surface's durable {@link ActorId} for a workspace root,
 * minting and persisting one on first use.
 *
 * Precedence: `HADES_STATE_ACTOR_ID` (explicit pin) > the id persisted at
 * `<root>/actors/<kind>.json` > a freshly minted `"<host>-<random>"` id,
 * which is then persisted atomically (tmp + rename). Any failure to read or
 * write that file degrades to an in-process-only id rather than throwing:
 * a read-only or full disk must never make `hades state status` unusable,
 * and the only cost is an extra clock entry for this run.
 */
export function resolveWorkspaceActor(opts: ResolveActorOptions): ActorId {
  const env = opts.env ?? process.env;
  const kind = opts.kind;

  const pinned = env.HADES_STATE_ACTOR_ID;
  if (typeof pinned === "string" && pinned.trim().length > 0) {
    return { kind, id: pinned.trim() };
  }

  const path = actorFilePath(opts.root, kind);
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object") {
        const rec = parsed as { kind?: unknown; id?: unknown };
        if (typeof rec.id === "string" && rec.id.length > 0 && isActorKind(rec.kind) && rec.kind === kind) {
          return { kind, id: rec.id };
        }
      }
    }
  } catch {
    // Unreadable/corrupt identity file — fall through and mint a fresh one
    // rather than failing the command outright.
  }

  const mint = opts.mintId ?? (() => `${hostSlug()}-${randomBytes(4).toString("hex")}`);
  const id = mint();
  try {
    mkdirSync(join(opts.root, "actors"), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ kind, id }), "utf8");
    renameSync(tmp, path);
  } catch {
    // Best effort: an unpersisted identity still works for this process.
  }
  return { kind, id };
}

// ---------------------------------------------------------------------------
// Config access (the `config` domain's engine side)
// ---------------------------------------------------------------------------

/**
 * File-backed `{ load, write }` pair for `configAdapter`, over
 * `<dataDir>/config.json`.
 *
 * `load()` returns the FULLY RESOLVED config (`loadConfig` layering
 * defaults < file < env), which is what the config domain is meant to
 * mirror. `write()` only ever persists the file layer, shallow-merged with
 * whatever is already on disk — so importing a config record can never
 * silently bake an environment-supplied value into the user's config file.
 * Writes are atomic (tmp + rename), matching every other store here.
 */
export function fileConfigAccess(
  dataDir: string,
  env: WorkspaceEnv = process.env,
): { load(): HadesConfig; write(next: Partial<HadesConfig>): void } {
  const path = join(dataDir, "config.json");

  const readFileLayer = (): Partial<HadesConfig> => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<HadesConfig>) : {};
    } catch {
      return {};
    }
  };

  return {
    load(): HadesConfig {
      return loadConfig({ file: readFileLayer(), env });
    },
    write(next: Partial<HadesConfig>): void {
      const merged: Partial<HadesConfig> = { ...readFileLayer(), ...next };
      mkdirSync(dataDir, { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
      renameSync(tmp, path);
    },
  };
}

// ---------------------------------------------------------------------------
// The assembled stack
// ---------------------------------------------------------------------------

export interface WorkspaceStackOptions {
  dataDir: string;
  /** Which surface owns this stack. */
  kind: Exclude<ActorKind, typeof DRAFT_ACTOR_KIND>;
  env?: WorkspaceEnv;
  now?: () => number;
  /** Real engine stores for the `sessions`/`memory` domains. Omitted, those
   *  domains simply have no adapter — never a fabricated empty engine. */
  sessions?: WorkspaceDeps["sessions"];
  memory?: WorkspaceDeps["memory"];
  /** Override the config domain's engine side; defaults to {@link fileConfigAccess}. */
  config?: WorkspaceDeps["config"];
  skillsDir?: string;
  /** Conflict policy for the assembled `SyncEngine`. */
  policy?: ConflictPolicy;
  /** Feed consumer name; must be a valid workspace key (validated by `WorkspaceFeed`). */
  consumer?: string;
  /** Passed through to `WorkspaceFeed` — `false` keeps it interval-only. */
  watch?: boolean;
  onFeedError?: (e: Error) => void;
}

export interface WorkspaceStack {
  root: string;
  actor: ActorId;
  store: WorkspaceStore;
  feed: WorkspaceFeed;
  sync: SyncEngine;
  mirror: InMemoryMirror;
  adapters: DomainAdapter[];
  deps: WorkspaceDeps;
  /** Stops the feed and closes the store. Idempotent, best-effort, never throws. */
  close(): void;
}

/**
 * Build the whole workspace stack for one surface: the durable
 * `WorkspaceStore` at `<dataDir>/state`, a `WorkspaceFeed` over it, a
 * `SyncEngine` (with a fresh `InMemoryMirror`), and the real engine domain
 * adapters. Every piece is the REAL implementation — there is no in-memory
 * or stubbed mode here; a caller that wants isolation points `dataDir` at a
 * temp directory.
 */
export function createWorkspaceStack(opts: WorkspaceStackOptions): WorkspaceStack {
  const env = opts.env ?? process.env;
  const root = workspaceRoot(opts.dataDir);
  mkdirSync(root, { recursive: true });

  const actor = resolveWorkspaceActor({ root, kind: opts.kind, env });
  const store = new WorkspaceStore({ root, actor, ...(opts.now ? { now: opts.now } : {}) });

  const deps: WorkspaceDeps = {
    dataDir: opts.dataDir,
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    config: opts.config ?? fileConfigAccess(opts.dataDir, env),
    ...(opts.skillsDir ? { skillsDir: opts.skillsDir } : {}),
  };
  const adapters = allAdapters(deps);

  const feed = new WorkspaceFeed({
    store,
    root,
    // Hyphen-joined, not colon-joined: the consumer name becomes a real
    // filename under `<root>/cursors/`, and a colon is not a legal path
    // character on Windows.
    consumer: opts.consumer ?? `${opts.kind}-${actor.id}`,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.watch !== undefined ? { watch: opts.watch } : {}),
    ...(opts.onFeedError ? { onError: opts.onFeedError } : {}),
  });

  const mirror = new InMemoryMirror();
  const sync = new SyncEngine({
    store,
    mirror,
    actor,
    policy: opts.policy ?? "last-writer-wins",
    ...(opts.now ? { now: opts.now } : {}),
  });

  let closed = false;
  return {
    root,
    actor,
    store,
    feed,
    sync,
    mirror,
    adapters,
    deps,
    close(): void {
      if (closed) return;
      closed = true;
      try {
        feed.stop();
      } catch {
        /* best-effort teardown */
      }
      try {
        store.close();
      } catch {
        /* best-effort teardown */
      }
    },
  };
}
