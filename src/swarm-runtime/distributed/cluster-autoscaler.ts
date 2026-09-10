/**
 * @module swarm-runtime/distributed/cluster-autoscaler
 *
 * Cluster-wide worker autoscaler. Converts live cluster demand (pending /
 * leased tasks, per-node lease pressure, verified throughput, node health)
 * into a per-node worker-count decision, then realizes those decisions by
 * provisioning and terminating workers on the existing remote execution
 * backends (`../../hades/backends/backend.ts`).
 *
 * Two-phase design, mirroring the rest of the distributed layer:
 *
 *  - {@link ClusterAutoscaler.evaluate} is a PURE function of `(internal
 *    bookkeeping, ScaleSignal)`: no I/O, no registry calls, clock supplied by
 *    the caller via `signal.now`. It decides *what* the cluster should look
 *    like — one {@link ScaleDecision} per known node — including which
 *    backend a new worker would land on, chosen via the real
 *    `matchesRequirements` + `scoreBackend` + `compareCandidates` scoring
 *    triplet against telemetry this autoscaler itself has accumulated via
 *    {@link ClusterAutoscaler.observe}. It never fabricates a preference
 *    order.
 *  - {@link ClusterAutoscaler.apply} is the effectful half: it takes
 *    `evaluate`'s decisions and drives the real
 *    `RemoteBackendRegistry`/`RemoteBackend.provision`/`terminate`/
 *    `hibernate` calls, honestly reporting what happened (including partial
 *    failure) rather than assuming success.
 *
 * ── Hysteresis ──────────────────────────────────────────────────────────
 * Two independent guards keep an oscillating queue from thrashing workers:
 *   1. Per-node, per-direction cooldowns (`scaleUpCooldownMs` /
 *      `scaleDownCooldownMs`) — a node that just scaled cannot scale again
 *      in that direction until its cooldown elapses; the blocked decision
 *      still comes back with `to === from` and `reason: "cooldown"`.
 *   2. Scale-to-zero additionally requires the *whole cluster* to have shown
 *      zero demand continuously for `idleBeforeScaleDownMs` before the last
 *      workers on a node are torn down — a brief dip to zero demand between
 *      bursts never trips it.
 * Both are driven purely by the caller-supplied `signal.now`, so replaying
 * the same signal sequence always reproduces the same decisions.
 *
 * ── Failure resilience ─────────────────────────────────────────────────
 * Every `observe()` call (including the ones `apply()` makes automatically
 * after each provision attempt) updates a per-backend consecutive-failure
 * counter. A failing backend's exponential backoff window
 * (`min(failureBackoffMs * 2^(failures-1), maxFailureBackoffMs)`) makes it
 * ineligible for `scoreBackend` selection until the window elapses; a single
 * successful observation immediately clears the counter and re-admits it.
 * Within one `apply()` call, a provisioning failure on the best-ranked
 * backend does not abandon the unit — the next best *not-currently-backed-
 * off* candidate is tried immediately.
 *
 * ── Budget ceiling ─────────────────────────────────────────────────────
 * `maxCostPerHourUsd` is enforced against the descriptors' real
 * `cost.perRunningHourUsd` *before* any registry call: a candidate worker is
 * only provisioned if `currentCost + backendRate <= maxCostPerHourUsd`. Units
 * that cannot fit under the cap (with any matching, non-backed-off backend)
 * are reported honestly in `ApplyReport.skipped` with `reason: "budget-cap"`
 * — the cluster never silently overspends.
 */

import { EventEmitter } from "node:events";

import type {
  RemoteBackendRegistry,
  RemoteHandle,
  RemoteSpec,
  RemoteState,
} from "../../hades/backends/backend";
import {
  matchesRequirements,
  scoreBackend,
  compareCandidates,
  type BackendDescriptor,
  type BackendRequirements,
  type BackendTelemetrySnapshot,
} from "../../hades/backends/descriptor";
import type { NodeState } from "./membership";

// ---------------------------------------------------------------------------
// Public types (locked contract)
// ---------------------------------------------------------------------------

