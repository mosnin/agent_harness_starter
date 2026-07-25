import { describe, expect, it } from "vitest";

import {
  initialSchedulePaneState,
  pushRun,
  renderSchedulePane,
  schedulePaneKey,
  type SchedulePaneJobRow,
  type SchedulePaneRunRow,
  type SchedulePaneState,
  type SchedulePaneTally,
} from "../tui/schedule-pane";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<SchedulePaneJobRow> = {}): SchedulePaneJobRow {
  return {
    id: "job-1",
    name: "daily digest",
    cron: "30 9 * * 1-5",
    timeZone: "America/New_York",
    enabled: true,
    taskKind: "digest",
    deliveryTarget: "telegram:U1",
    nextFireAt: 1_700_000_000_000,
    lastOutcome: "delivered",
    runCount: 5,
    failCount: 1,
    abstainCount: 0,
    ...overrides,
  };
}

function makeDisabledJob(overrides: Partial<SchedulePaneJobRow> = {}): SchedulePaneJobRow {
  return {
    id: "job-2",
    name: "weekly report",
    cron: "0 8 * * 1",
    timeZone: "UTC",
    enabled: false,
    taskKind: "report",
    deliveryTarget: null,
    nextFireAt: null,
    lastOutcome: null,
    runCount: 0,
    failCount: 0,
    abstainCount: 0,
    ...overrides,
  };
}

function makeRun(overrides: Partial<SchedulePaneRunRow> = {}): SchedulePaneRunRow {
  return {
    jobId: "job-1",
    jobName: "daily digest",
    firedAt: 1_699_999_000_000,
    scheduledFor: 1_699_998_900_000,
    outcome: "delivered",
    detail: "sent via telegram",
    durationMs: 1234,
    ...overrides,
  };
}

const REAL_TALLY: SchedulePaneTally = { delivered: 4, abstained: 1, withheld: 0, failed: 1, skipped: 0 };
const ZERO_TALLY: SchedulePaneTally = { delivered: 0, abstained: 0, withheld: 0, failed: 0, skipped: 0 };

function makePopulatedState(overrides: Partial<SchedulePaneState> = {}): SchedulePaneState {
  return {
    jobs: [makeJob(), makeDisabledJob()],
    runs: [makeRun()],
    tally: REAL_TALLY,
    runnerRunning: true,
    selected: 0,
    scroll: 0,
    viewHeight: 8,
    ...overrides,
  };
}

// ===========================================================================
// initialSchedulePaneState
// ===========================================================================

describe("initialSchedulePaneState", () => {
  it("is a fully empty, honest starting state", () => {
    const state = initialSchedulePaneState();
    expect(state).toEqual({
      jobs: [],
      runs: [],
      tally: null,
      runnerRunning: null,
      selected: 0,
      scroll: 0,
      viewHeight: 8,
    });
  });

  it("honors a custom viewHeight and floors/clamps it to at least 1", () => {
    expect(initialSchedulePaneState(3).viewHeight).toBe(3);
    expect(initialSchedulePaneState(0).viewHeight).toBe(1);
    expect(initialSchedulePaneState(-5).viewHeight).toBe(1);
    expect(initialSchedulePaneState(4.9).viewHeight).toBe(4);
  });
});

// ===========================================================================
// renderSchedulePane — exact full-frame assertions
// ===========================================================================

