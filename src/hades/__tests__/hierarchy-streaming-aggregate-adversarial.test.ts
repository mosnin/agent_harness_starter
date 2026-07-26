import { describe, it, expect } from "vitest";
import { StreamingHierarchyAggregator } from "../hierarchy/streaming-aggregate";
import type {
  StreamingAggExec,
  StreamingOptions,
} from "../hierarchy/streaming-aggregate";
import { buildBalancedHierarchy } from "../hierarchy/tree";
import type { HierarchyNode, HierarchyNodeInfo } from "../hierarchy/tree";

/**
 * ADVERSARIAL contract tests for the StreamingHierarchyAggregator.
 *
 * These tests deliberately try to BREAK a correct implementation and pin the
 * streaming-fold contract implied by the API + the task spec. Assumed semantics
 * (documented so a discrepancy is legible rather than a mystery):
 *
 *  - At a coordinator, `decompose(task, node)` returns one subtask per engaged
 *    child (index-paired to `node.info.childIds`). A returned array of length K
 *    engages exactly the first K children; `[]` engages none.
 *  - Each engaged child is run: a worker (leaf) runs `execute`; a coordinator
 *    recurses. The coordinator seeds an accumulator with `seed(node)` and folds
 *    each child's result into it via `combine` AS SOON AS that child resolves
 *    (streaming) — NOT buffer-all-then-reduce.
 *  - `onPartial(partial, node)` fires once after every fold, so the number of
 *    onPartial calls at a node == the number of children it folded, and the LAST
 *    onPartial value at a node == that node's returned accumulator.
 *  - `combine` is assumed commutative + associative, so the FINAL result must be
 *    independent of child completion order.
 *  - stats.workerRuns == number of `execute` calls; stats.folds == number of
 *    `combine` calls; stats.peakBuffered == max count of resolved-but-not-yet-
 *    folded child results held at any instant (O(1) for a true streaming fold,
 *    but == branching for a Promise.all + array-reduce cheat).
 *
 * The `peakBuffered` assertions (test 3) are the primary anti-cheat: a non-
 * streaming (buffer-then-aggregate) implementation is caught there because its
 * buffer spikes to the branching factor (8, 16), which exceeds the O(1) bound.
 */

// --------------------------------------------------------------------------
// Test harness: a number-crunching exec over an arbitrary commutative monoid.
// Task T = number[] (the leaf values assigned to this subtree). A coordinator
// round-robins its assigned values among its children (an EXACT partition, so
// the multiset of leaf values is preserved regardless of tree shape). A worker
// folds its own bucket with the same op (a length-1 bucket just returns the
// value). Every combine / onPartial / execute call is instrumented.
// --------------------------------------------------------------------------

type NumTask = number[];
type NumRes = number;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  exec: StreamingAggExec<NumTask, NumRes>;
  opts: StreamingOptions<NumRes>;
  combineLog: Array<{ parent: string; acc: number; child: number }>;
  partialLog: Array<{ node: string; partial: number }>;
  executeOrder: string[];
}

function roundRobin(task: NumTask, k: number): NumTask[] {
  const buckets: NumTask[] = Array.from({ length: k }, () => []);
  if (k <= 0) return buckets;
  task.forEach((v, i) => buckets[i % k].push(v));
  return buckets;
}

function makeHarness(
  op: (a: number, b: number) => number,
  identity: number,
  executeDelayMs?: (values: NumTask, node: HierarchyNodeInfo) => number,
): Harness {
  const combineLog: Harness["combineLog"] = [];
  const partialLog: Harness["partialLog"] = [];
  const executeOrder: string[] = [];

  const exec: StreamingAggExec<NumTask, NumRes> = {
    decompose: (task, node) => roundRobin(task, node.childIds.length),
    execute: async (task, node) => {
      const delay = executeDelayMs ? executeDelayMs(task, node) : 0;
      if (delay > 0) await sleep(delay);
      executeOrder.push(node.id);
      return task.reduce(op, identity);
    },
    seed: () => identity,
    combine: (acc, child, node) => {
      combineLog.push({ parent: node.id, acc, child });
      return op(acc, child);
    },
  };

  const opts: StreamingOptions<NumRes> = {
    onPartial: (partial, node) => partialLog.push({ node: node.id, partial }),
  };

  return { exec, opts, combineLog, partialLog, executeOrder };
}

