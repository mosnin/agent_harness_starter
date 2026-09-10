import { describe, it, expect } from "vitest";
import { hierarchyStats } from "../hierarchy/tree";
import type { HierarchyNode } from "../hierarchy/tree";
import {
  planAdaptiveHierarchy,
  compareToFixed,
} from "../hierarchy/adaptive";
import type {
  WorkloadEstimate,
  AdaptivePlanOptions,
  AdaptivePlan,
} from "../hierarchy/adaptive";

/**
 * Adversarial contract tests for the ADAPTIVE hierarchy planner.
 *
 * These tests deliberately try to BREAK a correct implementation and pin the
 * contract implied by the API + the task spec. Assumed semantics (documented so
 * a discrepancy is legible rather than a mystery):
 *
 *  - Defaults: maxBranching 8, maxWorkers 256, targetChunkCost 10, hopCostMs 0.5.
 *  - `planAdaptiveHierarchy(estimate, opts)` chooses branching / coordinatorLevels
 *    / workers to minimise a makespan model, then returns a REAL balanced tree
 *    (`root`) whose worker leaves cover the chosen `workers` (leaves >= workers).
 *  - `workers` is clamped to `min(maxWorkers, itemCount)` and never exceeds either
 *    bound; more work (more items at the same per-item cost) never decreases it.
 *  - The tree is built with `buildBalancedHierarchy(branching, coordinatorLevels)`,
 *    so `root` has exactly `branching` children (for branching-based plans) and
 *    the worker level sits at depth `coordinatorLevels + 1`
 *    (=> `hierarchyStats(root).maxDepth === coordinatorLevels + 1`).
 *  - `estimatedMakespanMs` is finite and > 0 for any non-empty workload, and stays
 *    finite even for pathologically skewed per-item costs (no NaN / Infinity).
 *  - `compareToFixed` returns { adaptiveMs, fixedMs, improvement } with
 *    `improvement === fixedMs / adaptiveMs` (>= 1 means adaptive is at least as
 *    fast as the fixed baseline). Because the adaptive planner minimises the same
 *    model it scores `fixed` with — and any in-range fixed config is inside its
 *    search space — adaptive should never be worse than a modest fixed baseline.
 *
 * If any assertion fails against a present implementation, the failing scenario
 * is reported as a probable bug rather than the test being weakened.
 */

// A finite, positive number that is neither NaN nor +/-Infinity.
function expectFiniteMs(ms: number, label: string): void {
  expect(Number.isFinite(ms), `${label} must be finite, got ${ms}`).toBe(true);
  expect(Number.isNaN(ms), `${label} must not be NaN`).toBe(false);
  expect(ms, `${label} must be > 0`).toBeGreaterThan(0);
}

// Basic structural sanity every returned plan must satisfy.
function assertWellFormedPlan(plan: AdaptivePlan, opts?: AdaptivePlanOptions): void {
  expect(Number.isInteger(plan.branching)).toBe(true);
  expect(plan.branching).toBeGreaterThanOrEqual(1);
  expect(Number.isInteger(plan.coordinatorLevels)).toBe(true);
  expect(plan.coordinatorLevels).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(plan.workers)).toBe(true);
  expect(plan.workers).toBeGreaterThanOrEqual(0);

  const maxBranching = opts?.maxBranching ?? 8;
  expect(plan.branching, "branching must respect maxBranching").toBeLessThanOrEqual(maxBranching);

  // The returned tree must be real and must physically host at least `workers` leaves.
  const root: HierarchyNode = plan.root;
  expect(root).toBeTruthy();
  expect(root.info.kind).toBe("root");
  expect(root.info.depth).toBe(0);

  const stats = hierarchyStats(root);
  expect(stats.workers, "tree leaf count must cover the plan's workers").toBeGreaterThanOrEqual(
    plan.workers
  );
  expect(stats.workers, "a valid tree always has >= 1 worker").toBeGreaterThanOrEqual(1);
  // Worker level sits at coordinatorLevels + 1.
  expect(stats.maxDepth, "maxDepth must equal coordinatorLevels + 1").toBe(
    plan.coordinatorLevels + 1
  );
}

describe("adaptive hierarchy — elasticity & monotonicity", () => {
  it("workers are non-decreasing in itemCount and clamp at min(maxWorkers, itemCount)", () => {
    const opts: AdaptivePlanOptions = { targetChunkCost: 10 }; // maxWorkers default 256
    const counts = [10, 100, 1000, 10000];
    const workersSeq: number[] = [];

    for (const itemCount of counts) {
      const plan = planAdaptiveHierarchy({ itemCount, costPerItem: 1 }, opts);
      assertWellFormedPlan(plan, opts);
      // Hard caps: never exceed maxWorkers, never exceed itemCount.
      expect(plan.workers, `workers must not exceed maxWorkers for n=${itemCount}`).toBeLessThanOrEqual(
        256
      );
      expect(plan.workers, `workers must not exceed itemCount for n=${itemCount}`).toBeLessThanOrEqual(
        itemCount
      );
      workersSeq.push(plan.workers);
    }

    // Monotonic non-decreasing as work grows at fixed per-item cost.
    for (let i = 1; i < workersSeq.length; i++) {
      expect(
        workersSeq[i],
        `workers must not shrink as work grows: ${JSON.stringify(workersSeq)}`
      ).toBeGreaterThanOrEqual(workersSeq[i - 1]);
    }

    // The largest workload (10000 items / chunk-cost 10 => ~1000 desired) must be
    // clamped by maxWorkers, so it hits the ceiling exactly.
    expect(workersSeq[workersSeq.length - 1]).toBe(256);
  });
});