export interface ScaleSignal {
  now: number;
  pending: number;
  leased: number;
  verifiedSinceLast: number;
  elapsedMs: number;
  aliveNodes: NodeState[];
  inFlightByNode: ReadonlyMap<string, number>;
}

export type ScaleReason =
  | "demand"
  | "idle"
  | "floor"
  | "ceiling"
  | "cooldown"
  | "budget-cap"
  | "no-backend"
  | "node-unhealthy"
  | "backoff";

export interface ScaleDecision {
  nodeId: string;
  from: number;
  to: number;
  delta: number;
  reason: ScaleReason;
  backendName?: string;
  estCostPerHourUsd?: number;
}

export interface ProvisionOutcome {
  nodeId: string;
  workerId: string;
  backendName: string;
  ok: boolean;
  handle?: RemoteHandle;
  error?: string;
}

export interface ApplyReport {
  provisioned: ProvisionOutcome[];
  terminated: Array<{ nodeId: string; workerId: string; backendName: string; ok: boolean; error?: string }>;
  skipped: ScaleDecision[];
  costPerHourUsd: number;
}

export interface AutoscalerStats {
  evaluations: number;
  scaleUps: number;
  scaleDowns: number;
  provisionFailures: number;
  backoffs: Record<string, number>;
  workersByNode: Record<string, number>;
  workersByBackend: Record<string, number>;
  costPerHourUsd: number;
}

export interface ClusterAutoscalerOptions {
  registry: RemoteBackendRegistry;
  descriptors: BackendDescriptor[];
  min: number;
  max: number;
  now?: () => number;
  targetQueuePerWorker?: number;
  scaleUpCooldownMs?: number;
  scaleDownCooldownMs?: number;
  idleBeforeScaleDownMs?: number;
  maxCostPerHourUsd?: number;
  failureBackoffMs?: number;
  maxFailureBackoffMs?: number;
  requirements?: BackendRequirements;
  managerUrl?: string;
  authToken?: string;
}

interface ClusterAutoscalerEvents {
  "scale:up": [decision: ScaleDecision];
  "scale:down": [decision: ScaleDecision];
  "provision:failed": [nodeId: string, backendName: string, error: string];
  "backend:backoff": [backendName: string, untilMs: number];
  "budget:capped": [costPerHourUsd: number];
}

// ---------------------------------------------------------------------------
// Internal bookkeeping shapes
// ---------------------------------------------------------------------------

interface TrackedWorker {
  workerId: string;
  nodeId: string;
  backendName: string;
  state: RemoteState;
  startedAt: number;
}

interface BackendTelemetryAccumulator {
  provisions: number;
  failures: number;
  latencyEmaMs: number | null;
  accruedUsd: number;
}

const ACTIVE_WORKER_STATES: ReadonlySet<RemoteState> = new Set(["provisioning", "running", "hibernated"]);
const LATENCY_EMA_ALPHA = 0.3;

// ---------------------------------------------------------------------------
// ClusterAutoscaler
// ---------------------------------------------------------------------------

export class ClusterAutoscaler extends EventEmitter<ClusterAutoscalerEvents> {
  private readonly registry: RemoteBackendRegistry;
  private readonly descriptors: BackendDescriptor[];
  private readonly descriptorsByName: Map<string, BackendDescriptor>;
  private readonly min: number;
  private readonly max: number;
  private readonly nowFn: () => number;
  private readonly targetQueuePerWorker: number;
  private readonly scaleUpCooldownMs: number;
  private readonly scaleDownCooldownMs: number;
  private readonly idleBeforeScaleDownMs: number;
  private readonly maxCostPerHourUsd: number | undefined;
  private readonly failureBackoffMs: number;
  private readonly maxFailureBackoffMs: number;
  private readonly requirements: BackendRequirements;
  private readonly managerUrl: string | undefined;
  private readonly authToken: string | undefined;

