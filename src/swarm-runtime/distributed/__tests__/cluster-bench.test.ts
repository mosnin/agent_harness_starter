import { describe, expect, it } from "vitest";

import { runClusterBench, formatClusterBench, type ClusterBenchReport } from "../cluster-bench";

describe("runClusterBench", () => {
  it("runs single-node, multi-node, and multi-node-chaos arms and returns a fully measured report", async () => {
    const report = await runClusterBench({ tasks: 5, nodes: 3, workersPerNode: 2, seed: 7, timeoutMs: 15_000 });

    expect(report.mode).toBe("measured");
    expect(report.tasks).toBe(5);
    expect(report.workersPerNode).toBe(2);
    expect(report.seed).toBe(7);
    expect(report.runAt).toBeGreaterThan(0);

    expect(report.arms).toHaveLength(3);
    const [single, multi, chaos] = report.arms;

    expect(single.label).toBe("single-node");
    expect(single.nodes).toBe(1);
    expect(single.faults).toBe(false);

    expect(multi.label).toBe("multi-node");
    expect(multi.nodes).toBeGreaterThanOrEqual(2);
    expect(multi.faults).toBe(false);

    expect(chaos.label).toBe("multi-node-chaos");
    expect(chaos.nodes).toBeGreaterThanOrEqual(2);
    expect(chaos.faults).toBe(true);

    // Every arm actually completed the full identical workload.
    for (const arm of report.arms) {
      expect(arm.tasksVerified).toBe(5);
      expect(arm.tasksFailed).toBe(0);
      expect(arm.makespanMs).toBeGreaterThan(0);
      expect(arm.verifiedPerSec).toBeGreaterThan(0);
      expect(Number.isFinite(arm.verifiedPerSec)).toBe(true);
      expect(arm.reassignments).toBeGreaterThanOrEqual(0);
    }

    expect(Number.isFinite(report.speedupVsSingleNode)).toBe(true);
    expect(Number.isFinite(report.verifiedThroughputRatio)).toBe(true);
    expect(report.speedupVsSingleNode).toBeGreaterThan(0);
    expect(report.verifiedThroughputRatio).toBeGreaterThan(0);
    expect(report.faultToleranceHeld).toBe(true);

    expect(report.notes.length).toBeGreaterThan(0);
    for (const note of report.notes) {
      expect(typeof note).toBe("string");
      expect(note.length).toBeGreaterThan(0);
    }
    // Honesty: the notes must describe this as an in-process simulation, and
    // must never claim a cross-machine measurement.
    expect(report.notes.some((n) => /in-process/i.test(n))).toBe(true);
    expect(report.notes.some((n) => /cross-machine/i.test(n))).toBe(true);
  }, 25_000);

  it("derives its ratios from the measured arms, not a hardcoded number", async () => {
    const report = await runClusterBench({ tasks: 4, nodes: 2, workersPerNode: 2, seed: 5, timeoutMs: 15_000 });
    const [single, multi] = report.arms;

    const expectedSpeedup = single.makespanMs / multi.makespanMs;
    const expectedThroughputRatio = multi.verifiedPerSec / single.verifiedPerSec;

    expect(report.speedupVsSingleNode).toBeCloseTo(expectedSpeedup, 6);
    expect(report.verifiedThroughputRatio).toBeCloseTo(expectedThroughputRatio, 6);
  }, 20_000);

  it("the chaos arm genuinely injected faults and still verified every task with zero failures", async () => {
    const report = await runClusterBench({ tasks: 5, nodes: 3, workersPerNode: 2, seed: 9, timeoutMs: 15_000 });
    const chaos = report.arms[2];

    expect(chaos.faults).toBe(true);
    expect(chaos.tasksVerified).toBe(5);
    expect(chaos.tasksFailed).toBe(0);
    expect(report.faultToleranceHeld).toBe(true);
    expect(report.notes.some((n) => /fault/i.test(n) && /seed=9/.test(n))).toBe(true);
  }, 20_000);

  it("throws rather than emitting a report when an arm cannot complete within its timeout budget", async () => {
    // Far more tasks than 1 worker on 1 node can finish inside the (clamped)
    // minimum timeout budget — a genuine, real incompletion, not a mock.
    await expect(
      runClusterBench({ tasks: 200, nodes: 2, workersPerNode: 1, seed: 1, timeoutMs: 1000 }),
    ).rejects.toThrow(/only verified .* — refusing to emit a bench report/);
  }, 20_000);

  it("clamps degenerate inputs to sane minimums rather than throwing", async () => {
    const report = await runClusterBench({ tasks: 0, nodes: 0, workersPerNode: 0, timeoutMs: 15_000 });
    expect(report.tasks).toBeGreaterThanOrEqual(1);
    expect(report.workersPerNode).toBeGreaterThanOrEqual(1);
    expect(report.arms.every((a) => a.tasksVerified === report.tasks)).toBe(true);
  }, 20_000);
});

describe("formatClusterBench", () => {
  it("produces one summary line per arm plus ratio/fault-tolerance/notes lines", async () => {
    const report: ClusterBenchReport = await runClusterBench({ tasks: 4, nodes: 2, workersPerNode: 2, seed: 3, timeoutMs: 15_000 });
    const lines = formatClusterBench(report);

    expect(lines[0]).toContain("cluster bench");
    for (const arm of report.arms) {
      expect(lines.some((l) => l.includes(arm.label))).toBe(true);
    }
    expect(lines.some((l) => l.includes("speedup vs single-node"))).toBe(true);
    expect(lines.some((l) => l.includes("verified-throughput ratio"))).toBe(true);
    expect(lines.some((l) => l.includes("fault tolerance held"))).toBe(true);
    for (const note of report.notes) {
      expect(lines.some((l) => l.includes(note))).toBe(true);
    }
  }, 20_000);
});
