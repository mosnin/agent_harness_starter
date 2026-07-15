/**
 * ADVERSARIAL VERIFICATION of the swarm-hierarchy vs flat-baseline head-to-head.
 *
 * These tests exist to try to PROVE the comparison is rigged, vacuous, or wrong:
 *   - the parity claim (resultsMatch) is not vacuous — both sides equal an
 *     INDEPENDENT plain Array.reduce reference, not just each other;
 *   - the flat baseline is not a crippled strawman — it runs workers concurrently
 *     and combines in index order;
 *   - the O(N^2) routing cost it is penalized for is real (exact triangular number,
 *     super-linear growth), not a faked O(N) constant;
 *   - the head-to-head report's fields are self-consistent and recomputable;
 *   - the rendered table actually contains the measured numbers.
 *
 * Fully deterministic: no Math.random, no Date.now. Small worker counts.
 */
import { describe, it, expect } from "vitest";
import { FlatOrchestrator, type FlatExec } from "../bench/flat-baseline";
import { runHeadToHead } from "../bench/head-to-head";
import { HierarchyOrchestrator, type HierarchyExec } from "../hierarchy/orchestrator";
import { buildBalancedHierarchy } from "../hierarchy/tree";

/** Exact triangular number N*(N+1)/2 — the honest flat routing cost. */
const tri = (n: number) => (n * (n + 1)) / 2;

/**
 * A flat sum exec over an array workload: the manager splits an N-element array
 * into N one-element sub-tasks (one per worker); each worker sums its slice;
 * the manager sums the worker results.
 */
function flatSumExec(): FlatExec<number[], number> {
  return {
    split: (task, n) => {
      // One sub-task per worker; if task shorter than n, only present items dispatch.
      const out: number[][] = [];
      for (let i = 0; i < n; i++) {
        if (i < task.length) out.push([task[i]]);
      }
      return out;
    },
    execute: async (slice) => slice.reduce((a, b) => a + b, 0),
    combine: (results) => results.reduce((a, b) => a + b, 0),
  };
}

/**
 * A hierarchy sum exec: each coordinator round-robins its array among its children,
 * leaves sum their slice, coordinators sum child results. Total = sum of the whole
 * array regardless of tree shape.
 */
function hierSumExec(): HierarchyExec<number[], number> {
  return {
    decompose: (task, node) => {
      const n = node.childIds.length;
      const chunks: number[][] = Array.from({ length: n }, () => []);
      task.forEach((v, i) => chunks[i % n].push(v));
      return chunks;
    },
    execute: async (task) => task.reduce((a, b) => a + b, 0),
    aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0),
  };
}

// Worker counts with a matching balanced hierarchy shape (branching^(levels+1) === N).
const PARITY_CASES: Array<{ n: number; branching: number; levels: number }> = [
  { n: 4, branching: 2, levels: 1 }, // 2^2
  { n: 8, branching: 2, levels: 2 }, // 2^3
  { n: 16, branching: 4, levels: 1 }, // 4^2
  { n: 9, branching: 3, levels: 1 }, // 3^2
];

describe("head-to-head adversarial :: (1) correctness parity is NOT vacuous", () => {
  for (const { n, branching, levels } of PARITY_CASES) {
    it(`flat & hierarchy both equal an independent Array.reduce sum (N=${n})`, async () => {
      // Non-uniform, distinctive values so a reducer that returns count/length
      // instead of the true sum would be caught (sum != N, sum != count).
      const data = Array.from({ length: n }, (_, i) => i * 3 + 1);
      const reference = data.reduce((a, b) => a + b, 0);

      // Sanity: the reference is genuinely distinct from trivial rigged answers.
      expect(reference).not.toBe(n); // not the worker count
      expect(reference).not.toBe(data.length); // not the item count

      const flat = new FlatOrchestrator<number[], number>(n, flatSumExec());
      const { result: flatResult } = await flat.run(data);

      const root = buildBalancedHierarchy(branching, levels);
      const hier = new HierarchyOrchestrator<number[], number>(root, hierSumExec());
      const { result: hierResult } = await hier.run(data);

      // Both must match EACH OTHER *and* the independent reference. If they matched
      // each other but not the reference, the shared reducer would be rigged.
      expect(flatResult).toBe(reference);
      expect(hierResult).toBe(reference);
      expect(flatResult).toBe(hierResult);
    });
  }

  it("hierarchy leaf count equals worker count for the chosen shapes", async () => {
    for (const { n, branching, levels } of PARITY_CASES) {
      const root = buildBalancedHierarchy(branching, levels);
      const data = Array.from({ length: n }, () => 1);
      const { stats } = await new HierarchyOrchestrator<number[], number>(
        root,
        hierSumExec(),
      ).run(data);
      // Every leaf ran exactly once -> workerRuns === N leaves.
      expect(stats.workerRuns).toBe(n);
    }
  });
});

