import { describe, it, expect } from "vitest";
import {
  initRoutePane,
  routePaneKey,
  renderRoutePane,
  armNote,
  costCell,
  thresholdCell,
  vtphCell,
  DEFAULT_WIDTH,
  type RoutePaneArmRow,
  type RoutePaneSummary,
} from "../route-pane";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function armRow(over: Partial<RoutePaneArmRow> = {}): RoutePaneArmRow {
  return {
    armId: "anthropic/haiku",
    provider: "anthropic",
    unpriced: false,
    eligible: true,
    rejectionCode: null,
    usdMean: 0.0045,
    usdP90: 0.006,
    costSource: "priced-prior",
    costSamples: 0,
    pulls: 0,
    verified: 0,
    pVerifiedMean: 0.5,
    measuredVtphPerDollar: 0,
    riskThreshold: null,
    riskThresholdFinite: false,
    riskSource: "none",
    riskCalibrationSize: 0,
    ...over,
  };
}

function summary(over: Partial<RoutePaneSummary> = {}): RoutePaneSummary {
  return {
    budgetUsd: 10,
    spentUsd: 1.25,
    remainingUsd: 8.75,
    lambda: 0.031,
    epsilon: 0.05,
    tier: "T4-consistency",
    ledgerEntries: 4,
    chainOk: true,
    chainCode: "ok",
    riskPoints: 4,
    unpricedArms: 0,
    ...over,
  };
}

const widthOf = (s: string): number => [...s].length;

// ===========================================================================

describe("route pane — honesty cells", () => {
  it("an UNPRICED arm renders — for cost, never 0.0000", () => {
    const row = armRow({ unpriced: true, usdMean: 0, usdP90: 0, costSource: "unpriced" });
    expect(costCell(row, "mean")).toBe("—");
    expect(costCell(row, "p90")).toBe("—");
    expect(armNote(row)).toMatch(/UNPRICED/);
    const lines = renderRoutePane(initRoutePane([row]));
    expect(lines.join("\n")).not.toMatch(/0\.0000/);
  });

  it("an abstaining stratum renders 'abstain', not a blank that reads as 'no limit'", () => {
    expect(thresholdCell(armRow())).toBe("abstain");
    expect(thresholdCell(armRow({ riskThresholdFinite: true, riskThreshold: 0.812 }))).toBe("0.812");
    // A hostile row claiming finite while carrying nothing still abstains.
    expect(thresholdCell(armRow({ riskThresholdFinite: true, riskThreshold: null }))).toBe("abstain");
  });

  it("a never-pulled arm renders — for measured V-TPH$/$", () => {
    expect(vtphCell(armRow({ pulls: 0, measuredVtphPerDollar: 1.8e9 }))).toBe("—");
    expect(vtphCell(armRow({ pulls: 3, measuredVtphPerDollar: 12.5 }))).toBe("12.50");
  });

  it("the note distinguishes a list price from a measurement", () => {
    expect(armNote(armRow({ pulls: 0, riskThresholdFinite: true, riskThreshold: 0.5 }))).toMatch(
      /LIST PRICE, not a measurement/,
    );
    expect(armNote(armRow({ pulls: 2, costSource: "priced-prior", riskThresholdFinite: true, riskThreshold: 0.5 }))).toMatch(
      /too few samples/,
    );
    expect(
      armNote(armRow({ pulls: 9, costSamples: 9, costSource: "measured", riskThresholdFinite: true, riskThreshold: 0.5 })),
    ).toMatch(/measured over 9 sample/);
  });

  it("an ineligible arm says so with its code", () => {
    expect(armNote(armRow({ eligible: false, rejectionCode: "over-usd-cap" }))).toMatch(/ineligible: over-usd-cap/);
  });

  it("an uncalibrated gate is called out before any performance number", () => {
    expect(armNote(armRow({ pulls: 5, riskThresholdFinite: false }))).toMatch(/gate abstains/);
  });
});

