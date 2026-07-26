/**
 * `StateService` — the desktop sidecar's real handler for `state.*`
 * commands. Structurally matches the existing handler seams in
 * `./sidecar.ts` (`ScheduleHandler`-style: `handle(cmd) -> events`) so
 * central wiring can drop it straight into `Sidecar`'s `state` option.
 *
 * Unlike every other desktop handler, this one does NOT wrap its own
 * private engine — it drives the REAL `WorkspaceStore` (and, when supplied,
 * the REAL `SyncEngine`/`WorkspaceFeed`) from `src/hades/state/**` against
 * the exact same `<dataDir>/state` root the `hades state` CLI and the TUI
 * use. A `hades state set` run from a terminal shows up here via `state.get`
 * /`state.list` immediately (both read straight off disk, no cache) and,
 * once `state.watch{enabled:true}` is sent (or the caller starts the feed
 * itself), streams out as a `state.changed` push through {@link
 * StateService.subscribe} shortly after — that IS the desktop half of "one
 * shared store, live in the app."
 *
 * ## Never throws, never hangs
 *
 * {@link StateService.handle} always resolves; every failure path (a locked
 * store, a corrupt journal `WorkspaceCorruptError`, an unknown domain, an
 * oversize/non-serializable `state.set` value, a malformed sync policy)
 * becomes a `state.error` carrying the REAL underlying message — never a
 * swallowed error, never a fabricated success. Nothing here starts a timer
 * or opens a handle that isn't torn down by {@link StateService.close}.
 *
 * ## Pagination
 *
 * `state.list` never emits a single unbounded event: results are cut into
 * ordered pages of at most `maxRecordsPerEvent` records each (default
 * {@link DEFAULT_MAX_RECORDS_PER_EVENT}), read once from a single
 * `store.list()` call so a 10k-record domain can never lose or duplicate a
 * key across pages.
 *
 * ## Live delivery
 *
 * When `opts.feed` is supplied, the constructor subscribes to it ONCE and
 * fans every delivered `WorkspaceChange` batch out to this service's own
 * listener set (registered via {@link StateService.subscribe}), converting
 * each change to a `state.changed` event in the exact order the feed
 * delivered it (the feed itself guarantees gap-free, ordered delivery — see
 * `../../hades/state/feed.ts`). The fan-out is `createEventHub`-style: a
 * listener that throws is contained (never breaks another listener or the
 * feed itself), and iterates over a defensive copy of the listener set so a
 * listener that subscribes/unsubscribes mid-dispatch can never corrupt
 * delivery to the others. `state.watch{enabled}` merely toggles whether the
 * underlying feed is actively polling/watching (`feed.start()`/`stop()`);
 * the subscription itself is wired up front and needs no re-arming.
 */

import {
  WORKSPACE_DOMAINS,
  canonicalJson,
  isWorkspaceDomain,
  type JsonValue,
  type WorkspaceRecord,
} from "../../hades/state/record";
import { WorkspaceStore } from "../../hades/state/store";
import type { SyncConflict, SyncEngine, SyncReport } from "../../hades/state/sync";
import type { WorkspaceChange, WorkspaceFeed } from "../../hades/state/feed";
import type {
  StateCommand,
  StateEvent,
  WorkspaceConflictView,
  WorkspaceRecordView,
  WorkspaceStatusView,
} from "../ipc/state-contract";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RECORDS_PER_EVENT = 500;
/** 256 KiB, measured over the value's canonical-JSON encoding. Generous
 *  enough for any real session/memory/config/skill record while still
 *  guarding the shared journal against a single pathological write. */
const DEFAULT_MAX_VALUE_BYTES = 256 * 1024;

const CONFLICT_POLICIES = ["last-writer-wins", "prefer-local", "prefer-remote", "manual"] as const;

