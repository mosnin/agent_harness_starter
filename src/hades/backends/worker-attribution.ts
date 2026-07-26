/**
 * WorkerAttributionRegistry — the durable answer to "which backend is this
 * worker actually running on?"
 *
 * The swarm core (`../../swarm-runtime/manager/manager.ts`) dispatches a
 * `WorkerTask` to a `workerId` (see `WorkerTask.assignedTo` /
 * `WorkerResult.workerId` in `../../swarm-runtime/types`), but nothing on
 * that path records which CONTAINER PROVIDER / backend actually spawned that
 * worker. `SwarmOutcomeFeed` (`./outcome-feed.ts`) needs exactly that
 * mapping — its `resolveBackend: (task: WorkerTask) => string | undefined`
 * option — to attribute cost/verification outcomes to a backend for
 * `CostAwareRouteBandit`. This module is the missing map, plus enough
 * persistence discipline to survive a process restart, and
 * {@link resolveBackendForTask} is the literal `resolveBackend` function
 * `SwarmOutcomeFeed` requires.
 *
 * This module reimplements nothing from `./manager.ts`'s
 * `RemoteBackendRegistry` — `WorkerAttributionRegistry` tracks a much
 * smaller fact (workerId -> backend NAME, not a whole `RemoteHandle`) and is
 * meant to sit ALONGSIDE it, populated by `./fleet-provider.ts`'s
 * `AttributedContainerProvider` as workers are actually spawned on the real
 * `LocalProcessProvider`/`DockerProvider` path (`../../swarm-runtime/types`'
 * `ContainerProvider`).
 *
 * ## Duplicate-id discipline
 *
 * Recording a `workerId` that already maps to a DIFFERENT backend is treated
 * as a programmer bug — the same backstop `RemoteBackendRegistry.adopt`
 * (`./backend.ts`) applies to a workerId that is already live: throw rather
 * than silently overwrite, because a worker id colliding across backends
 * means something upstream double-assigned an id. Re-recording the SAME
 * `(workerId, backend)` pair is a harmless no-op (retries, re-attach) and
 * never throws.
 *
 * ## Persistence
 *
 * `persist()`/`restore()` are best-effort and NEVER throw, mirroring
 * `FleetSupervisor.persist()`/`.restore()` (`./fleet-supervisor.ts`) and
 * `BanditRoutedProvisioner`'s save discipline (`./bandit-provisioner.ts`): a
 * failed save is reported honestly as `{ saved: false, error }`, and
 * `restore()` counts (and drops) individually malformed entries rather than
 * refusing to load the rest of an otherwise-good snapshot — the same
 * defensive discipline as `CostAwareRouteBandit.fromState`
 * (`./route-bandit.ts`).
 */

import type { WorkerTask } from "../../swarm-runtime/types";

// ===========================================================================
// Public types
// ===========================================================================

export const ATTRIBUTION_STATE_VERSION = 1;

/** One durable attribution record: which backend a worker is/was running on. */
export interface AttributionEntry {
  backend: string;
  /** ms timestamp (injected clock) this entry was last written. */
  at: number;
  /** Native container/process id on that backend, when known. */
  nativeId?: string;
}

export interface AttributionState {
  version: number;
  entries: Record<string, AttributionEntry>;
}

/**
 * Persistence seam for {@link WorkerAttributionRegistry}. Deliberately
 * Promise-returning (like `BanditSnapshotStore` in `./bandit-provisioner.ts`
 * and `AttributionStore.load()`'s `unknown` return below) so a real async
 * store (file I/O, a remote KV) can be plugged in directly; a synchronous
 * in-memory fake can always satisfy this by wrapping its return values in
 * `Promise.resolve(...)`.
 */
export interface AttributionStore {
  save(s: AttributionState): Promise<void>;
  /** Untrusted — validated entirely by {@link WorkerAttributionRegistry.fromState}. */
  load(): Promise<unknown>;
}

// ===========================================================================
// Internals
// ===========================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Validate one raw `state.entries[workerId]` value. Never throws;
 *  `undefined` means "drop it". */
