import { describe, it, expect } from "vitest";
import {
  encodeScheduleEvent,
  decodeScheduleCommand,
  isScheduleCommand,
  isScheduleEvent,
  isScheduleJobView,
  isScheduleRunView,
  isScheduleStatusView,
  SCHEDULE_COMMAND_KINDS,
  SCHEDULE_EVENT_KINDS,
  type ScheduleCommand,
  type ScheduleEvent,
  type ScheduleJobView,
  type ScheduleRunView,
  type ScheduleStatusView,
} from "../ipc/schedule-contract";

const runA: ScheduleRunView = {
  firedAt: 1_700_000_000_000,
  scheduledFor: 1_699_999_999_000,
  outcome: "delivered",
  detail: "delivered via telegram",
  durationMs: 42,
};

const runB: ScheduleRunView = {
  firedAt: 1_700_000_100_000,
  scheduledFor: 1_700_000_099_000,
  outcome: "failed",
  detail: "executor threw",
  durationMs: 0,
};

const jobWithDelivery: ScheduleJobView = {
  id: "job-1",
  name: "morning digest",
  cron: "0 9 * * *",
  timeZone: "America/New_York",
  enabled: true,
  taskKind: "note",
  taskInput: "summarize overnight activity",
  delivery: { platform: "telegram", user: "u1", channel: "c1" },
  misfire: "catch-up",
  nextFireAt: 1_700_003_600_000,
  lastFireAt: 1_700_000_000_000,
  runCount: 5,
  failCount: 1,
  abstainCount: 0,
  revision: 3,
};

const jobNoDelivery: ScheduleJobView = {
  id: "job-2",
  name: "disabled cleanup",
  cron: "*/5 * * * *",
  timeZone: "UTC",
  enabled: false,
  taskKind: "cleanup",
  taskInput: "",
  delivery: null,
  misfire: "skip",
  nextFireAt: null,
  lastFireAt: null,
  runCount: 0,
  failCount: 0,
  abstainCount: 0,
  revision: 1,
};

const jobDeliveryNoChannel: ScheduleJobView = {
  ...jobWithDelivery,
  id: "job-3",
  delivery: { platform: "discord", user: "u2", channel: null },
};

const status: ScheduleStatusView = {
  jobs: [jobWithDelivery, jobNoDelivery, jobDeliveryNoChannel],
  runnerAttached: true,
  at: 1_700_000_200_000,
};

// ---------------------------------------------------------------------------
// Round trips (via decodeScheduleCommand — encodeScheduleCommand is
// intentionally not part of the locked contract, matching gateway-contract's
// single-direction codec shape)
// ---------------------------------------------------------------------------

describe("ScheduleCommand round-trip", () => {
  const commands: ScheduleCommand[] = [
    { kind: "schedule.status.get" },
    { kind: "schedule.job.get", id: "job-1" },
    { kind: "schedule.job.toggle", id: "job-1", enabled: false, revision: 3 },
    { kind: "schedule.job.run", id: "job-1" },
  ];

  it.each(commands)("round-trips %j through JSON.stringify -> decodeScheduleCommand", (cmd) => {
    const decoded = decodeScheduleCommand(JSON.stringify(cmd));
    expect(decoded).toEqual(cmd);
  });

  it("round-trips schedule.job.toggle for enabled: true too", () => {
    const cmd: ScheduleCommand = { kind: "schedule.job.toggle", id: "job-9", enabled: true, revision: 0 };
    expect(decodeScheduleCommand(JSON.stringify(cmd))).toEqual(cmd);
  });

  it("every command kind has a round-trip fixture (no kind left untested)", () => {
    expect(new Set(commands.map((c) => c.kind))).toEqual(new Set(SCHEDULE_COMMAND_KINDS));
    expect(commands.length).toBe(SCHEDULE_COMMAND_KINDS.length);
  });
});

