/**
 * Hades desktop scheduler wire protocol.
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the scheduled
 * job engine (`src/hades/schedule/**`'s `JobStore` / `SchedulerRunner`):
 * `schedule.status.get` answered by a `schedule.status` snapshot of every
 * job, `schedule.job.get` answered by a single job's `schedule.job` view
 * (full run history included) or a `schedule.error`, `schedule.job.toggle`
 * answered by the same, and `schedule.job.run` answered by a
 * `schedule.run.receipt` for a manually-fired job or a `schedule.error`. The
 * `ScheduleCommand` union flows renderer -> sidecar, `ScheduleEvent` flows
 * sidecar -> renderer, exactly like `Command`/`AppEvent`.
 *
 * This module mirrors `./contract.ts` / `./gateway-contract.ts` /
 * `./fleet-contract.ts` / `./learning-contract.ts` conventions exactly (same
 * guard shapes, same codec error-message style) so it is ready to be merged
 * into the `Command`/`AppEvent` unions there. It is intentionally
 * standalone: pure, deterministic, dependency-free — it does not import from
 * `./contract.ts` or any of the other `*-contract.ts` modules (or anywhere
 * else) so the merge can happen without introducing a coupling in either
 * direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/**
 * One scheduled job, as the desktop UI understands it. Mirrors
 * `ScheduledJob` (`../../hades/schedule/store.ts`) field-for-field, with the
 * nested `task` flattened into `taskKind`/`taskInput` and `delivery` /
 * `nextFireAt` / `lastFireAt` normalized so `undefined` never crosses the
 * wire — only `null` (this view never forwards `undefined`, mirroring
 * `gateway-contract.ts`'s "never forwards undefined" rule).
 *
 * `delivery` is `null` when the job has no delivery target configured
 * (`ScheduledJob.delivery` is `undefined` in that case); `delivery.channel`
 * is `null` when the delivery spec has no channel set. `nextFireAt` is
 * `null` for a disabled job, or when the projection could not honestly
 * compute a next fire instant (an unparseable cron, an exhausted 5-year
 * search horizon) — never a guessed time. `lastFireAt` is `null` iff the job
 * has never fired.
 */
export interface ScheduleJobView {
  id: string;
  name: string;
  cron: string;
  timeZone: string;
  enabled: boolean;
  taskKind: string;
  taskInput: string;
  delivery: { platform: string; user: string; channel: string | null } | null;
  misfire: "skip" | "fire-once" | "catch-up";
  nextFireAt: number | null;
  lastFireAt: number | null;
  runCount: number;
  failCount: number;
  abstainCount: number;
  revision: number;
}

/** One recorded execution of a scheduled job. Mirrors `JobRunRecord`
 *  (`../../hades/schedule/store.ts`) exactly, field-for-field. */
export interface ScheduleRunView {
  firedAt: number;
  scheduledFor: number;
  outcome: "delivered" | "abstained" | "withheld" | "failed" | "skipped";
  detail: string;
  durationMs: number;
}

/** A full scheduler status snapshot for the desktop shell. `runnerAttached`
 *  is `true` iff a live `SchedulerRunner` seam was configured for this
 *  sidecar — never a fabricated verdict manufactured out of thin air. */
export interface ScheduleStatusView {
  jobs: ScheduleJobView[];
  runnerAttached: boolean;
  at: number;
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type ScheduleCommand =
  | { kind: "schedule.status.get" }
  | { kind: "schedule.job.get"; id: string }
  | { kind: "schedule.job.toggle"; id: string; enabled: boolean; revision: number }
  | { kind: "schedule.job.run"; id: string };

export type ScheduleEvent =
  | { kind: "schedule.status"; status: ScheduleStatusView }
  | { kind: "schedule.job"; job: ScheduleJobView; history: ScheduleRunView[] }
  | { kind: "schedule.run.receipt"; jobId: string; run: ScheduleRunView; at: number }
  | { kind: "schedule.error"; message: string; at: number };

export const SCHEDULE_COMMAND_KINDS = [
  "schedule.status.get",
  "schedule.job.get",
  "schedule.job.toggle",
  "schedule.job.run",
] as const satisfies readonly ScheduleCommand["kind"][];

export const SCHEDULE_EVENT_KINDS = [
  "schedule.status",
  "schedule.job",
  "schedule.run.receipt",
  "schedule.error",
] as const satisfies readonly ScheduleEvent["kind"][];

// Compile-time exhaustiveness: fails to type-check if a kind is added to the
// `ScheduleCommand`/`ScheduleEvent` unions without adding it to the tuples
// above (or vice versa) — a mismatch in either direction breaks these
// assignments.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [
  Union,
] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<ScheduleCommand["kind"], typeof SCHEDULE_COMMAND_KINDS> = true;
const _eventKindsExact: ExactlyKindsOf<ScheduleEvent["kind"], typeof SCHEDULE_EVENT_KINDS> = true;
void _commandKindsExact;
void _eventKindsExact;

