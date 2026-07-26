/**
 * BackendManager — the unified substrate the Phase 16 bandit routes on.
 *
 * Wraps {@link RemoteBackendRegistry} (never reimplemented — every provision /
 * hibernate / wake / terminate / status call ultimately goes through it) and
 * composes a {@link ScaleToZeroManager} sharing the same injected clock, then
 * layers three things neither of those provide:
 *
 * 1. **Descriptors** — static capability + cost metadata per backend
 *    ({@link BackendDescriptor} from `./descriptor.ts`), used for deterministic,
 *    total-order requirement-scored {@link BackendManager.select}.
 * 2. **TTL-cached availability probing** — `isAvailable()` is I/O and can be
 *    slow/flaky; results are cached per backend name for `probeTtlMs` so
 *    `select()`/`probeAll()` don't hammer every backend on every call.
 * 3. **Real measured telemetry** — provision latency (EMA), provision/failure
 *    counts, and running/hibernated wall-clock duration and accrued USD cost
 *    (`configured rate x real elapsed ms`), tracked per worker on every state
 *    change and finalized on terminate. Every number is either measured
 *    (durations, latencies, counts, derived from the injected clock) or an
 *    explicitly `source: "configured"` rate — nothing here is fabricated.
 *
 * Every mutating method emits exactly one {@link BackendManagerEvent} of its
 * own designated type (in addition to whatever events any method it calls
 * internally emits — e.g. `provision()` calls `select()`, so a single
 * `provision()` call yields both a `"selected"` and a `"provisioned"` /
 * `"provision-failed"` event). `status()` is a pure read reconciled against
 * telemetry and emits nothing, since it has no designated event type.
 */

import type {
  ProvisionResult,
  RemoteBackend,
  RemoteHandle,
  RemoteSpec,
  RemoteState,
} from "./backend";
import { RemoteBackendRegistry } from "./backend";
import { ScaleToZeroManager } from "./scale-to-zero";
import type { BackendDescriptor, BackendRequirements, BackendTelemetrySnapshot } from "./descriptor";
import { ZERO_TELEMETRY, compareCandidates, matchesRequirements, scoreBackend } from "./descriptor";

export interface BackendManagerOptions {
  /** ms clock, default () => Date.now(). Injectable for deterministic tests. */
  now?: () => number;
  /** How long a cached `isAvailable()` result stays valid. Default 30_000. */
  probeTtlMs?: number;
  /** EMA smoothing factor for provision latency, in (0, 1]. Default 0.3. */
  latencyEmaAlpha?: number;
  /** Observability hook — fired once per mutating call (see file header). */
  onEvent?: (e: BackendManagerEvent) => void;
}

export type BackendManagerEvent = {
  type:
    | "registered"
    | "probe"
    | "selected"
    | "provisioned"
    | "provision-failed"
    | "hibernated"
    | "woken"
    | "terminated"
    | "swept";
  at: number;
  backend?: string;
  workerId?: string;
  detail?: Record<string, unknown>;
};

/** Mutable per-backend telemetry accumulator (the public view is the frozen snapshot). */
interface MutableTelemetry {
  provisions: number;
  failures: number;
  latencyEma: number | null;
  runningMs: number;
  hibernatedMs: number;
  accruedUsd: number;
}