export interface StateServiceOptions {
  store: WorkspaceStore;
  sync?: SyncEngine;
  feed?: WorkspaceFeed;
  now?: () => number;
  maxRecordsPerEvent?: number;
  /** Override for the `state.set` value size cap, in bytes of canonical-JSON
   *  encoding. Defaults to {@link DEFAULT_MAX_VALUE_BYTES}. Not part of the
   *  locked handler-seam shape central wiring depends on — every caller that
   *  omits it gets the documented default. */
  maxValueBytes?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

function errorEvent(op: string, message: string): StateEvent {
  return { kind: "state.error", op, message };
}

function toRecordView(r: WorkspaceRecord): WorkspaceRecordView {
  return {
    domain: r.domain,
    key: r.key,
    rev: r.rev,
    updatedAt: r.updatedAt,
    actor: r.actor,
    deleted: r.deleted,
    hash: r.hash,
    value: r.value,
  };
}

function toConflictView(c: SyncConflict): WorkspaceConflictView {
  return {
    domain: c.domain,
    key: c.key,
    localActor: c.local.actor,
    remoteActor: c.remote.actor,
    resolution: c.resolution,
    reason: c.reason,
  };
}

/**
 * `WorkspaceStatusView.root`/`.actor` carry the store's REAL identity, read
 * through `WorkspaceStore`'s public `rootPath` / `actorKeyId` accessors
 * (added during central integration precisely so this file does not have to
 * reach through TypeScript's compile-time-only `private`). Defensive
 * `typeof` checks remain so a hand-rolled test double that only implements
 * part of the surface degrades to an honest empty string rather than
 * throwing mid-status.
 */
function readStoreIdentity(store: WorkspaceStore): { root: string; actor: string } {
  return {
    root: typeof store.rootPath === "string" ? store.rootPath : "",
    actor: typeof store.actorKeyId === "string" ? store.actorKeyId : "",
  };
}

// ---------------------------------------------------------------------------
// StateService
// ---------------------------------------------------------------------------

export class StateService {
  private readonly store: WorkspaceStore;
  private readonly sync?: SyncEngine;
  private readonly feed?: WorkspaceFeed;
  private readonly now: () => number;
  private readonly maxRecordsPerEvent: number;
  private readonly maxValueBytes: number;

  private readonly listeners = new Set<(e: StateEvent) => void>();
  private feedUnsubscribe?: () => void;

  private lastSyncAt: number | null = null;
  private lastConflictCount = 0;

  constructor(opts: StateServiceOptions) {
    if (!opts || !opts.store) throw new RangeError("StateServiceOptions.store is required");
    this.store = opts.store;
    this.sync = opts.sync;
    this.feed = opts.feed;
    this.now = opts.now ?? Date.now;
    this.maxRecordsPerEvent =
      opts.maxRecordsPerEvent !== undefined && opts.maxRecordsPerEvent > 0
        ? Math.floor(opts.maxRecordsPerEvent)
        : DEFAULT_MAX_RECORDS_PER_EVENT;
    this.maxValueBytes = opts.maxValueBytes !== undefined && opts.maxValueBytes > 0 ? opts.maxValueBytes : DEFAULT_MAX_VALUE_BYTES;

    if (this.feed) {
      this.feedUnsubscribe = this.feed.subscribe((batch) => this.onFeedBatch(batch));
    }
  }

  /** Process one command. Never throws, never hangs — every failure path resolves to a `state.error`. */
  async handle(cmd: StateCommand): Promise<StateEvent[]> {
    try {
      switch (cmd.kind) {
        case "state.status":
          return this.handleStatus();
        case "state.list":
          return this.handleList(cmd);
        case "state.get":
          return this.handleGet(cmd);
        case "state.set":
          return this.handleSet(cmd);
        case "state.delete":
          return this.handleDelete(cmd);
        case "state.sync":
          return this.handleSync(cmd);
        case "state.watch":
          return this.handleWatch(cmd);
        default: {
          const exhaustive: never = cmd;
          return exhaustive;
        }
      }
    } catch (err) {
      // Defense in depth: every branch above already has its own try/catch,
      // but a genuinely unexpected throw (e.g. a bug in a future branch)
      // still degrades to an honest state.error instead of an unhandled
      // rejection reaching the caller.
      return [errorEvent((cmd as { kind?: string })?.kind ?? "state", errMsg(err))];
    }
  }

