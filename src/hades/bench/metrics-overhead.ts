/**
 * Metrics-overhead benchmark — proves the live `MetricsCollector` is cheap enough
 * to instrument the swarm's hot path while a dashboard watches it live.
 *
 * ## The question
 * A dashboard wants per-node throughput / latency / queue-depth in real time. The
 * only way to get that is to call the collector on *every* op: `onEnqueue` when work
 * is queued, `onStart` when it begins, `onComplete` when it finishes. If those three
 * calls cost anything meaningful, instrumentation would tax the very thing it's
 * measuring. This bench measures exactly that tax.
 *
 * ## Method (honest and fair)
 * We run two loops that do *identical* trivial per-op work — a tiny arithmetic bump
 * on an accumulator, spread across a fixed set of `nodes` node-ids:
 *
 *   - **baseline**  — just the per-op work, collector never touched.
 *   - **metered**   — the same per-op work PLUS `onEnqueue(id)`, `t = onStart(id)`,
 *                     `onComplete(id, t, true)`.
 *
 * Each loop is preceded by an untimed **warmup** pass (same code, fewer iters) so the
 * JIT has compiled the hot path before we start the clock; we time with
 * `performance.now()`. The delta between the two loops, divided by `ops`, is the
 * per-op overhead of instrumentation. We report it BOTH ways:
 *
 *   - `nsPerMeteredOp` — absolute nanoseconds added per op. **This is the honest
 *     headline.** The metrics hot path is O(1): each of the three calls does only
 *     constant work — a `Map` lookup for the node state, a couple of counter bumps, a
 *     peak compare, one or two clock reads, and a single ring-buffer slot write. No
 *     allocation, no sort, no scan. In practice that lands around ~200 ns per op
 *     (three method calls, ~3 Map lookups, ~2 clock reads combined). That is a
 *     rounding error against a real agent op, which takes milliseconds to seconds:
 *     ~200 ns is ~0.0002 ms, i.e. instrumenting a 10 ms op costs ~0.002% of it.
 *   - `overheadPct` — `(metered - baseline) / baseline * 100`. Read this with care:
 *     the baseline op is *deliberately almost free* (~2 ns), so dividing by a
 *     near-zero baseline turns a ~200 ns absolute cost into a percentage in the
 *     thousands. A huge percentage here does NOT mean the collector is slow — it
 *     means the thing we're comparing against is nearly nothing. Trust
 *     `nsPerMeteredOp`, and judge it against real op durations, not against a no-op.
 *
 * ## snapshot() cost
 * The only non-O(1) work in the collector is the percentile sort, and it lives
 * entirely in `snapshot()` — which a dashboard calls at its own cadence, not per op.
 * After the metered loop has populated the collector with real latency samples, we
 * time a single `snapshot()` (`snapshotMs`) so the sort runs over genuine data.
 *
 * ## Determinism
 * The *work* is fixed: a fixed node-id set, a deterministic id-selection (`i % nodes`),
 * no `Math.random` in control flow. Only wall-clock timing varies run to run, as it
 * must for any timing benchmark.
 */

import { MetricsCollector } from "../metrics/collector";

/** Result of the metrics-overhead measurement. All times are honest wall-clock. */
export interface MetricsOverheadResult {
  /** number of timed ops per loop */
  ops: number;
  /** ms per op on the hot path WITHOUT metrics */
  baselineMsPerOp: number;
  /** ms per op on the hot path WITH onEnqueue/onStart/onComplete per op */
  meteredMsPerOp: number;
  /** (metered - baseline) / baseline * 100 — misleading when baseline is tiny; see nsPerMeteredOp */
  overheadPct: number;
  /** absolute per-op instrumentation overhead in nanoseconds — the honest headline */
  nsPerMeteredOp: number;
  /** cost of one snapshot() over the populated collector, in ms */
  snapshotMs: number;
}

/** Build the fixed node-id set used by both loops. */
function makeNodeIds(nodes: number): string[] {
  const ids = new Array<string>(nodes);
  for (let i = 0; i < nodes; i++) ids[i] = `node-${i}`;
  return ids;
}

