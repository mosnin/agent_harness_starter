/**
 * HandleAdoptionService — closes the "reported but not resurrected" gap in
 * {@link FleetSupervisor.restore} (`./fleet-supervisor.ts`).
 *
 * `FleetSupervisor.restore()` already does the hard part of crash recovery:
 * it loads the last persisted fleet via `HandleStore.load()` and probes every
 * stored handle against the REAL backend behind it via `HandleStore.reconcile`
 * (probed truth always wins over whatever was on disk). But `reconcile()` is
 * read-only — it never touches `RemoteBackendRegistry`'s internal handle map,
 * because until now that registry exposed no way to insert a handle other
 * than `provision()` actually bringing a NEW worker up. The practical result:
 * after a restart, `hades backends status <workerId>` / `hibernate` / `wake`
 * / `terminate` for a worker that was alive before the crash all fail with
 * "Unknown worker", because `RemoteBackendRegistry.handle()` has never heard
 * of it — the worker is reported as restored but never actually re-attached
 * to the live registry. This module is the missing half: given the REAL
 * probed truth, it re-attaches ("adopts") every trustworthy handle into the
 * live registry via a small, additive `RegistryAdoptionPort.adopt()` seam, so
 * a restored worker becomes a LIVE worker again, not just a line of output.
 *
 * Three pieces:
 *
 *  - {@link RegistryAdoptionPort} — the minimal surface this module needs
 *    from a registry. `RemoteBackendRegistry` (`./backend.ts`) satisfies it
 *    once central integration adds a real `adopt(handle)` method there (this
 *    module never edits `backend.ts` — see the port's own TSDoc below for the
 *    exact semantics that real method is expected to implement).
 *  - {@link HandleAdoptionService} — probes a batch of candidate handles for
 *    real and adopts every trustworthy one, per-handle isolated (one bad
 *    handle never aborts the batch) and fully event-observable.
 *  - {@link restoreWithAdoption} — the single shared "restart" code path:
 *    load the persisted fleet, adopt it, and (when a `LifecycleMachine` is
 *    supplied) re-track every adopted handle at its probed state. This is
 *    the function `FleetSupervisor.restore()`, the CLI's
 *    `hades backends reconcile --adopt`, and the desktop app are all meant to
 *    call at central integration, so "restart recovery" has exactly one
 *    implementation instead of three drifting copies of it.
 *
 * Adoption decision table (per candidate handle, in order):
 *
 *  1. Structurally malformed (not a plausible `RemoteHandle` shape) -> DROPPED.
 *  2. `backend` name not registered on the port -> DROPPED.
 *  3. `backend.status(handle)` throws -> DROPPED.
 *  4. Probed state is `"stopped"` or `"failed"` -> DROPPED (never adopted —
 *     a terminal remote state is not a worker worth re-attaching).
 *  5. `workerId` is already live in the registry (`registry.handle()` returns
 *     something) -> CONFLICT (never overwritten — live wins).
 *  6. Otherwise -> `registry.adopt(handle-with-probed-state)`. If `adopt`
 *     itself throws (e.g. a race lost to another adopter) -> DROPPED.
 *     Otherwise -> ADOPTED (and also CORRECTED when the probed state
 *     disagreed with the handle's own stored `state` field).
 *
 * Every candidate produces exactly ONE {@link AdoptionEvent} (`"adopted"`,
 * `"adopt-skipped"` for conflicts/terminal-state drops, or `"adopt-failed"`
 * for genuine errors) and lands in exactly one of
 * `adopted+conflicts+dropped` (never more than one, never zero) —
 * `corrected` is always a SUBSET of `adopted`, exactly like
 * `ReconcileReport.corrected` is a subset of `ReconcileReport.restored`
 * (`./handle-store.ts`).
 */

import type { RemoteBackend, RemoteHandle, RemoteState } from "./backend";
import type { HandleStore, PersistedFleet, ReconcileReport } from "./handle-store";
import type { LifecycleMachine, LifecycleState } from "./lifecycle";

// ===========================================================================
// RegistryAdoptionPort
// ===========================================================================

