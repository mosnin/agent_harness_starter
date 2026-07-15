/**
 * Per-node live metrics collector for the swarm.
 *
 * ## What it measures
 * For every node (identified by a string id, created lazily on first mention) the
 * collector tracks a small set of operational metrics that a live dashboard needs:
 *
 * - **processed**  – number of completed ops (whether they succeeded or errored).
 * - **errors**     – subset of `processed` that completed with `ok === false`.
 * - **inFlight**   – ops that have started but not yet completed (`onStart` without a
 *                    matching `onComplete`). Floored at 0 so unbalanced calls can never
 *                    drive it negative.
 * - **queueDepth** – ops that were enqueued but not yet started (`onEnqueue` without a
 *                    matching `onStart`). Also floored at 0.
 * - **peakQueueDepth / peakInFlight** – high-water marks observed over the node's life.
 * - **latency**    – distribution stats (count/mean/min/max/p50/p90/p99) computed over
 *                    the *retained* completed-op durations. Durations are kept in a
 *                    fixed-capacity ring buffer (`historySize`), so memory is bounded and
 *                    the oldest sample is evicted once the buffer is full.
 * - **throughputPerSec** – `processed / elapsedSec`, where elapsed is measured from the
 *                    node's first activity (first `onEnqueue`/`onStart`). Guarded against
 *                    divide-by-zero: if no time has elapsed we divide by a tiny epsilon
 *                    (and report 0 when nothing has been processed) so the value is never
 *                    `Infinity` or `NaN`.
 *
 * ## Why it's cheap (O(1) hot path)
 * Every event handler (`onEnqueue` / `onStart` / `onComplete`) does only constant work:
 * counter bumps, a peak comparison, and a single ring-buffer slot write. There is no
 * per-event sorting, allocation, or scanning — so instrumenting the swarm's hot path
 * adds negligible overhead. The only heavier work is the percentile sort, and that is
 * deferred entirely to `snapshot()` (O(n log n) in retained samples), which a dashboard
 * calls at its own cadence rather than on every op.
 *
 * ## snapshot() is an atomic pure read
 * `snapshot()` never mutates any counter, ring buffer, or peak. It copies the current
 * state and computes derived stats into a fresh, self-contained object. That makes it
 * safe to poll cheaply from a dashboard: two calls with no intervening events return
 * equal per-node data (only `at` and, if the injected clock advanced, throughput may
 * differ), and a snapshot can never perturb a later one.
 *
 * ## Determinism
 * The class contains no `Date.now()` or `Math.random()`. The clock is injected via
 * `opts.now` (defaulting to `() => Date.now()` at construction only), so tests can drive
 * time deterministically with a fake clock.
 */

/** Distribution statistics over a set of latency samples (milliseconds). */
export interface LatencyStats {
  count: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  min: number;
}

/** Immutable point-in-time view of a single node's metrics. */
export interface NodeSnapshot {
  nodeId: string;
  /** completed ops (ok or error) */
  processed: number;
  errors: number;
  /** started but not yet completed */
  inFlight: number;
  /** enqueued but not yet started */
  queueDepth: number;
  peakQueueDepth: number;
  peakInFlight: number;
  /** over retained completed-op durations */
  latency: LatencyStats;
  /** processed / elapsed since first activity */
  throughputPerSec: number;
}

/** Immutable point-in-time view of the whole collector. */
export interface MetricsSnapshot {
  at: number;
  /** sorted by nodeId ascending */
  nodes: NodeSnapshot[];
  totals: { processed: number; errors: number; inFlight: number; queueDepth: number };
}

/** Construction options. */
export interface MetricsOptions {
  /** ms clock, default () => Date.now() */
  now?: () => number;
  /** per-node retained latency samples (ring buffer), default 4096 */
  historySize?: number;
}

/** Tiny positive number used to avoid divide-by-zero in throughput. */
const EPSILON_SEC = 1e-9;

const ZERO_LATENCY: LatencyStats = Object.freeze({
  count: 0,
  mean: 0,
  p50: 0,
  p90: 0,
  p99: 0,
  max: 0,
  min: 0,
});

/** Mutable internal per-node state. */
interface NodeState {
  nodeId: string;
  processed: number;
  errors: number;
  inFlight: number;
  queueDepth: number;
  peakQueueDepth: number;
  peakInFlight: number;
  /** ring buffer of latency samples */
  ring: number[];
  /** ring capacity (== historySize) */
  cap: number;
  /** number of valid samples currently retained (<= cap) */
  size: number;
  /** next write index into ring */
  head: number;
  /** clock value of first activity, or -1 if none yet */
  firstActivity: number;
}

/**
 * Live metrics collector. See the file header for the full contract.
 *
 * Hot-path methods (`onEnqueue`/`onStart`/`onComplete`) are O(1); `snapshot()` is a pure
 * read that is O(n log n) in the number of retained latency samples (for the percentile
 * sort) and never mutates collector state.
 */
export class MetricsCollector {
  private readonly now: () => number;
  private readonly historySize: number;
  private readonly nodes = new Map<string, NodeState>();

  constructor(opts?: MetricsOptions) {
    this.now = opts?.now ?? (() => Date.now());
    const hs = opts?.historySize ?? 4096;
    // Guard against nonsensical sizes; a ring must hold at least one sample.
    this.historySize = hs > 0 ? Math.floor(hs) : 1;
  }