  /**
   * Feed-driven `state.changed` push. Re-entrant-safe (dispatch iterates a
   * defensive copy of the listener set) and a throwing listener never stops
   * delivery to the others. Returns an unsubscribe function; unsubscribing
   * twice, or from inside another listener's callback, is always safe.
   */
  subscribe(emit: (e: StateEvent) => void): () => void {
    this.listeners.add(emit);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(emit);
    };
  }

  /** Tears down the feed subscription and any live feed watcher/timer. Idempotent — safe to call more than once. */
  close(): void {
    if (this.feedUnsubscribe) {
      try {
        this.feedUnsubscribe();
      } catch {
        /* best-effort teardown */
      }
      this.feedUnsubscribe = undefined;
    }
    try {
      this.feed?.stop();
    } catch {
      /* best-effort teardown */
    }
    this.listeners.clear();
  }

  // ── Command handlers ───────────────────────────────────────────────────

  private handleStatus(): StateEvent[] {
    try {
      return [{ kind: "state.status", status: this.buildStatus() }];
    } catch (err) {
      return [errorEvent("state.status", errMsg(err))];
    }
  }

  private handleList(cmd: Extract<StateCommand, { kind: "state.list" }>): StateEvent[] {
    if (!isWorkspaceDomain(cmd.domain)) {
      return [errorEvent("state.list", `unknown workspace domain "${cmd.domain}"`)];
    }
    try {
      const records = this.store.list(cmd.domain, cmd.prefix !== undefined ? { prefix: cmd.prefix } : {});
      const views = records.map(toRecordView);
      if (views.length === 0) {
        return [{ kind: "state.records", domain: cmd.domain, records: [] }];
      }
      const events: StateEvent[] = [];
      for (let i = 0; i < views.length; i += this.maxRecordsPerEvent) {
        events.push({ kind: "state.records", domain: cmd.domain, records: views.slice(i, i + this.maxRecordsPerEvent) });
      }
      return events;
    } catch (err) {
      return [errorEvent("state.list", errMsg(err))];
    }
  }

  private handleGet(cmd: Extract<StateCommand, { kind: "state.get" }>): StateEvent[] {
    if (!isWorkspaceDomain(cmd.domain)) {
      return [errorEvent("state.get", `unknown workspace domain "${cmd.domain}"`)];
    }
    try {
      const record = this.store.get(cmd.domain, cmd.key);
      return [{ kind: "state.records", domain: cmd.domain, records: record ? [toRecordView(record)] : [] }];
    } catch (err) {
      return [errorEvent("state.get", errMsg(err))];
    }
  }

  private handleSet(cmd: Extract<StateCommand, { kind: "state.set" }>): StateEvent[] {
    if (!isWorkspaceDomain(cmd.domain)) {
      return [errorEvent("state.set", `unknown workspace domain "${cmd.domain}"`)];
    }

    let canonical: string;
    try {
      // `canonicalJson` is the same strict validator `WorkspaceStore.put`
      // itself uses — rejects NaN/±Infinity/-0/undefined/bigint/cycles/
      // functions with a precise message instead of ever reaching the
      // store with a value that could corrupt a segment or hash mismatch
      // later. Validated BEFORE any write is attempted.
      canonical = canonicalJson(cmd.value as JsonValue);
    } catch (err) {
      return [errorEvent("state.set", `value is not a valid JSON value: ${errMsg(err)}`)];
    }

    const bytes = Buffer.byteLength(canonical, "utf8");
    if (bytes > this.maxValueBytes) {
      return [errorEvent("state.set", `value exceeds the ${this.maxValueBytes}-byte size cap (was ${bytes} bytes)`)];
    }

    try {
      const record = this.store.put(cmd.domain, cmd.key, cmd.value as JsonValue);
      return [{ kind: "state.records", domain: cmd.domain, records: [toRecordView(record)] }];
    } catch (err) {
      return [errorEvent("state.set", errMsg(err))];
    }
  }