describe("renderSchedulePane: exact frames", () => {
  it("renders the fully empty pane honestly, one section at a time", () => {
    const lines = renderSchedulePane(initialSchedulePaneState());
    expect(lines).toEqual([
      "╭─ SCHEDULE────────────────────────────────────────────────────────────╮",
      "│JOBS (0)                                                              │",
      "│  no scheduled jobs                                                   │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│RUNNER                                                                │",
      "│  runner: not attached                                                │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│RUNS (0)                                                              │",
      "│  no runs yet                                                         │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│TALLY                                                                 │",
      "│  no completed runs yet                                               │",
      "╰──────────────────────────────────────────────────────────────────────╯",
    ]);
  });

  it("renders a fully populated pane (jobs, an enabled+disabled mix, runs, a real tally, an attached runner)", () => {
    const lines = renderSchedulePane(makePopulatedState());
    expect(lines).toEqual([
      "╭─ SCHEDULE────────────────────────────────────────────────────────────╮",
      "│JOBS (2)                                                              │",
      "│▸ on  daily digest  30 9 * * 1-5  America/New_York                    │",
      "│    digest  → telegram:U1  next: 1700000000000                        │",
      "│    last: delivered  runs=5  fails=1  abstains=0                      │",
      "│  off weekly report  0 8 * * 1  UTC                                   │",
      "│    report  → —  disabled                                             │",
      "│    last: —  runs=0  fails=0  abstains=0                              │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│RUNNER                                                                │",
      "│  runner: running                                                     │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│RUNS (1)                                                              │",
      "│  daily digest  delivered  fired=1699999000000  sched=1699998900000  …│",
      "│    sent via telegram                                                 │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│TALLY                                                                 │",
      "│  delivered=4  abstained=1  withheld=0  failed=1  skipped=0           │",
      "╰──────────────────────────────────────────────────────────────────────╯",
    ]);
  });

  it("distinguishes tally === null ('no completed runs yet') from a real all-zero tally (printed verbatim)", () => {
    const nullLines = renderSchedulePane(makePopulatedState({ tally: null }));
    const zeroLines = renderSchedulePane(makePopulatedState({ tally: ZERO_TALLY }));

    expect(nullLines[nullLines.length - 3]).toBe("│TALLY                                                                 │");
    expect(nullLines[nullLines.length - 2]).toBe("│  no completed runs yet                                               │");

    expect(zeroLines[zeroLines.length - 2]).toBe(
      "│  delivered=0  abstained=0  withheld=0  failed=0  skipped=0           │"
    );
    // The two must never render identically — that would be the exact
    // "conflating null with a real zero tally" bug this pane is contracted
    // never to have.
    expect(nullLines[nullLines.length - 2]).not.toBe(zeroLines[zeroLines.length - 2]);
  });

  it("renders runnerRunning true/false/null all distinctly and honestly", () => {
    const runningLines = renderSchedulePane(makePopulatedState({ runnerRunning: true }));
    const stoppedLines = renderSchedulePane(makePopulatedState({ runnerRunning: false }));
    const detachedLines = renderSchedulePane(makePopulatedState({ runnerRunning: null }));

    const runnerLineIndex = 10; // fixed by the populated-state fixture's section layout
    expect(runningLines[runnerLineIndex]).toBe("│  runner: running                                                     │");
    expect(stoppedLines[runnerLineIndex]).toBe("│  runner: stopped                                                     │");
    expect(detachedLines[runnerLineIndex]).toBe("│  runner: not attached                                                │");
  });

  it("renders an empty jobs list and empty runs feed with their exact honest strings", () => {
    const lines = renderSchedulePane(makePopulatedState({ jobs: [], runs: [], selected: 0, scroll: 0 }));
    expect(lines).toEqual([
      "╭─ SCHEDULE────────────────────────────────────────────────────────────╮",
      "│JOBS (0)                                                              │",
      "│  no scheduled jobs                                                   │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│RUNNER                                                                │",
      "│  runner: running                                                     │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│RUNS (0)                                                              │",
      "│  no runs yet                                                         │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│TALLY                                                                 │",
      "│  delivered=4  abstained=1  withheld=0  failed=1  skipped=0           │",
      "╰──────────────────────────────────────────────────────────────────────╯",
    ]);
  });

  it("an enabled job with an unparseable/unknowable next fire renders 'next: —', never a guessed time", () => {
    const lines = renderSchedulePane(
      makePopulatedState({ jobs: [makeJob({ nextFireAt: null })], runs: [], tally: null })
    );
    expect(lines).toContain("│    digest  → telegram:U1  next: —                                    │");
  });

  it("numbers print verbatim: runCount/failCount/abstainCount are never derived from history length", () => {
    // history-derived counts would be 0/0/0 here (no runs array backing this
    // job), but the row's own counters must still print exactly as given.
    const job = makeJob({ runCount: 999, failCount: 3, abstainCount: 42 });
    const lines = renderSchedulePane(makePopulatedState({ jobs: [job], runs: [] }));
    expect(lines.some((l) => l.includes("runs=999  fails=3  abstains=42"))).toBe(true);
  });
});

