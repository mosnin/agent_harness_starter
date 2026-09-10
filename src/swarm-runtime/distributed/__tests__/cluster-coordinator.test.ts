import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../../hades/styx/certificate";
import { ClusterMembership, type GossipDigest, type GossipEntry, type NodeDescriptor } from "../membership";
import type { AcceptOutcome, FederatedResultEntry } from "../lease-ledger";
import {
  ClusterCoordinator,
  costAwarePlacement,
  type Placement,
  type PlacementPolicy,
} from "../cluster-coordinator";
import type { ConsensusSpec, VerificationReport, WorkerResult, WorkerTask } from "../../types";
import type { IsolationKind } from "../../types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Deterministic mutable clock injected as `now` — never Date.now / sleep. */
class VirtualClock {
  value = 0;
  now = (): number => this.value;
  advance(ms: number): void {
    this.value += ms;
  }
}

function mkDescriptor(nodeId: string, overrides: Partial<NodeDescriptor> = {}): NodeDescriptor {
  return {
    nodeId,
    managerUrl: `https://${nodeId}.internal:9443`,
    capabilities: ["exec"],
    capacity: { maxWorkers: 4, providerKinds: ["process"] as IsolationKind[] },
    publicKeyHex: `pk-${nodeId}`,
    startedAt: 0,
    ...overrides,
  };
}

/** Builds a `ClusterMembership` for `selfId` with `otherIds` already joined and alive. */
function buildCluster(opts: {
  selfId: string;
  otherIds?: string[];
  now: () => number;
  quorumPolicy?: "majority" | "single";
  overrides?: Record<string, Partial<NodeDescriptor>>;
}): ClusterMembership {
  const m = new ClusterMembership({
    self: mkDescriptor(opts.selfId, opts.overrides?.[opts.selfId]),
    now: opts.now,
    quorumPolicy: opts.quorumPolicy ?? "majority",
  });
  for (const id of opts.otherIds ?? []) {
    m.join(mkDescriptor(id, opts.overrides?.[id]));
  }
  return m;
}

// Mirrors membership.ts's internal canonical-json + sha256 checksum exactly,
// letting the test harness hand-craft digests that pass the integrity check
// so it can directly drive a *specific* node's health (dead/alive) without
// waiting out suspect/dead timers — deterministic churn injection.
function stableJsonForTest(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJsonForTest(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonForTest(record[k])}`).join(",")}}`;
}
function checksumFor(entries: GossipEntry[]): string {
  return sha256Hex(stableJsonForTest(entries));
}

/** Marks `nodeId` dead in `m`'s view via a synthetic third-party gossip digest. */
function killNode(m: ClusterMembership, nodeId: string, now: number): void {
  const stored = m.get(nodeId);
  if (!stored) throw new Error(`killNode: unknown node ${nodeId}`);
  const entry: GossipEntry = { nodeId, incarnation: stored.incarnation, health: "dead", load: 0, liveWorkers: 0 };
  const digest: GossipDigest = { senderId: "test-harness", sentAt: now, epoch: 0, entries: [entry], checksum: checksumFor([entry]) };
  m.apply(digest);
}

/** Revives `nodeId` in `m`'s view (higher incarnation, as SWIM requires to move past `dead`). */
function reviveNode(m: ClusterMembership, nodeId: string, now: number): void {
  const stored = m.get(nodeId);
  if (!stored) throw new Error(`reviveNode: unknown node ${nodeId}`);
  const entry: GossipEntry = { nodeId, incarnation: stored.incarnation + 1, health: "alive", load: 0, liveWorkers: 0 };
  const digest: GossipDigest = { senderId: "test-harness", sentAt: now, epoch: 0, entries: [entry], checksum: checksumFor([entry]) };
  m.apply(digest);
}

let taskSeq = 0;
function mkTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  taskSeq += 1;
  return {
    id: overrides.id ?? `task-${taskSeq}`,
    goalId: "goal-1",
    description: "do the thing",
    requiredCapabilities: [],
    input: {},
    dependsOn: [],
    priority: 0,
    status: "pending",
    attempts: 0,
    maxAttempts: 5,
    createdAt: 0,
    ...overrides,
  };
}

function mkResult(taskId: string, workerId: string, output: unknown = "ok"): WorkerResult {
  return { taskId, workerId, output, claims: [], toolTrace: [], startedAt: 0, finishedAt: 1 };
}
function mkReport(taskId: string, workerId: string, verdict: VerificationReport["verdict"] = "accept"): VerificationReport {
  return { taskId, workerId, verdict, score: 0.9, checks: [], feedback: "", at: 1 };
}
function mkEntry(
  taskId: string,
  nodeId: string,
  fencing: number,
  opts: { output?: unknown; verdict?: VerificationReport["verdict"] } = {},
): FederatedResultEntry {
  return {
    taskId,
    nodeId,
    fencing,
    result: mkResult(taskId, nodeId, opts.output ?? "ok"),
    report: mkReport(taskId, nodeId, opts.verdict ?? "accept"),
  };
}

