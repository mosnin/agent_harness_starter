/**
 * Central-integration tests for the SCHEDULE pane inside TuiApp: the `d` key
 * toggles the pane (asking central wiring for a fresh snapshot on open), the
 * pane renders its honest empty states until real data arrives,
 * `setScheduleData` lays a real `buildSchedulePaneSnapshot`-shaped snapshot
 * into the pure pane state, navigation keys drive the pane's own keymap, and
 * esc/q returns to the dashboard.
 */
import { describe, it, expect, vi } from "vitest";
import { TuiApp } from "../tui/app";
import { keyToAction } from "../tui/keymap";
import type { SchedulePaneJobRow, SchedulePaneRunRow } from "../tui/schedule-pane";

function jobRow(i: number, overrides: Partial<SchedulePaneJobRow> = {}): SchedulePaneJobRow {
  return {
    id: `job-${i}`,
    name: `job number ${i}`,
    cron: "*/5 * * * *",
    timeZone: "UTC",
    enabled: true,
    taskKind: "note",
    deliveryTarget: null,
    nextFireAt: 1_700_000_000_000 + i,
    lastOutcome: null,
    runCount: 0,
    failCount: 0,
    abstainCount: 0,
    ...overrides,
  };
}

function runRow(i: number): SchedulePaneRunRow {
  return {
    jobId: `job-${i}`,
    jobName: `job number ${i}`,
    firedAt: 1_700_000_000_000 + i,
    scheduledFor: 1_700_000_000_000 + i,
    outcome: "abstained",
    detail: `run detail ${i}`,
    durationMs: 3,
  };
}

describe("keymap: d toggles the SCHEDULE pane", () => {
  it("maps d to the schedule pane action in view mode, and to plain input in compose mode", () => {
    expect(keyToAction("d", "view")).toEqual({ kind: "pane", pane: "schedule" });
    expect(keyToAction("d", "compose")).toEqual({ kind: "input", char: "d" });
  });
});

describe("TuiApp: SCHEDULE pane", () => {
  it("d opens the pane (requesting a refresh from central wiring), renders honest empties, and d/esc/q leave it", () => {
    const refreshSchedule = vi.fn();
    const app = new TuiApp({
      controller: {
        dispatchGoal: () => {},
        scalePool: () => {},
        cancel: () => {},
        refreshSchedule,
      },
    });

    expect(app.activePane()).toBe("dashboard");
    app.handleKey("d");
    expect(app.activePane()).toBe("schedule");
    expect(refreshSchedule).toHaveBeenCalledTimes(1);

    const frame = app.frame();
    expect(frame).toContain("SCHEDULE");
    expect(frame).toContain("no scheduled jobs");
    expect(frame).toContain("runner: not attached");
    expect(frame).toContain("no runs yet");
    expect(frame).toContain("no completed runs yet");
    expect(frame).toContain("[r] refresh");

    // r while open re-requests fresh data.
    app.handleKey("r");
    expect(refreshSchedule).toHaveBeenCalledTimes(2);

    // Toggle back with d; reopen; escape out; reopen; q backs out (never quits from the pane).
    app.handleKey("d");
    expect(app.activePane()).toBe("dashboard");
    app.handleKey("d");
    app.handleKey("\x1b");
    expect(app.activePane()).toBe("dashboard");
    app.handleKey("d");
    const result = app.handleKey("q");
    expect(result.quit).toBeUndefined();
    expect(app.activePane()).toBe("dashboard");

    // The dashboard footer advertises the pane.
    expect(app.frame()).toContain("[d] schedule");
  });

  it("setScheduleData lays a snapshot into the pane and navigation moves the JOBS selection", () => {
    const app = new TuiApp({});
    app.handleKey("d");
    app.setScheduleData({
      jobs: [jobRow(0), jobRow(1, { enabled: false }), jobRow(2)],
      runs: [runRow(2), runRow(1)],
      tally: { delivered: 1, abstained: 1, withheld: 0, failed: 0, skipped: 0 },
      runnerRunning: null,
    });

    const frame = app.frame();
    expect(frame).toContain("JOBS (3)");
    expect(frame).toContain("job number 0");
    expect(frame).toContain("disabled"); // the disabled job's next-fire slot is honest
    expect(frame).toContain("RUNS (2)");
    expect(frame).toContain("run detail 2");
    expect(frame).toContain("delivered=1");
    expect(frame).toContain("runner: not attached");

    expect(app.scheduleState().selected).toBe(0);
    app.handleKey("j");
    expect(app.scheduleState().selected).toBe(1);
    app.handleKey("down");
    expect(app.scheduleState().selected).toBe(2);
    app.handleKey("down"); // clamped at the last row
    expect(app.scheduleState().selected).toBe(2);
    app.handleKey("home");
    expect(app.scheduleState().selected).toBe(0);
    app.handleKey("end");
    expect(app.scheduleState().selected).toBe(2);
    app.handleKey("k");
    expect(app.scheduleState().selected).toBe(1);
  });

  it("a refreshed, shorter snapshot re-clamps the selection instead of pointing past the list", () => {
    const app = new TuiApp({});
    app.handleKey("d");
    app.setScheduleData({ jobs: [jobRow(0), jobRow(1), jobRow(2)], runs: [], tally: null, runnerRunning: null });
    app.handleKey("end");
    expect(app.scheduleState().selected).toBe(2);

    app.setScheduleData({ jobs: [jobRow(0)], runs: [], tally: null, runnerRunning: null });
    expect(app.scheduleState().selected).toBe(0);
    expect(() => app.frame()).not.toThrow();
  });

  it("adversarial job names never leak control bytes into the frame", () => {
    const app = new TuiApp({});
    app.handleKey("d");
    app.setScheduleData({
      jobs: [jobRow(0, { name: "evil\u001b[2Jnamewith\ncontrols" })],
      runs: [],
      tally: null,
      runnerRunning: false,
    });
    const frame = app.frame();
    // The pane's sanitizer strips ESC/C0 bytes; the frame itself contains
    // exactly one ESC-free SCHEDULE box (the app's own frame() adds no ANSI
    // around pane output).
    const paneLines = frame.split("\n").filter((l) => l.startsWith("╭") || l.startsWith("│") || l.startsWith("╰"));
    for (const line of paneLines) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(frame).toContain("runner: stopped");
  });
});
