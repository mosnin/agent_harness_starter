/**
 * pane-snapshot.ts — the zero-adapter bridge between the real scheduling
 * engine (`JobStore`, the cron engine, `Clock`) and the pure SCHEDULE pane
 * (`src/swarm-runtime/tui/schedule-pane.ts`).
 *
 * `buildSchedulePaneSnapshot()` reads the store's current `ScheduledJob`
 * list, computes each enabled job's real next-fire instant with the actual
 * cron engine (never a guess, never a stub), merges every job's run history
 * into one newest-first feed, and sums an honest per-outcome tally straight
 * from the `JobRunRecord`s the store actually holds. The result's row
 * shapes are *structural* duplicates of the pane's `SchedulePaneJobRow` /
 * `SchedulePaneRunRow` / `SchedulePaneTally` — field-for-field identical —
 * rather than an import, because the pane module is contractually barred
 * from importing anything outside `src/swarm-runtime/tui/**`. Structural
 * identity *is* the seam: exactly how `gateway-pane.ts` consumes
 * `GatewayProcess.status()` with no adapter layer in between. The seam is
 * enforced at compile time by a type-level assignment test in this module's
 * test suite (assigning a `buildSchedulePaneSnapshot` result into the
 * pane's own imported types) — any field drift between the two files breaks
 * `tsc`.
 *
 * Honesty rules mirrored from the pane (see that file's header for the full
 * rationale):
 *  - `nextFireAt` is computed via the real `parseCron` + `nextFireTime`
 *    engine for every *enabled* job. A disabled job always gets `null`
 *    (never a stale/guessed instant). An enabled job whose `cron` fails to
 *    parse (`CronParseError`) or whose engine search finds no fire within
 *    its horizon also gets `null` — never a fabricated time.
 *  - `deliveryTarget` is `` `${platform}:${user}` `` (plus `` `:${channel}` ``
 *    when the job's delivery spec has one), or `null` when the job has no
 *    delivery spec at all.
 *  - `tally` is `null` iff *no* job in the store has ever recorded a run.
 *    The moment any job has history, `tally` becomes a real, summed count
 *    per `RunOutcome` across every `JobRunRecord` in the store — never a
 *    fabricated all-zero placeholder standing in for "nothing happened
 *    yet".
 *  - `runs` merges every job's `history` into one newest-first
 *    (`firedAt` descending) feed, capped at `opts.runLimit` (default 200),
 *    with each run's `jobName` joined from the job that actually owns it.
 */

import type { JobStore, ScheduledJob, JobRunRecord, RunOutcome } from "./store";
import { parseCron, nextFireTime, CronParseError } from "./cron";
import type { Clock } from "./clock";

// ---------------------------------------------------------------------------
// Local structural duplicates of the pane's row/tally shapes (the seam).
// Field-for-field identical to
// `src/swarm-runtime/tui/schedule-pane.ts`'s `SchedulePaneJobRow` /
// `SchedulePaneRunRow` / `SchedulePaneTally` — see this file's header for
// why this is a structural duplicate rather than an import.
// ---------------------------------------------------------------------------

interface SchedulePaneJobRow {
  id: string;
  name: string;
  cron: string;
  timeZone: string;
  enabled: boolean;
  taskKind: string;
  deliveryTarget: string | null;
  nextFireAt: number | null;
  lastOutcome: string | null;
  runCount: number;
  failCount: number;
  abstainCount: number;
}

interface SchedulePaneRunRow {
  jobId: string;
  jobName: string;
  firedAt: number;
  scheduledFor: number;
  outcome: string;
  detail: string;
  durationMs: number;
}

interface SchedulePaneTally {
  delivered: number;
  abstained: number;
  withheld: number;
  failed: number;
  skipped: number;
}

export interface SchedulePaneSnapshot {
  jobs: SchedulePaneJobRow[];
  runs: SchedulePaneRunRow[];
  tally: SchedulePaneTally | null;
}

const DEFAULT_RUN_LIMIT = 200;

