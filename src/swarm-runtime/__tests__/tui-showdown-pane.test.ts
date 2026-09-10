import { describe, it, expect } from "vitest";
import {
  initialShowdownPaneState,
  showdownReducer,
  renderShowdownPane,
  type ShowdownPaneState,
  type ShowdownPaneEvent,
  type ShowdownPaneResult,
} from "../tui/showdown-pane";

const allLinesExactly = (s: string, width: number) =>
  s.split("\n").every((l) => [...l].length === width);
const maxLineLen = (s: string) => Math.max(...s.split("\n").map((l) => [...l].length));

const modeledResult: ShowdownPaneResult = {
  swarmVtph: 41.75,
  baselineVtph: 12.5,
  multiple: 3.34,
  swarmVerified: 87,
  baselineVerified: 63,
  swarmSilentWrong: 0,
  baselineSilentWrong: 14,
  auditOk: true,
};

const realResult: ShowdownPaneResult = {
  swarmVtph: 9.125,
  baselineVtph: 4.5,
  multiple: 2.0278,
  swarmVerified: 22,
  baselineVerified: 18,
  swarmSilentWrong: 0,
  baselineSilentWrong: 3,
  auditOk: true,
};

const failedAuditResult: ShowdownPaneResult = {
  ...modeledResult,
  auditOk: false,
};

describe("initialShowdownPaneState", () => {
  it("starts idle with no run data", () => {
    const st = initialShowdownPaneState();
    expect(st).toEqual({ phase: "idle" });
  });
});

