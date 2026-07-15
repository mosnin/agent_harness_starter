/**
 * PERFORMANCE REGRESSION GUARDRAILS for the Hades swarm.
 *
 * This suite does NOT benchmark for a number — it pins the swarm's ARCHITECTURAL
 * performance GUARANTEES as executable invariants that FAIL CI the moment the
 * real code regresses:
 *
 *   1. Direct A2A routing is O(1) — a constant `Map.get`, not a roster scan.
 *   2. Routing cost is roster-independent — the scans/send fit has slope ≈ 0.
 *   3. The hierarchy's critical path is depth-bounded (sub-linear) while the flat
 *      manager's is linear — proven by asserting flat WOULD violate sub-linearity.
 *   4. Tree aggregation is CORRECT — a tree reduce equals a plain Array.reduce.
 *   5. The guardrails have teeth — a too-strict bound is shown to actually throw.
 *
 * Everything runs against the REAL production APIs (the in-memory A2A transport,
 * the deterministic latency-makespan model, the hierarchy orchestrator) and is
 * pure + deterministic: no wall clock, no randomness. A regression that turns the
 * indexed router back into a scan, makes the critical path linear, or miswires an
 * aggregator makes the corresponding assertion THROW.
 */

import { describe, it, expect } from "vitest";

import {
  linearFit,
  measureRouteScans,
  assertO1Routing,
  assertSubLinearGrowth,
  assertResultsMatch,
} from "../bench/invariants";
import { compareMakespan } from "../bench/latency-makespan";
import { HierarchyOrchestrator, type HierarchyExec } from "../hierarchy/orchestrator";
import { buildBalancedHierarchy, hierarchyStats } from "../hierarchy/tree";

describe("perf guardrails", () => {
  // ── 1. O(1) direct routing ────────────────────────────────────────────────
  describe("O(1) direct routing", () => {
    it("uses exactly one scan per direct send at every roster size", () => {
      const sizes = [100, 1000, 10000];
      const sendsPerSize = 500;

      const measurements = assertO1Routing(sizes, sendsPerSize);

      // One measurement per size, in input order.
      expect(measurements).toHaveLength(sizes.length);
      expect(measurements.map((m) => m.size)).toEqual(sizes);

      // Every send costs a single indexed Map.get — independent of roster size.
      for (const m of measurements) {
        expect(m.scansPerSend).toBeLessThanOrEqual(1.000001);
        expect(m.scansPerSend).toBeCloseTo(1, 6);
      }
    });
  });

  // ── 2. Routing cost is roster-independent (fit slope ≈ 0) ──────────────────
  describe("routing cost is roster-independent", () => {
    it("shows a flat scans/send curve (linear fit slope ≈ 0)", () => {
      const sizes = [100, 500, 2000, 10000];
      const sendsPerSize = 500;

      const scansPerSend = sizes.map((size) => measureRouteScans(size, sendsPerSize) / sendsPerSize);

      // The curve is constant at 1 scan/send — a scanning router would slope up.
      for (const v of scansPerSend) {
        expect(v).toBeCloseTo(1, 6);
      }

      const fit = linearFit(sizes, scansPerSend);
      // Slope must be ~0: routing cost does NOT grow with roster size.
      expect(Math.abs(fit.slope)).toBeLessThan(1e-6);
    });
  });

  // ── 3. Depth-bounded (sub-linear) critical path ────────────────────────────
  describe("depth-bounded critical path", () => {
    const workerCounts = [16, 64, 256, 1024];
    const report = compareMakespan({ workerCounts, branching: 4 });

    it("keeps tree makespan sub-linear as fan-out widens", () => {
      const treeMakespans = report.rows.map((r) => r.treeMakespanMs);
      expect(treeMakespans).toHaveLength(workerCounts.length);
      // The tree's critical path is depth-bounded → grows sub-linearly in N.
      expect(() => assertSubLinearGrowth(workerCounts, treeMakespans)).not.toThrow();
    });

    it("proves the flat manager's makespan is genuinely linear (not sub-linear)", () => {
      const flatMakespans = report.rows.map((r) => r.flatMakespanMs);
      // A single flat manager serially issues N sends + folds N results → O(N).
      // Sub-linearity MUST NOT hold for it — that is what the tree beats.
      expect(() => assertSubLinearGrowth(workerCounts, flatMakespans)).toThrow();
    });

    it("has the tree win for every non-trivial worker count (>= 64)", () => {
      for (const row of report.rows) {
        if (row.workers >= 64) {
          expect(row.treeWins).toBe(true);
          expect(row.makespanSpeedup).toBeGreaterThan(1);
        }
      }
    });
  });

  // ── 4. Aggregation correctness invariant ───────────────────────────────────
  describe("aggregation correctness", () => {
    /** Split an array into `k` contiguous, as-even-as-possible chunks. */
    const chunk = (arr: number[], k: number): number[][] => {
      const out: number[][] = [];
      const base = Math.floor(arr.length / k);
      const rem = arr.length % k;
      let idx = 0;
      for (let i = 0; i < k; i++) {
        const size = base + (i < rem ? 1 : 0);
        out.push(arr.slice(idx, idx + size));
        idx += size;
      }
      return out;
    };

    // A tree reduce that sums leaf values must equal a plain Array.reduce sum.
    const exec: HierarchyExec<number[], number> = {
      // Each coordinator splits its slice one-per-child.
      decompose: (task, node) => chunk(task, node.childIds.length),
      // A worker leaf sums the slice it was handed.
      execute: async (task) => task.reduce((a, b) => a + b, 0),
      // A coordinator sums its children's partial sums.
      aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0),
    };

    const shapes: Array<{ branching: number; coordinatorLevels: number }> = [
      { branching: 3, coordinatorLevels: 2 }, // 27 workers
      { branching: 2, coordinatorLevels: 3 }, // 16 workers
      { branching: 4, coordinatorLevels: 1 }, // 16 workers
    ];

    for (const { branching, coordinatorLevels } of shapes) {
      it(`sums correctly for branching=${branching}, levels=${coordinatorLevels}`, async () => {
        const root = buildBalancedHierarchy(branching, coordinatorLevels);
        const stats = hierarchyStats(root);

        // Deterministic leaf values; one per worker leaf.
        const values = Array.from({ length: stats.workers }, (_, i) => i * 7 + 3);
        const referenceSum = values.reduce((a, b) => a + b, 0);

        const { result } = await new HierarchyOrchestrator(root, exec).run(values);

        // Sanity: the model actually built the tree we expect.
        expect(stats.workers).toBe(branching ** (coordinatorLevels + 1));

        assertResultsMatch([result], [referenceSum]);
        expect(result).toBe(referenceSum);
      });
    }
  });

  // ── 5. Meta: the guardrails have teeth (not vacuous) ───────────────────────
  describe("guardrails are not vacuous", () => {
    it("fails the O(1) assertion under an impossibly strict bound", () => {
      // Real routing costs exactly 1 scan/send, so a 0.5 ceiling MUST throw.
      expect(() => assertO1Routing([100, 1000], 500, { maxScansPerSend: 0.5 })).toThrow();
    });

    it("fails sub-linearity on a deliberately linear series", () => {
      const ns = [16, 64, 256, 1024];
      const linear = ns.map((n) => n * 2); // grows exactly with n → not sub-linear
      expect(() => assertSubLinearGrowth(ns, linear)).toThrow();
    });

    it("fails result-matching on a deliberately wrong sum", () => {
      expect(() => assertResultsMatch([41], [42])).toThrow();
    });
  });
});