const sum = (a: number, b: number) => a + b;
const product = (a: number, b: number) => a * b;
const max = (a: number, b: number) => Math.max(a, b);

// --------------------------------------------------------------------------

describe("StreamingHierarchyAggregator — adversarial contract", () => {
  // 1. Correctness vs an independent reduce, over a NON-trivial commutative
  //    monoid (product, and separately max), on a branching-2 tree with 16
  //    worker leaves. Round-robin decompose gives an exact partition, so the
  //    streamed result must equal a flat reduce over the identical multiset.
  it("matches a reference reduce for product and max over 16 workers", async () => {
    // 16 distinct-ish values in [2..4]; product stays an exact integer < 2^53.
    const values = Array.from({ length: 16 }, (_, i) => (i % 3) + 2);
    const root = buildBalancedHierarchy(2, 3); // 1+2+4+8+16 nodes, 16 workers

    // product
    {
      const h = makeHarness(product, 1);
      const agg = new StreamingHierarchyAggregator<NumTask, NumRes>(
        root,
        h.exec,
        h.opts,
      );
      const { result, stats } = await agg.run(values.slice());
      const reference = values.reduce(product, 1);
      expect(result).toBe(reference);
      expect(stats.workerRuns).toBe(16);
      expect(stats.folds).toBe(30); // every non-root edge carries exactly one fold
      expect(stats.peakBuffered).toBeLessThanOrEqual(2);
    }

    // max
    {
      const h = makeHarness(max, -Infinity);
      const agg = new StreamingHierarchyAggregator<NumTask, NumRes>(
        root,
        h.exec,
        h.opts,
      );
      const { result, stats } = await agg.run(values.slice());
      const reference = values.reduce(max, -Infinity);
      expect(result).toBe(reference);
      expect(result).toBe(Math.max(...values));
      expect(stats.workerRuns).toBe(16);
      expect(stats.folds).toBe(30);
      expect(stats.peakBuffered).toBeLessThanOrEqual(2);
    }
  });

  // 2. Out-of-order resolution must not corrupt the fold. Workers resolve in
  //    REVERSE of dispatch order (delay derived from the value/index). Because
  //    combine is commutative+associative the result is invariant, and the fold
  //    count must be exact regardless of who finished first.
  it("is immune to scrambled child resolution order", async () => {
    const values = Array.from({ length: 16 }, (_, i) => i); // 0..15, sum = 120
    const root = buildBalancedHierarchy(2, 3);
    // Higher value resolves FIRST -> reverse of the ascending dispatch order.
    const h = makeHarness(sum, 0, (task) => 20 - task[0]);
    const agg = new StreamingHierarchyAggregator<NumTask, NumRes>(
      root,
      h.exec,
      h.opts,
    );
    const { result, stats } = await agg.run(values.slice());
    expect(result).toBe(120);
    expect(stats.folds).toBe(30);
    expect(stats.workerRuns).toBe(16);
    expect(h.combineLog.length).toBe(30);
  });

  // 3. *** PRIMARY ANTI-CHEAT *** peakBuffered must be genuinely O(1).
  //    A streaming fold holds ~1 un-folded child result at a time. A
  //    Promise.all + array-reduce implementation would buffer `branching`
  //    results, spiking peakBuffered to 8 and 16 for those trees.
  it("keeps peakBuffered O(1) across branching 2, 8, 16 (not buffer-then-reduce)", async () => {
    const measured: Record<number, number> = {};
    for (const branching of [2, 8, 16]) {
      const root = buildBalancedHierarchy(branching, 1); // root -> coords -> workers
      const leaves = branching * branching;
      const h = makeHarness(sum, 0);
      const agg = new StreamingHierarchyAggregator<NumTask, NumRes>(
        root,
        h.exec,
        h.opts,
      );
      const { result, stats } = await agg.run(new Array<number>(leaves).fill(1));
      measured[branching] = stats.peakBuffered;
      // Sanity: the workload itself is correct.
      expect(result).toBe(leaves);
      expect(stats.workerRuns).toBe(leaves);
      // The real assertion: streaming, so buffer never approaches `branching`.
      expect(
        stats.peakBuffered,
        `peakBuffered spiked to ${stats.peakBuffered} for branching=${branching} ` +
          `(expected <= 2). A value near ${branching} means the impl buffers all ` +
          `children then reduces — i.e. NOT streaming.`,
      ).toBeLessThanOrEqual(2);
    }
    // Surface the measured values in the test output for the report.
    // eslint-disable-next-line no-console
    console.log("peakBuffered measured:", JSON.stringify(measured));
  });

  // 4. combine must be called exactly once per child result — no double-fold,
  //    no missed child. Each leaf carries a distinct power of two; the total is
  //    a bitmask, so any double or missing fold changes the sum uniquely.
  it("folds each child exactly once (no double-fold, no dropped child)", async () => {
    const values = Array.from({ length: 16 }, (_, i) => 2 ** i); // sum = 65535
    const root = buildBalancedHierarchy(2, 3);
    const h = makeHarness(sum, 0);
    const agg = new StreamingHierarchyAggregator<NumTask, NumRes>(
      root,
      h.exec,
      h.opts,
    );
    const { result, stats } = await agg.run(values.slice());

    expect(result).toBe(65535); // exact bitmask => every leaf folded once
    // The instrumented combine count must equal the reported fold count, and
    // both must equal the number of coordinator->child edges (30 for this tree).
    expect(h.combineLog.length).toBe(30);
    expect(stats.folds).toBe(30);
    expect(stats.workerRuns).toBe(16);

    // Per-coordinator: exactly `branching` folds each (root + 14 inner coords).
    const foldsByParent = new Map<string, number>();
    for (const e of h.combineLog) {
      foldsByParent.set(e.parent, (foldsByParent.get(e.parent) ?? 0) + 1);
    }
    expect(foldsByParent.size).toBe(15); // 1 root + 2 + 4 + 8 coordinators
    for (const [, count] of foldsByParent) expect(count).toBe(2);
  });

  // 5. onPartial reports monotonic progress for an additive fold over positive
  //    values (the accumulator only grows), and the LAST partial at a node is
  //    that node's returned accumulator (checked exactly at the root).
  it("emits monotonic onPartial progress ending at the node's final value", async () => {
    const values = Array.from({ length: 16 }, (_, i) => i + 1); // all positive
    const root = buildBalancedHierarchy(2, 3);
    const h = makeHarness(sum, 0);
    const agg = new StreamingHierarchyAggregator<NumTask, NumRes>(
      root,
      h.exec,
      h.opts,
    );
    const { result, stats } = await agg.run(values.slice());

    // Group partials by node, preserving emission order.
    const byNode = new Map<string, number[]>();
    for (const e of h.partialLog) {
      const arr = byNode.get(e.node) ?? [];
      arr.push(e.partial);
      byNode.set(e.node, arr);
    }

    // Every coordinator's partial sequence is non-decreasing.
    for (const [, seq] of byNode) {
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
      }
    }

    // Total onPartial calls == total folds.
    expect(h.partialLog.length).toBe(stats.folds);

    // The LAST partial at the root equals the returned result.
    const rootSeq = byNode.get(root.info.id);
    expect(rootSeq).toBeDefined();
    expect(rootSeq![rootSeq!.length - 1]).toBe(result);
    expect(result).toBe(values.reduce(sum, 0)); // = 136
  });

  // 6. Degenerate shapes.
  it("handles a single worker-node root: returns execute's result, zero folds", async () => {
    // Hand-built depth-0 tree whose sole node is a leaf worker.
    const solo: HierarchyNode = {
      info: { id: "solo", kind: "worker", depth: 0, path: ["solo"], childIds: [] },
      children: [],
    };
    const executeValue = 42;
    const exec: StreamingAggExec<NumTask, NumRes> = {
      decompose: () => [],
      execute: async () => executeValue,
      seed: () => 0,
      combine: (acc, child) => acc + child,
    };
    const agg = new StreamingHierarchyAggregator<NumTask, NumRes>(solo, exec);
    const { result, stats } = await agg.run([1, 2, 3]);
    expect(result).toBe(executeValue);
    expect(stats.folds).toBe(0);
    expect(stats.workerRuns).toBe(1);
    expect(stats.peakBuffered).toBeLessThanOrEqual(2);
  });

  it("returns seed unchanged when a coordinator's decompose is empty", async () => {
    const root = buildBalancedHierarchy(2, 0); // root + 2 worker children
    const SEED = 7;
    let executeCalls = 0;
    const exec: StreamingAggExec<NumTask, NumRes> = {
      decompose: () => [], // engage NO children
      execute: async () => {
        executeCalls++;
        return 999;
      },
      seed: () => SEED,
      combine: (acc, child) => acc + child,
    };
    const agg = new StreamingHierarchyAggregator<NumTask, NumRes>(root, exec);
    const { result, stats } = await agg.run([1, 2, 3, 4]);
    expect(result).toBe(SEED); // seed unchanged
    expect(stats.folds).toBe(0);
    expect(stats.workerRuns).toBe(0); // no child engaged => no worker ran
    expect(executeCalls).toBe(0);
  });

  // 7. Associativity independence: identical workload, two artificial
  //    resolution orderings (opposite delay functions). Results must be
  //    bit-identical — proving the fold never depends on completion order.
  it("produces identical results under two different resolution orderings", async () => {
    const values = Array.from({ length: 16 }, (_, i) => i + 1);
    const buildRoot = () => buildBalancedHierarchy(2, 3);
    const expected = values.reduce(sum, 0); // 136

    const hAsc = makeHarness(sum, 0, (task) => task[0]); // low value first
    const aggAsc = new StreamingHierarchyAggregator<NumTask, NumRes>(
      buildRoot(),
      hAsc.exec,
      hAsc.opts,
    );
    const resAsc = await aggAsc.run(values.slice());

    const hDesc = makeHarness(sum, 0, (task) => 20 - task[0]); // high value first
    const aggDesc = new StreamingHierarchyAggregator<NumTask, NumRes>(
      buildRoot(),
      hDesc.exec,
      hDesc.opts,
    );
    const resDesc = await aggDesc.run(values.slice());

    expect(resAsc.result).toBe(resDesc.result);
    expect(resAsc.result).toBe(expected);
    // Same amount of work regardless of ordering.
    expect(resAsc.stats.folds).toBe(resDesc.stats.folds);
    expect(resAsc.stats.workerRuns).toBe(resDesc.stats.workerRuns);

    // A product monoid under the same reordering, for good measure.
    const pAsc = makeHarness(product, 1, (task) => task[0]);
    const pDesc = makeHarness(product, 1, (task) => 20 - task[0]);
    const rp1 = await new StreamingHierarchyAggregator<NumTask, NumRes>(
      buildRoot(),
      pAsc.exec,
      pAsc.opts,
    ).run(values.slice());
    const rp2 = await new StreamingHierarchyAggregator<NumTask, NumRes>(
      buildRoot(),
      pDesc.exec,
      pDesc.opts,
    ).run(values.slice());
    expect(rp1.result).toBe(rp2.result);
    expect(rp1.result).toBe(values.reduce(product, 1));
  });
});
