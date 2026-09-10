export interface ThroughputSummary {
  count: number;
  wallMs: number;
  throughputPerSec: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/**
 * Summarize a batch of latency samples into throughput + percentile stats. Pure
 * and dependency-free so a load-test script can report consistent numbers and
 * the math stays unit-testable. `wallMs` is the total elapsed time for the batch
 * (which may be less than the sum of samples when they run concurrently).
 */
export function summarizeLatencies(sampleMs: number[], wallMs: number): ThroughputSummary {
  const n = sampleMs.length;
  if (n === 0) {
    return { count: 0, wallMs, throughputPerSec: 0, meanMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const sorted = [...sampleMs].sort((a, b) => a - b);
  const sum = sorted.reduce((s, x) => s + x, 0);
  return {
    count: n,
    wallMs,
    throughputPerSec: wallMs > 0 ? (n / wallMs) * 1000 : 0,
    meanMs: sum / n,
    minMs: sorted[0],
    maxMs: sorted[n - 1],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
  };
}

/** Nearest-rank percentile of a pre-sorted array. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(Math.min(1, Math.max(0, q)) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

/** Format a summary as a compact human-readable line. */
export function formatSummary(s: ThroughputSummary): string {
  return (
    `${s.count} goals in ${s.wallMs}ms · ${s.throughputPerSec.toFixed(2)}/s · ` +
    `mean ${s.meanMs.toFixed(0)}ms · p50 ${s.p50Ms}ms · p95 ${s.p95Ms}ms · p99 ${s.p99Ms}ms`
  );
}