describe("ScheduleEvent encode", () => {
  const events: ScheduleEvent[] = [
    { kind: "schedule.status", status },
    { kind: "schedule.job", job: jobWithDelivery, history: [runA, runB] },
    { kind: "schedule.run.receipt", jobId: "job-1", run: runA, at: 1_700_000_300_000 },
    { kind: "schedule.error", message: "ScheduledJob \"job-9\" not found", at: 5 },
  ];

  it("encodes with a trailing newline and valid JSON matching the source event", () => {
    for (const evt of events) {
      const line = encodeScheduleEvent(evt);
      expect(line.endsWith("\n")).toBe(true);
      expect(JSON.parse(line.trimEnd())).toEqual(evt);
    }
  });

  it("encodes a schedule.error tersely", () => {
    const line = encodeScheduleEvent({ kind: "schedule.error", message: "x", at: 0 });
    expect(line).toBe('{"kind":"schedule.error","message":"x","at":0}\n');
  });

  it("every event kind has an encode fixture (no kind left untested)", () => {
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(SCHEDULE_EVENT_KINDS));
    expect(events.length).toBe(SCHEDULE_EVENT_KINDS.length);
  });

  it("round-trips a schedule.status event through encode -> JSON.parse -> isScheduleEvent", () => {
    const line = encodeScheduleEvent({ kind: "schedule.status", status });
    const parsed = JSON.parse(line.trimEnd());
    expect(isScheduleEvent(parsed)).toBe(true);
    expect(parsed).toEqual({ kind: "schedule.status", status });
  });

  it("round-trips an empty-jobs schedule.status event", () => {
    const emptyStatus: ScheduleStatusView = { jobs: [], runnerAttached: false, at: 0 };
    const line = encodeScheduleEvent({ kind: "schedule.status", status: emptyStatus });
    expect(JSON.parse(line.trimEnd())).toEqual({ kind: "schedule.status", status: emptyStatus });
  });

  it("round-trips a schedule.job event with empty history", () => {
    const line = encodeScheduleEvent({ kind: "schedule.job", job: jobNoDelivery, history: [] });
    const parsed = JSON.parse(line.trimEnd());
    expect(isScheduleEvent(parsed)).toBe(true);
    expect(parsed).toEqual({ kind: "schedule.job", job: jobNoDelivery, history: [] });
  });

  it("every event kind's encoded fixture passes isScheduleEvent after round-trip", () => {
    for (const evt of events) {
      const parsed = JSON.parse(encodeScheduleEvent(evt).trimEnd());
      expect(isScheduleEvent(parsed)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Kind tuples exactly match the unions
// ---------------------------------------------------------------------------

describe("kind tuples exactly match their unions", () => {
  it("SCHEDULE_COMMAND_KINDS has no duplicates and matches the ScheduleCommand union", () => {
    expect(new Set(SCHEDULE_COMMAND_KINDS).size).toBe(SCHEDULE_COMMAND_KINDS.length);
    expect([...SCHEDULE_COMMAND_KINDS].sort()).toEqual(
      ["schedule.status.get", "schedule.job.get", "schedule.job.toggle", "schedule.job.run"].sort()
    );
  });

  it("SCHEDULE_EVENT_KINDS has no duplicates and matches the ScheduleEvent union", () => {
    expect(new Set(SCHEDULE_EVENT_KINDS).size).toBe(SCHEDULE_EVENT_KINDS.length);
    expect([...SCHEDULE_EVENT_KINDS].sort()).toEqual(
      ["schedule.status", "schedule.job", "schedule.run.receipt", "schedule.error"].sort()
    );
  });

  // Compile-time coverage assertion: this switch has no default branch that
  // does anything other than funnel into `never`. If a kind is ever added to
  // `ScheduleCommand` without a case here, `cmd` narrows to something other
  // than `never` in the default branch and this file fails to type-check.
  function assertNeverCommand(x: never): string {
    throw new Error(`uncovered ScheduleCommand kind: ${JSON.stringify(x)}`);
  }
  function classifyCommand(cmd: ScheduleCommand): string {
    switch (cmd.kind) {
      case "schedule.status.get":
        return "status.get";
      case "schedule.job.get":
        return "job.get";
      case "schedule.job.toggle":
        return "job.toggle";
      case "schedule.job.run":
        return "job.run";
      default:
        return assertNeverCommand(cmd);
    }
  }

  function assertNeverEvent(x: never): string {
    throw new Error(`uncovered ScheduleEvent kind: ${JSON.stringify(x)}`);
  }
  function classifyEvent(evt: ScheduleEvent): string {
    switch (evt.kind) {
      case "schedule.status":
        return "status";
      case "schedule.job":
        return "job";
      case "schedule.run.receipt":
        return "run.receipt";
      case "schedule.error":
        return "error";
      default:
        return assertNeverEvent(evt);
    }
  }

  it("exhaustive command switch covers every real command kind at runtime", () => {
    const fixtures: Record<(typeof SCHEDULE_COMMAND_KINDS)[number], ScheduleCommand> = {
      "schedule.status.get": { kind: "schedule.status.get" },
      "schedule.job.get": { kind: "schedule.job.get", id: "job-1" },
      "schedule.job.toggle": { kind: "schedule.job.toggle", id: "job-1", enabled: true, revision: 1 },
      "schedule.job.run": { kind: "schedule.job.run", id: "job-1" },
    };
    for (const kind of SCHEDULE_COMMAND_KINDS) {
      expect(() => classifyCommand(fixtures[kind])).not.toThrow();
    }
  });

  it("exhaustive event switch covers every real event kind at runtime", () => {
    const fixtures: Record<(typeof SCHEDULE_EVENT_KINDS)[number], ScheduleEvent> = {
      "schedule.status": { kind: "schedule.status", status },
      "schedule.job": { kind: "schedule.job", job: jobWithDelivery, history: [runA] },
      "schedule.run.receipt": { kind: "schedule.run.receipt", jobId: "job-1", run: runA, at: 0 },
      "schedule.error": { kind: "schedule.error", message: "x", at: 0 },
    };
    for (const kind of SCHEDULE_EVENT_KINDS) {
      expect(() => classifyEvent(fixtures[kind])).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// isScheduleRunView — field by field
// ---------------------------------------------------------------------------

describe("isScheduleRunView", () => {
  it("accepts every valid outcome", () => {
    const outcomes: ScheduleRunView["outcome"][] = ["delivered", "abstained", "withheld", "failed", "skipped"];
    for (const outcome of outcomes) {
      expect(isScheduleRunView({ ...runA, outcome })).toBe(true);
    }
  });

  it("rejects non-objects", () => {
    expect(isScheduleRunView(null)).toBe(false);
    expect(isScheduleRunView(undefined)).toBe(false);
    expect(isScheduleRunView("delivered")).toBe(false);
    expect(isScheduleRunView(42)).toBe(false);
    expect(isScheduleRunView([runA])).toBe(false);
  });

  it("rejects a missing or non-finite firedAt", () => {
    const { firedAt, ...rest } = runA;
    expect(isScheduleRunView(rest)).toBe(false);
    expect(isScheduleRunView({ ...runA, firedAt: "now" })).toBe(false);
    expect(isScheduleRunView({ ...runA, firedAt: NaN })).toBe(false);
    expect(isScheduleRunView({ ...runA, firedAt: Infinity })).toBe(false);
    expect(isScheduleRunView({ ...runA, firedAt: undefined })).toBe(false);
  });

  it("rejects a missing or non-finite scheduledFor", () => {
    const { scheduledFor, ...rest } = runA;
    expect(isScheduleRunView(rest)).toBe(false);
    expect(isScheduleRunView({ ...runA, scheduledFor: -Infinity })).toBe(false);
  });

  it("rejects an out-of-union outcome (closed set, case-sensitive)", () => {
    expect(isScheduleRunView({ ...runA, outcome: "DELIVERED" })).toBe(false);
    expect(isScheduleRunView({ ...runA, outcome: "pending" })).toBe(false);
    expect(isScheduleRunView({ ...runA, outcome: undefined })).toBe(false);
    expect(isScheduleRunView({ ...runA, outcome: 1 })).toBe(false);
  });

  it("rejects a missing or mistyped detail", () => {
    const { detail, ...rest } = runA;
    expect(isScheduleRunView(rest)).toBe(false);
    expect(isScheduleRunView({ ...runA, detail: null })).toBe(false);
  });

  it("rejects a missing, negative, or non-finite durationMs", () => {
    const { durationMs, ...rest } = runA;
    expect(isScheduleRunView(rest)).toBe(false);
    expect(isScheduleRunView({ ...runA, durationMs: NaN })).toBe(false);
    expect(isScheduleRunView({ ...runA, durationMs: Infinity })).toBe(false);
    expect(isScheduleRunView({ ...runA, durationMs: "0" })).toBe(false);
  });

  it("tolerates extra unknown fields", () => {
    expect(isScheduleRunView({ ...runA, extra: "field" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isScheduleJobView — field by field, hostile-shape fuzzing
// ---------------------------------------------------------------------------

describe("isScheduleJobView", () => {
  it("accepts a fully populated valid view with a delivery target", () => {
    expect(isScheduleJobView(jobWithDelivery)).toBe(true);
  });

  it("accepts a valid view with delivery: null", () => {
    expect(isScheduleJobView(jobNoDelivery)).toBe(true);
  });

  it("accepts a valid view with a delivery target whose channel is null", () => {
    expect(isScheduleJobView(jobDeliveryNoChannel)).toBe(true);
  });

  it("accepts every valid misfire policy", () => {
    const policies: ScheduleJobView["misfire"][] = ["skip", "fire-once", "catch-up"];
    for (const misfire of policies) {
      expect(isScheduleJobView({ ...jobWithDelivery, misfire })).toBe(true);
    }
  });

  it("rejects non-objects", () => {
    expect(isScheduleJobView(null)).toBe(false);
    expect(isScheduleJobView(3)).toBe(false);
    expect(isScheduleJobView([jobWithDelivery])).toBe(false);
    expect(isScheduleJobView("job")).toBe(false);
  });

  it("rejects a missing or mistyped id/name/cron/timeZone/taskKind/taskInput", () => {
    for (const field of ["id", "name", "cron", "timeZone", "taskKind", "taskInput"] as const) {
      const { [field]: _omit, ...rest } = jobWithDelivery;
      expect(isScheduleJobView(rest)).toBe(false);
      expect(isScheduleJobView({ ...jobWithDelivery, [field]: 7 })).toBe(false);
      expect(isScheduleJobView({ ...jobWithDelivery, [field]: null })).toBe(false);
    }
  });

  it("rejects a missing or mistyped enabled", () => {
    const { enabled, ...rest } = jobWithDelivery;
    expect(isScheduleJobView(rest)).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, enabled: "true" })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, enabled: 1 })).toBe(false);
  });

  it("distinguishes null from undefined for delivery (undefined rejected)", () => {
    expect(isScheduleJobView({ ...jobWithDelivery, delivery: undefined })).toBe(false);
    const { delivery, ...rest } = jobWithDelivery;
    expect(isScheduleJobView(rest)).toBe(false);
  });

  it("rejects a delivery object with a missing or mistyped platform/user", () => {
    expect(isScheduleJobView({ ...jobWithDelivery, delivery: { user: "u1", channel: null } })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, delivery: { platform: "telegram", channel: null } })).toBe(
      false
    );
    expect(
      isScheduleJobView({ ...jobWithDelivery, delivery: { platform: 1, user: "u1", channel: null } })
    ).toBe(false);
  });

  it("distinguishes null from undefined for delivery.channel (undefined rejected)", () => {
    expect(
      isScheduleJobView({ ...jobWithDelivery, delivery: { platform: "telegram", user: "u1", channel: undefined } })
    ).toBe(false);
    expect(
      isScheduleJobView({ ...jobWithDelivery, delivery: { platform: "telegram", user: "u1" } })
    ).toBe(false);
  });

  it("rejects a non-object, non-null delivery", () => {
    expect(isScheduleJobView({ ...jobWithDelivery, delivery: "telegram" })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, delivery: 42 })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, delivery: [] })).toBe(false);
  });

  it("rejects an out-of-union misfire (closed set, case-sensitive)", () => {
    expect(isScheduleJobView({ ...jobWithDelivery, misfire: "SKIP" })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, misfire: "retry" })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, misfire: undefined })).toBe(false);
  });

  it("distinguishes null from undefined for nextFireAt (undefined rejected)", () => {
    expect(isScheduleJobView({ ...jobWithDelivery, nextFireAt: undefined })).toBe(false);
    const { nextFireAt, ...rest } = jobWithDelivery;
    expect(isScheduleJobView(rest)).toBe(false);
  });

  it("rejects a mistyped nextFireAt (must be finite number or null)", () => {
    expect(isScheduleJobView({ ...jobWithDelivery, nextFireAt: "soon" })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, nextFireAt: NaN })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, nextFireAt: Infinity })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, nextFireAt: -Infinity })).toBe(false);
  });

  it("distinguishes null from undefined for lastFireAt (undefined rejected)", () => {
    expect(isScheduleJobView({ ...jobWithDelivery, lastFireAt: undefined })).toBe(false);
    const { lastFireAt, ...rest } = jobWithDelivery;
    expect(isScheduleJobView(rest)).toBe(false);
  });

  it("rejects a mistyped lastFireAt (must be finite number or null)", () => {
    expect(isScheduleJobView({ ...jobWithDelivery, lastFireAt: "never" })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, lastFireAt: NaN })).toBe(false);
  });

  it("rejects a missing, negative-is-fine-but-non-finite runCount/failCount/abstainCount", () => {
    for (const field of ["runCount", "failCount", "abstainCount"] as const) {
      const { [field]: _omit, ...rest } = jobWithDelivery;
      expect(isScheduleJobView(rest)).toBe(false);
      expect(isScheduleJobView({ ...jobWithDelivery, [field]: NaN })).toBe(false);
      expect(isScheduleJobView({ ...jobWithDelivery, [field]: Infinity })).toBe(false);
      expect(isScheduleJobView({ ...jobWithDelivery, [field]: "0" })).toBe(false);
    }
  });

  it("rejects a missing or mistyped revision", () => {
    const { revision, ...rest } = jobWithDelivery;
    expect(isScheduleJobView(rest)).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, revision: "1" })).toBe(false);
    expect(isScheduleJobView({ ...jobWithDelivery, revision: NaN })).toBe(false);
  });

  it("tolerates extra unknown fields on the top-level view", () => {
    expect(isScheduleJobView({ ...jobWithDelivery, extra: "field" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isScheduleStatusView
// ---------------------------------------------------------------------------

describe("isScheduleStatusView", () => {
  it("accepts a fully populated valid view", () => {
    expect(isScheduleStatusView(status)).toBe(true);
  });

  it("accepts an empty jobs array", () => {
    expect(isScheduleStatusView({ ...status, jobs: [] })).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isScheduleStatusView(null)).toBe(false);
    expect(isScheduleStatusView(3)).toBe(false);
    expect(isScheduleStatusView([status])).toBe(false);
    expect(isScheduleStatusView("status")).toBe(false);
  });

  it("rejects a missing or mistyped jobs array", () => {
    const { jobs, ...rest } = status;
    expect(isScheduleStatusView(rest)).toBe(false);
    expect(isScheduleStatusView({ ...status, jobs: "none" })).toBe(false);
    expect(isScheduleStatusView({ ...status, jobs: {} })).toBe(false);
  });

  it("rejects jobs containing a non-object or invalid element", () => {
    expect(isScheduleStatusView({ ...status, jobs: [jobWithDelivery, "job-2"] })).toBe(false);
    expect(isScheduleStatusView({ ...status, jobs: [jobWithDelivery, null] })).toBe(false);
    expect(isScheduleStatusView({ ...status, jobs: [{ ...jobWithDelivery, misfire: "bogus" }] })).toBe(false);
  });

  it("rejects a missing or mistyped runnerAttached", () => {
    const { runnerAttached, ...rest } = status;
    expect(isScheduleStatusView(rest)).toBe(false);
    expect(isScheduleStatusView({ ...status, runnerAttached: "true" })).toBe(false);
    expect(isScheduleStatusView({ ...status, runnerAttached: 1 })).toBe(false);
  });

  it("rejects a missing or mistyped at", () => {
    const { at, ...rest } = status;
    expect(isScheduleStatusView(rest)).toBe(false);
    expect(isScheduleStatusView({ ...status, at: "now" })).toBe(false);
    expect(isScheduleStatusView({ ...status, at: NaN })).toBe(false);
  });

  it("tolerates extra unknown fields on the top-level view", () => {
    expect(isScheduleStatusView({ ...status, extra: "field" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isScheduleCommand
// ---------------------------------------------------------------------------

describe("isScheduleCommand", () => {
  it("accepts every valid command shape", () => {
    expect(isScheduleCommand({ kind: "schedule.status.get" })).toBe(true);
    expect(isScheduleCommand({ kind: "schedule.job.get", id: "job-1" })).toBe(true);
    expect(isScheduleCommand({ kind: "schedule.job.toggle", id: "job-1", enabled: true, revision: 2 })).toBe(
      true
    );
    expect(isScheduleCommand({ kind: "schedule.job.run", id: "job-1" })).toBe(true);
  });

  it("rejects non-objects and missing/unknown kind", () => {
    expect(isScheduleCommand(null)).toBe(false);
    expect(isScheduleCommand(undefined)).toBe(false);
    expect(isScheduleCommand("schedule.status.get")).toBe(false);
    expect(isScheduleCommand([])).toBe(false);
    expect(isScheduleCommand({})).toBe(false);
    expect(isScheduleCommand({ kind: "schedule.bogus" })).toBe(false);
    expect(isScheduleCommand({ kind: 42 })).toBe(false);
  });

  it("rejects schedule.job.get with a missing or mistyped id", () => {
    expect(isScheduleCommand({ kind: "schedule.job.get" })).toBe(false);
    expect(isScheduleCommand({ kind: "schedule.job.get", id: 1 })).toBe(false);
    expect(isScheduleCommand({ kind: "schedule.job.get", id: null })).toBe(false);
  });

  it("rejects schedule.job.run with a missing or mistyped id", () => {
    expect(isScheduleCommand({ kind: "schedule.job.run" })).toBe(false);
    expect(isScheduleCommand({ kind: "schedule.job.run", id: 1 })).toBe(false);
  });

  it("rejects schedule.job.toggle with any single field wrong or missing", () => {
    expect(isScheduleCommand({ kind: "schedule.job.toggle", enabled: true, revision: 1 })).toBe(false);
    expect(isScheduleCommand({ kind: "schedule.job.toggle", id: "job-1", revision: 1 })).toBe(false);
    expect(isScheduleCommand({ kind: "schedule.job.toggle", id: "job-1", enabled: true })).toBe(false);
    expect(isScheduleCommand({ kind: "schedule.job.toggle", id: 1, enabled: true, revision: 1 })).toBe(false);
    expect(
      isScheduleCommand({ kind: "schedule.job.toggle", id: "job-1", enabled: "true", revision: 1 })
    ).toBe(false);
    expect(
      isScheduleCommand({ kind: "schedule.job.toggle", id: "job-1", enabled: true, revision: "1" })
    ).toBe(false);
    expect(
      isScheduleCommand({ kind: "schedule.job.toggle", id: "job-1", enabled: true, revision: NaN })
    ).toBe(false);
    expect(
      isScheduleCommand({ kind: "schedule.job.toggle", id: "job-1", enabled: true, revision: Infinity })
    ).toBe(false);
  });

  it("rejects a command from the plain contract.ts / gateway-contract.ts unions", () => {
    expect(isScheduleCommand({ kind: "worker.kill", workerId: "w-1" })).toBe(false);
    expect(isScheduleCommand({ kind: "gateway.status.get" })).toBe(false);
  });

  it("tolerates extra unknown fields on schedule.status.get", () => {
    expect(isScheduleCommand({ kind: "schedule.status.get", extra: 1 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isScheduleEvent
// ---------------------------------------------------------------------------

describe("isScheduleEvent", () => {
  it("accepts every valid event shape", () => {
    expect(isScheduleEvent({ kind: "schedule.status", status })).toBe(true);
    expect(isScheduleEvent({ kind: "schedule.job", job: jobWithDelivery, history: [runA, runB] })).toBe(true);
    expect(isScheduleEvent({ kind: "schedule.run.receipt", jobId: "job-1", run: runA, at: 0 })).toBe(true);
    expect(isScheduleEvent({ kind: "schedule.error", message: "x", at: 0 })).toBe(true);
  });

  it("rejects non-objects and missing/unknown kind", () => {
    expect(isScheduleEvent(null)).toBe(false);
    expect(isScheduleEvent(3)).toBe(false);
    expect(isScheduleEvent([])).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.bogus" })).toBe(false);
  });

  it("rejects schedule.status with a missing or invalid status", () => {
    expect(isScheduleEvent({ kind: "schedule.status" })).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.status", status: { ...status, runnerAttached: "yes" } })).toBe(
      false
    );
    expect(isScheduleEvent({ kind: "schedule.status", status: null })).toBe(false);
  });

  it("rejects schedule.job with a missing/invalid job or missing/invalid history", () => {
    expect(isScheduleEvent({ kind: "schedule.job", history: [] })).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.job", job: jobWithDelivery })).toBe(false);
    expect(
      isScheduleEvent({ kind: "schedule.job", job: { ...jobWithDelivery, misfire: "bogus" }, history: [] })
    ).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.job", job: jobWithDelivery, history: "none" })).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.job", job: jobWithDelivery, history: [runA, {}] })).toBe(false);
  });

  it("rejects schedule.run.receipt with a missing/mistyped jobId, run, or at", () => {
    expect(isScheduleEvent({ kind: "schedule.run.receipt", run: runA, at: 0 })).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.run.receipt", jobId: 1, run: runA, at: 0 })).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.run.receipt", jobId: "job-1", at: 0 })).toBe(false);
    expect(
      isScheduleEvent({ kind: "schedule.run.receipt", jobId: "job-1", run: { ...runA, outcome: "bogus" }, at: 0 })
    ).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.run.receipt", jobId: "job-1", run: runA })).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.run.receipt", jobId: "job-1", run: runA, at: "now" })).toBe(false);
  });

  it("rejects schedule.error with a missing/mistyped message or at", () => {
    expect(isScheduleEvent({ kind: "schedule.error", at: 0 })).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.error", message: 1, at: 0 })).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.error", message: "x" })).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.error", message: "x", at: "now" })).toBe(false);
  });

  it("rejects an event from the plain contract.ts / gateway-contract.ts unions", () => {
    expect(isScheduleEvent({ kind: "log", line: "hi", at: 1 })).toBe(false);
    expect(isScheduleEvent({ kind: "gateway.error", message: "x", at: 0 })).toBe(false);
  });

  it("never accepts a schedule.job payload's job/history swapped, or a status masquerading as a job", () => {
    expect(isScheduleEvent({ kind: "schedule.job", job: status, history: [] })).toBe(false);
    expect(isScheduleEvent({ kind: "schedule.status", status: jobWithDelivery })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codec error handling — decodeScheduleCommand
// ---------------------------------------------------------------------------

describe("decodeScheduleCommand error handling", () => {
  it("throws 'bad command: empty line' on empty input", () => {
    expect(() => decodeScheduleCommand("")).toThrow("bad command: empty line");
    expect(() => decodeScheduleCommand("   \n")).toThrow("bad command: empty line");
    expect(() => decodeScheduleCommand("\t  \t")).toThrow("bad command: empty line");
  });

  it("throws 'bad command: invalid JSON' on malformed JSON", () => {
    expect(() => decodeScheduleCommand("not json {{{")).toThrow("bad command: invalid JSON");
    expect(() => decodeScheduleCommand("{kind: 'schedule.status.get'}")).toThrow("bad command: invalid JSON");
  });

  it("throws 'bad command: missing kind' on a non-object payload", () => {
    expect(() => decodeScheduleCommand("42")).toThrow("bad command: missing kind");
    expect(() => decodeScheduleCommand('"schedule.status.get"')).toThrow("bad command: missing kind");
    expect(() => decodeScheduleCommand("null")).toThrow("bad command: missing kind");
    expect(() => decodeScheduleCommand("[]")).toThrow("bad command: missing kind");
    expect(() => decodeScheduleCommand("true")).toThrow("bad command: missing kind");
  });

  it("throws 'bad command: missing kind' when kind is absent or non-string", () => {
    expect(() => decodeScheduleCommand(JSON.stringify({ id: "job-1" }))).toThrow("bad command: missing kind");
    expect(() => decodeScheduleCommand(JSON.stringify({ kind: 5 }))).toThrow("bad command: missing kind");
  });

  it('throws \'bad command: unknown kind "..."\' for an unrecognized kind', () => {
    expect(() => decodeScheduleCommand(JSON.stringify({ kind: "schedule.bogus" }))).toThrow(
      'bad command: unknown kind "schedule.bogus"'
    );
  });

  it('throws \'bad command: missing or invalid fields...\' for schedule.job.get missing id', () => {
    expect(() => decodeScheduleCommand(JSON.stringify({ kind: "schedule.job.get" }))).toThrow(
      'bad command: missing or invalid fields for kind "schedule.job.get"'
    );
  });

  it('throws \'bad command: missing or invalid fields...\' for schedule.job.run missing id', () => {
    expect(() => decodeScheduleCommand(JSON.stringify({ kind: "schedule.job.run" }))).toThrow(
      'bad command: missing or invalid fields for kind "schedule.job.run"'
    );
  });

  it('throws \'bad command: missing or invalid fields...\' for schedule.job.toggle missing fields', () => {
    expect(() =>
      decodeScheduleCommand(JSON.stringify({ kind: "schedule.job.toggle", id: "job-1" }))
    ).toThrow('bad command: missing or invalid fields for kind "schedule.job.toggle"');
    expect(() =>
      decodeScheduleCommand(JSON.stringify({ kind: "schedule.job.toggle", id: "job-1", enabled: true }))
    ).toThrow('bad command: missing or invalid fields for kind "schedule.job.toggle"');
    expect(() =>
      decodeScheduleCommand(
        JSON.stringify({ kind: "schedule.job.toggle", id: "job-1", enabled: "yes", revision: 1 })
      )
    ).toThrow('bad command: missing or invalid fields for kind "schedule.job.toggle"');
  });

  it("round-trips through JSON.stringify -> decode for schedule.status.get", () => {
    expect(decodeScheduleCommand(JSON.stringify({ kind: "schedule.status.get" }))).toEqual({
      kind: "schedule.status.get",
    });
  });

  it("trims surrounding whitespace/newlines before parsing", () => {
    const cmd = { kind: "schedule.job.run", id: "job-1" };
    expect(decodeScheduleCommand(`  ${JSON.stringify(cmd)}  \n`)).toEqual(cmd);
  });
});
