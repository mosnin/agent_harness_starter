import { describe, it, expect } from "vitest";
import { buildBalancedHierarchy, hierarchyStats, walk } from "../hierarchy/tree";
import type { HierarchyNode } from "../hierarchy/tree";
import { StreamingHierarchyAggregator } from "../hierarchy/streaming-aggregate";
import type { StreamingAggExec, StreamingStats } from "../hierarchy/streaming-aggregate";

// Split a number[] across a coordinator's children round-robin.
const chunkTask = (task: number[], n: number): number[][] => {
  const chunks: number[][] = Array.from({ length: n }, () => []);
  task.forEach((v, i) => chunks[i % n].push(v));
  return chunks;
};

// A sum fold: leaves sum their chunk, coordinators add (commutative + associative).
const sumExec = (): StreamingAggExec<number[], number> => ({
  decompose: (task, node) => chunkTask(task, node.childIds.length),
  execute: async (task) => task.reduce((a, b) => a + b, 0),
  seed: () => 0,
  combine: (acc, childResult) => acc + childResult,
});

// Count edges that carry a result: every non-root node whose sub-task is defined.
// With the round-robin decompose above, every child gets a (possibly empty) chunk,
// so every edge carries a result => folds === (nodes - 1).
const usedEdges = (root: HierarchyNode): number => hierarchyStats(root).nodes - 1;

describe("StreamingHierarchyAggregator", () => {
  it("1. sums a large array equal to a plain reduce (branching-3 depth-2)", async () => {
    const root = buildBalancedHierarchy(3, 2); // 27 workers
    const data = Array.from({ length: 5000 }, (_, i) => i + 1);
    const expected = data.reduce((a, b) => a + b, 0);

    const agg = new StreamingHierarchyAggregator(root, sumExec());
    const { result, stats } = await agg.run(data);

    expect(result).toBe(expected);
    expect(stats.peakBuffered).toBe(1);
  });

  it("2. peakBuffered stays O(1) (=== 1) for a wide tree (branching 8, 64 workers)", async () => {
    const root = buildBalancedHierarchy(8, 1); // root -> 8 coordinators -> 8 workers each = 64
    expect(hierarchyStats(root).workers).toBe(64);

    const data = Array.from({ length: 2000 }, (_, i) => i);
    const agg = new StreamingHierarchyAggregator(root, sumExec());
    const { result, stats } = await agg.run(data);

    expect(result).toBe(data.reduce((a, b) => a + b, 0));
    // The memory-win assertion: never more than one un-folded child result live.
    expect(stats.peakBuffered).toBe(1);
  });

  it("3. onPartial fires exactly `folds` times; final call at root carries the final result", async () => {
    const root = buildBalancedHierarchy(3, 1); // root -> 3 coordinators -> 3 workers each
    const data = Array.from({ length: 300 }, (_, i) => i + 1);
    const expected = data.reduce((a, b) => a + b, 0);

    const calls: Array<{ partial: number; id: string; depth: number }> = [];
    const agg = new StreamingHierarchyAggregator(root, sumExec(), {
      onPartial: (partial, node) => calls.push({ partial, id: node.id, depth: node.depth }),
    });
    const { result, stats } = await agg.run(data);

    expect(result).toBe(expected);
    expect(calls.length).toBe(stats.folds);

    // The very last onPartial must be the root closing out its accumulator.
    const last = calls[calls.length - 1];
    expect(last.depth).toBe(0);
    expect(last.id).toBe(root.info.id);
    expect(last.partial).toBe(expected);
  });

  it("4. set-union combine over out-of-order-resolving children yields the correct union", async () => {
    const root = buildBalancedHierarchy(4, 1); // 16 workers

    // Each worker owns a distinct set of integers; some resolve late to force
    // out-of-order folding. Union is commutative + associative.
    const unionExec = (): StreamingAggExec<number[], Set<number>> => ({
      decompose: (task, node) => chunkTask(task, node.childIds.length),
      execute: async (task) => {
        // Half the workers resolve on a later microtask/timer to shuffle order.
        if (task.length > 0 && task[0] % 2 === 0) {
          await new Promise<void>((r) => setTimeout(r, 0));
        }
        return new Set(task);
      },
      seed: () => new Set<number>(),
      combine: (acc, childResult) => {
        for (const v of childResult) acc.add(v);
        return acc;
      },
    });

    const data = Array.from({ length: 400 }, (_, i) => i);
    const agg = new StreamingHierarchyAggregator(root, unionExec());
    const { result, stats } = await agg.run(data);

    expect(result.size).toBe(data.length);
    expect([...result].sort((a, b) => a - b)).toEqual(data);
    expect(stats.peakBuffered).toBe(1);
  });

  it("5. folds == total child->parent edges that carried a result", async () => {
    const root = buildBalancedHierarchy(3, 2); // nodes = 1 + 3 + 9 + 27 = 40 => 39 edges
    const data = Array.from({ length: 1000 }, (_, i) => i);

    const agg = new StreamingHierarchyAggregator(root, sumExec());
    const { stats } = await agg.run(data);

    // Independently count the coordinators' used children.
    let expectedFolds = 0;
    walk(root, (n) => {
      if (n.info.kind !== "worker" && n.children.length > 0) {
        expectedFolds += n.children.length; // round-robin => every child used
      }
    });

    expect(stats.folds).toBe(expectedFolds);
    expect(stats.folds).toBe(usedEdges(root));
  });
});

// Keep the unused-import guard honest across TS strict settings.
const _typecheck: StreamingStats = { activeNodes: 0, workerRuns: 0, folds: 0, peakBuffered: 0 };
void _typecheck;
