/**
 * FleetSupervisor — composes the REAL {@link BackendManager}, {@link
 * LifecycleMachine}, and {@link HandleStore} into the single entry point the
 * swarm uses for a remote worker's whole life: provision, hibernate, wake,
 * terminate.
 *
 * `BackendManager` (`./manager.ts`) already drives a backend's own
 * provision/hibernate/wake/terminate calls and tracks real telemetry, but it
 * has no notion of an in-flight transition, no wake retry/backoff, and no
 * guard against two concurrent wakes racing the same worker — that is
 * exactly what `LifecycleMachine` (`./lifecycle.ts`) is for. And neither of
 * those survives a process restart on its own — that is exactly what
 * `HandleStore` (`./handle-store.ts`) is for. This module reimplements NONE
 * of that: it is purely the glue that makes every mutating call go
 * `manager -> machine -> store`, in that order, every time, so:
 *
 *   - hibernate/wake legality, idempotency, retry/backoff, and the
 *     concurrent-wake guard come ENTIRELY from `LifecycleMachine`;
 *   - the on-disk format, atomic write, and crash-consistent reconciliation
 *     come ENTIRELY from `HandleStore`;
 *   - backend selection, provisioning, and telemetry come ENTIRELY from
 *     `BackendManager`.
 *
 * The one piece of bookkeeping this module DOES own is enumerating which
 * worker ids are currently tracked: `LifecycleMachine` deliberately exposes
 * only per-id `state()`/`history()` lookups and no "list every tracked id"
 * method, so `lifecycleMap()` (needed to hand a full map to
 * `HandleStore.save`) requires FleetSupervisor to remember, alongside the
 * machine, which ids it has told the machine to track.
 */

import { BackendManager } from "./manager";
import {
  LifecycleMachine,
  type LifecycleEvent,
  type LifecycleState,
  // TransitionError / WakeExhaustedError are never re-thrown as a new type by
  // this module — they surface to callers of hibernate()/wake()/terminate()
  // completely unchanged, straight out of LifecycleMachine. Imported here so
  // the doc comments below can `{@link}` them precisely, per the locked
  // contract; this module never constructs or catches-and-rewraps either one.
  type TransitionError,
  type WakeExhaustedError,
} from "./lifecycle";
import { HandleStore, type ReconcileReport } from "./handle-store";
import type { ProvisionResult, RemoteHandle, RemoteSpec } from "./backend";
import type { BackendRequirements } from "./descriptor";

export interface FleetSupervisorOptions {
  /** The real backend substrate. Required — FleetSupervisor never
   *  constructs its own BackendManager, since the caller owns backend
   *  registration/descriptors. */
  manager: BackendManager;
  /** Injectable so callers/tests can supply a machine with a fake clock and
   *  instant sleep. Defaults to `new LifecycleMachine({ now })`. */
  machine?: LifecycleMachine;
  /** Optional — when omitted, `persist()`/`restore()` are no-ops (in-memory
   *  only fleet, e.g. for short-lived processes/tests that don't care about
   *  crash consistency). */
  store?: HandleStore;
  /** Time source (ms), shared with a machine constructed by default.
   *  Injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Observability hook: fired once per successful mutating operation
   *  (`provisioned`/`hibernated`/`woken`/`terminated`), once per `persist()`
   *  attempt (`persisted` or `persist-failed`), and once per `restore()`
   *  call (`restored`). Never fired for a call that ends up throwing. */
  onEvent?: (e: FleetSupervisorEvent) => void;
}

export type FleetSupervisorEvent = {
  type: "provisioned" | "hibernated" | "woken" | "terminated" | "persisted" | "persist-failed" | "restored";
  at: number;
  workerId?: string;
  backend?: string;
  detail?: Record<string, unknown>;
};

/** Persisted lifecycle states a crash could have left a worker frozen in
 *  mid-transition. Per `lifecycle.ts`'s own doc: "a failed hibernate attempt
 *  is a failure, not a rollback" — the same reasoning applies to a process
 *  that died while `hibernating`/`waking` was in flight. `restore()`
 *  downgrades either to `"failed"` regardless of what the backend probe
 *  reports, since the backend's actual state at that exact boundary is not
 *  something a crash-recovered process can safely assume. */
