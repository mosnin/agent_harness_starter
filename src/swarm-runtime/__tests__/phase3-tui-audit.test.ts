/**
 * Phase 3 ADVERSARIAL AUDIT — TUI panes (Team 5) + TUI history (Team 6).
 *
 * Written by "Adversarial Verifier B". The goal of this file is NOT to restate
 * the authors' own happy-path tests but to actively try to BREAK the two
 * JS-testable workstreams and prove the claims they make are real:
 *
 *   panes.ts   — "every output line is exactly `width` code points" and the
 *                log pane's "…(N more)" marker counts hidden entries HONESTLY
 *                (no off-by-one that over- or under-reports lost lines), and the
 *                selection/scroll helpers clamp with no out-of-range / negative.
 *   history.ts — the module is REALLY clock-free (proven twice: a runtime Date
 *                trap AND a comment-stripped source scan), memory caps trim AND
 *                report dropped counts honestly (conservation law), recorded
 *                frames are isolated from later deep mutation, and replay clamps.
 *
 * The Rust (Team 1) and installer (Team 8) workstreams are verified by running
 * the real commands out-of-band; see the auditor's report, not this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { TuiState } from "../tui/render";
import {
  renderLogPane,
  renderWorkerDetail,
  renderSplit,
  moveWorkerSelection,
  selectedWorker,
  scrollLog,
  logMaxOffset,
  type PaneViewState,
} from "../tui/panes";
import {
  HistoryRecorder,
  initReplay,
  replayReduce,
  replayNext,
  replayLast,
  currentFrame,
  formatDuration,
  renderHistoryList,
  renderReplayBar,
} from "../tui/history";

type Worker = NonNullable<TuiState["workers"]>[number];
type LogEntry = NonNullable<TuiState["logs"]>[number];

const cpLen = (s: string) => [...s].length;
const lineWidths = (block: string) => block.split("\n").map(cpLen);
const distinctWidths = (block: string) => new Set(lineWidths(block));

function makeLogs(n: number, line = (i: number) => `event number ${i}`): LogEntry[] {
  return Array.from({ length: n }, (_, i) => ({ workerId: `w-${(i % 3) + 1}`, line: line(i) }));
}

// ===========================================================================
// TEAM 5 — panes.ts : width-exactness is REALLY in code points (emoji attack)
// ===========================================================================

describe("panes width-exactness under multi-byte / emoji / overflow", () => {
  // Astral (surrogate-pair) emoji, CJK wide chars, a combining mark, and box
  // glyphs. Each is thrown at the width machinery to prove the count is by code
  // point, not by UTF-16 code unit (which would double-count surrogate pairs and
  // blow the border alignment).
  const nasty = [
    "🚀 launch 🌍 世界 café",     // surrogate pairs + CJK + accented latin
    "日本語ログ ● ◐ ✗ ○",       // CJK + status glyphs
    "👍👎🔥💥🧪🛰️",              // run of astral emoji (+ a variation selector)
    "áè",             // combining accents (each combining mark is its own code point)
    "─┤├╭╮╰╯│",                  // box-drawing glyphs
    "x".repeat(300),             // pure overflow
    "",                          // empty
  ];

  it("renderSplit yields lines EXACTLY `width` code points for every width/content mix", () => {
    for (const width of [12, 20, 29, 30, 40, 41, 72, 100]) {
      for (const left of nasty) {
        for (const right of nasty) {
          const out = renderSplit(left, right, width);
          for (const line of out.split("\n")) {
            expect(cpLen(line)).toBe(width);
          }
        }
      }
    }
  });

  it("renderSplit truncates overflow with an ellipsis instead of widening", () => {
    const out = renderSplit("🚀".repeat(200), "世".repeat(200), 40);
    for (const line of out.split("\n")) {
      expect(cpLen(line)).toBe(40);
      expect(line).toContain("…");
    }
  });

  it("renderLogPane stays width-exact when log lines contain astral emoji", () => {
    const logs = makeLogs(30, (i) => `🚀 step ${i} 世界 done ✅ ${"…".repeat(i % 4)}`);
    for (const width of [24, 33, 40, 50]) {
      for (const height of [1, 2, 5, 8]) {
        const out = renderLogPane(logs, { width, height });
        expect(distinctWidths(out)).toEqual(new Set([width]));
        // header + height rows + footer
        expect(out.split("\n").length).toBe(height + 2);
      }
    }
  });

  it("renderWorkerDetail stays width-exact with an emoji-laden extra field", () => {
    const w = {
      workerId: "w-🚀",
      status: "busy",
      capabilities: ["研究", "código"],
      note: "handling 世界 事件 🌍🔥",
    } as unknown as Worker;
    for (const width of [20, 34, 48]) {
      expect(distinctWidths(renderWorkerDetail(w, { width }))).toEqual(new Set([width]));
    }
    // honest empty state is width-exact too
    expect(distinctWidths(renderWorkerDetail(undefined, { width: 34 }))).toEqual(new Set([34]));
  });
});

// ===========================================================================
// TEAM 5 — panes.ts : the "…(N more)" marker counts HONESTLY (no lying)
// ===========================================================================

describe("renderLogPane '…(N more)' marker is honest (conservation law)", () => {
  // At the live tail (scrollOffset 0) NOTHING is scrolled past below the window,
  // so every entry is either visible or counted as hidden-above. The marker must
  // therefore satisfy:  hidden + visibleDataRows === total  — exactly. An
  // off-by-one that inflates or hides lost lines breaks this for some (total,h).
  it("hidden count + visible entries == total for every (total,height) at the tail", () => {
    for (let total = 0; total <= 40; total++) {
      for (let height = 1; height <= 12; height++) {
        const out = renderLogPane(makeLogs(total), { width: 44, height });
        const lines = out.split("\n").slice(1, -1); // strip box header/footer
        const marker = out.match(/…\((\d+) more\)/);
        const hidden = marker ? Number(marker[1]) : 0;

        // Count real data rows (worker-id prefixed), ignoring blanks/marker/empty-state.
        const visible = lines.filter((l) => /\[w-\d+\]/.test(l)).length;

        if (total === 0) {
          expect(out).toContain("(no log output yet)");
          expect(marker).toBeNull();
          continue;
        }
        // Honesty core: the marker must never claim MORE hidden than exist
        // (no inflation) and every entry is accounted for exactly once — shown
        // or honestly reported hidden (no silent loss, no double count).
        expect(hidden).toBeGreaterThanOrEqual(0);
        expect(hidden).toBeLessThanOrEqual(total);
        expect(hidden + visible).toBe(total);
        // When a marker appears it is because data genuinely overflowed the box.
        if (marker) expect(total).toBeGreaterThan(height);
        // No marker means everything fit.
        if (!marker) expect(total).toBeLessThanOrEqual(height);
      }
    }
  });

  it("degenerate 1-row pane spends its only row on the marker but stays HONEST", () => {
    // OBSERVATION (not a lie): with height=1 and >1 entries, the single row is
    // consumed by the "…(N more)" marker, so NO log line is visible. The count
    // is still accurate (all N entries are genuinely not shown) and conservation
    // holds — but a 1-row log pane is effectively marker-only. Cosmetic, honest.
    const out = renderLogPane(makeLogs(2), { width: 30, height: 1 });
    expect(out.split("\n").slice(1, -1).filter((l) => /\[w-\d+\]/.test(l))).toHaveLength(0);
    expect(out).toMatch(/…\(2 more\)/); // count is truthful: both entries hidden
  });

  it("the newest entry is always visible at the tail; the oldest hidden one is not", () => {
    const out = renderLogPane(makeLogs(50), { width: 44, height: 6 });
    expect(out).toContain("event number 49"); // newest shown
    expect(out).not.toContain("event number 0"); // oldest dropped from view
    // 50 total, 6-row box => marker row + 5 data rows => 45 hidden.
    expect(out).toMatch(/…\(45 more\)/);
  });

  it("scrollOffset pages back and is clamped both ways without blanking the pane", () => {
    const logs = makeLogs(30);
    const back = renderLogPane(logs, { width: 44, height: 6, scrollOffset: 10 });
    expect(back).toContain("event number 19");
    const overshoot = renderLogPane(logs, { width: 44, height: 6, scrollOffset: 999999 });
    expect(overshoot).toContain("event number 0"); // clamps to top, shows oldest
    expect(distinctWidths(overshoot)).toEqual(new Set([44]));
    const negative = renderLogPane(logs, { width: 44, height: 6, scrollOffset: -50 });
    // negative clamps to the live tail (same as offset 0)
    expect(negative).toBe(renderLogPane(logs, { width: 44, height: 6, scrollOffset: 0 }));
  });

  it("logMaxOffset never goes negative and matches the honest scrollback ceiling", () => {
    expect(logMaxOffset(0, 8)).toBe(0);
    expect(logMaxOffset(3, 8)).toBe(0);
    expect(logMaxOffset(20, 5)).toBe(15);
    expect(logMaxOffset(5, 0)).toBeGreaterThanOrEqual(0); // degenerate height, no negatives
  });
});

// ===========================================================================
// TEAM 5 — panes.ts : selection + scroll helpers clamp (no OOB / negatives)
// ===========================================================================

describe("pane view-state helpers clamp and never go out of range", () => {
  const workers: Worker[] = [
    { workerId: "w-1", status: "idle", capabilities: [] },
    { workerId: "w-2", status: "busy", capabilities: [] },
    { workerId: "w-3", status: "failed", capabilities: [] },
  ];

  it("moveWorkerSelection clamps at both ends for absurd step magnitudes", () => {
    let v: PaneViewState = {};
    v = moveWorkerSelection(v, workers, +100); // from unselected, +dir picks first
    expect(v.selectedWorkerId).toBe("w-1");
    v = moveWorkerSelection(v, workers, +100); // clamp at bottom
    expect(v.selectedWorkerId).toBe("w-3");
    v = moveWorkerSelection(v, workers, -100); // clamp at top
    expect(v.selectedWorkerId).toBe("w-1");
    // selection always resolves to a REAL worker (never undefined for a non-empty pool)
    expect(selectedWorker(v, workers)).toBeDefined();
  });

  it("moveWorkerSelection from unselected with a negative dir picks the LAST worker", () => {
    const v = moveWorkerSelection({}, workers, -1);
    expect(v.selectedWorkerId).toBe("w-3");
  });

  it("moveWorkerSelection is immutable and clears selection for an empty pool", () => {
    const before: PaneViewState = { selectedWorkerId: "w-2", logScrollOffset: 4 };
    const after = moveWorkerSelection(before, [], 1);
    expect(after).not.toBe(before);
    expect(before.selectedWorkerId).toBe("w-2"); // input untouched
    expect(after.selectedWorkerId).toBeUndefined();
    expect(after.logScrollOffset).toBe(4); // unrelated field preserved
  });

  it("moveWorkerSelection recovers when the selected id no longer exists", () => {
    const stale: PaneViewState = { selectedWorkerId: "ghost" };
    const next = moveWorkerSelection(stale, workers, +1);
    // indexOf('ghost') === -1 => treated as unselected => +dir picks the first
    expect(next.selectedWorkerId).toBe("w-1");
  });

  it("scrollLog clamps to [0, maxOffset], never negative, and is immutable", () => {
    const max = logMaxOffset(30, 6); // 24
    let v: PaneViewState = {};
    v = scrollLog(v, 10_000, max);
    expect(v.logScrollOffset).toBe(24);
    v = scrollLog(v, -10_000, max);
    expect(v.logScrollOffset).toBe(0);
    // with no explicit ceiling it still refuses to go negative
    expect(scrollLog({}, -5).logScrollOffset).toBe(0);
    const before: PaneViewState = { logScrollOffset: 3 };
    const after = scrollLog(before, 2, max);
    expect(after).not.toBe(before);
    expect(before.logScrollOffset).toBe(3);
  });
});

// ===========================================================================
// TEAM 6 — history.ts : REALLY clock-free (runtime trap + source scan)
// ===========================================================================

describe("history.ts is genuinely clock-free", () => {
  it("runs a full record/replay/render cycle with the global clock booby-trapped", () => {
    const RealDate = globalThis.Date;
    const RealPerf = globalThis.performance;
    // Any attempt to read the wall clock now throws.
    function TrapDate(): never {
      throw new Error("history.ts consulted Date()");
    }
    (TrapDate as unknown as { now: () => number }).now = () => {
      throw new Error("history.ts consulted Date.now()");
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = TrapDate;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).performance = {
        now: () => {
          throw new Error("history.ts consulted performance.now()");
        },
      };

      expect(() => {
        const rec = new HistoryRecorder(4);
        rec.beginRun("g1", "Analyze 世界 🚀", 1000);
        for (let i = 0; i < 10; i++) rec.recordFrame(baseFrame(i), 1000 + i);
        rec.endRun("completed", 9000);
        const run = rec.get("g1")!;
        // exercise every clock-suspect surface
        formatDuration(run);
        renderHistoryList(rec.list(), 0);
        renderReplayBar(run, initReplay(run));
        currentFrame(run, initReplay(run));
        replayReduce(run, initReplay(run), "next");
      }).not.toThrow();
    } finally {
      globalThis.Date = RealDate;
      globalThis.performance = RealPerf;
    }
  });

  it("contains no clock API tokens in its source (comments stripped)", () => {
    const src = readFileSync(historySourcePath(), "utf8");
    const codeOnly = stripComments(src);
    expect(codeOnly).not.toMatch(/\bDate\s*\.\s*now\b/);
    expect(codeOnly).not.toMatch(/\bnew\s+Date\b/);
    expect(codeOnly).not.toMatch(/\bperformance\s*\.\s*now\b/);
    expect(codeOnly).not.toMatch(/\bDate\s*\(/);
    // sanity: the stripper kept real code (so the assertions above aren't vacuous)
    expect(codeOnly).toMatch(/class HistoryRecorder/);
  });
});

// ===========================================================================
// TEAM 6 — history.ts : caps trim AND report honestly (conservation law)
// ===========================================================================

describe("history.ts memory caps are honest (nothing silently lost)", () => {
  it("frames.length + droppedFrames == total recorded, for every cap/count", () => {
    for (const cap of [1, 2, 3, 5, 500]) {
      for (const recorded of [0, 1, cap - 1, cap, cap + 1, cap * 3 + 2].filter((n) => n >= 0)) {
        const rec = new HistoryRecorder(cap);
        rec.beginRun("g", "obj", 0);
        for (let i = 0; i < recorded; i++) rec.recordFrame(baseFrame(i), 100 + i);
        const run = rec.get("g")!;
        // Conservation: retained + dropped accounts for every recorded frame.
        expect(run.frames.length + run.droppedFrames).toBe(recorded);
        // Retained is exactly min(cap, recorded); dropped is the honest remainder.
        expect(run.frames.length).toBe(Math.min(cap, recorded));
        expect(run.droppedFrames).toBe(Math.max(0, recorded - cap));
        // Timestamps stay parallel to retained frames (no drift under trimming).
        expect(run.frameTimestamps.length).toBe(run.frames.length);
        // The SURVIVORS are the most-recent ones (oldest dropped first).
        const survivors = run.frames.map((f) => f.metrics!.goals.running);
        const expectedStart = Math.max(0, recorded - cap);
        expect(survivors).toEqual(
          Array.from({ length: run.frames.length }, (_, i) => expectedStart + i),
        );
        expect(run.frameTimestamps).toEqual(
          Array.from({ length: run.frames.length }, (_, i) => 100 + expectedStart + i),
        );
      }
    }
  });

  it("renderHistoryList surfaces dropped frames as retained+dropped (no hidden loss)", () => {
    const rec = new HistoryRecorder(2);
    rec.beginRun("g1", "obj", 0);
    for (let i = 0; i < 9; i++) rec.recordFrame(baseFrame(i), i);
    rec.endRun("completed", 100);
    const out = renderHistoryList(rec.list());
    // 2 retained + 7 dropped = 9 recorded, shown honestly as "2+7f".
    expect(out).toContain("2+7f");
  });

  it("run retention cap evicts oldest runs and list() length never exceeds the cap", () => {
    const rec = new HistoryRecorder(500, 3);
    for (let i = 0; i < 10; i++) {
      rec.beginRun(`g${i}`, `run ${i}`, i);
      rec.endRun("completed", i + 1);
    }
    expect(rec.list().length).toBe(3);
    // Only the three most-recent survive; the older seven are gone (not hidden).
    expect(rec.list().map((r) => r.goalId)).toEqual(["g9", "g8", "g7"]);
    for (let i = 0; i <= 6; i++) expect(rec.get(`g${i}`)).toBeUndefined();
  });
});

// ===========================================================================
// TEAM 6 — history.ts : recorded frames isolated from LATER DEEP mutation
// ===========================================================================

describe("history.ts frames are deep-isolated from caller mutation", () => {
  it("mutating nested arrays/objects on the live state does not rewrite recorded frames", () => {
    const rec = new HistoryRecorder();
    rec.beginRun("g1", "obj", 0);

    const live: TuiState = {
      mode: "inline",
      workers: [{ workerId: "w-1", status: "busy", capabilities: ["research"] }],
      tasks: [{ description: "dig", status: "dispatched" }],
      logs: [{ workerId: "w-1", line: "started" }],
    };
    rec.recordFrame(live, 1);

    // Deeply mutate every nested container AFTER recording.
    live.mode = "MUTATED";
    live.workers![0].status = "dead";
    live.workers![0].capabilities!.push("HACKED");
    live.workers!.push({ workerId: "w-2", status: "idle" });
    live.tasks![0].description = "MUTATED";
    live.logs![0].line = "MUTATED";
    live.logs!.push({ workerId: "w-9", line: "injected" });

    const stored = rec.get("g1")!.frames[0];
    expect(stored.mode).toBe("inline");
    expect(stored.workers).toHaveLength(1);
    expect(stored.workers![0].status).toBe("busy");
    expect(stored.workers![0].capabilities).toEqual(["research"]);
    expect(stored.tasks![0].description).toBe("dig");
    expect(stored.logs).toHaveLength(1);
    expect(stored.logs![0].line).toBe("started");
  });
});

// ===========================================================================
// TEAM 6 — history.ts : replay clamps hard at bounds
// ===========================================================================

describe("history.ts replay clamps at bounds", () => {
  function runWithFrames(n: number) {
    const rec = new HistoryRecorder();
    rec.beginRun("g1", "obj", 0);
    for (let i = 0; i < n; i++) rec.recordFrame(baseFrame(i), i);
    rec.endRun("completed", n);
    return rec.get("g1")!;
  }

  it("next/last never exceed len-1 and prev/first never drop below 0", () => {
    const run = runWithFrames(5);
    let s = initReplay(run);
    for (let i = 0; i < 20; i++) s = replayNext(run, s);
    expect(s.frameIndex).toBe(4);
    s = replayLast(run, s);
    expect(s.frameIndex).toBe(4);
    for (let i = 0; i < 20; i++) s = replayReduce(run, s, "prev");
    expect(s.frameIndex).toBe(0);
  });

  it("currentFrame refuses out-of-range / mismatched / empty and never throws", () => {
    const run = runWithFrames(3);
    expect(currentFrame(run, { runId: "g1", frameIndex: 999 })).toBeNull();
    expect(currentFrame(run, { runId: "g1", frameIndex: -1 })).toBeNull();
    expect(currentFrame(run, { runId: "other", frameIndex: 0 })).toBeNull();

    const empty = (() => {
      const rec = new HistoryRecorder();
      rec.beginRun("e", "obj", 0);
      return rec.get("e")!;
    })();
    let s = initReplay(empty);
    s = replayNext(empty, s);
    s = replayLast(empty, s);
    expect(s.frameIndex).toBe(0);
    expect(currentFrame(empty, s)).toBeNull();
    expect(renderReplayBar(empty, s)).toContain("[frame 0/0]");
  });
});

// ===========================================================================
// helpers
// ===========================================================================

function baseFrame(running: number): TuiState {
  return {
    mode: "inline",
    metrics: {
      goals: { total: 1, completed: 0, failed: 0, aborted: 0, running },
      tasks: { total: 0, verified: 0, failed: 0, pending: 0, dispatched: 0 },
      workers: { total: 1, idle: 1, busy: 0, killed: 0, dead: 0 },
      verification: { total: 0, accepted: 0, rejected: 0, avgScore: 0, groundingRate: 0 },
      usage: { toolCalls: 0, costUsd: 0 },
    },
  };
}

function historySourcePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../tui/history.ts");
}

/** Remove /* *​/ block comments and // line comments so a token scan sees code only. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
