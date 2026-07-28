/**
 * Latency-model makespan: the honest makespan comparison.
 *
 * The in-memory {@link runHeadToHead} benchmark proves the hierarchy's O(N)→O(N²)
 * *routing* win as a hard count, but its wall-clock makespan favors the flat
 * baseline — and that is expected, not a defeat: a single-threaded event loop
 * with free function-call "delivery" cannot express parallelism, and the tree
 * simply does more total aggregation work. That model does not describe any real
 * multi-agent system.
 *
 * In a REAL swarm (Hades, Hermes, or anything distributed) two things are true
 * that the free-call model ignores:
 *   1. **Delivery costs real latency** — a task handed from a parent to a child
 *      crosses a wire/IPC boundary (`linkMs`), and the sender spends real time
 *      per send routing + serializing (`sendMs`).
 *   2. **Each agent processes its mailbox sequentially** — one node is one event
 *      loop; it can only send to, and aggregate from, one peer at a time.
 *
 * Under those two realities a single flat manager fanning out to N workers is a
 * serial bottleneck: it must issue N sends and absorb N results one at a time,
 * so its makespan is **O(N)**. The hierarchy spreads that fan-out across
 * coordinators that work on independent timelines, so its critical path is the
 * tree depth × branch cost — **O(log N)**. This is the classic reason
 * reduction trees exist (MPI all-reduce, MapReduce shuffle, gossip trees).
 *
 * This module makes that concrete with a DETERMINISTIC discrete-event model
 * (virtual time — no wall clock, no randomness, so results are reproducible and
 * cannot be fudged). {@link simulateMakespan} computes the finish time of a node
 * given the instant its task arrives; {@link compareMakespan} builds a flat
 * (depth-1, N children) and a balanced B-ary topology with the SAME N leaves and
 * the SAME per-hop costs and reports both makespans. The tree wins for any N past
 * a small crossover, and the win grows without bound as N grows.
 */

/** A topology node. A leaf has no children; a coordinator fans out to children. */
export interface SimNode {
  children: SimNode[];
}

export interface LatencyParams {
  /** Per-child outbound cost, serialized on the sender (routing + serialization). */
  sendMs: number;
  /** One-way wire latency for a message (applied on the way down and the way up). */
  linkMs: number;
  /** Leaf compute time. */
  taskMs: number;
  /** Per-child aggregation cost, serialized on the receiving parent. */
  aggMs: number;
}

/**
 * Finish time of `node` whose task ARRIVES at virtual time `arrival`.
 *
 * A leaf computes for `taskMs` and is done. A coordinator:
 *   1. **Sends sequentially** — child k is dispatched at `arrival + (k+1)*sendMs`
 *      (the node is single-threaded, so the k-th send waits behind the first k).
 *      The dispatched sub-task reaches the child `linkMs` later.
 *   2. Recurses to get each child's finish time; the child's result travels back
 *      up the wire, arriving at the parent `linkMs` after the child finishes.
 *   3. **Aggregates sequentially** — the parent, free only after it has finished
 *      issuing all its sends (`arrival + B*sendMs`), folds each arrived result one
 *      at a time (`aggMs` each), in result-arrival order.
 *
 * The returned time is when the parent has folded its last child's result.
 */
export function simulateMakespan(node: SimNode, arrival: number, p: LatencyParams): number {
  if (node.children.length === 0) {
    return arrival + p.taskMs;
  }

  const b = node.children.length;
  const resultArrivals: number[] = [];
  for (let k = 0; k < b; k++) {
    const dispatchAt = arrival + (k + 1) * p.sendMs; // sequential outbound
    const childArrival = dispatchAt + p.linkMs;
    const childFinish = simulateMakespan(node.children[k], childArrival, p);
    resultArrivals.push(childFinish + p.linkMs); // result travels back up
  }

  // The parent cannot start folding until it has finished all its sends.
  let free = arrival + b * p.sendMs;
  const sorted = [...resultArrivals].sort((a, z) => a - z);
  for (const a of sorted) {
    free = Math.max(free, a) + p.aggMs; // one-at-a-time, in arrival order
  }
  return free;
}

/** A flat manager: one root whose children are all N workers (leaves). */
export function buildFlatTopology(n: number): SimNode {
  if (n < 1) throw new RangeError(`worker count must be >= 1, got ${n}`);
  return { children: Array.from({ length: n }, () => ({ children: [] as SimNode[] })) };
}

/**
 * A balanced B-ary topology with EXACTLY `n` leaves — leaves are split as evenly
 * as possible across up to `b` subtrees at every level, so depth is ⌈log_b n⌉.
 */
export function buildBalancedTopology(n: number, b: number): SimNode {
  if (n < 1) throw new RangeError(`worker count must be >= 1, got ${n}`);
  if (b < 2) throw new RangeError(`branching must be >= 2, got ${b}`);
  if (n === 1) return { children: [] };
  const groups = Math.min(b, n);
  const base = Math.floor(n / groups);
  const rem = n % groups;
  const children: SimNode[] = [];
  for (let i = 0; i < groups; i++) {
    const cnt = base + (i < rem ? 1 : 0);
    children.push(buildBalancedTopology(cnt, b));
  }
  return { children };
}

export interface MakespanRow {
  workers: number;
  flatMakespanMs: number;
  treeMakespanMs: number;
  /** flatMakespanMs / treeMakespanMs (>1 means the hierarchy wins). */
  makespanSpeedup: number;
  treeWins: boolean;
}

export interface MakespanReport {
  rows: MakespanRow[];
  markdownTable: string;
  params: LatencyParams & { branching: number };
}

const DEFAULT_PARAMS: LatencyParams = { sendMs: 1, linkMs: 1, taskMs: 10, aggMs: 1 };

/**
 * Compare flat vs balanced-hierarchy makespan under the latency model across a
 * range of worker counts. Both topologies reduce the SAME N leaves with the SAME
 * per-hop costs; the only difference is the fan-out shape. Deterministic.
 */
export function compareMakespan(
  opts: {
    readonly workerCounts?: readonly number[];
    branching?: number;
    params?: Partial<LatencyParams>;
  } = {}
): MakespanReport {
  const workerCounts = opts.workerCounts ?? [16, 64, 256, 1024];
  const branching = opts.branching ?? 4;
  const p: LatencyParams = { ...DEFAULT_PARAMS, ...opts.params };

  const rows: MakespanRow[] = workerCounts.map((n) => {
    const flat = simulateMakespan(buildFlatTopology(n), 0, p);
    const tree = simulateMakespan(buildBalancedTopology(n, branching), 0, p);
    return {
      workers: n,
      flatMakespanMs: flat,
      treeMakespanMs: tree,
      makespanSpeedup: flat / tree,
      treeWins: tree < flat,
    };
  });

  const header =
    "| Workers | Makespan flat (ms) | Makespan hier (ms) | Makespan speedup | Hierarchy wins |\n" +
    "| ---: | ---: | ---: | ---: | :---: |";
  const body = rows
    .map(
      (r) =>
        `| ${r.workers} | ${r.flatMakespanMs.toFixed(1)} | ${r.treeMakespanMs.toFixed(1)} | ${r.makespanSpeedup.toFixed(2)}x | ${r.treeWins ? "yes" : "no"} |`
    )
    .join("\n");

  return { rows, markdownTable: `${header}\n${body}`, params: { ...p, branching } };
}