describe("adaptive hierarchy — never meaningfully worse than a fixed tree", () => {
  const workloads: WorkloadEstimate[] = [
    { itemCount: 8, costPerItem: 5 },
    { itemCount: 64, costPerItem: 2 },
    { itemCount: 500, costPerItem: 1 },
    { itemCount: 4000, costPerItem: 3 },
  ];

  it("beats or ties a modest fixed tree {branching:2, coordinatorLevels:1} (improvement >= 1)", () => {
    for (const w of workloads) {
      const cmp = compareToFixed(w, { branching: 2, coordinatorLevels: 1 });
      expectFiniteMs(cmp.adaptiveMs, `adaptiveMs for ${JSON.stringify(w)}`);
      expectFiniteMs(cmp.fixedMs, `fixedMs for ${JSON.stringify(w)}`);
      // Pin the definition of improvement.
      expect(cmp.improvement).toBeCloseTo(cmp.fixedMs / cmp.adaptiveMs, 6);
      expect(
        cmp.improvement,
        `adaptive should be <= a 4-worker fixed tree for ${JSON.stringify(w)} (impr=${cmp.improvement})`
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("is not dramatically worse than an over-provisioned but IN-BUDGET wide tree (improvement >= 0.9)", () => {
    // 2^7 = 128 workers with 7 coordination hops: far more fan-out (and hops)
    // than these workloads need, but still within the default maxWorkers cap of
    // 256 — an apples-to-apples budget. Adaptive, which minimises makespan over
    // the same bounded space, must not trail this over-provisioned shape.
    const wideInBudget = { branching: 2, coordinatorLevels: 6 };
    for (const w of workloads) {
      const cmp = compareToFixed(w, wideInBudget);
      expectFiniteMs(cmp.adaptiveMs, `adaptiveMs (wide) for ${JSON.stringify(w)}`);
      expectFiniteMs(cmp.fixedMs, `fixedMs (wide) for ${JSON.stringify(w)}`);
      expect(cmp.improvement).toBeCloseTo(cmp.fixedMs / cmp.adaptiveMs, 6);
      expect(
        cmp.improvement,
        `adaptive should not trail an in-budget over-wide tree for ${JSON.stringify(w)} (impr=${cmp.improvement})`
      ).toBeGreaterThanOrEqual(0.9);
    }
  });

  // DOCUMENTED CONTRACT NOTE (not a bug in adaptive):
  // `compareToFixed` does NOT clamp the fixed baseline to `maxWorkers`, while
  // `planAdaptiveHierarchy` DOES honor it (see the cap-enforcement suite). So a
  // fixed tree that exceeds the cap can out-run capped adaptive purely by using
  // more workers than adaptive is allowed to. This is expected — adaptive is
  // resource-bounded, the fixed baseline is not — so `improvement` can fall well
  // below 1 here. We assert only that the numbers stay well-formed, and pin the
  // observed behavior so a future "adaptive should always win" claim is caught.
  it("an OVER-CAP fixed tree can beat capped adaptive — expected, results stay finite", () => {
    const overCap = { branching: 8, coordinatorLevels: 3 }; // 8^4 = 4096 > maxWorkers 256
    let sawAdaptiveTrail = false;
    for (const w of workloads) {
      const cmp = compareToFixed(w, overCap);
      expectFiniteMs(cmp.adaptiveMs, `adaptiveMs (over-cap) for ${JSON.stringify(w)}`);
      expectFiniteMs(cmp.fixedMs, `fixedMs (over-cap) for ${JSON.stringify(w)}`);
      expect(cmp.improvement).toBeCloseTo(cmp.fixedMs / cmp.adaptiveMs, 6);
      expect(cmp.improvement).toBeGreaterThan(0);
      if (cmp.improvement < 0.9) sawAdaptiveTrail = true;
    }
    // On these workloads the over-cap tree does out-run adaptive on at least one,
    // documenting that compareToFixed leaves the fixed baseline un-clamped.
    expect(
      sawAdaptiveTrail,
      "expected an un-clamped over-cap fixed tree to beat capped adaptive on >=1 workload"
    ).toBe(true);
  });
});

describe("adaptive hierarchy — degenerate inputs", () => {
  it("itemCount 0 does not throw, gives workers <= 1 and a valid tree", () => {
    let plan: AdaptivePlan | undefined;
    expect(() => {
      plan = planAdaptiveHierarchy({ itemCount: 0, costPerItem: 1 });
    }).not.toThrow();
    expect(plan).toBeTruthy();
    const p = plan as AdaptivePlan;
    expect(p.workers).toBeLessThanOrEqual(1);
    expect(hierarchyStats(p.root).workers).toBeGreaterThanOrEqual(1);
    expect(p.root.info.kind).toBe("root");
  });

  it("itemCount 1 does not throw, gives workers <= 1 and a valid tree", () => {
    let plan: AdaptivePlan | undefined;
    expect(() => {
      plan = planAdaptiveHierarchy({ itemCount: 1, costPerItem: 7 });
    }).not.toThrow();
    const p = plan as AdaptivePlan;
    expect(p.workers).toBeLessThanOrEqual(1);
    expect(hierarchyStats(p.root).workers).toBeGreaterThanOrEqual(1);
    // Even a one-item plan must model a finite, positive makespan.
    expectFiniteMs(p.estimatedMakespanMs, "estimatedMakespanMs (itemCount 1)");
  });
});

describe("adaptive hierarchy — cap enforcement under pressure", () => {
  it("100k items @ targetChunkCost 1 saturates the default worker cap (256)", () => {
    const opts: AdaptivePlanOptions = { targetChunkCost: 1 }; // wants ~100k workers
    const plan = planAdaptiveHierarchy({ itemCount: 100_000, costPerItem: 1 }, opts);
    assertWellFormedPlan(plan, opts);
    expect(plan.workers, "worker demand of 100k must clamp to the 256 default cap").toBe(256);
    expect(hierarchyStats(plan.root).workers).toBeGreaterThanOrEqual(plan.workers);
  });

  it("respects a custom maxWorkers cap of 64 under the same pressure", () => {
    const opts: AdaptivePlanOptions = { targetChunkCost: 1, maxWorkers: 64 };
    const plan = planAdaptiveHierarchy({ itemCount: 100_000, costPerItem: 1 }, opts);
    assertWellFormedPlan(plan, opts);
    expect(plan.workers, "custom cap of 64 must bind").toBe(64);
    expect(plan.workers).toBeLessThanOrEqual(64);
    expect(hierarchyStats(plan.root).workers).toBeGreaterThanOrEqual(plan.workers);
  });
});

describe("adaptive hierarchy — skewed costs stay finite", () => {
  it("one enormously expensive item does not produce Infinity/NaN makespan", () => {
    const costOf = (index: number): number => (index === 0 ? 1e12 : 1);
    const estimate: WorkloadEstimate = { itemCount: 500, costOf };

    let plan: AdaptivePlan | undefined;
    expect(() => {
      plan = planAdaptiveHierarchy(estimate, { targetChunkCost: 10 });
    }).not.toThrow();
    const p = plan as AdaptivePlan;
    assertWellFormedPlan(p, { targetChunkCost: 10 });
    expectFiniteMs(p.estimatedMakespanMs, "estimatedMakespanMs (skewed)");
    // The single 1e12 task is a lower bound on any parallel makespan — one agent
    // must own it — so a sane model reflects at least that magnitude.
    expect(p.estimatedMakespanMs).toBeGreaterThanOrEqual(1e12);

    // compareToFixed over the same skewed workload must also stay finite.
    const cmp = compareToFixed(estimate, { branching: 2, coordinatorLevels: 1 }, { targetChunkCost: 10 });
    expectFiniteMs(cmp.adaptiveMs, "adaptiveMs (skewed)");
    expectFiniteMs(cmp.fixedMs, "fixedMs (skewed)");
    expect(Number.isFinite(cmp.improvement)).toBe(true);
  });
});

describe("adaptive hierarchy — tree validity for a mid workload", () => {
  it("returns a well-formed balanced tree consistent with the chosen plan", () => {
    const opts: AdaptivePlanOptions = { targetChunkCost: 10 };
    const plan = planAdaptiveHierarchy({ itemCount: 1000, costPerItem: 1 }, opts);
    assertWellFormedPlan(plan, opts);

    const stats = hierarchyStats(plan.root);
    // Tree hosts at least the planned workers.
    expect(stats.workers).toBeGreaterThanOrEqual(plan.workers);
    // Depth matches coordinatorLevels + 1.
    expect(stats.maxDepth).toBe(plan.coordinatorLevels + 1);

    // A mid workload (1000 items / chunk-cost 10 => ~100 workers) is non-trivial:
    // it must fan out (branching > 1) and the root's child count must equal the
    // plan's branching, matching buildBalancedHierarchy's contract.
    expect(plan.branching, "mid workload should fan out").toBeGreaterThan(1);
    expect(
      plan.root.children.length,
      "root child count must equal plan.branching"
    ).toBe(plan.branching);
    expect(plan.root.info.childIds.length).toBe(plan.branching);

    // Makespan is finite and positive.
    expectFiniteMs(plan.estimatedMakespanMs, "estimatedMakespanMs (mid)");
  });
});