// ===========================================================================
// Width discipline & sanitization under adversarial input
// ===========================================================================

describe("renderSchedulePane: width discipline and sanitization", () => {
  function assertFrameIsSafe(lines: string[], width: number): void {
    for (const line of lines) {
      expect([...line].length).toBeLessThanOrEqual(width);
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/);
      expect(line.includes("\u001b")).toBe(false);
    }
  }

  it("clamps a 500-char job name, CJK/emoji multi-code-point text, and default width to <=72 code points", () => {
    const job = makeJob({
      name: "x".repeat(500),
      taskKind: "日本語タスク🎉".repeat(10),
      deliveryTarget: "telegram:" + "ユーザー🚀".repeat(20),
    });
    const lines = renderSchedulePane(makePopulatedState({ jobs: [job] }));
    assertFrameIsSafe(lines, 72);
  });

  it("strips ANSI escape sequences (ESC [31m ... ESC [0m) embedded in name/cron/detail and never lets ESC reach the frame", () => {
    const job = makeJob({
      name: "\x1b[31minjected-name\x1b[0m",
      cron: "\x1b[31mred\x1b[0m",
      timeZone: "\x1b[31mzone\x1b[0m",
      taskKind: "\x1b[31mkind\x1b[0m",
      deliveryTarget: "\x1b[31mplat\x1b[0m:\x1b[31muser\x1b[0m",
      lastOutcome: "\x1b[31mfailed\x1b[0m",
    });
    const run = makeRun({
      jobName: "\x1b[31mrun-name\x1b[0m",
      outcome: "\x1b[31mdelivered\x1b[0m",
      detail: "click here\x07\x1b[31m to pwn\x1b[0m",
    });
    const lines = renderSchedulePane(makePopulatedState({ jobs: [job], runs: [run] }));
    assertFrameIsSafe(lines, 72);
    // The literal bracket text (with ESC stripped) is allowed to survive —
    // only the raw ESC/BEL control bytes must never reach the frame.
    expect(lines.some((l) => l.includes("[31m"))).toBe(true);
  });

  it("strips C0/C1 control characters embedded in run detail and cron fields", () => {
    const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("");
    const c1 = Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x80 + i)).join("");
    const job = makeJob({ cron: `cron${controls}${c1}text` });
    const run = makeRun({ detail: `detail${controls}${c1}text` });
    const lines = renderSchedulePane(makePopulatedState({ jobs: [job], runs: [run] }));
    assertFrameIsSafe(lines, 72);
  });

  it("holds the width clamp at a narrower custom width", () => {
    const lines = renderSchedulePane(makePopulatedState({ jobs: [makeJob({ name: "x".repeat(200) })] }), 40);
    assertFrameIsSafe(lines, 40);
  });
});

// ===========================================================================
// Text sanitization, exercised indirectly through renderSchedulePane (the
// module's only export surface — see the locked "Exports EXACTLY" contract)
// ===========================================================================

describe("renderSchedulePane: text sanitization semantics", () => {
  it("collapses newline variants (\\n, \\r, \\r\\n) to a single ⏎ inside a rendered field", () => {
    const job = makeJob({ name: "a\nb\r\nc\rd" });
    const lines = renderSchedulePane(makePopulatedState({ jobs: [job], runs: [] }));
    expect(lines.some((l) => l.includes("a⏎b⏎c⏎d"))).toBe(true);
  });

  it("never splits a surrogate pair when truncating a long multi-code-point field, and always ends the truncated field with an ellipsis", () => {
    // timeZone is capped at 30 code points inside renderSchedulePane; 40
    // 🎉 emoji (each a surrogate pair) forces truncation.
    const job = makeJob({ timeZone: "🎉".repeat(40) });
    const lines = renderSchedulePane(makePopulatedState({ jobs: [job], runs: [] }));
    const jobLine = lines.find((l) => l.includes("🎉"));
    expect(jobLine).toBeDefined();
    expect(jobLine).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(jobLine).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(jobLine!.trimEnd().includes("…")).toBe(true);
  });
});

