/**
 * Flat manager -> worker orchestrator: the honest baseline for the swarm hierarchy.
 *
 * WHY THIS IS A FAIR BASELINE
 * ---------------------------
 * When we claim the swarm *hierarchy* is faster / cheaper than a naive orchestrator, the
 * comparison is only meaningful if the baseline is a REASONABLE naive design rather than a
 * rigged strawman. This class is that baseline. It deliberately keeps everything a competent
 * engineer would keep when writing a first, un-optimized manager:
 *
 *  1. REAL PARALLELISM. The single manager fans out all sub-tasks and the workers run
 *     CONCURRENTLY via `Promise.all` — never serially. If we compared a parallel hierarchy
 *     against a serial baseline, any speedup would be an artifact of serial-vs-parallel, not of
 *     the architecture. By preserving parallelism, the comparison isolates the thing we actually
 *     want to measure: routing + aggregation *topology*.
 *
 *  2. HONEST AGGREGATION. The flat design has exactly one fan-out level and a single manager that
 *     combines every worker result itself, in one serial `combine` pass. That is a genuine and
 *     characteristic property of a flat topology (no tree of partial reducers), not an artificial
 *     handicap — so we model it faithfully.
 *
 * THE ONE ARCHITECTURAL DISADVANTAGE
 * ----------------------------------
 * The manager holds its workers in a plain array (the "roster") and, lacking an index/map from
 * worker id to slot, it locates worker `w{i}` by a LINEAR SCAN from the front of the roster. This
 * is exactly what a toy orchestrator without indexed routing genuinely does: "walk the list until
 * you find the worker with this id." Routing worker `i` therefore costs `i + 1` comparisons, and
 * routing all N workers costs `1 + 2 + ... + N === N*(N+1)/2` scan steps — an O(N^2) routing cost.
 * The hierarchy avoids this via indexed / structural routing. That un-indexed scan is the single,
 * realistic naive choice this baseline exists to expose. Everything else is kept fair.
 *
 * The class is pure and deterministic: it never reads the wall clock (`Date.now`) or `Math.random`,
 * so its stats are a reproducible function of `workerCount`, the sub-task split, and completion
 * behavior of the supplied `execute`.
 */

/**
 * The pluggable strategy a caller supplies to describe how a root task is split across workers,
 * how a single worker runs its slice, and how the manager recombines the results.
 */
export interface FlatExec<T, R> {
  /** Manager splits the root task into exactly `workerCount` sub-tasks (one per worker). */
  split: (task: T, workerCount: number) => T[];
  /** A worker runs its sub-task. */
  execute: (task: T, workerIndex: number) => Promise<R>;
  /** Manager combines ALL worker results into the final result (serial, at the single manager). */
  combine: (results: R[], task: T) => R;
}

/** Observability counters produced by a single `run`. */
export interface FlatRunStats {
  workerRuns: number;
  /** Total linear-scan steps the manager spent locating workers by id (models un-indexed O(N) routing). */
  routeScans: number;
  /** Peak workers executing concurrently (should equal workerCount — flat has one fan-out level). */
  peakConcurrency: number;
}

/**
 * A naive flat orchestrator: one manager, `workerCount` sibling workers, un-indexed linear-scan
 * routing, real concurrent execution, and a single serial combine at the manager.
 */
export class FlatOrchestrator<T, R> {
  private readonly _workerCount: number;
  private readonly exec: FlatExec<T, R>;
  /** The roster: worker ids `w0..w{n-1}` held in a plain array with no id->slot index. */
  private readonly roster: string[];

  constructor(workerCount: number, exec: FlatExec<T, R>) {
    if (workerCount < 1) {
      throw new RangeError(
        `FlatOrchestrator requires workerCount >= 1, got ${workerCount}`,
      );
    }
    this._workerCount = workerCount;
    this.exec = exec;
    this.roster = [];
    for (let i = 0; i < workerCount; i++) {
      this.roster.push(`w${i}`);
    }
  }

  /** The number of workers this manager was constructed with. */
  workerCount(): number {
    return this._workerCount;
  }

  /**
   * Locate `targetId` in the roster by a linear scan from the front, returning the number of
   * elements examined (== index + 1 on a hit). This is the load-bearing O(N) routing primitive:
   * because the roster is un-indexed, the manager cannot do better than a walk.
   */
  private scanFor(targetId: string): number {
    let steps = 0;
    for (let i = 0; i < this.roster.length; i++) {
      steps++;
      if (this.roster[i] === targetId) {
        return steps;
      }
    }
    return steps;
  }

  run(rootTask: T): Promise<{ result: R; stats: FlatRunStats }> {
    const subTasks = this.exec.split(rootTask, this._workerCount);

    // Only dispatch sub-tasks that exist; ignore any beyond workerCount.
    const dispatchCount = Math.min(subTasks.length, this._workerCount);

    let routeScans = 0;
    let liveConcurrency = 0;
    let peakConcurrency = 0;

    // Slot-indexed result buffer so `combine` always receives results in worker-index order,
    // regardless of which worker settles first.
    const results = new Array<R>(dispatchCount);

    const pending: Array<Promise<void>> = [];

    for (let i = 0; i < dispatchCount; i++) {
      // ROUTE: un-indexed linear scan to find worker `w{i}` in the roster.
      // Routing worker i from the front costs (i + 1) scans -> total N*(N+1)/2.
      routeScans += this.scanFor(`w${i}`);

      const subTask = subTasks[i];
      const workerIndex = i;

      // DISPATCH: start the worker now so all dispatched workers run concurrently.
      liveConcurrency++;
      if (liveConcurrency > peakConcurrency) {
        peakConcurrency = liveConcurrency;
      }

      const p = this.exec
        .execute(subTask, workerIndex)
        .then((r) => {
          results[workerIndex] = r;
        })
        .finally(() => {
          liveConcurrency--;
        });

      pending.push(p);
    }

    return Promise.all(pending).then(() => {
      // Single serial aggregation at the one manager.
      const result = this.exec.combine(results, rootTask);
      const stats: FlatRunStats = {
        workerRuns: dispatchCount,
        routeScans,
        peakConcurrency,
      };
      return { result, stats };
    });
  }
}
