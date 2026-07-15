/**
 * ADVERSARIAL verification of the perf-invariant PRIMITIVES.
 *
 * A guardrail is only worth anything if it FAILS when the invariant it guards is
 * violated. Every block below proves TEETH: feed each primitive data that breaks
 * the invariant and assert it THROWS, then feed it healthy data and assert it does
 * NOT throw (no false alarm). We recompute the ratio/threshold math by hand so the
 * throw/no-throw split is pinned to the correct side of the boundary.
 */
import { describe, it, expect } from "vitest";
import {
  linearFit,
  measureRouteScans,
  assertO1Routing,
  assertSubLinearGrowth,
  assertResultsMatch,
} from "../bench/invariants";

describe("assertSubLinearGrowth — TEETH against growth regressions", () => {
  // ns = [16,64,256,1024] -> nRatio = 1024/16 = 64; default fraction 0.25 ->
  // budget valueRatio = 0.25 * 64 = 16. valueRatio = last/first.
  const NS = [16, 64, 256, 1024];

  it("THROWS on a LINEAR regression (value grows exactly as n)", () => {
    // values [32,128,512,2048]: valueRatio = 2048/32 = 64 > budget 16 -> throw.
    expect(() => assertSubLinearGrowth(NS, [32, 128, 512, 2048])).toThrow();
    expect(() => assertSubLinearGrowth(NS, [32, 128, 512, 2048])).toThrow(/sub-linear/i);
  });

  it("THROWS on a QUADRATIC regression (value ~ n^2)", () => {
    // values [256,4096,65536,1048576] = n^2: valueRatio = 1048576/256 = 4096 >> 16.
    expect(() => assertSubLinearGrowth(NS, [256, 4096, 65536, 1048576])).toThrow();
  });

  it("does NOT throw on healthy (logarithmic) data", () => {
    // [24,31,38,45]: valueRatio = 45/24 = 1.875 <= budget 16 -> OK.
    expect(() => assertSubLinearGrowth(NS, [24, 31, 38, 45])).not.toThrow();
  });

  it("splits on the CORRECT side of the fraction threshold", () => {
    // budget = 0.25 * nRatio. Handcraft first/last so valueRatio lands exactly on
    // and just over the budget. first=2, so budget in value-terms = 2 * budget-ratio.
    // nRatio 64 -> budget ratio = 16 -> boundary last value = 2 * 16 = 32.
    const budgetRatio = 0.25 * (NS[NS.length - 1] / NS[0]);
    expect(budgetRatio).toBe(16);

    // valueRatio EXACTLY at budget (32/2 = 16): 16 <= 16 -> no throw (inclusive).
    expect(() => assertSubLinearGrowth(NS, [2, 8, 20, 32])).not.toThrow();
    // valueRatio JUST OVER budget (33/2 = 16.5 > 16) -> throw.
    expect(() => assertSubLinearGrowth(NS, [2, 8, 20, 33])).toThrow();
    // valueRatio just UNDER budget (31/2 = 15.5) -> no throw.
    expect(() => assertSubLinearGrowth(NS, [2, 8, 20, 31])).not.toThrow();
  });

  it("enforces its input contract (length>=2, strictly increasing ns, positive first)", () => {
    // length < 2
    expect(() => assertSubLinearGrowth([16], [10])).toThrow();
    // non-increasing ns
    expect(() => assertSubLinearGrowth([16, 16], [10, 20])).toThrow();
    expect(() => assertSubLinearGrowth([64, 16], [10, 20])).toThrow();
    // mismatched lengths
    expect(() => assertSubLinearGrowth([16, 64, 256], [10, 20])).toThrow();
    // non-positive first elements make the ratios ill-defined
    expect(() => assertSubLinearGrowth([0, 64], [10, 20])).toThrow();
    expect(() => assertSubLinearGrowth([16, 64], [0, 20])).toThrow();
  });
});