// ===========================================================================
// schedulePaneKey — full clamp matrix
// ===========================================================================

describe("schedulePaneKey", () => {
  function jobsOf(n: number): SchedulePaneJobRow[] {
    return Array.from({ length: n }, (_, i) => makeJob({ id: `job-${i}`, name: `job ${i}` }));
  }

  it("pins selected/scroll to 0,0 for every key on an empty job list", () => {
    const empty = initialSchedulePaneState(3);
    for (const key of ["up", "down", "home", "end"]) {
      const result = schedulePaneKey(empty, key);
      expect(result.selected).toBe(0);
      expect(result.scroll).toBe(0);
    }
    // Already at 0,0 — the empty-list branch must return the same reference.
    expect(schedulePaneKey(empty, "down")).toBe(empty);
    expect(schedulePaneKey(empty, "up")).toBe(empty);
    expect(schedulePaneKey(empty, "home")).toBe(empty);
  });

  it("a single job clamps up/down to stay at index 0 and returns the same reference once already there", () => {
    const state: SchedulePaneState = { ...initialSchedulePaneState(3), jobs: jobsOf(1) };
    expect(schedulePaneKey(state, "down")).toBe(state);
    expect(schedulePaneKey(state, "up")).toBe(state);
    const afterEnd = schedulePaneKey(state, "end");
    expect(afterEnd.selected).toBe(0);
    expect(afterEnd.scroll).toBe(0);
  });

  it("clamps selection at the low end: 'up' from selected=0 stays at 0 and returns the same reference", () => {
    const state: SchedulePaneState = { ...initialSchedulePaneState(3), jobs: jobsOf(5), selected: 0, scroll: 0 };
    const result = schedulePaneKey(state, "up");
    expect(result).toBe(state);
  });

  it("clamps selection at the high end: 'down' from the last index stays there and returns the same reference", () => {
    const state: SchedulePaneState = {
      ...initialSchedulePaneState(3),
      jobs: jobsOf(5),
      selected: 4,
      scroll: 2,
    };
    const result = schedulePaneKey(state, "down");
    expect(result).toBe(state);
  });

  it("scroll follows selection downward through a viewHeight smaller than the job list", () => {
    const jobs = jobsOf(10);
    let state: SchedulePaneState = { ...initialSchedulePaneState(3), jobs };
    const trace: Array<[number, number]> = [];
    for (let i = 0; i < 9; i++) {
      state = schedulePaneKey(state, "down");
      trace.push([state.selected, state.scroll]);
    }
    expect(trace).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
      [4, 2],
      [5, 3],
      [6, 4],
      [7, 5],
      [8, 6],
      [9, 7],
    ]);
  });

  it("scroll follows selection upward back through the same window", () => {
    const jobs = jobsOf(10);
    let state: SchedulePaneState = { ...initialSchedulePaneState(3), jobs, selected: 9, scroll: 7 };
    const trace: Array<[number, number]> = [];
    for (let i = 0; i < 9; i++) {
      state = schedulePaneKey(state, "up");
      trace.push([state.selected, state.scroll]);
    }
    expect(trace).toEqual([
      [8, 7],
      [7, 7],
      [6, 6],
      [5, 5],
      [4, 4],
      [3, 3],
      [2, 2],
      [1, 1],
      [0, 0],
    ]);
  });

  it("'home' jumps to index 0 with scroll pinned to 0", () => {
    const jobs = jobsOf(10);
    const state: SchedulePaneState = { ...initialSchedulePaneState(3), jobs, selected: 5, scroll: 3 };
    const result = schedulePaneKey(state, "home");
    expect(result.selected).toBe(0);
    expect(result.scroll).toBe(0);
  });

  it("'end' jumps to the last index with scroll pinned to the final window", () => {
    const jobs = jobsOf(10);
    const state: SchedulePaneState = { ...initialSchedulePaneState(3), jobs, selected: 2, scroll: 0 };
    const result = schedulePaneKey(state, "end");
    expect(result.selected).toBe(9);
    expect(result.scroll).toBe(7);
  });

  it("an unknown key returns the exact same state reference (===), not merely an equal one", () => {
    const state: SchedulePaneState = { ...initialSchedulePaneState(3), jobs: jobsOf(5), selected: 2, scroll: 1 };
    expect(schedulePaneKey(state, "pageup")).toBe(state);
    expect(schedulePaneKey(state, "pagedown")).toBe(state);
    expect(schedulePaneKey(state, "left")).toBe(state);
    expect(schedulePaneKey(state, "")).toBe(state);
    expect(schedulePaneKey(state, "DOWN")).toBe(state); // case-sensitive: not the same as "down"
  });

  it("'home' on a state already at home returns the same reference", () => {
    const state: SchedulePaneState = { ...initialSchedulePaneState(3), jobs: jobsOf(5), selected: 0, scroll: 0 };
    expect(schedulePaneKey(state, "home")).toBe(state);
  });

  it("never mutates the input state", () => {
    const jobs = jobsOf(5);
    const state: SchedulePaneState = { ...initialSchedulePaneState(3), jobs, selected: 0, scroll: 0 };
    Object.freeze(state);
    Object.freeze(state.jobs);
    for (const j of state.jobs) Object.freeze(j);
    expect(() => schedulePaneKey(state, "down")).not.toThrow();
    expect(state.selected).toBe(0);
    expect(state.scroll).toBe(0);
  });
});

