/**
 * ScheduleService — turns `ScheduleCommand`s into `ScheduleEvent`s for the
 * desktop sidecar, projecting the real scheduled-job engine
 * (`src/hades/schedule/store.ts`'s `JobStore` and
 * `src/hades/schedule/runner.ts`'s `SchedulerRunner`) into the wire-safe
 * `ScheduleJobView` / `ScheduleRunView` / `ScheduleStatusView`
 * (`../ipc/schedule-contract.ts`).
 *
 * This module imports ONLY types from `../ipc/schedule-contract` and
 * `../../hades/schedule/store` — no runtime import of the scheduling engine
 * anywhere. Instead it declares its own structural seam types
 * (`ScheduleJobsSource`, `ScheduleRunnerSource`, `ScheduleNextFire`) that the
 * real `JobStore` implementations (`InMemoryJobStore` / `JsonFileJobStore`),
 * `SchedulerRunner`, and `nextFireTime` already satisfy without wrapping —
 * see the doc comments on each seam below for exactly how they line up.
 *
 * `schedule.job.run` needs its `runner` seam configured to do anything: an
 * absent runner is reported as an honest `schedule.error` ("no scheduler
 * runner attached to this sidecar"), never a fabricated receipt. Every other
 * command only needs `jobs`. A THROWING seam — `jobs.list()`, `jobs.get()`,
 * `jobs.update()`, `runner.runOnce()`, or `nextFire()` — is caught and
 * reported the same way: `handle()` never rejects and never throws, and it
 * carries only `err.message` (never a stack trace) into the emitted
 * `schedule.error`.
 */

import type {
  ScheduleCommand,
  ScheduleEvent,
  ScheduleJobView,
  ScheduleRunView,
  ScheduleStatusView,
} from "../ipc/schedule-contract";
import type { JobRunRecord, ScheduledJob } from "../../hades/schedule/store";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * The subset of `JobStore` this service needs. Structural on purpose: a real
 * `InMemoryJobStore` / `JsonFileJobStore` instance (`../../hades/schedule/store.ts`)
 * already implements `list()` / `get()` / `update()` with exactly these
 * signatures — the full `JobStore` interface is a superset, so any real
 * store satisfies this seam without wrapping.
 */
export interface ScheduleJobsSource {
  list(): ScheduledJob[];
  get(id: string): ScheduledJob | undefined;
  update(
    id: string,
    patch: Partial<Omit<ScheduledJob, "id" | "createdAt" | "revision">>,
    expectedRevision?: number,
  ): ScheduledJob;
}

/**
 * The subset of `SchedulerRunner` this service needs. Structural on purpose:
 * a real `SchedulerRunner` instance's `.runOnce(jobId)` method
 * (`../../hades/schedule/runner.ts`) already returns `Promise<JobRunRecord>`,
 * having already persisted the run via `store.recordRun()` internally — this
 * service never calls `recordRun` itself, it only relays what `runOnce`
 * reports.
 */
export interface ScheduleRunnerSource {
  runOnce(jobId: string): Promise<JobRunRecord>;
}

/**
 * Computes the next fire instant strictly after `afterEpochMs`, or
 * `undefined` if none exists within the search horizon. The real
 * `nextFireTime` (`../../hades/schedule/cron.ts`), composed with `parseCron`,
 * already has this exact shape: `(cron, afterEpochMs, timeZone) =>
 * nextFireTime(parseCron(cron), afterEpochMs, timeZone)` satisfies this seam
 * with zero adapter code. May throw (an unparseable cron, an invalid IANA
 * time zone) — `ScheduleService` treats a throw exactly like `undefined`.
 */
export interface ScheduleNextFire {
  (cron: string, afterEpochMs: number, timeZone: string): number | undefined;
}

