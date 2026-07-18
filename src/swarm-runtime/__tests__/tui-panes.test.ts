import { describe, it, expect } from "vitest";
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

type Worker = NonNullable<TuiState["workers"]>[number];
type LogEntry = NonNullable<TuiState["logs"]>[number];

const workers: Worker[] = [
  { workerId: "w-1", status: "idle", capabilities: ["research"] },
  { workerId: "w-2", status: "busy", capabilities: ["code", "test"] },
  { workerId: "w-3", status: "failed", capabilities: [] },
];

function makeLogs(n: number): LogEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    workerId: `w-${(i % 3) + 1}`,
    line: `event number ${i}`,
  }));
}

const cpWidths = (s: string) => new Set(s.split("\n").map((l) => [...l].length));

describe("renderLogPane", () => {
  it("is deterministic and width/height exact", () => {
    const out = renderLogPane(makeLogs(20), { width: 40, height: 6 });
    expect(out).toBe(renderLogPane(makeLogs(20), { width: 40, height: 6 }));
    expect(cpWidths(out)).toEqual(new Set([40]));
    // header + `height` rows + footer
    expect(out.split("\n").length).toBe(6 + 2);
  });

  it("shows a `…more` marker when older lines overflow", () => {
    const out = renderLogPane(makeLogs(20), { width: 40, height: 5 });
    expect(out).toMatch(/…\(\d+ more\)/);
    // most recent entry is visible, oldest is not
    expect(out).toContain("event number 19");
    expect(out).not.toContain("event number 5");
  });

  it("has no marker when everything fits", () => {
    const out = renderLogPane(makeLogs(3), { width: 40, height: 8 });
    expect(out).not.toMatch(/more\)/);
    expect(out).toContain("event number 0");
    expect(out).toContain("event number 2");
  });

  it("scrollOffset pages back into history and is clamped", () => {
    const logs = makeLogs(20);
    const back = renderLogPane(logs, { width: 40, height: 5, scrollOffset: 10 });
    expect(back).toContain("event number 9");
    // absurd offset clamps to the top rather than blanking the pane
    const maxed = renderLogPane(logs, { width: 40, height: 5, scrollOffset: 9999 });
    expect(maxed).toContain("event number 0");
    expect(cpWidths(maxed)).toEqual(new Set([40]));
  });

  it("renders an honest empty state and prefixes worker ids", () => {
    const empty = renderLogPane([], { width: 40, height: 4 });
    expect(empty).toContain("(no log output yet)");
    expect(cpWidths(empty)).toEqual(new Set([40]));
    const one = renderLogPane([{ workerId: "w-2", line: "hello" }], { width: 40, height: 4 });
    expect(one).toContain("[w-2] hello");
  });
});

describe("renderWorkerDetail", () => {
  it("renders known + extra fields, width exact and deterministic", () => {
    const extended = { ...workers[1], pid: 4242, host: "vps-1" } as unknown as Worker;
    const out = renderWorkerDetail(extended, { width: 34 });
    expect(out).toBe(renderWorkerDetail(extended, { width: 34 }));
    expect(cpWidths(out)).toEqual(new Set([34]));
    expect(out).toContain("w-2");
    expect(out).toContain("status");
    expect(out).toContain("busy");
    expect(out).toContain("code, test");
    expect(out).toContain("pid");
    expect(out).toContain("4242");
    expect(out).toContain("host");
  });

  it("renders an honest empty state when no worker is selected", () => {
    const out = renderWorkerDetail(undefined, { width: 34 });
    expect(out).toContain("(no worker selected)");
    expect(cpWidths(out)).toEqual(new Set([34]));
  });

  it("shows a dash for empty capabilities", () => {
    const out = renderWorkerDetail(workers[2], { width: 34 });
    expect(out).toContain("w-3");
    expect(out).toMatch(/capabilities\s+—/);
  });
});

describe("renderSplit", () => {
  it("aligns two columns so every line is exactly `width` wide", () => {
    const left = renderWorkerDetail(workers[0], { width: 30 });
    const right = renderLogPane(makeLogs(12), { width: 36, height: 10 });
    const out = renderSplit(left, right, 72);
    for (const line of out.split("\n")) {
      expect([...line].length).toBe(72);
    }
  });

  it("pads the shorter column and keeps a stable separator", () => {
    const out = renderSplit("a\nb\nc", "x", 21);
    const lines = out.split("\n");
    expect(lines.length).toBe(3); // driven by the taller block
    for (const line of lines) expect([...line].length).toBe(21);
    expect(lines[0]).toContain(" │ ");
  });

  it("truncates overflow instead of widening the line", () => {
    const out = renderSplit("x".repeat(200), "y".repeat(200), 40);
    for (const line of out.split("\n")) {
      expect([...line].length).toBe(40);
      expect(line).toContain("…");
    }
  });

  it("counts width by code points for multi-byte content", () => {
    const out = renderSplit("● busy 世界", "日本語ログ", 30);
    for (const line of out.split("\n")) {
      expect([...line].length).toBe(30);
    }
  });
});

describe("PaneViewState helpers", () => {
  it("moveWorkerSelection clamps at both bounds without wrapping", () => {
    let v: PaneViewState = {};
    v = moveWorkerSelection(v, workers, 1); // picks first
    expect(v.selectedWorkerId).toBe("w-1");
    v = moveWorkerSelection(v, workers, -1); // clamp at top
    expect(v.selectedWorkerId).toBe("w-1");
    v = moveWorkerSelection(v, workers, 1);
    v = moveWorkerSelection(v, workers, 1);
    expect(v.selectedWorkerId).toBe("w-3");
    v = moveWorkerSelection(v, workers, 1); // clamp at bottom
    expect(v.selectedWorkerId).toBe("w-3");
  });

  it("moveWorkerSelection is immutable and handles an empty pool", () => {
    const v: PaneViewState = { selectedWorkerId: "w-2" };
    const next = moveWorkerSelection(v, [], 1);
    expect(next).not.toBe(v);
    expect(v.selectedWorkerId).toBe("w-2");
    expect(next.selectedWorkerId).toBeUndefined();
  });

  it("selectedWorker resolves the current selection", () => {
    expect(selectedWorker({ selectedWorkerId: "w-2" }, workers)?.status).toBe("busy");
    expect(selectedWorker({ selectedWorkerId: "nope" }, workers)).toBeUndefined();
    expect(selectedWorker({}, workers)).toBeUndefined();
  });

  it("scrollLog clamps to [0, maxOffset] and is immutable", () => {
    const max = logMaxOffset(20, 5); // 15
    expect(max).toBe(15);
    let v: PaneViewState = {};
    v = scrollLog(v, 100, max);
    expect(v.logScrollOffset).toBe(15);
    v = scrollLog(v, -100, max);
    expect(v.logScrollOffset).toBe(0);
    const before: PaneViewState = { logScrollOffset: 3 };
    const after = scrollLog(before, 2, max);
    expect(after).not.toBe(before);
    expect(before.logScrollOffset).toBe(3);
    expect(after.logScrollOffset).toBe(5);
  });
});
