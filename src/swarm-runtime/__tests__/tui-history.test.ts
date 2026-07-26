import { describe, it, expect } from "vitest";
import type { TuiState } from "../tui/render";
import {
  HistoryRecorder,
  MAX_FRAMES_PER_RUN,
  MAX_RUNS_RETAINED,
  initReplay,
  replayReduce,
  replayNext,
  replayPrev,
  replayFirst,
  replayLast,
  currentFrame,
  formatDuration,
  renderHistoryList,
  renderReplayBar,
  type GoalRun,
  type ReplayState,
} from "../tui/history";

function frame(mode: string, running: number): TuiState {
  return {
    mode,
    metrics: {
      goals: { total: 1, completed: 0, failed: 0, aborted: 0, running },
      tasks: { total: 0, verified: 0, failed: 0, pending: 0, dispatched: 0 },
      workers: { total: 1, idle: 1, busy: 0, killed: 0, dead: 0 },
      verification: { total: 0, accepted: 0, rejected: 0, avgScore: 0, groundingRate: 0 },
      usage: { toolCalls: 0, costUsd: 0 },
    },
  };
}

describe("HistoryRecorder", () => {
  it("records the expected sequence of frames on the active run", () => {
    const rec = new HistoryRecorder();
    rec.beginRun("g1", "Analyze the objective", 1000);
    rec.recordFrame(frame("inline", 1), 1100);
    rec.recordFrame(frame("inline", 2), 1200);
    rec.endRun("completed", 1300);

    const run = rec.get("g1")!;
    expect(run.frames.length).toBe(2);
    expect(run.frames[0].metrics!.goals.running).toBe(1);
    expect(run.frames[1].metrics!.goals.running).toBe(2);
    expect(run.frameTimestamps).toEqual([1100, 1200]);
    expect(run.startedAt).toBe(1000);
    expect(run.endedAt).toBe(1300);
    expect(run.status).toBe("completed");
    expect(run.droppedFrames).toBe(0);
  });

  it("defensively copies frames so later mutation does not rewrite history", () => {
    const rec = new HistoryRecorder();
    rec.beginRun("g1", "obj", 0);
    const live = frame("inline", 1);
    rec.recordFrame(live, 1);
    live.metrics!.goals.running = 99;
    expect(rec.get("g1")!.frames[0].metrics!.goals.running).toBe(1);
  });

  it("throws when recording or ending with no active run", () => {
    const rec = new HistoryRecorder();
    expect(() => rec.recordFrame(frame("inline", 1), 0)).toThrow();
    expect(() => rec.endRun("completed", 0)).toThrow();
  });

  it("throws on a duplicate goalId", () => {
    const rec = new HistoryRecorder();
    rec.beginRun("g1", "a", 0);
    expect(() => rec.beginRun("g1", "b", 1)).toThrow();
  });

  it("trims oldest frames honestly at the per-run cap", () => {
    const cap = 3;
    const rec = new HistoryRecorder(cap);
    rec.beginRun("g1", "obj", 0);
    for (let i = 0; i < 10; i++) rec.recordFrame(frame("inline", i), 100 + i);
    const run = rec.get("g1")!;
    expect(run.frames.length).toBe(cap);
    expect(run.droppedFrames).toBe(7);
    // Only the most-recent `cap` frames survive (running = 7,8,9).
    expect(run.frames.map((f) => f.metrics!.goals.running)).toEqual([7, 8, 9]);
    expect(run.frameTimestamps).toEqual([107, 108, 109]);
  });

  it("evicts oldest runs honestly at the retention cap", () => {
    const rec = new HistoryRecorder(MAX_FRAMES_PER_RUN, 2);
    rec.beginRun("g1", "one", 0);
    rec.endRun("completed", 1);
    rec.beginRun("g2", "two", 2);
    rec.endRun("completed", 3);
    rec.beginRun("g3", "three", 4);
    rec.endRun("completed", 5);

    expect(rec.get("g1")).toBeUndefined(); // oldest evicted
    expect(rec.get("g2")).toBeDefined();
    expect(rec.get("g3")).toBeDefined();
    expect(rec.list().length).toBe(2);
  });

  it("lists runs most-recent first", () => {
    const rec = new HistoryRecorder();
    rec.beginRun("g1", "first", 0);
    rec.endRun("completed", 1);
    rec.beginRun("g2", "second", 2);
    rec.endRun("failed", 3);

    const list = rec.list();
    expect(list.map((r) => r.goalId)).toEqual(["g2", "g1"]);
  });

  it("uses no clock internally (durations derive only from supplied timestamps)", () => {
    const rec = new HistoryRecorder();
    rec.beginRun("g1", "obj", 5000);
    rec.recordFrame(frame("inline", 1), 5500);
    rec.endRun("completed", 6500);
    const run = rec.get("g1")!;
    expect(run.endedAt! - run.startedAt).toBe(1500);
    expect(formatDuration(run)).toBe("1.5s");
  });
});

function runWithFrames(n: number): GoalRun {
  const rec = new HistoryRecorder();
  rec.beginRun("g1", "Analyze the objective", 0);
  for (let i = 0; i < n; i++) rec.recordFrame(frame("inline", i), i);
  rec.endRun("completed", n);
  return rec.get("g1")!;
}