describe("showdownReducer — transition matrix", () => {
  const phases: ShowdownPaneState[] = [
    { phase: "idle" },
    { phase: "running", mode: "modeled", progress: { done: 3, total: 10 } },
    { phase: "done", mode: "modeled", progress: { done: 10, total: 10 }, result: modeledResult },
    { phase: "failed", mode: "modeled", error: "boom" },
  ];

  const events: ShowdownPaneEvent[] = [
    { type: "start", mode: "modeled", total: 10 },
    { type: "progress", done: 5 },
    { type: "done", result: modeledResult },
    { type: "fail", error: "explosion" },
  ];

  it("never throws for any (phase, event) pair and always returns a well-formed state", () => {
    for (const st of phases) {
      for (const ev of events) {
        expect(() => showdownReducer(st, ev)).not.toThrow();
        const next = showdownReducer(st, ev);
        expect(["idle", "running", "done", "failed"]).toContain(next.phase);
      }
    }
  });

  it("idle + start -> running with fresh progress at 0/total", () => {
    const next = showdownReducer({ phase: "idle" }, { type: "start", mode: "real", total: 20 });
    expect(next).toEqual({
      phase: "running",
      mode: "real",
      progress: { done: 0, total: 20 },
      result: undefined,
      error: undefined,
    });
  });

  it("idle + progress/done/fail are illegal: state unchanged by reference", () => {
    const st: ShowdownPaneState = { phase: "idle" };
    expect(showdownReducer(st, { type: "progress", done: 5 })).toBe(st);
    expect(showdownReducer(st, { type: "done", result: modeledResult })).toBe(st);
    expect(showdownReducer(st, { type: "fail", error: "x" })).toBe(st);
  });

  it("running + start is a double-start: illegal, state unchanged by reference", () => {
    const st: ShowdownPaneState = { phase: "running", mode: "modeled", progress: { done: 2, total: 10 } };
    const next = showdownReducer(st, { type: "start", mode: "real", total: 999 });
    expect(next).toBe(st);
  });

  it("running + progress updates done, clamped to [0, total]", () => {
    const st: ShowdownPaneState = { phase: "running", mode: "modeled", progress: { done: 2, total: 10 } };
    const next = showdownReducer(st, { type: "progress", done: 7 });
    expect(next.progress).toEqual({ done: 7, total: 10 });
    expect(next).not.toBe(st);

    const overshoot = showdownReducer(st, { type: "progress", done: 999 });
    expect(overshoot.progress).toEqual({ done: 10, total: 10 });

    const undershoot = showdownReducer(st, { type: "progress", done: -50 });
    expect(undershoot.progress).toEqual({ done: 0, total: 10 });

    const nonFinite = showdownReducer(st, { type: "progress", done: NaN });
    expect(nonFinite.progress).toEqual({ done: 0, total: 10 });
  });

  it("running + done -> done, clamps progress to exactly total regardless of last progress value", () => {
    const st: ShowdownPaneState = { phase: "running", mode: "modeled", progress: { done: 3, total: 10 } };
    const next = showdownReducer(st, { type: "done", result: modeledResult });
    expect(next.phase).toBe("done");
    expect(next.progress).toEqual({ done: 10, total: 10 });
    expect(next.result).toBe(modeledResult);
    expect(next.error).toBeUndefined();
  });

  it("running + fail -> failed, sets error and drops result", () => {
    const st: ShowdownPaneState = {
      phase: "running",
      mode: "modeled",
      progress: { done: 3, total: 10 },
      result: undefined,
    };
    const next = showdownReducer(st, { type: "fail", error: "provider timeout" });
    expect(next.phase).toBe("failed");
    expect(next.error).toBe("provider timeout");
    expect(next.result).toBeUndefined();
  });

  it("done + progress is illegal (progress after done): state unchanged by reference", () => {
    const st: ShowdownPaneState = {
      phase: "done",
      mode: "modeled",
      progress: { done: 10, total: 10 },
      result: modeledResult,
    };
    expect(showdownReducer(st, { type: "progress", done: 3 })).toBe(st);
  });

  it("done + fail is illegal (fail after done): state unchanged by reference", () => {
    const st: ShowdownPaneState = {
      phase: "done",
      mode: "modeled",
      progress: { done: 10, total: 10 },
      result: modeledResult,
    };
    expect(showdownReducer(st, { type: "fail", error: "late failure" })).toBe(st);
  });

  it("done + done is illegal (double-done): state unchanged by reference", () => {
    const st: ShowdownPaneState = {
      phase: "done",
      mode: "modeled",
      progress: { done: 10, total: 10 },
      result: modeledResult,
    };
    expect(showdownReducer(st, { type: "done", result: realResult })).toBe(st);
  });

  it("done + start is legal: starts a fresh run and clears the prior result", () => {
    const st: ShowdownPaneState = {
      phase: "done",
      mode: "modeled",
      progress: { done: 10, total: 10 },
      result: modeledResult,
    };
    const next = showdownReducer(st, { type: "start", mode: "real", total: 5 });
    expect(next.phase).toBe("running");
    expect(next.mode).toBe("real");
    expect(next.progress).toEqual({ done: 0, total: 5 });
    expect(next.result).toBeUndefined();
  });

  it("failed + start is legal: retries with a fresh run", () => {
    const st: ShowdownPaneState = { phase: "failed", mode: "modeled", error: "boom" };
    const next = showdownReducer(st, { type: "start", mode: "modeled", total: 4 });
    expect(next.phase).toBe("running");
    expect(next.progress).toEqual({ done: 0, total: 4 });
    expect(next.error).toBeUndefined();
  });

  it("failed + progress/done/fail are illegal: state unchanged by reference", () => {
    const st: ShowdownPaneState = { phase: "failed", mode: "modeled", error: "boom" };
    expect(showdownReducer(st, { type: "progress", done: 1 })).toBe(st);
    expect(showdownReducer(st, { type: "done", result: modeledResult })).toBe(st);
    expect(showdownReducer(st, { type: "fail", error: "again" })).toBe(st);
  });

  it("is immutable: the input state object is never mutated by any transition, legal or illegal", () => {
    for (const st of phases) {
      const before = JSON.parse(JSON.stringify(st));
      for (const ev of events) {
        showdownReducer(st, ev);
      }
      expect(st).toEqual(before);
    }
  });

  it("total: a zero-task run (total=0) starts, accepts progress, and completes without dividing by zero", () => {
    let st = showdownReducer({ phase: "idle" }, { type: "start", mode: "modeled", total: 0 });
    expect(st.progress).toEqual({ done: 0, total: 0 });
    st = showdownReducer(st, { type: "progress", done: 5 });
    expect(st.progress).toEqual({ done: 0, total: 0 });
    st = showdownReducer(st, { type: "done", result: modeledResult });
    expect(st.phase).toBe("done");
    expect(st.progress).toEqual({ done: 0, total: 0 });
  });
});