  /** Lazily create (or fetch) the mutable state for a node. */
  private getOrCreate(nodeId: string): NodeState {
    let n = this.nodes.get(nodeId);
    if (n === undefined) {
      n = {
        nodeId,
        processed: 0,
        errors: 0,
        inFlight: 0,
        queueDepth: 0,
        peakQueueDepth: 0,
        peakInFlight: 0,
        ring: [],
        cap: this.historySize,
        size: 0,
        head: 0,
        firstActivity: -1,
      };
      this.nodes.set(nodeId, n);
    }
    return n;
  }

  /** Record that the node's clock has seen activity (idempotent after first call). */
  private touchFirstActivity(n: NodeState): void {
    if (n.firstActivity < 0) n.firstActivity = this.now();
  }

  /** An op was enqueued: queueDepth++, tracking peakQueueDepth. O(1). */
  onEnqueue(nodeId: string): void {
    const n = this.getOrCreate(nodeId);
    this.touchFirstActivity(n);
    n.queueDepth += 1;
    if (n.queueDepth > n.peakQueueDepth) n.peakQueueDepth = n.queueDepth;
  }

  /**
   * An op started: queueDepth-- (floored at 0), inFlight++ (tracking peakInFlight).
   * Returns the start time (= now()) to be passed back to onComplete. O(1).
   */
  onStart(nodeId: string): number {
    const n = this.getOrCreate(nodeId);
    this.touchFirstActivity(n);
    if (n.queueDepth > 0) n.queueDepth -= 1;
    n.inFlight += 1;
    if (n.inFlight > n.peakInFlight) n.peakInFlight = n.inFlight;
    return this.now();
  }

  /**
   * An op completed: inFlight-- (floored at 0), processed++, errors++ if ok===false,
   * and record latency = now() - startTime into the ring buffer. O(1).
   */
  onComplete(nodeId: string, startTime: number, ok?: boolean): void {
    const n = this.getOrCreate(nodeId);
    // A completion is activity too (covers a node whose first mention is onComplete).
    this.touchFirstActivity(n);
    if (n.inFlight > 0) n.inFlight -= 1;
    n.processed += 1;
    if (ok === false) n.errors += 1;
    const latency = this.now() - startTime;
    // Ring-buffer write: constant time, oldest sample evicted when full.
    n.ring[n.head] = latency;
    n.head = (n.head + 1) % n.cap;
    if (n.size < n.cap) n.size += 1;
  }

  /**
   * Atomic pure read. Computes a fresh snapshot of every node (sorted by id) plus
   * elementwise totals. Does NOT mutate any collector state. O(n log n) in retained
   * samples due to the percentile sort.
   */
  snapshot(): MetricsSnapshot {
    const at = this.now();
    const ids = [...this.nodes.keys()].sort();
    const nodes: NodeSnapshot[] = [];
    const totals = { processed: 0, errors: 0, inFlight: 0, queueDepth: 0 };

    for (const id of ids) {
      const n = this.nodes.get(id)!;
      const latency = this.computeLatency(n);
      const throughputPerSec = this.computeThroughput(n, at);
      nodes.push({
        nodeId: n.nodeId,
        processed: n.processed,
        errors: n.errors,
        inFlight: n.inFlight,
        queueDepth: n.queueDepth,
        peakQueueDepth: n.peakQueueDepth,
        peakInFlight: n.peakInFlight,
        latency,
        throughputPerSec,
      });
      totals.processed += n.processed;
      totals.errors += n.errors;
      totals.inFlight += n.inFlight;
      totals.queueDepth += n.queueDepth;
    }

    return { at, nodes, totals };
  }

  /**
   * Compute latency stats over the retained ring-buffer samples without mutating them.
   * Percentiles use the nearest-rank method on an ascending-sorted copy:
   *   p(q) = sorted[clamp(ceil(q/100 * n) - 1, 0, n-1)].
   */
  private computeLatency(n: NodeState): LatencyStats {
    const count = n.size;
    if (count === 0) return { ...ZERO_LATENCY };

    // Copy retained samples (never touch the live ring) and sort ascending.
    const sorted = new Array<number>(count);
    for (let i = 0; i < count; i++) sorted[i] = n.ring[i];
    sorted.sort((a, b) => a - b);

    let sum = 0;
    for (let i = 0; i < count; i++) sum += sorted[i];
    const mean = sum / count;

    return {
      count,
      mean,
      p50: nearestRank(sorted, 50),
      p90: nearestRank(sorted, 90),
      p99: nearestRank(sorted, 99),
      max: sorted[count - 1],
      min: sorted[0],
    };
  }

  /** processed / max(elapsedSec, epsilon); 0 when nothing processed; never NaN/Infinity. */
  private computeThroughput(n: NodeState, at: number): number {
    if (n.processed === 0) return 0;
    const elapsedMs = n.firstActivity < 0 ? 0 : at - n.firstActivity;
    const elapsedSec = elapsedMs > 0 ? elapsedMs / 1000 : 0;
    return n.processed / Math.max(elapsedSec, EPSILON_SEC);
  }

  /** Zero everything: forget all nodes and their samples. */
  reset(): void {
    this.nodes.clear();
  }

  /** Known node ids, sorted ascending. */
  nodeIds(): string[] {
    return [...this.nodes.keys()].sort();
  }
}

/**
 * Nearest-rank percentile over an ascending-sorted array:
 *   index = clamp(ceil(q/100 * n) - 1, 0, n-1).
 * Caller guarantees `sorted.length >= 1`.
 */
function nearestRank(sorted: number[], q: number): number {
  const n = sorted.length;
  const idx = Math.ceil((q / 100) * n) - 1;
  const clamped = idx < 0 ? 0 : idx > n - 1 ? n - 1 : idx;
  return sorted[clamped];
}
