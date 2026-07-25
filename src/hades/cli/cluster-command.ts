/**
 * `hades cluster <sub>` — the terminal surface over Team 5's in-process
 * multi-node cluster fabric (`../../swarm-runtime/distributed/cluster-chaos.ts`,
 * `cluster-bench.ts`).
 *
 *   hades cluster status [--nodes N] [--workers N] [--json]
 *   hades cluster nodes  [--nodes N] [--workers N] [--json]
 *   hades cluster run    --nodes N --tasks N [--workers N] [--json]
 *   hades cluster bench  [--tasks N] [--nodes N] [--workers N] [--seed N] [--json]
 *   hades cluster chaos  [--seed N] [--nodes N] [--tasks N] [--workers N] [--density F] [--json]
 *   hades cluster autoscale [--pending N] [--leased N] [--min N] [--max N]
 *                           [--target-queue N] [--max-usd-hour N] [--json]
 *   hades cluster help
 *
 * Every subcommand actually builds and runs a real in-process fabric (real
 * inline `SwarmManager`s, real verification gate, real ed25519 certificates,
 * real SWIM membership) and tears it down before returning — nothing here is
 * a static or precomputed figure. Terminal-free (`{ code, lines }`), matching
 * the house shape; no terminal I/O happens inside this module.
 *
 * Reachable as `hades cluster <sub>` (routed from `./cli.ts`, listed in
 * `hades help`, exported from `./index.ts`) and as
 * `npm run cluster[:status|:nodes|:run|:bench|:chaos]`. The desktop app reads
 * the same fabric through the `cluster.*` IPC lane
 * (`../../desktop/ipc/cluster-contract.ts`), and the TUI renders the same
 * measured report through `swarm-runtime/tui/cluster-pane.ts`.
 */

import { randomUUID } from "node:crypto";

import type { CliResult } from "./cli";
import {
  buildClusterFabric,
  chaosPlan,
  runClusterChaos,
  type ChaosRunReport,
  type ClusterFabric,
} from "../../swarm-runtime/distributed/cluster-chaos";
import { runClusterBench, formatClusterBench } from "../../swarm-runtime/distributed/cluster-bench";
import { ClusterAutoscaler, type ScaleDecision } from "../../swarm-runtime/distributed/cluster-autoscaler";
import type { NodeState } from "../../swarm-runtime/distributed/membership";
import type { RemoteBackendRegistry } from "../backends/backend";
import type { BackendDescriptor } from "../backends/descriptor";
import type { WorkerTask } from "../../swarm-runtime/types";

/**
 * The real remote-compute fleet `hades cluster autoscale` plans against. This
 * is the SAME `BackendManager` `hades backends` drives — central wiring passes
 * `manager.registry` and `manager.descriptors()` straight through — so a plan
 * is written against the backends this install actually has registered, never
 * a hardcoded or invented backend list. Absent, `autoscale` says so and
 * refuses rather than planning against a fiction.
 */
export interface ClusterAutoscaleDeps {
  registry: RemoteBackendRegistry;
  descriptors: BackendDescriptor[];
}

export interface ClusterCommandDeps {
  fabric?: typeof buildClusterFabric;
  bench?: typeof runClusterBench;
  chaos?: typeof runClusterChaos;
  /** Real fleet for `autoscale`. Absent -> `autoscale` reports it honestly. */
  backends?: () => ClusterAutoscaleDeps;
  now?: () => number;
}

export const CLUSTER_USAGE: readonly string[] = [
  "Usage: hades cluster <command> [options]",
  "",
  "Commands:",
  "  status [--nodes N] [--workers N] [--json]",
  "      Build a small in-process fabric, report its composition + coordinator stats, tear it down.",
  "  nodes [--nodes N] [--workers N] [--json]",
  "      Build a fabric and list each node's live snapshot (health, load, in-flight leases).",
  "  run --nodes N --tasks N [--workers N] [--json]",
  "      Build a fabric and run N real tasks across it end to end (no injected faults).",
  "  bench [--tasks N] [--nodes N] [--workers N] [--seed N] [--json]",
  "      Measured single-node vs multi-node vs multi-node-under-faults benchmark.",
  "  chaos [--seed N] [--nodes N] [--tasks N] [--workers N] [--density F] [--json]",
  "      Run N tasks across a fabric under a real, seeded fault-injection schedule",
  "      (worker kills, node crashes, link partitions) — same seed reproduces the same schedule.",
  "  autoscale [--pending N] [--leased N] [--min N] [--max N] [--target-queue N]",
  "            [--max-usd-hour N] [--json]",
  "      DRY RUN. Plan the per-node worker counts the autoscaler would ask for at the",
  "      given demand, against THIS install's real registered backends. Reports each",
  "      decision and its reason; provisions and terminates NOTHING.",
  "  help",
  "      Show this help.",
  "",
  "Every reported number comes from an actually-executed in-process cluster fabric — never a",
  "simulated or hand-picked figure. `--json` emits the underlying measured report verbatim.",
];

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