// Seeded PRNG (mulberry32) — deterministic, no external dependency.
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("ClusterCoordinator — construction", () => {
  it("rejects a non-positive leaseTtlMs", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    expect(() => new ClusterCoordinator({ membership, leaseTtlMs: 0 })).toThrow(RangeError);
    expect(() => new ClusterCoordinator({ membership, leaseTtlMs: -5 })).toThrow(RangeError);
  });

  it("rejects a negative maxAttempts", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    expect(() => new ClusterCoordinator({ membership, maxAttempts: -1 })).toThrow(RangeError);
  });

  it("starts with empty, vacuously-complete state", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    expect(c.pending()).toEqual([]);
    expect(c.verifiedTaskIds()).toEqual([]);
    expect(c.isComplete()).toBe(true);
    expect(c.stats().total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// submit()
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.submit()", () => {
  it("tracks submitted tasks as pending", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t1 = mkTask();
    const t2 = mkTask();
    c.submit([t1, t2]);
    expect(c.stats().total).toBe(2);
    expect(c.stats().pending).toBe(2);
    expect(c.state(t1.id)?.status).toBe("pending");
  });

  it("is idempotent on duplicate submission (does not reset progress)", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask();
    c.submit([t]);
    c.plan(0); // leases it
    expect(c.state(t.id)?.status).toBe("leased");
    c.submit([t]); // resubmit the same id
    expect(c.stats().total).toBe(1);
    expect(c.state(t.id)?.status).toBe("leased"); // untouched, not reset to pending
  });

  it("never throws on an empty batch", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    expect(() => c.submit([])).not.toThrow();
    expect(c.stats().total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// plan() — basic placement
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.plan() — basic placement", () => {
  it("places a pending task onto an alive, capable, capacity-available node", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, leaseTtlMs: 10_000 });
    const t = mkTask({ requiredCapabilities: ["exec"] });
    c.submit([t]);

    const placed: Placement[] = [];
    c.on("task:placed", (p) => placed.push(p));

    const placements = c.plan(0);
    expect(placements).toHaveLength(1);
    expect(placed).toHaveLength(1);
    expect(["a", "b"]).toContain(placements[0].nodeId);
    expect(placements[0].taskId).toBe(t.id);
    expect(placements[0].lease.fencing).toBe(1);
    expect(placements[0].attempt).toBe(1);
    expect(placements[0].replicaIndex).toBe(0);

    const state = c.state(t.id)!;
    expect(state.status).toBe("leased");
    expect(state.leases).toHaveLength(1);
    expect(c.stats().leased).toBe(1);
  });

  it("never double-places a task that already holds a live single-replica lease", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b", "c"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask();
    c.submit([t]);

    const first = c.plan(0);
    expect(first).toHaveLength(1);
    const second = c.plan(1);
    expect(second).toHaveLength(0); // already leased, nothing to do
    expect(c.state(t.id)!.leases).toHaveLength(1);
  });

  it("blocks with capability-miss when no alive node advertises the required capability", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask({ requiredCapabilities: ["gpu"] });
    c.submit([t]);

    const blocked: Array<[string, string]> = [];
    c.on("placement:blocked", (taskId, reason) => blocked.push([taskId, reason]));

    expect(c.plan(0)).toEqual([]);
    expect(blocked).toEqual([[t.id, "capability-miss"]]);
    expect(c.state(t.id)!.lastBlock).toBe("capability-miss");
    expect(c.state(t.id)!.status).toBe("pending");
  });

  it("blocks with no-capacity when capable nodes are all at their in-flight cap", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({
      selfId: "a",
      overrides: { a: { capacity: { maxWorkers: 0, providerKinds: ["process"] as IsolationKind[] } } },
      now: clock.now,
    });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask({ requiredCapabilities: ["exec"] });
    c.submit([t]);

    expect(c.plan(0)).toEqual([]);
    expect(c.state(t.id)!.lastBlock).toBe("no-capacity");
  });

  it("blocks with no-alive-nodes when the cluster genuinely has nobody alive", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, requireLeadership: false });
    membership.leave(); // only way to make alive() empty
    const t = mkTask();
    c.submit([t]);

    expect(c.plan(0)).toEqual([]);
    expect(c.state(t.id)!.lastBlock).toBe("no-alive-nodes");
  });

  it("respects a global maxInFlightPerNode override even when node capacity is larger", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now }); // maxWorkers: 4
    const c = new ClusterCoordinator({ membership, now: clock.now, maxInFlightPerNode: 1 });
    const t1 = mkTask();
    const t2 = mkTask();
    c.submit([t1, t2]);
    const p1 = c.plan(0);
    expect(p1).toHaveLength(1); // only one slot available cluster-wide
    // Whichever of the two tasks didn't get the single slot must be blocked.
    const placedId = p1[0].taskId;
    const blockedId = placedId === t1.id ? t2.id : t1.id;
    expect(c.state(blockedId)!.lastBlock).toBe("no-capacity");
    expect(c.state(placedId)!.status).toBe("leased");
  });

  it("respects task priority ordering deterministically (higher priority placed when capacity is scarce)", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, maxInFlightPerNode: 1 });
    const low = mkTask({ priority: 0 });
    const high = mkTask({ priority: 10 });
    c.submit([low, high]);
    const placements = c.plan(0);
    expect(placements).toHaveLength(1);
    expect(placements[0].taskId).toBe(high.id);
  });
});

