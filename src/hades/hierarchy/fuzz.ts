/**
 * Property-based fuzzer for the swarm hierarchy — the correctness oracle is:
 * **the hierarchy result must equal a flat reference reducer**.
 *
 * A {@link HierarchyOrchestrator} recursively decomposes an ordered array of leaf
 * values down a balanced tree, executes each leaf, and aggregates children's
 * results back up with an associative reduction. If decompose partitions the
 * ordered values correctly and aggregate folds children in order, the tree fold
 * must produce exactly the same value as folding the flat leaf array left-to-right
 * ({@link reduceRef}). This module drives that equality over *random* tree shapes,
 * *random* associative reductions, and *random* integer workloads, all derived
 * deterministically from a numeric `seed` via {@link mulberry32} (no `Math.random`,
 * no clock) so any failing case is reproducible from its seed alone.
 *
 * What the fuzz specifically guards:
 *  - **Partition correctness**: decompose must carry the *contiguous, ordered* slice
 *    of leaf values that a node's subtree owns to each child (leftmost leaves get
 *    the leftmost values). A slicing bug shows up as a wrong sum/product/max/min.
 *  - **Leaf-order preservation**: the `concat` reduction is order-sensitive (it joins
 *    the values with `","`). Any bug that reorders children or mis-slices the array
 *    changes the string and is caught immediately — sum/max/min alone could not see
 *    a reordering because they are commutative.
 *
 * Exactness note: all reductions are computed with IEEE-754 doubles, so the tree
 * fold and the flat fold agree only when arithmetic is *exact* (no rounding that
 * would depend on grouping). Leaf values are therefore integers in `[-9..9]`,
 * **except for `product`**, where a full tree may hold up to `4^4 = 256` leaves and
 * `9^256` would overflow the safe-integer range and round differently under tree
 * vs. flat grouping — so `product` draws leaf values from `[-1..1]`, keeping every
 * partial product in `{-1, 0, 1}` and the equality exact regardless of tree size.
 */

import { buildBalancedHierarchy } from "./tree";
import { HierarchyOrchestrator } from "./orchestrator";
import type { HierarchyExec } from "./orchestrator";

/** The associative reductions the fuzzer folds over the leaves. */
export type ReductionName = "sum" | "product" | "max" | "min" | "concat";

/**
 * Deterministic PRNG (mulberry32) from a numeric seed. Returns a function that
 * yields the next float in `[0, 1)` on each call. Inlined on purpose — the whole
 * point is reproducibility, so `Math.random` is never used.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Identity element for each reduction (used as the fold seed / empty-input value). */
function identity(name: ReductionName): number | string {
  switch (name) {
    case "sum":
      return 0;
    case "product":
      return 1;
    case "max":
      return -Infinity;
    case "min":
      return Infinity;
    case "concat":
      return "";
  }
}

/**
 * Apply a reduction to a list of partial results, in order. Works both on raw leaf
 * values (numbers) and on already-aggregated coordinator results (numbers, or
 * strings for `concat`). This is the single combine used by both the flat reference
 * and the hierarchy's `aggregate`, so the two can only diverge via ordering/slicing.
 */
function combine(name: ReductionName, results: Array<number | string>): number | string {
  switch (name) {
    case "sum":
      return (results as number[]).reduce((a, b) => a + b, 0);
    case "product":
      return (results as number[]).reduce((a, b) => a * b, 1);
    case "max":
      return (results as number[]).reduce((a, b) => Math.max(a, b), -Infinity);
    case "min":
      return (results as number[]).reduce((a, b) => Math.min(a, b), Infinity);
    case "concat":
      // Ordered, separator-joined string — order-sensitive by construction.
      return results.length === 0 ? "" : results.map((r) => String(r)).join(",");
  }
}

/**
 * The flat reference reduction over `vals` **in order**:
 * `sum`→`+` (id 0), `product`→`*` (id 1), `max`→`Math.max` (id -Infinity),
 * `min`→`Math.min` (id +Infinity), `concat`→ordered string join of the values
 * separated by `","` (id `""`). Order-sensitive for `concat`.
 */
export function reduceRef(name: ReductionName, vals: number[]): number | string {
  if (vals.length === 0) return identity(name);
  return combine(name, vals);
}

export interface FuzzTreeSpec {
  branching: number;
  coordinatorLevels: number;
  leafCount: number;
}

/**
 * Pick a random FULL-tree spec: `branching` in `[2..maxBranching]`,
 * `coordinatorLevels` in `[0..maxLevels]`; `leafCount = branching^(coordinatorLevels+1)`
 * (a full balanced tree, so every leaf gets exactly one value — no surplus slots).
 * Defaults: `maxBranching` 4, `maxLevels` 3 (so up to `4^4 = 256` leaves).
 */
