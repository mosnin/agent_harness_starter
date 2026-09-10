/**
 * The firing engine for `src/hades/schedule/**`.
 *
 * `SchedulerRunner` is the piece that actually turns a `JobStore` full of
 * `ScheduledJob` records into executed work: on every `tick()` it asks, for
 * each enabled job, "which fire instants are due?" (via `nextFireTime` from
 * `./cron`), applies the job's misfire/catch-up policy to whatever it finds,
 * runs the due instant(s) through the injected `JobExecutor`, hands a
 * successful execution to the injected `JobDeliverer` when the job has a
 * delivery target, and persists every outcome — success, failure, misfire
 * skip, or overlap skip — to the `JobStore`.
 *
 * The one invariant everything else in this file exists to protect:
 * `tick()` is a **pure function of `(store.list(), clock.now())`**. It never
 * reads `Date.now()` directly, never sleeps, and never leaves a job's
 * `lastFireAt` pointing anywhere except the `scheduledFor` of the last fire
 * instant this runner actually attempted (fired successfully, fired and
 * failed, or never touched at all). That is what makes a scheduler that
 * crashed two hours ago and just restarted behave *identically*, given the
 * same store state and the same `now()`, to one replaying that same gap in
 * a deterministic test with `ManualClock` — there is no hidden runner-local
 * state (beyond the in-flight overlap guard, which is itself reset on every
 * fresh construction) for a restart to lose.
 *
 * ## Misfire / catch-up policy (locked semantics)
 *
 * Every tick, per enabled job, "due" means every fire instant strictly
 * after `job.lastFireAt ?? job.createdAt` and `<= clock.now()`, found by
 * iterating `nextFireTime`. Zero due instants: the job is left completely
 * untouched (no store write at all). Exactly one: fired normally, no
 * misfire bookkeeping. More than one — the job missed fires while this
 * runner (or the whole process) wasn't ticking — and `job.misfire` decides
 * what happens to the backlog:
 *
 *  - `"skip"`      — none of the missed instants run; only the single
 *                    latest one fires. The rest are reported in
 *                    `misfiresSkipped`, never executed, never retried.
 *  - `"fire-once"` — exactly one execution runs, for the latest missed
 *                    instant, with the run's `detail` recording how many
 *                    instants were coalesced into it.
 *  - `"catch-up"`  — instants fire oldest-first, but hard-capped at
 *                    `job.catchUpLimit` executions in a single tick. Any
 *                    remainder is reported in `misfiresSkipped` (never
 *                    silently dropped) and, because `lastFireAt` only
 *                    advances to the *last fired* instant, is picked up by
 *                    a later tick — spreading a large backlog across
 *                    several ticks rather than firing an unbounded storm
 *                    in one.
 *
 * ## Overlap protection
 *
 * Each job has a per-runner in-flight guard. If a due tick finds a job
 * whose previous firing (executor + deliverer) hasn't resolved yet, nothing
 * new fires for it this tick: the skip is reported in `overlapsSkipped` and
 * recorded as a `"skipped"` run with detail `"overlap"`. Crucially,
 * `lastFireAt` is *not* advanced by an overlap skip (the store's own
 * `recordRun` unconditionally sets `lastFireAt = firedAt`, so this runner
 * explicitly restores it afterward) — nothing actually ran, so the next
 * tick, once the guard clears, sees the very same backlog and resolves it
 * through the ordinary misfire-policy path above.
 *
 * ## Failure containment
 *
 * `tick()` never throws for a per-job failure. An `executor.execute()`
 * throw, a `deliverer.deliver()` throw, and a `store.recordRun()` /
 * `store.update()` throw (a hostile store) are all caught individually,
 * surfaced in `TickReport.errors`, and — for the executor/deliverer case —
 * recorded as a `"failed"` run so a permanently-broken job fails loudly on
 * every tick instead of being retried forever. A job whose `cron` no longer
 * parses (e.g. a store file tampered with on disk) is likewise reported as
 * an error and skipped, never crashing the tick for every other job.
 */

import { nextFireTime, parseCron } from "./cron";
import type { CronSchedule } from "./cron";
import type { Clock } from "./clock";
import type { JobRunRecord, JobStore, MisfirePolicy, RunOutcome, ScheduledJob } from "./store";
// Type-only: `./delivery` is owned by the delivery-channel workstream. No
// runtime dependency is taken on it — only its published types.
import type { DeliveryReceipt, JobDeliverer } from "./delivery";

// ===========================================================================
// Locked public types
// ===========================================================================

export interface JobExecutionContext {
  scheduledFor: number;
  firedAt: number;
  manual: boolean;
}