// ---------------------------------------------------------------------------
// plan() — dependencies
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.plan() — dependency correctness", () => {
  it("never leases a task before all its deps are verified", async () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const dep = mkTask();
    const downstream = mkTask({ dependsOn: [dep.id] });
    c.submit([dep, downstream]);

    const p1 = c.plan(0);
    expect(p1).toHaveLength(1);
    expect(p1[0].taskId).toBe(dep.id);
    expect(c.state(downstream.id)!.status).toBe("pending");
    expect(c.state(downstream.id)!.lastBlock).toBe("deps-unmet");

    const depLease = p1[0];
    await c.report(mkEntry(dep.id, depLease.nodeId, depLease.lease.fencing));
    expect(c.state(dep.id)!.status).toBe("verified");

    const p2 = c.plan(1);
    expect(p2).toHaveLength(1);
    expect(p2[0].taskId).toBe(downstream.id);
  });

  it("keeps a downstream task blocked while its dep is reassigned mid-flight", async () => {
    const clock = new VirtualClock();
    // Self ("a") deliberately lacks "worker" so it can never be picked as the
    // dep's holder — the leader's own SWIM entry can't be killed via gossip
    // (self-downgrade protection), so the node we're about to kill must be a
    // real (non-self) worker.
    const membership = buildCluster({
      selfId: "a",
      otherIds: ["b", "c"],
      now: clock.now,
      overrides: { b: { capabilities: ["exec", "worker"] }, c: { capabilities: ["exec", "worker"] } },
    });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const dep = mkTask({ requiredCapabilities: ["worker"] });
    const downstream = mkTask({ dependsOn: [dep.id], requiredCapabilities: ["worker"] });
    c.submit([dep, downstream]);

    const p1 = c.plan(0);
    const depNode = p1[0].nodeId;
    expect(c.state(downstream.id)!.status).toBe("pending");

    // Dep's holder actually dies (membership marks it dead) before ever reporting —
    // the leader reacts by reclaiming the lease. Dep goes back to pending, not verified.
    killNode(membership, depNode, 1);
    c.onNodeDown(depNode, "dead");
    expect(c.state(dep.id)!.status).toBe("pending");
    expect(c.state(dep.id)!.attempts).toBe(1); // preserved, not incremented by onNodeDown

    const p2 = c.plan(1);
    expect(p2).toHaveLength(1);
    expect(p2[0].taskId).toBe(dep.id);
    expect(p2[0].nodeId).not.toBe(depNode);
    // Downstream must still never have been placed.
    expect(c.state(downstream.id)!.status).toBe("pending");
    expect(c.state(downstream.id)!.leases).toHaveLength(0);

    await c.report(mkEntry(dep.id, p2[0].nodeId, p2[0].lease.fencing));
    expect(c.state(dep.id)!.status).toBe("verified");

    const p3 = c.plan(2);
    expect(p3.map((p) => p.taskId)).toEqual([downstream.id]);
  });
});

// ---------------------------------------------------------------------------
// plan() — consensus replicas
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.plan() — consensus replicas", () => {
  it("places an N-replica task on N distinct nodes with ordinal fencing tokens", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b", "c", "d"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, consensus: { replicas: 3, quorum: 0.6 } });
    const t = mkTask();
    c.submit([t]);

    const placements = c.plan(0);
    expect(placements).toHaveLength(3);
    const nodeIds = new Set(placements.map((p) => p.nodeId));
    expect(nodeIds.size).toBe(3);
    expect(placements.map((p) => p.lease.fencing).sort((x, y) => x - y)).toEqual([1, 2, 3]);
    expect(placements.every((p) => p.attempt === 1)).toBe(true);
    expect(new Set(placements.map((p) => p.replicaIndex))).toEqual(new Set([0, 1, 2]));
    expect(c.state(t.id)!.status).toBe("leased");
    expect(c.state(t.id)!.leases).toHaveLength(3);
  });

  it("blocks with replica-exhausted rather than placing two replicas on one node", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now }); // only 2 alive total
    const c = new ClusterCoordinator({ membership, now: clock.now, consensus: { replicas: 3, quorum: 0.6 } });
    const t = mkTask();
    c.submit([t]);

    const blocked: Array<[string, string]> = [];
    c.on("placement:blocked", (taskId, reason) => blocked.push([taskId, reason]));

    expect(c.plan(0)).toEqual([]);
    expect(blocked).toEqual([[t.id, "replica-exhausted"]]);
    expect(c.state(t.id)!.status).toBe("pending");
    expect(c.state(t.id)!.leases).toHaveLength(0);
  });

  it("reaches quorum on the 2nd of 3 accepted replicas, verifies once, and revokes the remaining replica's lease", async () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b", "c", "d"], now: clock.now });
    const spec: ConsensusSpec = { replicas: 3, quorum: 0.6 }; // ceil(3*0.6)=2
    const c = new ClusterCoordinator({ membership, now: clock.now, consensus: spec });
    const t = mkTask();
    c.submit([t]);
    const placements = c.plan(0);

    const verifiedEvents: Array<[string, FederatedResultEntry]> = [];
    c.on("task:verified", (taskId, entry) => verifiedEvents.push([taskId, entry]));

    const [r1, r2, r3] = placements;
    const o1 = await c.report(mkEntry(t.id, r1.nodeId, r1.lease.fencing, { output: "consensus-output" }));
    expect(o1).toMatchObject({ accepted: true, quorumMet: false });
    expect(c.state(t.id)!.status).toBe("leased");

    const o2 = await c.report(mkEntry(t.id, r2.nodeId, r2.lease.fencing, { output: "consensus-output" }));
    expect(o2).toMatchObject({ accepted: true, quorumMet: true });
    expect(c.state(t.id)!.status).toBe("verified");
    expect(c.state(t.id)!.leases).toHaveLength(0); // r3's lease pre-emptively revoked
    expect(verifiedEvents).toHaveLength(1);

    // A late, valid, matching report from the 3rd (never-explicitly-revoked-by-it) replica
    // is accepted by the ledger but does not re-fire task:verified.
    const o3 = await c.report(mkEntry(t.id, r3.nodeId, r3.lease.fencing, { output: "consensus-output" }));
    expect(o3.accepted).toBe(true);
    expect(verifiedEvents).toHaveLength(1);
    expect(c.stats().verified).toBe(1);
  });

  it("surfaces genuinely divergent replica outputs as a conflict rather than silently overwriting the verified record", async () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    // Deliberately: per-task consensus asks for 2 replicas, but the coordinator's
    // results ledger is NOT configured with a global consensus spec, so it runs
    // in single-owner (first-write-wins) mode even though two leases are live at
    // once. This models "run N candidates, but only the first genuinely-verified
    // answer counts, and any later disagreement is surfaced, never silently
    // applied over it" — a legitimate policy distinct from quorum consensus.
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask({ consensus: { replicas: 2, quorum: 1 } });
    c.submit([t]);
    const [r1, r2] = c.plan(0);
    expect(c.state(t.id)!.leases).toHaveLength(2);

    const o1 = await c.report(mkEntry(t.id, r1.nodeId, r1.lease.fencing, { output: "X" }));
    expect(o1).toMatchObject({ accepted: true });
    expect(c.state(t.id)!.status).toBe("verified");

    const o2 = await c.report(mkEntry(t.id, r2.nodeId, r2.lease.fencing, { output: "Y" }));
    expect(o2).toEqual({ accepted: false, reason: "conflict" });
    expect(c.stats().conflicts).toBe(1);
    expect(c.state(t.id)!.status).toBe("verified"); // untouched — first write still wins
  });
});