/**
 * The minimal registry surface {@link HandleAdoptionService} needs. Deliberately
 * narrow (four methods) so it can be satisfied by:
 *
 *  - the REAL `RemoteBackendRegistry` (`./backend.ts`), once central
 *    integration adds `adopt()` there alongside the `register`/`get`/`handle`/
 *    `list` it already has;
 *  - a thin test shim composed with a real `RemoteBackendRegistry` (this
 *    module's own tests never reimplement `get`/`handle`/`list` — those
 *    delegate straight through to a real registry; only `adopt` needs a shim
 *    body, since the real one lands at central integration).
 *
 * `adopt`'s locked semantics (documented here since this module is the
 * authority the real `RemoteBackendRegistry.adopt` central integration adds
 * must match):
 *
 *  - Inserts `handle` into the registry's live handle map, keyed by
 *    `handle.workerId`, exactly as if `provision()` had just produced it —
 *    after `adopt()` returns, `registry.handle(handle.workerId)` must return
 *    this same handle (by value), and `registry.list()` must include it.
 *  - A `handle.workerId` that is ALREADY live in the registry is a
 *    programmer error, not a silent overwrite: `adopt` MUST throw rather than
 *    replace the existing entry. ({@link HandleAdoptionService} never
 *    actually exercises this path in normal operation — it always checks
 *    `handle()` for a live conflict itself BEFORE calling `adopt`, routing
 *    those to `AdoptionReport.conflicts` instead — but `adopt`'s own
 *    duplicate-throws contract is still relied on as a defensive backstop the
 *    service catches and converts into a dropped entry, e.g. under a race.)
 *  - Synchronous and side-effect-free beyond that one insertion: no probing,
 *    no lifecycle-machine interaction, no persistence. Those are this
 *    module's job, layered on top.
 */
export interface RegistryAdoptionPort {
  /** Insert `handle` as a live handle. Throws on a duplicate `workerId`. */
  adopt(handle: RemoteHandle): void;
  /** Current live handle for `workerId`, or `undefined` if not tracked. */
  handle(workerId: string): RemoteHandle | undefined;
  /** The registered backend named `name`, or `undefined` if unknown. */
  get(name: string): RemoteBackend | undefined;
  /** Every currently-live handle. */
  list(): RemoteHandle[];
}

// ===========================================================================
// Events + reports
// ===========================================================================

/** One recorded outcome for a single candidate handle. Exactly one is
 *  emitted per handle passed to {@link HandleAdoptionService.adoptHandles}
 *  (and, transitively, {@link HandleAdoptionService.adoptFromStore} /
 *  {@link restoreWithAdoption}). */
export type AdoptionEvent = {
  type: "adopted" | "adopt-skipped" | "adopt-failed";
  at: number;
  workerId?: string;
  backend?: string;
  detail?: Record<string, unknown>;
};

/**
 * Partitions every candidate handle into exactly one outcome bucket:
 * `adopted` (now live in the registry — `corrected` is always a SUBSET of
 * this, never additional entries), `conflicts` (workerId already live —
 * untouched), or `dropped` (untrustworthy or explicitly non-adoptable). For
 * any call, `handles.length === adopted.length + conflicts.length +
 * dropped.length` always holds.
 */
export interface AdoptionReport {
  /** Handles now live in the registry, with `state` set to the freshly
   *  probed truth (never the possibly-stale stored value). */
  adopted: RemoteHandle[];
  /** Adopted handles whose stored `state` disagreed with the live probe —
   *  each entry here also appears in `adopted`. */
  corrected: Array<{ workerId: string; stored: LifecycleState; probed: RemoteState }>;
  /** Handles whose `workerId` was already live in the registry; left
   *  completely untouched (live always wins). */
  conflicts: Array<{ workerId: string; reason: string }>;
  /** Handles that could not be trusted, or whose probed state is terminal
   *  (`"stopped"`/`"failed"`) and therefore never adopted. */
  dropped: Array<{ workerId: string; reason: string }>;
}

// ===========================================================================
// small local helpers
// ===========================================================================

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const REMOTE_STATE_SET: ReadonlySet<string> = new Set<RemoteState>([
  "provisioning",
  "running",
  "hibernated",
  "stopped",
  "failed",
]);

