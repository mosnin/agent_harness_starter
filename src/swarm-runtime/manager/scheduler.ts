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

/** Clamp demand to the autoscale envelope. */
export function desiredWorkers(demand: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.max(demand, 0)));
}

/**
 * Demand = worker-slots the goal's live tasks want right now. A consensus task
 * wants `replicas` slots; every other pending-or-in-flight task wants one.
 */
export function computeDemand(tasks: WorkerTask[], isVerified: (id: string) => boolean): number {
  let demand = 0;
  for (const t of tasks) {
    const wants = t.consensus?.replicas ?? 1;
    if (t.status === "pending" && isReady(t, isVerified)) demand += wants;
    else if (t.status === "dispatched" || t.status === "reported") demand += wants;
  }
  return demand;
}