// ---------------------------------------------------------------------------
// plan() — leadership & quorum
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.plan() — leadership & quorum", () => {
  it("returns [] and blocks every pending task with no-quorum when this node lacks quorum", () => {
    const clock = new VirtualClock();
    // 5 known nodes total (self + 4). Majority = 3.
    const membership = buildCluster({ selfId: "a", otherIds: ["b", "c", "d", "e"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask();
    c.submit([t]);

    killNode(membership, "b", 0);
    killNode(membership, "c", 0);
    killNode(membership, "d", 0); // alive: a, e = 2 < majority(5)=3

    expect(membership.election().quorum).toBe(false);

    const blocked: Array<[string, string]> = [];
    c.on("placement:blocked", (taskId, reason) => blocked.push([taskId, reason]));
    expect(c.plan(0)).toEqual([]);
    expect(blocked).toEqual([[t.id, "no-quorum"]]);
    expect(c.state(t.id)!.status).toBe("pending");
  });

  it("resumes placement cleanly, at a higher epoch, once quorum returns", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b", "c", "d", "e"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask();
    c.submit([t]);

    killNode(membership, "b", 0);
    killNode(membership, "c", 0);
    killNode(membership, "d", 0);
    const epochDown = membership.election().epoch;
    expect(c.plan(0)).toEqual([]);

    reviveNode(membership, "b", 1);
    reviveNode(membership, "c", 1);
    const epochUp = membership.election().epoch;
    expect(epochUp).toBeGreaterThan(epochDown);
    expect(membership.election().quorum).toBe(true);

    const placements = c.plan(1);
    expect(placements).toHaveLength(1);
    expect(c.state(t.id)!.status).toBe("leased");
  });

  it("bypasses the leadership/quorum gate entirely when requireLeadership is false", () => {
    const clock = new VirtualClock();
    // self ("z") is never lexicographically first, so it would never be elected leader.
    const membership = buildCluster({ selfId: "z", otherIds: ["a", "b"], now: clock.now });
    expect(membership.election().leaderId).not.toBe("z");
    const c = new ClusterCoordinator({ membership, now: clock.now, requireLeadership: false });
    const t = mkTask();
    c.submit([t]);
    expect(c.plan(0)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// plan() — determinism & scale
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.plan() — determinism & scale", () => {
  it("produces identical placements across two independently-built, identically-configured coordinators", () => {
    function build(): ClusterCoordinator {
      const clock = new VirtualClock();
      const membership = buildCluster({ selfId: "a", otherIds: ["b", "c", "d", "e"], now: clock.now });
      const c = new ClusterCoordinator({ membership, now: clock.now });
      const tasks = Array.from({ length: 12 }, (_, i) => mkTask({ id: `det-${i}`, priority: i % 3 }));
      c.submit(tasks);
      return c;
    }
    const c1 = build();
    const c2 = build();
    const p1 = c1.plan(0).map((p) => ({ taskId: p.taskId, nodeId: p.nodeId, fencing: p.lease.fencing }));
    const p2 = c2.plan(0).map((p) => ({ taskId: p.taskId, nodeId: p.nodeId, fencing: p.lease.fencing }));
    expect(p1).toEqual(p2);
  });

  it("plans 500 tasks over 25 nodes well under a second (real timing guard)", () => {
    const clock = new VirtualClock();
    const nodeIds = Array.from({ length: 24 }, (_, i) => `n${i}`);
    const membership = buildCluster({
      selfId: "leader",
      otherIds: nodeIds,
      now: clock.now,
      overrides: Object.fromEntries(
        ["leader", ...nodeIds].map((id) => [id, { capacity: { maxWorkers: 50, providerKinds: ["process"] as IsolationKind[] } }]),
      ),
    });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const tasks = Array.from({ length: 500 }, (_, i) => mkTask({ id: `bulk-${i}` }));
    c.submit(tasks);

    const start = Date.now();
    const placements = c.plan(0);
    const elapsedMs = Date.now() - start;

    expect(placements).toHaveLength(500);
    expect(elapsedMs).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// renew()
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.renew()", () => {
  it("extends an active lease's expiry when nodeId+fencing match", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, leaseTtlMs: 1_000 });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);
    const renewed = c.renew(t.id, p.nodeId, p.lease.fencing, 500);
    expect(renewed).not.toBeNull();
    expect(renewed!.expiresAt).toBe(1_500);
  });

  it("fails closed for a wrong fencing token, unknown task, or NaN fencing — never throws", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);

    expect(c.renew(t.id, p.nodeId, p.lease.fencing + 99, 1)).toBeNull();
    expect(c.renew("nonexistent-task", p.nodeId, p.lease.fencing, 1)).toBeNull();
    expect(() => c.renew(t.id, p.nodeId, Number.NaN, 1)).not.toThrow();
    expect(c.renew(t.id, p.nodeId, Number.NaN, 1)).toBeNull();
    expect(c.renew(t.id, p.nodeId, -5, 1)).toBeNull();
  });

  it("refuses to renew an already-expired lease", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, leaseTtlMs: 100 });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);
    expect(c.renew(t.id, p.nodeId, p.lease.fencing, 100)).toBeNull(); // now >= expiresAt(100)
  });
});