describe("head-to-head adversarial :: (2) flat baseline is NOT a strawman", () => {
  it("runs workers CONCURRENTLY (peakConcurrency === workerCount, not 1)", async () => {
    const n = 8;
    let live = 0;
    let peakObserved = 0;
    // Every worker parks on a timer, so if dispatch is concurrent all n are live at once.
    const exec: FlatExec<number, number> = {
      split: (_t, count) => Array.from({ length: count }, (_v, i) => i),
      execute: (_t, i) =>
        new Promise((resolve) => {
          live++;
          peakObserved = Math.max(peakObserved, live);
          setTimeout(() => {
            live--;
            resolve(i);
          }, 10);
        }),
      combine: (results) => results.length,
    };
    const orch = new FlatOrchestrator<number, number>(n, exec);
    const { stats } = await orch.run(0);

    // The reported peak must be the true parallelism, and it must be full width.
    expect(stats.peakConcurrency).toBe(n);
    expect(stats.peakConcurrency).toBe(orch.workerCount());
    expect(peakObserved).toBe(n);
    // A crippled (serial) baseline would report peakConcurrency === 1 — reject that.
    expect(stats.peakConcurrency).not.toBe(1);
  });

  it("combine receives results in worker-INDEX order even when later workers resolve first", async () => {
    const n = 6;
    const exec: FlatExec<number, string> = {
      split: (_t, count) => Array.from({ length: count }, (_v, i) => i),
      // Reverse completion order: worker 0 finishes LAST, worker n-1 finishes FIRST.
      execute: (_t, i) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(`w${i}`), (n - i) * 6),
        ),
      combine: (results) => results.join(","),
    };
    const orch = new FlatOrchestrator<number, string>(n, exec);
    const { result } = await orch.run(0);
    expect(result).toBe("w0,w1,w2,w3,w4,w5");
  });
});

describe("head-to-head adversarial :: (3) flat routing metric is HONEST (O(N^2))", () => {
  it("routeScans === N*(N+1)/2 exactly for N in {1,2,5,16,64}", async () => {
    for (const n of [1, 2, 5, 16, 64]) {
      const exec: FlatExec<number, number> = {
        split: (_t, count) => Array.from({ length: count }, (_v, i) => i),
        execute: async (i) => i,
        combine: (rs) => rs.reduce((a, b) => a + b, 0),
      };
      const orch = new FlatOrchestrator<number, number>(n, exec);
      const { stats } = await orch.run(0);
      expect(stats.routeScans).toBe(tri(n));
    }
  });

  it("routeScans grows QUADRATICALLY: routeScans(2N)/routeScans(N) -> ~4, not ~2", async () => {
    const exec = (): FlatExec<number, number> => ({
      split: (_t, count) => Array.from({ length: count }, (_v, i) => i),
      execute: async (i) => i,
      combine: (rs) => rs.reduce((a, b) => a + b, 0),
    });
    const scansFor = async (n: number) => {
      const { stats } = await new FlatOrchestrator<number, number>(n, exec()).run(0);
      return stats.routeScans;
    };
    for (const n of [16, 32]) {
      const a = await scansFor(n);
      const b = await scansFor(2 * n);
      const ratio = b / a;
      // Quadratic doubling ratio = 2(2N+1)/(N+1): ~3.94 at N=32, ~3.88 at N=16.
      // A linear metric would give ~2.0 — that would mean the "win" is fake.
      expect(ratio).toBeGreaterThan(3.5);
      expect(ratio).toBeLessThanOrEqual(4.0);
      expect(ratio).toBeGreaterThan(3); // decisively NOT linear (~2)
    }
  });
});