export interface JobExecutionResult {
  ok: boolean;
  output: string;
  detail?: string;
  verification?: {
    decision?: import("../styx/gate").GateDecision;
    certificate?: import("../styx/certificate").VerificationCertificate;
  };
}

export interface JobExecutor {
  execute(job: ScheduledJob, ctx: JobExecutionContext): Promise<JobExecutionResult>;
}

export type SchedulerEvent = {
  kind: "fired" | "misfire-skipped" | "overlap-skipped" | "executor-error" | "delivery";
  jobId: string;
  at: number;
  detail: string;
};

export interface SchedulerRunnerOptions {
  store: JobStore;
  clock: Clock;
  executor: JobExecutor;
  deliverer: JobDeliverer;
  onEvent?: (e: SchedulerEvent) => void;
}

export interface TickReport {
  at: number;
  evaluated: number;
  fired: { jobId: string; scheduledFor: number; outcome: string }[];
  misfiresSkipped: { jobId: string; missed: number }[];
  overlapsSkipped: string[];
  errors: { jobId: string; message: string }[];
}

// ===========================================================================
// Small pure helpers
// ===========================================================================

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every fire instant strictly after `baseline` and `<= horizon`, oldest
 * first, found by repeated `nextFireTime` iteration. A finite safety cap
 * (not one of the locked policy caps — those are `job.catchUpLimit`,
 * applied afterward by `resolveMisfire`) guards against a pathological
 * store record (e.g. a `lastFireAt` tampered to sit decades in the past)
 * turning a single tick into an unbounded loop; hitting it is not a normal
 * outcome for any of this module's real call sites.
 */
function computeDueInstants(
  schedule: CronSchedule,
  baseline: number,
  horizon: number,
  timeZone: string,
): number[] {
  const SAFETY_CAP = 100_000;
  const instants: number[] = [];
  let cursor = baseline;
  while (instants.length < SAFETY_CAP) {
    const next = nextFireTime(schedule, cursor, timeZone);
    if (next === undefined || next > horizon) break;
    instants.push(next);
    cursor = next;
  }
  return instants;
}

interface MisfireResolution {
  /** Instants to actually fire this tick, oldest-first. */
  instantsToFire: number[];
  /** Present only when the backlog required applying misfire policy. */
  misfireReport?: { missed: number; detail: string };
  /** Appended to the single fired run's detail under "fire-once" only. */
  extraDetailSuffix?: string;
}

function resolveMisfire(policy: MisfirePolicy, due: number[], catchUpLimitRaw: number): MisfireResolution {
  if (due.length <= 1) {
    return { instantsToFire: due.slice() };
  }

  const latest = due[due.length - 1];

  switch (policy) {
    case "skip": {
      const missed = due.length - 1;
      return {
        instantsToFire: [latest],
        misfireReport: {
          missed,
          detail: `misfire policy "skip": ${missed} missed fire(s) dropped, firing only the latest (scheduledFor=${latest})`,
        },
      };
    }
    case "fire-once": {
      const missed = due.length - 1;
      return {
        instantsToFire: [latest],
        misfireReport: {
          missed,
          detail: `misfire policy "fire-once": coalescing ${due.length} missed fire(s) into a single execution (scheduledFor=${latest})`,
        },
        extraDetailSuffix: ` (coalesced ${due.length} missed fires)`,
      };
    }
    case "catch-up": {
      const limit = Number.isInteger(catchUpLimitRaw) && catchUpLimitRaw >= 0 ? catchUpLimitRaw : 0;
      const firing = due.slice(0, limit);
      const overflow = due.length - firing.length;
      if (overflow > 0) {
        return {
          instantsToFire: firing,
          misfireReport: {
            missed: overflow,
            detail: `misfire policy "catch-up": firing ${firing.length} of ${due.length} missed fire(s) this tick (limit ${limit}), ${overflow} remaining for a future tick`,
          },
        };
      }
      return { instantsToFire: firing };
    }
    default: {
      // Defensive only: a store record tampered with on disk could carry an
      // unrecognized misfire value. Never crash the tick over it — fall
      // back to the most conservative policy ("skip") and say so honestly.
      const missed = due.length - 1;
      return {
        instantsToFire: [latest],
        misfireReport: {
          missed,
          detail: `unrecognized misfire policy ${JSON.stringify(policy)}; applied "skip" semantics, ${missed} missed fire(s) dropped`,
        },
      };
    }
  }
}

const DEFAULT_POLL_MS = 15_000;

// ===========================================================================
// SchedulerRunner
// ===========================================================================