export interface ScheduleServiceOptions {
  /** A live job store. Required — every command needs it. */
  jobs: ScheduleJobsSource;
  /** A live, attached scheduler runner. Required for `schedule.job.run` to succeed. */
  runner?: ScheduleRunnerSource;
  /** Computes a job's next fire instant for `nextFireAt` projection. Required. */
  nextFire: ScheduleNextFire;
  /** ms clock, default `() => Date.now()`. Injectable for deterministic tests. */
  now?: () => number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ScheduleService {
  private readonly jobs: ScheduleJobsSource;
  private readonly runner?: ScheduleRunnerSource;
  private readonly nextFire: ScheduleNextFire;
  private readonly now: () => number;

  constructor(opts: ScheduleServiceOptions) {
    if (!opts || !opts.jobs) {
      throw new TypeError("ScheduleService: opts.jobs is required");
    }
    if (typeof opts.nextFire !== "function") {
      throw new TypeError("ScheduleService: opts.nextFire is required");
    }
    this.jobs = opts.jobs;
    this.runner = opts.runner;
    this.nextFire = opts.nextFire;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Handle one `ScheduleCommand`, resolving to the resulting `ScheduleEvent`.
   * Never rejects and never throws: any error thrown by `jobs`, `runner`, or
   * `nextFire` (outside of the per-job `nextFireAt` projection, which already
   * treats a throw as "unknown" and reports `null`) becomes a
   * `schedule.error` event instead of propagating.
   */
  async handle(cmd: ScheduleCommand): Promise<ScheduleEvent> {
    try {
      switch (cmd.kind) {
        case "schedule.status.get":
          return this.handleStatusGet();
        case "schedule.job.get":
          return this.handleJobGet(cmd.id);
        case "schedule.job.toggle":
          return this.handleJobToggle(cmd.id, cmd.enabled, cmd.revision);
        case "schedule.job.run":
          return await this.handleJobRun(cmd.id);
        default: {
          // Exhaustiveness guard: a new ScheduleCommand kind added upstream
          // without a case here fails to compile.
          const _exhaustive: never = cmd;
          return this.errorEvent(`unrecognized schedule command: ${JSON.stringify(_exhaustive)}`);
        }
      }
    } catch (err) {
      return this.errorEvent(errorMessage(err));
    }
  }

  // -------------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------------

  /**
   * Project a real `ScheduledJob` into the wire-safe `ScheduleJobView`.
   * `nextFireAt` is `null` for a disabled job, and `null` (never a guessed
   * time, never a thrown exception) when `nextFire` returns `undefined` or
   * throws for an enabled job's cron/time zone.
   */
  private toJobView(job: ScheduledJob): ScheduleJobView {
    let nextFireAt: number | null = null;
    if (job.enabled) {
      try {
        const next = this.nextFire(job.cron, this.now(), job.timeZone);
        nextFireAt = next === undefined ? null : next;
      } catch {
        nextFireAt = null;
      }
    }

    return {
      id: job.id,
      name: job.name,
      cron: job.cron,
      timeZone: job.timeZone,
      enabled: job.enabled,
      taskKind: job.task.kind,
      taskInput: job.task.input,
      delivery: job.delivery
        ? { platform: job.delivery.platform, user: job.delivery.user, channel: job.delivery.channel ?? null }
        : null,
      misfire: job.misfire,
      nextFireAt,
      lastFireAt: job.lastFireAt ?? null,
      runCount: job.runCount,
      failCount: job.failCount,
      abstainCount: job.abstainCount,
      revision: job.revision,
    };
  }

  private toRunView(run: JobRunRecord): ScheduleRunView {
    return {
      firedAt: run.firedAt,
      scheduledFor: run.scheduledFor,
      outcome: run.outcome,
      detail: run.detail,
      durationMs: run.durationMs,
    };
  }

  private errorEvent(message: string): ScheduleEvent {
    return { kind: "schedule.error", message, at: this.now() };
  }

  // -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------

  private handleStatusGet(): ScheduleEvent {
    const jobs = this.jobs.list().map((job) => this.toJobView(job));
    const status: ScheduleStatusView = {
      jobs,
      runnerAttached: this.runner !== undefined,
      at: this.now(),
    };
    return { kind: "schedule.status", status };
  }

  private handleJobGet(id: string): ScheduleEvent {
    const job = this.jobs.get(id);
    if (!job) {
      return this.errorEvent(`ScheduledJob "${id}" not found`);
    }
    return {
      kind: "schedule.job",
      job: this.toJobView(job),
      history: job.history.map((run) => this.toRunView(run)),
    };
  }

  private handleJobToggle(id: string, enabled: boolean, revision: number): ScheduleEvent {
    let updated: ScheduledJob;
    try {
      // Optimistic concurrency: `jobs.update` throws the store's real
      // "not found" / "revision conflict" message on mismatch, which
      // `errorEvent` relays verbatim — never a service-invented message.
      updated = this.jobs.update(id, { enabled }, revision);
    } catch (err) {
      return this.errorEvent(errorMessage(err));
    }
    return {
      kind: "schedule.job",
      job: this.toJobView(updated),
      history: updated.history.map((run) => this.toRunView(run)),
    };
  }

  private async handleJobRun(id: string): Promise<ScheduleEvent> {
    if (!this.runner) {
      return this.errorEvent("no scheduler runner attached to this sidecar");
    }

    let run: JobRunRecord;
    try {
      // The REAL JobRunRecord SchedulerRunner.runOnce produced (and already
      // persisted via store.recordRun internally) — never a fabricated
      // receipt.
      run = await this.runner.runOnce(id);
    } catch (err) {
      return this.errorEvent(errorMessage(err));
    }

    return {
      kind: "schedule.run.receipt",
      jobId: id,
      run: this.toRunView(run),
      at: this.now(),
    };
  }
}