describe("renderShowdownPane — idle", () => {
  it("explains how to start a run", () => {
    const out = renderShowdownPane(initialShowdownPaneState());
    expect(out.toLowerCase()).toContain("no run in progress");
  });

  for (const width of [40, 72, 100]) {
    it(`respects the width hard-clamp at width=${width}`, () => {
      const out = renderShowdownPane(initialShowdownPaneState(), width);
      expect(allLinesExactly(out, width)).toBe(true);
    });
  }
});

describe("renderShowdownPane — running", () => {
  const running: ShowdownPaneState = { phase: "running", mode: "real", progress: { done: 4, total: 10 } };

  it("shows a meter bar with the real done/total figures", () => {
    const out = renderShowdownPane(running);
    expect(out).toContain("4/10");
    expect(out).toMatch(/\[█+░*\]/);
  });

  it("meter is fully filled at done === total and empty at done === 0", () => {
    const full = renderShowdownPane({ phase: "running", mode: "modeled", progress: { done: 10, total: 10 } });
    expect(full).toMatch(/\[█{20}\] 10\/10/);
    const empty = renderShowdownPane({ phase: "running", mode: "modeled", progress: { done: 0, total: 10 } });
    expect(empty).toMatch(/\[░{20}\] 0\/10/);
  });

  it("handles a zero-total run without crashing or dividing by zero", () => {
    const out = renderShowdownPane({ phase: "running", mode: "modeled", progress: { done: 0, total: 0 } });
    expect(out).toContain("0/0");
  });

  for (const width of [40, 72, 100]) {
    it(`respects the width hard-clamp at width=${width}`, () => {
      const out = renderShowdownPane(running, width);
      expect(allLinesExactly(out, width)).toBe(true);
    });
  }
});

describe("renderShowdownPane — done (mode honesty)", () => {
  it('suffixes every numeric figure with "(modeled)" for a modeled run', () => {
    const out = renderShowdownPane({ phase: "done", mode: "modeled", result: modeledResult });
    const figures = [
      modeledResult.swarmVtph.toFixed(2),
      modeledResult.baselineVtph.toFixed(2),
      `${modeledResult.multiple.toFixed(2)}x`,
      String(modeledResult.swarmVerified),
      String(modeledResult.baselineVerified),
      String(modeledResult.swarmSilentWrong),
      String(modeledResult.baselineSilentWrong),
    ];
    for (const f of figures) {
      // Each figure is immediately followed by the honesty suffix.
      expect(out).toContain(`${f} (modeled)`);
    }
    // No numeric figure escapes without the suffix: every occurrence of the
    // multiple's raw number is inside a "(modeled)"-suffixed token.
    const bareMultiple = new RegExp(`${modeledResult.multiple.toFixed(2)}x(?! \\(modeled\\))`);
    expect(out).not.toMatch(bareMultiple);
  });

  it("carries no (modeled) suffix for a real run, and figures pass through unaltered", () => {
    const out = renderShowdownPane({ phase: "done", mode: "real", result: realResult });
    expect(out).not.toContain("(modeled)");
    expect(out).toContain(realResult.swarmVtph.toFixed(2));
    expect(out).toContain(realResult.baselineVtph.toFixed(2));
    expect(out).toContain(`${realResult.multiple.toFixed(2)}x`);
    expect(out).toContain(String(realResult.swarmVerified));
    expect(out).toContain(String(realResult.baselineSilentWrong));
  });

  it("figures originate in the fixture and pass through unaltered (no fabrication)", () => {
    const custom: ShowdownPaneResult = {
      swarmVtph: 123.456,
      baselineVtph: 7.001,
      multiple: 17.63,
      swarmVerified: 555,
      baselineVerified: 1,
      swarmSilentWrong: 2,
      baselineSilentWrong: 400,
      auditOk: true,
    };
    const out = renderShowdownPane({ phase: "done", mode: "real", result: custom });
    expect(out).toContain("123.46"); // toFixed(2) of the exact fixture value
    expect(out).toContain("7.00");
    expect(out).toContain("555");
    expect(out).toContain("400");
  });
});