export class SchedulerRunner {
  private readonly store: JobStore;
  private readonly clock: Clock;
  private readonly executor: JobExecutor;
  private readonly deliverer: JobDeliverer;
  private readonly onEvent?: (e: SchedulerEvent) => void;

  /** Per-job overlap guard: a job id present here has a firing in flight. */
  private readonly inFlight = new Set<string>();

  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private isRunning = false;

  constructor(opts: SchedulerRunnerOptions) {
    this.store = opts.store;
    this.clock = opts.clock;
    this.executor = opts.executor;
    this.deliverer = opts.deliverer;
    this.onEvent = opts.onEvent;
  }

  running(): boolean {
    return this.isRunning;
  }

  private emit(event: SchedulerEvent): void {
    if (this.onEvent) this.onEvent(event);
  }

  /**
   * Evaluate every enabled job in the store exactly once against
   * `clock.now()` and fire whatever is due. Never throws for a per-job
   * failure — see the module doc comment for the full failure-containment
   * contract.
   */
  async tick(): Promise<TickReport> {
    const at = this.clock.now();
    const report: TickReport = {
      at,
      evaluated: 0,
      fired: [],
      misfiresSkipped: [],
      overlapsSkipped: [],
      errors: [],
    };

    for (const job of this.store.list()) {
      await this.processJob(job, at, report);
    }

    return report;
  }

  /**
   * Fire a single job immediately, bypassing its schedule and `enabled`
   * flag entirely — `ctx.manual` is `true` and `scheduledFor === firedAt ===
   * clock.now()`. Unlike `tick()`, an unknown job id is a caller error and
   * throws. Runs the same executor -> deliverer -> store.recordRun pipeline
   * as a normal tick fire, but is not subject to the overlap guard (a
   * manual run is explicit operator intent, not schedule-driven).
   */
  async runOnce(jobId: string): Promise<JobRunRecord> {
    const job = this.store.get(jobId);
    if (!job) {
      throw new Error(`SchedulerRunner.runOnce: unknown job id "${jobId}"`);
    }

    const now = this.clock.now();
    const ctx: JobExecutionContext = { scheduledFor: now, firedAt: now, manual: true };
    const t0 = this.clock.now();

    let run: JobRunRecord;
    try {
      const result = await this.executor.execute(job, ctx);

      let outcome: RunOutcome;
      let detail: string;

      if (job.delivery) {
        const receipt = await this.deliverer.deliver(job, result, ctx);
        outcome = receipt.outcome as RunOutcome;
        detail = receipt.detail ?? "";
      } else if (result.ok) {
        outcome = "delivered";
        detail = "no delivery target — result stored only";
      } else {
        outcome = "failed";
        detail = result.detail ?? `executor reported failure: ${result.output}`;
      }

      run = {
        firedAt: now,
        scheduledFor: now,
        outcome,
        detail,
        durationMs: Math.max(0, this.clock.now() - t0),
      };
    } catch (err) {
      run = {
        firedAt: now,
        scheduledFor: now,
        outcome: "failed",
        detail: errorMessage(err),
        durationMs: Math.max(0, this.clock.now() - t0),
      };
    }

    this.store.recordRun(jobId, run);
    return run;
  }