  private readonly workersMap = new Map<string, TrackedWorker>();
  private readonly lastKnownNodes = new Map<string, NodeState>();
  private readonly lastScaleUpAt = new Map<string, number>();
  private readonly lastScaleDownAt = new Map<string, number>();
  private readonly backendFailureCount = new Map<string, number>();
  private readonly backendBackoffUntil = new Map<string, number>();
  private readonly backendTelemetry = new Map<string, BackendTelemetryAccumulator>();
  private readonly backoffEnterCount = new Map<string, number>();

  private lastNonIdleAt = -Infinity;
  private evaluationsCount = 0;
  private scaleUpsCount = 0;
  private scaleDownsCount = 0;
  private provisionFailuresCount = 0;
  private workerIdSeq = 0;
  private mutex: Promise<void> = Promise.resolve();

  constructor(opts: ClusterAutoscalerOptions) {
    super();

    if (!(opts.min >= 0) || !Number.isFinite(opts.min)) {
      throw new RangeError(`ClusterAutoscaler: min must be a finite number >= 0, got ${opts.min}`);
    }
    if (!(opts.max >= opts.min) || !Number.isFinite(opts.max)) {
      throw new RangeError(`ClusterAutoscaler: max must be a finite number >= min, got ${opts.max}`);
    }

    this.registry = opts.registry;
    this.descriptors = [...opts.descriptors];
    this.descriptorsByName = new Map(this.descriptors.map((d) => [d.name, d]));
    this.min = opts.min;
    this.max = opts.max;
    this.nowFn = opts.now ?? (() => Date.now());
    this.targetQueuePerWorker = Math.max(1, opts.targetQueuePerWorker ?? 2);
    this.scaleUpCooldownMs = opts.scaleUpCooldownMs ?? 30_000;
    this.scaleDownCooldownMs = opts.scaleDownCooldownMs ?? 60_000;
    this.idleBeforeScaleDownMs = opts.idleBeforeScaleDownMs ?? 120_000;
    this.maxCostPerHourUsd = opts.maxCostPerHourUsd;
    this.failureBackoffMs = opts.failureBackoffMs ?? 5_000;
    this.maxFailureBackoffMs = opts.maxFailureBackoffMs ?? 300_000;
    this.requirements = opts.requirements ?? {};
    this.managerUrl = opts.managerUrl;
    this.authToken = opts.authToken;
  }

  // ── Small pure helpers ──────────────────────────────────────────────

  private countActiveWorkers(nodeId: string): number {
    let n = 0;
    for (const w of this.workersMap.values()) {
      if (w.nodeId === nodeId && ACTIVE_WORKER_STATES.has(w.state)) n += 1;
    }
    return n;
  }

  private matchingDescriptors(): BackendDescriptor[] {
    return this.descriptors.filter((d) => matchesRequirements(d, this.requirements));
  }

  private isBackedOff(name: string, now: number): boolean {
    const until = this.backendBackoffUntil.get(name) ?? 0;
    return now < until;
  }

  private telemetrySnapshot(name: string): BackendTelemetrySnapshot {
    const t = this.backendTelemetry.get(name);
    if (!t) {
      return { provisions: 0, failures: 0, provisionLatencyEmaMs: null, runningMs: 0, hibernatedMs: 0, accruedUsd: 0 };
    }
    return {
      provisions: t.provisions,
      failures: t.failures,
      provisionLatencyEmaMs: t.latencyEmaMs,
      runningMs: 0,
      hibernatedMs: 0,
      accruedUsd: t.accruedUsd,
    };
  }

  private bestCandidate(candidates: BackendDescriptor[]): BackendDescriptor | undefined {
    if (candidates.length === 0) return undefined;
    const scored = candidates.map((d) => ({
      d,
      name: d.name,
      score: scoreBackend(d, this.requirements, this.telemetrySnapshot(d.name)),
    }));
    scored.sort(compareCandidates);
    return scored[0].d;
  }

  private costPerHourUsd(): number {
    let total = 0;
    for (const w of this.workersMap.values()) {
      const d = this.descriptorsByName.get(w.backendName);
      if (!d) continue;
      if (w.state === "hibernated") total += d.cost.perHibernatedHourUsd;
      else if (w.state === "running" || w.state === "provisioning") total += d.cost.perRunningHourUsd;
    }
    return total;
  }