describe("renderShowdownPane — done (audit banner)", () => {
  it("renders the tampered-audit banner verbatim when auditOk is false", () => {
    const out = renderShowdownPane({ phase: "done", mode: "modeled", result: failedAuditResult });
    expect(out).toContain("AUDIT CHAIN FAILED — DO NOT TRUST THESE NUMBERS");
  });

  it("does not render the banner when auditOk is true", () => {
    const out = renderShowdownPane({ phase: "done", mode: "modeled", result: modeledResult });
    expect(out).not.toContain("AUDIT CHAIN FAILED");
  });

  for (const width of [40, 72, 100]) {
    it(`banner respects the width hard-clamp at width=${width}`, () => {
      const out = renderShowdownPane({ phase: "done", mode: "modeled", result: failedAuditResult }, width);
      expect(allLinesExactly(out, width)).toBe(true);
      expect(out).toContain("AUDIT CHAIN FAILED");
    });
  }
});

describe("renderShowdownPane — done, width discipline", () => {
  for (const width of [40, 72, 100]) {
    it(`clamps every line to exactly width=${width} for modeled and real results`, () => {
      const modeledOut = renderShowdownPane({ phase: "done", mode: "modeled", result: modeledResult }, width);
      const realOut = renderShowdownPane({ phase: "done", mode: "real", result: realResult }, width);
      expect(allLinesExactly(modeledOut, width)).toBe(true);
      expect(allLinesExactly(realOut, width)).toBe(true);
    });
  }

  it("is total over a done state with no result recorded (defensive, should not throw)", () => {
    const out = renderShowdownPane({ phase: "done", mode: "modeled" });
    expect(() => out).not.toThrow();
    expect(typeof out).toBe("string");
  });
});

describe("renderShowdownPane — failed", () => {
  it("shows the error message", () => {
    const out = renderShowdownPane({ phase: "failed", error: "provider returned 500" });
    expect(out).toContain("provider returned 500");
  });

  it("truncates an overlong error to fit the pane width instead of overflowing", () => {
    const longError = "connection reset by peer: " + "x".repeat(500);
    const out = renderShowdownPane({ phase: "failed", error: longError }, 40);
    expect(allLinesExactly(out, 40)).toBe(true);
    expect(maxLineLen(out)).toBeLessThanOrEqual(40);
    expect(out).toContain("…");
  });

  it("handles unicode error text without breaking width discipline", () => {
    const out = renderShowdownPane({ phase: "failed", error: "エラー: 接続に失敗しました 🔥🔥🔥" }, 40);
    expect(allLinesExactly(out, 40)).toBe(true);
  });

  it("handles a missing error message gracefully", () => {
    const out = renderShowdownPane({ phase: "failed" });
    expect(typeof out).toBe("string");
    expect(allLinesExactly(out, 72)).toBe(true);
  });

  for (const width of [40, 72, 100]) {
    it(`respects the width hard-clamp at width=${width}`, () => {
      const out = renderShowdownPane({ phase: "failed", error: "boom" }, width);
      expect(allLinesExactly(out, width)).toBe(true);
    });
  }
});
