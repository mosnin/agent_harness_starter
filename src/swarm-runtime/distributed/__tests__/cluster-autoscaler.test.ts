import { describe, expect, it } from "vitest";

import { RemoteBackendRegistry, type RemoteBackend, type RemoteHandle, type RemoteSpec, type RemoteState } from "../../../hades/backends/backend";
import { FakeBackend } from "../../../hades/backends/fake-backend";
import type { BackendCostModel, BackendDescriptor } from "../../../hades/backends/descriptor";
import type { NodeDescriptor, NodeState, NodeHealth } from "../membership";
import type { IsolationKind } from "../../types";
import { ClusterAutoscaler, type ScaleSignal } from "../cluster-autoscaler";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Deterministic mutable clock — never Date.now / real sleeps. */
class VirtualClock {
  value = 0;
  now = (): number => this.value;
  advance(ms: number): void {
    this.value += ms;
  }
}

function cost(overrides: Partial<BackendCostModel> = {}): BackendCostModel {
  return { perRunningHourUsd: 1, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured", ...overrides };
}

function mkBackendDescriptor(name: string, overrides: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    name,
    kind: "ssh",
    capabilities: ["exec"],
    cost: cost(),
    supportsHibernate: true,
    locality: "remote",
    ...overrides,
  };
}

function mkNodeDescriptor(nodeId: string, overrides: Partial<NodeDescriptor> = {}): NodeDescriptor {
  return {
    nodeId,
    managerUrl: `https://${nodeId}.internal:9443`,
    capabilities: ["exec"],
    capacity: { maxWorkers: 8, providerKinds: ["process"] as IsolationKind[] },
    publicKeyHex: `pk-${nodeId}`,
    startedAt: 0,
    ...overrides,
  };
}

function mkNodeState(nodeId: string, overrides: Partial<NodeState> & { descriptorOverrides?: Partial<NodeDescriptor> } = {}): NodeState {
  const { descriptorOverrides, ...rest } = overrides;
  return {
    descriptor: mkNodeDescriptor(nodeId, descriptorOverrides),
    health: "alive" as NodeHealth,
    incarnation: 0,
    lastSeenAt: 0,
    load: 0,
    liveWorkers: 0,
    ...rest,
  };
}

function mkSignal(overrides: Partial<ScaleSignal> = {}): ScaleSignal {
  return {
    now: 0,
    pending: 0,
    leased: 0,
    verifiedSinceLast: 0,
    elapsedMs: 1000,
    aliveNodes: [],
    inFlightByNode: new Map(),
    ...overrides,
  };
}

/** A hand-rolled RemoteBackend (not FakeBackend) used to inject controlled
 * provisioning failures — this is testing OUR module's failure handling, not
 * mocking the backend module itself (no vi.mock anywhere in this file). */
class FlakyBackend implements RemoteBackend {
  readonly name: string;
  private counter = 0;
  /** 1-indexed call numbers on which provision() should throw. */
  private readonly failOnCalls: Set<number>;
  private readonly nowFn: () => number;

  constructor(name: string, failOnCalls: number[], now: () => number) {
    this.name = name;
    this.failOnCalls = new Set(failOnCalls);
    this.nowFn = now;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async provision(spec: RemoteSpec): Promise<RemoteHandle> {
    this.counter += 1;
    if (this.failOnCalls.has(this.counter)) {
      throw new Error(`${this.name}: simulated provision failure #${this.counter}`);
    }
    return {
      workerId: spec.workerId,
      backend: this.name,
      nativeId: `${this.name}-${this.counter}`,
      state: "running",
      startedAt: this.nowFn(),
    };
  }

  async terminate(): Promise<void> {}

  async status(): Promise<RemoteState> {
    return "running";
  }

  async logs(): Promise<string> {
    return "";
  }
}

/** Backend whose hibernate() always succeeds but whose terminate() fails
 * exactly once before succeeding on every subsequent call — used to exercise
 * the "hibernated worker survives a failed terminate, then gets cleaned up
 * later" path (including by shutdown()). */
class HibernateThenFlakyTerminateBackend implements RemoteBackend {
  readonly name = "hf";
  private terminateCalls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async provision(spec: RemoteSpec): Promise<RemoteHandle> {
    return { workerId: spec.workerId, backend: this.name, nativeId: `hf-${spec.workerId}`, state: "running", startedAt: 0 };
  }

