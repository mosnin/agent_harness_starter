/**
 * Benchmark harness — measures the things a "beats Hermes on benchmarks" claim
 * rests on: throughput, latency percentiles, A2A round-trip, and spawn time. The
 * clock is injectable so results are deterministic in tests; in production it's
 * real wall-clock (`performance.now`/`Date.now`).
 */

export interface BenchStats {
  count: number;
  totalMs: number;
  meanMs: number;
  opsPerSec: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/** Summarize a set of per-op durations into throughput + latency stats. Pure. */
export function summarize(durations: number[]): BenchStats {
  const count = durations.length;
  if (count === 0) return { count: 0, totalMs: 0, meanMs: 0, opsPerSec: 0, p50: 0, p95: 0, min: 0, max: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const totalMs = durations.reduce((a, b) => a + b, 0);
  const meanMs = totalMs / count;
  return {
    count,
    totalMs,
    meanMs,
    opsPerSec: meanMs > 0 ? 1000 / meanMs : Infinity,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * Time `iterations` runs of `fn`, recording each op's duration, and summarize.
 * `now` is called twice per op (before/after), so an injected sequence makes the
 * measurement deterministic.
 */
export async function measure(
  fn: (i: number) => Promise<void> | void,
  iterations: number,
  now: () => number = () => Date.now()
): Promise<BenchStats> {
  const durations: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = now();
    await fn(i);
    durations.push(now() - t0);
  }
  return summarize(durations);
}

export interface BenchResult {
  name: string;
  stats: BenchStats;
}

/** Runs a set of named benchmarks and collects a comparable report. */
export class BenchSuite {
  private results: BenchResult[] = [];
  constructor(private readonly now: () => number = () => Date.now()) {}

  async run(name: string, fn: (i: number) => Promise<void> | void, iterations: number): Promise<BenchStats> {
    const stats = await measure(fn, iterations, this.now);
    this.results.push({ name, stats });
    return stats;
  }

  report(): BenchResult[] {
    return [...this.results];
  }

  /** Render a compact text table (for the CLI / docs). */
  table(): string {
    const rows = this.results.map(
      (r) =>
        `${r.name.padEnd(24)} ${r.stats.count.toString().padStart(6)}  ${r.stats.meanMs.toFixed(2).padStart(8)}ms  ` +
        `${r.stats.p95.toFixed(2).padStart(8)}ms  ${Math.round(r.stats.opsPerSec).toString().padStart(8)}/s`
    );
    return ["name                       iters      mean       p95       thpt", ...rows].join("\n");
  }
}
