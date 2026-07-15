import { describe, it, expect } from "vitest";
import { buildBalancedHierarchy } from "../hierarchy/tree";
import type { HierarchyExec } from "../hierarchy/orchestrator";
import {
  ResilientHierarchyOrchestrator,
  type ResilientEvent,
  type ResilientOptions,
} from "../hierarchy/resilient";

/**
 * A sum-reduce as a hierarchical computation. `executeFor` lets a test inject
 * per-node fault behaviour (throw / hang) keyed by worker id.
 */
function sumExec(
  executeFor?: (task: number[], id: string) => Promise<number> | undefined
): HierarchyExec<number[], number> {
  return {
    decompose: (task, node) => {
      const n = node.childIds.length;
      const chunks: number[][] = Array.from({ length: n }, () => []);
      task.forEach((v, i) => chunks[i % n].push(v));
      return chunks;
    },
    execute: (task, node) => {
      const injected = executeFor?.(task, node.id);
      if (injected !== undefined) return injected;
      return Promise.resolve(task.reduce((a, b) => a + b, 0));
    },
    aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0),
  };
}

const data = Array.from({ length: 30 }, (_, i) => i + 1);
const expectedSum = data.reduce((a, b) => a + b, 0); // 465

describe("ResilientHierarchyOrchestrator", () => {
  it("happy path: matches a plain reduce with zero reassignments", async () => {
    const root = buildBalancedHierarchy(3, 1); // root -> 3 coordinators -> 3 workers each
    const orch = new ResilientHierarchyOrchestrator(root, sumExec());
    const { result, stats } = await orch.run(data);

    expect(result).toBe(expectedSum);
    expect(stats.reassignments).toBe(0);
    expect(stats.retries).toBe(0);
    expect(stats.deadNodes).toEqual([]);
    expect(stats.aggregations).toBeGreaterThan(0);
  });

  it("recovers from a worker that throws on its first call, reassigning to a sibling", async () => {
    const root = buildBalancedHierarchy(3, 0); // root -> 3 workers
    const calls = new Map<string, number>();
    const flakyId = "n/1";

    const exec = sumExec((_task, id) => {
      if (id !== flakyId) return undefined;
      const c = (calls.get(id) ?? 0) + 1;
      calls.set(id, c);
      if (c === 1) return Promise.reject(new Error("flaky first call"));
      return undefined; // subsequent calls behave normally
    });

    const events: ResilientEvent[] = [];
    const orch = new ResilientHierarchyOrchestrator(root, exec, { onEvent: (e) => events.push(e) });
    const { result, stats } = await orch.run(data);

    expect(result).toBe(expectedSum);
    expect(stats.reassignments).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "reassign")).toBe(true);
    // A single transient failure must not retire the node (default deadAfter = 3).
    expect(stats.deadNodes).toEqual([]);
  });

  it("reassigns around a permanently dead worker and reports it in deadNodes", async () => {
    const root = buildBalancedHierarchy(3, 0); // root -> 3 workers
    const deadId = "n/2";

    const exec = sumExec((_task, id) =>
      id === deadId ? Promise.reject(new Error("worker is broken")) : undefined
    );

    const orch = new ResilientHierarchyOrchestrator(root, exec, { deadAfter: 1 });
    const { result, stats } = await orch.run(data);

    expect(result).toBe(expectedSum);
    expect(stats.deadNodes).toContain(deadId);
    expect(stats.reassignments).toBeGreaterThanOrEqual(1);
  });

  it("treats a hanging child as a failure via the injected timer and reassigns", async () => {
    const root = buildBalancedHierarchy(3, 0); // root -> 3 workers
    const hangingId = "n/0";

    // Controllable clock: capture pending timeout callbacks and fire them by hand.
    const pending: Array<() => void> = [];
    const setTimeoutFn: NonNullable<ResilientOptions["setTimeoutFn"]> = (cb) => {
      pending.push(cb);
      return pending.length as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimeoutFn: NonNullable<ResilientOptions["clearTimeoutFn"]> = () => {
      /* no-op: harmless leftover timers are never fired */
    };

    const exec = sumExec((_task, id) =>
      id === hangingId ? new Promise<number>(() => {/* never resolves */}) : undefined
    );

    const events: ResilientEvent[] = [];
    const orch = new ResilientHierarchyOrchestrator(root, exec, {
      timeoutMs: 50,
      setTimeoutFn,
      clearTimeoutFn,
      onEvent: (e) => events.push(e),
    });

    const runPromise = orch.run(data);
    // Let the healthy siblings fully settle (their timers become no-ops via the
    // internal `settled` guard), leaving only the hanging node's timer live.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(pending.length).toBeGreaterThan(0);
    pending.forEach((cb) => cb());

    const { result, stats } = await runPromise;
    expect(result).toBe(expectedSum);
    expect(stats.reassignments).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "subtask-failed")).toBe(true);
  });

  it("rejects with a clear error when every sibling fails past maxReassignments", async () => {
    const root = buildBalancedHierarchy(2, 0); // root -> 2 workers, both broken
    const exec = sumExec(() => Promise.reject(new Error("everything is down")));

    const orch = new ResilientHierarchyOrchestrator(root, exec, {
      maxReassignments: 1,
      deadAfter: 5,
    });

    await expect(orch.run(data)).rejects.toThrow(/exhausted resilience/);
  });
});