  private handleDelete(cmd: Extract<StateCommand, { kind: "state.delete" }>): StateEvent[] {
    if (!isWorkspaceDomain(cmd.domain)) {
      return [errorEvent("state.delete", `unknown workspace domain "${cmd.domain}"`)];
    }
    try {
      const record = this.store.delete(cmd.domain, cmd.key);
      return [{ kind: "state.records", domain: cmd.domain, records: record ? [toRecordView(record)] : [] }];
    } catch (err) {
      return [errorEvent("state.delete", errMsg(err))];
    }
  }

  private handleSync(cmd: Extract<StateCommand, { kind: "state.sync" }>): StateEvent[] {
    if (!this.sync) {
      return [errorEvent("state.sync", "sync is not configured for this desktop build")];
    }
    if (cmd.policy !== undefined && !(CONFLICT_POLICIES as readonly string[]).includes(cmd.policy)) {
      return [errorEvent("state.sync", `unknown sync policy "${cmd.policy}" (expected one of: ${CONFLICT_POLICIES.join(", ")})`)];
    }
    try {
      const report: SyncReport = cmd.dryRun ? this.sync.plan() : this.sync.reconcile();
      const conflicts = report.conflicts.map(toConflictView);
      this.lastSyncAt = report.at;
      this.lastConflictCount = conflicts.length;
      return [
        {
          kind: "state.synced",
          pulled: report.pulled.length,
          pushed: report.pushed.length,
          conflicts,
          dryRun: !!cmd.dryRun,
          at: report.at,
        },
      ];
    } catch (err) {
      return [errorEvent("state.sync", errMsg(err))];
    }
  }

  private handleWatch(cmd: Extract<StateCommand, { kind: "state.watch" }>): StateEvent[] {
    if (!this.feed) {
      return [errorEvent("state.watch", "live feed is not configured for this desktop build")];
    }
    try {
      if (cmd.enabled) this.feed.start();
      else this.feed.stop();
      return [];
    } catch (err) {
      return [errorEvent("state.watch", errMsg(err))];
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────

  private buildStatus(): WorkspaceStatusView {
    const snapshot = this.store.snapshot();
    const chain = this.store.verifyChain();
    const perDomain = WORKSPACE_DOMAINS.map((domain) => {
      const live = this.store.list(domain, {});
      let lastUpdatedAt = 0;
      for (const r of live) if (r.updatedAt > lastUpdatedAt) lastUpdatedAt = r.updatedAt;
      return { domain, records: live.length, lastUpdatedAt };
    });
    const { root, actor } = readStoreIdentity(this.store);
    return {
      root,
      actor,
      journalSeq: snapshot.journalSeq,
      head: snapshot.head,
      chainOk: chain.ok,
      perDomain,
      lastSyncAt: this.lastSyncAt,
      conflicts: this.lastConflictCount,
    };
  }

  // ── Live feed fan-out ───────────────────────────────────────────────────

  private onFeedBatch(batch: WorkspaceChange[]): void {
    for (const change of batch) {
      this.dispatch({
        kind: "state.changed",
        seq: change.seq,
        actor: change.actor,
        records: change.records.map(toRecordView),
      });
    }
  }

  private dispatch(ev: StateEvent): void {
    // Defensive copy: a listener that subscribes/unsubscribes (including
    // unsubscribing itself) while being called must never corrupt delivery
    // to the rest of the set, and a throwing listener must never stop it.
    for (const cb of [...this.listeners]) {
      try {
        cb(ev);
      } catch {
        /* one bad subscriber must never break another, or the feed */
      }
    }
  }
}
