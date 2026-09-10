import { describe, it, expect } from "vitest";
import { summarizeLatencies, percentile, formatSummary } from "../bench/throughput";

describe("percentile", () => {
  it("computes nearest-rank percentiles", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("summarizeLatencies", () => {
  it("computes throughput and latency stats", () => {
    const s = summarizeLatencies([100, 200, 300, 400], 500);
    expect(s.count).toBe(4);
    expect(s.wallMs).toBe(500);
    expect(s.throughputPerSec).toBeCloseTo(8); // 4 / 0.5s
    expect(s.meanMs).toBe(250);
    expect(s.minMs).toBe(100);
    expect(s.maxMs).toBe(400);
    expect(s.p50Ms).toBe(200);
  });

  it("handles an empty batch without dividing by zero", () => {
    const s = summarizeLatencies([], 0);
    expect(s.count).toBe(0);
    expect(s.throughputPerSec).toBe(0);
  });

  it("formats a readable summary line", () => {
    const line = formatSummary(summarizeLatencies([10, 20, 30], 100));
    expect(line).toContain("3 goals");
    expect(line).toContain("/s");
    expect(line).toContain("p95");
  });
});
