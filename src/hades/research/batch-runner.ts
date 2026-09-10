import type { GoalTrajectory } from "./recorder";
import type { InMemoryTrajectoryStore } from "./recorder";

/**
 * Drives one goal to a recorded trajectory. The caller wires this to the real
 * swarm + a {@link TrajectoryRecorder}; the batch runner just orchestrates many
 * of them. May throw — the runner isolates the failure.
 */
export type GoalRunner = (objective: string, index: number) => Promise<GoalTrajectory>;

export interface BatchOptions {
  /** Max goals in flight at once. Default 4. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  onError?: (objective: string, error: Error, index: number) => void;
  /** Store to append each completed trajectory to. */
  store?: InMemoryTrajectoryStore;
}

export interface BatchFailure {
  objective: string;
  index: number;
  error: string;
}

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  trajectories: GoalTrajectory[];
  failures: BatchFailure[];
}

/**
 * Batch trajectory generation — drive a list of objectives through the swarm to
 * build a training dataset. Runs with bounded concurrency, isolates a failed
 * goal (recorded in `failures`, never aborting the batch), reports progress, and
 * accumulates successful trajectories (optionally into a store). Results are
 * returned in the input order regardless of completion order.
 */
export class BatchTrajectoryRunner {
  constructor(
    private readonly runGoal: GoalRunner,
    private readonly opts: BatchOptions = {}
  ) {}

  async run(objectives: string[]): Promise<BatchSummary> {
    const concurrency = Math.max(1, this.opts.concurrency ?? 4);
    const results = new Array<GoalTrajectory | undefined>(objectives.length);
    const failures: BatchFailure[] = [];
    let done = 0;
    let next = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = next++;
        if (index >= objectives.length) return;
        const objective = objectives[index];
        try {
          const trajectory = await this.runGoal(objective, index);
          results[index] = trajectory;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          failures.push({ objective, index, error: error.message });
          this.opts.onError?.(objective, error, index);
        } finally {
          done++;
          this.opts.onProgress?.(done, objectives.length);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, objectives.length) }, () => worker()));

    const trajectories = results.filter((t): t is GoalTrajectory => t !== undefined);
    if (this.opts.store && trajectories.length) this.opts.store.addAll(trajectories);

    return {
      total: objectives.length,
      succeeded: trajectories.length,
      failed: failures.length,
      trajectories,
      failures: failures.sort((a, b) => a.index - b.index),
    };
  }
}