const TRANSIENT_LIFECYCLE_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>(["hibernating", "waking"]);

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class FleetSupervisor {
  private readonly manager: BackendManager;
  private readonly machine: LifecycleMachine;
  private readonly store?: HandleStore;
  private readonly now: () => number;
  private readonly onEventCb?: (e: FleetSupervisorEvent) => void;

  /** Worker ids this supervisor has told `machine` to track, purely so
   *  `lifecycleMap()` can enumerate them (see file header). Kept in lockstep
   *  with every `machine.track`/`machine.untrack` call this class makes. */
  private readonly trackedIds = new Set<string>();

  constructor(opts: FleetSupervisorOptions) {
    if (!opts || !opts.manager) {
      throw new TypeError("FleetSupervisor: opts.manager is required");
    }
    this.manager = opts.manager;
    this.now = opts.now ?? (() => Date.now());
    this.machine = opts.machine ?? new LifecycleMachine({ now: this.now });
    this.store = opts.store;
    this.onEventCb = opts.onEvent;
  }

  private emit(type: FleetSupervisorEvent["type"], fields: Omit<FleetSupervisorEvent, "type" | "at"> = {}): void {
    this.onEventCb?.({ type, at: this.now(), ...fields });
  }

  private trackWorker(workerId: string, state: LifecycleState): void {
    this.machine.track(workerId, state);
    this.trackedIds.add(workerId);
  }

  private untrackWorker(workerId: string): void {
    this.machine.untrack(workerId);
    this.trackedIds.delete(workerId);
  }

  // ---------------------------------------------------------------------
  // Provision / hibernate / wake / terminate
  // ---------------------------------------------------------------------

  /**
   * Delegate to `manager.provision` (backend selection, real provisioning,
   * telemetry — all unchanged). If that throws, the error propagates
   * unchanged and NOTHING is tracked or persisted (there is nothing yet to
   * track). On success, the new worker is tracked at `"provisioning"` and
   * immediately transitioned to `"running"` through the table (this is a
   * deliberate re-provision path too: `track()` overwrites any prior
   * tracking, so re-provisioning a previously `"failed"`/untracked worker
   * id works exactly like a first provision), then persisted.
   */
  async provision(spec: RemoteSpec, r?: BackendRequirements): Promise<ProvisionResult> {
    const result = await this.manager.provision(spec, r);
    const workerId = result.handle.workerId;
    this.trackWorker(workerId, "provisioning");
    this.machine.transition(workerId, "running", "provisioned");
    this.emit("provisioned", {
      workerId,
      backend: result.backend,
      detail: { nativeId: result.handle.nativeId },
    });
    await this.persist();
    return result;
  }

  /**
   * Hibernate through the real machine: `machine.runHibernate` owns legality
   * (illegal-state -> {@link TransitionError}), idempotency
   * (already-`hibernated` -> no-op, `op` NOT re-invoked), and the `failed`
   * transition on a throwing op (rethrown unchanged). `op` itself just
   * awaits `manager.hibernate(workerId)`.
   *
   * An unknown/untracked `workerId` is well-defined: `runHibernate` throws
   * {@link TransitionError} before `op` ever runs (so `manager.hibernate` is
   * never called for a worker this supervisor never tracked), the state is
   * left untouched, and the fleet is still persisted (a no-op save) before
   * the error propagates.
   *
   * Persistence always happens exactly once per call, success or failure,
   * so a `"failed"` transition from a throwing op is durably recorded before
   * the error reaches the caller.
   */
  async hibernate(workerId: string): Promise<RemoteHandle | undefined> {
    let result: RemoteHandle | undefined;
    try {
      await this.machine.runHibernate(workerId, async () => {
        result = await this.manager.hibernate(workerId);
      });
    } catch (err) {
      await this.persist();
      throw err;
    }
    const handle = result ?? this.manager.registry.handle(workerId);
    this.emit("hibernated", { workerId, backend: handle?.backend, detail: { nativeId: handle?.nativeId } });
    await this.persist();
    return handle;
  }

  /**
   * Wake through the real machine: `machine.runWake` owns legality,
   * idempotency (already-`running` -> no-op, `op` NOT re-invoked), retry
   * with exponential backoff up to the machine's configured
   * `wakeMaxAttempts` (rethrowing {@link WakeExhaustedError} — with every
   * attempt's error attached — and ending state `"failed"` once attempts are
   * exhausted), and the concurrent-wake guard: a second `wake()` call for a
   * worker whose first wake is still in flight (mid-backoff or otherwise)
   * rejects immediately with {@link TransitionError} rather than racing it.
   * `op` itself just awaits `manager.wake(workerId)`.
   *
   * Same unknown-workerId and always-persist-once semantics as {@link
   * hibernate}.
   */
  async wake(workerId: string): Promise<RemoteHandle | undefined> {
    let result: RemoteHandle | undefined;
    try {
      await this.machine.runWake(workerId, async () => {
        result = await this.manager.wake(workerId);
      });
    } catch (err) {
      await this.persist();
      throw err;
    }
    const handle = result ?? this.manager.registry.handle(workerId);
    this.emit("woken", { workerId, backend: handle?.backend, detail: { nativeId: handle?.nativeId } });
    await this.persist();
    return handle;
  }

  /**
   * Transition a tracked worker to the fully terminal `"stopped"` state
   * through the table, tear it down on the real backend via
   * `manager.terminate`, and stop tracking it. An unknown/untracked
   * `workerId` is well-defined: `machine.transition` throws {@link
   * TransitionError} before `manager.terminate` is ever called and before
   * anything is untracked; the fleet is still persisted (no-op) before the
   * error propagates. Likewise, `"stopped"` is fully terminal per the
   * transition table, so a second `terminate()` on an already-terminated
   * worker also throws {@link TransitionError} rather than silently
   * no-opping.
   *
   * If `manager.terminate` itself throws (after the machine has already
   * legally moved to `"stopped"`), the worker is left tracked at `"stopped"`
   * (that transition already happened and is not rolled back — this
   * machine never rolls back a completed transition) but is NOT untracked,
   * and the fleet is persisted before the error propagates, so a partial
   * teardown is never silently lost.
   */
  async terminate(workerId: string): Promise<void> {
    try {
      this.machine.transition(workerId, "stopped", "terminated");
      await this.manager.terminate(workerId);
    } catch (err) {
      await this.persist();
      throw err;
    }
    this.untrackWorker(workerId);
    this.emit("terminated", { workerId });
    await this.persist();
  }

  // ---------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------

  /** Current tracked lifecycle state, or `undefined` for an unknown worker. */
  lifecycle(workerId: string): LifecycleState | undefined {
    return this.machine.state(workerId);
  }

  /** Every currently-tracked worker's lifecycle state — the map handed to
   *  `HandleStore.save` by `persist()`, and the shape callers diff a
   *  `restore()` round-trip against. */
  lifecycleMap(): Record<string, LifecycleState> {
    const out: Record<string, LifecycleState> = {};
    for (const workerId of this.trackedIds) {
      const state = this.machine.state(workerId);
      if (state !== undefined) out[workerId] = state;
    }
    return out;
  }

  /** Full recorded transition history for one worker (delegates entirely to
   *  `machine.history` — unknown worker returns `[]`, never throws). */
  history(workerId: string, limit?: number): LifecycleEvent[] {
    return this.machine.history(workerId, limit);
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  /**
   * Persist the current fleet (`manager.registry.list()`) and lifecycle map
   * (`lifecycleMap()`) via `store.save`. A no-op when no store was
   * configured. Persistence failures NEVER throw out of this call — or any
   * lifecycle operation that calls it — they are reported exclusively via a
   * `"persist-failed"` event.
   */
  async persist(): Promise<void> {
    if (!this.store) return;
    const handles = this.manager.registry.list();
    const lifecycle = this.lifecycleMap();
    try {
      await this.store.save(handles, lifecycle);
      this.emit("persisted", { detail: { handleCount: handles.length, lifecycleCount: Object.keys(lifecycle).length } });
    } catch (err) {
      this.emit("persist-failed", { detail: { error: errMsg(err) } });
    }
  }

  /**
   * Restore the fleet after a process restart: `store.load()` the last
   * saved envelope, `store.reconcile()` it against the REAL backend
   * registry (probed truth wins over whatever was stored), then re-track
   * every successfully-probed handle in `machine` mapping its probed
   * `RemoteState` 1:1 into `LifecycleState` — EXCEPT that a handle whose
   * *persisted* lifecycle entry was the transient `"hibernating"` or
   * `"waking"` is downgraded to `"failed"` regardless of what the probe
   * reports (a crash mid-transition is a failure, not a state to trust —
   * see {@link TRANSIENT_LIFECYCLE_STATES}).
   *
   * Handles `store.reconcile` dropped (unknown backend, a throwing probe, a
   * malformed entry) are never tracked. Returns `undefined` (doing nothing
   * else) when no store is configured, or when there is nothing persisted
   * yet (`store.load()` returns `undefined` — e.g. first run).
   */
  async restore(): Promise<ReconcileReport | undefined> {
    if (!this.store) return undefined;
    const fleet = await this.store.load();
    if (!fleet) return undefined;

    const report = await this.store.reconcile(fleet, this.manager.registry);

    for (const handle of report.restored) {
      const persisted = fleet.lifecycle[handle.workerId];
      const state: LifecycleState =
        persisted !== undefined && TRANSIENT_LIFECYCLE_STATES.has(persisted) ? "failed" : handle.state;
      this.trackWorker(handle.workerId, state);
    }

    this.emit("restored", {
      detail: {
        restored: report.restored.length,
        corrected: report.corrected.length,
        dropped: report.dropped.length,
      },
    });
    return report;
  }
}
