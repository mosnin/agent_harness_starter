import { describe, it, expect } from "vitest";
import { buildBalancedHierarchy, hierarchyStats } from "../hierarchy/tree";
import { HierarchyOrchestrator } from "../hierarchy/orchestrator";
import type { HierarchyExec } from "../hierarchy/orchestrator";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";

/**
 * Scale / stress tests: prove the swarm hierarchy and the A2A bus hold up at
 * large scale — correct results, depth-bounded critical path, and O(1) routing
 * (no quadratic blow-up).
 */

/** Sum of a geometric series 1 + b + b^2 + ... + b^k. */
function geometricNodeCount(branching: number, topExponent: number): number {
  let total = 0;
  for (let e = 0; e <= topExponent; e++) total += branching ** e;
  return total;
}

/**
 * Sum-over-tree computation. `decompose` round-robins the input array across the
 * node's children so every chunk count is exact at every level (no element
 * dropped, none duplicated); `execute` sums a leaf's slice; `aggregate` sums the
 * children's partial sums. Strongly typed end to end.
 */
function sumExec(): HierarchyExec<number[], number> {
  return {
    decompose: (task, node) => {
      const n = node.childIds.length;
      const chunks: number[][] = Array.from({ length: n }, () => []);
      task.forEach((value, i) => {
        chunks[i % n].push(value);
      });
      return chunks;
    },
    execute: (task) => Promise.resolve(task.reduce((a, b) => a + b, 0)),
    aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0),
  };
}

describe("hierarchy scale", () => {
  it("branching-3, 4 coordinator levels => 243 workers, exact sum via the tree", async () => {
    const branching = 3;
    const coordinatorLevels = 4;
    const root = buildBalancedHierarchy(branching, coordinatorLevels);

    const stats = hierarchyStats(root);
    // Workers live at depth coordinatorLevels+1 = 5 => 3^5 = 243.
    expect(stats.workers).toBe(243);
    // Total nodes = 3^0 + 3^1 + ... + 3^5 = 364.
    expect(stats.nodes).toBe(geometricNodeCount(branching, coordinatorLevels + 1));
    expect(stats.nodes).toBe(364);
    expect(stats.maxDepth).toBe(5);

    const data = Array.from({ length: 243 }, () => 1);
    const { result, stats: runStats } = await new HierarchyOrchestrator(root, sumExec()).run(data);

    expect(result).toBe(243);
    expect(runStats.workerRuns).toBe(243);
    expect(runStats.reachedDepth).toBe(5);
  });

  it("wide hierarchy: 50 leaves under root all execute concurrently (peak = 50)", async () => {
    const root = buildBalancedHierarchy(50, 0); // 50 workers directly under root

    let live = 0;
    let peak = 0;
    const exec: HierarchyExec<number, number> = {
      decompose: (task, node) => node.childIds.map((_, i) => task + i),
      execute: async (task) => {
        live++;
        peak = Math.max(peak, live);
        // Yield so all siblings are in-flight before any of them completes.
        await Promise.resolve();
        live--;
        return task;
      },
      aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0),
    };

    const { stats } = await new HierarchyOrchestrator(root, exec).run(0);
    expect(peak).toBe(50); // all leaves live at the same instant
    expect(stats.peakConcurrency).toBe(50);
  });

  it("deep hierarchy: 2048 workers, correct sum, critical path is depth 11 not 2048 steps", async () => {
    const root = buildBalancedHierarchy(2, 10); // 2^11 = 2048 workers
    const stats = hierarchyStats(root);
    expect(stats.workers).toBe(2048);
    expect(stats.maxDepth).toBe(11);

    const data = Array.from({ length: 2048 }, () => 1);
    const { result, stats: runStats } = await new HierarchyOrchestrator(root, sumExec()).run(data);

    // Every worker contributed exactly once => deep recursion over the tree is correct.
    expect(result).toBe(2048);
    expect(runStats.workerRuns).toBe(2048);
    expect(runStats.reachedDepth).toBe(11);
  });
});

describe("A2A scale", () => {
  it("20k agents, 1k point-to-point sends stay O(1) each (routeScans === 1000)", async () => {
    const transport = new InMemoryA2ATransport();
    const endpoints = Array.from(
      { length: 20_000 },
      (_, i) => new AgentEndpoint({ agentId: `agent-${i}`, team: "swarm" }, transport, { idPrefix: `agent-${i}` })
    );
    expect(transport.size()).toBe(20_000);

    const sender = endpoints[0];
    const target = endpoints[19_999];

    // Attach a listener so delivery has somewhere to go (does not affect scans).
    const received: number[] = [];
    target.on((msg) => {
      const payload = msg.payload as { i: number };
      received.push(payload.i);
    });

    transport.routeScans = 0;
    for (let i = 0; i < 1000; i++) {
      void sender.emit(target.address, { i });
    }

    // Exactly one subscriber comparison per send — O(1), NOT 1000 * 20000.
    expect(transport.routeScans).toBe(1000);
    expect(received).toHaveLength(1000);
    // Roster unchanged by routing.
    expect(transport.size()).toBe(20_000);
  });
});