describe("route pane — rendering", () => {
  it("never exceeds the requested width, at any width", () => {
    const rows = [
      armRow(),
      armRow({ armId: "a-very-long-provider-name/an-extremely-long-model-identifier-2026", unpriced: true }),
    ];
    for (const w of [24, 40, DEFAULT_WIDTH, 120]) {
      const lines = renderRoutePane({ rows, summary: summary(), selected: 1, showDetail: true }, w);
      for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(w);
    }
  });

  it("renders an explicit empty state rather than a bare box", () => {
    const lines = renderRoutePane(initRoutePane([]));
    expect(lines.join("\n")).toMatch(/no routable arms/);
  });

  it("renders a full-width alert when the ledger chain FAILED", () => {
    const lines = renderRoutePane(initRoutePane([armRow()], summary({ chainOk: false, chainCode: "hash-mismatch" })));
    const joined = lines.join("\n");
    expect(joined).toMatch(/CHAIN\s+FAILED/);
    expect(joined).toMatch(/REFUSED/);
    // The alert must survive the default clamp intact — a truncated integrity
    // warning is a defeated one.
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(DEFAULT_WIDTH);
  });

  it("renders a budget-exhausted alert instead of a quiet negative number", () => {
    const joined = renderRoutePane(initRoutePane([armRow()], summary({ spentUsd: 10, remainingUsd: 0 }))).join("\n");
    expect(joined).toMatch(/BUDGET\s+EXHAUSTED/);
  });

  it("announces unpriced arms in the summary", () => {
    const joined = renderRoutePane(initRoutePane([armRow()], summary({ unpricedArms: 2 }))).join("\n");
    expect(joined).toMatch(/UNPRICED 2 arm\(s\)/);
  });

  it("strips control characters so upstream text cannot inject escapes", () => {
    const hostile = armRow({
      armId: "evil\u001b[2Jarm",
      provider: "x\u0007y",
      costSource: "meas\u0000ured",
    });
    const joined = renderRoutePane(initRoutePane([hostile], summary()), 100).join("\n");
    expect(joined).not.toContain("\u001b");
    expect(joined).not.toContain("\u0007");
    expect(joined).not.toContain("\u0000");
    expect(joined).toContain("evil[2Jarm");
  });

  it("is pure: the same state renders identically every time", () => {
    const state = initRoutePane([armRow(), armRow({ armId: "b/c" })], summary());
    expect(renderRoutePane(state)).toEqual(renderRoutePane(state));
  });

  it("shows the detail block only when toggled", () => {
    const state = initRoutePane([armRow()], summary());
    expect(renderRoutePane(state).join("\n")).not.toMatch(/DETAIL/);
    expect(renderRoutePane(routePaneKey(state, "enter")).join("\n")).toMatch(/DETAIL/);
  });
});

describe("route pane — key handling", () => {
  const state = initRoutePane([armRow({ armId: "a/1" }), armRow({ armId: "b/2" }), armRow({ armId: "c/3" })]);

  it("moves the selection and clamps at both ends", () => {
    expect(routePaneKey(state, "j").selected).toBe(1);
    expect(routePaneKey(state, "k")).toBe(state); // already at 0 => same object
    expect(routePaneKey(state, "G").selected).toBe(2);
    const atEnd = routePaneKey(state, "end");
    expect(routePaneKey(atEnd, "down")).toBe(atEnd); // clamped => same object
    expect(routePaneKey(routePaneKey(state, "G"), "home").selected).toBe(0);
  });

  it("returns the SAME object for unknown keys (cheap re-render skip)", () => {
    expect(routePaneKey(state, "z")).toBe(state);
    expect(routePaneKey(state, "")).toBe(state);
  });

  it("escape closes the detail block and is a no-op when already closed", () => {
    expect(routePaneKey(state, "escape")).toBe(state);
    const opened = routePaneKey(state, "l");
    expect(routePaneKey(opened, "escape").showDetail).toBe(false);
  });

  it("handles an empty pane without crashing or going out of range", () => {
    const empty = initRoutePane([]);
    expect(routePaneKey(empty, "j").selected).toBe(0);
    expect(routePaneKey(empty, "G").selected).toBe(0);
  });
});
