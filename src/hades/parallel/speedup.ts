export interface SpeedupModel {
  agents: number;
  /** Serial makespan = sum of task costs. */
  serialMs: number;
  /** Parallel makespan under greedy list-scheduling across `agents`. */
  parallelMs: number;
  /** serialMs / parallelMs (≥1 means faster). */
  speedup: number;
  /** speedup / agents (1.0 = perfect scaling). */
  efficiency: number;
}

/**
 * Model the speedup of running `costs` (per-task durations) across `agents`
 * using greedy list-scheduling — each task goes to the earliest-free agent. This
 * predicts the wall-clock a fan-out achieves and yields `speedup` and
 * `efficiency` deterministically (no flaky timers), which is exactly what a
 * "parallel in a fraction of the time" claim needs to be measured against.
 */
export function modelSpeedup(costs: number[], agents: number): SpeedupModel {
  if (agents < 1) throw new Error("need at least one agent");
  const serialMs = costs.reduce((a, c) => a + Math.max(0, c), 0);
  const freeAt = new Array<number>(agents).fill(0);
  for (const cost of costs) {
    let min = 0;
    for (let i = 1; i < agents; i++) if (freeAt[i] < freeAt[min]) min = i;
    freeAt[min] += Math.max(0, cost);
  }
  const parallelMs = Math.max(0, ...freeAt);
  const speedup = parallelMs === 0 ? 1 : serialMs / parallelMs;
  return { agents, serialMs, parallelMs, speedup, efficiency: speedup / agents };
}

export interface Timed<T> {
  value: T;
  elapsedMs: number;
}

/** Measure an async op's wall-clock with an injectable clock (test-friendly). */
export async function timed<T>(fn: () => Promise<T>, now: () => number = () => Date.now()): Promise<Timed<T>> {
  const start = now();
  const value = await fn();
  return { value, elapsedMs: now() - start };
}

export interface SpeedupReport {
  serialMs: number;
  parallelMs: number;
  speedup: number;
  efficiency: number;
  agents: number;
}

/**
 * Run the same workload serially and in parallel and report the measured
 * speedup. The clock is injectable so the ratio is deterministic in tests; in
 * production it's real wall-clock.
 */
export async function benchmarkSpeedup(opts: {
  agents: number;
  serial: () => Promise<unknown>;
  parallel: () => Promise<unknown>;
  now?: () => number;
}): Promise<SpeedupReport> {
  const now = opts.now ?? (() => Date.now());
  const s = await timed(opts.serial, now);
  const p = await timed(opts.parallel, now);
  const speedup = p.elapsedMs === 0 ? 1 : s.elapsedMs / p.elapsedMs;
  return {
    agents: opts.agents,
    serialMs: s.elapsedMs,
    parallelMs: p.elapsedMs,
    speedup,
    efficiency: speedup / opts.agents,
  };
}
