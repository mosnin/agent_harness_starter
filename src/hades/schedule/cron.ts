/**
 * A dependency-free, 5-field (Vixie-style) cron engine.
 *
 * This module is pure math: `parseCron` turns an expression into a
 * `CronSchedule` of resolved value sets, `cronMatches` checks whether a
 * given instant's wall-clock reading (in a given IANA time zone) satisfies
 * that schedule, and `nextFireTime` / `nextFireTimes` compute the next
 * minute-aligned instant(s), strictly after a given instant, that fire.
 *
 * Time-zone wall-clock decomposition uses only
 * `Intl.DateTimeFormat(...).formatToParts()` with `hourCycle: "h23"` — never
 * string-parsing of `Date#toLocaleString()` output, which silently loses
 * precision. No `Date.now()`, no timers, no filesystem access: every
 * instant this module ever looks at is one the caller handed it.
 *
 * ---------------------------------------------------------------------
 * DST policy (locked)
 * ---------------------------------------------------------------------
 * Converting a wall-clock time (year/month/day/hour/minute) back to a
 * concrete instant in an IANA zone is not always a 1:1 mapping:
 *
 *  - Spring-forward gap: a wall-clock time that a DST transition skips
 *    (e.g. `02:30` on the day clocks jump from 02:00 to 03:00) does not
 *    correspond to any real instant. We resolve it to the exact transition
 *    boundary itself — the first valid instant after the gap (e.g. a
 *    nonexistent 02:30 resolves to 03:00:00, the moment the clocks finish
 *    springing forward) — found by bisecting the zone's offset function.
 *    The job fires exactly once, at that boundary instant.
 *  - Fall-back fold: a wall-clock time that occurs twice (e.g. `01:30`
 *    occurs once under DST and again under standard time) resolves to
 *    the FIRST (earlier, pre-transition) of the two occurrences only.
 *
 * Both cases are handled by `wallToEpoch` below; see its comments for the
 * derivation.
 * ---------------------------------------------------------------------
 *
 * Strictness policy for parsing: this parser is intentionally stricter
 * than some real-world `crontab(5)` implementations in one respect —
 * a step that is larger than the span of its range (e.g. `10-20/50`) is
 * rejected outright rather than silently collapsing to a single value.
 * That is a deliberate choice: a step nobody could have meant is far more
 * likely to be a typo than an intentional singleton.
 */

// ===========================================================================
// Locked public types
// ===========================================================================

export interface CronSchedule {
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

export class CronParseError extends Error {
  readonly field?: "minute" | "hour" | "day-of-month" | "month" | "day-of-week";

  constructor(message: string, field?: "minute" | "hour" | "day-of-month" | "month" | "day-of-week") {
    super(message);
    this.name = "CronParseError";
    this.field = field;
    Object.setPrototypeOf(this, CronParseError.prototype);
  }
}

// ===========================================================================
// Field definitions
// ===========================================================================

type CronField = "minute" | "hour" | "day-of-month" | "month" | "day-of-week";

interface FieldDef {
  readonly name: CronField;
  readonly min: number;
  readonly max: number;
  readonly names?: Readonly<Record<string, number>>;
  readonly isDow?: boolean;
}

const MONTH_NAMES: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DOW_NAMES: Readonly<Record<string, number>> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const MINUTE_FIELD: FieldDef = { name: "minute", min: 0, max: 59 };
const HOUR_FIELD: FieldDef = { name: "hour", min: 0, max: 23 };
const DOM_FIELD: FieldDef = { name: "day-of-month", min: 1, max: 31 };
const MONTH_FIELD: FieldDef = { name: "month", min: 1, max: 12, names: MONTH_NAMES };
const DOW_FIELD: FieldDef = { name: "day-of-week", min: 0, max: 7, names: DOW_NAMES, isDow: true };

const FIELD_ORDER: readonly FieldDef[] = [MINUTE_FIELD, HOUR_FIELD, DOM_FIELD, MONTH_FIELD, DOW_FIELD];

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ===========================================================================
// parseCron
// ===========================================================================

export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== "string") {
    throw new CronParseError(`cron expression must be a string, got ${typeof expression}`);
  }

  // Splitting on a single literal space means any leading space, trailing
  // space, or run of more-than-one space between fields changes the token
  // count away from exactly 5 and is rejected right here — deliberately,
  // rather than being silently collapsed the way `split(/\s+/)` would.
  const rawFields = expression.split(" ");
  if (rawFields.length !== 5) {
    throw new CronParseError(
      `cron expression must have exactly 5 space-separated fields (minute hour day-of-month month day-of-week), got ${rawFields.length}: "${expression}"`,
    );
  }

  for (let i = 0; i < FIELD_ORDER.length; i++) {
    if (rawFields[i] === "") {
      throw new CronParseError(
        `${FIELD_ORDER[i].name} field is empty (check for stray/duplicate whitespace) in "${expression}"`,
        FIELD_ORDER[i].name,
      );
    }
  }

  const minutes = parseField(rawFields[0], MINUTE_FIELD);
  const hours = parseField(rawFields[1], HOUR_FIELD);
  const daysOfMonth = parseField(rawFields[2], DOM_FIELD);
  const months = parseField(rawFields[3], MONTH_FIELD);
  const daysOfWeek = parseField(rawFields[4], DOW_FIELD);

  const domRestricted = rawFields[2] !== "*";
  const dowRestricted = rawFields[4] !== "*";

  return Object.freeze({
    expression,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted,
    dowRestricted,
  });
}

