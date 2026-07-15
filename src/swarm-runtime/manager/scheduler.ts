import type { WorkerTask } from "../types";

/**
 * Pure DAG-scheduling helpers, split out from the manager so the ordering and
 * backpressure logic is unit-testable in isolation.
 *
 * The manager owns *when* to call these (after a plan, a verification, or a
 * rejection); these functions decide *which* ready tasks to release next.
 */

/** A task is a dispatch candidate when it's pending and every dependency is verified. */
export function isReady(task: WorkerTask, isVerified: (id: string) => boolean): boolean {
  return task.status === "pending" && task.dependsOn.every(isVerified);
}

/** Higher priority first; ties broken by earlier creation (FIFO fairness). */
export function orderByPriority(tasks: WorkerTask[]): WorkerTask[] {
  return [...tasks].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
}

/**
 * Choose the subset of ready candidates to dispatch now, honoring a max
 * in-flight budget (backpressure). Returns them in priority order so that when
 * capacity is scarce, the most urgent work goes first.
 */
export function scheduleReady(params: {
  candidates: WorkerTask[];
  inFlight: number;
  maxInFlight: number;
}): WorkerTask[] {
  const capacity = Math.max(0, params.maxInFlight - params.inFlight);
  if (capacity === 0) return [];
  return orderByPriority(params.candidates).slice(0, capacity);
}