describe("replay", () => {
  it("initReplay starts at frame 0 of the run", () => {
    const run = runWithFrames(5);
    expect(initReplay(run)).toEqual<ReplayState>({ runId: "g1", frameIndex: 0 });
  });

  it("next/prev clamp at [0, len-1]", () => {
    const run = runWithFrames(3); // indexes 0..2
    let s = initReplay(run);
    s = replayPrev(run, s);
    expect(s.frameIndex).toBe(0); // clamped low
    s = replayNext(run, s);
    s = replayNext(run, s);
    expect(s.frameIndex).toBe(2);
    s = replayNext(run, s);
    expect(s.frameIndex).toBe(2); // clamped high
  });

  it("first/last jump to the ends", () => {
    const run = runWithFrames(4);
    let s: ReplayState = { runId: "g1", frameIndex: 2 };
    s = replayLast(run, s);
    expect(s.frameIndex).toBe(3);
    s = replayFirst(run, s);
    expect(s.frameIndex).toBe(0);
  });

  it("replayReduce is pure (does not mutate input state)", () => {
    const run = runWithFrames(3);
    const s0 = initReplay(run);
    const s1 = replayReduce(run, s0, "next");
    expect(s0.frameIndex).toBe(0);
    expect(s1.frameIndex).toBe(1);
    expect(s1).not.toBe(s0);
  });

  it("clamps sanely on an empty run", () => {
    const rec = new HistoryRecorder();
    rec.beginRun("empty", "obj", 0);
    const run = rec.get("empty")!;
    let s = initReplay(run);
    s = replayNext(run, s);
    expect(s.frameIndex).toBe(0);
    s = replayLast(run, s);
    expect(s.frameIndex).toBe(0);
  });

  it("currentFrame returns the right snapshot", () => {
    const run = runWithFrames(4);
    expect(currentFrame(run, { runId: "g1", frameIndex: 2 })!.metrics!.goals.running).toBe(2);
    expect(currentFrame(run, { runId: "g1", frameIndex: 0 })!.metrics!.goals.running).toBe(0);
  });

  it("currentFrame returns null for mismatched run, empty run, or out-of-range", () => {
    const run = runWithFrames(3);
    expect(currentFrame(run, { runId: "other", frameIndex: 0 })).toBeNull();
    expect(currentFrame(run, { runId: "g1", frameIndex: 99 })).toBeNull();
    expect(currentFrame(run, { runId: "g1", frameIndex: -1 })).toBeNull();

    const rec = new HistoryRecorder();
    rec.beginRun("empty", "obj", 0);
    expect(currentFrame(rec.get("empty")!, { runId: "empty", frameIndex: 0 })).toBeNull();
  });
});

describe("formatDuration", () => {
  it("reports running when not ended", () => {
    const rec = new HistoryRecorder();
    rec.beginRun("g1", "obj", 100);
    expect(formatDuration(rec.get("g1")!)).toBe("running");
  });

  it("formats sub-second, seconds, and minutes", () => {
    const mk = (start: number, end: number): GoalRun => {
      const rec = new HistoryRecorder();
      rec.beginRun("g", "o", start);
      rec.endRun("completed", end);
      return rec.get("g")!;
    };
    expect(formatDuration(mk(0, 250))).toBe("250ms");
    expect(formatDuration(mk(0, 1500))).toBe("1.5s");
    expect(formatDuration(mk(0, 83_000))).toBe("1m23s");
  });
});

describe("renderers", () => {
  it("renderHistoryList is deterministic and contains expected substrings", () => {
    const rec = new HistoryRecorder();
    rec.beginRun("g1", "First analysis", 0);
    rec.recordFrame(frame("inline", 1), 100);
    rec.endRun("completed", 1500);
    rec.beginRun("g2", "Second analysis", 2000);
    rec.recordFrame(frame("inline", 1), 2100);
    rec.endRun("failed", 2300);

    const out = renderHistoryList(rec.list(), 0);
    expect(out).toBe(renderHistoryList(rec.list(), 0)); // deterministic

    const lines = out.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("Second analysis"); // most-recent first
    expect(lines[0]).toContain(">"); // selected marker on index 0
    expect(lines[0]).toContain("ERR"); // failed status
    expect(lines[1]).toContain("First analysis");
    expect(lines[1]).toContain("OK"); // completed status
    expect(out).not.toContain("—"); // no em-dashes
  });

  it("renderHistoryList handles the empty case", () => {
    expect(renderHistoryList([])).toContain("no goal runs");
  });

  it("renderHistoryList surfaces dropped frames in the count", () => {
    const rec = new HistoryRecorder(2);
    rec.beginRun("g1", "obj", 0);
    for (let i = 0; i < 5; i++) rec.recordFrame(frame("inline", i), i);
    rec.endRun("completed", 10);
    const out = renderHistoryList(rec.list());
    expect(out).toContain("2+3f"); // 2 retained, 3 dropped
  });

  it("renderReplayBar shows a 1-based scrubber and the objective", () => {
    const run = runWithFrames(12);
    const bar = renderReplayBar(run, { runId: "g1", frameIndex: 2 });
    expect(bar).toBe(renderReplayBar(run, { runId: "g1", frameIndex: 2 })); // deterministic
    expect(bar).toContain("[frame 3/12]");
    expect(bar).toContain("◀ ▶");
    expect(bar).toContain('goal: "Analyze the objective"');
    expect(bar).not.toContain("—"); // no em-dashes
  });

  it("renderReplayBar shows 0/0 for an empty run", () => {
    const rec = new HistoryRecorder();
    rec.beginRun("empty", "obj", 0);
    const run = rec.get("empty")!;
    expect(renderReplayBar(run, initReplay(run))).toContain("[frame 0/0]");
  });
});

describe("caps are exported and sane", () => {
  it("exposes the documented default caps", () => {
    expect(MAX_FRAMES_PER_RUN).toBe(500);
    expect(MAX_RUNS_RETAINED).toBe(50);
  });
});