/** Every `RunOutcome` the store's `store.ts` module recognizes, kept in sync deliberately (not derived) so a future new outcome fails loudly here rather than silently vanishing from the tally. */
const ALL_OUTCOMES: readonly RunOutcome[] = ["delivered", "abstained", "withheld", "failed", "skipped"];

function computeNextFireAt(job: ScheduledJob, clock: Clock): number | null {
  if (!job.enabled) return null;
  try {
    const schedule = parseCron(job.cron);
    const next = nextFireTime(schedule, clock.now(), job.timeZone);
    return next ?? null;
  } catch (err) {
    // An unparseable cron (CronParseError) — or any other zone/engine
    // failure — is reported honestly as "no known next fire", never a
    // guessed instant.
    if (err instanceof CronParseError) return null;
    return null;
  }
}

function computeDeliveryTarget(job: ScheduledJob): string | null {
  if (!job.delivery) return null;
  const { platform, user, channel } = job.delivery;
  return channel !== undefined ? `${platform}:${user}:${channel}` : `${platform}:${user}`;
}

function computeLastOutcome(job: ScheduledJob): string | null {
  if (job.history.length === 0) return null;
  // `history` is stored in chronological (oldest-first) append order — see
  // `JobStoreCore.recordRun` in `./store`, which always pushes onto the
  // end — so the last element is the most recent run.
  return job.history[job.history.length - 1].outcome;
}

function toJobRow(job: ScheduledJob, clock: Clock): SchedulePaneJobRow {
  return {
    id: job.id,
    name: job.name,
    cron: job.cron,
    timeZone: job.timeZone,
    enabled: job.enabled,
    taskKind: job.task.kind,
    deliveryTarget: computeDeliveryTarget(job),
    nextFireAt: computeNextFireAt(job, clock),
    lastOutcome: computeLastOutcome(job),
    runCount: job.runCount,
    failCount: job.failCount,
    abstainCount: job.abstainCount,
  };
}

function toRunRows(job: ScheduledJob): SchedulePaneRunRow[] {
  return job.history.map((run: JobRunRecord) => ({
    jobId: job.id,
    jobName: job.name,
    firedAt: run.firedAt,
    scheduledFor: run.scheduledFor,
    outcome: run.outcome,
    detail: run.detail,
    durationMs: run.durationMs,
  }));
}

/**
 * Build the SCHEDULE pane's snapshot straight from the real `JobStore` and
 * `Clock` — the zero-adapter path `tui/app.ts`'s integration pass hands to
 * `renderSchedulePane` / lays into `SchedulePaneState`. Deterministic: the
 * same `store` contents and `clock.now()` always produce a byte-identical
 * (structurally, via `JSON.stringify`) snapshot.
 */
export function buildSchedulePaneSnapshot(
  store: JobStore,
  clock: Clock,
  opts?: { runLimit?: number }
): SchedulePaneSnapshot {
  const jobs = store.list();
  const runLimit = Math.max(0, Math.floor(opts?.runLimit ?? DEFAULT_RUN_LIMIT));

  const jobRows = jobs.map((job) => toJobRow(job, clock));

  const allRuns = jobs.flatMap(toRunRows);
  allRuns.sort((a, b) => b.firedAt - a.firedAt);
  const runs = allRuns.slice(0, runLimit);

  const hasAnyHistory = jobs.some((job) => job.history.length > 0);
  let tally: SchedulePaneTally | null = null;
  if (hasAnyHistory) {
    const counts: Record<RunOutcome, number> = {
      delivered: 0,
      abstained: 0,
      withheld: 0,
      failed: 0,
      skipped: 0,
    };
    for (const job of jobs) {
      for (const run of job.history) {
        counts[run.outcome] += 1;
      }
    }
    // Touch every declared outcome key even if a given store never produced
    // it, so a fresh outcome added to `RunOutcome` in the future can never
    // silently read back as `undefined` here.
    for (const outcome of ALL_OUTCOMES) {
      if (counts[outcome] === undefined) counts[outcome] = 0;
    }
    tally = { ...counts };
  }

  return { jobs: jobRows, runs, tally };
}