export function randomTreeSpec(
  rng: () => number,
  opts?: { maxBranching?: number; maxLevels?: number }
): FuzzTreeSpec {
  const maxBranching = Math.max(2, opts?.maxBranching ?? 4);
  const maxLevels = Math.max(0, opts?.maxLevels ?? 3);
  // branching ∈ [2 .. maxBranching]  (maxBranching - 1 distinct values)
  const branching = 2 + Math.floor(rng() * (maxBranching - 1));
  // coordinatorLevels ∈ [0 .. maxLevels]
  const coordinatorLevels = Math.floor(rng() * (maxLevels + 1));
  const leafCount = branching ** (coordinatorLevels + 1);
  return { branching, coordinatorLevels, leafCount };
}

export interface FuzzCase {
  seed: number;
  spec: FuzzTreeSpec;
  reduction: ReductionName;
  leafValues: number[]; // the leafCount inputs in leaf order
  hierResult: number | string;
  referenceResult: number | string;
  match: boolean; // hierResult deep-equals referenceResult
}

const REDUCTIONS: ReductionName[] = ["sum", "product", "max", "min", "concat"];

/**
 * Leaf-value range for a reduction. `[-9..9]` in general; `[-1..1]` for `product`
 * so that a full tree's product stays in `{-1, 0, 1}` and the exact-equality oracle
 * holds regardless of leaf count (see the module doc's exactness note).
 */
function valueBounds(name: ReductionName): { min: number; span: number } {
  return name === "product" ? { min: -1, span: 3 } : { min: -9, span: 19 };
}

/** Deep equality for the primitive result union. `===` treats `-0` and `0` as equal. */
function deepEqual(a: number | string, b: number | string): boolean {
  return a === b;
}

/**
 * Build a random tree + random reduction + random integer leaf values from `seed`,
 * run the {@link HierarchyOrchestrator} so it reduces the leaves with the chosen op,
 * compute {@link reduceRef} over the same ordered leaves, and return the FuzzCase
 * with `match = deepEqual(hierResult, referenceResult)`.
 *
 * The exec:
 *  - `decompose(task, node)` splits the node's ordered value-array into
 *    `node.childIds.length` **contiguous, equally-sized** chunks (a full balanced
 *    tree divides evenly at every level), preserving left-to-right order.
 *  - `execute(task)` runs a leaf: its task is a single-element slice; it returns that
 *    one value.
 *  - `aggregate(childResults)` applies the reduction op to the child results in order.
 */
export async function runFuzzCase(
  seed: number,
  opts?: { maxBranching?: number; maxLevels?: number }
): Promise<FuzzCase> {
  const rng = mulberry32(seed);

  const spec = randomTreeSpec(rng, opts);
  const reduction = REDUCTIONS[Math.floor(rng() * REDUCTIONS.length)];

  const { min, span } = valueBounds(reduction);
  const leafValues: number[] = [];
  for (let i = 0; i < spec.leafCount; i++) {
    leafValues.push(Math.floor(rng() * span) + min);
  }

  const root = buildBalancedHierarchy(spec.branching, spec.coordinatorLevels);

  const exec: HierarchyExec<number[], number | string> = {
    decompose: (task, node) => {
      const n = node.childIds.length;
      const size = task.length / n; // exact: full balanced tree divides evenly
      const chunks: number[][] = [];
      for (let i = 0; i < n; i++) {
        chunks.push(task.slice(i * size, (i + 1) * size));
      }
      return chunks;
    },
    execute: async (task) => task[0],
    aggregate: (childResults) => combine(reduction, childResults),
  };

  const orch = new HierarchyOrchestrator(root, exec);
  const { result: hierResult } = await orch.run(leafValues);
  const referenceResult = reduceRef(reduction, leafValues);

  return {
    seed,
    spec,
    reduction,
    leafValues,
    hierResult,
    referenceResult,
    match: deepEqual(hierResult, referenceResult),
  };
}

/**
 * Run seeds `[startSeed .. startSeed+count-1]`; collect every case whose
 * `match === false`. `firstFailure` is the earliest such case (or `null` — the
 * healthy outcome, meaning the hierarchy matched the flat reference on every seed).
 */
export async function fuzzMany(
  count: number,
  opts?: { startSeed?: number; maxBranching?: number; maxLevels?: number }
): Promise<{ checked: number; failures: FuzzCase[]; firstFailure: FuzzCase | null }> {
  const startSeed = opts?.startSeed ?? 0;
  const failures: FuzzCase[] = [];
  let checked = 0;
  for (let i = 0; i < count; i++) {
    const c = await runFuzzCase(startSeed + i, opts);
    checked++;
    if (!c.match) failures.push(c);
  }
  return { checked, failures, firstFailure: failures[0] ?? null };
}
