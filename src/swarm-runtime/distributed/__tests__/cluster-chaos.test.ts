import { afterEach, describe, expect, it } from "vitest";

import {
  buildClusterFabric,
  chaosPlan,
  runClusterChaos,
  type ChaosPlan,
  type ChaosRunReport,
  type ClusterFabric,
} from "../cluster-chaos";
import { electLeader, type ClusterMembership } from "../membership";
import type { WorkerTask } from "../../types";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
} from "../../../hades/styx/certificate";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function mkTasks(count: number, capabilities: string[] = ["general"]): WorkerTask[] {
  const createdAt = Date.now();
  return Array.from({ length: count }, () => {
    idCounter += 1;
    return {
      id: `t-${idCounter}`,
      goalId: "test-goal",
      description: `synthetic task ${idCounter}`,
      requiredCapabilities: capabilities,
      input: { objective: `objective ${idCounter}` },
      dependsOn: [],
      priority: 1,
      status: "pending" as const,
      attempts: 0,
      maxAttempts: 3,
      createdAt,
    };
  });
}

const openFabrics: ClusterFabric[] = [];
async function track(fabric: ClusterFabric): Promise<ClusterFabric> {
  openFabrics.push(fabric);
  return fabric;
}

afterEach(async () => {
  await Promise.all(openFabrics.splice(0).map((f) => f.shutdown().catch(() => undefined)));
});

// ---------------------------------------------------------------------------
// Basic fabric behavior
// ---------------------------------------------------------------------------

