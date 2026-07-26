import { describe, it, expect } from "vitest";
import {
  emptyFleetPaneState,
  renderFleetPane,
  moveFleetSelection,
  fleetKeyToAction,
  type FleetPaneState,
  type FleetPaneBackendRow,
  type FleetPaneWorkerRow,
  type FleetPaneBanditRow,
} from "../tui/fleet-pane";

const backends: FleetPaneBackendRow[] = [
  { name: "vast-a1", kind: "vast", state: "ready", provisions: 12, accruedUsd: 3.14159, provisionLatencyEmaMs: 812.4 },
  { name: "runpod-b2", kind: "runpod", state: "provisioning", provisions: 0, accruedUsd: 0, provisionLatencyEmaMs: null },
  { name: "local-c3", kind: "local", state: "dead", provisions: 5, accruedUsd: 0.0001, provisionLatencyEmaMs: 12 },
];

const workers: FleetPaneWorkerRow[] = [
  { workerId: "w-1", backend: "vast-a1", lifecycle: "busy", idleMs: undefined },
  { workerId: "w-2", backend: "vast-a1", lifecycle: "idle", idleMs: 45231 },
  { workerId: "w-3", backend: "runpod-b2", lifecycle: "spawning" },
  { workerId: "w-4", lifecycle: "dead" },
];

const bandit: FleetPaneBanditRow[] = [
  { name: "vast", pulls: 40, verified: 37, meanReward: 0.8123, ucb: 0.9456 },
  { name: "runpod", pulls: 0, verified: 0, meanReward: 0, ucb: null },
  { name: "local", pulls: 3, verified: 1, meanReward: 0.3333, ucb: null },
];

function fullState(overrides: Partial<FleetPaneState> = {}): FleetPaneState {
  return { backends, workers, bandit, selection: 0, scroll: 0, height: 6, ...overrides };
}

const maxLineLen = (s: string) => Math.max(...s.split("\n").map((l) => [...l].length));
const allLinesExactly = (s: string, width: number) =>
  s.split("\n").every((l) => [...l].length === width);

describe("emptyFleetPaneState", () => {
  it("has no backends/workers/bandit rows and a sane default height", () => {
    const st = emptyFleetPaneState();
    expect(st.backends).toEqual([]);
    expect(st.workers).toEqual([]);
    expect(st.bandit).toEqual([]);
    expect(st.selection).toBe(0);
    expect(st.scroll).toBe(0);
    expect(st.height).toBeGreaterThan(0);
  });

  it("honors a custom height and floors/clamps to >= 1", () => {
    expect(emptyFleetPaneState(10).height).toBe(10);
    expect(emptyFleetPaneState(0).height).toBe(1);
    expect(emptyFleetPaneState(-5).height).toBe(1);
  });
});

/** Strip box-drawing borders/padding from a rendered pane and rejoin the
 *  interior text with single spaces, so a message that had to be word-wrapped
 *  to respect the width hard-clamp can still be checked for its full,
 *  unmangled content (word-wrap never changes the words or their order). */
function innerText(rendered: string): string {
  return rendered
    .split("\n")
    .filter((l) => l.startsWith("│"))
    .map((l) => l.slice(1, -1).trimEnd())
    .filter((l) => l.length > 0)
    .join(" ");
}

describe("renderFleetPane — empty state honesty", () => {
  it("never renders a bare empty box: shows the explicit no-fleet message (wrapped, not truncated, to honor the width hard-clamp)", () => {
    const out = renderFleetPane(emptyFleetPaneState());
    expect(innerText(out)).toContain(
      "no fleet attached — start a swarm with fleet wiring to populate this pane"
    );
  });

  it("contains no blank content rows for the empty state", () => {
    const out = renderFleetPane(emptyFleetPaneState());
    expect(innerText(out).trim().length).toBeGreaterThan(0);
  });

  it("is deterministic for the empty state", () => {
    const a = renderFleetPane(emptyFleetPaneState());
    const b = renderFleetPane(emptyFleetPaneState());
    expect(a).toBe(b);
  });

  for (const width of [40, 72, 100]) {
    it(`clamps every line to exactly width=${width} for the empty state`, () => {
      const out = renderFleetPane(emptyFleetPaneState(), width);
      expect(allLinesExactly(out, width)).toBe(true);
    });
  }
});

