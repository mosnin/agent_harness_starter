import { afterEach, describe, expect, it } from "vitest";

import { createInlineSwarm } from "../../factory";
import type { SwarmManager } from "../../manager/manager";
import type { TaskExecutor, ExecutionOutput, WorkerContext } from "../../worker/executor";
import type { IsolationKind, WorkerTask } from "../../types";
import {
  certifiesOutput,
  sha256Hex,
  verifyCertificate,
} from "../../../hades/styx/certificate";
import { ClusterMembership, type GossipDigest, type NodeDescriptor } from "../membership";
import {
  LeaseLedger,
  VerifiedResultLedger,
  type FederatedResultEntry,
  type Lease,
} from "../lease-ledger";
import { ClusterNode, LeasedTaskPlanner, type LeasedTaskOutcome } from "../cluster-node";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** A configurable TaskExecutor so tests can pick exactly which real code path
 * through the verification gate they want to exercise — never a mock of the
 * gate/manager themselves, just a real, deterministic worker brain. */
class ControllableExecutor implements TaskExecutor {
  constructor(
    private readonly opts: {
      mode?: "grounded" | "ungrounded" | "throw";
      delayMs?: number;
    } = {}
  ) {}

  async execute(task: WorkerTask, _ctx: WorkerContext): Promise<ExecutionOutput> {
    if (this.opts.delayMs) await delay(this.opts.delayMs);
    if (this.opts.mode === "throw") {
      throw new Error("controllable-executor: simulated worker crash");
    }
    const objective = String((task.input as { objective?: unknown }).objective ?? task.description);
    if (this.opts.mode === "ungrounded") {
      return {
        output: `guess about ${objective}`,
        claims: [{ statement: `I think ${objective} is probably true`, evidence: [], confidence: 0.95 }],
        toolTrace: [],
      };
    }
    const trace = [
      { tool: "analyze", args: { objective }, ok: true, output: `analyzed:${objective}`, at: Date.now() },
    ];
    return {
      output: `done:${objective}`,
      claims: [
        {
          statement: `The objective "${objective}" was analyzed and confirmed.`,
          evidence: [`analyze output: analyzed:${objective}`],
          confidence: 0.9,
        },
      ],
      toolTrace: trace,
    };
  }
}

function mkDescriptor(nodeId: string, overrides: Partial<NodeDescriptor> = {}): NodeDescriptor {
  return {
    nodeId,
    managerUrl: `inline://${nodeId}`,
    capabilities: ["general"],
    capacity: { maxWorkers: 4, providerKinds: ["inline"] as IsolationKind[] },
    publicKeyHex: `pk-${nodeId}`,
    startedAt: 0,
    ...overrides,
  };
}

function mkLeasedTask(id: string, overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id,
    goalId: "unused-cluster-goal-placeholder",
    description: `Investigate ${id}`,
    requiredCapabilities: ["general"],
    input: { objective: `objective-${id}` },
    dependsOn: [],
    priority: 5,
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    createdAt: 0,
    ...overrides,
  };
}

function mkLease(taskId: string, nodeId: string, fencing = 1, overrides: Partial<Lease> = {}): Lease {
  return { taskId, nodeId, fencing, attempt: 1, grantedAt: 0, expiresAt: 60_000, ...overrides };
}

const createdManagers: SwarmManager[] = [];
const createdNodes: ClusterNode[] = [];

afterEach(async () => {
  await Promise.all(createdNodes.splice(0).map((n) => n.shutdown().catch(() => undefined)));
  await Promise.all(createdManagers.splice(0).map((m) => m.shutdown().catch(() => undefined)));
});

