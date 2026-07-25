/**
 * `ClusterService` — the desktop `cluster.*` backend, over the REAL multi-node
 * fabric (`src/swarm-runtime/distributed/**`).
 *
 * Structurally a `ClusterHandler` (see `./sidecar.ts`), so central wiring can
 * hand it to the `Sidecar` and the desktop drives the SAME
 * `buildClusterFabric()` / `runClusterChaos()` entry points `hades cluster`
 * drives from a terminal — one implementation, never a second private copy and
 * never a re-implementation.
 *
 * Everything this service reports is measured by real code:
 *   - membership health, epochs and leadership come from the real SWIM
 *     `ClusterMembership` (real gossip, real suspect/dead timeouts, real
 *     `electLeader()`);
 *   - "verified" means a real `VerificationGate` accepted the output AND a
 *     real ed25519 certificate binds its exact bytes — verified independently
 *     with `verifyCertificate`/`certifiesOutput`, not trusted from a flag;
 *   - `reassignments`, `conflicts` and `staleReportsRejected` come from the
 *     real `ClusterCoordinator`'s own counters over real fencing tokens;
 *   - `makespanMs` is a real wall-clock delta;
 *   - injected faults are real consequences (a worker that genuinely throws, a
 *     node that genuinely stops heartbeating, a link that genuinely stops
 *     carrying frames), and `faults` lists only the ones that actually fired.
 *
 * Three honesty rules are enforced HERE, not left to the renderer:
 *
 *   1. `mode: "measured"` and `ephemeral: true` travel with EVERY reply.
 *      There is no persistent cluster daemon in this product: each command
 *      builds a fabric, measures it, and tears it down. A renderer must never
 *      present these numbers as "the state of your cluster".
 *   2. `complete: false` travels with any run that did not verify every task
 *      it submitted (or that failed one). A partial distributed run is not a
 *      result, and this flag is what stops a UI drawing one as green.
 *   3. `certificatesInvalid` and `duplicateVerifications` are first-class,
 *      mandatory fields. They are the two numbers that must be zero for the
 *      cluster's trust claim to hold, so they are never omitted when zero and
 *      never rounded away when not.
 *
 * ## Bounds, because this lane spends real CPU
 *
 * The renderer supplies `nodes`/`tasks`/`workersPerNode`, and each node is a
 * real inline `SwarmManager` with a real worker pool. Every one of those is
 * clamped SERVER-SIDE (`maxNodes`/`maxTasks`/`maxWorkersPerNode`) so a
 * renderer cannot ask for a 500-node fabric and wedge the machine. Requests
 * are also SERIALIZED behind an internal mutex: two concurrent fabrics would
 * multiply the worker pools and make both runs' wall-clock numbers meaningless
 * (and `makespanMs` is a real measurement, so it must not be polluted).
 *
 * No command in this lane can spend money — every node executes on the inline
 * provider, never a paid remote backend — and there is deliberately no
 * `cluster.bench` (see `../ipc/cluster-contract.ts` for why).
 */

import type {
  ClusterCommand,
  ClusterEvent,
  ClusterFaultWire,
  ClusterNodeWire,
  ClusterRunWire,
  ClusterStatusWire,
} from "../ipc/cluster-contract";
import {
  buildClusterFabric,
  chaosPlan,
  type ChaosPlan,
  type ChaosRunReport,
  type ClusterFabric,
  type ClusterFabricOptions,
} from "../../swarm-runtime/distributed/cluster-chaos";
import type { WorkerTask } from "../../swarm-runtime/types";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Finite numbers only cross the wire; a non-finite one becomes 0, never NaN. */
function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export interface ClusterServiceOptions {
  /** Injectable so tests can drive a real-but-tiny fabric without the default
   *  sizes. Defaults to the real `buildClusterFabric`. */
  buildFabric?: typeof buildClusterFabric;
  now?: () => number;
  /** Hard ceiling on nodes per request. Each node is a real worker pool. */
  maxNodes?: number;
  /** Hard ceiling on tasks per request. Each task is a real graded execution. */
  maxTasks?: number;
  /** Hard ceiling on workers per node. */
  maxWorkersPerNode?: number;
  /** Wall-clock budget handed to `fabric.run()`. */
  runTimeoutMs?: number;
}

const DEFAULT_MAX_NODES = 6;
const DEFAULT_MAX_TASKS = 24;
const DEFAULT_MAX_WORKERS_PER_NODE = 4;
const DEFAULT_RUN_TIMEOUT_MS = 20_000;