function parseField(text: string, def: FieldDef): ReadonlySet<number> {
  const result = new Set<number>();
  const items = text.split(",");
  for (const item of items) {
    if (item === "") {
      throw new CronParseError(`${def.name} field contains an empty list item in "${text}"`, def.name);
    }
    parseItemInto(item, def, result);
  }
  return result;
}

function resolveToken(token: string, def: FieldDef): number {
  if (def.names) {
    const named = def.names[token.toUpperCase()];
    if (named !== undefined) {
      return named;
    }
  }
  if (!/^[0-9]+$/.test(token)) {
    throw new CronParseError(`invalid value "${token}" in ${def.name} field`, def.name);
  }
  const value = Number(token);
  if (!Number.isSafeInteger(value) || value < def.min || value > def.max) {
    throw new CronParseError(
      `value ${token} is out of range [${def.min}-${def.max}] in ${def.name} field`,
      def.name,
    );
  }
  return value;
}

function parseItemInto(item: string, def: FieldDef, target: Set<number>): void {
  const slashParts = item.split("/");
  if (slashParts.length > 2) {
    throw new CronParseError(`malformed step expression "${item}" in ${def.name} field`, def.name);
  }
  const rangeText = slashParts[0];
  const stepText = slashParts.length === 2 ? slashParts[1] : undefined;

  let step = 1;
  let hasExplicitStep = false;
  if (stepText !== undefined) {
    if (stepText === "" || !/^[0-9]+$/.test(stepText)) {
      throw new CronParseError(`invalid step "${stepText}" in ${def.name} field: "${item}"`, def.name);
    }
    step = Number(stepText);
    if (step <= 0) {
      throw new CronParseError(`step must be a positive integer in ${def.name} field: "${item}"`, def.name);
    }
    hasExplicitStep = true;
  }

  if (rangeText === "") {
    throw new CronParseError(`malformed range "${rangeText}" in ${def.name} field: "${item}"`, def.name);
  }

  let start: number;
  let end: number;

  if (rangeText === "*") {
    start = def.min;
    end = def.max;
  } else {
    const dashParts = rangeText.split("-");
    if (dashParts.length === 1) {
      start = resolveToken(dashParts[0], def);
      // crontab(5) semantics: "first/step" (no explicit end) means
      // "first through the field's maximum, by step".
      end = hasExplicitStep ? def.max : start;
    } else if (dashParts.length === 2) {
      if (dashParts[0] === "" || dashParts[1] === "") {
        throw new CronParseError(`malformed range "${rangeText}" in ${def.name} field`, def.name);
      }
      start = resolveToken(dashParts[0], def);
      end = resolveToken(dashParts[1], def);
      if (start > end) {
        throw new CronParseError(
          `reversed range "${rangeText}" in ${def.name} field (start ${start} greater than end ${end})`,
          def.name,
        );
      }
    } else {
      throw new CronParseError(`malformed range "${rangeText}" in ${def.name} field`, def.name);
    }
  }

  const span = end - start;
  if (hasExplicitStep && span > 0 && step > span) {
    throw new CronParseError(
      `step ${step} is larger than the range span (${span}) in ${def.name} field: "${item}"`,
      def.name,
    );
  }

  for (let v = start; v <= end; v += step) {
    target.add(def.isDow && v === 7 ? 0 : v);
  }
}

// ===========================================================================
// Time-zone wall-clock plumbing
// ===========================================================================