function validateEntry(raw: unknown): AttributionEntry | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { backend, at, nativeId } = raw;
  if (typeof backend !== "string" || backend.trim().length === 0) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  if (nativeId !== undefined && typeof nativeId !== "string") return undefined;
  const entry: AttributionEntry = { backend, at };
  if (nativeId !== undefined) entry.nativeId = nativeId;
  return entry;
}

// ===========================================================================
// WorkerAttributionRegistry
// ===========================================================================

/**
 * Durable, in-memory-first workerId -> backend map. `record`/`lookup`/
 * `release`/`ids`/`snapshot` are synchronous and are the source of truth for
 * the life of this process; `persist`/`restore` are the OPTIONAL best-effort
 * bridge to a durable {@link AttributionStore} across restarts.
 */
export class WorkerAttributionRegistry {
  private readonly store?: AttributionStore;
  private readonly nowFn: () => number;
  private readonly entriesById = new Map<string, AttributionEntry>();

  constructor(opts: { store?: AttributionStore; now?: () => number } = {}) {
    this.store = opts.store;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /**
   * Record that `workerId` is running on `backend`. Throws `RangeError` for
   * a blank id, an empty backend name, or when `workerId` is already
   * attributed to a DIFFERENT backend (a worker id colliding across
   * backends is a bug upstream, never silently resolved here — same
   * backstop as `RemoteBackendRegistry.adopt`). Re-recording the identical
   * `(workerId, backend)` pair (nativeId may differ, e.g. a fresher probe)
   * is a no-op that refreshes `at` and `nativeId`.
   */
  record(workerId: string, backend: string, meta?: { nativeId?: string }): void {
    if (typeof workerId !== "string" || workerId.trim().length === 0) {
      throw new RangeError("WorkerAttributionRegistry.record: workerId must be a non-empty string");
    }
    if (typeof backend !== "string" || backend.trim().length === 0) {
      throw new RangeError("WorkerAttributionRegistry.record: backend must be a non-empty string");
    }
    const existing = this.entriesById.get(workerId);
    if (existing && existing.backend !== backend) {
      throw new RangeError(
        `WorkerAttributionRegistry.record: workerId "${workerId}" already attributed to backend "${existing.backend}", cannot re-attribute to "${backend}"`
      );
    }
    const entry: AttributionEntry = { backend, at: this.nowFn() };
    if (meta?.nativeId !== undefined) entry.nativeId = meta.nativeId;
    this.entriesById.set(workerId, entry);
  }

  /** The backend name currently attributed to `workerId`, or `undefined` if unknown. */
  lookup(workerId: string): string | undefined {
    return this.entriesById.get(workerId)?.backend;
  }

  /** Drop `workerId`'s attribution. Returns whether anything was actually removed. */
  release(workerId: string): boolean {
    return this.entriesById.delete(workerId);
  }

  /** Every tracked worker id, sorted. */
  ids(): string[] {
    return [...this.entriesById.keys()].sort();
  }

  /** Deep-copied, canonical-key-ordered serializable snapshot. */
  snapshot(): AttributionState {
    const entries: AttributionState["entries"] = {};
    for (const id of this.ids()) {
      const e = this.entriesById.get(id)!;
      entries[id] = { backend: e.backend, at: e.at, ...(e.nativeId !== undefined ? { nativeId: e.nativeId } : {}) };
    }
    return { version: ATTRIBUTION_STATE_VERSION, entries };
  }

  /**
   * Reconstruct a registry from a persisted (or arbitrary, untrusted)
   * snapshot. NEVER throws: a wrong top-level shape or version mismatch
   * yields a fresh, empty registry; individually malformed entries are
   * dropped while the rest of the state loads normally — same defensive
   * discipline as `CostAwareRouteBandit.fromState` (`./route-bandit.ts`).
   */
  static fromState(state: unknown, opts: { store?: AttributionStore; now?: () => number } = {}): WorkerAttributionRegistry {
    const registry = new WorkerAttributionRegistry(opts);
    if (!isPlainObject(state)) return registry;
    const { version, entries } = state;
    if (typeof version !== "number" || version !== ATTRIBUTION_STATE_VERSION) return registry;
    if (!isPlainObject(entries)) return registry;
    for (const [workerId, raw] of Object.entries(entries)) {
      if (typeof workerId !== "string" || workerId.trim().length === 0) continue;
      const validated = validateEntry(raw);
      if (validated) registry.entriesById.set(workerId, validated);
    }
    return registry;
  }

  /**
   * Best-effort persist this registry's current snapshot via the configured
   * `AttributionStore`. Never throws: no store configured is reported as
   * `{ saved: false, error: "no store configured" }`; a real store failure
   * is caught and reported the same honest way.
   */
  async persist(): Promise<{ saved: boolean; error?: string }> {
    if (!this.store) return { saved: false, error: "no store configured" };
    try {
      await this.store.save(this.snapshot());
      return { saved: true };
    } catch (err) {
      return { saved: false, error: errorMessage(err) };
    }
  }

  /**
   * Best-effort load from the configured `AttributionStore`, merging
   * validated entries into THIS registry (existing in-memory entries for
   * ids not present in the loaded state are left untouched). Never throws:
   * no store, a `load()` rejection, or an unusable top-level shape/version
   * all resolve to `{ loaded: false, dropped: 0 }`. Individually malformed
   * entries inside an otherwise valid envelope are counted in `dropped`
   * rather than aborting the whole restore.
   */
  async restore(): Promise<{ loaded: boolean; dropped: number }> {
    if (!this.store) return { loaded: false, dropped: 0 };
    let raw: unknown;
    try {
      raw = await this.store.load();
    } catch {
      return { loaded: false, dropped: 0 };
    }
    if (!isPlainObject(raw)) return { loaded: false, dropped: 0 };
    const { version, entries } = raw;
    if (typeof version !== "number" || version !== ATTRIBUTION_STATE_VERSION) return { loaded: false, dropped: 0 };
    if (!isPlainObject(entries)) return { loaded: false, dropped: 0 };
    let dropped = 0;
    for (const [workerId, rawEntry] of Object.entries(entries)) {
      if (typeof workerId !== "string" || workerId.trim().length === 0) {
        dropped += 1;
        continue;
      }
      const validated = validateEntry(rawEntry);
      if (validated) {
        this.entriesById.set(workerId, validated);
      } else {
        dropped += 1;
      }
    }
    return { loaded: true, dropped };
  }
}

// ===========================================================================
// resolveBackendForTask — the literal SwarmOutcomeFeed.resolveBackend it needs
// ===========================================================================

/**
 * Build the `resolveBackend: (task: WorkerTask) => string | undefined`
 * function `SwarmOutcomeFeed` (`./outcome-feed.ts`) requires, backed by a
 * real `WorkerAttributionRegistry`.
 *
 * Resolution order, NEVER a guess:
 *   1. `task.result?.workerId` — the worker that actually PRODUCED the
 *      result (for a consensus task this is the specific replica id that
 *      won/reported, per `WorkerResult` in `../../swarm-runtime/types`).
 *   2. `task.assignedTo` — the worker the task is currently dispatched to,
 *      used when no result has landed yet (e.g. an in-flight terminal event
 *      racing the result write).
 *   3. `undefined` — neither field names a worker id this registry knows
 *      about, or neither field is set at all. `SwarmOutcomeFeed` treats
 *      `undefined` (and `""`, folded into `undefined` here too) as "unknown"
 *      and records nothing rather than guessing.
 */
export function resolveBackendForTask(registry: WorkerAttributionRegistry): (task: WorkerTask) => string | undefined {
  return (task: WorkerTask): string | undefined => {
    const candidates = [task.result?.workerId, task.assignedTo];
    for (const id of candidates) {
      if (typeof id !== "string" || id.length === 0) continue;
      const backend = registry.lookup(id);
      if (backend) return backend;
    }
    return undefined;
  };
}
