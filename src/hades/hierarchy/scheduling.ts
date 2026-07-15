/**
 * Priority + deadline scheduling for hierarchy subtasks. A swarm coordinator
 * rarely has the budget to run every subtask it decomposed — so it must run the
 * ones that matter first and *shed* the ones that are already too late. This
 * scheduler dispatches jobs highest-priority-first (ties broken by earliest
 * deadline, then id), and at the instant a job would be dispatched it checks the
 * injectable clock: if the job's deadline has already passed, the job is
 * cancelled instead of run. That way a coordinator honors priorities and never
 * burns compute on work whose window has closed. Deadlines propagate down the
 * tree via {@link propagateDeadline} so a child can never outlive its parent's
 * budget. Everything is clock-injectable and deterministic.
 */

export interface Job<T> {
  id: string;
  task: T;
  /** Higher runs first. Default 0. */
  priority?: number;
  /** Absolute deadline in ms (same clock as `now`). Cancelled if now() >= deadline at dispatch. */
  deadline?: number;
}

export type SchedEventType = "dispatch" | "complete" | "cancel-deadline";

export interface SchedEvent {
  type: SchedEventType;
  id: string;
  at: number;
}

export interface SchedulerOptions {
  now?: () => number;
  onEvent?: (e: SchedEvent) => void;
}

export interface ScheduleResult<R> {
  completed: Array<{ id: string; result: R }>;
  /** Ids skipped because their deadline had passed. */
  cancelled: string[];
  /**
   * Every job in priority-ranked order (priority-desc, then EDF, then id) — the
   * order jobs were *considered* for dispatch. A job that was later cancelled
   * still appears in its ranked position, so this is the full schedule, not only
   * the dispatched subset (intersect with `completed`/`cancelled` to filter).
   */
  order: string[];
}

/**
 * The effective deadline of a child = the earliest (min) of the parent's and the
 * child's own. `undefined` on either side means "no constraint from that side".
 * If neither is defined the result is `undefined` (no deadline).
 */
export function propagateDeadline(
  parent: number | undefined,
  child: number | undefined
): number | undefined {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  return Math.min(parent, child);
}

/**
 * Total ordering used for dispatch: priority descending, then earliest deadline
 * (EDF) with an undefined deadline sorting last, then id ascending so the order
 * is fully deterministic regardless of input order.
 */
function compareJobs<T>(a: Job<T>, b: Job<T>): number {
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pb - pa; // higher priority first

  const da = a.deadline;
  const db = b.deadline;
  if (da !== db) {
    if (da === undefined) return 1; // undefined deadline sorts last
    if (db === undefined) return -1;
    return da - db; // earlier deadline first
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class PriorityScheduler<T, R> {
  private readonly now: () => number;
  private readonly onEvent?: (e: SchedEvent) => void;

  constructor(
    private readonly exec: (task: T, job: Job<T>) => Promise<R>,
    opts: SchedulerOptions = {}
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  private emit(type: SchedEventType, id: string): void {
    this.onEvent?.({ type, id, at: this.now() });
  }

  async run(
    jobs: Array<Job<T>>,
    opts: { concurrency?: number } = {}
  ): Promise<ScheduleResult<R>> {
    const ordered = [...jobs].sort(compareJobs);
    const order = ordered.map((j) => j.id);

    const completed: Array<{ id: string; result: R }> = [];
    const cancelled: string[] = [];

    const concurrency = Math.max(1, opts.concurrency ?? 1);

    // Shared cursor: every worker pulls the next job in sorted order, so even a
    // parallel pool dispatches in strict priority/EDF sequence.
    let cursor = 0;
    const pull = (): Job<T> | undefined => (cursor < ordered.length ? ordered[cursor++] : undefined);

    const worker = async (): Promise<void> => {
      for (;;) {
        const job = pull();
        if (job === undefined) return;

        // Deadline check at the moment of dispatch — a job dispatched earlier in
        // this same run may have advanced the clock past this job's deadline.
        if (job.deadline != null && this.now() >= job.deadline) {
          cancelled.push(job.id);
          this.emit("cancel-deadline", job.id);
          continue;
        }

        this.emit("dispatch", job.id);
        const result = await this.exec(job.task, job);
        completed.push({ id: job.id, result });
        this.emit("complete", job.id);
      }
    };

    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    return { completed, cancelled, order };
  }
}
