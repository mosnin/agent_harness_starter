import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport } from "../a2a/bus";
import { buildBalancedHierarchy } from "../hierarchy/tree";
import { DistributedHierarchy } from "../hierarchy/distributed";
import { HierarchyOrchestrator } from "../hierarchy/orchestrator";
import type { HierarchyExec } from "../hierarchy/orchestrator";

/**
 * A sum-reduce expressed as a hierarchical computation:
 *  - decompose: round-robin split the numbers into one chunk per child,
 *  - execute:   sum a leaf chunk,
 *  - aggregate: sum the children's partial sums.
 */
const sumExec: HierarchyExec<number[], number> = {
  decompose: (task, node) => {
    const n = node.childIds.length;
    const chunks: number[][] = Array.from({ length: n }, () => []);
    task.forEach((v, i) => chunks[i % n].push(v));
    return chunks;
  },
  execute: (task) => Promise.resolve(task.reduce((a, b) => a + b, 0)),
  aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0),
};

describe("DistributedHierarchy", () => {
  it("sums over a branching-2 depth-2 tree (8 workers) matching a plain reduce", async () => {
    const root = buildBalancedHierarchy(2, 2);
    const transport = new InMemoryA2ATransport();
    const dh = new DistributedHierarchy(root, transport, sumExec);

    const data = Array.from({ length: 40 }, (_, i) => i + 1);
    const expected = data.reduce((a, b) => a + b, 0);

    const result = await dh.run(data);
    expect(result).toBe(expected);

    // 8 workers + coordinators/root over depth 2 = 1 + 2 + 4 + 8 = 15 nodes.
    expect(dh.nodeCount()).toBe(15);
    dh.stop();
  });

  it("matches the in-process HierarchyOrchestrator result for the same exec + data", async () => {
    const root = buildBalancedHierarchy(2, 2);
    const data = Array.from({ length: 33 }, (_, i) => (i + 1) * 3);

    const inProcess = new HierarchyOrchestrator(root, sumExec);
    const { result: expected } = await inProcess.run(data);

    const transport = new InMemoryA2ATransport();
    const dh = new DistributedHierarchy(root, transport, sumExec);
    const result = await dh.run(data);

    expect(result).toBe(expected);
    dh.stop();
  });

  it("runs correctly over a depth-3 branching-2 tree (16 workers)", async () => {
    const root = buildBalancedHierarchy(2, 3);
    const transport = new InMemoryA2ATransport();
    const dh = new DistributedHierarchy(root, transport, sumExec);

    // 1 + 2 + 4 + 8 + 16 = 31 nodes.
    const data = Array.from({ length: 100 }, (_, i) => i + 1);
    const expected = data.reduce((a, b) => a + b, 0);

    const result = await dh.run(data);
    expect(result).toBe(expected);
    expect(dh.nodeCount()).toBe(31);
    dh.stop();
  });

  it("stop() cleans up without throwing and keeps nodeCount consistent", async () => {
    const root = buildBalancedHierarchy(2, 2);
    const transport = new InMemoryA2ATransport();
    const dh = new DistributedHierarchy(root, transport, sumExec);

    await dh.run([1, 2, 3, 4]);
    expect(dh.nodeCount()).toBe(15);

    expect(() => dh.stop()).not.toThrow();
    expect(dh.nodeCount()).toBe(0);

    // Re-running after stop() re-spawns cleanly and still computes correctly.
    const result = await dh.run([5, 6, 7]);
    expect(result).toBe(18);
    expect(dh.nodeCount()).toBe(15);
    dh.stop();
  });
});
