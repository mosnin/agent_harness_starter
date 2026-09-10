import { describe, it, expect } from "vitest";
import { buildBalancedHierarchy } from "../hierarchy/tree";
import type { HierarchyExec } from "../hierarchy/orchestrator";
import { ResilientHierarchyOrchestrator } from "../hierarchy/resilient";
import type { ResilientOptions } from "../hierarchy/resilient";

/**
 * Adversarial contract tests for the resilient hierarchy orchestrator.
 *
 * These tests deliberately try to BREAK a correct implementation and pin the
 * contract implied by the API + the task spec. Key assumed semantics (documented
 * so a discrepancy is legible rather than a mystery):
 *
 *  - The unit that gets retried/reassigned is a COORDINATOR's per-child subtask.
 *    On failure the subtask is re-run; recovery is on a SIBLING (a "reassign"),
 *    per the spec's "recover on siblings" language.
 *  - `stats.reassignments` counts subtask moves to a new candidate node.
 *  - A node whose cumulative failure count reaches `deadAfter` is marked dead
 *    exactly once (appears once in `stats.deadNodes`) and excluded thereafter.
 *  - A subtask that cannot be completed within `maxReassignments` moves causes
 *    `run()` to REJECT (not hang, not silently drop the slot).
 *  - Aggregation still receives exactly one result per subtask slot, whichever
 *    node produced it, so a sum stays exact under recovery.
 */

// ---------------------------------------------------------------------------
// Fault-injection helper: a summing HierarchyExec<number[], number> where you
// declare faults keyed by INPUT (the chunk) and/or by NODE id, and it tracks
// per-input and per-node execute() call counts.
// ---------------------------------------------------------------------------

interface FaultSpec {
  /** input-key (JSON of chunk) -> number of leading calls that throw (Infinity = always). */
  inputFailTimes?: Record<string, number>;
  /** node id -> number of leading calls on that node that throw (Infinity = always). */
  nodeFailTimes?: Record<string, number>;
}

interface SumHarness {
  exec: HierarchyExec<number[], number>;
  /** per input-key: total execute() calls (includes failed attempts). */
  inputCalls: Map<string, number>;
  /** per node id: total execute() calls. */
  nodeCalls: Map<string, number>;
  keyOf: (chunk: number[]) => string;
}

/** The chunk a single-level `buildBalancedHierarchy(B, 0)` hands to worker `i`. */
function chunkForWorker(data: number[], workerCount: number, i: number): number[] {
  const chunk: number[] = [];
  data.forEach((v, idx) => {
    if (idx % workerCount === i) chunk.push(v);
  });
  return chunk;
}

function makeSumHarness(spec: FaultSpec = {}): SumHarness {
  const inputCalls = new Map<string, number>();
  const inputFails = new Map<string, number>();
  const nodeCalls = new Map<string, number>();
  const nodeFails = new Map<string, number>();
  const keyOf = (chunk: number[]) => JSON.stringify(chunk);

  const exec: HierarchyExec<number[], number> = {
    // Same distribution the built-in sum examples use: round-robin by index.
    decompose: (task, node) => {
      const n = node.childIds.length;
      const chunks: number[][] = Array.from({ length: n }, () => []);
      task.forEach((v, i) => chunks[i % n].push(v));
      return chunks;
    },
    execute: async (task, node) => {
      const key = keyOf(task);
      inputCalls.set(key, (inputCalls.get(key) ?? 0) + 1);
      nodeCalls.set(node.id, (nodeCalls.get(node.id) ?? 0) + 1);
      await Promise.resolve(); // force async scheduling

      // Node-keyed fault first: models a genuinely bad worker that fails
      // regardless of input, so a healthy sibling can complete the same work.
      const nodeLimit = spec.nodeFailTimes?.[node.id];
      if (nodeLimit !== undefined) {
        const f = nodeFails.get(node.id) ?? 0;
        if (f < nodeLimit) {
          nodeFails.set(node.id, f + 1);
          throw new Error(`INJECT node ${node.id} fail ${f + 1}/${nodeLimit}`);
        }
      }

      // Input-keyed fault: models a flaky subtask that fails the first K times
      // it is attempted (on any node) and then succeeds on retry/reassign.
      const inputLimit = spec.inputFailTimes?.[key];
      if (inputLimit !== undefined) {
        const f = inputFails.get(key) ?? 0;
        if (f < inputLimit) {
          inputFails.set(key, f + 1);
          throw new Error(`INJECT input ${key} fail ${f + 1}/${inputLimit}`);
        }
      }

      return task.reduce((a, b) => a + b, 0);
    },
    aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0),
  };

  return { exec, inputCalls, nodeCalls, keyOf };
}