describe("renderFleetPane — populated state", () => {
  it("headers report real section counts", () => {
    const out = renderFleetPane(fullState());
    expect(out).toContain(`BACKENDS (${backends.length})`);
    expect(out).toContain(`WORKERS (${workers.length})`);
    expect(out).toContain(`ROUTING (${bandit.length})`);
  });

  it("prints accruedUsd to exactly 4 decimals", () => {
    const out = renderFleetPane(fullState());
    expect(out).toContain("$3.1416");
    expect(out).toContain("$0.0000");
    expect(out).toContain("$0.0001");
  });

  it("renders null provision latency as an em dash, not a fabricated number", () => {
    const out = renderFleetPane(fullState());
    expect(out).toMatch(/runpod-b2.*lat=—/);
  });

  it('never-pulled bandit arm renders "never pulled", never a fabricated 0.00 reward', () => {
    const out = renderFleetPane(fullState());
    expect(out).toMatch(/runpod\s+never pulled/);
    expect(out).not.toMatch(/runpod.*reward=0\.0000/);
  });

  it("renders ucb null as an em dash for a pulled arm", () => {
    const out = renderFleetPane(fullState());
    expect(out).toMatch(/local\s+pulls=3.*ucb=—/);
  });

  it("renders a real ucb value for a pulled arm that has one", () => {
    const out = renderFleetPane(fullState());
    expect(out).toMatch(/vast\s+pulls=40\s+verified=37\s+reward=0\.8123\s+ucb=0\.9456/);
  });

  it("marks the selected worker row with ▸", () => {
    const out = renderFleetPane(fullState({ selection: 2, height: 6 }));
    const lines = out.split("\n");
    const selLine = lines.find((l) => l.includes("w-3"));
    expect(selLine).toBeDefined();
    expect(selLine).toContain("▸");
    const otherLine = lines.find((l) => l.includes("w-1"));
    expect(otherLine).not.toContain("▸");
  });

  it("is deterministic for a populated state", () => {
    const a = renderFleetPane(fullState());
    const b = renderFleetPane(fullState());
    expect(a).toBe(b);
  });

  for (const width of [40, 72, 100]) {
    it(`clamps every line to exactly width=${width} for a populated state`, () => {
      const out = renderFleetPane(fullState(), width);
      expect(allLinesExactly(out, width)).toBe(true);
    });
  }
});

describe("renderFleetPane — width discipline under adversarial input", () => {
  const longId = "w-" + "x".repeat(300);
  const unicodeWorkers: FleetPaneWorkerRow[] = [
    { workerId: longId, backend: "vast-a1", lifecycle: "busy" },
    { workerId: "世界-ワーカー-🚀", backend: "runpod-b2", lifecycle: "idle", idleMs: 999 },
  ];
  const adversarial: FleetPaneState = {
    backends: [
      { name: "b-" + "y".repeat(200), kind: "vast", state: "ready", provisions: 1, accruedUsd: 99999.999999, provisionLatencyEmaMs: 1_000_000 },
    ],
    workers: unicodeWorkers,
    bandit: [{ name: "arm-" + "z".repeat(200), pulls: 1, verified: 1, meanReward: 1, ucb: 1 }],
    selection: 0,
    scroll: 0,
    height: 4,
  };

  for (const width of [40, 72, 100]) {
    it(`hard-clamps overlong ids/names and unicode content to width=${width}`, () => {
      const out = renderFleetPane(adversarial, width);
      expect(maxLineLen(out)).toBeLessThanOrEqual(width);
      expect(allLinesExactly(out, width)).toBe(true);
    });
  }
});