  /**
   * Production convenience: an unref'd `setTimeout` chain that awaits
   * `tick()` then re-arms itself every `pollMs` (default 15s). Never used
   * by this module's own tests — every test drives `tick()` directly with a
   * `ManualClock` so the firing logic stays provably deterministic. Calling
   * `start()` while already running is a no-op.
   */
  start(pollMs: number = DEFAULT_POLL_MS): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const schedule = (): void => {
      if (!this.isRunning) return;
      this.pollTimer = setTimeout(() => {
        void this.tick().finally(schedule);
      }, pollMs);
      this.pollTimer.unref?.();
    };
    schedule();
  }

  /** Stop the poll loop started by `start()`. Idempotent. */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async processJob(job: ScheduledJob, at: number, report: TickReport): Promise<void> {
    if (!job.enabled) return;

    let schedule: CronSchedule;
    try {
      schedule = parseCron(job.cron);
    } catch (err) {
      report.errors.push({ jobId: job.id, message: `unparseable cron "${job.cron}": ${errorMessage(err)}` });
      return;
    }

    const baseline = job.lastFireAt ?? job.createdAt;

    let due: number[];
    try {
      due = computeDueInstants(schedule, baseline, at, job.timeZone);
    } catch (err) {
      report.errors.push({ jobId: job.id, message: `failed to compute due fire times: ${errorMessage(err)}` });
      return;
    }

    report.evaluated += 1;
    if (due.length === 0) return;

    if (this.inFlight.has(job.id)) {
      report.overlapsSkipped.push(job.id);
      const scheduledFor = due[due.length - 1];
      const detail = `previous execution still in flight; skipped ${due.length} due fire(s)`;
      this.emit({ kind: "overlap-skipped", jobId: job.id, at, detail });
      this.safeRecordRun(job.id, { firedAt: at, scheduledFor, outcome: "skipped", detail: "overlap", durationMs: 0 }, report);
      // Nothing actually fired: undo the store's default
      // lastFireAt-from-firedAt bump so the backlog is not lost.
      this.safeSetLastFireAt(job.id, job.lastFireAt, report);
      return;
    }

    const { instantsToFire, misfireReport, extraDetailSuffix } = resolveMisfire(job.misfire, due, job.catchUpLimit);

    if (misfireReport) {
      report.misfiresSkipped.push({ jobId: job.id, missed: misfireReport.missed });
      this.emit({ kind: "misfire-skipped", jobId: job.id, at, detail: misfireReport.detail });
    }

    if (instantsToFire.length === 0) return;

    this.inFlight.add(job.id);
    try {
      let lastAttempted: number | undefined;
      for (const scheduledFor of instantsToFire) {
        await this.fireOne(job, scheduledFor, at, report, extraDetailSuffix);
        lastAttempted = scheduledFor;
      }
      if (lastAttempted !== undefined) {
        this.safeSetLastFireAt(job.id, lastAttempted, report);
      }
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  private async fireOne(
    job: ScheduledJob,
    scheduledFor: number,
    at: number,
    report: TickReport,
    extraDetailSuffix: string | undefined,
  ): Promise<void> {
    const ctx: JobExecutionContext = { scheduledFor, firedAt: at, manual: false };
    const t0 = this.clock.now();

    let result: JobExecutionResult;
    try {
      result = await this.executor.execute(job, ctx);
    } catch (err) {
      const message = errorMessage(err);
      report.errors.push({ jobId: job.id, message });
      report.fired.push({ jobId: job.id, scheduledFor, outcome: "failed" });
      this.emit({ kind: "executor-error", jobId: job.id, at, detail: message });
      this.safeRecordRun(
        job.id,
        { firedAt: at, scheduledFor, outcome: "failed", detail: message, durationMs: Math.max(0, this.clock.now() - t0) },
        report,
      );
      return;
    }

    this.emit({
      kind: "fired",
      jobId: job.id,
      at,
      detail: result.ok ? (result.detail ?? result.output) : `executor reported failure: ${result.detail ?? result.output}`,
    });

    let outcome: RunOutcome;
    let detail: string;

    if (job.delivery) {
      let receipt: DeliveryReceipt;
      try {
        receipt = await this.deliverer.deliver(job, result, ctx);
      } catch (err) {
        const message = errorMessage(err);
        report.errors.push({ jobId: job.id, message });
        report.fired.push({ jobId: job.id, scheduledFor, outcome: "failed" });
        this.emit({ kind: "executor-error", jobId: job.id, at, detail: `delivery failed: ${message}` });
        this.safeRecordRun(
          job.id,
          {
            firedAt: at,
            scheduledFor,
            outcome: "failed",
            detail: `delivery failed: ${message}`,
            durationMs: Math.max(0, this.clock.now() - t0),
          },
          report,
        );
        return;
      }
      outcome = receipt.outcome as RunOutcome;
      detail = receipt.detail ?? "";
      this.emit({ kind: "delivery", jobId: job.id, at, detail: `delivered via ${job.delivery.platform}: ${detail}` });
    } else if (result.ok) {
      outcome = "delivered";
      detail = "no delivery target — result stored only";
    } else {
      outcome = "failed";
      detail = result.detail ?? `executor reported failure: ${result.output}`;
    }

    if (extraDetailSuffix) detail = `${detail}${extraDetailSuffix}`;

    report.fired.push({ jobId: job.id, scheduledFor, outcome });
    this.safeRecordRun(
      job.id,
      { firedAt: at, scheduledFor, outcome, detail, durationMs: Math.max(0, this.clock.now() - t0) },
      report,
    );
  }

  private safeRecordRun(jobId: string, run: JobRunRecord, report: TickReport): void {
    try {
      this.store.recordRun(jobId, run);
    } catch (err) {
      report.errors.push({ jobId, message: `store.recordRun failed: ${errorMessage(err)}` });
    }
  }

  private safeSetLastFireAt(jobId: string, lastFireAt: number | undefined, report: TickReport): void {
    try {
      this.store.update(jobId, { lastFireAt });
    } catch (err) {
      report.errors.push({ jobId, message: `store.update(lastFireAt) failed: ${errorMessage(err)}` });
    }
  }
}
