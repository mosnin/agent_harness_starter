import { describe, it, expect } from "vitest";
import {
  mulberry32,
  reduceRef,
  randomTreeSpec,
  runFuzzCase,
  fuzzMany,
} from "../hierarchy/fuzz";
import type { ReductionName, FuzzTreeSpec, FuzzCase } from "../hierarchy/fuzz";
import { buildBalancedHierarchy } from "../hierarchy/tree";
import { HierarchyOrchestrator } from "../hierarchy/orchestrator";
import type { HierarchyExec, HierarchyNodeInfo } from "../hierarchy/orchestrator";

/**
 * ADVERSARIAL VERIFIER for the property-based fuzzer (`../hierarchy/fuzz`).
 *
 * A property test that can't fail is worthless. These tests prove:
 *  - reduceRef is a CORRECT, independent, order-sensitive oracle (hand-computed).
 *  - The hier-vs-reference comparison has TEETH: a real aggregation bug (dropped
 *    child, +1, reordered concat) genuinely produces hier !== reference.
 *  - fuzzMany's failure-detection shape is sound.
 *  - randomTreeSpec is DIVERSE and mulberry32 is a real, reproducible PRNG.
 *  - runFuzzCase stores results consistent with a fresh reduceRef call.
 *
 * Nothing here is weakened: where the fuzzer is expected to be correct we assert
 * it, and where a wrong exec must diverge we assert divergence. If any assertion
 * fails, the fuzzer's oracle is broken or vacuous — and that is the finding.
 */

// ---------------------------------------------------------------------------
// Local execs used only to PROVE the oracle has teeth. These drive the PUBLIC
// HierarchyOrchestrator directly over known leaf values. Contiguous chunking is
// used so a correct, order-preserving aggregate matches reduceRef's ordered
// semantics (round-robin would scramble concat order and muddy the concat test).
// ---------------------------------------------------------------------------

/** Split an array into `n` contiguous equal chunks (exact for full trees). */
function contiguousChunks<T>(arr: T[], n: number): T[][] {
  const size = arr.length / n; // integer for balanced full trees
  const out: T[][] = [];
  for (let i = 0; i < n; i++) out.push(arr.slice(i * size, (i + 1) * size));
  return out;
}

const decomposeContiguous = (task: number[], node: HierarchyNodeInfo): number[][] =>
  contiguousChunks(task, node.childIds.length);

// (a) CORRECT sum: aggregate = sum of all children.
const correctSumExec: HierarchyExec<number[], number> = {
  decompose: decomposeContiguous,
  execute: async (task) => task[0],
  aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0),
};

// (b) WRONG sum #1: drop the last child before summing.
const dropLastSumExec: HierarchyExec<number[], number> = {
  decompose: decomposeContiguous,
  execute: async (task) => task[0],
  aggregate: (childResults) => childResults.slice(0, -1).reduce((a, b) => a + b, 0),
};

// (b) WRONG sum #2: add 1 to the sum.
const plusOneSumExec: HierarchyExec<number[], number> = {
  decompose: decomposeContiguous,
  execute: async (task) => task[0],
  aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0) + 1,
};

// CORRECT ordered concat: join children in order.
const correctConcatExec: HierarchyExec<number[], string> = {
  decompose: decomposeContiguous,
  execute: async (task) => String(task[0]),
  aggregate: (childResults) => childResults.join(","),
};

// WRONG concat: reverse children before joining (child-order regression).
const reverseConcatExec: HierarchyExec<number[], string> = {
  decompose: decomposeContiguous,
  execute: async (task) => String(task[0]),
  aggregate: (childResults) => [...childResults].reverse().join(","),
};

// ===========================================================================
// 1. reduceRef IS A CORRECT ORACLE (hand-computed)
// ===========================================================================

describe("reduceRef is a correct, independent oracle", () => {
  it("sum [1,2,3,4] = 10", () => {
    expect(reduceRef("sum", [1, 2, 3, 4])).toBe(10);
  });
  it("product [2,3,4] = 24", () => {
    expect(reduceRef("product", [2, 3, 4])).toBe(24);
  });
  it("max [-5,3,-1] = 3", () => {
    expect(reduceRef("max", [-5, 3, -1])).toBe(3);
  });
  it("min [-5,3,-1] = -5", () => {
    expect(reduceRef("min", [-5, 3, -1])).toBe(-5);
  });

  it("concat is ORDER-SENSITIVE — [1,2,3] and [3,2,1] differ", () => {
    expect(reduceRef("concat", [1, 2, 3])).toBe("1,2,3");
    expect(reduceRef("concat", [3, 2, 1])).toBe("3,2,1");
    // If reduceRef sorted/reordered, these would collide. They must not.
    expect(reduceRef("concat", [1, 2, 3])).not.toBe(reduceRef("concat", [3, 2, 1]));
  });

  it("empty array → the identity element for each op", () => {
    expect(reduceRef("sum", [])).toBe(0);
    expect(reduceRef("product", [])).toBe(1);
    expect(reduceRef("max", [])).toBe(-Infinity);
    expect(reduceRef("min", [])).toBe(Infinity);
    expect(reduceRef("concat", [])).toBe("");
  });

  it("single element → that element (or its string for concat)", () => {
    expect(reduceRef("sum", [7])).toBe(7);
    expect(reduceRef("product", [7])).toBe(7);
    expect(reduceRef("max", [7])).toBe(7);
    expect(reduceRef("min", [7])).toBe(7);
    expect(reduceRef("concat", [7])).toBe("7");
  });
});

