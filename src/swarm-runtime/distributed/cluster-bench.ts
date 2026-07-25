/**
 * @module swarm-runtime/distributed/cluster-bench
 *
 * Team 5 — the measured, multi-arm cluster benchmark. Runs the IDENTICAL
 * synthetic task set, through the IDENTICAL executor (`DemoExecutor`, wired
 * in by `./cluster-chaos`'s fabric builder), across three arms:
 *
 *   1. `single-node`      — one simulated node, no faults.
 *   2. `multi-node`       — `opts.nodes` simulated nodes, no faults.
 *   3. `multi-node-chaos` — the same `opts.nodes` nodes, running under a
 *      real, seeded {@link chaosPlan} (worker kills, node crashes, link
 *      partitions) via the exact same `ClusterFabric.run()` path Team 5's
 *      chaos harness uses.
 *
 * Every number in {@link ClusterBenchReport} is read straight off a real
 * {@link ChaosRunReport} produced by actually executing that arm's fabric —
 * real wall-clock `makespanMs`, real verified counts, real reassignment
 * counts. `speedupVsSingleNode` and `verifiedThroughputRatio` are plain
 * ratios of those two measured arms; nothing is modeled, interpolated, or
 * hand-picked. If any arm fails to verify every submitted task within its
 * timeout budget, {@link runClusterBench} throws rather than emitting a
 * report built on an incomplete run — a bench report only ever describes
 * work that actually finished.
 */

import { randomUUID } from "node:crypto";

import { buildClusterFabric, chaosPlan, type ChaosRunReport, type ClusterFabricOptions } from "./cluster-chaos";
import type { WorkerTask } from "../types";

// ---------------------------------------------------------------------------
// Public types (locked contract)
// ---------------------------------------------------------------------------

export interface ClusterBenchArm {
  label: string;
  nodes: number;
  faults: boolean;
  makespanMs: number;
  tasksVerified: number;
  tasksFailed: number;
  verifiedPerSec: number;
  reassignments: number;
}

export interface ClusterBenchReport {
  mode: "measured";
  runAt: number;
  tasks: number;
  workersPerNode: number;
  seed: number;
  arms: ClusterBenchArm[];
  speedupVsSingleNode: number;
  verifiedThroughputRatio: number;
  faultToleranceHeld: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildBenchTasks(count: number, capabilities: string[]): WorkerTask[] {
  const createdAt = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `bench-${i}-${randomUUID().slice(0, 8)}`,
    goalId: "cluster-bench-goal",
    description: `Bench workload item ${i}`,
    requiredCapabilities: capabilities,
    input: { objective: `bench objective ${i}` },
    dependsOn: [],
    priority: 1,
    status: "pending" as const,
    attempts: 0,
    maxAttempts: 3,
    createdAt,
  }));
}

interface ArmRun {
  arm: ClusterBenchArm;
  report: ChaosRunReport;
}

async function runArm(
  label: string,
  fabricOpts: ClusterFabricOptions,
  tasks: WorkerTask[],
  faults: boolean,
  plan: ReturnType<typeof chaosPlan> | undefined,
  timeoutMs: number,
): Promise<ArmRun> {
  const fabric = await buildClusterFabric(fabricOpts);
  try {
    const report = await fabric.run(tasks, { timeoutMs, plan });
    return {
      report,
      arm: {
        label,
        nodes: fabricOpts.nodes,
        faults,
        makespanMs: report.makespanMs,
        tasksVerified: report.tasksVerified,
        tasksFailed: report.tasksFailed,
        verifiedPerSec: report.verifiedPerSec,
        reassignments: report.reassignments,
      },
    };
  } finally {
    await fabric.shutdown();
  }
}

function safeRatio(numerator: number, denominator: number): number {
  if (!(denominator > 0)) return numerator > 0 ? numerator : 0;
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) ? ratio : 0;
}

// ---------------------------------------------------------------------------
// runClusterBench
// ---------------------------------------------------------------------------