  private waterFillDistribute(
    total: number,
    nodes: Array<{ nodeId: string; cap: number; current: number; pressure: number }>,
  ): Map<string, number> {
    const order = [...nodes].sort(
      (a, b) => b.pressure - a.pressure || a.current - b.current || a.nodeId.localeCompare(b.nodeId),
    );
    const alloc = new Map<string, number>(order.map((n) => [n.nodeId, 0]));
    let remaining = Math.max(0, total);
    let progress = true;
    while (remaining > 0 && progress) {
      progress = false;
      for (const n of order) {
        if (remaining <= 0) break;
        const cur = alloc.get(n.nodeId) ?? 0;
        if (cur < n.cap) {
          alloc.set(n.nodeId, cur + 1);
          remaining -= 1;
          progress = true;
        }
      }
    }
    return alloc;
  }

  // ── evaluate(): pure decision-making ─────────────────────────────────

  evaluate(signal: ScaleSignal): ScaleDecision[] {
    this.evaluationsCount += 1;
    const now = signal.now;
    const totalDemand = Math.max(0, signal.pending) + Math.max(0, signal.leased);
    if (totalDemand > 0) this.lastNonIdleAt = now;

    for (const n of signal.aliveNodes) this.lastKnownNodes.set(n.descriptor.nodeId, n);

    const rawDesiredTotal = totalDemand === 0 ? 0 : Math.ceil(totalDemand / this.targetQueuePerWorker);
    let clusterDesired = rawDesiredTotal;
    let clampReason: "floor" | "ceiling" | undefined;
    if (clusterDesired < this.min) {
      clusterDesired = this.min;
      if (this.min > 0) clampReason = "floor";
    }
    if (clusterDesired > this.max) {
      clusterDesired = this.max;
      clampReason = "ceiling";
    }

    const decisions: ScaleDecision[] = [];

    // Nodes that are unhealthy, or have vanished from the roster entirely
    // while this autoscaler still tracks workers on them: forced to zero,
    // unconditionally (health always overrides cooldowns/backoff).
    const presentIds = new Set(signal.aliveNodes.map((n) => n.descriptor.nodeId));
    const unhealthyIds = new Set<string>();
    for (const n of signal.aliveNodes) {
      if (n.health !== "alive") unhealthyIds.add(n.descriptor.nodeId);
    }
    for (const w of this.workersMap.values()) {
      if (!presentIds.has(w.nodeId)) unhealthyIds.add(w.nodeId);
    }

    for (const nodeId of unhealthyIds) {
      const current = this.countActiveWorkers(nodeId);
      const decision: ScaleDecision = { nodeId, from: current, to: 0, delta: -current, reason: "node-unhealthy" };
      decisions.push(decision);
      if (decision.delta < 0) {
        this.scaleDownsCount += 1;
        this.emit("scale:down", decision);
      }
    }

    const healthyNodes = signal.aliveNodes.filter((n) => n.health === "alive");
    const pool = healthyNodes.map((n) => {
      const nodeId = n.descriptor.nodeId;
      return {
        nodeId,
        cap: Math.max(0, n.descriptor.capacity.maxWorkers),
        current: this.countActiveWorkers(nodeId),
        pressure: signal.inFlightByNode.get(nodeId) ?? 0,
      };
    });
    const allocation = this.waterFillDistribute(clusterDesired, pool);

    for (const p of pool) {
      const { nodeId, current } = p;
      const desiredForNode = allocation.get(nodeId) ?? 0;

      if (desiredForNode === current) {
        decisions.push({ nodeId, from: current, to: current, delta: 0, reason: clampReason ?? "demand" });
        continue;
      }

      if (desiredForNode > current) {
        const lastUp = this.lastScaleUpAt.get(nodeId) ?? -Infinity;
        if (now - lastUp < this.scaleUpCooldownMs) {
          decisions.push({ nodeId, from: current, to: current, delta: 0, reason: "cooldown" });
          continue;
        }
        const candidates = this.matchingDescriptors();
        if (candidates.length === 0) {
          decisions.push({ nodeId, from: current, to: current, delta: 0, reason: "no-backend" });
          continue;
        }
        const available = candidates.filter((d) => !this.isBackedOff(d.name, now));
        if (available.length === 0) {
          decisions.push({ nodeId, from: current, to: current, delta: 0, reason: "backoff" });
          continue;
        }
        const best = this.bestCandidate(available) as BackendDescriptor;
        const decision: ScaleDecision = {
          nodeId,
          from: current,
          to: desiredForNode,
          delta: desiredForNode - current,
          reason: clampReason ?? "demand",
          backendName: best.name,
          estCostPerHourUsd: best.cost.perRunningHourUsd,
        };
        decisions.push(decision);
        this.lastScaleUpAt.set(nodeId, now);
        this.scaleUpsCount += 1;
        this.emit("scale:up", decision);
        continue;
      }

      // desiredForNode < current: a scale-down of some size.
      const goingToClusterZero = desiredForNode === 0 && clusterDesired === 0;
      if (goingToClusterZero) {
        const idleFor = now - this.lastNonIdleAt;
        if (this.min === 0 && idleFor >= this.idleBeforeScaleDownMs) {
          const lastDown = this.lastScaleDownAt.get(nodeId) ?? -Infinity;
          if (now - lastDown < this.scaleDownCooldownMs) {
            decisions.push({ nodeId, from: current, to: current, delta: 0, reason: "cooldown" });
            continue;
          }
          const decision: ScaleDecision = { nodeId, from: current, to: 0, delta: -current, reason: "idle" };
          decisions.push(decision);
          this.lastScaleDownAt.set(nodeId, now);
          this.scaleDownsCount += 1;
          this.emit("scale:down", decision);
          continue;
        }
        decisions.push({ nodeId, from: current, to: current, delta: 0, reason: "cooldown" });
        continue;
      }

      // Partial scale-down: demand dropped but the cluster is not fully
      // idle — only the plain scale-down cooldown applies.
      const lastDown = this.lastScaleDownAt.get(nodeId) ?? -Infinity;
      if (now - lastDown < this.scaleDownCooldownMs) {
        decisions.push({ nodeId, from: current, to: current, delta: 0, reason: "cooldown" });
        continue;
      }
      const decision: ScaleDecision = {
        nodeId,
        from: current,
        to: desiredForNode,
        delta: desiredForNode - current,
        reason: clampReason ?? "demand",
      };
      decisions.push(decision);
      this.lastScaleDownAt.set(nodeId, now);
      this.scaleDownsCount += 1;
      this.emit("scale:down", decision);
    }

    return decisions;
  }