export class ClusterService {
  private readonly buildFabric: typeof buildClusterFabric;
  private readonly now: () => number;
  private readonly maxNodes: number;
  private readonly maxTasks: number;
  private readonly maxWorkersPerNode: number;
  private readonly runTimeoutMs: number;
  /** Serializes fabric construction: two concurrent fabrics would multiply the
   *  worker pools and make both runs' measured wall clocks meaningless. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Monotonic per-service counter used to make task ids unique across
   *  requests. A timestamp alone is not enough: two requests landing in the
   *  same millisecond would produce colliding ids, and `submit()` treats a
   *  duplicate id as an idempotent no-op — the second run would report the
   *  first run's outcomes without executing anything. */
  private requestSeq = 0;

  constructor(opts: ClusterServiceOptions = {}) {
    this.buildFabric = opts.buildFabric ?? buildClusterFabric;
    this.now = opts.now ?? ((): number => Date.now());
    this.maxNodes = Math.max(1, Math.floor(opts.maxNodes ?? DEFAULT_MAX_NODES));
    this.maxTasks = Math.max(1, Math.floor(opts.maxTasks ?? DEFAULT_MAX_TASKS));
    this.maxWorkersPerNode = Math.max(1, Math.floor(opts.maxWorkersPerNode ?? DEFAULT_MAX_WORKERS_PER_NODE));
    this.runTimeoutMs = Math.max(1000, Math.floor(opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS));
  }

  async handle(cmd: ClusterCommand): Promise<ClusterEvent> {
    try {
      switch (cmd.kind) {
        case "cluster.status":
          return { kind: "cluster.status", status: await this.status(cmd), at: this.now() };
        case "cluster.nodes":
          return { kind: "cluster.nodes", nodes: await this.nodes(cmd), at: this.now() };
        case "cluster.run":
          return { kind: "cluster.run", run: await this.run(cmd), at: this.now() };
        case "cluster.chaos":
          return { kind: "cluster.chaos", run: await this.chaos(cmd), at: this.now() };
        default: {
          const exhaustive: never = cmd;
          return {
            kind: "cluster.error",
            op: String((exhaustive as { kind?: unknown }).kind ?? "cluster.unknown"),
            message: "unsupported cluster command",
            at: this.now(),
          };
        }
      }
    } catch (err) {
      // Never silence and never fabricate an "ok": a renderer that cannot
      // distinguish "the fabric failed to build" from "nothing went wrong"
      // would draw an empty, healthy-looking panel over a broken stack.
      return { kind: "cluster.error", op: cmd.kind, message: errMsg(err), at: this.now() };
    }
  }

  // -------------------------------------------------------------------------
  // Shared coercion + serialization
  // -------------------------------------------------------------------------