/**
 * Defense-in-depth structural check, deliberately independent of (and not a
 * substitute for) `HandleStore`'s own authoritative `validateHandle` (a
 * private function in `./handle-store.ts` this module never reimplements the
 * intent of — `HandleStore.load()` already guarantees every entry in a
 * `PersistedFleet.handles` it returns is well-formed). This exists because
 * `adoptHandles` is a PUBLIC entry point callers may invoke directly with
 * hand-built data that never passed through `HandleStore` at all, so one
 * malformed entry in that array must still drop only itself.
 */
function isStructurallyValidHandle(v: unknown): v is RemoteHandle {
  if (!isPlainObject(v)) return false;
  const { workerId, backend, nativeId, state, startedAt, endpoint, meta } = v;
  if (typeof workerId !== "string" || workerId.length === 0) return false;
  if (typeof backend !== "string" || backend.length === 0) return false;
  if (typeof nativeId !== "string" || nativeId.length === 0) return false;
  if (typeof state !== "string" || !REMOTE_STATE_SET.has(state)) return false;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return false;
  if (endpoint !== undefined && typeof endpoint !== "string") return false;
  if (meta !== undefined && !isPlainObject(meta)) return false;
  return true;
}

/** `lifecycle[workerId]`, guarded against a crafted `workerId` of
 *  `"__proto__"`/`"constructor"`/`"prototype"` walking the prototype chain
 *  instead of missing cleanly. `HandleStore`'s own `validateLifecycleMap`
 *  already keeps the map itself clean of polluting keys — this guard is
 *  purely about the LOOKUP being safe regardless of what `workerId` a
 *  (separately validated) handle happens to carry. */
function ownLifecycle(
  lifecycle: Record<string, LifecycleState>,
  workerId: string,
): LifecycleState | undefined {
  if (!Object.prototype.hasOwnProperty.call(lifecycle, workerId)) return undefined;
  return lifecycle[workerId];
}

function candidateWorkerId(raw: unknown): string | undefined {
  return isPlainObject(raw) && typeof raw.workerId === "string" && raw.workerId.length > 0
    ? raw.workerId
    : undefined;
}

// ===========================================================================
// Core probe-and-classify pass (shared by the class and restoreWithAdoption)
// ===========================================================================

interface AdoptionRunResult {
  adoption: AdoptionReport;
  reconcile: ReconcileReport;
}

