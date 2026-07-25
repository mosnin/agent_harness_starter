import { describe, expect, it } from "vitest";

import {
  CronParseError,
  type CronSchedule,
  cronMatches,
  describeCron,
  nextFireTime,
  nextFireTimes,
  parseCron,
} from "../cron";

// ===========================================================================
// Test helpers
// ===========================================================================

/** Formats an epoch as an ISO-ish string for readable assertion failures. */
function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function sortedArray(set: ReadonlySet<number>): number[] {
  return Array.from(set).sort((a, b) => a - b);
}

// A tiny, deterministic PRNG (mulberry32) so the 500+ case fuzz test below is
// fully reproducible. The seed is fixed and printed so a failure can be
// reproduced byte-for-byte outside the suite.
const FUZZ_SEED = 0x5eed_c20e;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================
// parseCron: malformed expressions
// ===========================================================================

describe("parseCron: malformed expressions", () => {
  it("rejects the wrong number of fields (too few)", () => {
    expect(() => parseCron("* * * *")).toThrow(CronParseError);
    expect(() => parseCron("* * * *")).toThrow(/5 space-separated fields/);
  });

  it("rejects the wrong number of fields (too many)", () => {
    expect(() => parseCron("* * * * * *")).toThrow(CronParseError);
  });

  it("rejects a single-field garbage string", () => {
    expect(() => parseCron("garbage")).toThrow(CronParseError);
  });

  it("rejects leading whitespace", () => {
    expect(() => parseCron(" * * * * *")).toThrow(CronParseError);
  });

  it("rejects trailing whitespace", () => {
    expect(() => parseCron("* * * * * ")).toThrow(CronParseError);
  });

  it("rejects duplicate (double-space) whitespace between fields", () => {
    expect(() => parseCron("*  * * * *")).toThrow(CronParseError);
    expect(() => parseCron("* * *  * *")).toThrow(CronParseError);
  });

  it("rejects an empty field produced by an internal double space even when the raw split count is 5", () => {
    // "* * *  *" has exactly 4 space characters, so split(" ") yields exactly
    // 5 tokens ["*","*","*","","*"] — the field-count check alone would not
    // catch this; the explicit per-field emptiness check must.
    expect(() => parseCron("* * *  *")).toThrow(CronParseError);
  });

  it("names the offending field for out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow(CronParseError);
    try {
      parseCron("60 * * * *");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CronParseError);
      expect((err as CronParseError).field).toBe("minute");
    }
  });

  it("rejects minute 60 (out of range)", () => {
    expect(() => parseCron("60 * * * *")).toThrow(CronParseError);
  });

  it("rejects hour 24 (out of range)", () => {
    expect(() => parseCron("0 24 * * *")).toThrow(CronParseError);
  });

  it("rejects day-of-month 0 (out of range, dom is 1-based)", () => {
    expect(() => parseCron("0 0 0 * *")).toThrow(CronParseError);
  });

  it("rejects day-of-month 32 (out of range)", () => {
    expect(() => parseCron("0 0 32 * *")).toThrow(CronParseError);
  });

  it("rejects month 0 (out of range)", () => {
    expect(() => parseCron("0 0 * 0 *")).toThrow(CronParseError);
  });

  it("rejects month 13 (out of range)", () => {
    expect(() => parseCron("0 0 * 13 *")).toThrow(CronParseError);
  });

  it("accepts day-of-week 7 and normalizes it to 0 (Sunday)", () => {
    const schedule = parseCron("0 0 * * 7");
    expect(sortedArray(schedule.daysOfWeek)).toEqual([0]);
  });

  it("rejects day-of-week 8 (out of the 0-7 range)", () => {
    let field: string | undefined;
    try {
      parseCron("0 0 * * 8");
      expect.unreachable();
    } catch (err) {
      field = (err as CronParseError).field;
    }
    expect(field).toBe("day-of-week");
  });

  it("rejects day-of-week 9 (out of the 0-7 range)", () => {
    expect(() => parseCron("0 0 * * 9")).toThrow(CronParseError);
  });

  it("rejects a reversed range (30-10)", () => {
    expect(() => parseCron("30-10 * * * *")).toThrow(CronParseError);
    expect(() => parseCron("30-10 * * * *")).toThrow(/reversed range/);
  });

  it("rejects a reversed named range (FRI-MON is not a wraparound)", () => {
    expect(() => parseCron("0 0 * * FRI-MON")).toThrow(CronParseError);
  });

  it("rejects a zero step (*/0)", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(CronParseError);
    expect(() => parseCron("*/0 * * * *")).toThrow(/positive/);
  });

  it("rejects a negative step", () => {
    expect(() => parseCron("*/-5 * * * *")).toThrow(CronParseError);
  });

  it("rejects a step larger than its explicit range span", () => {
    // span is 20-10=10, step 50 > 10.
    expect(() => parseCron("10-20/50 * * * *")).toThrow(CronParseError);
    expect(() => parseCron("10-20/50 * * * *")).toThrow(/larger than the range/);
  });

  it("accepts a single value with an oversized step (crontab 'first/step' semantics collapse to a singleton)", () => {
    // "31/5" means "31 through 31 (the dom max) by 5" == {31}; span is 0,
    // so the oversized-step rejection deliberately does not apply here.
    const schedule = parseCron("0 0 31/5 * *");
    expect(sortedArray(schedule.daysOfMonth)).toEqual([31]);
  });

  it("rejects a garbage token", () => {
    expect(() => parseCron("abc * * * *")).toThrow(CronParseError);
  });

  it("rejects unicode digits (not ASCII 0-9)", () => {
    // U+0665 ARABIC-INDIC DIGIT FIVE - visually "5" but not what /[0-9]/ matches.
    expect(() => parseCron("٥ * * * *")).toThrow(CronParseError);
  });

  it("rejects a malformed step expression with too many slashes", () => {
    expect(() => parseCron("1/2/3 * * * *")).toThrow(CronParseError);
  });

  it("rejects a malformed range with too many dashes", () => {
    expect(() => parseCron("1-2-3 * * * *")).toThrow(CronParseError);
  });

  it("rejects an empty list item from a stray comma", () => {
    expect(() => parseCron("1,,2 * * * *")).toThrow(CronParseError);
    expect(() => parseCron(",1 * * * *")).toThrow(CronParseError);
    expect(() => parseCron("1, * * * *")).toThrow(CronParseError);
  });

  it("rejects an invalid IANA-looking month name", () => {
    expect(() => parseCron("0 0 * FOO *")).toThrow(CronParseError);
  });

  it("never returns a partial schedule: a throwing parse leaves nothing observable", () => {
    let schedule: CronSchedule | undefined;
    try {
      schedule = parseCron("99 * * * *");
    } catch {
      // expected
    }
    expect(schedule).toBeUndefined();
  });
});