async function buildNode(
  opts: {
    nodeId?: string;
    executor?: TaskExecutor;
    maxAttempts?: number;
    poolSize?: number;
    maxConcurrentTasks?: number;
    leaseRenewMs?: number;
    taskTimeoutMs?: number;
    drainTimeoutMs?: number;
    membership?: ClusterMembership;
    now?: () => number;
    epsilon?: number;
  } = {}
): Promise<{ node: ClusterNode; manager: SwarmManager; descriptor: NodeDescriptor }> {
  const manager = await createInlineSwarm({
    capabilities: ["general"],
    poolSize: opts.poolSize ?? 2,
    executor: opts.executor ?? new ControllableExecutor({ mode: "grounded" }),
    maxAttempts: opts.maxAttempts ?? 2,
  });
  createdManagers.push(manager);

  const descriptor = mkDescriptor(opts.nodeId ?? uniqueId("node"));
  const node = new ClusterNode({
    descriptor,
    manager,
    membership: opts.membership,
    now: opts.now,
    maxConcurrentTasks: opts.maxConcurrentTasks,
    leaseRenewMs: opts.leaseRenewMs,
    taskTimeoutMs: opts.taskTimeoutMs,
    drainTimeoutMs: opts.drainTimeoutMs,
    ...(opts.epsilon !== undefined ? { epsilon: opts.epsilon } : {}),
  });
  createdNodes.push(node);

  await node.start();
  return { node, manager, descriptor };
}

// ---------------------------------------------------------------------------
// LeasedTaskPlanner
// ---------------------------------------------------------------------------

describe("LeasedTaskPlanner", () => {
  it("materializes exactly the leased task, ignoring the objective/capabilities it's called with", async () => {
    const task = mkLeasedTask("t1", {
      description: "a very specific leased task",
      requiredCapabilities: ["exec", "verify"],
      input: { objective: "x", foo: "bar" },
      priority: 9,
    });
    const planner = new LeasedTaskPlanner(task);
    const planned = await planner.plan("completely different objective", ["unrelated-cap"]);

    expect(planned).toHaveLength(1);
    expect(planned[0].description).toBe("a very specific leased task");
    expect(planned[0].requiredCapabilities).toEqual(["exec", "verify"]);
    expect(planned[0].input).toEqual({ objective: "x", foo: "bar" });
    expect(planned[0].priority).toBe(9);
    expect(planned[0].dependsOn).toEqual([]);
    expect(planned[0].consensus).toBeUndefined();
  });

  it("carries the leased task's consensus policy through when present", async () => {
    const task = mkLeasedTask("t2", { consensus: { replicas: 3, quorum: 0.6 } });
    const planned = await new LeasedTaskPlanner(task).plan("obj", []);
    expect(planned[0].consensus).toEqual({ replicas: 3, quorum: 0.6 });
  });
});

// ---------------------------------------------------------------------------
// Construction & basic accessors
// ---------------------------------------------------------------------------