  async terminate(handle: RemoteHandle): Promise<void> {
    this.terminateCalls += 1;
    if (this.terminateCalls === 1) throw new Error("terminate failed on first attempt");
    void handle;
  }

  async status(): Promise<RemoteState> {
    return "running";
  }

  async logs(): Promise<string> {
    return "";
  }

  async hibernate(handle: RemoteHandle): Promise<RemoteHandle> {
    return { ...handle, state: "hibernated" };
  }
}

/** Standard two-backend registry: "alpha" (cheap, $1/hr) and "beta" ($3/hr),
 * both matching the default (empty) requirement set. */
function buildRegistry(clock: VirtualClock): { registry: RemoteBackendRegistry; descriptors: BackendDescriptor[] } {
  const registry = new RemoteBackendRegistry();
  registry.register(new FakeBackend({ name: "alpha", now: clock.now }));
  registry.register(new FakeBackend({ name: "beta", now: clock.now, supportsHibernate: false }));
  const descriptors = [
    mkBackendDescriptor("alpha", { cost: cost({ perRunningHourUsd: 1 }) }),
    mkBackendDescriptor("beta", { cost: cost({ perRunningHourUsd: 3 }), supportsHibernate: false }),
  ];
  return { registry, descriptors };
}

// ---------------------------------------------------------------------------
// evaluate() — pure decision-making
// ---------------------------------------------------------------------------

describe("ClusterAutoscaler.evaluate", () => {
  it("returns no decisions when there are no known nodes", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now });
    expect(scaler.evaluate(mkSignal({ aliveNodes: [] }))).toEqual([]);
  });

  it("scales up from zero when demand appears, choosing the cheapest matching backend", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now });
    const nodeA = mkNodeState("node-a");

    const decisions = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA] }));
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    expect(d.nodeId).toBe("node-a");
    expect(d.from).toBe(0);
    expect(d.to).toBe(5); // ceil(10 / targetQueuePerWorker=2)
    expect(d.delta).toBe(5);
    expect(d.reason).toBe("demand");
    expect(d.backendName).toBe("alpha"); // cheaper of the two, zero telemetry
    expect(d.estCostPerHourUsd).toBe(1);
  });

  it("honors a configured targetQueuePerWorker ratio", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now, targetQueuePerWorker: 5 });
    const nodeA = mkNodeState("node-a");
    const [d] = scaler.evaluate(mkSignal({ pending: 12, aliveNodes: [nodeA] }));
    expect(d.to).toBe(3); // ceil(12 / 5)
  });

  it("clamps the cluster desired total up to min (floor)", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 2, max: 10, now: clock.now });
    const nodeA = mkNodeState("node-a");
    const [d] = scaler.evaluate(mkSignal({ pending: 0, leased: 0, aliveNodes: [nodeA] }));
    expect(d.to).toBe(2);
    expect(d.reason).toBe("floor");
  });

  it("clamps the cluster desired total down to max (ceiling)", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 3, now: clock.now });
    const nodeA = mkNodeState("node-a", { descriptorOverrides: { capacity: { maxWorkers: 20, providerKinds: [] } } });
    const [d] = scaler.evaluate(mkSignal({ pending: 500, aliveNodes: [nodeA] }));
    expect(d.to).toBe(3);
    expect(d.reason).toBe("ceiling");
  });

  it("bounds a node's allocation by its own descriptor.capacity.maxWorkers", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now });
    const nodeA = mkNodeState("node-a", { descriptorOverrides: { capacity: { maxWorkers: 1, providerKinds: [] } } });
    const [d] = scaler.evaluate(mkSignal({ pending: 100, aliveNodes: [nodeA] }));
    expect(d.to).toBe(1); // hard node cap, well under cluster max
  });

  it("prioritizes nodes with higher per-node lease pressure when demand is scarce", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now, targetQueuePerWorker: 1 });
    const nodeA = mkNodeState("node-a");
    const nodeB = mkNodeState("node-b");
    const inFlightByNode = new Map([
      ["node-a", 0],
      ["node-b", 5],
    ]);
    const decisions = scaler.evaluate(mkSignal({ pending: 1, aliveNodes: [nodeA, nodeB], inFlightByNode }));
    const byNode = Object.fromEntries(decisions.map((d) => [d.nodeId, d]));
    expect(byNode["node-b"].to).toBe(1);
    expect(byNode["node-a"].to).toBe(0);
  });

  it("forces a suspect/dead node's allocation to zero regardless of demand", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now });
    const nodeA = mkNodeState("node-a");

    // First bring node-a up to 5 workers.
    const up = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA] }));
    return scaler.apply(up).then(() => {
      const deadNodeA = mkNodeState("node-a", { health: "dead" });
      clock.advance(1);
      const [d] = scaler.evaluate(mkSignal({ now: clock.now(), pending: 10, aliveNodes: [deadNodeA] }));
      expect(d.reason).toBe("node-unhealthy");
      expect(d.to).toBe(0);
      expect(d.from).toBe(5);
    });
  });

  it("forces a node's allocation to zero when it vanishes from the roster entirely", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now });
    const nodeA = mkNodeState("node-a");

    const up = scaler.evaluate(mkSignal({ pending: 4, aliveNodes: [nodeA] }));
    await scaler.apply(up);

    clock.advance(1);
    const [d] = scaler.evaluate(mkSignal({ now: clock.now(), pending: 4, aliveNodes: [] }));
    expect(d.nodeId).toBe("node-a");
    expect(d.reason).toBe("node-unhealthy");
    expect(d.to).toBe(0);
  });

  it("abstains honestly with no-backend when no descriptor satisfies the requirements", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({
      registry,
      descriptors,
      min: 0,
      max: 10,
      now: clock.now,
      requirements: { capabilities: ["gpu"] },
    });
    const nodeA = mkNodeState("node-a");
    const [d] = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA] }));
    expect(d.reason).toBe("no-backend");
    expect(d.to).toBe(0);
    expect(d.backendName).toBeUndefined();
  });

  it("reports backoff (not no-backend) when matching backends exist but are all currently backed off", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now, failureBackoffMs: 5000 });
    scaler.observe("alpha", { ok: false, latencyMs: 5 });
    scaler.observe("beta", { ok: false, latencyMs: 5 });

    const nodeA = mkNodeState("node-a");
    const [d] = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA] }));
    expect(d.reason).toBe("backoff");
    expect(d.to).toBe(0);
  });

  it("blocks a repeat scale-up within the cooldown window, then allows it after", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 20, now: clock.now, scaleUpCooldownMs: 10_000 });
    const nodeA = mkNodeState("node-a");

    const first = scaler.evaluate(mkSignal({ now: 0, pending: 10, aliveNodes: [nodeA] }));
    expect(first[0].to).toBe(5);
    await scaler.apply(first); // realize it, so "current" reflects reality for the next tick

    clock.advance(1000);
    const second = scaler.evaluate(mkSignal({ now: clock.now(), pending: 40, aliveNodes: [nodeA] }));
    expect(second[0].reason).toBe("cooldown");
    expect(second[0].to).toBe(5); // unchanged: still what's actually running
    await scaler.apply(second);

    clock.advance(10_000);
    const third = scaler.evaluate(mkSignal({ now: clock.now(), pending: 40, aliveNodes: [nodeA] }));
    expect(third[0].reason).toBe("demand");
    expect(third[0].to).toBe(8); // ceil(40/2)=20, but capped by node-a's own capacity.maxWorkers (8)
  });

  it("does not thrash on an oscillating 10 -> 0 -> 10 -> 0 queue (bounded scale-event count)", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({
      registry,
      descriptors,
      min: 0,
      max: 20,
      now: clock.now,
      scaleUpCooldownMs: 1000,
      scaleDownCooldownMs: 1000,
      idleBeforeScaleDownMs: 50_000, // much longer than the oscillation period
    });
    const nodeA = mkNodeState("node-a");

    const pendingSequence = [10, 0, 10, 0, 10, 0, 10, 0];
    for (const pending of pendingSequence) {
      const decisions = scaler.evaluate(mkSignal({ now: clock.now(), pending, aliveNodes: [nodeA] }));
      await scaler.apply(decisions); // realize each decision, exactly as a real control loop would
      clock.advance(2000);
    }

    const stats = scaler.stats();
    expect(stats.evaluations).toBe(pendingSequence.length);
    expect(stats.scaleUps).toBe(1); // only the very first tick actually changed anything
    expect(stats.scaleDowns).toBe(0); // never idle long enough to earn a scale-down
    expect(scaler.workers()).toHaveLength(5); // settled, never bounced
  });

  it("scales a fully-idle cluster to zero once idleBeforeScaleDownMs has elapsed, when min is 0", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({
      registry,
      descriptors,
      min: 0,
      max: 20,
      now: clock.now,
      idleBeforeScaleDownMs: 30_000,
      scaleDownCooldownMs: 0,
    });
    const nodeA = mkNodeState("node-a");

    const up = scaler.evaluate(mkSignal({ now: 0, pending: 10, aliveNodes: [nodeA] }));
    await scaler.apply(up);
    expect(scaler.workers()).toHaveLength(5);

    clock.advance(1);
    scaler.evaluate(mkSignal({ now: clock.now(), pending: 0, aliveNodes: [nodeA] })); // demand drops to zero here
    clock.advance(30_001);
    const [d] = scaler.evaluate(mkSignal({ now: clock.now(), pending: 0, aliveNodes: [nodeA] }));
    expect(d.reason).toBe("idle");
    expect(d.to).toBe(0);
    expect(d.from).toBe(5);
  });

  it("never scales to true zero when min > 0, even after a very long idle period", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({
      registry,
      descriptors,
      min: 2,
      max: 20,
      now: clock.now,
      idleBeforeScaleDownMs: 1000,
      scaleDownCooldownMs: 0,
    });
    const nodeA = mkNodeState("node-a");

    scaler.evaluate(mkSignal({ now: 0, pending: 10, aliveNodes: [nodeA] }));
    clock.advance(1_000_000);
    const [d] = scaler.evaluate(mkSignal({ now: clock.now(), pending: 0, aliveNodes: [nodeA] }));
    expect(d.to).toBe(2);
    expect(d.reason).toBe("floor");
  });
});