const DEFAULT_PROBE_TTL_MS = 30_000;
const DEFAULT_LATENCY_EMA_ALPHA = 0.3;
const MS_PER_HOUR = 3_600_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class BackendManager {
  readonly registry: RemoteBackendRegistry;
  readonly scaler: ScaleToZeroManager;

  private readonly now: () => number;
  private readonly probeTtlMs: number;
  private readonly latencyEmaAlpha: number;
  private readonly onEventCb?: (e: BackendManagerEvent) => void;

  private readonly descriptorsByName = new Map<string, BackendDescriptor>();
  private readonly telemetryByName = new Map<string, MutableTelemetry>();
  private readonly probeCache = new Map<string, { result: boolean; at: number }>();
  /** Wall-clock timestamp of the worker's last state transition (running/hibernated start). */
  private readonly sinceByWorker = new Map<string, number>();

  constructor(opts: BackendManagerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.probeTtlMs = opts.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;
    this.latencyEmaAlpha = opts.latencyEmaAlpha ?? DEFAULT_LATENCY_EMA_ALPHA;
    this.onEventCb = opts.onEvent;
    this.registry = new RemoteBackendRegistry();
    // Shares this manager's injected clock so duration accounting (which reads
    // wall-clock state via `registry.handle()`) and the scaler's idle reaper
    // agree on "now" — no drift between the two subsystems under fake clocks.
    this.scaler = new ScaleToZeroManager(this.registry, { now: this.now });
  }

  private emit(type: BackendManagerEvent["type"], fields: Omit<BackendManagerEvent, "type" | "at"> = {}): void {
    this.onEventCb?.({ type, at: this.now(), ...fields });
  }

  // ---------------------------------------------------------------------
  // Registration & descriptors
  // ---------------------------------------------------------------------

  /** Register a backend + its static descriptor. Throws on name mismatch or duplicate registration. */
  register(backend: RemoteBackend, descriptor: BackendDescriptor): void {
    if (backend.name !== descriptor.name) {
      throw new Error(
        `BackendManager.register: backend.name ("${backend.name}") does not match descriptor.name ("${descriptor.name}")`
      );
    }
    if (this.descriptorsByName.has(descriptor.name)) {
      throw new Error(`BackendManager.register: backend "${descriptor.name}" is already registered`);
    }
    this.registry.register(backend);
    this.descriptorsByName.set(descriptor.name, descriptor);
    this.emit("registered", { backend: descriptor.name, detail: { kind: descriptor.kind } });
  }

  /** All registered descriptors, sorted by name for deterministic iteration. */
  descriptors(): BackendDescriptor[] {
    return [...this.descriptorsByName.keys()].sort().map((name) => this.descriptorsByName.get(name)!);
  }

  descriptor(name: string): BackendDescriptor | undefined {
    return this.descriptorsByName.get(name);
  }

  // ---------------------------------------------------------------------
  // Availability probing (TTL-cached)
  // ---------------------------------------------------------------------

  /**
   * Best-effort availability check for one backend, cached for `probeTtlMs`.
   * A throwing `isAvailable()` is caught, cached as unavailable, and reported
   * via the emitted event's `detail.error` — it never propagates. Emits a
   * `"probe"` event only for an actual check (cache miss); a cache hit
   * mutates nothing and stays silent.
   */
  async probe(name: string): Promise<boolean> {
    const descriptor = this.descriptorsByName.get(name);
    if (!descriptor) throw new Error(`BackendManager.probe: unknown backend "${name}"`);
    const backend = this.registry.get(name);
    if (!backend) throw new Error(`BackendManager.probe: unknown backend "${name}"`);

    const at = this.now();
    const cached = this.probeCache.get(name);
    if (cached && at - cached.at < this.probeTtlMs) {
      // Cache hits are silent — the event stream reflects actual probe
      // activity (real isAvailable() calls), not every cached lookup.
      return cached.result;
    }

    let available: boolean;
    let error: string | undefined;
    try {
      available = await backend.isAvailable();
    } catch (err) {
      available = false;
      error = errorMessage(err);
    }
    this.probeCache.set(name, { result: available, at });
    this.emit("probe", { backend: name, detail: error ? { available, cached: false, error } : { available, cached: false } });
    return available;
  }

  /** Probe every registered backend (sequentially, so probe events stay in a deterministic order). */
  async probeAll(): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    for (const name of [...this.descriptorsByName.keys()].sort()) {
      result[name] = await this.probe(name);
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------

  /**
   * Pick the best available backend for a requirement set: filter by
   * availability + {@link matchesRequirements}, score survivors with
   * {@link scoreBackend}, and return the top candidate under
   * {@link compareCandidates}'s total order. Returns `undefined` (never
   * throws) when the registry is empty or nothing available matches.
   */
  async select(r: BackendRequirements = {}): Promise<{ name: string; descriptor: BackendDescriptor; score: number } | undefined> {
    const availability = await this.probeAll();
    const candidates: { name: string; descriptor: BackendDescriptor; score: number }[] = [];
    for (const name of [...this.descriptorsByName.keys()].sort()) {
      if (!availability[name]) continue;
      const descriptor = this.descriptorsByName.get(name)!;
      if (!matchesRequirements(descriptor, r)) continue;
      const score = scoreBackend(descriptor, r, this.telemetry(name));
      candidates.push({ name, descriptor, score });
    }
    candidates.sort(compareCandidates);
    const chosen = candidates[0];
    this.emit("selected", {
      backend: chosen?.name,
      detail: { candidateCount: candidates.length, requirements: r as Record<string, unknown> },
    });
    return chosen;
  }

  // ---------------------------------------------------------------------
  // Provision / lifecycle
  // ---------------------------------------------------------------------

  /**
   * Select a backend for `r`, then provision `spec` on it. Measures real
   * provision latency via the injected clock, records success/failure
   * telemetry (provisions/failures count, latency EMA on success, the
   * configured per-provision charge on success), starts duration accounting,
   * and marks the worker active on the scaler. On failure, the original
   * error is rethrown unchanged after telemetry is recorded.
   */
  async provision(spec: RemoteSpec, r?: BackendRequirements): Promise<ProvisionResult> {
    const sel = await this.select(r);
    if (!sel) {
      this.emit("provision-failed", {
        workerId: spec.workerId,
        detail: { reason: "no backend available matching requirements" },
      });
      throw new Error("BackendManager.provision: no backend available matching requirements");
    }

    const start = this.now();
    let result: ProvisionResult;
    try {
      result = await this.registry.provision(spec, sel.name);
    } catch (err) {
      const elapsedMs = this.now() - start;
      this.recordFailure(sel.name);
      this.emit("provision-failed", {
        backend: sel.name,
        workerId: spec.workerId,
        detail: { elapsedMs, error: errorMessage(err) },
      });
      throw err;
    }

    const at = this.now();
    const elapsedMs = at - start;
    this.recordSuccess(sel.name, elapsedMs);
    this.sinceByWorker.set(spec.workerId, at);
    this.scaler.markActive(spec.workerId);
    this.emit("provisioned", {
      backend: result.backend,
      workerId: spec.workerId,
      detail: { nativeId: result.handle.nativeId, latencyMs: elapsedMs },
    });
    return result;
  }

  /**
   * Hibernate a worker. Idempotent: a second call on an already-hibernated
   * worker is a no-op (still emits one event) that does not touch duration
   * accounting, so double-hibernate calls never double-count elapsed time.
   */
  async hibernate(workerId: string): Promise<RemoteHandle | undefined> {
    const before = this.registry.handle(workerId);
    if (!before) {
      this.emit("hibernated", { workerId, detail: { unknown: true } });
      return undefined;
    }
    if (before.state === "hibernated") {
      this.emit("hibernated", { backend: before.backend, workerId, detail: { noop: true, reason: "already hibernated" } });
      return before;
    }

    const at = this.now();
    const start = this.sinceByWorker.get(workerId) ?? at;
    // May throw (e.g. backend doesn't support hibernate) — propagated as-is,
    // before any accounting mutation, so a failed call leaves state untouched.
    const handle = await this.registry.hibernate(workerId);
    this.accrueDuration(before.backend, "running", at - start);
    this.sinceByWorker.set(workerId, at);
    this.emit("hibernated", { backend: handle?.backend ?? before.backend, workerId, detail: { nativeId: handle?.nativeId } });
    return handle;
  }

  /**
   * Wake a worker (delegates the actual wake decision to
   * {@link ScaleToZeroManager.ensureAwake}, which is itself idempotent — a
   * worker that is already running is returned as-is, no backend call made),
   * then marks it active. Finalizes hibernated-duration accounting exactly
   * once per real wake.
   */
  async wake(workerId: string): Promise<RemoteHandle | undefined> {
    const before = this.registry.handle(workerId);
    if (!before) {
      this.emit("woken", { workerId, detail: { unknown: true } });
      return undefined;
    }
    const wasHibernated = before.state === "hibernated";
    const at = this.now();
    const handle = await this.scaler.ensureAwake(workerId);
    if (wasHibernated && handle) {
      const start = this.sinceByWorker.get(workerId) ?? at;
      this.accrueDuration(before.backend, "hibernated", at - start);
      this.sinceByWorker.set(workerId, at);
    }
    this.scaler.markActive(workerId);
    this.emit("woken", { backend: handle?.backend ?? before.backend, workerId, detail: { noop: !wasHibernated } });
    return handle;
  }

  /** Tear a worker down for good, finalizing whatever duration bucket it was last in. */
  async terminate(workerId: string): Promise<void> {
    const before = this.registry.handle(workerId);
    await this.registry.terminate(workerId);
    if (before) {
      const at = this.now();
      const start = this.sinceByWorker.get(workerId) ?? at;
      if (before.state === "running" || before.state === "hibernated") {
        this.accrueDuration(before.backend, before.state, at - start);
      }
      this.sinceByWorker.delete(workerId);
    }
    this.emit("terminated", { backend: before?.backend, workerId, detail: { unknown: !before } });
  }

  /**
   * Live status probe (delegates to the registry, which updates its cached
   * handle state). Reconciles duration accounting if the backend reports a
   * state change the manager didn't itself drive (e.g. an external failure).
   * Pure read otherwise — emits nothing (no event type is designated for it).
   */
  async status(workerId: string): Promise<RemoteState | undefined> {
    const before = this.registry.handle(workerId);
    // Snapshot the pre-call state/backend as primitives: registry.status()
    // mutates the handle object in place (`h.state = state`), so holding
    // onto `before` alone would see the *post*-mutation state by the time we
    // compare below — always "not asleep before it changed."
    const beforeState = before?.state;
    const beforeBackend = before?.backend;
    const state = await this.registry.status(workerId);
    if (state === undefined) return undefined;
    if (before && beforeState !== state) {
      const at = this.now();
      const start = this.sinceByWorker.get(workerId) ?? at;
      if (beforeState === "running" || beforeState === "hibernated") {
        this.accrueDuration(beforeBackend!, beforeState, at - start);
      }
      if (state === "running" || state === "hibernated") {
        this.sinceByWorker.set(workerId, at);
      } else {
        this.sinceByWorker.delete(workerId);
      }
    }
    return state;
  }

  /**
   * Hibernate every idle-too-long running worker (via the scaler's idle
   * reaper), finalizing running-duration accounting for each one hibernated.
   * Emits exactly one `"swept"` event per call regardless of how many
   * workers were affected.
   */
  async sweepIdle(): Promise<string[]> {
    const hibernatedIds = await this.scaler.sweep();
    const at = this.now();
    for (const workerId of hibernatedIds) {
      const handle = this.registry.handle(workerId);
      if (!handle) continue;
      const start = this.sinceByWorker.get(workerId) ?? at;
      this.accrueDuration(handle.backend, "running", at - start);
      this.sinceByWorker.set(workerId, at);
    }
    this.emit("swept", { detail: { workerIds: hibernatedIds, count: hibernatedIds.length } });
    return hibernatedIds;
  }

  // ---------------------------------------------------------------------
  // Telemetry & listing
  // ---------------------------------------------------------------------

  /** Measured telemetry for a backend. Unknown backends return a zeroed snapshot, never crash. */
  telemetry(name: string): BackendTelemetrySnapshot {
    const tel = this.telemetryByName.get(name);
    if (!tel) return { ...ZERO_TELEMETRY };
    return {
      provisions: tel.provisions,
      failures: tel.failures,
      provisionLatencyEmaMs: tel.latencyEma,
      runningMs: tel.runningMs,
      hibernatedMs: tel.hibernatedMs,
      accruedUsd: tel.accruedUsd,
    };
  }

  /** Every currently-tracked handle with its descriptor and current idle duration. */
  list(): Array<{ handle: RemoteHandle; descriptor: BackendDescriptor; idleMs: number }> {
    const out: Array<{ handle: RemoteHandle; descriptor: BackendDescriptor; idleMs: number }> = [];
    for (const handle of this.registry.list()) {
      const descriptor = this.descriptorsByName.get(handle.backend);
      if (!descriptor) continue;
      out.push({ handle, descriptor, idleMs: this.scaler.idleFor(handle.workerId) });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Internal telemetry bookkeeping
  // ---------------------------------------------------------------------

  private getOrCreateTelemetry(name: string): MutableTelemetry {
    let tel = this.telemetryByName.get(name);
    if (!tel) {
      tel = { provisions: 0, failures: 0, latencyEma: null, runningMs: 0, hibernatedMs: 0, accruedUsd: 0 };
      this.telemetryByName.set(name, tel);
    }
    return tel;
  }

  private recordSuccess(name: string, latencyMs: number): void {
    const tel = this.getOrCreateTelemetry(name);
    tel.provisions += 1;
    tel.latencyEma = tel.latencyEma == null ? latencyMs : this.latencyEmaAlpha * latencyMs + (1 - this.latencyEmaAlpha) * tel.latencyEma;
    const descriptor = this.descriptorsByName.get(name);
    if (descriptor) tel.accruedUsd += descriptor.cost.perProvisionUsd;
  }

  private recordFailure(name: string): void {
    const tel = this.getOrCreateTelemetry(name);
    tel.provisions += 1;
    tel.failures += 1;
  }

  /** Add real elapsed ms in `state` to a backend's duration/cost accumulators. Rate x elapsed, always. */
  private accrueDuration(backendName: string, state: "running" | "hibernated", elapsedMs: number): void {
    if (elapsedMs <= 0) return;
    const tel = this.getOrCreateTelemetry(backendName);
    const descriptor = this.descriptorsByName.get(backendName);
    const rate = descriptor ? (state === "running" ? descriptor.cost.perRunningHourUsd : descriptor.cost.perHibernatedHourUsd) : 0;
    if (state === "running") tel.runningMs += elapsedMs;
    else tel.hibernatedMs += elapsedMs;
    tel.accruedUsd += rate * (elapsedMs / MS_PER_HOUR);
  }
}