  // ── observe(): telemetry + backoff bookkeeping ───────────────────────

  observe(backendName: string, sample: { ok: boolean; latencyMs: number; costUsd?: number }): void {
    let t = this.backendTelemetry.get(backendName);
    if (!t) {
      t = { provisions: 0, failures: 0, latencyEmaMs: null, accruedUsd: 0 };
      this.backendTelemetry.set(backendName, t);
    }
    t.provisions += 1;
    if (!sample.ok) t.failures += 1;
    t.latencyEmaMs =
      t.latencyEmaMs == null
        ? sample.latencyMs
        : LATENCY_EMA_ALPHA * sample.latencyMs + (1 - LATENCY_EMA_ALPHA) * t.latencyEmaMs;
    if (sample.costUsd) t.accruedUsd += sample.costUsd;

    if (sample.ok) {
      this.backendFailureCount.set(backendName, 0);
      this.backendBackoffUntil.set(backendName, 0);
    } else {
      const count = (this.backendFailureCount.get(backendName) ?? 0) + 1;
      this.backendFailureCount.set(backendName, count);
      const backoffMs = Math.min(this.failureBackoffMs * 2 ** (count - 1), this.maxFailureBackoffMs);
      const until = this.nowFn() + backoffMs;
      this.backendBackoffUntil.set(backendName, until);
      this.backoffEnterCount.set(backendName, (this.backoffEnterCount.get(backendName) ?? 0) + 1);
      this.emit("backend:backoff", backendName, until);
    }
  }

