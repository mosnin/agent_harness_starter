import { describe, it, expect } from "vitest";
import { buildBalancedHierarchy, hierarchyStats } from "../hierarchy/tree";
import { HierarchyOrchestrator } from "../hierarchy/orchestrator";
import type { HierarchyExec } from "../hierarchy/orchestrator";

describe("buildBalancedHierarchy", () => {
  it("builds B^(levels+1) workers with correct structure", () => {
    const root = buildBalancedHierarchy(3, 1); // root → 3 coordinators → 3 workers each = 9 workers
    const stats = hierarchyStats(root);
    expect(stats.workers).toBe(9);
    expect(stats.maxDepth).toBe(2);
    expect(stats.maxWidth).toBe(9); // the worker level
    expect(root.info.kind).toBe("root");
    expect(root.children).toHaveLength(3);
    expect(root.children[0].children[0].info.kind).toBe("worker");
  });

  it("depth 0 makes the root's children workers directly", () => {
    const root = buildBalancedHierarchy(4, 0);
    expect(hierarchyStats(root).workers).toBe(4);
    expect(root.children.every((c) => c.info.kind === "worker")).toBe(true);
  });
});

describe("HierarchyOrchestrator", () => {
  // Sum a list by splitting it down the tree and adding leaves back up.
  const sumExec = (): HierarchyExec<number[], number> => ({
    decompose: (task, node) => {
      const n = node.childIds.length;
      const chunks: number[][] = Array.from({ length: n }, () => []);
      task.forEach((v, i) => chunks[i % n].push(v));
      return chunks;
    },
    execute: async (task) => task.reduce((a, b) => a + b, 0),
    aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0),
  });

  it("computes the same result as a flat reduce, via the tree", async () => {
    const root = buildBalancedHierarchy(2, 2); // 8 workers
    const orch = new HierarchyOrchestrator(root, sumExec());
    const data = Array.from({ length: 40 }, (_, i) => i + 1);
    const { result, stats } = await orch.run(data);
    expect(result).toBe(data.reduce((a, b) => a + b, 0)); // 820
    expect(stats.reachedDepth).toBe(3);
    expect(stats.workerRuns).toBe(8);
    expect(stats.aggregations).toBeGreaterThan(0);
  });

  it("fans out siblings concurrently (peak concurrency = branching)", async () => {
    let live = 0;
    let peak = 0;
    const root = buildBalancedHierarchy(5, 0); // 5 workers under root
    const exec: HierarchyExec<number, number> = {
      decompose: (task, node) => node.childIds.map((_, i) => task + i),
      execute: async (task) => {
        live++;
        peak = Math.max(peak, live);
        await Promise.resolve();
        live--;
        return task;
      },
      aggregate: (rs) => rs.reduce((a, b) => a + b, 0),
    };
    const { stats } = await new HierarchyOrchestrator(root, exec).run(0);
    expect(peak).toBe(5); // all 5 leaves ran at once
    expect(stats.peakConcurrency).toBe(5);
  });

  it("critical path is depth hops, not total nodes (deep tree)", async () => {
    // A branching-2 depth-6 tree has 2^7 = 128 workers but only 7 hops deep.
    const root = buildBalancedHierarchy(2, 6);
    const stats = hierarchyStats(root);
    expect(stats.workers).toBe(128);
    const orch = new HierarchyOrchestrator(root, sumExec());
    const { result } = await orch.run(Array.from({ length: 128 }, () => 1));
    expect(result).toBe(128); // every worker contributed exactly once
  });
});