// ---------------------------------------------------------------------------
// observe() — telemetry-driven routing
// ---------------------------------------------------------------------------

describe("ClusterAutoscaler.observe", () => {
  it("shifts backend selection toward the backend with the better observed track record", () => {
    const clock = new VirtualClock();
    const registry = new RemoteBackendRegistry();
    registry.register(new FakeBackend({ name: "pricey-but-reliable", now: clock.now }));
    registry.register(new FakeBackend({ name: "cheap-but-flaky", now: clock.now }));
    const descriptors = [
      mkBackendDescriptor("pricey-but-reliable", { cost: cost({ perRunningHourUsd: 4 }) }),
      mkBackendDescriptor("cheap-but-flaky", { cost: cost({ perRunningHourUsd: 0.5 }) }),
    ];
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now });

    // With no telemetry, the cheap backend wins on cost.
    const nodeA = mkNodeState("node-a");
    const before = scaler.evaluate(mkSignal({ pending: 2, aliveNodes: [nodeA] }));
    expect(before[0].backendName).toBe("cheap-but-flaky");

    // Feed enough real failure telemetry to tank the cheap backend's score
    // below the reliable one's, without ever putting it fully into backoff
    // (observe() resets backoff on success — alternate ok:false to accumulate
    // a bad failure rate while never triggering the hard backoff gate).
    for (let i = 0; i < 8; i++) {
      scaler.observe("cheap-but-flaky", { ok: false, latencyMs: 1 });
      scaler.observe("cheap-but-flaky", { ok: true, latencyMs: 1 }); // clears backoff each time
    }

    clock.advance(100_000); // clear any residual backoff window deterministically
    const nodeB = mkNodeState("node-b");
    const after = scaler.evaluate(mkSignal({ now: clock.now(), pending: 2, aliveNodes: [nodeB] }));
    expect(after[0].backendName).toBe("pricey-but-reliable");
  });
});