  private clampInt(v: number | undefined, fallback: number, max: number): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return Math.min(fallback, max);
    return Math.min(max, Math.max(1, Math.floor(v)));
  }

  /** Run `fn` against a freshly-built fabric and ALWAYS tear it down, even if
   *  `fn` throws — a leaked fabric leaves real worker pools and real timers
   *  alive for the life of the sidecar process. */
  private async withFabric<T>(opts: ClusterFabricOptions, fn: (fabric: ClusterFabric) => Promise<T>): Promise<T> {
    const build = async (): Promise<T> => {
      const fabric = await this.buildFabric(opts);
      try {
        return await fn(fabric);
      } finally {
        await fabric.shutdown().catch(() => undefined);
      }
    };
    // Same continuation on BOTH settle paths: the queue is purely about
    // ordering, so a previous request's failure must never poison this one.
    const task = this.queue.then(build, build);
    // Keep the chain alive but swallowed, so one rejection cannot leave the
    // queue permanently rejected for every later request.
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private buildTasks(count: number, prefix: string): WorkerTask[] {
    const createdAt = this.now();
    return Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`,
      goalId: `${prefix}-goal`,
      description: `Desktop-driven cluster item ${i}`,
      requiredCapabilities: ["general"],
      input: { objective: `${prefix} objective ${i}` },
      dependsOn: [],
      priority: 1,
      status: "pending" as const,
      attempts: 0,
      maxAttempts: 3,
      createdAt,
    }));
  }

  private static toFaultWire(f: ChaosRunReport["faultsInjected"][number]): ClusterFaultWire {
    return {
      at: fin(f.at),
      kind: f.kind,
      target: f.target,
      peer: f.peer ?? null,
      detail: f.detail ?? null,
    };
  }

  private static toRunWire(report: ChaosRunReport, seed: number | null): ClusterRunWire {
    return {
      mode: "measured",
      ephemeral: true,
      nodes: fin(report.nodes),
      tasksSubmitted: fin(report.tasksSubmitted),
      tasksVerified: fin(report.tasksVerified),
      tasksFailed: fin(report.tasksFailed),
      duplicateVerifications: fin(report.duplicateVerifications),
      reassignments: fin(report.reassignments),
      conflicts: fin(report.conflicts),
      certificatesValid: fin(report.certificatesValid),
      certificatesInvalid: fin(report.certificatesInvalid),
      makespanMs: fin(report.makespanMs),
      verifiedPerSec: fin(report.verifiedPerSec),
      // Computed HERE so a renderer cannot get it wrong, and so an incomplete
      // run can never be drawn as a finished one.
      complete: report.tasksVerified === report.tasksSubmitted && report.tasksFailed === 0,
      faults: report.faultsInjected.map(ClusterService.toFaultWire),
      seed,
    };
  }

  // -------------------------------------------------------------------------
  // cluster.status
  // -------------------------------------------------------------------------

  private async status(cmd: Extract<ClusterCommand, { kind: "cluster.status" }>): Promise<ClusterStatusWire> {
    const nodes = this.clampInt(cmd.nodes, 2, this.maxNodes);
    const workersPerNode = this.clampInt(cmd.workersPerNode, 2, this.maxWorkersPerNode);

    return this.withFabric({ nodes, workersPerNode }, async (fabric) => {
      const stats = fabric.coordinator.stats();
      return {
        mode: "measured" as const,
        ephemeral: true as const,
        nodes,
        workersPerNode,
        total: fin(stats.total),
        pending: fin(stats.pending),
        leased: fin(stats.leased),
        verified: fin(stats.verified),
        failed: fin(stats.failed),
        reassignments: fin(stats.reassignments),
        staleReportsRejected: fin(stats.staleReportsRejected),
        conflicts: fin(stats.conflicts),
        peersReady: fabric.routers.map((r) => fin(r.stats().ready)),
      };
    });
  }

  // -------------------------------------------------------------------------
  // cluster.nodes
  // -------------------------------------------------------------------------

  private async nodes(cmd: Extract<ClusterCommand, { kind: "cluster.nodes" }>): Promise<ClusterNodeWire[]> {
    const nodes = this.clampInt(cmd.nodes, 3, this.maxNodes);
    const workersPerNode = this.clampInt(cmd.workersPerNode, 2, this.maxWorkersPerNode);

    return this.withFabric({ nodes, workersPerNode }, async (fabric) =>
      fabric.nodes.map((n) => {
        const s = n.snapshot();
        return {
          nodeId: s.nodeId,
          health: s.health,
          inFlight: s.inFlight.length,
          liveWorkers: fin(s.liveWorkers),
          load: fin(s.load),
          completed: fin(s.completed),
          handedBack: fin(s.handedBack),
          abandoned: fin(s.abandoned),
          epoch: fin(s.epoch),
          leaderId: s.leaderId,
        };
      }),
    );
  }

  // -------------------------------------------------------------------------
  // cluster.run
  // -------------------------------------------------------------------------

  private async run(cmd: Extract<ClusterCommand, { kind: "cluster.run" }>): Promise<ClusterRunWire> {
    const nodes = this.clampInt(cmd.nodes, 3, this.maxNodes);
    const tasks = this.clampInt(cmd.tasks, 6, this.maxTasks);
    const workersPerNode = this.clampInt(cmd.workersPerNode, 2, this.maxWorkersPerNode);

    return this.withFabric({ nodes, workersPerNode }, async (fabric) => {
      const report = await fabric.run(this.buildTasks(tasks, `desktop-run-${this.now()}-${++this.requestSeq}`), {
        timeoutMs: this.runTimeoutMs,
      });
      return ClusterService.toRunWire(report, null);
    });
  }

  // -------------------------------------------------------------------------
  // cluster.chaos
  // -------------------------------------------------------------------------

  private async chaos(cmd: Extract<ClusterCommand, { kind: "cluster.chaos" }>): Promise<ClusterRunWire> {
    const nodes = this.clampInt(cmd.nodes, 3, this.maxNodes);
    const tasks = this.clampInt(cmd.tasks, 6, this.maxTasks);
    const workersPerNode = this.clampInt(cmd.workersPerNode, 2, this.maxWorkersPerNode);
    const seed = typeof cmd.seed === "number" && Number.isFinite(cmd.seed) ? Math.floor(cmd.seed) : 7;
    const density =
      typeof cmd.density === "number" && Number.isFinite(cmd.density) && cmd.density >= 0
        ? Math.min(4, cmd.density)
        : 0.5;

    // Same node-id convention `buildClusterFabric` uses, so the generated
    // schedule's targets line up with the fabric it runs against.
    const nodeIds = Array.from({ length: nodes }, (_, i) => `node-${i}`);
    const plan: ChaosPlan = chaosPlan({
      seed,
      durationMs: Math.max(500, tasks * 150),
      nodes: nodeIds,
      density,
    });

    return this.withFabric({ nodes, workersPerNode, seed }, async (fabric) => {
      const report = await fabric.run(this.buildTasks(tasks, `desktop-chaos-${this.now()}-${++this.requestSeq}`), {
        timeoutMs: this.runTimeoutMs,
        plan,
      });
      return ClusterService.toRunWire(report, seed);
    });
  }
}
