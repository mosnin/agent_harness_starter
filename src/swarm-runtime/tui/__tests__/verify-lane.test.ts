import { describe, expect, it } from "vitest";

import type { Verdict, VerificationReport } from "../../types";
import {
  laneInit,
  laneApply,
  laneKey,
  vtphReadout,
  renderVerifyLane,
  type LaneRuling,
  type VerifyEvent,
  type VerifyLaneRow,
  type VerifyLaneState,
  type VtphInput,
} from "../verify-lane";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function report(verdict: Verdict, score: number): Pick<VerificationReport, "verdict" | "score"> {
  return { verdict, score };
}

function taskEvent(
  overrides: Partial<Extract<VerifyEvent, { type: "task" }>> & { taskId: string }
): VerifyEvent {
  return {
    type: "task",
    at: 1000,
    description: "do the thing",
    ruling: "pending",
    ...overrides,
  };
}

function feed(events: VerifyEvent[]): VerifyLaneState {
  let s = laneInit();
  for (const ev of events) s = laneApply(s, ev);
  return s;
}

function row(state: VerifyLaneState, taskId: string): VerifyLaneRow {
  const r = state.rows.find((x) => x.taskId === taskId);
  if (!r) throw new Error(`no row for ${taskId}`);
  return r;
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === "object") {
    Object.values(obj as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

function freshVtph(overrides: Partial<VtphInput> = {}): VtphInput {
  return { verifiedCount: 10, wallMs: 3_600_000, costUsd: 2, ...overrides };
}

/** Recount tally directly from rows — the ground truth `laneApply`'s `tally` must always match. */
function recount(rows: readonly VerifyLaneRow[]): VerifyLaneState["tally"] {
  const t = { accept: 0, abstain: 0, reject: 0, pending: 0 };
  for (const r of rows) t[r.ruling] += 1;
  return t;
}

// ---------------------------------------------------------------------------
// laneInit
// ---------------------------------------------------------------------------

describe("laneInit", () => {
  it("starts empty with an all-zero tally and no run started", () => {
    const s = laneInit();
    expect(s.rows).toEqual([]);
    expect(s.tally).toEqual({ accept: 0, abstain: 0, reject: 0, pending: 0 });
    expect(s.scroll).toBe(0);
    expect(s.startedAt).toBeNull();
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = laneInit();
    const b = laneInit();
    expect(a).not.toBe(b);
    expect(a.rows).not.toBe(b.rows);
  });
});

// ---------------------------------------------------------------------------
// laneApply — run-start / run-end
// ---------------------------------------------------------------------------

describe("laneApply run-start / run-end", () => {
  it("run-start sets startedAt from the event's own at, never a clock read", () => {
    const s = laneApply(laneInit(), { type: "run-start", at: 424242 });
    expect(s.startedAt).toBe(424242);
  });

  it("run-start leaves existing rows/tally untouched", () => {
    let s = feed([taskEvent({ taskId: "t1", ruling: "pending" })]);
    s = laneApply(s, { type: "run-start", at: 5 });
    expect(s.rows).toHaveLength(1);
    expect(s.tally.pending).toBe(1);
  });

  it("run-end is a pure no-op returning the exact same reference", () => {
    const s = feed([taskEvent({ taskId: "t1" })]);
    const next = laneApply(s, { type: "run-end", at: 999 });
    expect(next).toBe(s);
  });

  it("does not mutate the input state object", () => {
    const s = deepFreeze(laneInit());
    expect(() => laneApply(s, { type: "run-start", at: 1 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// laneApply — the locked ruling mapping, exhaustively
// ---------------------------------------------------------------------------

describe("laneApply ruling mapping (the moat)", () => {
  it("task:dispatched -> pending (ruling with no report)", () => {
    const s = feed([taskEvent({ taskId: "t1", ruling: "pending" })]);
    expect(row(s, "t1").ruling).toBe("pending");
    expect(row(s, "t1").score).toBeNull();
  });

  it("task:verified -> accept, carrying report.score", () => {
    const s = feed([taskEvent({ taskId: "t1", ruling: "accept", report: report("accept", 0.93) })]);
    expect(row(s, "t1").ruling).toBe("accept");
    expect(row(s, "t1").score).toBe(0.93);
  });

  it("task:rejected -> reject, carrying report.score", () => {
    const s = feed([taskEvent({ taskId: "t1", ruling: "reject", report: report("reject", 0.12) })]);
    expect(row(s, "t1").ruling).toBe("reject");
    expect(row(s, "t1").score).toBe(0.12);
  });

  it("task:escalated (ruling: abstain, no report) -> abstain", () => {
    const s = feed([taskEvent({ taskId: "t1", ruling: "abstain" })]);
    expect(row(s, "t1").ruling).toBe("abstain");
  });

  it("any report.verdict === 'revise' -> abstain, regardless of the event's own ruling field", () => {
    const s = feed([taskEvent({ taskId: "t1", ruling: "accept", report: report("revise", 0.5) })]);
    expect(row(s, "t1").ruling).toBe("abstain");
  });

  it("task:failed -> reject (terminal, no report)", () => {
    const s = feed([taskEvent({ taskId: "t1", ruling: "reject" })]);
    expect(row(s, "t1").ruling).toBe("reject");
  });

  it("exhaustive (ruling, report.verdict) matrix: report always wins and maps via the locked table", () => {
    const rulings: Array<Exclude<LaneRuling, "pending"> | "pending"> = ["pending", "accept", "abstain", "reject"];
    const verdicts: Verdict[] = ["accept", "revise", "reject"];
    const expectedFromVerdict: Record<Verdict, LaneRuling> = { accept: "accept", revise: "abstain", reject: "reject" };

    for (const ruling of rulings) {
      for (const verdict of verdicts) {
        const s = feed([taskEvent({ taskId: "t", ruling, report: report(verdict, 0.5) })]);
        expect(row(s, "t").ruling).toBe(expectedFromVerdict[verdict]);
      }
    }
  });

  it("revise never renders as accept or reject under any ruling override attempt", () => {
    for (const ruling of ["pending", "accept", "abstain", "reject"] as const) {
      const s = feed([taskEvent({ taskId: "t", ruling, report: report("revise", 0.7) })]);
      expect(row(s, "t").ruling).not.toBe("accept");
      expect(row(s, "t").ruling).not.toBe("reject");
      expect(row(s, "t").ruling).toBe("abstain");
    }
  });

  it("a verified-after-revision task transitions abstain -> accept with attempts preserved", () => {
    const s1 = feed([
      taskEvent({ taskId: "t1", at: 1, ruling: "pending" }),
      taskEvent({ taskId: "t1", at: 2, ruling: "abstain", report: report("revise", 0.4) }),
    ]);
    expect(row(s1, "t1").ruling).toBe("abstain");
    expect(row(s1, "t1").attempts).toBe(1);

    const s2 = laneApply(s1, taskEvent({ taskId: "t1", at: 3, ruling: "accept", report: report("accept", 0.95) }));
    expect(row(s2, "t1").ruling).toBe("accept");
    expect(row(s2, "t1").score).toBe(0.95);
    expect(row(s2, "t1").attempts).toBe(1); // same attempt, not a new one
  });
});

// ---------------------------------------------------------------------------
// laneApply — re-dispatch / attempts bookkeeping
// ---------------------------------------------------------------------------

describe("laneApply attempts / re-dispatch", () => {
  it("re-dispatch after reject returns to pending with attempts=2 and a cleared score", () => {
    const s1 = feed([
      taskEvent({ taskId: "t1", at: 1, ruling: "pending" }),
      taskEvent({ taskId: "t1", at: 2, ruling: "reject", report: report("reject", 0.1) }),
    ]);
    expect(row(s1, "t1").attempts).toBe(1);

    const s2 = laneApply(s1, taskEvent({ taskId: "t1", at: 3, ruling: "pending" }));
    expect(row(s2, "t1").ruling).toBe("pending");
    expect(row(s2, "t1").attempts).toBe(2);
    expect(row(s2, "t1").score).toBeNull();
  });

  it("a first-ever dispatch starts attempts at 1, not 2", () => {
    const s = feed([taskEvent({ taskId: "t1", ruling: "pending" })]);
    expect(row(s, "t1").attempts).toBe(1);
  });

  it("duplicate pending events for an already-pending row do not increment attempts", () => {
    const s = feed([
      taskEvent({ taskId: "t1", at: 1, ruling: "pending" }),
      taskEvent({ taskId: "t1", at: 2, ruling: "pending" }),
    ]);
    expect(row(s, "t1").attempts).toBe(1);
  });

  it("multiple reject -> re-dispatch cycles keep incrementing attempts", () => {
    const s = feed([
      taskEvent({ taskId: "t1", at: 1, ruling: "pending" }),
      taskEvent({ taskId: "t1", at: 2, ruling: "reject" }),
      taskEvent({ taskId: "t1", at: 3, ruling: "pending" }),
      taskEvent({ taskId: "t1", at: 4, ruling: "reject" }),
      taskEvent({ taskId: "t1", at: 5, ruling: "pending" }),
    ]);
    expect(row(s, "t1").attempts).toBe(3);
    expect(row(s, "t1").ruling).toBe("pending");
  });

  it("updatedAt always tracks the event's own at, never a derived/incremented clock", () => {
    const s = feed([taskEvent({ taskId: "t1", at: 777, ruling: "pending" })]);
    expect(row(s, "t1").updatedAt).toBe(777);
  });

  it("description is refreshed from the latest event", () => {
    const s = feed([
      taskEvent({ taskId: "t1", at: 1, ruling: "pending", description: "first draft" }),
      taskEvent({ taskId: "t1", at: 2, ruling: "accept", report: report("accept", 0.8), description: "final form" }),
    ]);
    expect(row(s, "t1").description).toBe("final form");
  });
});

// ---------------------------------------------------------------------------
// Out-of-order / duplicate / unknown-taskId events
// ---------------------------------------------------------------------------

describe("laneApply out-of-order and duplicate events", () => {
  it("a verify arriving for an unknown taskId creates the row honestly rather than dropping the ruling", () => {
    const s = feed([taskEvent({ taskId: "ghost", ruling: "accept", report: report("accept", 0.7) })]);
    expect(row(s, "ghost").ruling).toBe("accept");
    expect(row(s, "ghost").attempts).toBe(1);
  });

  it("verify arriving twice for the same taskId is deterministic (last write wins, no duplicate row)", () => {
    const s = feed([
      taskEvent({ taskId: "t1", at: 1, ruling: "accept", report: report("accept", 0.5) }),
      taskEvent({ taskId: "t1", at: 2, ruling: "accept", report: report("accept", 0.99) }),
    ]);
    expect(s.rows.filter((r) => r.taskId === "t1")).toHaveLength(1);
    expect(row(s, "t1").score).toBe(0.99);
    expect(row(s, "t1").attempts).toBe(1);
  });

  it("an out-of-order sequence (verify before dispatch) still lands on the correct final ruling", () => {
    const s = feed([
      taskEvent({ taskId: "t1", at: 5, ruling: "accept", report: report("accept", 0.8) }),
      taskEvent({ taskId: "t1", at: 1, ruling: "pending" }), // stale dispatch arriving late
    ]);
    // Reducer applies events in the order given; a later-arriving "pending"
    // for an already-accepted row is treated as a genuine re-dispatch.
    expect(row(s, "t1").ruling).toBe("pending");
    expect(row(s, "t1").attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Property test: tally always equals a fresh recount of rows
// ---------------------------------------------------------------------------

describe("tally consistency property", () => {
  it("tally always equals a fresh recount of rows after arbitrary event sequences", () => {
    const taskIds = ["a", "b", "c", "d"];
    const rulings: Array<Exclude<LaneRuling, "pending"> | "pending"> = ["pending", "accept", "abstain", "reject"];
    const verdicts: Array<Verdict | undefined> = ["accept", "revise", "reject", undefined];

    let seed = 12345;
    function rand() {
      // Deterministic LCG — no Math.random, keeps the test itself reproducible.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    let s = laneInit();
    for (let i = 0; i < 500; i++) {
      const taskId = taskIds[Math.floor(rand() * taskIds.length)];
      const ruling = rulings[Math.floor(rand() * rulings.length)];
      const verdict = verdicts[Math.floor(rand() * verdicts.length)];
      const ev: VerifyEvent = taskEvent({
        taskId,
        at: i,
        ruling,
        description: `task ${taskId} step ${i}`,
        report: verdict === undefined ? undefined : report(verdict, rand()),
      });
      s = laneApply(s, ev);
      expect(s.tally).toEqual(recount(s.rows));
    }
    // Also true for the run-start/run-end no-ops interleaved.
    s = laneApply(s, { type: "run-start", at: 9999 });
    expect(s.tally).toEqual(recount(s.rows));
    s = laneApply(s, { type: "run-end", at: 10000 });
    expect(s.tally).toEqual(recount(s.rows));
  });

  it("never mutates a prior state snapshot (immutability under a long event chain)", () => {
    const snapshots: VerifyLaneState[] = [laneInit()];
    let s = snapshots[0];
    for (let i = 0; i < 20; i++) {
      s = laneApply(s, taskEvent({ taskId: `t${i % 3}`, at: i, ruling: i % 2 === 0 ? "pending" : "accept" }));
      snapshots.push(s);
    }
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i].tally).toEqual(recount(snapshots[i].rows));
    }
    // Earliest snapshot is still the pristine empty state.
    expect(snapshots[0].rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// laneKey — scroll navigation
// ---------------------------------------------------------------------------

describe("laneKey", () => {
  function stateWithRows(n: number): VerifyLaneState {
    const s = laneInit();
    return { ...s, rows: Array.from({ length: n }, (_, i) => row0(`t${i}`)) };
  }
  function row0(taskId: string): VerifyLaneRow {
    return { taskId, description: "x", ruling: "pending", score: null, attempts: 1, updatedAt: 0 };
  }

  it("down/up move the scroll offset by one, clamped to [0, rows.length-1]", () => {
    let s = stateWithRows(5);
    s = laneKey(s, "down");
    expect(s.scroll).toBe(1);
    s = laneKey(s, "down");
    expect(s.scroll).toBe(2);
    s = laneKey(s, "up");
    expect(s.scroll).toBe(1);
  });

  it("up at scroll=0 stays clamped at 0", () => {
    const s = laneKey(stateWithRows(5), "up");
    expect(s.scroll).toBe(0);
  });

  it("down repeatedly clamps at rows.length - 1", () => {
    let s = stateWithRows(3);
    for (let i = 0; i < 10; i++) s = laneKey(s, "down");
    expect(s.scroll).toBe(2);
  });

  it("home jumps to 0, end jumps to rows.length - 1", () => {
    let s = stateWithRows(10);
    s = laneKey(s, "end");
    expect(s.scroll).toBe(9);
    s = laneKey(s, "home");
    expect(s.scroll).toBe(0);
  });

  it("an empty rows list clamps scroll to 0 regardless of key", () => {
    const empty = laneInit();
    expect(laneKey(empty, "down").scroll).toBe(0);
    expect(laneKey(empty, "end").scroll).toBe(0);
  });

  it("an unrecognized key is a no-op returning the exact same reference", () => {
    const s = stateWithRows(5);
    expect(laneKey(s, "x")).toBe(s);
    expect(laneKey(s, "")).toBe(s);
    expect(laneKey(s, "left")).toBe(s);
  });

  it("a no-op clamp (already at the boundary) also returns the same reference", () => {
    const s = stateWithRows(5);
    expect(laneKey(s, "up")).toBe(s); // already at scroll=0
  });

  it("never mutates the input state", () => {
    const s = deepFreeze(stateWithRows(5));
    expect(() => laneKey(s, "down")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// vtphReadout
// ---------------------------------------------------------------------------

describe("vtphReadout", () => {
  it("golden: 10 verified in 1 hour at $2 total -> 5.0 V-TPH$", () => {
    const r = vtphReadout(freshVtph({ verifiedCount: 10, wallMs: 3_600_000, costUsd: 2 }));
    expect(r.value).toBeCloseTo(5, 10);
    expect(r.label).toBe("V-TPH$ 5.0");
  });

  it("golden: 1 verified in 30 minutes at $0.50 -> 4.0 V-TPH$", () => {
    const r = vtphReadout(freshVtph({ verifiedCount: 1, wallMs: 1_800_000, costUsd: 0.5 }));
    expect(r.value).toBeCloseTo(4, 10);
    expect(r.label).toBe("V-TPH$ 4.0");
  });

  it("boundary: wallMs=999 is invalid (too short)", () => {
    const r = vtphReadout(freshVtph({ wallMs: 999 }));
    expect(r.value).toBeNull();
    expect(r.label).toBe("V-TPH$ n/a (run too short)");
  });

  it("boundary: wallMs=1000 is valid", () => {
    const r = vtphReadout(freshVtph({ wallMs: 1000, verifiedCount: 1, costUsd: 1 }));
    expect(r.value).not.toBeNull();
    expect(r.label).not.toContain("n/a");
  });

  it("boundary: costUsd=0 is invalid (no cost recorded)", () => {
    const r = vtphReadout(freshVtph({ costUsd: 0 }));
    expect(r.value).toBeNull();
    expect(r.label).toBe("V-TPH$ n/a (no cost recorded)");
  });

  it("boundary: costUsd=0.0001 is valid, and never renders Infinity even though it's a tiny denominator", () => {
    const r = vtphReadout(freshVtph({ verifiedCount: 1, wallMs: 3_600_000, costUsd: 0.0001 }));
    expect(r.value).toBeCloseTo(10000, 5);
    expect(r.label).not.toContain("Infinity");
    expect(r.label).not.toContain("n/a");
  });

  it("verifiedCount=0 over a valid run renders a real, honest zero — never n/a", () => {
    const r = vtphReadout(freshVtph({ verifiedCount: 0 }));
    expect(r.value).toBe(0);
    expect(r.label).toBe("V-TPH$ 0");
  });

  it("negative costUsd is rejected with an n/a label, never a negative or NaN figure", () => {
    const r = vtphReadout(freshVtph({ costUsd: -5 }));
    expect(r.value).toBeNull();
    expect(r.label).toBe("V-TPH$ n/a (no cost recorded)");
  });

  it("negative wallMs is rejected with an n/a label", () => {
    const r = vtphReadout(freshVtph({ wallMs: -1000 }));
    expect(r.value).toBeNull();
    expect(r.label).toBe("V-TPH$ n/a (run too short)");
  });

  it("negative verifiedCount is rejected with an n/a label, never a negative figure", () => {
    const r = vtphReadout(freshVtph({ verifiedCount: -3 }));
    expect(r.value).toBeNull();
    expect(r.label).toContain("n/a");
  });

  it("NaN in any field is rejected with an n/a label, never NaN in the output", () => {
    for (const field of ["verifiedCount", "wallMs", "costUsd"] as const) {
      const r = vtphReadout(freshVtph({ [field]: NaN }));
      expect(r.value).toBeNull();
      expect(r.label).toContain("n/a");
      expect(r.label).not.toContain("NaN");
    }
  });

  it("Infinity in any field is rejected with an n/a label, never Infinity in the output", () => {
    for (const field of ["verifiedCount", "wallMs", "costUsd"] as const) {
      const r = vtphReadout(freshVtph({ [field]: Infinity }));
      expect(r.value).toBeNull();
      expect(r.label).toContain("n/a");
    }
  });

  it("the literal string 'Infinity' can never appear in any label, across a wide sweep of inputs", () => {
    const values = [-Infinity, -1000, -1, -0.0001, 0, 0.0001, 1, 999, 1000, 1e6, NaN, Infinity];
    for (const verifiedCount of values) {
      for (const wallMs of values) {
        for (const costUsd of values) {
          const r = vtphReadout({ verifiedCount, wallMs, costUsd });
          expect(r.label).not.toContain("Infinity");
          expect(r.label).not.toContain("NaN");
          if (r.value !== null) {
            expect(Number.isFinite(r.value)).toBe(true);
          }
        }
      }
    }
  });

  it("a zero-cost run never renders Infinity or a fabricated figure", () => {
    const r = vtphReadout(freshVtph({ verifiedCount: 1000, wallMs: 3_600_000, costUsd: 0 }));
    expect(r.value).toBeNull();
    expect(r.label).toBe("V-TPH$ n/a (no cost recorded)");
  });

  it("formats large results without scientific notation", () => {
    const r = vtphReadout(freshVtph({ verifiedCount: 100000, wallMs: 3_600_000, costUsd: 0.001 }));
    expect(r.label).not.toMatch(/e[+-]/i);
  });

  it("formats small positive results without collapsing to the same string as an honest zero", () => {
    const zero = vtphReadout(freshVtph({ verifiedCount: 0 }));
    const tiny = vtphReadout(freshVtph({ verifiedCount: 1, wallMs: 3_600_000, costUsd: 1_000_000 }));
    expect(tiny.value).toBeGreaterThan(0);
    expect(tiny.label).not.toBe(zero.label);
  });
});

// ---------------------------------------------------------------------------
// renderVerifyLane
// ---------------------------------------------------------------------------

describe("renderVerifyLane", () => {
  const NA = { value: null, label: "V-TPH$ n/a (run too short)" };

  it("exact height discipline: line count is always height + 7, regardless of row count", () => {
    for (const height of [1, 4, 8, 20]) {
      const empty = renderVerifyLane(laneInit(), NA, 72, height);
      expect(empty).toHaveLength(height + 8);

      const s = feed(Array.from({ length: 50 }, (_, i) => taskEvent({ taskId: `t${i}`, at: i })));
      const full = renderVerifyLane(s, NA, 72, height);
      expect(full).toHaveLength(height + 8);
    }
  });

  it("exact width discipline: every line is exactly `width` code points, including with CJK/emoji descriptions", () => {
    const s = feed([
      taskEvent({ taskId: "t1", description: "修复这个非常重要的错误 🔥🔥🔥 emoji-heavy task description here" }),
      taskEvent({ taskId: "t2", ruling: "accept", report: report("accept", 0.87), description: "🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀" }),
    ]);
    for (const width of [20, 40, 72, 100]) {
      const lines = renderVerifyLane(s, NA, width, 6);
      for (const line of lines) {
        expect([...line]).toHaveLength(width);
      }
    }
  });

  it("honest empty state when no tasks have been dispatched yet", () => {
    const lines = renderVerifyLane(laneInit(), NA, 72, 6);
    const joined = lines.join("\n");
    expect(joined).toContain("no tasks yet");
    expect(joined).toContain("dispatch a goal with g");
  });

  it("renders the abstain legend verbatim", () => {
    const lines = renderVerifyLane(laneInit(), NA, 72, 6).join("\n");
    expect(lines).toContain("abstain = escalated for revision, not yet trusted");
  });

  it("renders real tally counts in the header", () => {
    const s = feed([
      taskEvent({ taskId: "t1", ruling: "accept", report: report("accept", 0.9) }),
      taskEvent({ taskId: "t2", ruling: "abstain", report: report("revise", 0.5) }),
      taskEvent({ taskId: "t3", ruling: "reject", report: report("reject", 0.1) }),
      taskEvent({ taskId: "t4", ruling: "pending" }),
    ]);
    const lines = renderVerifyLane(s, NA, 72, 6).join("\n");
    expect(lines).toContain("accept=1 abstain=1 reject=1 pending=1");
  });

  it("renders the V-TPH$ label verbatim", () => {
    const readout = vtphReadout(freshVtph());
    const lines = renderVerifyLane(laneInit(), readout, 72, 6);
    expect(lines.some((l) => l.includes(readout.label))).toBe(true);
  });

  it("renders an n/a V-TPH$ label verbatim too", () => {
    const readout = vtphReadout({ verifiedCount: 5, wallMs: 500, costUsd: 1 });
    expect(readout.label).toBe("V-TPH$ n/a (run too short)");
    const lines = renderVerifyLane(laneInit(), readout, 72, 6);
    expect(lines.some((l) => l.includes("V-TPH$ n/a (run too short)"))).toBe(true);
  });

  it("tally meter's three segments always sum to the fixed bar width when any rulings exist", () => {
    const s = feed([
      taskEvent({ taskId: "t1", ruling: "accept", report: report("accept", 0.9) }),
      taskEvent({ taskId: "t2", ruling: "accept", report: report("accept", 0.9) }),
      taskEvent({ taskId: "t3", ruling: "abstain", report: report("revise", 0.5) }),
      taskEvent({ taskId: "t4", ruling: "reject", report: report("reject", 0.1) }),
    ]);
    const lines = renderVerifyLane(s, NA, 72, 6);
    const barLine = lines.find((l) => l.includes("█") || l.includes("▒") || l.includes("✗") || l.includes("░"));
    expect(barLine).toBeDefined();
    const filled = [...(barLine ?? "")].filter((ch) => ch === "█" || ch === "▒" || ch === "✗").length;
    expect(filled).toBe(20); // BAR_WIDTH
  });

  it("tally meter proportions scale with lopsided distributions (many accepts, one reject)", () => {
    const events = Array.from({ length: 19 }, (_, i) =>
      taskEvent({ taskId: `a${i}`, ruling: "accept", report: report("accept", 0.9) })
    );
    events.push(taskEvent({ taskId: "r1", ruling: "reject", report: report("reject", 0.1) }));
    const s = feed(events);
    const lines = renderVerifyLane(s, NA, 72, 6);
    const barLine = lines.find((l) => l.includes("█"))!;
    const acceptCount = [...barLine].filter((ch) => ch === "█").length;
    const rejectCount = [...barLine].filter((ch) => ch === "✗").length;
    expect(acceptCount).toBeGreaterThan(rejectCount);
    expect(acceptCount + rejectCount).toBe(20);
  });

  it("shows ruling glyphs for each state: accept ●, abstain ◌, reject ✗, pending ○", () => {
    const s = feed([
      taskEvent({ taskId: "acc", ruling: "accept", report: report("accept", 0.9) }),
      taskEvent({ taskId: "abs", ruling: "abstain", report: report("revise", 0.5) }),
      taskEvent({ taskId: "rej", ruling: "reject", report: report("reject", 0.1) }),
      taskEvent({ taskId: "pen", ruling: "pending" }),
    ]);
    const lines = renderVerifyLane(s, NA, 72, 8).join("\n");
    expect(lines).toContain("●");
    expect(lines).toContain("◌");
    expect(lines).toContain("✗");
    expect(lines).toContain("○");
  });

  it("shows score as a percentage, and — when null", () => {
    const s = feed([
      taskEvent({ taskId: "scored", ruling: "accept", report: report("accept", 0.876) }),
      taskEvent({ taskId: "unscored", ruling: "pending" }),
    ]);
    const lines = renderVerifyLane(s, NA, 72, 6).join("\n");
    expect(lines).toContain("88%"); // 0.876 rounds to 88%
    expect(lines).toContain("—");
  });

  it("shows attempts as ×N only when attempts > 1", () => {
    const s = feed([
      taskEvent({ taskId: "t1", at: 1, ruling: "pending" }),
      taskEvent({ taskId: "t1", at: 2, ruling: "reject" }),
      taskEvent({ taskId: "t1", at: 3, ruling: "pending" }), // attempts=2
    ]);
    const lines = renderVerifyLane(s, NA, 72, 6).join("\n");
    expect(lines).toContain("×2");
  });

  it("does not render ×N for a first attempt", () => {
    const s = feed([taskEvent({ taskId: "t1", ruling: "pending" })]);
    const lines = renderVerifyLane(s, NA, 72, 6).join("\n");
    expect(lines).not.toContain("×1");
  });

  it("scroll follows upserts into view: scrolled window still shows the correct slice after new rows arrive", () => {
    let s = feed(Array.from({ length: 10 }, (_, i) => taskEvent({ taskId: `t${i}`, at: i })));
    s = laneKey(s, "end"); // scroll to the bottom
    const beforeLines = renderVerifyLane(s, NA, 72, 4).join("\n");
    expect(beforeLines).toContain("t9");

    // A new task arrives; scroll offset itself is untouched by laneApply, so
    // the render clamps it against the new (larger) row count deterministically.
    s = laneApply(s, taskEvent({ taskId: "t10", at: 10 }));
    const afterLines = renderVerifyLane(s, NA, 72, 4).join("\n");
    expect(afterLines).toContain("t9");
  });

  it("sanitizes ANSI-escape-laden descriptions: control characters become U+FFFD, never raw escape bytes", () => {
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    const NUL = String.fromCharCode(0x00);
    const evil = `${ESC}[31mRED${ESC}[0m${BEL}bell${NUL}null`;
    const s = feed([taskEvent({ taskId: "t1", description: evil })]);
    const lines = renderVerifyLane(s, NA, 100, 6);
    const joined = lines.join("\n");
    expect(joined).not.toContain(ESC);
    expect(joined).not.toContain(BEL);
    expect(joined).not.toContain(NUL);
    expect(joined).toContain("\uFFFD");
  });

  it("sanitizes control characters embedded in the taskId too", () => {
    const ESC = String.fromCharCode(0x1b);
    const s = feed([taskEvent({ taskId: `evil${ESC}[31mid`, description: "x" })]);
    const lines = renderVerifyLane(s, NA, 100, 6).join("\n");
    expect(lines).not.toContain(ESC);
  });

  it("newline characters in a description are sanitized away rather than breaking the one-line-per-row grid", () => {
    const s = feed([taskEvent({ taskId: "t1", description: "line one\nline two\r\nline three" })]);
    const lines = renderVerifyLane(s, NA, 100, 6);
    // Every returned array entry must still be a single rendered line (no
    // embedded raw newline slipped through into one "line" string).
    for (const l of lines) {
      expect(l).not.toContain("\n");
      expect(l).not.toContain("\r");
    }
  });

  it("code-point fits long descriptions rather than overflowing the box width", () => {
    const long = "x".repeat(500);
    const s = feed([taskEvent({ taskId: "t1", description: long })]);
    const lines = renderVerifyLane(s, NA, 40, 6);
    for (const line of lines) {
      expect([...line]).toHaveLength(40);
    }
  });

  it("never mutates the input state or vtph readout", () => {
    const s = deepFreeze(feed([taskEvent({ taskId: "t1" })]));
    const readout = deepFreeze(vtphReadout(freshVtph()));
    expect(() => renderVerifyLane(s, readout, 72, 6)).not.toThrow();
  });

  it("degenerate width/height (0 or negative) never throws and still returns fixed-length output", () => {
    for (const width of [0, -5, 1]) {
      for (const height of [0, -1, 1]) {
        expect(() => renderVerifyLane(laneInit(), NA, width, height)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Reducer purity — no Date.now, no Math.random, no fs anywhere in the module
// ---------------------------------------------------------------------------

describe("module purity", () => {
  it("laneApply is referentially pure: identical (state, event) inputs always produce structurally identical output", () => {
    const s = feed([taskEvent({ taskId: "t1", ruling: "pending", at: 1 })]);
    const ev = taskEvent({ taskId: "t1", ruling: "accept", report: report("accept", 0.5), at: 2 });
    const out1 = laneApply(s, ev);
    const out2 = laneApply(s, ev);
    expect(out1).toEqual(out2);
    expect(out1).not.toBe(out2); // fresh object each call, no caching/mutation
  });

  it("renderVerifyLane is referentially pure: identical inputs always produce identical output", () => {
    const s = feed([taskEvent({ taskId: "t1", ruling: "accept", report: report("accept", 0.9) })]);
    const readout = vtphReadout(freshVtph());
    expect(renderVerifyLane(s, readout, 72, 6)).toEqual(renderVerifyLane(s, readout, 72, 6));
  });

  it("vtphReadout is referentially pure", () => {
    const input = freshVtph();
    expect(vtphReadout(input)).toEqual(vtphReadout(input));
  });
});