export async function runClusterBench(opts?: {
  tasks?: number;
  nodes?: number;
  workersPerNode?: number;
  seed?: number;
  timeoutMs?: number;
}): Promise<ClusterBenchReport> {
  const tasksCount = Math.max(1, Math.floor(opts?.tasks ?? 6));
  const nodes = Math.max(2, Math.floor(opts?.nodes ?? 3));
  const workersPerNode = Math.max(1, Math.floor(opts?.workersPerNode ?? 2));
  const seed = Number.isFinite(opts?.seed) ? (opts?.seed as number) : 42;
  const timeoutMs = Math.max(1000, Math.floor(opts?.timeoutMs ?? 12_000));
  const capabilities = ["general"];

  const tasks = buildBenchTasks(tasksCount, capabilities);
  const runAt = Date.now();

  const singleRun = await runArm("single-node", { nodes: 1, workersPerNode, capabilities, seed }, tasks, false, undefined, timeoutMs);
  const multiRun = await runArm("multi-node", { nodes, workersPerNode, capabilities, seed }, tasks, false, undefined, timeoutMs);

  const chaosNodeIds = Array.from({ length: nodes }, (_, i) => `node-${i}`);
  const plan = chaosPlan({ seed, durationMs: Math.min(1500, Math.max(200, timeoutMs / 4)), nodes: chaosNodeIds, density: 0.6 });
  const chaosRun = await runArm("multi-node-chaos", { nodes, workersPerNode, capabilities, seed }, tasks, true, plan, timeoutMs);

  const arms = [singleRun.arm, multiRun.arm, chaosRun.arm];
  for (const run of [singleRun, multiRun, chaosRun]) {
    if (run.arm.tasksVerified !== tasksCount) {
      throw new Error(
        `runClusterBench: arm "${run.arm.label}" only verified ${run.arm.tasksVerified}/${tasksCount} tasks ` +
          `within timeoutMs=${timeoutMs} — refusing to emit a bench report built on an incomplete run.`,
      );
    }
  }

  const speedupVsSingleNode = safeRatio(singleRun.arm.makespanMs, multiRun.arm.makespanMs);
  const verifiedThroughputRatio = safeRatio(multiRun.arm.verifiedPerSec, singleRun.arm.verifiedPerSec);
  const faultToleranceHeld =
    chaosRun.arm.tasksVerified === tasksCount &&
    chaosRun.arm.tasksFailed === 0 &&
    chaosRun.report.duplicateVerifications === 0 &&
    chaosRun.report.certificatesInvalid === 0;

  const notes: string[] = [
    `in-process simulation: every arm runs ${nodes >= 1 ? "up to " : ""}${nodes} simulated cluster nodes (each a real inline SwarmManager with its own worker pool) inside this one Node.js process on one wall clock — this is not a cross-machine measurement.`,
    `single-node arm: 1 node x ${workersPerNode} workers. multi-node arms: ${nodes} nodes x ${workersPerNode} workers.`,
    `all three arms ran the identical ${tasksCount}-task workload through the identical executor; only node count and fault injection differ between arms.`,
    `multi-node-chaos arm injected ${chaosRun.report.faultsInjected.length} real fault(s) (seed=${seed}: worker kills, node crashes, and/or link partitions) and still verified ${chaosRun.arm.tasksVerified}/${tasksCount} tasks with ${chaosRun.arm.reassignments} reassignment(s) and ${chaosRun.report.duplicateVerifications} duplicate verification(s).`,
  ];

  return {
    mode: "measured",
    runAt,
    tasks: tasksCount,
    workersPerNode,
    seed,
    arms,
    speedupVsSingleNode,
    verifiedThroughputRatio,
    faultToleranceHeld,
    notes,
  };
}

// ---------------------------------------------------------------------------
// formatClusterBench
// ---------------------------------------------------------------------------

export function formatClusterBench(r: ClusterBenchReport): string[] {
  const lines: string[] = [];
  lines.push(`cluster bench (measured, seed=${r.seed}, tasks=${r.tasks}, workersPerNode=${r.workersPerNode})`);
  for (const arm of r.arms) {
    lines.push(
      `  ${arm.label.padEnd(18)} nodes=${arm.nodes} faults=${arm.faults ? "yes" : "no"} ` +
        `makespan=${arm.makespanMs}ms verified=${arm.tasksVerified} failed=${arm.tasksFailed} ` +
        `verifiedPerSec=${arm.verifiedPerSec.toFixed(2)} reassignments=${arm.reassignments}`,
    );
  }
  lines.push(`  speedup vs single-node: ${r.speedupVsSingleNode.toFixed(2)}x`);
  lines.push(`  verified-throughput ratio (multi/single): ${r.verifiedThroughputRatio.toFixed(2)}x`);
  lines.push(`  fault tolerance held: ${r.faultToleranceHeld ? "yes" : "no"}`);
  for (const note of r.notes) lines.push(`  note: ${note}`);
  return lines;
}