async function runAdoption(params: {
  handles: RemoteHandle[];
  lifecycle: Record<string, LifecycleState>;
  registry: RegistryAdoptionPort;
  now: () => number;
  onEvent?: (e: AdoptionEvent) => void;
}): Promise<AdoptionRunResult> {
  const { handles, lifecycle, registry, now, onEvent } = params;
  const adoption: AdoptionReport = { adopted: [], corrected: [], conflicts: [], dropped: [] };
  const reconcile: ReconcileReport = { restored: [], corrected: [], dropped: [] };

  const emit = (type: AdoptionEvent["type"], fields: Omit<AdoptionEvent, "type" | "at"> = {}): void => {
    onEvent?.({ type, at: now(), ...fields });
  };

  for (const raw of handles) {
    const fallbackId = candidateWorkerId(raw) ?? "<unknown>";
    try {
      if (!isStructurallyValidHandle(raw)) {
        const reason = "malformed handle entry";
        adoption.dropped.push({ workerId: fallbackId, reason });
        reconcile.dropped.push({ workerId: fallbackId, reason });
        emit("adopt-failed", {
          ...(fallbackId !== "<unknown>" ? { workerId: fallbackId } : {}),
          detail: { reason },
        });
        continue;
      }

      const candidate: RemoteHandle = raw;

      const backend = registry.get(candidate.backend);
      if (!backend) {
        const reason = `unknown backend: ${candidate.backend}`;
        adoption.dropped.push({ workerId: candidate.workerId, reason });
        reconcile.dropped.push({ workerId: candidate.workerId, reason });
        emit("adopt-failed", { workerId: candidate.workerId, backend: candidate.backend, detail: { reason } });
        continue;
      }

      let probed: RemoteState;
      try {
        probed = await backend.status(candidate);
      } catch (err) {
        const reason = `status probe threw: ${errMsg(err)}`;
        adoption.dropped.push({ workerId: candidate.workerId, reason });
        reconcile.dropped.push({ workerId: candidate.workerId, reason });
        emit("adopt-failed", { workerId: candidate.workerId, backend: candidate.backend, detail: { reason } });
        continue;
      }

      // Probed successfully: this contributes to the reconcile-equivalent
      // picture regardless of what adoption decides to do with it next —
      // mirrors HandleStore.reconcile's restored/corrected exactly.
      const probedHandle: RemoteHandle = { ...candidate, state: probed };
      reconcile.restored.push(probedHandle);
      if (probed !== candidate.state) {
        reconcile.corrected.push({ workerId: candidate.workerId, stored: candidate.state, probed });
      }

      if (probed === "stopped" || probed === "failed") {
        const reason = `probed state is "${probed}"; a terminal remote state is never adopted`;
        adoption.dropped.push({ workerId: candidate.workerId, reason });
        emit("adopt-skipped", {
          workerId: candidate.workerId,
          backend: candidate.backend,
          detail: { reason, probed },
        });
        continue;
      }

      const existing = registry.handle(candidate.workerId);
      if (existing) {
        const reason = `workerId already live in the registry (backend=${existing.backend})`;
        adoption.conflicts.push({ workerId: candidate.workerId, reason });
        emit("adopt-skipped", {
          workerId: candidate.workerId,
          backend: candidate.backend,
          detail: { reason, existingBackend: existing.backend },
        });
        continue;
      }

      try {
        registry.adopt(probedHandle);
      } catch (err) {
        const reason = `registry.adopt rejected: ${errMsg(err)}`;
        adoption.dropped.push({ workerId: candidate.workerId, reason });
        emit("adopt-failed", { workerId: candidate.workerId, backend: candidate.backend, detail: { reason } });
        continue;
      }

      adoption.adopted.push(probedHandle);
      if (probed !== candidate.state) {
        adoption.corrected.push({ workerId: candidate.workerId, stored: candidate.state, probed });
      }
      emit("adopted", {
        workerId: candidate.workerId,
        backend: candidate.backend,
        detail: {
          probed,
          stored: candidate.state,
          persistedLifecycle: ownLifecycle(lifecycle, candidate.workerId),
        },
      });
    } catch (err) {
      // Belt-and-braces per-handle isolation: nothing above this line is
      // documented to throw synchronously, but the service must NEVER let
      // one bad candidate abort the whole batch, no matter what.
      const reason = `unexpected error: ${errMsg(err)}`;
      adoption.dropped.push({ workerId: fallbackId, reason });
      reconcile.dropped.push({ workerId: fallbackId, reason });
      emit("adopt-failed", {
        ...(fallbackId !== "<unknown>" ? { workerId: fallbackId } : {}),
        detail: { reason },
      });
    }
  }

  return { adoption, reconcile };
}

// ===========================================================================
// HandleAdoptionService
// ===========================================================================

/**
 * Probes a batch of candidate {@link RemoteHandle}s for real and re-attaches
 * every trustworthy one into a {@link RegistryAdoptionPort}. See the file
 * header for the full decision table; every call is fully per-handle
 * isolated (a throwing probe, an unknown backend, or a malformed entry drops
 * only that one handle) and emits exactly one {@link AdoptionEvent} per
 * candidate via the optional `onEvent` hook.
 */
export class HandleAdoptionService {
  private readonly registry: RegistryAdoptionPort;
  private readonly now: () => number;
  private readonly onEvent?: (e: AdoptionEvent) => void;