describe("assertResultsMatch — TEETH against a miswired aggregation", () => {
  it("THROWS naming the first mismatching index when an element differs beyond eps", () => {
    const actual = [1, 2, 999, 4];
    const expected = [1, 2, 3, 4];
    expect(() => assertResultsMatch(actual, expected)).toThrow();
    expect(() => assertResultsMatch(actual, expected)).toThrow(/index 2/);
  });

  it("does NOT throw when arrays are equal within eps", () => {
    expect(() => assertResultsMatch([1, 2, 3], [1, 2, 3])).not.toThrow();
    // within default eps (1e-9)
    expect(() => assertResultsMatch([1, 2, 3], [1, 2, 3 + 1e-12])).not.toThrow();
  });

  it("respects the eps boundary (just under passes, just over throws)", () => {
    // eps 0.5: diff 0.4 (10.4-10) passes; diff 0.6 (10.6-10) throws.
    expect(() => assertResultsMatch([10.4], [10], 0.5)).not.toThrow();
    expect(() => assertResultsMatch([10.6], [10], 0.5)).toThrow();
  });

  it("THROWS on different-length arrays (a partial aggregation)", () => {
    expect(() => assertResultsMatch([1, 2, 3], [1, 2])).toThrow();
    expect(() => assertResultsMatch([1, 2], [1, 2, 3])).toThrow();
    expect(() => assertResultsMatch([1, 2, 3], [1, 2])).toThrow(/length/i);
  });
});

describe("assertO1Routing — TEETH: the O(1) bound is actually enforced", () => {
  it("THROWS when the per-send scan limit is below the real cost (1 > 0.5)", () => {
    // Real transport: scans-per-send is exactly 1. A limit of 0.5 must reject it.
    expect(() => assertO1Routing([100, 1000, 10000], 300, { maxScansPerSend: 0.5 })).toThrow();
    expect(() =>
      assertO1Routing([100, 1000, 10000], 300, { maxScansPerSend: 0.5 })
    ).toThrow(/O\(1\)/);
  });

  it("does NOT throw when the limit sits at/above the real cost (1 <= 1.0000001)", () => {
    expect(() =>
      assertO1Routing([100, 1000, 10000], 300, { maxScansPerSend: 1.0000001 })
    ).not.toThrow();
  });
});

describe("measureRouteScans — is TRUTHFUL about O(1) routing", () => {
  it("returns exactly `sends`, independent of roster size", () => {
    // If routeScans were roster-dependent, O(1) routing would be false. Pin exact
    // equality across a 100x roster jump so a scanning regression (delta > sends)
    // would fail HERE.
    expect(measureRouteScans(100, 300)).toBe(300);
    expect(measureRouteScans(10000, 300)).toBe(300);
    expect(measureRouteScans(1, 300)).toBe(300);
    // and the two large-vs-small measurements are identical
    expect(measureRouteScans(10000, 300)).toBe(measureRouteScans(100, 300));
  });
});

describe("linearFit — CORRECTNESS (so the fit-based checks aren't meaningless)", () => {
  it("recovers exact slope/intercept/r2 on a perfectly linear y = 3x - 2", () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = xs.map((x) => 3 * x - 2);
    const fit = linearFit(xs, ys);
    expect(fit.slope).toBeCloseTo(3, 10);
    expect(fit.intercept).toBeCloseTo(-2, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
  });

  it("gives slope ~ 0 and r2 = 1 on constant y (flat data)", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [7, 7, 7, 7, 7];
    const fit = linearFit(xs, ys);
    expect(fit.slope).toBeCloseTo(0, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
  });

  it("reports r2 strictly in (0,1) on a known noisy-but-correlated set", () => {
    // xs=[0,1,2,3], ys=[1,1,2,2]: slope 0.4, r2 = 0.8 (hand-computed).
    const fit = linearFit([0, 1, 2, 3], [1, 1, 2, 2]);
    expect(fit.slope).toBeCloseTo(0.4, 10);
    expect(fit.r2).toBeCloseTo(0.8, 10);
    expect(fit.r2).toBeGreaterThan(0);
    expect(fit.r2).toBeLessThan(1);
  });
});

describe("NON-VACUOUS SANITY — healthy real data passes every primitive", () => {
  it("assertO1Routing on real transport returns 3 entries, all scansPerSend === 1", () => {
    const measurements = assertO1Routing([100, 1000, 10000], 300);
    expect(measurements).toHaveLength(3);
    expect(measurements.map((m) => m.size)).toEqual([100, 1000, 10000]);
    for (const m of measurements) {
      expect(m.scansPerSend).toBe(1);
    }
  });

  it("all primitives are quiet on healthy inputs together (no false alarms)", () => {
    expect(() => {
      assertO1Routing([100, 1000, 10000], 300);
      assertSubLinearGrowth([16, 64, 256, 1024], [24, 31, 38, 45]);
      assertResultsMatch([1, 2, 3], [1, 2, 3]);
      linearFit([0, 1, 2, 3], [1, 2, 3, 4]);
    }).not.toThrow();
  });
});
