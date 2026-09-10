import { describe, it, expect } from "vitest";
import {
  runHeadToHeadForApp,
  renderHeadToHead,
  HEAD_TO_HEAD_METHODOLOGY,
  type AppHeadToHeadResult,
} from "../core/head-to-head";

// Small, fast, deterministic opts: a couple of worker counts, cheap aggregation.
// Keeps the real benchmark run well under a second while still exercising the
// O(N^2) vs O(N) routing gap.
const SMALL_OPTS = { workerCounts: [4, 16], branching: 2, aggCostPerItem: 1 } as const;

describe("runHeadToHeadForApp — runs the REAL benchmark", () => {
  it("returns one row per requested worker count with real numeric fields", async () => {
    const result = await runHeadToHeadForApp(SMALL_OPTS);

    expect(result.rows.map((r) => r.workers)).toEqual([4, 16]);
    expect(result.summary.workerCounts).toEqual([4, 16]);

    for (const row of result.rows) {
      expect(Number.isFinite(row.flatRouteScans)).toBe(true);
      expect(Number.isFinite(row.hierarchyRouteScans)).toBe(true);
      expect(Number.isFinite(row.flatMakespanMs)).toBe(true);
      expect(Number.isFinite(row.hierarchyMakespanMs)).toBe(true);
      // Flat routing is un-indexed O(N^2), the tree is O(N): flat must scan more.
      expect(row.flatRouteScans).toBeGreaterThan(row.hierarchyRouteScans);
      // Both topologies reduce the identical workload to the identical aggregate.
      expect(row.resultsMatch).toBe(true);
    }
  });

  it("derives routingSpeedup and winner from the real report, not constants", async () => {
    const result = await runHeadToHeadForApp(SMALL_OPTS);

    for (const row of result.rows) {
      // Speedup is exactly flat/hier scans, computed from the report's counts.
      expect(row.routingSpeedup).toBeCloseTo(row.flatRouteScans / row.hierarchyRouteScans, 10);
      // Winner follows the real counts (fewer scans wins), it is not hardcoded.
      const expectedWinner =
        row.hierarchyRouteScans < row.flatRouteScans
          ? "hierarchy"
          : row.flatRouteScans < row.hierarchyRouteScans
            ? "flat"
            : "tie";
      expect(row.routingWinner).toBe(expectedWinner);
    }

    // The flat baseline routes with N*(N+1)/2 scans, verifiable independently:
    // N=4 -> 10, N=16 -> 136. This proves the numbers are the real ones.
    const byN = new Map(result.rows.map((r) => [r.workers, r]));
    expect(byN.get(4)!.flatRouteScans).toBe((4 * 5) / 2);
    expect(byN.get(16)!.flatRouteScans).toBe((16 * 17) / 2);

    // Speedup genuinely varies with N (grows), so it cannot be a constant.
    expect(byN.get(16)!.routingSpeedup).toBeGreaterThan(byN.get(4)!.routingSpeedup);
  });

  it("the result shape holds when opts change (different worker counts)", async () => {
    const other = await runHeadToHeadForApp({ workerCounts: [8], branching: 2, aggCostPerItem: 1 });
    expect(other.rows).toHaveLength(1);
    expect(other.rows[0].workers).toBe(8);
    expect(other.rows[0].flatRouteScans).toBe((8 * 9) / 2);
    // Overall summary reflects the real rows.
    expect(other.summary.workerCounts).toEqual([8]);
    expect(other.summary.routingWinner).toBe("hierarchy");
    expect(other.summary.peakRoutingWorkers).toBe(8);
    expect(other.summary.allResultsMatch).toBe(true);
  });

  it("carries an honest methodology label (not a live-model claim)", async () => {
    const result = await runHeadToHeadForApp(SMALL_OPTS);
    expect(result.methodology).toBe(HEAD_TO_HEAD_METHODOLOGY);
    expect(result.methodology.toLowerCase()).toContain("in-memory");
    expect(result.methodology.toLowerCase()).toContain("no live model");
  });
});

describe("renderHeadToHead — pure HTML", () => {
  it("renders a row per worker count with real numbers and an honest label", async () => {
    const result = await runHeadToHeadForApp(SMALL_OPTS);
    const html = renderHeadToHead(result);

    // One data row per measured worker count.
    expect(html).toContain('data-workers="4"');
    expect(html).toContain('data-workers="16"');
    // Real flat scan counts appear (thousands-formatted integers).
    expect(html).toContain((10).toLocaleString("en-US")); // N=4 -> 10
    expect(html).toContain((136).toLocaleString("en-US")); // N=16 -> 136
    // Honest methodology label, no live-model claim, and no em-dash.
    expect(html).toContain(HEAD_TO_HEAD_METHODOLOGY);
    expect(html).not.toContain("—");
    // Routing winner surfaces as a pill.
    expect(html).toContain('class="h2h-winner"');
  });

  it("renders an honest prompt for the null (not-yet-run) state", () => {
    const html = renderHeadToHead(null);
    expect(html).toContain("No benchmark run yet");
    expect(html).toContain(HEAD_TO_HEAD_METHODOLOGY);
    expect(html).not.toContain("<tbody>");
    expect(html).not.toContain("—");
  });

  it("renders an honest empty state when a run produced no rows", () => {
    const empty: AppHeadToHeadResult = {
      rows: [],
      summary: {
        workerCounts: [],
        peakRoutingSpeedup: 0,
        peakRoutingWorkers: 0,
        routingWinner: "tie",
        allResultsMatch: true,
      },
      methodology: HEAD_TO_HEAD_METHODOLOGY,
    };
    const html = renderHeadToHead(empty);
    expect(html).toContain("no rows");
    expect(html).not.toContain("<tbody>");
  });
});