// ===========================================================================
// pushRun — cap eviction order and immutability
// ===========================================================================

describe("pushRun", () => {
  function runOf(firedAt: number): SchedulePaneRunRow {
    return makeRun({ firedAt, scheduledFor: firedAt, jobId: `j-${firedAt}`, jobName: `j-${firedAt}` });
  }

  it("prepends newest-first: the most recently pushed run is always index 0", () => {
    let state = initialSchedulePaneState();
    state = pushRun(state, runOf(1));
    state = pushRun(state, runOf(2));
    state = pushRun(state, runOf(3));
    expect(state.runs.map((r) => r.firedAt)).toEqual([3, 2, 1]);
  });

  it("evicts the oldest rows (the tail) once the cap is exceeded, preserving newest-first order", () => {
    let state = initialSchedulePaneState();
    for (let i = 0; i < 5; i++) {
      state = pushRun(state, runOf(i), 3);
    }
    expect(state.runs.map((r) => r.firedAt)).toEqual([4, 3, 2]);
    expect(state.runs.length).toBe(3);
  });

  it("defaults the cap to 200", () => {
    let state = initialSchedulePaneState();
    for (let i = 0; i < 250; i++) {
      state = pushRun(state, runOf(i));
    }
    expect(state.runs.length).toBe(200);
    expect(state.runs[0].firedAt).toBe(249);
    expect(state.runs[199].firedAt).toBe(50);
  });

  it("floors and clamps a fractional/zero/negative cap to at least 1", () => {
    let state = initialSchedulePaneState();
    state = pushRun(state, runOf(1), 0.9);
    expect(state.runs.length).toBe(1);
    state = pushRun(state, runOf(2), -5);
    expect(state.runs.length).toBe(1);
    expect(state.runs[0].firedAt).toBe(2);
  });

  it("never mutates the input state or the input row", () => {
    const state = initialSchedulePaneState();
    Object.freeze(state);
    Object.freeze(state.runs);
    const row = runOf(1);
    Object.freeze(row);
    const next = pushRun(state, row);
    expect(state.runs).toEqual([]);
    expect(next.runs).toEqual([row]);
    // The stored row is a clone, not the frozen input object.
    expect(next.runs[0]).not.toBe(row);
    expect(next.runs[0]).toEqual(row);
  });

  it("does not mutate a frozen, already-populated runs array when evicting", () => {
    let state = initialSchedulePaneState();
    state = pushRun(state, runOf(1), 2);
    state = pushRun(state, runOf(2), 2);
    Object.freeze(state);
    Object.freeze(state.runs);
    for (const r of state.runs) Object.freeze(r);
    const next = pushRun(state, runOf(3), 2);
    expect(state.runs.map((r) => r.firedAt)).toEqual([2, 1]);
    expect(next.runs.map((r) => r.firedAt)).toEqual([3, 2]);
  });
});
