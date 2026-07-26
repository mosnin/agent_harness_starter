import { describe, it, expect } from "vitest";
import {
  linearFit,
  measureRouteScans,
  assertO1Routing,
  assertSubLinearGrowth,
  assertResultsMatch,
} from "../bench/invariants";

/**
 * Unit tests for the performance-invariant primitives. These check both the
 * happy path (measurements come out exactly as the O(1) / sub-linear / correct
 * claims predict) AND the TEETH (every assertion throws precisely on adversarial
 * violating data). Pure counts/ratios — no timing, no randomness.
 */
describe("invariants: linearFit", () => {
  it("fits exact data y = 2x + 1 with slope 2, intercept 1, r2 1", () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = xs.map((x) => 2 * x + 1);
    const fit = linearFit(xs, ys);
    expect(fit.slope).toBeCloseTo(2, 12);
    expect(fit.intercept).toBeCloseTo(1, 12);
    expect(fit.r2).toBeCloseTo(1, 12);
  });

  it("handles n < 2 and zero-variance xs sensibly", () => {
    expect(linearFit([], [])).toEqual({ slope: 0, intercept: 0, r2: 0 });
    expect(linearFit([5], [9])).toEqual({ slope: 0, intercept: 9, r2: 0 });
    // All xs equal, ys constant → flat line fits perfectly.
    expect(linearFit([3, 3, 3], [7, 7, 7])).toEqual({ slope: 0, intercept: 7, r2: 1 });
    // All xs equal, ys varying → no line explains it → r2 0.
    const noisy = linearFit([3, 3, 3], [1, 2, 3]);
    expect(noisy.slope).toBe(0);
    expect(noisy.r2).toBe(0);
  });
});

describe("invariants: measureRouteScans (O(1) direct routing)", () => {
  it("uses exactly `sends` scans regardless of roster size", () => {
    expect(measureRouteScans(1000, 500)).toBe(500);
    expect(measureRouteScans(10000, 500)).toBe(500);
  });
});

describe("invariants: assertO1Routing", () => {
  it("returns scansPerSend === 1 for every size and does not throw", () => {
    const measurements = assertO1Routing([100, 1000, 10000], 200);
    expect(measurements.map((m) => m.size)).toEqual([100, 1000, 10000]);
    for (const m of measurements) {
      expect(m.scansPerSend).toBe(1);
    }
  });

  it("throws when the per-send budget is set below the real cost", () => {
    // Real routing costs 1 scan/send; a 0.5 budget must fail loudly.
    expect(() => assertO1Routing([100], 100, { maxScansPerSend: 0.5 })).toThrow(/NOT O\(1\)/);
  });
});

describe("invariants: assertSubLinearGrowth", () => {
  it("passes when values grow much slower than n", () => {
    expect(() => assertSubLinearGrowth([16, 1024], [24, 45])).not.toThrow();
  });

  it("throws on linear growth", () => {
    expect(() => assertSubLinearGrowth([16, 1024], [32, 2048])).toThrow(/NOT sub-linear/);
  });
});

describe("invariants: assertResultsMatch", () => {
  it("passes on equal arrays", () => {
    expect(() => assertResultsMatch([1, 2, 3], [1, 2, 3])).not.toThrow();
    expect(() => assertResultsMatch([1, 2, 3], [1, 2, 3 + 1e-12])).not.toThrow();
  });

  it("throws naming the first mismatching index", () => {
    expect(() => assertResultsMatch([1, 2, 3], [1, 9, 3])).toThrow(/index 1/);
  });
});