interface ParsedFlags {
  nodes?: number;
  tasks?: number;
  workers?: number;
  seed?: number;
  density?: number;
  pending?: number;
  leased?: number;
  min?: number;
  max?: number;
  targetQueue?: number;
  maxUsdHour?: number;
  json: boolean;
}
interface FlagError {
  error: string;
}

function isFlagError(v: ParsedFlags | FlagError): v is FlagError {
  return "error" in v;
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): ParsedFlags | FlagError {
  const out: ParsedFlags = { json: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a === "--json") {
      if (!allowed.has(a)) return { error: `unknown flag: ${a}` };
      out.json = true;
      continue;
    }

    if (a === "--max-usd-hour") {
      if (!allowed.has(a)) return { error: `unknown flag: ${a}` };
      const raw = args[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isFinite(n) || n < 0) {
        return { error: `--max-usd-hour must be a non-negative number, got "${raw ?? "(missing)"}"` };
      }
      out.maxUsdHour = n;
      continue;
    }

    if (a === "--pending" || a === "--leased" || a === "--min") {
      if (!allowed.has(a)) return { error: `unknown flag: ${a}` };
      const raw = args[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n < 0) {
        return { error: `${a} must be a non-negative integer, got "${raw ?? "(missing)"}"` };
      }
      if (a === "--pending") out.pending = n;
      else if (a === "--leased") out.leased = n;
      else out.min = n;
      continue;
    }

    if (a === "--max" || a === "--target-queue") {
      if (!allowed.has(a)) return { error: `unknown flag: ${a}` };
      const raw = args[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n <= 0) {
        return { error: `${a} must be a positive integer, got "${raw ?? "(missing)"}"` };
      }
      if (a === "--max") out.max = n;
      else out.targetQueue = n;
      continue;
    }

    if (a === "--density") {
      if (!allowed.has(a)) return { error: `unknown flag: ${a}` };
      const raw = args[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isFinite(n) || n < 0) {
        return { error: `--density must be a non-negative number, got "${raw ?? "(missing)"}"` };
      }
      out.density = n;
      continue;
    }

    if (a === "--seed") {
      if (!allowed.has(a)) return { error: `unknown flag: ${a}` };
      const raw = args[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isFinite(n) || !Number.isInteger(n)) {
        return { error: `--seed must be an integer, got "${raw ?? "(missing)"}"` };
      }
      out.seed = n;
      continue;
    }

    if (a === "--nodes" || a === "--tasks" || a === "--workers") {
      if (!allowed.has(a)) return { error: `unknown flag: ${a}` };
      const raw = args[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n <= 0) {
        return { error: `${a} must be a positive integer, got "${raw ?? "(missing)"}"` };
      }
      if (a === "--nodes") out.nodes = n;
      else if (a === "--tasks") out.tasks = n;
      else out.workers = n;
      continue;
    }

    return { error: `unknown flag: ${a}` };
  }

  return out;
}