/** Reject if `p` has not settled within `ms` — turns a hang into a test failure. */
async function withDeadline<X>(p: Promise<X>, ms: number, label: string): Promise<X> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DEADLINE(${label}) exceeded ${ms}ms — probable hang`)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

const reduce = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------

describe("ResilientHierarchyOrchestrator — adversarial", () => {
  it("1. correctness under partial failure: flaky workers recover, sum stays exact", async () => {
    const B = 9;
    const data = Array.from({ length: B }, (_, i) => i * 7 + 3); // distinct: 3,10,17,...
    const expected = reduce(data); // 279

    const failingIdx = [1, 4, 7]; // every third worker fails once
    const spec: FaultSpec = { inputFailTimes: {} };
    for (const i of failingIdx) {
      spec.inputFailTimes![JSON.stringify(chunkForWorker(data, B, i))] = 1;
    }

    const harness = makeSumHarness(spec);
    const root = buildBalancedHierarchy(B, 0);
    const orch = new ResilientHierarchyOrchestrator<number[], number>(root, harness.exec);

    const { result, stats } = await withDeadline(orch.run(data), 3000, "partial-failure");

    expect(result).toBe(expected);
    // Each injected first-attempt failure must be recovered by exactly one reassignment.
    expect(stats.reassignments).toBe(failingIdx.length);
    expect(stats.deadNodes).toEqual([]); // fail-once is not enough to kill a node (deadAfter default 3)
  });

  it("2. cascading failure: two workers each fail once; reassignments == injected failures", async () => {
    const B = 4;
    const data = [100, 200, 300, 400];
    const expected = reduce(data); // 1000

    const failingIdx = [1, 2];
    const spec: FaultSpec = { inputFailTimes: {} };
    for (const i of failingIdx) {
      spec.inputFailTimes![JSON.stringify(chunkForWorker(data, B, i))] = 1;
    }

    const harness = makeSumHarness(spec);
    const root = buildBalancedHierarchy(B, 0);
    const orch = new ResilientHierarchyOrchestrator<number[], number>(root, harness.exec);

    const { result, stats } = await withDeadline(orch.run(data), 3000, "cascading");

    expect(result).toBe(expected);
    expect(stats.reassignments).toBe(2); // exactly the number of injected failures
  });

  it("3. dead-node isolation: always-failing workers are killed once and their work lands on siblings", async () => {
    const B = 5;
    const data = [11, 22, 33, 44, 55];
    const expected = reduce(data); // 165

    const deadIdx = [0, 2]; // non-adjacent so healthy siblings 1,3,4 remain
    const spec: FaultSpec = { nodeFailTimes: {} };
    for (const i of deadIdx) spec.nodeFailTimes![`n/${i}`] = Number.POSITIVE_INFINITY;

    const events: Array<{ type: string; nodeId: string; detail?: string }> = [];
    const harness = makeSumHarness(spec);
    const root = buildBalancedHierarchy(B, 0);
    const opts: ResilientOptions = {
      deadAfter: 1, // one failure is enough to condemn a node
      maxReassignments: 5, // generous slack so recovery never spuriously exhausts
      onEvent: (e) => events.push(e),
    };
    const orch = new ResilientHierarchyOrchestrator<number[], number>(root, harness.exec, opts);

    const { result, stats } = await withDeadline(orch.run(data), 3000, "dead-node");

    expect(result).toBe(expected); // work completed on healthy siblings
    // Exactly the two bad nodes, each listed once (no dupes, no healthy node).
    expect([...stats.deadNodes].sort()).toEqual(["n/0", "n/2"]);
    expect(new Set(stats.deadNodes).size).toBe(stats.deadNodes.length);

    const deadEvents = events.filter((e) => e.type === "dead-node");
    expect(new Set(deadEvents.map((e) => e.nodeId))).toEqual(new Set(["n/0", "n/2"]));
  });

  it("4. exhaustion is clean: an unrecoverable subtask rejects run() without hanging", async () => {
    const B = 3;
    const data = [7, 8, 9];
    // The middle worker's chunk fails on EVERY node it is tried on.
    const doomedKey = JSON.stringify(chunkForWorker(data, B, 1)); // "[8]"
    const spec: FaultSpec = { inputFailTimes: { [doomedKey]: Number.POSITIVE_INFINITY } };

    const harness = makeSumHarness(spec);
    const root = buildBalancedHierarchy(B, 0);
    const orch = new ResilientHierarchyOrchestrator<number[], number>(root, harness.exec, {
      maxReassignments: 2,
    });

    // Settle the run into a plain value; the deadline converts a hang into a failure.
    const settled = orch.run(data).then(
      (v) => ({ status: "resolved" as const, v }),
      (e) => ({ status: "rejected" as const, e })
    );
    const res = await withDeadline(settled, 2500, "exhaustion");

    expect(res.status).toBe("rejected");

    // Belt-and-suspenders: the vitest rejects matcher on the same shape of run.
    const harness2 = makeSumHarness(spec);
    const orch2 = new ResilientHierarchyOrchestrator<number[], number>(
      buildBalancedHierarchy(B, 0),
      harness2.exec,
      { maxReassignments: 2 }
    );
    await expect(withDeadline(orch2.run(data), 2500, "exhaustion-2")).rejects.toThrow();
  });

  it("5. no double-execution of a SUCCEEDED subtask: healthy inputs run exactly once", async () => {
    const B = 6;
    const data = [2, 4, 6, 8, 10, 12];
    const expected = reduce(data); // 42

    const flakyIdx = 2;
    const flakyKey = JSON.stringify(chunkForWorker(data, B, flakyIdx)); // "[6]"
    const spec: FaultSpec = { inputFailTimes: { [flakyKey]: 1 } };

    const harness = makeSumHarness(spec);
    const root = buildBalancedHierarchy(B, 0);
    const orch = new ResilientHierarchyOrchestrator<number[], number>(root, harness.exec);

    const { result } = await withDeadline(orch.run(data), 3000, "no-double-exec");
    expect(result).toBe(expected);

    // Every healthy subtask ran exactly once; only the flaky one ran twice
    // (one failure + one successful reassignment). No successful slot re-runs.
    for (let i = 0; i < B; i++) {
      const key = JSON.stringify(chunkForWorker(data, B, i));
      const calls = harness.inputCalls.get(key);
      if (key === flakyKey) {
        expect(calls).toBe(2);
      } else {
        expect(calls).toBe(1);
      }
    }
  });

  it("6. events: emits reassign and dead-node with valid node ids", async () => {
    const B = 5;
    const data = [1, 2, 3, 4, 5];
    const expected = reduce(data); // 15

    // A single always-failing node yields BOTH events: it is retired (dead-node)
    // AND its subtask is re-delegated to a sibling (reassign). Note: with
    // deadAfter=1, ANY node that fails once is condemned, so we deliberately use
    // only one fault source here to keep the dead-set unambiguous.
    const spec: FaultSpec = {
      nodeFailTimes: { "n/1": Number.POSITIVE_INFINITY },
    };

    const events: Array<{ type: string; nodeId: string; detail?: string }> = [];
    const harness = makeSumHarness(spec);
    const root = buildBalancedHierarchy(B, 0);
    const orch = new ResilientHierarchyOrchestrator<number[], number>(root, harness.exec, {
      deadAfter: 1,
      maxReassignments: 5,
      onEvent: (e) => events.push(e),
    });

    const { result } = await withDeadline(orch.run(data), 3000, "events");
    expect(result).toBe(expected);

    const types = new Set(events.map((e) => e.type));
    expect(types.has("reassign")).toBe(true);
    expect(types.has("dead-node")).toBe(true);

    // The only condemned node is the always-failing one.
    const dead = events.filter((e) => e.type === "dead-node");
    expect(dead.every((e) => e.nodeId === "n/1")).toBe(true);
    // Every event carries a non-empty node id.
    expect(events.every((e) => typeof e.nodeId === "string" && e.nodeId.length > 0)).toBe(true);
  });
});