describe("buildClusterFabric — basic composition", () => {
  it("rejects a non-positive node count", async () => {
    await expect(buildClusterFabric({ nodes: 0 })).rejects.toThrow(RangeError);
    await expect(buildClusterFabric({ nodes: -1 })).rejects.toThrow(RangeError);
  });

  it("reports PER-RUN counters when one fabric is run twice — never the coordinator's cumulative totals", async () => {
    // The coordinator's own stats() are cumulative over its lifetime. A report
    // that read them directly would, on a second run of the same fabric, claim
    // more verified tasks than it submitted — a number that looks measured but
    // is an accounting artifact.
    const fabric = await track(await buildClusterFabric({ nodes: 2, workersPerNode: 2, leaseTtlMs: 2000 }));

    const first = await fabric.run(mkTasks(2), { timeoutMs: 6000 });
    expect(first.tasksSubmitted).toBe(2);
    expect(first.tasksVerified).toBe(2);

    const second = await fabric.run(mkTasks(3), { timeoutMs: 6000 });
    expect(second.tasksSubmitted).toBe(3);
    // Would be 5 if the report leaked the cumulative counter.
    expect(second.tasksVerified).toBe(3);
    expect(second.tasksFailed).toBe(0);
    // Rates derive from this run's own tally, so they stay sane too.
    expect(second.verifiedPerSec).toBeLessThanOrEqual(3 / (Math.max(1, second.makespanMs) / 1000));
    // Delta-based, so a clean second run cannot inherit the first's churn.
    expect(second.reassignments).toBeGreaterThanOrEqual(0);
    expect(second.conflicts).toBe(0);
  }, 30_000);

  it("runs a small fault-free multi-node workload and verifies every task exactly once", async () => {
    const fabric = await track(await buildClusterFabric({ nodes: 2, workersPerNode: 2, leaseTtlMs: 2000 }));
    const tasks = mkTasks(4);
    const report = await fabric.run(tasks, { timeoutMs: 6000 });

    expect(report.mode).toBe("measured");
    expect(report.nodes).toBe(2);
    expect(report.tasksSubmitted).toBe(4);
    expect(report.tasksVerified).toBe(4);
    expect(report.tasksFailed).toBe(0);
    expect(report.duplicateVerifications).toBe(0);
    expect(report.conflicts).toBe(0);
    expect(report.certificatesInvalid).toBe(0);
    expect(report.certificatesValid).toBeGreaterThan(0);
    expect(report.faultsInjected).toEqual([]);
    expect(report.makespanMs).toBeGreaterThan(0);
    expect(report.verifiedPerSec).toBeGreaterThan(0);
    expect(fabric.nodes).toHaveLength(2);
    expect(fabric.routers).toHaveLength(2);
    expect(fabric.coordinator.verifiedTaskIds()).toHaveLength(4);
  }, 12_000);

  it("runClusterChaos rejects a non-positive task count", async () => {
    await expect(runClusterChaos({ nodes: 1, tasks: 0 })).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// chaosPlan — pure & deterministic
// ---------------------------------------------------------------------------

describe("chaosPlan", () => {
  it("is a pure, deterministic function of its inputs", () => {
    const a = chaosPlan({ seed: 123, durationMs: 1000, nodes: ["node-0", "node-1", "node-2"], density: 0.6 });
    const b = chaosPlan({ seed: 123, durationMs: 1000, nodes: ["node-0", "node-1", "node-2"], density: 0.6 });
    expect(b).toEqual(a);
    expect(a.seed).toBe(123);
    expect(a.faults.length).toBeGreaterThan(0);
    // sorted by time
    for (let i = 1; i < a.faults.length; i++) {
      expect(a.faults[i].at).toBeGreaterThanOrEqual(a.faults[i - 1].at);
    }
  });

  it("produces a different schedule for a different seed", () => {
    const a = chaosPlan({ seed: 1, durationMs: 1000, nodes: ["node-0", "node-1"], density: 0.6 });
    const b = chaosPlan({ seed: 2, durationMs: 1000, nodes: ["node-0", "node-1"], density: 0.6 });
    expect(b).not.toEqual(a);
  });

  it("rejects malformed inputs", () => {
    expect(() => chaosPlan({ seed: 1, durationMs: 0, nodes: ["a"] })).toThrow(RangeError);
    expect(() => chaosPlan({ seed: 1, durationMs: 100, nodes: [] })).toThrow(RangeError);
    expect(() => chaosPlan({ seed: Number.NaN, durationMs: 100, nodes: ["a"] })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// THE CHECKPOINT
// ---------------------------------------------------------------------------

describe("THE CHECKPOINT — worker kill + node crash + link partition mid-run", () => {
  it("still verifies every task exactly once, with zero duplicates, zero failures, zero invalid certificates, and real reassignments", async () => {
    const fabric = await track(
      await buildClusterFabric({ nodes: 4, workersPerNode: 2, leaseTtlMs: 2500, taskTimeoutMs: 5000 }),
    );
    const tasks = mkTasks(8);

    const plan: ChaosPlan = {
      seed: 1,
      faults: [
        { at: 40, kind: "kill-worker", target: "node-0" },
        { at: 90, kind: "partition-link", target: "node-2", peer: "node-3" },
        { at: 120, kind: "crash-node", target: "node-1" },
        { at: 260, kind: "heal-link", target: "node-2", peer: "node-3" },
      ],
    };

    const report: ChaosRunReport = await fabric.run(tasks, { timeoutMs: 9000, plan });

    // The faults must have actually fired — a run where nothing bit would
    // vacuously pass every assertion below, which is exactly what this test
    // must not allow.
    expect(report.faultsInjected).toHaveLength(plan.faults.length);
    expect(report.faultsInjected.map((f) => f.kind).sort()).toEqual(
      ["crash-node", "heal-link", "kill-worker", "partition-link"].sort(),
    );

    expect(report.mode).toBe("measured");
    expect(report.tasksSubmitted).toBe(8);
    expect(report.tasksVerified).toBe(8);
    expect(report.tasksFailed).toBe(0);
    expect(report.duplicateVerifications).toBe(0);
    expect(report.certificatesInvalid).toBe(0);
    expect(report.conflicts).toBe(0);
    expect(report.reassignments).toBeGreaterThan(0);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("the same seed reproduces the same fault schedule and the same verified outcome across two independent runs", async () => {
    const nodeIds = ["node-0", "node-1", "node-2"];
    const planParams = { seed: 99, durationMs: 700, nodes: nodeIds, density: 0.6 } as const;
    expect(chaosPlan(planParams)).toEqual(chaosPlan(planParams));

    async function runOnce(): Promise<ChaosRunReport> {
      const fabric = await buildClusterFabric({ nodes: 3, workersPerNode: 2, leaseTtlMs: 2500, taskTimeoutMs: 5000 });
      try {
        const tasks = mkTasks(5);
        return await fabric.run(tasks, { timeoutMs: 8000, plan: chaosPlan(planParams) });
      } finally {
        await fabric.shutdown();
      }
    }

    const r1 = await runOnce();
    const r2 = await runOnce();

    expect(r1.faultsInjected).toEqual(r2.faultsInjected);
    expect(r1.tasksVerified).toBe(r1.tasksSubmitted);
    expect(r2.tasksVerified).toBe(r2.tasksSubmitted);
    expect(r1.tasksVerified).toBe(r2.tasksVerified);
    expect(r1.tasksFailed).toBe(r2.tasksFailed);
    expect(r1.duplicateVerifications).toBe(0);
    expect(r2.duplicateVerifications).toBe(0);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Severity coverage
// ---------------------------------------------------------------------------

describe("severity coverage", () => {
  it("a node crashing while holding the ONLY replica of a consensus task still gets it verified", async () => {
    const fabric = await track(
      await buildClusterFabric({
        nodes: 3,
        workersPerNode: 2,
        consensus: { replicas: 1, quorum: 1 },
        leaseTtlMs: 2500,
        taskTimeoutMs: 5000,
      }),
    );
    const tasks = mkTasks(1);
    const plan: ChaosPlan = { seed: 11, faults: [{ at: 20, kind: "crash-node", target: "node-0" }] };

    const report = await fabric.run(tasks, { timeoutMs: 7000, plan });

    expect(report.tasksVerified).toBe(1);
    expect(report.tasksFailed).toBe(0);
    expect(report.duplicateVerifications).toBe(0);
    expect(report.reassignments).toBeGreaterThan(0);
  }, 10_000);

  it("two nodes crashing simultaneously still lets every task get verified", async () => {
    const fabric = await track(
      await buildClusterFabric({ nodes: 5, workersPerNode: 2, leaseTtlMs: 3000, taskTimeoutMs: 6000 }),
    );
    const tasks = mkTasks(6);
    const plan: ChaosPlan = {
      seed: 12,
      faults: [
        { at: 40, kind: "crash-node", target: "node-0" },
        { at: 40, kind: "crash-node", target: "node-1" },
      ],
    };

    const report = await fabric.run(tasks, { timeoutMs: 15_000, plan });

    expect(report.tasksVerified).toBe(6);
    expect(report.tasksFailed).toBe(0);
    expect(report.duplicateVerifications).toBe(0);
    expect(report.reassignments).toBeGreaterThan(0);
  }, 20_000);

  it("a result computed but not yet delivered before its node 'dies' is neither lost nor double-counted", async () => {
    const fabric = await track(await buildClusterFabric({ nodes: 2, workersPerNode: 2, leaseTtlMs: 5000 }));
    const [task] = mkTasks(1);
    fabric.coordinator.submit([task]);

    const placements1 = fabric.coordinator.plan();
    expect(placements1).toHaveLength(1);
    const p1 = placements1[0];
    const node1 = fabric.nodes.find((n) => n.nodeId === p1.nodeId);
    expect(node1).toBeDefined();

    // The node genuinely finishes the work (real gate, real certificate)...
    const outcome1 = await (node1 as NonNullable<typeof node1>).execute(p1.lease, task);
    expect(outcome1.report.verdict).toBe("accept");

    // ...but never gets to ship it back (message lost / node presumed dead
    // before reporting) — the coordinator reclaims the still-outstanding
    // lease exactly as a real leader eventually would.
    const handedBack = fabric.coordinator.handBack(p1.taskId, p1.nodeId, p1.lease.fencing, "presumed dead before reporting");
    expect(handedBack).toBe(true);

    // Not lost: reassigned and completed for real.
    const placements2 = fabric.coordinator.plan();
    expect(placements2).toHaveLength(1);
    const p2 = placements2[0];
    const node2 = fabric.nodes.find((n) => n.nodeId === p2.nodeId);
    expect(node2).toBeDefined();
    const outcome2 = await (node2 as NonNullable<typeof node2>).execute(p2.lease, task);
    expect(outcome2.report.verdict).toBe("accept");

    const accept2 = await fabric.coordinator.report({
      taskId: outcome2.taskId,
      nodeId: outcome2.nodeId,
      fencing: outcome2.fencing,
      result: outcome2.result,
      report: outcome2.report,
      certificate: outcome2.certificate,
      outputText: outcome2.outputText,
    });
    expect(accept2.accepted).toBe(true);
    expect(fabric.coordinator.verifiedTaskIds()).toEqual([task.id]);
    expect(fabric.coordinator.stats().verified).toBe(1);

    // Not double-counted: the stale first result finally "arrives" late and
    // must be rejected.
    const lateAccept = await fabric.coordinator.report({
      taskId: outcome1.taskId,
      nodeId: outcome1.nodeId,
      fencing: outcome1.fencing,
      result: outcome1.result,
      report: outcome1.report,
      certificate: outcome1.certificate,
      outputText: outcome1.outputText,
    });
    expect(lateAccept.accepted).toBe(false);
    expect(fabric.coordinator.stats().verified).toBe(1);
  }, 10_000);

  it("a leader node (per real SWIM election) crashing mid-run still lets a new leader emerge and work continue", async () => {
    const fabric = await track(
      await buildClusterFabric({ nodes: 3, workersPerNode: 2, leaseTtlMs: 2500, taskTimeoutMs: 5000 }),
    );

    const computeLeader = (m: ClusterMembership) =>
      electLeader(
        m.nodes().filter((n) => n.descriptor.nodeId !== "controller"),
        { quorum: "majority", epoch: 0, knownSize: 3 },
      );

    const before = computeLeader(fabric.nodes[1].membership());
    expect(before.leaderId).toBe("node-0"); // lexicographically smallest, all alive at bootstrap

    const tasks = mkTasks(5);
    const plan: ChaosPlan = { seed: 13, faults: [{ at: 30, kind: "crash-node", target: "node-0" }] };
    const report = await fabric.run(tasks, { timeoutMs: 9000, plan });

    expect(report.tasksVerified).toBe(5);
    expect(report.tasksFailed).toBe(0);
    expect(report.duplicateVerifications).toBe(0);

    // A surviving node's own real ClusterMembership has, by now, genuinely
    // converged (real gossip + real SWIM tick()) on node-0 no longer being
    // alive — suspect or dead both correctly exclude it from `electLeader`'s
    // voter set, which is what re-election below actually depends on.
    const survivorView = fabric.nodes[1].membership().get("node-0");
    expect(survivorView?.health).not.toBe("alive");

    const after = computeLeader(fabric.nodes[1].membership());
    expect(after.leaderId).toBe("node-1");
    expect(after.leaderId).not.toBe(before.leaderId);
  }, 12_000);

  it("a total partition that removes quorum stalls placement safely and finishes once healed, without double-dispatch", async () => {
    const fabric = await track(
      await buildClusterFabric({ nodes: 3, workersPerNode: 1, leaseTtlMs: 400, taskTimeoutMs: 4000 }),
    );
    const tasks = mkTasks(6);

    // Cuts the controller off from a majority of the known cluster (2 of 3
    // compute nodes) — real quorum loss, not a fabricated flag.
    const plan: ChaosPlan = {
      seed: 14,
      faults: [
        { at: 0, kind: "partition-link", target: "controller", peer: "node-1" },
        { at: 0, kind: "partition-link", target: "controller", peer: "node-2" },
        { at: 900, kind: "heal-link", target: "controller", peer: "node-1" },
        { at: 900, kind: "heal-link", target: "controller", peer: "node-2" },
      ],
    };

    const report = await fabric.run(tasks, { timeoutMs: 12_000, plan });

    expect(report.faultsInjected).toHaveLength(4);
    expect(report.tasksVerified).toBe(6);
    expect(report.tasksFailed).toBe(0);
    expect(report.duplicateVerifications).toBe(0);
    expect(report.conflicts).toBe(0);
  }, 18_000);
});

// ---------------------------------------------------------------------------
// Certificate verification is real
// ---------------------------------------------------------------------------

describe("certificate verification", () => {
  it("coordinator.report() rejects a certificate that does not certify the reported output", async () => {
    const fabric = await track(await buildClusterFabric({ nodes: 1, workersPerNode: 1 }));
    const [task] = mkTasks(1);
    fabric.coordinator.submit([task]);
    const placements = fabric.coordinator.plan();
    expect(placements).toHaveLength(1);
    const p = placements[0];

    const outcome = await fabric.nodes[0].execute(p.lease, task);
    expect(outcome.report.verdict).toBe("accept");

    const ca = new CertificateAuthority(generatePrivateKeyHex());
    const wrongOutputText = JSON.stringify({ not: "the real output" });
    const payload: CertificatePayload = {
      outputSha256: sha256Hex(wrongOutputText),
      taskId: task.id,
      verifierTier: "T1-swarm-verification-gate",
      ensembleScore: 0.95,
      pCorrect: 0.95,
      epsilon: 0.1,
      traceSha256: sha256Hex("[]"),
      verifierVersions: ["test@1"],
      issuedAt: Date.now(),
    };
    const badCert = await ca.issue(payload);

    const rejected = await fabric.coordinator.report({
      taskId: outcome.taskId,
      nodeId: outcome.nodeId,
      fencing: outcome.fencing,
      result: outcome.result,
      report: outcome.report,
      certificate: badCert,
      outputText: outcome.outputText,
    });

    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted) expect(rejected.reason).toBe("cert-invalid");
    expect(fabric.coordinator.stats().verified).toBe(0);
  }, 8_000);
});

// ---------------------------------------------------------------------------
// Resource hygiene
// ---------------------------------------------------------------------------

describe("resource hygiene", () => {
  it("shutdown() tears down every inline swarm, router, and link, and is idempotent", async () => {
    const fabric = await buildClusterFabric({ nodes: 2, workersPerNode: 1, leaseTtlMs: 2000 });
    const report = await fabric.run(mkTasks(2), { timeoutMs: 5000 });
    expect(report.tasksVerified).toBe(2);

    await fabric.shutdown();
    await expect(fabric.shutdown()).resolves.toBeUndefined();

    for (const router of fabric.routers) {
      expect(router.stats().peers).toBe(0);
    }
  }, 10_000);
});