// ---------------------------------------------------------------------------
// report() — exactly-once & fencing safety
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.report() — exactly-once & fencing safety", () => {
  it("accepts a valid report, revokes the lease, and verifies the task exactly once", async () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);

    const verified: Array<[string, FederatedResultEntry]> = [];
    c.on("task:verified", (taskId, entry) => verified.push([taskId, entry]));

    const outcome = await c.report(mkEntry(t.id, p.nodeId, p.lease.fencing));
    expect(outcome).toMatchObject({ accepted: true, first: true });
    expect(c.state(t.id)!.status).toBe("verified");
    expect(c.state(t.id)!.leases).toHaveLength(0);
    expect(verified).toHaveLength(1);
    expect(c.verifiedTaskIds()).toEqual([t.id]);
  });

  it("fails closed for a report on a taskId the coordinator never submitted", async () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const outcome = await c.report(mkEntry("ghost-task", "a", 1));
    expect(outcome).toEqual({ accepted: false, reason: "unknown-task" });
  });

  it("fails closed for a report from a node that never held the lease (forged fencing)", async () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);
    const impostor = p.nodeId === "a" ? "b" : "a";

    const rejected: Array<[string, string, AcceptOutcome]> = [];
    c.on("result:rejected", (taskId, nodeId, outcome) => rejected.push([taskId, nodeId, outcome]));

    const outcome = await c.report(mkEntry(t.id, impostor, p.lease.fencing));
    expect(outcome).toEqual({ accepted: false, reason: "stale-fencing" });
    expect(rejected).toHaveLength(1);
    expect(c.stats().staleReportsRejected).toBe(1);
    expect(c.state(t.id)!.status).toBe("leased"); // untouched
  });

  it("(fencing safety) rejects a late report from the zombie original holder without ever overwriting the verified record", async () => {
    const clock = new VirtualClock();
    // Self ("a") deliberately lacks "worker" so the leader itself is never the
    // node picked to hold (and later be killed as) the zombie lease — the
    // leader's own SWIM entry cannot be killed via gossip (self-downgrade
    // protection), so the zombie must be a real, killable, non-self worker.
    const membership = buildCluster({
      selfId: "a",
      otherIds: ["b", "c"],
      now: clock.now,
      overrides: { b: { capabilities: ["exec", "worker"] }, c: { capabilities: ["exec", "worker"] } },
    });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask({ requiredCapabilities: ["worker"] });
    c.submit([t]);

    const [p1] = c.plan(0);
    const zombieFencing = p1.lease.fencing;
    const zombieNode = p1.nodeId;

    // The zombie actually dies (membership marks it dead) before it ever reports.
    killNode(membership, zombieNode, 1);
    c.onNodeDown(zombieNode, "dead"); // reclaimed
    const [p2] = c.plan(1);
    expect(p2.nodeId).not.toBe(zombieNode);

    const goodOutcome = await c.report(mkEntry(t.id, p2.nodeId, p2.lease.fencing, { output: "real" }));
    expect(goodOutcome).toMatchObject({ accepted: true });
    expect(c.state(t.id)!.status).toBe("verified");

    // The zombie finally phones home with its old, superseded token.
    const zombieOutcome = await c.report(mkEntry(t.id, zombieNode, zombieFencing, { output: "forged" }));
    expect(zombieOutcome).toEqual({ accepted: false, reason: "stale-fencing" });
    expect(c.state(t.id)!.status).toBe("verified"); // never overwritten
  });

  it("(exactly-once) refuses an exact replay of an already-accepted entry, and a re-report after renewal, as duplicates", async () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, leaseTtlMs: 10_000 });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);

    // Renew before ever reporting — same fencing token, later expiry.
    const renewed = c.renew(t.id, p.nodeId, p.lease.fencing, 1);
    expect(renewed).not.toBeNull();

    const entry = mkEntry(t.id, p.nodeId, p.lease.fencing);
    const first = await c.report(entry);
    expect(first.accepted).toBe(true);
    expect(c.state(t.id)!.status).toBe("verified");

    const replay = await c.report(entry); // exact same entry object
    expect(replay).toEqual({ accepted: false, reason: "duplicate" });

    const replay2 = await c.report(mkEntry(t.id, p.nodeId, p.lease.fencing)); // fresh object, same content
    expect(replay2).toEqual({ accepted: false, reason: "duplicate" });

    expect(c.verifiedTaskIds()).toEqual([t.id]); // verified exactly once, never re-verified
  });
});