describe("head-to-head adversarial :: (4) head-to-head report INTEGRITY", () => {
  it("rows are self-consistent, routing win is real and grows with N", async () => {
    const workerCounts = [16, 64];
    const report = await runHeadToHead({
      workerCounts,
      branching: 4,
      perTaskMs: 0,
      aggCostPerItem: 0.0001,
    });

    // One row per requested worker count, in a stable mapping.
    expect(report.rows).toHaveLength(workerCounts.length);
    const byWorkers = new Map(report.rows.map((r) => [r.workers, r]));
    for (const w of workerCounts) expect(byWorkers.has(w)).toBe(true);

    for (const row of report.rows) {
      // Parity must hold on every row.
      expect(row.resultsMatch).toBe(true);

      // Flat routing cost is the exact triangular number (honest O(N^2) penalty).
      expect(row.flatRouteScans).toBe(tri(row.workers));

      // Hierarchy routing is cheaper for w >= 16 and strictly positive.
      expect(row.hierarchyRouteScans).toBeGreaterThan(0);
      expect(row.hierarchyRouteScans).toBeLessThan(row.flatRouteScans);

      // routingSpeedup must equal flat/hier (recompute — don't trust the field).
      // Exact (Object.is) recompute with the row's own operands: catches any rounding/rigging.
      expect(row.routingSpeedup).toBe(
        row.flatRouteScans / row.hierarchyRouteScans,
      );
      expect(row.routingSpeedup).toBeGreaterThan(1);

      // Makespan numbers must be real: finite, non-negative.
      expect(Number.isFinite(row.hierarchyMakespanMs)).toBe(true);
      expect(Number.isFinite(row.flatMakespanMs)).toBe(true);
      expect(row.hierarchyMakespanMs).toBeGreaterThanOrEqual(0);
      expect(row.flatMakespanMs).toBeGreaterThanOrEqual(0);

      // makespanSpeedup must equal flat/hier makespan (recompute, exact Object.is).
      expect(row.makespanSpeedup).toBe(
        row.flatMakespanMs / row.hierarchyMakespanMs,
      );
      // NOTE: we deliberately do NOT assert a makespan WIN direction — in-memory
      // it can go either way; only self-consistency is required.
    }

    // Routing speedup must INCREASE with N (flat quadratic vs hierarchy linear).
    const r16 = byWorkers.get(16)!;
    const r64 = byWorkers.get(64)!;
    expect(r64.routingSpeedup).toBeGreaterThan(r16.routingSpeedup);

    // Flat scans grow ~quadratically (16x for 4x workers); hierarchy scans grow
    // ~linearly (roughly 4x). If the hierarchy secretly grew quadratically too,
    // there would be no architectural win to report.
    const flatGrowth = r64.flatRouteScans / r16.flatRouteScans;
    const hierGrowth = r64.hierarchyRouteScans / r16.hierarchyRouteScans;
    expect(flatGrowth).toBeCloseTo(tri(64) / tri(16), 6); // 2080/136 ~ 15.29
    expect(flatGrowth).toBeGreaterThan(12); // clearly super-linear
    expect(hierGrowth).toBeLessThan(6); // clearly sub-quadratic (~linear)
    expect(hierGrowth).toBeLessThan(flatGrowth);
  });
});

describe("head-to-head adversarial :: (5) rendered table is NON-VACUOUS", () => {
  it("markdownTable is a string containing the actual measured route-scan numbers", async () => {
    const workerCounts = [16, 64];
    const report = await runHeadToHead({
      workerCounts,
      branching: 4,
      perTaskMs: 0,
      aggCostPerItem: 0.0001,
    });

    const table = report.markdownTable;
    expect(typeof table).toBe("string");
    expect(table.length).toBeGreaterThan(0);

    // A real row per worker count must be present.
    expect(table).toContain("16");
    expect(table).toContain("64");

    // The actual measured flat route-scan integers must appear verbatim:
    // w=16 -> 136, w=64 -> 2080. This proves the table is rendered from the
    // measured rows, not a hardcoded/empty template.
    expect(table).toContain("136");
    expect(table).toContain(String(tri(64))); // 2080

    // Cross-check the numbers came from the same run.
    const r16 = report.rows.find((r) => r.workers === 16)!;
    expect(r16.flatRouteScans).toBe(136);
  });
});