function usageError(message: string): CliResult {
  return { code: 2, lines: [message, "", ...CLUSTER_USAGE] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Synthetic task builder for `run` (mirrors the shape `cluster-chaos.ts`
// and `cluster-bench.ts` build internally; kept as an independent local copy
// per the locked file boundary — this module never imports their private
// helpers, only their exported surface).
// ---------------------------------------------------------------------------

function buildRunTasks(count: number): WorkerTask[] {
  const createdAt = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `cli-run-${i}-${randomUUID().slice(0, 8)}`,
    goalId: "cluster-cli-run-goal",
    description: `CLI-driven cluster run item ${i}`,
    requiredCapabilities: ["general"],
    input: { objective: `cli run objective ${i}` },
    dependsOn: [],
    priority: 1,
    status: "pending" as const,
    attempts: 0,
    maxAttempts: 3,
    createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatChaosReport(label: string, report: ChaosRunReport, json: boolean): CliResult {
  const complete = report.tasksVerified === report.tasksSubmitted && report.tasksFailed === 0;

  if (json) {
    return { code: complete ? 0 : 1, lines: [JSON.stringify(report, null, 2)] };
  }

  const lines: string[] = [
    `${label} (mode=${report.mode}, nodes=${report.nodes})`,
    `  submitted=${report.tasksSubmitted} verified=${report.tasksVerified} failed=${report.tasksFailed}`,
    `  duplicateVerifications=${report.duplicateVerifications} reassignments=${report.reassignments} conflicts=${report.conflicts}`,
    `  certificates: valid=${report.certificatesValid} invalid=${report.certificatesInvalid}`,
    `  makespan=${report.makespanMs}ms verifiedPerSec=${report.verifiedPerSec.toFixed(2)}`,
    `  faults injected: ${report.faultsInjected.length}`,
  ];
  for (const f of report.faultsInjected) {
    lines.push(`    at=${f.at}ms ${f.kind} target=${f.target}${f.peer ? ` peer=${f.peer}` : ""}${f.detail ? ` detail=${f.detail}` : ""}`);
  }
  if (!complete) {
    lines.push(
      `WARNING: run did not fully complete within its timeout budget (verified ${report.tasksVerified}/${report.tasksSubmitted}, failed ${report.tasksFailed}).`,
    );
  }
  return { code: complete ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// runClusterCommand
// ---------------------------------------------------------------------------

export async function runClusterCommand(argv: string[], deps?: ClusterCommandDeps): Promise<CliResult> {
  const buildFabric = deps?.fabric ?? buildClusterFabric;
  const bench = deps?.bench ?? runClusterBench;
  const chaos = deps?.chaos ?? runClusterChaos;
  const now = deps?.now ?? (() => Date.now());

  const [sub, ...rest] = argv;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: [...CLUSTER_USAGE] };
  }

  if (sub === "status") {
    const parsed = parseFlags(rest, new Set(["--nodes", "--workers", "--json"]));
    if (isFlagError(parsed)) return usageError(parsed.error);
    const nodesCount = parsed.nodes ?? 2;
    const workers = parsed.workers ?? 2;

    let fabric: ClusterFabric;
    try {
      fabric = await buildFabric({ nodes: nodesCount, workersPerNode: workers });
    } catch (err) {
      return { code: 1, lines: [`cluster status: failed to build fabric: ${errorMessage(err)}`] };
    }
    try {
      const stats = fabric.coordinator.stats();
      const peersReady = fabric.routers.map((r) => r.stats().ready);
      const asOf = now();
      if (parsed.json) {
        return {
          code: 0,
          lines: [JSON.stringify({ mode: "measured", asOf, nodes: nodesCount, workersPerNode: workers, coordinator: stats, peersReady }, null, 2)],
        };
      }
      return {
        code: 0,
        lines: [
          "cluster status (measured, in-process fabric — ephemeral: no persistent cluster daemon runs between CLI invocations)",
          `  as of: ${new Date(asOf).toISOString()}`,
          `  nodes: ${nodesCount} x ${workers} workers/node`,
          `  coordinator: total=${stats.total} pending=${stats.pending} leased=${stats.leased} verified=${stats.verified} failed=${stats.failed}`,
          `  federation peers ready per node router: [${peersReady.join(", ")}]`,
        ],
      };
    } finally {
      await fabric.shutdown();
    }
  }

  if (sub === "nodes") {
    const parsed = parseFlags(rest, new Set(["--nodes", "--workers", "--json"]));
    if (isFlagError(parsed)) return usageError(parsed.error);
    const nodesCount = parsed.nodes ?? 3;
    const workers = parsed.workers ?? 2;

    let fabric: ClusterFabric;
    try {
      fabric = await buildFabric({ nodes: nodesCount, workersPerNode: workers });
    } catch (err) {
      return { code: 1, lines: [`cluster nodes: failed to build fabric: ${errorMessage(err)}`] };
    }
    try {
      const snapshots = fabric.nodes.map((n) => n.snapshot());
      const asOf = now();
      if (parsed.json) {
        return { code: 0, lines: [JSON.stringify({ mode: "measured", asOf, nodes: snapshots }, null, 2)] };
      }
      const lines = [`cluster nodes (measured, ${snapshots.length} nodes x ${workers} workers/node)`];
      for (const s of snapshots) {
        lines.push(
          `  ${s.nodeId.padEnd(10)} health=${s.health.padEnd(9)} liveWorkers=${s.liveWorkers} load=${s.load.toFixed(2)} ` +
            `inFlight=${s.inFlight.length} leader=${s.leaderId ?? "(none)"}`,
        );
      }
      return { code: 0, lines };
    } finally {
      await fabric.shutdown();
    }
  }

  if (sub === "run") {
    const parsed = parseFlags(rest, new Set(["--nodes", "--tasks", "--workers", "--json"]));
    if (isFlagError(parsed)) return usageError(parsed.error);
    if (parsed.nodes === undefined) return usageError("cluster run: --nodes is required");
    if (parsed.tasks === undefined) return usageError("cluster run: --tasks is required");
    const workers = parsed.workers ?? 2;

    let fabric: ClusterFabric;
    try {
      fabric = await buildFabric({ nodes: parsed.nodes, workersPerNode: workers });
    } catch (err) {
      return { code: 1, lines: [`cluster run: failed to build fabric: ${errorMessage(err)}`] };
    }
    try {
      const tasks = buildRunTasks(parsed.tasks);
      const report = await fabric.run(tasks);
      return formatChaosReport("cluster run", report, parsed.json);
    } catch (err) {
      return { code: 1, lines: [`cluster run: ${errorMessage(err)}`] };
    } finally {
      await fabric.shutdown();
    }
  }

  if (sub === "chaos") {
    const parsed = parseFlags(rest, new Set(["--seed", "--nodes", "--tasks", "--workers", "--density", "--json"]));
    if (isFlagError(parsed)) return usageError(parsed.error);
    const nodesCount = parsed.nodes ?? 3;
    const tasksCount = parsed.tasks ?? 6;
    const seed = parsed.seed ?? 7;
    const density = parsed.density ?? 0.5;

    // Mirrors cluster-chaos.ts's fixed "node-{i}" naming convention so the
    // generated plan's fault targets line up with the fabric it will run
    // against — this file never imports that module's private helpers.
    const nodeIds = Array.from({ length: nodesCount }, (_, i) => `node-${i}`);
    const durationMs = Math.max(500, tasksCount * 150);
    const plan = chaosPlan({ seed, durationMs, nodes: nodeIds, density });

    try {
      const report = await chaos({
        nodes: nodesCount,
        tasks: tasksCount,
        seed,
        plan,
        ...(parsed.workers !== undefined ? { workersPerNode: parsed.workers } : {}),
      });
      return formatChaosReport("cluster chaos", report, parsed.json);
    } catch (err) {
      return { code: 1, lines: [`cluster chaos: ${errorMessage(err)}`] };
    }
  }

  if (sub === "bench") {
    const parsed = parseFlags(rest, new Set(["--tasks", "--nodes", "--workers", "--seed", "--json"]));
    if (isFlagError(parsed)) return usageError(parsed.error);

    try {
      const report = await bench({
        tasks: parsed.tasks,
        nodes: parsed.nodes,
        seed: parsed.seed,
        workersPerNode: parsed.workers,
      });
      if (parsed.json) return { code: 0, lines: [JSON.stringify(report, null, 2)] };
      return { code: 0, lines: formatClusterBench(report) };
    } catch (err) {
      return { code: 1, lines: [`cluster bench: ${errorMessage(err)}`] };
    }
  }

  if (sub === "autoscale") {
    const parsed = parseFlags(
      rest,
      new Set(["--pending", "--leased", "--min", "--max", "--target-queue", "--max-usd-hour", "--nodes", "--workers", "--json"]),
    );
    if (isFlagError(parsed)) return usageError(parsed.error);

    if (!deps?.backends) {
      // No fleet configured -> there is nothing real to plan against. Refuse
      // rather than inventing a backend list and printing a plan that could
      // never be applied on this machine.
      return {
        code: 1,
        lines: [
          "cluster autoscale: the remote-compute fleet is not configured in this build,",
          "so there are no real backends to plan against. Run `hades backends list` to see",
          "what this install has registered; autoscale refuses to plan against a fiction.",
        ],
      };
    }

    let fleet: ClusterAutoscaleDeps;
    try {
      fleet = deps.backends();
    } catch (err) {
      return { code: 1, lines: [`cluster autoscale: ${errorMessage(err)}`] };
    }

    const nodesCount = parsed.nodes ?? 3;
    const workersPerNode = parsed.workers ?? 2;
    const pending = parsed.pending ?? 0;
    const leased = parsed.leased ?? 0;
    const min = parsed.min ?? 0;
    const max = parsed.max ?? nodesCount * workersPerNode;
    if (max < min) {
      return usageError(`cluster autoscale: --max (${max}) must be >= --min (${min})`);
    }

    const at = now();
    // A hypothetical roster at the requested shape. `evaluate()` is a PURE
    // function of (bookkeeping, signal) — this call performs no I/O, touches
    // no registry, and provisions nothing. It is the autoscaler's real
    // decision logic, run against this install's real backend descriptors.
    const makeNode = (i: number): NodeState => ({
      descriptor: {
        nodeId: `node-${i}`,
        managerUrl: `inline://node-${i}`,
        capabilities: ["general"],
        capacity: { maxWorkers: workersPerNode, providerKinds: ["inline"] },
        publicKeyHex: "",
        startedAt: at,
      },
      health: "alive",
      incarnation: 0,
      lastSeenAt: at,
      load: 0,
      liveWorkers: 0,
    });
    const aliveNodes: NodeState[] = Array.from({ length: nodesCount }, (_, i) => makeNode(i));

    const autoscaler = new ClusterAutoscaler({
      registry: fleet.registry,
      descriptors: fleet.descriptors,
      min,
      max,
      now: () => at,
      ...(parsed.targetQueue !== undefined ? { targetQueuePerWorker: parsed.targetQueue } : {}),
      ...(parsed.maxUsdHour !== undefined ? { maxCostPerHourUsd: parsed.maxUsdHour } : {}),
    });

    let decisions: ScaleDecision[];
    try {
      decisions = autoscaler.evaluate({
        now: at,
        pending,
        leased,
        verifiedSinceLast: 0,
        elapsedMs: 0,
        aliveNodes,
        inFlightByNode: new Map<string, number>(),
      });
    } catch (err) {
      return { code: 1, lines: [`cluster autoscale: ${errorMessage(err)}`] };
    }

    const backendNames = fleet.descriptors.map((d) => d.name);

    if (parsed.json) {
      return {
        code: 0,
        lines: [
          JSON.stringify(
            {
              mode: "plan",
              dryRun: true,
              asOf: at,
              demand: { pending, leased },
              bounds: { min, max },
              backends: backendNames,
              decisions,
            },
            null,
            2,
          ),
        ],
      };
    }

    const lines = [
      "cluster autoscale (DRY RUN — a plan, not a measurement; nothing was provisioned or terminated)",
      `  as of: ${new Date(at).toISOString()}`,
      `  demand: pending=${pending} leased=${leased}   bounds: min=${min} max=${max}`,
      `  registered backends: ${backendNames.length > 0 ? backendNames.join(", ") : "(none)"}`,
    ];
    if (backendNames.length === 0) {
      lines.push("  NOTE: no backends are registered, so every scale-up abstains with reason=no-backend.");
    }
    for (const d of decisions) {
      lines.push(
        `  ${d.nodeId.padEnd(10)} ${String(d.from).padStart(3)} -> ${String(d.to).padEnd(3)} ` +
          `(${d.delta >= 0 ? "+" : ""}${d.delta}) reason=${d.reason}` +
          `${d.backendName ? ` backend=${d.backendName}` : ""}` +
          `${d.estCostPerHourUsd !== undefined ? ` est=$${d.estCostPerHourUsd.toFixed(4)}/h` : ""}`,
      );
    }
    lines.push("  Apply this plan with `hades backends provision` — autoscale itself never mutates the fleet.");
    return { code: 0, lines };
  }

  return usageError(`Unknown cluster command: ${sub}`);
}