// ===========================================================================
// 2. THE ORACLE HAS TEETH — a real aggregation bug produces hier !== reference
// ===========================================================================

describe("the hier-vs-reference comparison has teeth (sum)", () => {
  // branching 2, coordinatorLevels 1 → 2^2 = 4 workers.
  const leaves = [3, 1, 4, 2];
  const reference = reduceRef("sum", leaves); // 10
  const buildRoot = () => buildBalancedHierarchy(2, 1);

  it("a CORRECT aggregate EQUALS reduceRef('sum', leaves)", async () => {
    const orch = new HierarchyOrchestrator(buildRoot(), correctSumExec);
    const { result } = await orch.run(leaves);
    expect(result).toBe(reference);
    expect(result).toBe(10);
  });

  it("a WRONG aggregate that DROPS the last child does NOT equal the reference", async () => {
    const orch = new HierarchyOrchestrator(buildRoot(), dropLastSumExec);
    const { result } = await orch.run(leaves);
    // If this still equaled `reference`, the comparison would be insensitive.
    expect(result).not.toBe(reference);
  });

  it("a WRONG aggregate that ADDS 1 does NOT equal the reference", async () => {
    const orch = new HierarchyOrchestrator(buildRoot(), plusOneSumExec);
    const { result } = await orch.run(leaves);
    expect(result).not.toBe(reference);
  });
});

// ===========================================================================
// 3. CONCAT ORDER SENSITIVITY HAS TEETH
// ===========================================================================

describe("the fuzzer would catch a child-order regression (concat)", () => {
  // Non-palindromic leaf set so reversing genuinely changes the string.
  const leaves = [1, 2, 3, 4];
  const reference = reduceRef("concat", leaves); // "1,2,3,4"
  const buildRoot = () => buildBalancedHierarchy(2, 1);

  it("a CORRECT ordered concat EQUALS reduceRef('concat', leaves)", async () => {
    const orch = new HierarchyOrchestrator(buildRoot(), correctConcatExec);
    const { result } = await orch.run(leaves);
    expect(result).toBe(reference);
    expect(result).toBe("1,2,3,4");
  });

  it("a REORDERING concat does NOT equal the reference", async () => {
    const orch = new HierarchyOrchestrator(buildRoot(), reverseConcatExec);
    const { result } = await orch.run(leaves);
    expect(result).not.toBe(reference);
  });
});

// ===========================================================================
// 4. fuzzMany DETECTS FAILURES STRUCTURALLY
// ===========================================================================

describe("fuzzMany failure-detection shape", () => {
  it("reports {checked:50, failures:[], firstFailure:null} on the correct code", async () => {
    const r = await fuzzMany(50);
    expect(r.checked).toBe(50);
    expect(r.failures).toEqual([]);
    expect(r.firstFailure).toBeNull();
  });

  it("firstFailure is exactly failures[0] ?? null (structural invariant)", async () => {
    const r = await fuzzMany(50);
    // Holds whether or not there are failures; proves firstFailure is the
    // first match===false case, not something disconnected from `failures`.
    expect(r.firstFailure).toBe(r.failures[0] ?? null);
    // Every reported failure must actually be a mismatch.
    for (const f of r.failures) {
      expect(f.match).toBe(false);
      expect(f.hierResult).not.toBe(f.referenceResult);
    }
  });
});

// ===========================================================================
// 5. GENERATOR DIVERSITY & PRNG
// ===========================================================================

describe("randomTreeSpec is diverse and mulberry32 is a real PRNG", () => {
  it("produces >=3 distinct branchings and >=3 distinct levels over 100 seeds, leafCount always consistent", () => {
    const branchings = new Set<number>();
    const levels = new Set<number>();
    for (let seed = 1; seed <= 100; seed++) {
      const spec: FuzzTreeSpec = randomTreeSpec(mulberry32(seed));
      branchings.add(spec.branching);
      levels.add(spec.coordinatorLevels);
      // Full-tree invariant: leafCount === branching^(coordinatorLevels+1).
      expect(spec.leafCount).toBe(Math.pow(spec.branching, spec.coordinatorLevels + 1));
    }
    expect(branchings.size).toBeGreaterThanOrEqual(3);
    expect(levels.size).toBeGreaterThanOrEqual(3);
  });

  it("mulberry32 yields distinct sequences for distinct seeds, values in [0,1)", () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    expect(a).not.toBe(b);
    for (const v of [a, b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("mulberry32 is reproducible — same seed, same sequence", () => {
    const seq = (seed: number) => {
      const rng = mulberry32(seed);
      return [rng(), rng(), rng(), rng(), rng()];
    };
    expect(seq(42)).toEqual(seq(42));
    // And a different seed diverges somewhere in the sequence.
    expect(seq(42)).not.toEqual(seq(43));
  });
});

// ===========================================================================
// 6. runFuzzCase INTEGRITY
// ===========================================================================

describe("runFuzzCase integrity — stored results agree with a fresh oracle call", () => {
  const seeds = [1, 2, 3, 7, 13, 99];
  for (const seed of seeds) {
    it(`seed ${seed}: fresh reduceRef === referenceResult === hierResult, match===true`, async () => {
      const c: FuzzCase = await runFuzzCase(seed);
      const fresh = reduceRef(c.reduction as ReductionName, c.leafValues);
      expect(fresh).toBe(c.referenceResult);
      expect(c.hierResult).toBe(c.referenceResult);
      expect(c.match).toBe(true);
    });
  }
});