  // ── apply(): the effectful half, serialized so overlapping calls never
  //    double-count or leak handles. ────────────────────────────────────

  async apply(decisions: ScaleDecision[]): Promise<ApplyReport> {
    const run = this.mutex.then(() => this.applyLocked(decisions));
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private buildSpec(nodeId: string): Omit<RemoteSpec, "workerId"> {
    const node = this.lastKnownNodes.get(nodeId);
    return {
      capabilities: this.requirements.capabilities ?? [],
      managerUrl: this.managerUrl ?? node?.descriptor.managerUrl ?? "https://cluster.local",
      authToken: this.authToken ?? "",
    };
  }

  private async applyScaleUp(decision: ScaleDecision, report: ApplyReport): Promise<void> {
    let remaining = decision.to - this.countActiveWorkers(decision.nodeId);
    const allMatching = this.matchingDescriptors();

    if (remaining > 0 && allMatching.length === 0) {
      const nowActive = this.countActiveWorkers(decision.nodeId);
      report.skipped.push({ nodeId: decision.nodeId, from: nowActive, to: decision.to, delta: remaining, reason: "no-backend" });
      return;
    }

    while (remaining > 0) {
      const excludedThisUnit = new Set<string>();
      let unitDone = false;

      while (!unitDone) {
        const now = this.nowFn();
        const eligible = allMatching.filter((d) => !excludedThisUnit.has(d.name) && !this.isBackedOff(d.name, now));

        if (eligible.length === 0) {
          const allBackedOffOrTried = allMatching.every((d) => excludedThisUnit.has(d.name) || this.isBackedOff(d.name, now));
          const reason: ScaleReason = allBackedOffOrTried ? "backoff" : "no-backend";
          const nowActive = this.countActiveWorkers(decision.nodeId);
          report.skipped.push({ nodeId: decision.nodeId, from: nowActive, to: decision.to, delta: remaining, reason });
          remaining = 0;
          break;
        }

        const currentCost = this.costPerHourUsd();
        const withinBudget = eligible.filter(
          (d) => this.maxCostPerHourUsd === undefined || currentCost + d.cost.perRunningHourUsd <= this.maxCostPerHourUsd,
        );

        if (withinBudget.length === 0) {
          const nowActive = this.countActiveWorkers(decision.nodeId);
          report.skipped.push({ nodeId: decision.nodeId, from: nowActive, to: decision.to, delta: remaining, reason: "budget-cap" });
          this.emit("budget:capped", currentCost);
          remaining = 0;
          break;
        }

        const best = this.bestCandidate(withinBudget) as BackendDescriptor;
        const workerId = `${decision.nodeId}-w${++this.workerIdSeq}`;
        const spec: RemoteSpec = { workerId, ...this.buildSpec(decision.nodeId) };
        const t0 = this.nowFn();

        try {
          const result = await this.registry.provision(spec, best.name);
          const t1 = this.nowFn();
          this.workersMap.set(workerId, {
            workerId,
            nodeId: decision.nodeId,
            backendName: best.name,
            state: result.handle.state,
            startedAt: result.handle.startedAt,
          });
          this.observe(best.name, { ok: true, latencyMs: Math.max(0, t1 - t0), costUsd: best.cost.perProvisionUsd });
          report.provisioned.push({ nodeId: decision.nodeId, workerId, backendName: best.name, ok: true, handle: result.handle });
          unitDone = true;
          remaining -= 1;
        } catch (err) {
          const t1 = this.nowFn();
          const message = err instanceof Error ? err.message : String(err);
          this.observe(best.name, { ok: false, latencyMs: Math.max(0, t1 - t0) });
          this.provisionFailuresCount += 1;
          report.provisioned.push({ nodeId: decision.nodeId, workerId, backendName: best.name, ok: false, error: message });
          this.emit("provision:failed", decision.nodeId, best.name, message);
          excludedThisUnit.add(best.name);
          // Loop again: try the next-best not-yet-tried, not-backed-off
          // candidate for this same unit.
        }
      }
    }
  }

  private async applyScaleDown(decision: ScaleDecision, report: ApplyReport): Promise<void> {
    const currentActive = this.countActiveWorkers(decision.nodeId);
    const excess = currentActive - Math.max(0, decision.to);
    if (excess <= 0) return;

    const candidates = [...this.workersMap.values()]
      .filter((w) => w.nodeId === decision.nodeId && ACTIVE_WORKER_STATES.has(w.state))
      .sort((a, b) => b.startedAt - a.startedAt || b.workerId.localeCompare(a.workerId));
    const toRemove = candidates.slice(0, excess);
    const hibernateFirst = decision.reason === "idle" && decision.to === 0;

    for (const w of toRemove) {
      try {
        if (hibernateFirst && this.registry.get(w.backendName)?.hibernate) {
          try {
            await this.registry.hibernate(w.workerId);
            w.state = "hibernated";
          } catch {
            // Best-effort: a failed hibernate never blocks the terminate
            // that follows — the worker still must go away.
          }
        }
        await this.registry.terminate(w.workerId);
        this.workersMap.delete(w.workerId);
        report.terminated.push({ nodeId: decision.nodeId, workerId: w.workerId, backendName: w.backendName, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Termination genuinely failed: the worker is still (as far as we
        // know) alive out there, so it stays tracked — stats() must never
        // claim a worker is gone that the backend never actually released.
        report.terminated.push({ nodeId: decision.nodeId, workerId: w.workerId, backendName: w.backendName, ok: false, error: message });
      }
    }
  }

  private async applyLocked(decisions: ScaleDecision[]): Promise<ApplyReport> {
    const report: ApplyReport = { provisioned: [], terminated: [], skipped: [], costPerHourUsd: 0 };
    const sorted = [...decisions].sort((a, b) => a.nodeId.localeCompare(b.nodeId));

    for (const decision of sorted) {
      if (decision.delta === 0) {
        report.skipped.push(decision);
        continue;
      }
      const currentActive = this.countActiveWorkers(decision.nodeId);
      if (decision.to > currentActive) {
        await this.applyScaleUp(decision, report);
      } else if (decision.to < currentActive) {
        await this.applyScaleDown(decision, report);
      }
      // decision.to === currentActive already (stale/idempotent replay of a
      // previously-applied decision): nothing left to do, by design.
    }

    report.costPerHourUsd = this.costPerHourUsd();
    return report;
  }

  // ── Introspection ─────────────────────────────────────────────────────

  workers(nodeId?: string): Array<{ workerId: string; nodeId: string; backendName: string; state: RemoteState; startedAt: number }> {
    const all = [...this.workersMap.values()].map((w) => ({ ...w }));
    return nodeId === undefined ? all : all.filter((w) => w.nodeId === nodeId);
  }

  stats(): AutoscalerStats {
    const workersByNode: Record<string, number> = {};
    const workersByBackend: Record<string, number> = {};
    for (const w of this.workersMap.values()) {
      workersByNode[w.nodeId] = (workersByNode[w.nodeId] ?? 0) + 1;
      workersByBackend[w.backendName] = (workersByBackend[w.backendName] ?? 0) + 1;
    }
    const backoffs: Record<string, number> = {};
    for (const [name, count] of this.backoffEnterCount) backoffs[name] = count;

    return {
      evaluations: this.evaluationsCount,
      scaleUps: this.scaleUpsCount,
      scaleDowns: this.scaleDownsCount,
      provisionFailures: this.provisionFailuresCount,
      backoffs,
      workersByNode,
      workersByBackend,
      costPerHourUsd: this.costPerHourUsd(),
    };
  }

  async shutdown(): Promise<void> {
    const run = this.mutex.then(() => this.shutdownLocked());
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async shutdownLocked(): Promise<void> {
    const all = [...this.workersMap.values()];
    for (const w of all) {
      try {
        await this.registry.terminate(w.workerId);
      } catch {
        // Best-effort teardown: shutdown must still drop our own tracking
        // even if the remote side is already gone / unreachable.
      }
      this.workersMap.delete(w.workerId);
    }
  }
}