  constructor(opts: { registry: RegistryAdoptionPort; now?: () => number; onEvent?: (e: AdoptionEvent) => void }) {
    if (!opts || !opts.registry) {
      throw new TypeError("HandleAdoptionService: opts.registry is required");
    }
    this.registry = opts.registry;
    this.now = opts.now ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  /**
   * Adopt every handle in `handles`, using `lifecycle` only to annotate
   * `"adopted"` events with the candidate's persisted lifecycle entry (this
   * method never tracks a `LifecycleMachine` itself — that is
   * {@link restoreWithAdoption}'s job, since this class's locked constructor
   * takes no `machine`). Never throws for a single bad candidate; see the
   * file header's decision table for exactly how each handle is classified.
   */
  async adoptHandles(handles: RemoteHandle[], lifecycle: Record<string, LifecycleState>): Promise<AdoptionReport> {
    const { adoption } = await runAdoption({
      handles,
      lifecycle,
      registry: this.registry,
      now: this.now,
      onEvent: this.onEvent,
    });
    return adoption;
  }

  /**
   * Load the persisted fleet from `store` and adopt it in one call.
   * `undefined` when nothing has ever been persisted (`store.load()` itself
   * returned `undefined` — first run, or the file was quarantined) — this is
   * a "nothing to do" signal, never an error.
   */
  async adoptFromStore(store: HandleStore): Promise<AdoptionReport | undefined> {
    const fleet: PersistedFleet | undefined = await store.load();
    if (!fleet) return undefined;
    return this.adoptHandles(fleet.handles, fleet.lifecycle);
  }
}

// ===========================================================================
// restoreWithAdoption — the single shared restart code path
// ===========================================================================

/**
 * Persisted lifecycle states a crash could have left a worker frozen in
 * mid-transition. Mirrors `FleetSupervisor`'s own `TRANSIENT_LIFECYCLE_STATES`
 * verbatim (`./fleet-supervisor.ts:79-86`): a crash mid-hibernate or
 * mid-wake is a failure, not a state to trust, so the MACHINE tracks it as
 * `"failed"` — but note this is purely a lifecycle-machine bookkeeping
 * decision. The handle itself is still adopted into the registry at its
 * freshly probed `RemoteState` (e.g. `"running"`) exactly like any other
 * adopted handle; only what `restoreWithAdoption` feeds into
 * `LifecycleMachine.track` for that worker is downgraded.
 */
const TRANSIENT_LIFECYCLE_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>(["hibernating", "waking"]);

/**
 * The single shared "process restart" code path: load the persisted fleet
 * from `store`, probe and adopt every trustworthy handle into `registry` via
 * a fresh {@link HandleAdoptionService}, and — when `machine` is supplied —
 * re-track every successfully ADOPTED handle in it at its probed state
 * (downgraded to `"failed"` when the persisted lifecycle entry was the
 * transient `"hibernating"`/`"waking"`, per {@link TRANSIENT_LIFECYCLE_STATES}).
 *
 * Returns `undefined` when nothing has ever been persisted (`store.load()`
 * returned `undefined`) — a "nothing to restore" signal, not an error.
 * Otherwise returns both the `ReconcileReport`-shaped read-only probe result
 * (mirroring `HandleStore.reconcile`'s shape exactly, computed from the SAME
 * probes `adoption` used — no handle is ever probed twice) and the
 * `AdoptionReport` describing what was actually re-attached.
 *
 * `FleetSupervisor.restore()`, `hades backends reconcile --adopt`, and the
 * desktop app's restart path are all meant to call this one function at
 * central integration, rather than each hand-rolling their own adopt loop.
 */
export async function restoreWithAdoption(opts: {
  store: HandleStore;
  registry: RegistryAdoptionPort;
  machine?: LifecycleMachine;
  now?: () => number;
  onEvent?: (e: AdoptionEvent) => void;
}): Promise<{ reconcile: ReconcileReport; adoption: AdoptionReport } | undefined> {
  if (!opts || !opts.store || !opts.registry) {
    throw new TypeError("restoreWithAdoption: opts.store and opts.registry are required");
  }
  const now = opts.now ?? (() => Date.now());

  const fleet: PersistedFleet | undefined = await opts.store.load();
  if (!fleet) return undefined;

  const { adoption, reconcile } = await runAdoption({
    handles: fleet.handles,
    lifecycle: fleet.lifecycle,
    registry: opts.registry,
    now,
    onEvent: opts.onEvent,
  });

  if (opts.machine) {
    const machine = opts.machine;
    for (const handle of adoption.adopted) {
      const persisted = ownLifecycle(fleet.lifecycle, handle.workerId);
      const trackState: LifecycleState =
        persisted !== undefined && TRANSIENT_LIFECYCLE_STATES.has(persisted) ? "failed" : handle.state;
      machine.track(handle.workerId, trackState);
    }
  }

  return { reconcile, adoption };
}
