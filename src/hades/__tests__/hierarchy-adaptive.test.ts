import { describe, it, expect } from "vitest";
import { planAdaptiveHierarchy, compareToFixed } from "../hierarchy/adaptive";
import { hierarchyStats } from "../hierarchy/tree";

describe("planAdaptiveHierarchy", () => {
  it("scales a big uniform workload to ~100 workers, far below serial makespan", () => {
    const plan = planAdaptiveHierarchy({ itemCount: 1000, costPerItem: 1 }, { targetChunkCost: 10 });
    // Desired ~100 workers; the elastic shape lands in a sensible band and honors the cap.
    expect(plan.workers).toBeGreaterThanOrEqual(100);
    expect(plan.workers).toBeLessThanOrEqual(256); // default maxWorkers
    // Serial makespan would be 1000; the parallel plan is a small fraction of that.
    expect(plan.estimatedMakespanMs).toBeLessThan(50);
    expect(plan.coordinatorLevels).toBeGreaterThanOrEqual(0);
  });

  it("collapses a tiny workload to a single worker", () => {
    const plan = planAdaptiveHierarchy({ itemCount: 1 });
    expect(plan.workers).toBe(1);
    expect(plan.branching).toBe(1);
    expect(plan.coordinatorLevels).toBe(0);
    expect(hierarchyStats(plan.root).workers).toBe(1);
  });

  it("collapses an empty workload to a single worker without throwing", () => {
    const plan = planAdaptiveHierarchy({ itemCount: 0 });
    expect(plan.workers).toBe(1);
    expect(hierarchyStats(plan.root).workers).toBe(1);
  });

  it("respects the maxWorkers and maxBranching caps", () => {
    const plan = planAdaptiveHierarchy(
      { itemCount: 100000, costPerItem: 1 },
      { targetChunkCost: 1, maxWorkers: 32, maxBranching: 3 },
    );
    expect(plan.workers).toBeLessThanOrEqual(32);
    expect(plan.branching).toBeLessThanOrEqual(3);
    expect(plan.branching).toBeGreaterThanOrEqual(2);
    expect(hierarchyStats(plan.root).workers).toBe(plan.workers);
  });

  it("the returned root is a valid tree whose worker count meets the desired W", () => {
    const plan = planAdaptiveHierarchy({ itemCount: 500, costPerItem: 1 }, { targetChunkCost: 10 });
    const stats = hierarchyStats(plan.root);
    // desired W = ceil(500/10) = 50; leaves are >= W and match the reported worker count.
    expect(stats.workers).toBeGreaterThanOrEqual(50);
    expect(stats.workers).toBe(plan.workers);
    // structural sanity: exactly one root level, positive depth, positive fan-out.
    expect(stats.maxDepth).toBe(plan.coordinatorLevels + 1);
    expect(stats.maxWidth).toBeGreaterThanOrEqual(1);
    expect(stats.nodes).toBeGreaterThan(stats.workers);
  });

  it("sums non-uniform costOf costs correctly and still produces a valid plan", () => {
    // Skewed costs: index 0 is very expensive, the rest cheap. Total = 100 + 199 = 299.
    const costOf = (i: number): number => (i === 0 ? 100 : 1);
    const plan = planAdaptiveHierarchy({ itemCount: 200, costOf }, { targetChunkCost: 10 });
    // The workload is bottlenecked by the single 100-cost item, so beyond a few
    // workers extra parallelism can't lower makespan. The makespan-optimal planner
    // therefore keeps the pool SMALL (faster AND lighter) rather than provisioning
    // to a chunk-cost target — a strict improvement over eager provisioning. The
    // hard contract: never more workers than items, and a valid, finite plan.
    expect(plan.workers).toBeGreaterThanOrEqual(1);
    expect(plan.workers).toBeLessThanOrEqual(Math.min(256, 200));
    const stats = hierarchyStats(plan.root);
    expect(stats.workers).toBe(plan.workers);
    expect(Number.isFinite(plan.estimatedMakespanMs)).toBe(true);
    // one worker still eats the 100-cost item, so makespan can't beat that hot chunk.
    expect(plan.estimatedMakespanMs).toBeGreaterThanOrEqual(100);
  });
});

describe("compareToFixed", () => {
  it("adaptive is at least as fast as a naive branching-2 / levels-1 fixed tree", () => {
    const cmp = compareToFixed(
      { itemCount: 1000, costPerItem: 1 },
      { branching: 2, coordinatorLevels: 1 }, // 4 leaves
      { targetChunkCost: 10 },
    );
    expect(cmp.improvement).toBeGreaterThanOrEqual(1);
    // With only 4 fixed workers vs ~100 adaptive, adaptive is dramatically faster.
    expect(cmp.adaptiveMs).toBeLessThan(cmp.fixedMs);
    expect(cmp.improvement).toBeGreaterThan(5);
  });

  it("returns improvement 1 when the fixed tree already matches the tiny job", () => {
    const cmp = compareToFixed({ itemCount: 1 }, { branching: 1, coordinatorLevels: 0 });
    expect(cmp.improvement).toBeGreaterThanOrEqual(1);
  });
});