interface WallClock {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
  readonly second: number; // 0-59
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    // Some environments only reject an invalid zone on first use rather
    // than at construction time — force that now so callers always see a
    // clear, immediate error rather than a NaN propagating downstream.
    formatter.format(0);
  } catch {
    throw new RangeError(`Invalid IANA time zone: "${timeZone}"`);
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function getWallClock(epochMs: number, timeZone: string): WallClock {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`epochMs must be a finite number, got ${String(epochMs)}`);
  }
  const formatter = getFormatter(timeZone);
  const parts = formatter.formatToParts(epochMs);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        // hourCycle "h23" yields 00-23; guard the (spec-legal-but-unwanted)
        // "24" edge some engines emit for local midnight under h24 defaults.
        hour = part.value === "24" ? 0 : Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  return { year, month, day, hour, minute, second };
}

/** Day of the Gregorian week for a wall-clock date: 0=Sunday .. 6=Saturday. */
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Number of days in `month` (1-12) of `year`, leap-year aware. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function offsetMillisAt(epochMs: number, timeZone: string): number {
  const wall = getWallClock(epochMs, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, 0);
  return asUtc - epochMs;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bisect for the exact instant an offset transition takes effect.
 *
 * Precondition: `offsetMillisAt(loMs) === fromOffset` and
 * `offsetMillisAt(hiMs) !== fromOffset`, with the transition somewhere in
 * between. Returns the smallest instant whose offset differs from
 * `fromOffset` — i.e. the first instant of the new regime.
 *
 * `Intl.DateTimeFormat` only reports whole-second wall-clock parts, so
 * `offsetMillisAt` is only a clean step function at second granularity
 * (probing at sub-second resolution would see a sawtooth of drift rather
 * than a flat step). We therefore bisect over whole seconds, which is
 * exact for every real IANA transition (they land on whole seconds — in
 * practice always whole minutes) and still gives an exact millisecond
 * epoch as the final result.
 */
function bisectTransitionBoundary(loMs: number, hiMs: number, fromOffset: number, timeZone: string): number {
  let loSec = Math.floor(loMs / 1000);
  let hiSec = Math.ceil(hiMs / 1000);
  while (hiSec - loSec > 1) {
    const midSec = loSec + Math.floor((hiSec - loSec) / 2);
    if (offsetMillisAt(midSec * 1000, timeZone) === fromOffset) {
      loSec = midSec;
    } else {
      hiSec = midSec;
    }
  }
  return hiSec * 1000;
}

/**
 * Resolve a wall-clock time in `timeZone` to a concrete epoch instant.
 *
 * Start from the naive guess `utc1` (treat the wall-clock fields as if
 * they were UTC) and its offset `oa`. A single Newton-style correction
 * (`candA = utc1 - oa`) reproduces the desired wall-clock exactly whenever
 * `offsetMillisAt(candA) === oa` — that self-consistency check is the
 * whole trick: it holds for every ordinary instant, and for at least one
 * side of a fall-back fold, but never for a spring-forward gap.
 *
 * A single correction is not always enough on its own (a wall-clock time
 * immediately after a gap can still need a *second* Newton step before it
 * converges), and it is not enough to find the *earlier* of two fold
 * occurrences either (the naive guess can land squarely on the later one
 * with no hint of the earlier one nearby). So we gather every offset we
 * can cheaply observe near the guess — `oa`, the offset actually observed
 * at `candA`, and the offsets one full day to either side of `candA`
 * (guaranteed to span any single transition, since real IANA zones never
 * schedule two transitions within a day) — and test each as a candidate
 * offset for reconstructing the wall-clock. Every valid (self-consistent)
 * candidate is a real occurrence of this wall-clock time; picking the
 * earliest one is exactly the "first occurrence only" fold policy.
 *
 * If nothing reconstructs the desired wall-clock, no instant has it: the
 * time was skipped by a spring-forward gap. We resolve to the exact
 * transition boundary via bisection, per the policy documented at the top
 * of this file.
 */
function wallToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): { epoch: number; existed: boolean } {
  const utc1 = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const oa = offsetMillisAt(utc1, timeZone);
  const candA = utc1 - oa;
  const oHereA = offsetMillisAt(candA, timeZone);

  const candidateOffsets = new Set<number>([
    oa,
    oHereA,
    offsetMillisAt(candA - ONE_DAY_MS, timeZone),
    offsetMillisAt(candA + ONE_DAY_MS, timeZone),
  ]);

  let best: number | undefined;
  for (const offset of candidateOffsets) {
    const candidate = utc1 - offset;
    if (offsetMillisAt(candidate, timeZone) === offset) {
      if (best === undefined || candidate < best) {
        best = candidate;
      }
    }
  }
  if (best !== undefined) {
    return { epoch: best, existed: true };
  }

  // Gap: bisect for the transition boundary adjacent to candA. oHereA is
  // whichever of the two nearby offsets actually governs candA; the other
  // (from the mismatched oa) is the regime on the far side of the gap.
  const larger = Math.max(oa, oHereA);
  const smaller = Math.min(oa, oHereA);
  const boundary =
    oHereA === larger
      ? bisectTransitionBoundary(candA - ONE_DAY_MS, candA, smaller, timeZone)
      : bisectTransitionBoundary(candA, candA + ONE_DAY_MS, smaller, timeZone);
  return { epoch: boundary, existed: false };
}