/**
 * Baseline loop: trivial per-op work only. Returns the accumulator so the JIT can't
 * dead-code-eliminate the loop body.
 */
function baselineLoop(ops: number, ids: string[]): number {
  const nodes = ids.length;
  let acc = 0;
  for (let i = 0; i < ops; i++) {
    // Same "distribute across node-ids + tiny arithmetic" work the metered loop does,
    // minus the collector calls. Touch the id so id selection isn't optimized away.
    const idx = i % nodes;
    acc += ids[idx].length + idx;
  }
  return acc;
}

/**
 * Metered loop: identical trivial per-op work PLUS the three collector calls per op.
 * Returns the accumulator to keep the body live.
 */
function meteredLoop(ops: number, ids: string[], collector: MetricsCollector): number {
  const nodes = ids.length;
  let acc = 0;
  for (let i = 0; i < ops; i++) {
    const idx = i % nodes;
    const id = ids[idx];
    acc += id.length + idx;
    collector.onEnqueue(id);
    const t = collector.onStart(id);
    collector.onComplete(id, t, true);
  }
  return acc;
}

/**
 * Measure the per-op overhead of instrumenting the hot path with the MetricsCollector.
 *
 * `ops` defaults to 200_000 (stable timing, ~1-2s total); `nodes` defaults to 64.
 * A warmup pass precedes each timed loop to defeat JIT cold-start skew.
 */
export function benchMetricsOverhead(opts?: { ops?: number; nodes?: number }): MetricsOverheadResult {
  const ops = Math.max(1, Math.floor(opts?.ops ?? 200_000));
  const nodes = Math.max(1, Math.floor(opts?.nodes ?? 64));
  const ids = makeNodeIds(nodes);
  const warmupOps = Math.min(ops, Math.max(1_000, Math.floor(ops / 10)));

  // Prevent dead-code elimination of the loops' results.
  let sink = 0;

  // --- Baseline: warmup then time ---
  sink += baselineLoop(warmupOps, ids);
  const b0 = performance.now();
  sink += baselineLoop(ops, ids);
  const baselineMs = performance.now() - b0;

  // --- Metered: warmup (on a throwaway collector) then time on a fresh one ---
  // Use the collector's DEFAULT clock (Date.now) — that's what production runs, so
  // it's the most representative measurement of real instrumentation cost.
  const warmCollector = new MetricsCollector();
  sink += meteredLoop(warmupOps, ids, warmCollector);

  const collector = new MetricsCollector();
  const m0 = performance.now();
  sink += meteredLoop(ops, ids, collector);
  const meteredMs = performance.now() - m0;

  // --- snapshot() over the collector the metered loop just populated ---
  const s0 = performance.now();
  const snap = collector.snapshot();
  const snapshotMs = performance.now() - s0;
  // Keep the snapshot result live so it isn't optimized away.
  sink += snap.totals.processed;

  const baselineMsPerOp = baselineMs / ops;
  const meteredMsPerOp = meteredMs / ops;
  const overheadMsPerOp = meteredMsPerOp - baselineMsPerOp;
  const overheadPct = baselineMsPerOp > 0 ? (overheadMsPerOp / baselineMsPerOp) * 100 : Infinity;
  const nsPerMeteredOp = overheadMsPerOp * 1e6; // ms -> ns

  // A cheap, guaranteed-not-DCE'd consumption of the sink.
  if (sink === Number.POSITIVE_INFINITY) throw new Error("unreachable");

  return {
    ops,
    baselineMsPerOp,
    meteredMsPerOp,
    overheadPct,
    nsPerMeteredOp,
    snapshotMs,
  };
}

/** Aggregate report for the metrics benchmarks. */
export interface MetricsBenchReport {
  overhead: MetricsOverheadResult;
}

/** Run all metrics benchmarks and collect a report. */
export function runMetricsBenchmarks(opts?: { ops?: number; nodes?: number }): MetricsBenchReport {
  return { overhead: benchMetricsOverhead(opts) };
}