// ---------------------------------------------------------------------------
// handBack()
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.handBack()", () => {
  it("releases a lease early, returns the task to pending, and counts a reassignment", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);

    const ok = c.handBack(t.id, p.nodeId, p.lease.fencing, "worker-shutdown");
    expect(ok).toBe(true);
    expect(c.state(t.id)!.status).toBe("pending");
    expect(c.state(t.id)!.reassignments).toBe(1);
    expect(c.stats().reassignments).toBe(1);

    const replaced = c.plan(1);
    expect(replaced).toHaveLength(1);
  });

  it("fails closed (returns false, never throws) for a mismatched node/fencing or unknown task", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);

    expect(c.handBack("nonexistent", p.nodeId, p.lease.fencing, "x")).toBe(false);
    expect(c.handBack(t.id, p.nodeId, p.lease.fencing + 1, "x")).toBe(false);
    expect(() => c.handBack(t.id, p.nodeId, Number.NaN, "x")).not.toThrow();
    expect(c.handBack(t.id, p.nodeId, Number.NaN, "x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tick()
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.tick()", () => {
  it("sweeps an expired lease back to pending and increments attempts", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, leaseTtlMs: 1_000, maxAttempts: 5 });
    const t = mkTask();
    c.submit([t]);
    c.plan(0);
    expect(c.state(t.id)!.attempts).toBe(1);

    const reassigned: Array<[string, string, string]> = [];
    c.on("task:reassigned", (taskId, nodeId, reason) => reassigned.push([taskId, nodeId, reason]));

    const result = c.tick(1_000);
    expect(result.expired).toHaveLength(1);
    expect(result.reassigned).toEqual([t.id]);
    expect(result.failed).toEqual([]);
    expect(c.state(t.id)!.status).toBe("pending");
    expect(c.state(t.id)!.attempts).toBe(2);
    expect(reassigned).toEqual([[t.id, expect.any(String), "lease-expired"]]);
  });

  it("fails a task once attempts exceed maxAttempts, and never silently retries forever", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, leaseTtlMs: 100, maxAttempts: 2 });
    const t = mkTask();
    c.submit([t]);

    const failedEvents: Array<[string, string]> = [];
    c.on("task:failed", (taskId, reason) => failedEvents.push([taskId, reason]));

    c.plan(0); // attempts -> 1
    c.tick(100); // expires -> attempts=2 >= maxAttempts(2) -> failed
    expect(c.state(t.id)!.status).toBe("failed");
    expect(c.state(t.id)!.attempts).toBe(2);
    expect(failedEvents).toEqual([[t.id, "attempts-exhausted"]]);
    expect(c.stats().failed).toBe(1);
    expect(c.isComplete()).toBe(true);
  });

  it("fails a task immediately via plan() when maxAttempts is 0 (attempts-exhausted before ever leasing)", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, maxAttempts: 0 });
    const t = mkTask();
    c.submit([t]);
    expect(c.plan(0)).toEqual([]);
    expect(c.state(t.id)!.status).toBe("failed");
    expect(c.state(t.id)!.lastError).toBe("attempts-exhausted");
  });

  it("keeps a multi-replica task 'leased' on partial expiry, topping up only the freed slot", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b", "c", "d"], now: clock.now });
    const c = new ClusterCoordinator({
      membership,
      now: clock.now,
      leaseTtlMs: 1_000,
      consensus: { replicas: 3, quorum: 0.6 },
    });
    const t = mkTask();
    c.submit([t]);
    const placements = c.plan(0);
    expect(placements).toHaveLength(3);

    // Renew two of the three so only one expires at t=1000.
    c.renew(t.id, placements[0].nodeId, placements[0].lease.fencing, 500);
    c.renew(t.id, placements[1].nodeId, placements[1].lease.fencing, 500);

    const result = c.tick(1_000);
    expect(result.expired).toHaveLength(1);
    expect(result.expired[0].nodeId).toBe(placements[2].nodeId);
    expect(c.state(t.id)!.status).toBe("leased"); // still has 2 live replicas
    expect(c.state(t.id)!.leases).toHaveLength(2);
    expect(c.state(t.id)!.attempts).toBe(1); // NOT bumped — task as a whole wasn't fully lost

    const topUp = c.plan(1_000);
    expect(topUp).toHaveLength(1); // refills the freed 3rd slot
    expect(c.state(t.id)!.leases).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// onNodeDown()
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.onNodeDown()", () => {
  it("reclaims every lease held by the node in one pass and preserves prior attempt counts", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now, overrides: { b: { capacity: { maxWorkers: 8, providerKinds: ["process"] as IsolationKind[] } } } });
    const c = new ClusterCoordinator({ membership, now: clock.now, requireLeadership: false, maxInFlightPerNode: undefined });
    // Force everything onto "b" by making "a" incapable.
    const t1 = mkTask({ requiredCapabilities: ["special"] });
    const t2 = mkTask({ requiredCapabilities: ["special"] });
    // give b the capability (re-join with an updated descriptor)
    const bDescriptor = membership.get("b")!.descriptor;
    membership.join({ ...bDescriptor, capabilities: ["special"] });
    c.submit([t1, t2]);
    const placements = c.plan(0);
    expect(placements.every((p) => p.nodeId === "b")).toBe(true);
    expect(c.state(t1.id)!.attempts).toBe(1);

    const affected = c.onNodeDown("b", "dead");
    expect(affected.sort()).toEqual([t1.id, t2.id].sort());
    expect(c.state(t1.id)!.status).toBe("pending");
    expect(c.state(t1.id)!.attempts).toBe(1); // preserved, not incremented
    expect(c.state(t2.id)!.status).toBe("pending");
    expect(c.stats().byNode["b"].reclaimed).toBe(2);
  });

  it("is a no-op for a node holding no leases and never throws", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });
    expect(() => c.onNodeDown("nonexistent-node", "left")).not.toThrow();
    expect(c.onNodeDown("nonexistent-node", "left")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Randomized redistribution under churn
// ---------------------------------------------------------------------------

describe("ClusterCoordinator — redistribution under randomized churn", () => {
  it("converges to every task verified exactly once, with honestly-reported reassignment counts, despite repeated kill/revive cycles", async () => {
    const clock = new VirtualClock();
    const workerIds = ["n1", "n2", "n3", "n4", "n5"];
    const membership = buildCluster({
      selfId: "leader",
      otherIds: workerIds,
      now: clock.now,
      overrides: Object.fromEntries(
        ["leader", ...workerIds].map((id) => [id, { capacity: { maxWorkers: 3, providerKinds: ["process"] as IsolationKind[] } }]),
      ),
    });
    const c = new ClusterCoordinator({ membership, now: clock.now, leaseTtlMs: 50, maxAttempts: 50 });

    const taskIds = Array.from({ length: 20 }, (_, i) => `churn-${i}`);
    c.submit(taskIds.map((id) => mkTask({ id })));

    const rng = mulberry32(20260725);
    let alive = new Set(workerIds);
    let t = 0;

    for (let round = 0; round < 400 && !c.isComplete(); round++) {
      t += 10;
      clock.value = t;

      // Occasionally flip one worker's health, never taking more than 2 of 5 down
      // (keeps majority quorum for the leader so progress always stays possible).
      const roll = rng();
      const downCount = workerIds.filter((id) => !alive.has(id)).length;
      if (roll < 0.15 && downCount < 2) {
        const candidates = workerIds.filter((id) => alive.has(id));
        const victim = candidates[Math.floor(rng() * candidates.length)];
        killNode(membership, victim, t);
        alive.delete(victim);
        c.onNodeDown(victim, "dead");
      } else if (roll < 0.3 && downCount > 0) {
        const candidates = workerIds.filter((id) => !alive.has(id));
        const lucky = candidates[Math.floor(rng() * candidates.length)];
        reviveNode(membership, lucky, t);
        alive.add(lucky);
      }

      c.tick(t);
      const placements = c.plan(t);

      // Simulate workers: any currently-alive holder of a fresh lease reports
      // success most of the time (some rounds it just doesn't get to yet).
      for (const p of placements) {
        if (!alive.has(p.nodeId) && p.nodeId !== "leader") continue;
        if (rng() < 0.7) {
          await c.report(mkEntry(p.taskId, p.nodeId, p.lease.fencing, { output: `${p.taskId}-final` }));
        }
      }
      // Also let already-outstanding leases (from earlier rounds) get reported.
      for (const state of c.pending()) {
        for (const lease of state.leases) {
          if (!alive.has(lease.nodeId) && lease.nodeId !== "leader") continue;
          if (rng() < 0.5) {
            await c.report(mkEntry(state.task.id, lease.nodeId, lease.fencing, { output: `${state.task.id}-final` }));
          }
        }
      }
    }

    expect(c.isComplete()).toBe(true);
    expect(c.verifiedTaskIds().sort()).toEqual([...taskIds].sort());
    expect(c.stats().failed).toBe(0);
    expect(c.stats().verified).toBe(taskIds.length);

    // No task was ever lost or duplicated: exactly one verified record each.
    for (const id of taskIds) {
      expect(c.state(id)!.status).toBe("verified");
    }

    // Reassignment counts are honestly reported: the global stat equals the
    // sum of every individual task's own reassignment count.
    const summed = taskIds.reduce((sum, id) => sum + c.state(id)!.reassignments, 0);
    expect(c.stats().reassignments).toBe(summed);
  });
});

// ---------------------------------------------------------------------------
// Adversarial input
// ---------------------------------------------------------------------------

describe("ClusterCoordinator — adversarial input handling", () => {
  it("fails closed on every adversarial input without ever throwing", async () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now });

    expect(() => c.submit([])).not.toThrow();

    const t = mkTask();
    expect(() => c.submit([t, t])).not.toThrow(); // duplicate within one batch
    expect(c.stats().total).toBe(1);

    await expect(c.report(mkEntry("unknown", "a", 1))).resolves.toEqual({ accepted: false, reason: "unknown-task" });

    c.submit([t]); // idempotent, still 1
    expect(c.stats().total).toBe(1);
    const [p] = c.plan(0);

    await expect(c.report(mkEntry(t.id, "never-held-node", p.lease.fencing))).resolves.toEqual({
      accepted: false,
      reason: "stale-fencing",
    });
    await expect(c.report(mkEntry(t.id, p.nodeId, Number.NaN))).resolves.toEqual({
      accepted: false,
      reason: "stale-fencing",
    });
    await expect(c.report(mkEntry(t.id, p.nodeId, -1))).resolves.toEqual({ accepted: false, reason: "stale-fencing" });

    expect(c.renew(t.id, p.nodeId, Number.NaN, 1)).toBeNull();
    expect(c.handBack(t.id, p.nodeId, Number.NaN, "x")).toBe(false);
    expect(c.state("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stats()
// ---------------------------------------------------------------------------

describe("ClusterCoordinator.stats()", () => {
  it("attributes leased/verified/reclaimed counts to the correct nodes", async () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b"], now: clock.now });
    const c = new ClusterCoordinator({ membership, now: clock.now, leaseTtlMs: 1_000 });
    const t1 = mkTask();
    const t2 = mkTask();
    c.submit([t1, t2]);
    const [p1, p2] = c.plan(0);
    await c.report(mkEntry(p1.taskId, p1.nodeId, p1.lease.fencing));
    c.onNodeDown(p2.nodeId, "dead");

    const s = c.stats();
    expect(s.total).toBe(2);
    expect(s.verified).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.byNode[p1.nodeId].verified).toBeGreaterThanOrEqual(1);
    expect(s.byNode[p2.nodeId].reclaimed).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// costAwarePlacement / custom PlacementPolicy
// ---------------------------------------------------------------------------

describe("costAwarePlacement()", () => {
  it("prefers the lower-cost node and breaks ties on nodeId deterministically", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({
      selfId: "a",
      otherIds: ["cheap", "expensive"],
      now: clock.now,
      overrides: {
        a: { costPerWorkerHourUsd: 10.0 },
        cheap: { costPerWorkerHourUsd: 0.1 },
        expensive: { costPerWorkerHourUsd: 5.0 },
      },
    });
    const c = new ClusterCoordinator({ membership, now: clock.now, maxInFlightPerNode: 1 });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);
    expect(p.nodeId).toBe("cheap");
  });

  it("prefers a node matching the configured region affinity", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({
      selfId: "a",
      otherIds: ["us", "eu"],
      now: clock.now,
      overrides: { us: { region: "us-east" }, eu: { region: "eu-west" } },
    });
    const c = new ClusterCoordinator({
      membership,
      now: clock.now,
      maxInFlightPerNode: 1,
      placement: costAwarePlacement({ regionAffinity: "eu-west" }),
    });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);
    expect(p.nodeId).toBe("eu");
  });

  it("is deterministic: identical scores always rank by nodeId ascending", () => {
    const policy = costAwarePlacement();
    const nodeC = { descriptor: mkDescriptor("c"), health: "alive" as const, incarnation: 0, lastSeenAt: 0, load: 0, liveWorkers: 0 };
    const nodeA = { descriptor: mkDescriptor("a"), health: "alive" as const, incarnation: 0, lastSeenAt: 0, load: 0, liveWorkers: 0 };
    const nodeB = { descriptor: mkDescriptor("b"), health: "alive" as const, incarnation: 0, lastSeenAt: 0, load: 0, liveWorkers: 0 };
    const ranked = policy.rank([nodeC, nodeA, nodeB], mkTask(), { inFlightByNode: new Map(), now: 0 });
    expect(ranked.map((n) => n.descriptor.nodeId)).toEqual(["a", "b", "c"]);
  });
});

describe("ClusterCoordinator — custom PlacementPolicy", () => {
  it("delegates ranking entirely to a caller-supplied policy", () => {
    const clock = new VirtualClock();
    const membership = buildCluster({ selfId: "a", otherIds: ["b", "c"], now: clock.now });
    const reverseAlphabetical: PlacementPolicy = {
      rank(candidates) {
        return [...candidates].sort((x, y) => y.descriptor.nodeId.localeCompare(x.descriptor.nodeId));
      },
    };
    const c = new ClusterCoordinator({ membership, now: clock.now, maxInFlightPerNode: 1, placement: reverseAlphabetical });
    const t = mkTask();
    c.submit([t]);
    const [p] = c.plan(0);
    expect(p.nodeId).toBe("c"); // last alphabetically = first under the reversed policy
  });
});