// ===========================================================================
// Matching
// ===========================================================================

function dayMatches(schedule: CronSchedule, day: number, dow: number): boolean {
  const domMatch = schedule.daysOfMonth.has(day);
  const dowMatch = schedule.daysOfWeek.has(dow);
  if (schedule.domRestricted && schedule.dowRestricted) {
    // The classic Vixie-cron OR rule: when BOTH fields are restricted, a
    // day qualifies if EITHER matches.
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

export function cronMatches(schedule: CronSchedule, epochMs: number, timeZone: string): boolean {
  const wall = getWallClock(epochMs, timeZone);
  if (!schedule.months.has(wall.month)) {
    return false;
  }
  const dow = dayOfWeek(wall.year, wall.month, wall.day);
  if (!dayMatches(schedule, wall.day, dow)) {
    return false;
  }
  return schedule.hours.has(wall.hour) && schedule.minutes.has(wall.minute);
}

// ===========================================================================
// nextFireTime / nextFireTimes
// ===========================================================================

function smallestAtLeast(set: ReadonlySet<number>, value: number): number | undefined {
  let best: number | undefined;
  for (const v of set) {
    if (v >= value && (best === undefined || v < best)) {
      best = v;
    }
  }
  return best;
}

function smallest(set: ReadonlySet<number>): number {
  let best: number | undefined;
  for (const v of set) {
    if (best === undefined || v < best) {
      best = v;
    }
  }
  if (best === undefined) {
    // Unreachable: parseCron never produces an empty value set (a bare "*"
    // always fills the field's full range).
    throw new Error("cron: encountered an empty field value set");
  }
  return best;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Advance `wall` field-by-field (month, then day, then hour, then minute)
 * until it satisfies `schedule`, or until `wall.year` exceeds
 * `horizonYear`, in which case the search gives up and returns
 * `undefined`. Every branch below ends in `continue`, re-validating from
 * the month check on down — that redundancy is what makes the loop simple
 * to prove correct (each iteration only needs to trust the *previous*
 * iteration's edit, not track compound invariants across branches) while
 * still terminating in at most a few thousand iterations even across the
 * full 5-year horizon, since each iteration advances the calendar by at
 * least one unit.
 */
function advanceToNextFire(schedule: CronSchedule, wall: WallTime, horizonYear: number): WallTime | undefined {
  let { year, month, day, hour, minute } = wall;

  // A hard cap as a defense-in-depth safety net against any bug in the
  // advancement logic; the year-horizon check above is what actually
  // bounds legitimate searches (a few thousand iterations at most), so
  // this should never be the limiting factor in practice.
  const MAX_ITERATIONS = 2_000_000;
  let iterations = 0;

  while (true) {
    if (year > horizonYear) {
      return undefined;
    }
    iterations += 1;
    if (iterations > MAX_ITERATIONS) {
      return undefined;
    }

    if (!schedule.months.has(month)) {
      const nextMonth = smallestAtLeast(schedule.months, month + 1);
      if (nextMonth !== undefined) {
        month = nextMonth;
      } else {
        year += 1;
        month = smallest(schedule.months);
      }
      day = 1;
      hour = 0;
      minute = 0;
      continue;
    }

    const dim = daysInMonth(year, month);
    if (day > dim) {
      if (month === 12) {
        year += 1;
        month = 1;
      } else {
        month += 1;
      }
      day = 1;
      hour = 0;
      minute = 0;
      continue;
    }

    const dow = dayOfWeek(year, month, day);
    if (!dayMatches(schedule, day, dow)) {
      day += 1;
      hour = 0;
      minute = 0;
      if (day > dim) {
        day = 1;
        if (month === 12) {
          year += 1;
          month = 1;
        } else {
          month += 1;
        }
      }
      continue;
    }

    if (!schedule.hours.has(hour)) {
      const nextHour = smallestAtLeast(schedule.hours, hour + 1);
      if (nextHour !== undefined) {
        hour = nextHour;
        minute = 0;
      } else {
        day += 1;
        hour = 0;
        minute = 0;
        if (day > dim) {
          day = 1;
          if (month === 12) {
            year += 1;
            month = 1;
          } else {
            month += 1;
          }
        }
      }
      continue;
    }

    if (!schedule.minutes.has(minute)) {
      const nextMinute = smallestAtLeast(schedule.minutes, minute + 1);
      if (nextMinute !== undefined) {
        minute = nextMinute;
      } else {
        hour += 1;
        minute = 0;
        if (hour > 23) {
          hour = 0;
          day += 1;
          if (day > dim) {
            day = 1;
            if (month === 12) {
              year += 1;
              month = 1;
            } else {
              month += 1;
            }
          }
        }
      }
      continue;
    }

    return { year, month, day, hour, minute };
  }
}

export function nextFireTime(schedule: CronSchedule, afterEpochMs: number, timeZone: string): number | undefined {
  if (!Number.isFinite(afterEpochMs)) {
    throw new RangeError(`afterEpochMs must be a finite number, got ${String(afterEpochMs)}`);
  }
  // Validate the zone up front so an invalid zone fails fast and clearly,
  // even for a schedule that would otherwise never search far enough to
  // read the wall clock.
  getFormatter(timeZone);

  const startWall = getWallClock(afterEpochMs, timeZone);
  const horizonYear = startWall.year + 5;

  // The retry loop below is a defensive safety net (see the comment at its
  // single `continue`-equivalent site): in the overwhelming majority of
  // calls it runs exactly once. It exists only to keep the "strictly
  // after afterEpochMs" contract airtight across the exceedingly rare DST
  // edge instant where a naive first pass could land un-advanced.
  let searchAfter = afterEpochMs;
  for (let guard = 0; guard < 5; guard++) {
    const candidateStart = Math.floor(searchAfter / 60000) * 60000 + 60000;
    const wall0 = getWallClock(candidateStart, timeZone);
    const found = advanceToNextFire(
      schedule,
      { year: wall0.year, month: wall0.month, day: wall0.day, hour: wall0.hour, minute: wall0.minute },
      horizonYear,
    );
    if (found === undefined) {
      return undefined;
    }
    const { epoch } = wallToEpoch(found.year, found.month, found.day, found.hour, found.minute, 0, timeZone);
    if (epoch > afterEpochMs) {
      return epoch;
    }
    searchAfter = epoch;
  }
  return undefined;
}

export function nextFireTimes(schedule: CronSchedule, afterEpochMs: number, timeZone: string, count: number): number[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${count}`);
  }
  const results: number[] = [];
  let cursor = afterEpochMs;
  for (let i = 0; i < count; i++) {
    const next = nextFireTime(schedule, cursor, timeZone);
    if (next === undefined) {
      break;
    }
    results.push(next);
    cursor = next;
  }
  return results;
}

// ===========================================================================
// describeCron
// ===========================================================================

function sortedValues(set: ReadonlySet<number>): number[] {
  return Array.from(set).sort((a, b) => a - b);
}

function formatList(values: readonly (number | string)[]): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return String(values[0]);
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function describeCron(schedule: CronSchedule): string {
  const minutes = sortedValues(schedule.minutes);
  const hours = sortedValues(schedule.hours);
  const allMinutes = schedule.minutes.size === 60;
  const allHours = schedule.hours.size === 24;

  let timeClause: string;
  if (allMinutes && allHours) {
    timeClause = "every minute";
  } else if (!allMinutes && minutes.length === 1 && allHours) {
    timeClause = `at minute ${minutes[0]} of every hour`;
  } else if (!allMinutes && !allHours && minutes.length === 1 && hours.length === 1) {
    timeClause = `at ${pad2(hours[0])}:${pad2(minutes[0])}`;
  } else {
    const minutePart = allMinutes ? "every minute" : `minute ${formatList(minutes)}`;
    const hourPart = allHours ? "every hour" : `hour ${formatList(hours)}`;
    timeClause = `at ${minutePart} past ${hourPart}`;
  }

  const clauses: string[] = [timeClause];

  const domLabel = schedule.domRestricted ? `day-of-month ${formatList(sortedValues(schedule.daysOfMonth))}` : undefined;
  const dowLabel = schedule.dowRestricted
    ? formatList(sortedValues(schedule.daysOfWeek).map((d) => DOW_LABELS[d]))
    : undefined;

  if (domLabel && dowLabel) {
    clauses.push(`on ${domLabel} or on ${dowLabel}`);
  } else if (domLabel) {
    clauses.push(`on ${domLabel}`);
  } else if (dowLabel) {
    clauses.push(`on ${dowLabel}`);
  }

  if (schedule.months.size !== 12) {
    clauses.push(`in ${formatList(sortedValues(schedule.months).map((m) => MONTH_LABELS[m - 1]))}`);
  }

  return clauses.join(", ");
}