describe("ClusterNode construction", () => {
  it("exposes nodeId and a membership view seeded from the descriptor", async () => {
    const { node, descriptor } = await buildNode({ nodeId: "ctor-node" });
    expect(node.nodeId).toBe("ctor-node");
    expect(node.membership().self().descriptor.nodeId).toBe(descriptor.nodeId);
    expect(node.membership().self().health).toBe("alive");
  });

  it("start() ensures the worker pool and reports live workers in the snapshot", async () => {
    const { node } = await buildNode({ poolSize: 2 });
    const snap = node.snapshot();
    expect(snap.liveWorkers).toBeGreaterThan(0);
    expect(snap.health).toBe("alive");
    expect(snap.inFlight).toEqual([]);
  });

  it("accepts an externally-constructed ClusterMembership and uses it", async () => {
    const descriptor = mkDescriptor("shared-membership-node");
    const membership = new ClusterMembership({ self: descriptor });
    const manager = await createInlineSwarm({ capabilities: ["general"], poolSize: 1 });
    createdManagers.push(manager);
    const node = new ClusterNode({ descriptor, manager, membership });
    createdNodes.push(node);
    expect(node.membership()).toBe(membership);
  });

  it("rejects an injected membership whose self id does not match the descriptor", async () => {
    const descriptor = mkDescriptor("mismatched-node");
    const otherMembership = new ClusterMembership({ self: mkDescriptor("a-totally-different-id") });
    const manager = await createInlineSwarm({ capabilities: ["general"], poolSize: 1 });
    createdManagers.push(manager);
    const node = new ClusterNode({ descriptor, manager, membership: otherMembership });
    createdNodes.push(node);
    await expect(node.start()).rejects.toThrow(/does not match/i);
  });

  it("validates its numeric options", async () => {
    const descriptor = mkDescriptor("bad-opts-node");
    const manager = await createInlineSwarm({ capabilities: ["general"], poolSize: 1 });
    createdManagers.push(manager);
    expect(() => new ClusterNode({ descriptor, manager, maxConcurrentTasks: 0 })).toThrow(RangeError);
    expect(() => new ClusterNode({ descriptor, manager, leaseRenewMs: 0 })).toThrow(RangeError);
    expect(() => new ClusterNode({ descriptor, manager, taskTimeoutMs: -1 })).toThrow(RangeError);
    expect(() => new ClusterNode({ descriptor, manager, drainTimeoutMs: 0 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// canAccept
// ---------------------------------------------------------------------------

describe("canAccept", () => {
  it("is true for a task whose capabilities this node has, while alive and under capacity", async () => {
    const { node } = await buildNode();
    expect(node.canAccept(mkLeasedTask("t", { requiredCapabilities: ["general"] }))).toBe(true);
  });

  it("is false when the task requires a capability this node doesn't advertise", async () => {
    const { node } = await buildNode();
    expect(node.canAccept(mkLeasedTask("t", { requiredCapabilities: ["gpu-inference"] }))).toBe(false);
  });

  it("is false once the node is at maxConcurrentTasks", async () => {
    const { node } = await buildNode({
      maxConcurrentTasks: 1,
      executor: new ControllableExecutor({ mode: "grounded", delayMs: 200 }),
    });
    const lease = mkLease("cap-task", node.nodeId);
    const p = node.execute(lease, mkLeasedTask("cap-task"));
    expect(node.snapshot().inFlight).toHaveLength(1);
    expect(node.canAccept(mkLeasedTask("other"))).toBe(false);
    await expect(node.execute(mkLease("other", node.nodeId), mkLeasedTask("other"))).rejects.toThrow(/cannot accept/i);
    await p;
  });

  it("is false while draining and after crash", async () => {
    const { node } = await buildNode();
    node.crash("boom");
    expect(node.canAccept(mkLeasedTask("t"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// execute — real accepted path
// ---------------------------------------------------------------------------

describe("execute: real accepted path (genuine end-to-end)", () => {
  it("drives a leased task through the real worker pool + real gate and accepts it", async () => {
    const { node } = await buildNode();
    const started: string[] = [];
    const completed: LeasedTaskOutcome[] = [];
    node.on("task:started", (taskId) => started.push(taskId));
    node.on("task:completed", (outcome) => completed.push(outcome));

    const lease = mkLease("real-task", node.nodeId);
    const task = mkLeasedTask("real-task");
    const outcome = await node.execute(lease, task);

    expect(started).toEqual(["real-task"]);
    expect(completed).toHaveLength(1);
    expect(outcome.report.verdict).toBe("accept");
    expect(outcome.taskId).toBe("real-task");
    expect(outcome.nodeId).toBe(node.nodeId);
    expect(outcome.fencing).toBe(1);
    // Relabeled to the cluster-wide lease id, not the manager's internal one.
    expect(outcome.result.taskId).toBe("real-task");
    expect(outcome.report.taskId).toBe("real-task");
    expect(outcome.result.output).toContain("objective-real-task");
    expect(node.snapshot().completed).toBe(1);
    expect(node.snapshot().inFlight).toEqual([]);
  });

  it("issues a real ed25519 certificate that verifies and binds the exact outputText", async () => {
    const { node } = await buildNode();
    const lease = mkLease("cert-task", node.nodeId);
    const outcome = await node.execute(lease, mkLeasedTask("cert-task"));

    expect(outcome.certificate).toBeDefined();
    const cert = outcome.certificate!;
    expect(await verifyCertificate(cert)).toBe(true);
    expect(await certifiesOutput(cert, outcome.outputText)).toBe(true);
    expect(cert.payload.outputSha256).toBe(sha256Hex(outcome.outputText));
    expect(cert.payload.taskId).toBe("cert-task");

    // A one-byte mutation of the bound text must invalidate the binding.
    const mutated = `${outcome.outputText}x`;
    expect(await certifiesOutput(cert, mutated)).toBe(false);

    // Tampering with the certificate itself (not just the text) must also fail.
    const tampered = { ...cert, payload: { ...cert.payload, ensembleScore: 0.999999 } };
    expect(await verifyCertificate(tampered)).toBe(false);
  });

  it("does NOT claim a conformal bound it never computed: epsilon defaults to 0, and pCorrect is the gate's own score verbatim", async () => {
    const { node } = await buildNode();
    const lease = mkLease("epsilon-task", node.nodeId);
    const outcome = await node.execute(lease, mkLeasedTask("epsilon-task"));
    const cert = outcome.certificate!;

    // `CertificatePayload.epsilon` means "the conformal bound the abstention
    // gate ENFORCED". The swarm's VerificationGate runs no conformal
    // calibration at all, so naming any nonzero bound here would be a
    // fabricated guarantee — and a consequential one, since downstream
    // consumers admit a certificate on `pCorrect >= 1 - epsilon`.
    expect(cert.payload.epsilon).toBe(0);
    // pCorrect is the ONE number that was actually computed (the gate score),
    // not a separately-invented "calibrated" figure.
    expect(cert.payload.pCorrect).toBe(outcome.report.score);
    expect(cert.payload.ensembleScore).toBe(outcome.report.score);
  });

  it("honors an explicitly-asserted epsilon from a caller that has its own calibration", async () => {
    const { node } = await buildNode({ epsilon: 0.05 });
    const lease = mkLease("epsilon-explicit", node.nodeId);
    const outcome = await node.execute(lease, mkLeasedTask("epsilon-explicit"));
    expect(outcome.certificate!.payload.epsilon).toBe(0.05);
  });

  it("round-trips a node-produced accepted outcome through a real VerifiedResultLedger", async () => {
    const { node } = await buildNode();
    const lease = mkLease("ledger-task", node.nodeId);
    const outcome = await node.execute(lease, mkLeasedTask("ledger-task"));
    expect(outcome.report.verdict).toBe("accept");

    const ledger = new VerifiedResultLedger({ requireCertificate: true });
    const entry: FederatedResultEntry = {
      taskId: outcome.taskId,
      nodeId: outcome.nodeId,
      fencing: outcome.fencing,
      result: outcome.result,
      report: outcome.report,
      certificate: outcome.certificate,
      outputText: outcome.outputText,
    };
    const res = await ledger.accept(entry);
    expect(res).toEqual({ accepted: true, first: true });
    expect(ledger.verifiedTaskIds()).toEqual(["ledger-task"]);
  });
});

// ---------------------------------------------------------------------------
// execute — non-accept paths (never fabricates an accept)
// ---------------------------------------------------------------------------

describe("execute: non-accept paths never fabricate an accept", () => {
  it("a worker that throws every attempt produces a real, non-accept report and no certificate", async () => {
    const { node } = await buildNode({ executor: new ControllableExecutor({ mode: "throw" }), maxAttempts: 1 });
    const outcome = await node.execute(mkLease("throwing-task", node.nodeId), mkLeasedTask("throwing-task"));
    expect(outcome.report.verdict).not.toBe("accept");
    expect(outcome.report.verdict).toBe("reject");
    expect(outcome.result.error).toMatch(/simulated worker crash/);
    expect(outcome.certificate).toBeUndefined();
  });

  it("ungrounded/hallucinated claims are rejected by the real gate after retries are exhausted", async () => {
    const { node } = await buildNode({ executor: new ControllableExecutor({ mode: "ungrounded" }), maxAttempts: 2 });
    const outcome = await node.execute(mkLease("bad-claims-task", node.nodeId), mkLeasedTask("bad-claims-task"));
    expect(outcome.report.verdict).not.toBe("accept");
    expect(outcome.certificate).toBeUndefined();
    expect(outcome.report.checks.length).toBeGreaterThan(0);
  });

  it("resolves with a synthetic non-accept outcome (not a hang) when execution exceeds taskTimeoutMs", async () => {
    const { node } = await buildNode({
      executor: new ControllableExecutor({ mode: "grounded", delayMs: 500 }),
      taskTimeoutMs: 40,
    });
    const startedAt = Date.now();
    const outcome = await node.execute(mkLease("slow-task", node.nodeId), mkLeasedTask("slow-task"));
    const elapsed = Date.now() - startedAt;

    expect(outcome.report.verdict).not.toBe("accept");
    expect(outcome.certificate).toBeUndefined();
    expect(outcome.result.error).toMatch(/taskTimeoutMs/);
    expect(elapsed).toBeLessThan(400); // resolved on our own timeout, not the worker's 500ms delay
  });

  it("resolves with a non-accept outcome rather than hanging when the manager shuts down mid-execution", async () => {
    const { node, manager } = await buildNode({
      executor: new ControllableExecutor({ mode: "grounded", delayMs: 500 }),
      taskTimeoutMs: 60,
    });
    const p = node.execute(mkLease("shutdown-task", node.nodeId), mkLeasedTask("shutdown-task"));
    await manager.shutdown();
    const outcome = await p;
    expect(outcome.report.verdict).not.toBe("accept");
    expect(outcome.certificate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// execute — guards & concurrency
// ---------------------------------------------------------------------------

describe("execute: guards and concurrency safety", () => {
  it("throws when the lease is granted to a different node", async () => {
    const { node } = await buildNode();
    await expect(node.execute(mkLease("t", "some-other-node"), mkLeasedTask("t"))).rejects.toThrow(/not this node/i);
  });

  it("throws on a duplicate in-flight lease (same taskId + fencing already executing)", async () => {
    const { node } = await buildNode({ executor: new ControllableExecutor({ mode: "grounded", delayMs: 100 }) });
    const lease = mkLease("dup-task", node.nodeId, 1);
    const p1 = node.execute(lease, mkLeasedTask("dup-task"));
    await expect(node.execute(lease, mkLeasedTask("dup-task"))).rejects.toThrow(/already executing/i);
    await p1;
  });

  it("two concurrent executes for the same taskId with different fencing tokens do not corrupt bookkeeping", async () => {
    const { node } = await buildNode({
      maxConcurrentTasks: 4,
      poolSize: 2,
      executor: new ControllableExecutor({ mode: "grounded", delayMs: 60 }),
    });
    const leaseA = mkLease("shared-task", node.nodeId, 1);
    const leaseB = mkLease("shared-task", node.nodeId, 2);

    const pA = node.execute(leaseA, mkLeasedTask("shared-task"));
    const pB = node.execute(leaseB, mkLeasedTask("shared-task"));

    const inFlight = node.snapshot().inFlight;
    expect(inFlight).toHaveLength(2);
    expect(inFlight.map((e) => e.fencing).sort()).toEqual([1, 2]);

    const [outcomeA, outcomeB] = await Promise.all([pA, pB]);
    expect(outcomeA.fencing).toBe(1);
    expect(outcomeB.fencing).toBe(2);
    expect(outcomeA.taskId).toBe("shared-task");
    expect(outcomeB.taskId).toBe("shared-task");
    expect(outcomeA.report.verdict).toBe("accept");
    expect(outcomeB.report.verdict).toBe("accept");
    expect(node.snapshot().completed).toBe(2);
    expect(node.snapshot().inFlight).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renewals & lease:renew-due
// ---------------------------------------------------------------------------

describe("renewals()", () => {
  it("reports the next renewal deadline for every in-flight lease", async () => {
    const { node } = await buildNode({
      leaseRenewMs: 1_000,
      executor: new ControllableExecutor({ mode: "grounded", delayMs: 200 }),
    });
    const lease = mkLease("renew-task", node.nodeId, 1);
    const p = node.execute(lease, mkLeasedTask("renew-task"));
    const due = node.renewals();
    expect(due).toHaveLength(1);
    expect(due[0].taskId).toBe("renew-task");
    expect(due[0].fencing).toBe(1);
    expect(due[0].dueAt).toBeGreaterThan(0);
    await p;
    expect(node.renewals()).toEqual([]);
  });

  it("emits lease:renew-due periodically for an in-flight task", async () => {
    const { node } = await buildNode({
      leaseRenewMs: 25,
      executor: new ControllableExecutor({ mode: "grounded", delayMs: 200 }),
    });
    const events: Array<{ taskId: string; fencing: number }> = [];
    node.on("lease:renew-due", (taskId, fencing) => events.push({ taskId, fencing }));

    const lease = mkLease("renew-events-task", node.nodeId, 1);
    const p = node.execute(lease, mkLeasedTask("renew-events-task"));
    await delay(90); // several 25ms ticks
    await p;

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((e) => e.taskId === "renew-events-task" && e.fencing === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// crash
// ---------------------------------------------------------------------------

describe("crash()", () => {
  it("abandons in-flight leases, rejects pending execute() calls, and never touches membership", async () => {
    const { node } = await buildNode({ executor: new ControllableExecutor({ mode: "grounded", delayMs: 500 }) });
    const crashedEvents: string[] = [];
    const abandonedEvents: string[] = [];
    node.on("node:crashed", (reason) => crashedEvents.push(reason));
    node.on("task:abandoned", (taskId) => abandonedEvents.push(taskId));

    const lease = mkLease("crash-task", node.nodeId, 1);
    const p = node.execute(lease, mkLeasedTask("crash-task"));
    expect(node.snapshot().inFlight).toHaveLength(1);

    const healthBefore = node.membership().self().health;
    node.crash("simulated hardware failure");

    await expect(p).rejects.toThrow(/abandoned/i);
    const snap = node.snapshot();
    expect(snap.health).toBe("crashed");
    expect(snap.abandoned).toBe(1);
    expect(snap.inFlight).toEqual([]);
    expect(crashedEvents).toEqual(["simulated hardware failure"]);
    expect(abandonedEvents).toEqual(["crash-task"]);
    // A hard crash never emits a graceful "left" — membership's own view of
    // this node's health is left exactly as it was before the crash.
    expect(node.membership().self().health).toBe(healthBefore);
  });

  it("is idempotent — a second crash() call is a no-op", async () => {
    const { node } = await buildNode();
    node.crash("first");
    const snapAfterFirst = node.snapshot();
    node.crash("second");
    const snapAfterSecond = node.snapshot();
    expect(snapAfterSecond.abandoned).toBe(snapAfterFirst.abandoned);
    expect(snapAfterSecond.health).toBe("crashed");
  });

  it("stops renewals and refuses new work after crash", async () => {
    const { node } = await buildNode();
    node.crash("boom");
    expect(node.renewals()).toEqual([]);
    expect(node.canAccept(mkLeasedTask("anything"))).toBe(false);
    await expect(node.execute(mkLease("t", node.nodeId), mkLeasedTask("t"))).rejects.toThrow(/cannot accept/i);
  });

  it("exercises the real leader reclaim path: an abandoned lease expires and can be re-granted at a higher fencing token", async () => {
    const clock = { value: 0 };
    const now = () => clock.value;
    const { node } = await buildNode({ now, executor: new ControllableExecutor({ mode: "grounded", delayMs: 5_000 }) });

    const ledger = new LeaseLedger();
    const lease = ledger.grant("reclaim-task", node.nodeId, 1, now(), 5_000);
    const p = node.execute(lease, mkLeasedTask("reclaim-task")).catch((e: Error) => e);

    node.crash("node went dark mid-task");
    const outcome = await p;
    expect(outcome).toBeInstanceOf(Error);
    expect(node.renewals()).toEqual([]); // no renewal will ever be signaled again

    // The leader never received a renewal, so the lease is free to expire...
    clock.value += 6_000;
    const expired = ledger.expire(now());
    expect(expired.map((l) => l.taskId)).toContain("reclaim-task");

    // ...and reclaim it for a different node with a strictly higher fencing token.
    const reclaimed = ledger.grant("reclaim-task", "node-b", 1, now(), 5_000);
    expect(reclaimed.fencing).toBeGreaterThan(lease.fencing);
    expect(reclaimed.nodeId).toBe("node-b");
  });
});

// ---------------------------------------------------------------------------
// drain / leave
// ---------------------------------------------------------------------------

describe("drain() and leave()", () => {
  it("drain refuses new work immediately", async () => {
    const { node } = await buildNode();
    void node.drain("planned maintenance");
    expect(node.canAccept(mkLeasedTask("t"))).toBe(false);
  });

  it("drain waits for a fast in-flight task to finish, reports it completed, and transitions to left", async () => {
    const { node } = await buildNode({ drainTimeoutMs: 2_000 });
    const lease = mkLease("fast-drain-task", node.nodeId, 1);
    const p = node.execute(lease, mkLeasedTask("fast-drain-task"));

    const result = await node.drain("graceful shutdown");
    expect(result.completed).toEqual(["fast-drain-task"]);
    expect(result.handedBack).toEqual([]);
    expect(node.snapshot().health).toBe("left");

    const outcome = await p;
    expect(outcome.report.verdict).toBe("accept");

    const digest = node.gossip();
    const self = digest.entries.find((e) => e.nodeId === node.nodeId);
    expect(self?.health).toBe("left");
  });

  it("drain hands back a straggler that exceeds drainTimeoutMs, losslessly", async () => {
    const { node } = await buildNode({
      drainTimeoutMs: 30,
      executor: new ControllableExecutor({ mode: "grounded", delayMs: 400 }),
    });
    const lease = mkLease("straggler-task", node.nodeId, 1);
    const p = node.execute(lease, mkLeasedTask("straggler-task")).catch((e: Error) => e);

    const result = await node.drain("must go now");
    expect(result.handedBack).toEqual(["straggler-task"]);
    expect(result.completed).toEqual([]);

    const outcome = await p;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/handed back/i);
    expect(node.snapshot().health).toBe("left");
  });

  it("leave() hands back in-flight work immediately, without waiting", async () => {
    const { node } = await buildNode({ executor: new ControllableExecutor({ mode: "grounded", delayMs: 5_000 }) });
    const lease = mkLease("leave-now-task", node.nodeId, 1);
    const p = node.execute(lease, mkLeasedTask("leave-now-task")).catch((e: Error) => e);

    const startedAt = Date.now();
    const digest: GossipDigest = await node.leave("forced immediate leave");
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(200); // did not wait for the 5s task
    const self = digest.entries.find((e) => e.nodeId === node.nodeId);
    expect(self?.health).toBe("left");

    const outcome = await p;
    expect(outcome).toBeInstanceOf(Error);
    expect(node.snapshot().handedBack).toBe(1);
  });

  it("drain() and leave() both refuse to run on an already-crashed node", async () => {
    const { node } = await buildNode();
    node.crash("dead");
    await expect(node.drain("too late")).rejects.toThrow(/crashed/i);
    await expect(node.leave("too late")).rejects.toThrow(/crashed/i);
  });
});

// ---------------------------------------------------------------------------
// membership integration: join / gossip / ingest / rejoin
// ---------------------------------------------------------------------------

describe("membership integration", () => {
  it("two nodes joining and exchanging gossip converge on seeing each other alive", async () => {
    const a = await buildNode({ nodeId: "conv-node-a" });
    const b = await buildNode({ nodeId: "conv-node-b" });

    a.node.join(b.descriptor);
    b.node.join(a.descriptor);
    const digestA = a.node.gossip();
    const digestB = b.node.gossip();
    a.node.ingest(digestB);
    b.node.ingest(digestA);

    expect(a.node.membership().get("conv-node-b")?.health).toBe("alive");
    expect(b.node.membership().get("conv-node-a")?.health).toBe("alive");
  });

  it("a node that left and rejoins bumps its incarnation and resists resurrection by stale gossip", async () => {
    const a = await buildNode({ nodeId: "rejoin-node-a" });
    const observer = await buildNode({ nodeId: "rejoin-observer" });

    observer.node.join(a.descriptor);
    expect(observer.node.membership().get("rejoin-node-a")?.health).toBe("alive");

    const leaveDigest = await a.node.leave("graceful maintenance window");
    observer.node.ingest(leaveDigest);
    const afterLeave = observer.node.membership().get("rejoin-node-a")!;
    expect(afterLeave.health).toBe("left");
    const leftIncarnation = afterLeave.incarnation;

    // node-a comes back — the observer re-joins it directly (an out-of-band
    // rejoin handshake), which is what bumps the incarnation past `left`.
    observer.node.join(a.descriptor);
    const afterRejoin = observer.node.membership().get("rejoin-node-a")!;
    expect(afterRejoin.health).toBe("alive");
    expect(afterRejoin.incarnation).toBeGreaterThan(leftIncarnation);

    // A stale digest — built from the *old* leave — must not resurrect the
    // downgrade now that the observer has a strictly newer fact.
    const staleObserver = new ClusterMembership({ self: mkDescriptor("stale-relay") });
    staleObserver.apply(leaveDigest);
    const staleDigest = staleObserver.digest();
    observer.node.ingest(staleDigest);

    const afterStale = observer.node.membership().get("rejoin-node-a")!;
    expect(afterStale.health).toBe("alive");
    expect(afterStale.incarnation).toBe(afterRejoin.incarnation);
  });
});

// ---------------------------------------------------------------------------
// shutdown & resource hygiene
// ---------------------------------------------------------------------------

describe("shutdown() and resource hygiene", () => {
  it("abandons stragglers and is idempotent across repeated calls", async () => {
    const { node } = await buildNode({ executor: new ControllableExecutor({ mode: "grounded", delayMs: 500 }) });
    const lease = mkLease("shutdown-node-task", node.nodeId, 1);
    const p = node.execute(lease, mkLeasedTask("shutdown-node-task")).catch((e: Error) => e);

    await node.shutdown();
    const outcome = await p;
    expect(outcome).toBeInstanceOf(Error);
    expect(node.snapshot().abandoned).toBe(1);

    // Repeated shutdown must not throw or double-count.
    await node.shutdown();
    expect(node.snapshot().abandoned).toBe(1);
  });

  it("leaves no leaked manager listeners once every execute() call has settled", async () => {
    const { node, manager } = await buildNode({ poolSize: 2 });
    const before = {
      verified: manager.listenerCount("task:verified"),
      rejected: manager.listenerCount("task:rejected"),
      failed: manager.listenerCount("task:failed"),
      aborted: manager.listenerCount("goal:aborted"),
    };

    await node.execute(mkLease("leak-check-1", node.nodeId, 1), mkLeasedTask("leak-check-1"));
    await node.execute(mkLease("leak-check-2", node.nodeId, 1), mkLeasedTask("leak-check-2"));

    expect(manager.listenerCount("task:verified")).toBe(before.verified);
    expect(manager.listenerCount("task:rejected")).toBe(before.rejected);
    expect(manager.listenerCount("task:failed")).toBe(before.failed);
    expect(manager.listenerCount("goal:aborted")).toBe(before.aborted);
  });

  it("clears its renewal timer on shutdown (no further lease:renew-due after shutdown)", async () => {
    const { node } = await buildNode({
      leaseRenewMs: 20,
      executor: new ControllableExecutor({ mode: "grounded", delayMs: 300 }),
    });
    let count = 0;
    node.on("lease:renew-due", () => count++);
    const p = node.execute(mkLease("timer-task", node.nodeId), mkLeasedTask("timer-task")).catch((e: Error) => e);
    await delay(45);
    await node.shutdown();
    const countAtShutdown = count;
    await delay(60);
    expect(count).toBe(countAtShutdown);
    await p;
  });
});
