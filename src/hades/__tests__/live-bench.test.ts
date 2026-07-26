import { describe, it, expect } from "vitest";
import {
  benchA2ARoundTrip,
  benchA2AThroughput,
  benchHierarchyVsFlat,
  benchRoutingScaling,
  runAllBenchmarks,
} from "../bench/live-bench";

/**
 * Sanity tests for the live benchmark suite. These assert STRUCTURAL invariants
 * — counts, well-formed positive throughput, and the O(1) routing proof — never
 * absolute millisecond values, which are machine-dependent and flaky. Small
 * iteration counts keep the whole file well under a second.
 */
describe("live benchmarks", () => {
  it("A2A round-trip returns well-formed latency stats", async () => {
    const { stats } = await benchA2ARoundTrip({ iterations: 200 });
    expect(stats.count).toBe(200);
    expect(stats.meanMs).toBeGreaterThanOrEqual(0);
    expect(stats.p95).toBeGreaterThanOrEqual(stats.p50);
    expect(stats.max).toBeGreaterThanOrEqual(stats.min);
    expect(stats.opsPerSec).toBeGreaterThan(0);
  });

  it("A2A throughput reports positive messages/sec with matching count", async () => {
    const messages = 5000;
    const res = await benchA2AThroughput({ messages, agents: 50 });
    expect(res.messages).toBe(messages);
    expect(res.totalMs).toBeGreaterThanOrEqual(0);
    expect(res.messagesPerSec).toBeGreaterThan(0);
    expect(Number.isFinite(res.messagesPerSec)).toBe(true);
  });

  it("hierarchy fans out over the right worker count and beats serial", async () => {
    const res = await benchHierarchyVsFlat({ branching: 4, levels: 2, taskCostMs: 1 });
    expect(res.workers).toBe(64); // 4^(2+1)
    expect(res.hierarchyMs).toBeGreaterThan(0);
    expect(res.flatMs).toBeGreaterThan(0);
    // Parallel fan-out must be faster than the serial baseline for real latency.
    expect(res.speedup).toBeGreaterThan(1);
  });

  it("direct routing is O(1): exactly 1 scan at 100 AND 10k agents", async () => {
    const { small, large } = await benchRoutingScaling();
    expect(small).toBe(1);
    expect(large).toBe(1); // the key architectural proof
  });

  it("runAllBenchmarks returns a complete report", async () => {
    const report = (await runAllBenchmarks()) as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual(
      ["a2aRoundTrip", "a2aThroughput", "hierarchyVsFlat", "routingScaling"].sort()
    );
    const routing = report.routingScaling as { small: number; large: number };
    expect(routing.small).toBe(1);
    expect(routing.large).toBe(1);
  });
});