// ---------------------------------------------------------------------------
// apply() — the effectful half
// ---------------------------------------------------------------------------

describe("ClusterAutoscaler.apply", () => {
  it("provisions workers through the real registry/FakeBackend and tracks them accurately", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now });
    const nodeA = mkNodeState("node-a");

    const decisions = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA] }));
    const report = await scaler.apply(decisions);

    expect(report.provisioned).toHaveLength(5);
    expect(report.provisioned.every((p) => p.ok)).toBe(true);
    expect(report.provisioned.every((p) => p.backendName === "alpha")).toBe(true);
    expect(scaler.workers()).toHaveLength(5);
    expect(scaler.stats().workersByNode["node-a"]).toBe(5);
    expect(scaler.stats().costPerHourUsd).toBe(5);
    expect(report.costPerHourUsd).toBe(5);
  });

  it("is idempotent: applying the same decisions twice never double-provisions", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now });
    const nodeA = mkNodeState("node-a");
    const decisions = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA] }));

    await scaler.apply(decisions);
    expect(scaler.workers()).toHaveLength(5);

    const second = await scaler.apply(decisions);
    expect(second.provisioned).toHaveLength(0);
    expect(second.terminated).toHaveLength(0);
    expect(scaler.workers()).toHaveLength(5);
  });

  it("does not double-count or leak handles across overlapping apply() calls", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now });
    const nodeA = mkNodeState("node-a");
    const decisions = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA] }));

    const [r1, r2] = await Promise.all([scaler.apply(decisions), scaler.apply(decisions)]);
    expect(scaler.workers()).toHaveLength(5);
    expect(r1.provisioned.length + r2.provisioned.length).toBe(5);
  });

  it("backs a failing backend off with real exponential growth, shifts traffic, then re-admits it on recovery", async () => {
    const clock = new VirtualClock();
    const registry = new RemoteBackendRegistry();
    const flaky = new FlakyBackend("flaky", [1], clock.now); // fails its first call only
    registry.register(flaky);
    registry.register(new FakeBackend({ name: "alpha", now: clock.now }));
    const descriptors = [
      // flaky is dramatically cheaper so it wins on cost even after eating a
      // full failure-rate penalty from its one recorded failure; alpha's
      // rate is set at the cost term's saturation point so a single failure
      // is what it takes to keep it competitive without permanently locking
      // flaky out once it recovers.
      mkBackendDescriptor("flaky", { cost: cost({ perRunningHourUsd: 0.01 }) }),
      mkBackendDescriptor("alpha", { cost: cost({ perRunningHourUsd: 10 }) }),
    ];
    const scaler = new ClusterAutoscaler({
      registry,
      descriptors,
      min: 0,
      max: 10,
      now: clock.now,
      failureBackoffMs: 1000,
      maxFailureBackoffMs: 8000,
    });
    const nodeA = mkNodeState("node-a", { descriptorOverrides: { capacity: { maxWorkers: 1, providerKinds: [] } } });

    const decisions = scaler.evaluate(mkSignal({ pending: 1, aliveNodes: [nodeA] }));
    const report = await scaler.apply(decisions);

    expect(report.provisioned).toHaveLength(2);
    expect(report.provisioned[0]).toMatchObject({ backendName: "flaky", ok: false });
    expect(report.provisioned[1]).toMatchObject({ backendName: "alpha", ok: true });
    expect(scaler.workers()).toHaveLength(1);
    expect(scaler.workers()[0].backendName).toBe("alpha");
    expect(scaler.stats().provisionFailures).toBe(1);
    expect(scaler.stats().backoffs["flaky"]).toBe(1);

    // Backoff window elapses; flaky (cheapest) is re-admitted and succeeds
    // on its second-ever provision call (only the first call was made to fail).
    clock.advance(2000);
    const nodeB = mkNodeState("node-b", { descriptorOverrides: { capacity: { maxWorkers: 1, providerKinds: [] } } });
    const decisions2 = scaler.evaluate(mkSignal({ now: clock.now(), pending: 1, aliveNodes: [nodeB] }));
    expect(decisions2.find((d) => d.nodeId === "node-b")?.backendName).toBe("flaky");
    const report2 = await scaler.apply(decisions2);
    expect(report2.provisioned).toHaveLength(1);
    expect(report2.provisioned[0]).toMatchObject({ backendName: "flaky", ok: true });
  });

  it("exponentially grows the backoff window on repeated failures, capped at maxFailureBackoffMs", () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({
      registry,
      descriptors,
      min: 0,
      max: 10,
      now: clock.now,
      failureBackoffMs: 1000,
      maxFailureBackoffMs: 5000,
    });

    const untils: number[] = [];
    scaler.on("backend:backoff", (_name, untilMs) => untils.push(untilMs));
    scaler.observe("alpha", { ok: false, latencyMs: 1 }); // backoff 1000
    scaler.observe("alpha", { ok: false, latencyMs: 1 }); // backoff 2000
    scaler.observe("alpha", { ok: false, latencyMs: 1 }); // backoff 4000
    scaler.observe("alpha", { ok: false, latencyMs: 1 }); // backoff 5000 (capped from 8000)

    expect(untils).toEqual([1000, 2000, 4000, 5000]);
    expect(scaler.stats().backoffs["alpha"]).toBe(4);
  });

  it("enforces the budget ceiling: provisions strictly under the cap and reports the shortfall", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock); // alpha $1/hr
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now, maxCostPerHourUsd: 2.5 });
    const nodeA = mkNodeState("node-a");

    let capped: number | undefined;
    scaler.on("budget:capped", (c) => (capped = c));

    const decisions = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA] })); // wants 5 workers
    const report = await scaler.apply(decisions);

    expect(report.provisioned).toHaveLength(2); // 2 * $1 = $2 <= $2.5, a 3rd would be $3 > $2.5
    expect(report.provisioned.every((p) => p.ok)).toBe(true);
    expect(report.costPerHourUsd).toBeLessThanOrEqual(2.5);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ nodeId: "node-a", reason: "budget-cap", delta: 3 });
    expect(capped).toBe(2);
  });

  it("accurately reflects a mixed batch: workers(), stats(), and costPerHourUsd match what is truly running", async () => {
    const clock = new VirtualClock();
    const registry = new RemoteBackendRegistry();
    const unstable = new FlakyBackend("unstable", [1], clock.now); // fails once, then always succeeds
    registry.register(unstable);
    registry.register(new FakeBackend({ name: "stable", now: clock.now }));
    const descriptors = [
      mkBackendDescriptor("unstable", { cost: cost({ perRunningHourUsd: 0.5 }) }),
      mkBackendDescriptor("stable", { cost: cost({ perRunningHourUsd: 2 }) }),
    ];
    const scaler = new ClusterAutoscaler({
      registry,
      descriptors,
      min: 0,
      max: 10,
      now: clock.now,
      failureBackoffMs: 10_000,
      targetQueuePerWorker: 1, // 1 worker per pending unit, so 2 pending -> 2 desired (1 per node)
    });

    const nodeA = mkNodeState("node-a", { descriptorOverrides: { capacity: { maxWorkers: 1, providerKinds: [] } } });
    const nodeB = mkNodeState("node-b", { descriptorOverrides: { capacity: { maxWorkers: 1, providerKinds: [] } } });
    const decisions = scaler.evaluate(mkSignal({ pending: 2, aliveNodes: [nodeA, nodeB] }));
    const report = await scaler.apply(decisions);

    // node-a: unstable fails once (recorded), retried immediately with
    // stable, which succeeds. node-b: unstable is already backed off from
    // node-a's failure, so stable is chosen directly.
    const failedEntries = report.provisioned.filter((p) => !p.ok);
    const okEntries = report.provisioned.filter((p) => p.ok);
    expect(failedEntries).toHaveLength(1);
    expect(okEntries).toHaveLength(2);
    expect(scaler.workers()).toHaveLength(2); // exactly what's really running, not 3
    expect(scaler.workers().every((w) => w.backendName === "stable")).toBe(true);
    expect(scaler.stats().costPerHourUsd).toBe(4); // 2 * stable's $2/hr, never counting the failed attempt
    expect(report.costPerHourUsd).toBe(4);

    // A subsequent evaluate() must see the true (successful) count, not the
    // failed attempt, and must not re-request already-satisfied capacity.
    clock.advance(1);
    const redo = scaler.evaluate(mkSignal({ now: clock.now(), pending: 2, aliveNodes: [nodeA, nodeB] }));
    for (const d of redo) {
      expect(d.from).toBe(1);
      expect(d.delta).toBe(0);
    }
  });

  it("terminates a dead node's workers and removes its capacity from the distribution within one cycle", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 20, now: clock.now });
    const nodeA = mkNodeState("node-a");
    const nodeB = mkNodeState("node-b");

    const up = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA, nodeB] }));
    await scaler.apply(up);
    const totalBefore = scaler.workers().length;
    expect(totalBefore).toBeGreaterThan(0);
    const nodeAWorkersBefore = scaler.workers("node-a").length;
    expect(nodeAWorkersBefore).toBeGreaterThan(0);

    clock.advance(1);
    const deadNodeA = mkNodeState("node-a", { health: "dead" });
    const down = scaler.evaluate(mkSignal({ now: clock.now(), pending: 10, aliveNodes: [deadNodeA, nodeB] }));
    const nodeADecision = down.find((d) => d.nodeId === "node-a")!;
    expect(nodeADecision.reason).toBe("node-unhealthy");
    expect(nodeADecision.to).toBe(0);

    const report = await scaler.apply(down);
    expect(report.terminated.filter((t) => t.nodeId === "node-a" && t.ok)).toHaveLength(nodeAWorkersBefore);
    expect(scaler.workers("node-a")).toHaveLength(0);

    // node-a's capacity must never be counted again, even if it "returns" to
    // the alive list with demand still present but stays out of this signal.
    clock.advance(1);
    const after = scaler.evaluate(mkSignal({ now: clock.now(), pending: 10, aliveNodes: [nodeB] }));
    expect(after.find((d) => d.nodeId === "node-a")).toBeUndefined();
    expect(after.find((d) => d.nodeId === "node-b")!.to).toBeGreaterThan(0);
  });

  it("never places a wrong-backend worker: apply() honestly skips when no backend matches", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({
      registry,
      descriptors,
      min: 0,
      max: 10,
      now: clock.now,
      requirements: { capabilities: ["tpu"] },
    });
    const nodeA = mkNodeState("node-a");
    const decisions = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA] }));
    expect(decisions[0].reason).toBe("no-backend");

    const report = await scaler.apply(decisions);
    expect(report.provisioned).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(scaler.workers()).toHaveLength(0);
  });

  it("hibernates before terminating on scale-to-zero when the backend supports hibernate", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock); // alpha supports hibernate
    const scaler = new ClusterAutoscaler({
      registry,
      descriptors,
      min: 0,
      max: 10,
      now: clock.now,
      idleBeforeScaleDownMs: 1000,
      scaleDownCooldownMs: 0,
    });
    const nodeA = mkNodeState("node-a");

    const up = scaler.evaluate(mkSignal({ now: 0, pending: 2, aliveNodes: [nodeA] }));
    await scaler.apply(up);
    expect(scaler.workers()).toHaveLength(1);

    clock.advance(1); // register the demand drop
    scaler.evaluate(mkSignal({ now: clock.now(), pending: 0, aliveNodes: [nodeA] }));
    clock.advance(1001);
    const [down] = scaler.evaluate(mkSignal({ now: clock.now(), pending: 0, aliveNodes: [nodeA] }));
    expect(down.reason).toBe("idle");

    const report = await scaler.apply([down]);
    expect(report.terminated).toHaveLength(1);
    expect(report.terminated[0].ok).toBe(true);
    expect(scaler.workers()).toHaveLength(0);
  });

  it("keeps a worker tracked when terminate() fails, and shutdown() cleans it up (including hibernated), safely idempotent", async () => {
    const clock = new VirtualClock();
    const registry = new RemoteBackendRegistry();
    registry.register(new HibernateThenFlakyTerminateBackend());
    const descriptors = [mkBackendDescriptor("hf", { cost: cost({ perRunningHourUsd: 1 }), supportsHibernate: true })];
    const scaler = new ClusterAutoscaler({
      registry,
      descriptors,
      min: 0,
      max: 10,
      now: clock.now,
      idleBeforeScaleDownMs: 0,
      scaleDownCooldownMs: 0,
    });
    const nodeA = mkNodeState("node-a");

    const up = scaler.evaluate(mkSignal({ now: 0, pending: 2, aliveNodes: [nodeA] }));
    await scaler.apply(up);
    expect(scaler.workers()).toHaveLength(1);

    clock.advance(1);
    scaler.evaluate(mkSignal({ now: clock.now(), pending: 0, aliveNodes: [nodeA] }));
    clock.advance(1);
    const [down] = scaler.evaluate(mkSignal({ now: clock.now(), pending: 0, aliveNodes: [nodeA] }));
    expect(down.reason).toBe("idle");

    const report = await scaler.apply([down]);
    // terminate() fails on its first call: the worker survives, honestly
    // reported as a failed termination — never silently dropped.
    expect(report.terminated).toHaveLength(1);
    expect(report.terminated[0].ok).toBe(false);
    expect(scaler.workers()).toHaveLength(1);

    await scaler.shutdown();
    expect(scaler.workers()).toHaveLength(0);

    // Safe to call twice.
    await expect(scaler.shutdown()).resolves.toBeUndefined();
    expect(scaler.workers()).toHaveLength(0);
  });

  it("returns an empty report for an empty decision list, without error", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 10, now: clock.now });
    const report = await scaler.apply([]);
    expect(report).toEqual({ provisioned: [], terminated: [], skipped: [], costPerHourUsd: 0 });
  });

  it("filters workers() by nodeId", async () => {
    const clock = new VirtualClock();
    const { registry, descriptors } = buildRegistry(clock);
    const scaler = new ClusterAutoscaler({ registry, descriptors, min: 0, max: 20, now: clock.now });
    const nodeA = mkNodeState("node-a");
    const nodeB = mkNodeState("node-b");
    const decisions = scaler.evaluate(mkSignal({ pending: 10, aliveNodes: [nodeA, nodeB] }));
    await scaler.apply(decisions);

    const aWorkers = scaler.workers("node-a");
    const bWorkers = scaler.workers("node-b");
    expect(aWorkers.every((w) => w.nodeId === "node-a")).toBe(true);
    expect(bWorkers.every((w) => w.nodeId === "node-b")).toBe(true);
    expect(aWorkers.length + bWorkers.length).toBe(scaler.workers().length);
  });
});