describe("moveFleetSelection", () => {
  const base = fullState({ selection: 0, scroll: 0, height: 2 });

  it("clamps at the top without wrapping", () => {
    const next = moveFleetSelection(base, -5);
    expect(next.selection).toBe(0);
  });

  it("clamps at the bottom without wrapping", () => {
    const next = moveFleetSelection(base, 999);
    expect(next.selection).toBe(workers.length - 1);
  });

  it("moves by delta within bounds", () => {
    const next = moveFleetSelection(base, 1);
    expect(next.selection).toBe(1);
  });

  it("negative delta past zero clamps to zero, not negative", () => {
    const mid = moveFleetSelection(base, 1); // selection 1
    const next = moveFleetSelection(mid, -10);
    expect(next.selection).toBe(0);
  });

  it("adjusts scroll to keep the selection inside the height window (scrolling down)", () => {
    // height=2, 4 workers: selecting index 3 must scroll so it's visible.
    let st = fullState({ selection: 0, scroll: 0, height: 2 });
    st = moveFleetSelection(st, 3); // -> index 3
    expect(st.selection).toBe(3);
    expect(st.scroll).toBeLessThanOrEqual(3);
    expect(st.scroll + st.height).toBeGreaterThan(st.selection);
    expect(st.scroll).toBeGreaterThanOrEqual(0);
  });

  it("adjusts scroll to keep the selection inside the window when moving back up", () => {
    let st = fullState({ selection: 3, scroll: 2, height: 2 });
    st = moveFleetSelection(st, -3); // -> index 0
    expect(st.selection).toBe(0);
    expect(st.scroll).toBe(0);
  });

  it("height smaller than the list never lets scroll+height exceed the list length unnecessarily", () => {
    const st = moveFleetSelection(fullState({ selection: 0, scroll: 0, height: 1 }), 3);
    expect(st.scroll).toBe(workers.length - 1);
  });

  it("handles an empty worker list: selection and scroll pin to 0", () => {
    const empty = emptyFleetPaneState(3);
    const next = moveFleetSelection(empty, 1);
    expect(next.selection).toBe(0);
    expect(next.scroll).toBe(0);
    const next2 = moveFleetSelection(empty, -1);
    expect(next2.selection).toBe(0);
    expect(next2.scroll).toBe(0);
  });

  it("handles a single-item worker list: selection always 0, no negative scroll", () => {
    const single = fullState({ workers: [workers[0]], selection: 0, scroll: 0, height: 3 });
    expect(moveFleetSelection(single, 1).selection).toBe(0);
    expect(moveFleetSelection(single, -1).selection).toBe(0);
  });

  it("selection already at last index with a further positive delta stays put", () => {
    const st = fullState({ selection: workers.length - 1, scroll: 0, height: 2 });
    const next = moveFleetSelection(st, 1);
    expect(next.selection).toBe(workers.length - 1);
  });

  it("is pure: returns a new object and never mutates the input", () => {
    const before = fullState({ selection: 0, scroll: 0, height: 2 });
    const beforeCopy = JSON.parse(JSON.stringify(before));
    const next = moveFleetSelection(before, 1);
    expect(next).not.toBe(before);
    expect(before).toEqual(beforeCopy);
  });
});

describe("fleetKeyToAction", () => {
  it("maps arrows and jk to up/down", () => {
    expect(fleetKeyToAction("\x1b[A")).toBe("up");
    expect(fleetKeyToAction("up")).toBe("up");
    expect(fleetKeyToAction("k")).toBe("up");
    expect(fleetKeyToAction("\x1b[B")).toBe("down");
    expect(fleetKeyToAction("down")).toBe("down");
    expect(fleetKeyToAction("j")).toBe("down");
  });

  it("maps r to refresh", () => {
    expect(fleetKeyToAction("r")).toBe("refresh");
  });

  it("maps escape/q to back", () => {
    expect(fleetKeyToAction("\x1b")).toBe("back");
    expect(fleetKeyToAction("escape")).toBe("back");
    expect(fleetKeyToAction("q")).toBe("back");
  });

  it("returns null for anything else", () => {
    expect(fleetKeyToAction("a")).toBeNull();
    expect(fleetKeyToAction("")).toBeNull();
    expect(fleetKeyToAction("R")).toBeNull();
    expect(fleetKeyToAction("\r")).toBeNull();
  });
});