// ===========================================================================
// parseCron: valid expressions and semantics
// ===========================================================================

describe("parseCron: valid expressions", () => {
  it("parses '* * * * *' as full wildcards for every field", () => {
    const schedule = parseCron("* * * * *");
    expect(schedule.minutes.size).toBe(60);
    expect(schedule.hours.size).toBe(24);
    expect(schedule.daysOfMonth.size).toBe(31);
    expect(schedule.months.size).toBe(12);
    expect(schedule.daysOfWeek.size).toBe(7);
    expect(schedule.domRestricted).toBe(false);
    expect(schedule.dowRestricted).toBe(false);
  });

  it("parses '*/5 * * * *' as every 5th minute", () => {
    const schedule = parseCron("*/5 * * * *");
    expect(sortedArray(schedule.minutes)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it("parses '0 9 * * MON-FRI' with case-insensitive weekday names and marks dow restricted", () => {
    const schedule = parseCron("0 9 * * MON-FRI");
    expect(sortedArray(schedule.daysOfWeek)).toEqual([1, 2, 3, 4, 5]);
    expect(schedule.dowRestricted).toBe(true);
    expect(schedule.domRestricted).toBe(false);
    // lower-case is equally valid
    const lower = parseCron("0 9 * * mon-fri");
    expect(sortedArray(lower.daysOfWeek)).toEqual(sortedArray(schedule.daysOfWeek));
  });

  it("parses '30 4 1 * *' as a monthly schedule", () => {
    const schedule = parseCron("30 4 1 * *");
    expect(sortedArray(schedule.minutes)).toEqual([30]);
    expect(sortedArray(schedule.hours)).toEqual([4]);
    expect(sortedArray(schedule.daysOfMonth)).toEqual([1]);
    expect(schedule.domRestricted).toBe(true);
    expect(schedule.dowRestricted).toBe(false);
  });

  it("parses '0 0 29 2 *' (Feb 29 only)", () => {
    const schedule = parseCron("0 0 29 2 *");
    expect(sortedArray(schedule.daysOfMonth)).toEqual([29]);
    expect(sortedArray(schedule.months)).toEqual([2]);
  });

  it("parses '0 12 13 * 5' and marks both dom and dow restricted (OR rule applies)", () => {
    const schedule = parseCron("0 12 13 * 5");
    expect(schedule.domRestricted).toBe(true);
    expect(schedule.dowRestricted).toBe(true);
    expect(sortedArray(schedule.daysOfMonth)).toEqual([13]);
    expect(sortedArray(schedule.daysOfWeek)).toEqual([5]);
  });

  it("parses month name aliases case-insensitively, including ranges", () => {
    const schedule = parseCron("0 0 1 JAN,jul,Dec *");
    expect(sortedArray(schedule.months)).toEqual([1, 7, 12]);
    const range = parseCron("0 0 1 mar-jun *");
    expect(sortedArray(range.months)).toEqual([3, 4, 5, 6]);
  });

  it("parses comma lists mixed with ranges and steps in one field", () => {
    const schedule = parseCron("0,15,30-45/5 * * * *");
    expect(sortedArray(schedule.minutes)).toEqual([0, 15, 30, 35, 40, 45]);
  });

  it("treats a literal '*' day-of-month/day-of-week as unrestricted (domRestricted/dowRestricted false)", () => {
    const schedule = parseCron("0 0 * * *");
    expect(schedule.domRestricted).toBe(false);
    expect(schedule.dowRestricted).toBe(false);
  });

  it("retains the original expression string on the schedule", () => {
    const schedule = parseCron("*/10 8-17 * * 1-5");
    expect(schedule.expression).toBe("*/10 8-17 * * 1-5");
  });
});

// ===========================================================================
// cronMatches
// ===========================================================================

describe("cronMatches", () => {
  it("truncates seconds/milliseconds to the minute", () => {
    const schedule = parseCron("30 4 * * *");
    // 2026-01-01T04:30:00Z plus 47 seconds and 999 ms - still minute 30.
    const epoch = Date.UTC(2026, 0, 1, 4, 30, 47, 999);
    expect(cronMatches(schedule, epoch, "UTC")).toBe(true);
  });

  it("does not match a different minute within the same hour", () => {
    const schedule = parseCron("30 4 * * *");
    expect(cronMatches(schedule, Date.UTC(2026, 0, 1, 4, 31, 0), "UTC")).toBe(false);
  });

  it("applies the dom/dow OR rule when both fields are restricted", () => {
    // "0 12 13 * 5": the 13th of the month OR any Friday, at 12:00 UTC.
    const schedule = parseCron("0 12 13 * 5");
    // 2026-01-13 is a Tuesday (dom matches, dow doesn't) - OR rule -> match.
    expect(cronMatches(schedule, Date.UTC(2026, 0, 13, 12, 0, 0), "UTC")).toBe(true);
    // 2026-01-02 is a Friday (dow matches, dom doesn't) - OR rule -> match.
    expect(cronMatches(schedule, Date.UTC(2026, 0, 2, 12, 0, 0), "UTC")).toBe(true);
    // 2026-01-14 is a Wednesday and not the 13th - neither matches.
    expect(cronMatches(schedule, Date.UTC(2026, 0, 14, 12, 0, 0), "UTC")).toBe(false);
  });

  it("applies AND semantics when only one of dom/dow is restricted", () => {
    // dow unrestricted ("*"): only dom=1 matters.
    const schedule = parseCron("0 0 1 * *");
    expect(cronMatches(schedule, Date.UTC(2026, 0, 1, 0, 0, 0), "UTC")).toBe(true);
    expect(cronMatches(schedule, Date.UTC(2026, 0, 2, 0, 0, 0), "UTC")).toBe(false);
  });

  it("requires the month to match", () => {
    const schedule = parseCron("0 0 1 6 *");
    expect(cronMatches(schedule, Date.UTC(2026, 5, 1, 0, 0, 0), "UTC")).toBe(true);
    expect(cronMatches(schedule, Date.UTC(2026, 6, 1, 0, 0, 0), "UTC")).toBe(false);
  });

  it("is timezone-sensitive: the same instant can match in one zone and not another", () => {
    const schedule = parseCron("0 9 * * *");
    // 2026-01-01T09:00:00Z is 09:00 in UTC but 04:00 in America/New_York (EST, UTC-5).
    const epoch = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(cronMatches(schedule, epoch, "UTC")).toBe(true);
    expect(cronMatches(schedule, epoch, "America/New_York")).toBe(false);
  });
});

// ===========================================================================
// nextFireTime: exact sequences (UTC)
// ===========================================================================

describe("nextFireTime: exact sequences", () => {
  it("'* * * * *' fires every minute", () => {
    const schedule = parseCron("* * * * *");
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = nextFireTime(schedule, start, "UTC");
    expect(next).toBe(start + 60_000);
  });

  it("'*/5 * * * *' fires on every 5th minute, strictly after the given instant", () => {
    const schedule = parseCron("*/5 * * * *");
    // 2026-01-01T00:07:00Z -> next multiple of 5 strictly after is :10.
    const start = Date.UTC(2026, 0, 1, 0, 7, 0);
    expect(nextFireTime(schedule, start, "UTC")).toBe(Date.UTC(2026, 0, 1, 0, 10, 0));
    // starting exactly on a fire minute still advances to the next one.
    expect(nextFireTime(schedule, Date.UTC(2026, 0, 1, 0, 10, 0), "UTC")).toBe(Date.UTC(2026, 0, 1, 0, 15, 0));
  });

  it("'0 9 * * MON-FRI' fires only on weekday mornings", () => {
    const schedule = parseCron("0 9 * * MON-FRI");
    // 2026-01-01 is a Thursday - 09:00 that day should be the very next fire.
    const fromWedNight = Date.UTC(2025, 11, 31, 23, 0, 0); // 2025-12-31 23:00Z (Wed)
    expect(nextFireTime(schedule, fromWedNight, "UTC")).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
    // From Thursday 09:00 exactly, next is Friday 2026-01-02 09:00 (Fri).
    expect(nextFireTime(schedule, Date.UTC(2026, 0, 1, 9, 0, 0), "UTC")).toBe(Date.UTC(2026, 0, 2, 9, 0, 0));
    // From Friday 09:00, weekend is skipped -> next Monday 2026-01-05 09:00.
    expect(nextFireTime(schedule, Date.UTC(2026, 0, 2, 9, 0, 0), "UTC")).toBe(Date.UTC(2026, 0, 5, 9, 0, 0));
  });

  it("'30 4 1 * *' fires monthly on the 1st at 04:30", () => {
    const schedule = parseCron("30 4 1 * *");
    expect(nextFireTime(schedule, Date.UTC(2026, 0, 1, 4, 30, 0), "UTC")).toBe(Date.UTC(2026, 1, 1, 4, 30, 0));
    expect(nextFireTime(schedule, Date.UTC(2026, 0, 15, 0, 0, 0), "UTC")).toBe(Date.UTC(2026, 1, 1, 4, 30, 0));
    // December rolls over into next January.
    expect(nextFireTime(schedule, Date.UTC(2026, 11, 1, 4, 30, 0), "UTC")).toBe(Date.UTC(2027, 0, 1, 4, 30, 0));
  });

  it("'0 0 29 2 *' fires only on leap-year Feb 29ths: 2024, then 2028", () => {
    const schedule = parseCron("0 0 29 2 *");
    // 2024-02-29 00:00:00Z = Date.UTC(2024,1,29,0,0,0) = 1709164800000.
    const first = nextFireTime(schedule, Date.UTC(2023, 0, 1, 0, 0, 0), "UTC");
    expect(first).toBe(Date.UTC(2024, 1, 29, 0, 0, 0));
    expect(first).toBe(1709164800000);
    // 2025, 2026, 2027 are not leap years - the next fire after 2024's is 2028.
    // 2028-02-29 00:00:00Z = Date.UTC(2028,1,29,0,0,0) = 1835395200000.
    const second = nextFireTime(schedule, first!, "UTC");
    expect(second).toBe(Date.UTC(2028, 1, 29, 0, 0, 0));
    expect(second).toBe(1835395200000);
  });

  it("'0 12 13 * 5' (dom/dow OR rule) matches a hand-computed sequence of dates", () => {
    const schedule = parseCron("0 12 13 * 5");
    // Hand-computed against a real 2026 calendar (2026-01-01 is a Thursday):
    // Jan  2 Fri, Jan  9 Fri, Jan 13 Tue (dom), Jan 16 Fri, Jan 23 Fri,
    // Jan 30 Fri, Feb  6 Fri, Feb 13 Fri (both dom and dow, counted once).
    const expected = [
      Date.UTC(2026, 0, 2, 12, 0, 0),
      Date.UTC(2026, 0, 9, 12, 0, 0),
      Date.UTC(2026, 0, 13, 12, 0, 0),
      Date.UTC(2026, 0, 16, 12, 0, 0),
      Date.UTC(2026, 0, 23, 12, 0, 0),
      Date.UTC(2026, 0, 30, 12, 0, 0),
      Date.UTC(2026, 1, 6, 12, 0, 0),
      Date.UTC(2026, 1, 13, 12, 0, 0),
    ];
    const actual = nextFireTimes(schedule, Date.UTC(2026, 0, 1, 0, 0, 0), "UTC", expected.length);
    expect(actual).toEqual(expected);
  });

  it("numeric day-of-week ranges are equivalent to their name-range spelling", () => {
    const named = parseCron("0 9 * * MON-FRI");
    const numeric = parseCron("0 9 * * 1-5");
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(nextFireTimes(named, start, "UTC", 10)).toEqual(nextFireTimes(numeric, start, "UTC", 10));
  });
});

// ===========================================================================
// nextFireTime: minute alignment, strict-after, and the 5-year horizon
// ===========================================================================

describe("nextFireTime: alignment, strictness, and horizon", () => {
  it("truncates seconds/milliseconds of afterEpochMs before searching", () => {
    const schedule = parseCron("* * * * *");
    const withSeconds = Date.UTC(2026, 0, 1, 0, 0, 42, 500);
    const clean = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    // Regardless of the trailing seconds/ms, the next minute-aligned fire
    // strictly after either instant is the same: 00:01:00.000.
    expect(nextFireTime(schedule, withSeconds, "UTC")).toBe(clean + 60_000);
    expect(nextFireTime(schedule, clean, "UTC")).toBe(clean + 60_000);
  });

  it("is always minute-aligned (zero seconds, zero milliseconds)", () => {
    const schedule = parseCron("*/7 * * * *");
    for (const epoch of nextFireTimes(schedule, Date.UTC(2026, 0, 1, 0, 0, 0), "UTC", 20)) {
      expect(epoch % 60_000).toBe(0);
    }
  });

  it("returns the NEXT fire when called exactly at a fire time (strictly after)", () => {
    const schedule = parseCron("0 * * * *"); // every hour on the hour
    const exact = Date.UTC(2026, 0, 1, 5, 0, 0);
    const next = nextFireTime(schedule, exact, "UTC");
    expect(next).toBe(Date.UTC(2026, 0, 1, 6, 0, 0));
    expect(next).toBeGreaterThan(exact);
  });

  it("returns undefined within a bounded 5-year horizon for an impossible schedule (Feb 30)", () => {
    const schedule = parseCron("0 0 30 2 *"); // Feb never has a 30th
    const start = Date.now();
    const result = nextFireTime(schedule, Date.UTC(2026, 0, 1, 0, 0, 0), "UTC");
    const elapsedMs = Date.now() - start;
    expect(result).toBeUndefined();
    // Proves the search is bounded (field-jumping, not a multi-million-step
    // minute-by-minute scan): comfortably under a second in practice.
    expect(elapsedMs).toBeLessThan(2000);
  }, 10_000);

  it("nextFireTimes never hangs collecting from an impossible schedule", () => {
    const schedule = parseCron("0 0 31 2 *");
    const results = nextFireTimes(schedule, Date.UTC(2026, 0, 1, 0, 0, 0), "UTC", 5);
    expect(results).toEqual([]);
  }, 10_000);
});

// ===========================================================================
// nextFireTimes: monotonicity and count semantics
// ===========================================================================

describe("nextFireTimes", () => {
  it("produces exactly `count` strictly increasing epochs when the schedule fires often enough", () => {
    const schedule = parseCron("*/15 * * * *");
    const results = nextFireTimes(schedule, Date.UTC(2026, 0, 1, 0, 0, 0), "UTC", 6);
    expect(results).toHaveLength(6);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThan(results[i - 1]);
    }
  });

  it("each entry equals what nextFireTime would produce chained from the previous entry", () => {
    const schedule = parseCron("30 8,20 * * *");
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const results = nextFireTimes(schedule, start, "UTC", 5);
    let cursor = start;
    for (const epoch of results) {
      expect(nextFireTime(schedule, cursor, "UTC")).toBe(epoch);
      cursor = epoch;
    }
  });

  it("returns an empty array for count 0", () => {
    const schedule = parseCron("* * * * *");
    expect(nextFireTimes(schedule, Date.UTC(2026, 0, 1, 0, 0, 0), "UTC", 0)).toEqual([]);
  });

  it("rejects a negative count", () => {
    const schedule = parseCron("* * * * *");
    expect(() => nextFireTimes(schedule, 0, "UTC", -1)).toThrow(RangeError);
  });
});

// ===========================================================================
// Timezone correctness fixtures
// ===========================================================================

describe("timezone correctness", () => {
  it("UTC: baseline sanity (no offset)", () => {
    const schedule = parseCron("15 6 * * *");
    expect(nextFireTime(schedule, Date.UTC(2026, 0, 1, 0, 0, 0), "UTC")).toBe(Date.UTC(2026, 0, 1, 6, 15, 0));
  });

  it("America/New_York: an ordinary EST morning fire (no DST involved)", () => {
    // 2026-01-15 07:00 EST (UTC-5) = 2026-01-15T12:00:00Z.
    const schedule = parseCron("0 7 * * *");
    const next = nextFireTime(schedule, Date.UTC(2026, 0, 14, 12, 0, 0), "America/New_York");
    expect(next).toBe(Date.UTC(2026, 0, 15, 12, 0, 0));
  });

  it("Europe/Berlin: an ordinary CET morning fire (no DST involved)", () => {
    // 2026-01-15 07:00 CET (UTC+1) = 2026-01-15T06:00:00Z.
    const schedule = parseCron("0 7 * * *");
    const next = nextFireTime(schedule, Date.UTC(2026, 0, 14, 6, 0, 0), "Europe/Berlin");
    expect(next).toBe(Date.UTC(2026, 0, 15, 6, 0, 0));
  });

  it("Asia/Kolkata: a half-hour UTC offset (IST is UTC+5:30, no DST)", () => {
    // 2026-01-01 05:30 IST = 2026-01-01T00:00:00Z exactly.
    const schedule = parseCron("30 5 1 1 *");
    const next = nextFireTime(schedule, Date.UTC(2025, 11, 31, 0, 0, 0), "Asia/Kolkata");
    expect(next).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(next).toBe(1767225600000);
    expect(cronMatches(schedule, next!, "Asia/Kolkata")).toBe(true);
  });

  it("Asia/Kolkata: no DST means minute-by-minute matching never encounters an anomaly", () => {
    const schedule = parseCron("*/20 * * * *");
    for (const epoch of nextFireTimes(schedule, Date.UTC(2026, 5, 1, 0, 0, 0), "Asia/Kolkata", 50)) {
      expect(cronMatches(schedule, epoch, "Asia/Kolkata")).toBe(true);
    }
  });

  it("America/New_York 2026 spring-forward: a 02:30 job fires once, at the exact transition boundary", () => {
    // 2026-03-08: America/New_York clocks jump from 02:00 EST straight to
    // 03:00 EDT. 02:30 local never exists that day.
    //  - Verified via Intl: 2026-03-08T06:59:00Z reads as 01:59:00 EST, and
    //    2026-03-08T07:00:00Z reads as 03:00:00 EDT - the transition is
    //    exactly Date.UTC(2026,2,8,7,0,0) = 1772953200000.
    //  - Per this module's DST policy, a skipped wall-clock time resolves to
    //    that exact boundary instant (03:00:00 local), the first valid
    //    instant after the gap.
    const schedule = parseCron("30 2 * * *");
    const searchFrom = Date.UTC(2026, 2, 7, 10, 0, 0); // well after Mar 7's own 02:30 EST fire
    const next = nextFireTime(schedule, searchFrom, "America/New_York");
    expect(next).toBe(Date.UTC(2026, 2, 8, 7, 0, 0));
    expect(next).toBe(1772953200000);
    // The wall clock at that resolved instant reads 03:00, not 02:30 - this
    // module's cronMatches (a pure wall-clock read) correctly does NOT
    // consider that instant a schedule match; that is the documented,
    // deliberate exception carved out by the gap-resolution policy, not an
    // inconsistency in cronMatches itself.
    expect(cronMatches(schedule, next!, "America/New_York")).toBe(false);
  });

  it("America/New_York 2026 fall-back: a 01:30 job fires once, on the FIRST (earlier) occurrence", () => {
    // 2026-11-01: clocks fall back from 02:00 EDT to 01:00 EST, so 01:00-
    // 01:59 occurs twice: first as EDT (UTC-4), then again as EST (UTC-5).
    //  - First occurrence of 01:30: 01:30 EDT = 2026-11-01T05:30:00Z
    //    = Date.UTC(2026,10,1,5,30,0) = 1793511000000.
    //  - Second occurrence (must NOT be the one returned): 01:30 EST
    //    = 2026-11-01T06:30:00Z.
    const schedule = parseCron("30 1 * * *");
    const searchFrom = Date.UTC(2026, 9, 31, 10, 0, 0); // well after Oct 31's own 01:30 fire
    const next = nextFireTime(schedule, searchFrom, "America/New_York");
    expect(next).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
    expect(next).toBe(1793511000000);
    expect(next).not.toBe(Date.UTC(2026, 10, 1, 6, 30, 0));
    // The very next fire after that (the following day at 01:30) must be
    // strictly later and NOT the second (EST) occurrence of the same day.
    const after = nextFireTime(schedule, next!, "America/New_York");
    expect(after).toBe(Date.UTC(2026, 10, 2, 6, 30, 0)); // 2026-11-02 01:30 EST
  });

  it("Europe/Berlin 2026 spring-forward (last Sunday of March): a 02:30 job fires once, at the transition boundary", () => {
    // 2026-03-29: Europe/Berlin jumps from 02:00 CET to 03:00 CEST.
    //  - Verified via Intl: the transition instant is
    //    Date.UTC(2026,2,29,1,0,0) = 1774746000000 (02:00 CET == 01:00Z,
    //    03:00 CEST == 01:00Z - same instant, offset changes from +1 to +2).
    const schedule = parseCron("30 2 * * *");
    const searchFrom = Date.UTC(2026, 2, 28, 10, 0, 0);
    const next = nextFireTime(schedule, searchFrom, "Europe/Berlin");
    expect(next).toBe(Date.UTC(2026, 2, 29, 1, 0, 0));
    expect(next).toBe(1774746000000);
  });

  it("Europe/Berlin 2026 fall-back (last Sunday of October): a 02:30 job fires once, on the FIRST occurrence", () => {
    // 2026-10-25: Europe/Berlin falls back from 03:00 CEST to 02:00 CET.
    //  - First occurrence of 02:30: 02:30 CEST (UTC+2) = 2026-10-25T00:30:00Z
    //    = Date.UTC(2026,9,25,0,30,0) = 1792888200000.
    //  - Second occurrence (must NOT be returned): 02:30 CET (UTC+1)
    //    = 2026-10-25T01:30:00Z.
    const schedule = parseCron("30 2 * * *");
    const searchFrom = Date.UTC(2026, 9, 24, 10, 0, 0);
    const next = nextFireTime(schedule, searchFrom, "Europe/Berlin");
    expect(next).toBe(Date.UTC(2026, 9, 25, 0, 30, 0));
    expect(next).toBe(1792888200000);
    expect(next).not.toBe(Date.UTC(2026, 9, 25, 1, 30, 0));
  });

  it("throws a clear error for an invalid IANA time zone (never NaN)", () => {
    const schedule = parseCron("* * * * *");
    expect(() => cronMatches(schedule, 0, "Not/AZone")).toThrow(/Invalid IANA time zone/);
    expect(() => nextFireTime(schedule, 0, "Not/AZone")).toThrow(/Invalid IANA time zone/);
    expect(() => cronMatches(schedule, 0, "")).toThrow(/Invalid IANA time zone/);
  });
});

// ===========================================================================
// describeCron
// ===========================================================================

describe("describeCron", () => {
  it("is deterministic: the same schedule always describes the same way", () => {
    const schedule = parseCron("*/5 8-17 * * MON-FRI");
    expect(describeCron(schedule)).toBe(describeCron(parseCron("*/5 8-17 * * MON-FRI")));
  });

  it("produces a non-empty, human-readable string for every locked example", () => {
    for (const expr of ["* * * * *", "*/5 * * * *", "0 9 * * MON-FRI", "30 4 1 * *", "0 0 29 2 *", "0 12 13 * 5"]) {
      const text = describeCron(parseCron(expr));
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("describes 'every minute' for the full wildcard schedule", () => {
    expect(describeCron(parseCron("* * * * *"))).toBe("every minute");
  });

  it("mentions the restricted day-of-month value", () => {
    expect(describeCron(parseCron("30 4 1 * *"))).toContain("1");
  });

  it("mentions weekday names when day-of-week is restricted", () => {
    const text = describeCron(parseCron("0 9 * * MON-FRI"));
    expect(text).toMatch(/Monday/);
    expect(text).toMatch(/Friday/);
  });

  it("mentions the month name when month is restricted", () => {
    expect(describeCron(parseCron("0 0 29 2 *"))).toMatch(/February/);
  });

  it("differs between schedules that are not equivalent", () => {
    expect(describeCron(parseCron("0 9 * * *"))).not.toBe(describeCron(parseCron("0 17 * * *")));
  });
});

// ===========================================================================
// Fuzz: cronMatches / nextFireTime consistency over many random cases
//
// Restricted to the UTC zone deliberately: cronMatches is a pure wall-clock
// read, while a DST-gap-resolved nextFireTime can legitimately land on a
// wall-clock reading that differs from the schedule's literal fields (see
// the dedicated spring-forward tests above, which document and assert that
// exact, intentional exception). UTC has no DST, so in UTC the two
// functions must agree in 100% of cases with no carve-out required - which
// is exactly what this fuzz test is designed to prove at high volume.
// ===========================================================================

describe(`fuzz: cronMatches/nextFireTime consistency (seed 0x${FUZZ_SEED.toString(16)})`, () => {
  const CASE_COUNT = 500;

  function randomField(rand: () => number, min: number, max: number): string {
    const choice = Math.floor(rand() * 4);
    if (choice === 0) {
      return "*";
    }
    if (choice === 1) {
      const step = 1 + Math.floor(rand() * (max - min + 1));
      return `*/${step}`;
    }
    const a = min + Math.floor(rand() * (max - min + 1));
    if (choice === 2) {
      return String(a);
    }
    const b = a + Math.floor(rand() * (max - a + 1));
    return `${a}-${b}`;
  }

  function randomExpression(rand: () => number): string {
    return [
      randomField(rand, 0, 59),
      randomField(rand, 0, 23),
      randomField(rand, 1, 28), // stick to 1-28 so every month can satisfy it
      randomField(rand, 1, 12),
      randomField(rand, 0, 6),
    ].join(" ");
  }

  it(`holds for ${CASE_COUNT} randomized schedule/instant pairs`, () => {
    const rand = mulberry32(FUZZ_SEED);
    const yearStart = Date.UTC(2026, 0, 1, 0, 0, 0);
    const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;

    let checked = 0;
    for (let i = 0; i < CASE_COUNT; i++) {
      const expr = randomExpression(rand);
      let schedule: CronSchedule;
      try {
        schedule = parseCron(expr);
      } catch {
        // A random combination can occasionally produce a step larger than
        // its range span (deliberately rejected - see the parseCron tests
        // above); skip and keep the fuzz loop deterministic-but-forgiving.
        continue;
      }

      const instant = yearStart + Math.floor(rand() * twoYearsMs);
      const minuteAligned = Math.floor(instant / 60_000) * 60_000;

      const matches = cronMatches(schedule, minuteAligned, "UTC");
      if (matches) {
        // If this instant matches, it must BE the strict-after fire time
        // computed from one minute earlier.
        expect(nextFireTime(schedule, minuteAligned - 60_000, "UTC")).toBe(minuteAligned);
      }

      // Whatever nextFireTime finds strictly after this instant must itself
      // satisfy cronMatches (no DST involved in UTC, so no carve-out).
      const next = nextFireTime(schedule, minuteAligned, "UTC");
      if (next !== undefined) {
        expect(cronMatches(schedule, next, "UTC")).toBe(true);
        expect(next).toBeGreaterThan(minuteAligned);
      }
      checked += 1;
    }
    // Guard against the whole loop having been (im)possibly skipped.
    expect(checked).toBeGreaterThan(CASE_COUNT * 0.5);
  });
});

// ===========================================================================
// CronSchedule structural properties
// ===========================================================================

describe("CronSchedule structure", () => {
  it("returns readonly-shaped sets (no unexpected extra members) for a fully restricted schedule", () => {
    const schedule = parseCron("1,2,3 4 5 6 0");
    expect(sortedArray(schedule.minutes)).toEqual([1, 2, 3]);
    expect(sortedArray(schedule.hours)).toEqual([4]);
    expect(sortedArray(schedule.daysOfMonth)).toEqual([5]);
    expect(sortedArray(schedule.months)).toEqual([6]);
    expect(sortedArray(schedule.daysOfWeek)).toEqual([0]);
  });

  it("CronParseError is a real Error subclass with a name and optional field", () => {
    try {
      parseCron("99 * * * *");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(CronParseError);
      expect((err as CronParseError).name).toBe("CronParseError");
      expect((err as CronParseError).field).toBe("minute");
      expect(typeof (err as CronParseError).message).toBe("string");
    }
  });
});