// ---------------------------------------------------------------------------
// Primitive type helpers
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNullableNumber(x: unknown): x is number | null {
  return x === null || isNumber(x);
}

function isNullableString(x: unknown): x is string | null {
  return x === null || isString(x);
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

function isOneOf<T extends string>(x: unknown, values: readonly T[]): x is T {
  return typeof x === "string" && (values as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// View model guards
// ---------------------------------------------------------------------------

const MISFIRE_POLICIES = ["skip", "fire-once", "catch-up"] as const;
const RUN_OUTCOMES = ["delivered", "abstained", "withheld", "failed", "skipped"] as const;

function isScheduleDeliveryView(
  x: unknown
): x is { platform: string; user: string; channel: string | null } {
  if (!isPlainObject(x)) return false;
  return isString(x.platform) && isString(x.user) && isNullableString(x.channel);
}

function isNullableScheduleDeliveryView(
  x: unknown
): x is { platform: string; user: string; channel: string | null } | null {
  return x === null || isScheduleDeliveryView(x);
}

export function isScheduleJobView(x: unknown): x is ScheduleJobView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.id) &&
    isString(x.name) &&
    isString(x.cron) &&
    isString(x.timeZone) &&
    isBoolean(x.enabled) &&
    isString(x.taskKind) &&
    isString(x.taskInput) &&
    isNullableScheduleDeliveryView(x.delivery) &&
    isOneOf(x.misfire, MISFIRE_POLICIES) &&
    isNullableNumber(x.nextFireAt) &&
    isNullableNumber(x.lastFireAt) &&
    isNumber(x.runCount) &&
    isNumber(x.failCount) &&
    isNumber(x.abstainCount) &&
    isNumber(x.revision)
  );
}

export function isScheduleRunView(x: unknown): x is ScheduleRunView {
  if (!isPlainObject(x)) return false;
  return (
    isNumber(x.firedAt) &&
    isNumber(x.scheduledFor) &&
    isOneOf(x.outcome, RUN_OUTCOMES) &&
    isString(x.detail) &&
    isNumber(x.durationMs)
  );
}

export function isScheduleStatusView(x: unknown): x is ScheduleStatusView {
  if (!isPlainObject(x)) return false;
  return (
    Array.isArray(x.jobs) &&
    x.jobs.every(isScheduleJobView) &&
    isBoolean(x.runnerAttached) &&
    isNumber(x.at)
  );
}

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

export function isScheduleCommand(x: unknown): x is ScheduleCommand {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "schedule.status.get":
      return true;
    case "schedule.job.get":
      return isString(x.id);
    case "schedule.job.toggle":
      return isString(x.id) && isBoolean(x.enabled) && isNumber(x.revision);
    case "schedule.job.run":
      return isString(x.id);
    default:
      return false;
  }
}

export function isScheduleEvent(x: unknown): x is ScheduleEvent {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "schedule.status":
      return isScheduleStatusView(x.status);
    case "schedule.job":
      return isScheduleJobView(x.job) && Array.isArray(x.history) && x.history.every(isScheduleRunView);
    case "schedule.run.receipt":
      return isString(x.jobId) && isScheduleRunView(x.run) && isNumber(x.at);
    case "schedule.error":
      return isString(x.message) && isNumber(x.at);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

function parseLine(line: string, label: "command" | "event"): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error(`bad ${label}: empty line`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`bad ${label}: invalid JSON`);
  }
}

export function encodeScheduleEvent(e: ScheduleEvent): string {
  return JSON.stringify(e) + "\n";
}

export function decodeScheduleCommand(raw: string): ScheduleCommand {
  const parsed = parseLine(raw, "command");
  if (!isPlainObject(parsed) || typeof parsed.kind !== "string") {
    throw new Error("bad command: missing kind");
  }
  if (!(SCHEDULE_COMMAND_KINDS as readonly string[]).includes(parsed.kind)) {
    throw new Error(`bad command: unknown kind "${parsed.kind}"`);
  }
  if (!isScheduleCommand(parsed)) {
    throw new Error(`bad command: missing or invalid fields for kind "${parsed.kind}"`);
  }
  return parsed;
}
