/**
 * Adaptive / elastic hierarchy planning. A fixed swarm tree wastes coordination
 * on tiny jobs and starves big ones of parallelism. Given a workload estimate,
 * this module computes the tree **shape** — branching factor, coordinator depth,
 * and worker count — that minimizes modeled makespan, so a small job gets a
 * shallow narrow tree and a big job a wider/deeper one, each worker's chunk
 * sized near a target cost. The result plugs straight into `buildBalancedHierarchy`.
 */

import { buildBalancedHierarchy, type HierarchyNode } from "./tree";
import { modelSpeedup } from "../parallel/speedup";

export interface WorkloadEstimate {
  itemCount: number;
  /** uniform cost per item (default 1) OR a per-index cost function (takes precedence). */
  costPerItem?: number;
  costOf?: (index: number) => number;
}

export interface AdaptivePlanOptions {
  maxBranching?: number; // cap children per node, default 8
  maxWorkers?: number; // cap total leaf workers, default 256
  targetChunkCost?: number; // aim each worker's chunk near this total cost, default 10
  /** modeled cost of one coordination hop, added per depth level. default 0.5 */
  hopCostMs?: number;
}

export interface AdaptivePlan {
  branching: number;
  coordinatorLevels: number;
  workers: number;
  root: HierarchyNode;
  /** modeled makespan = worker-level parallel makespan + depth*hopCost. */
  estimatedMakespanMs: number;
}

interface ResolvedOptions {
  maxBranching: number;
  maxWorkers: number;
  targetChunkCost: number;
  hopCostMs: number;
}

function resolveOptions(opts?: AdaptivePlanOptions): ResolvedOptions {
  return {
    maxBranching: Math.max(2, Math.floor(opts?.maxBranching ?? 8)),
    maxWorkers: Math.max(1, Math.floor(opts?.maxWorkers ?? 256)),
    targetChunkCost: opts?.targetChunkCost && opts.targetChunkCost > 0 ? opts.targetChunkCost : 10,
    hopCostMs: opts?.hopCostMs ?? 0.5,
  };
}

/** Build the per-item cost array from an estimate (`costOf` wins over `costPerItem`). */
function costArray(estimate: WorkloadEstimate): number[] {
  const n = Math.max(0, Math.floor(estimate.itemCount));
  const costs = new Array<number>(n);
  const uniform = estimate.costPerItem ?? 1;
  for (let i = 0; i < n; i++) {
    costs[i] = estimate.costOf ? estimate.costOf(i) : uniform;
  }
  return costs;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Total node count of a balanced tree: sum of B^d for d in 0..L+1. */
function totalNodes(branching: number, coordinatorLevels: number): number {
  const depth = coordinatorLevels + 1;
  let sum = 0;
  for (let d = 0; d <= depth; d++) sum += branching ** d;
  return sum;
}

/** modeled makespan for a leaf pool: parallel worker makespan + depth hops. */
function makespanFor(costs: number[], leaves: number, coordinatorLevels: number, hopCostMs: number): number {
  const parallelMs = modelSpeedup(costs, Math.max(1, leaves)).parallelMs;
  return parallelMs + (coordinatorLevels + 1) * hopCostMs;
}

interface Candidate {
  branching: number;
  coordinatorLevels: number;
  leaves: number;
  makespan: number;
  nodes: number;
}

/**
 * Compute the elastic hierarchy shape that minimizes modeled makespan for a
 * workload, sizing each worker's chunk near `targetChunkCost` while respecting
 * the branching and worker caps. Never throws on valid positive inputs; an
 * empty or single-item workload collapses to a single-worker plan.
 */
export function planAdaptiveHierarchy(estimate: WorkloadEstimate, opts?: AdaptivePlanOptions): AdaptivePlan {
  const o = resolveOptions(opts);
  const costs = costArray(estimate);
  const itemCount = costs.length;
  const totalCost = costs.reduce((a, c) => a + Math.max(0, c), 0);

  // Desired worker count: enough chunks to keep each near the target cost, but
  // never more workers than items (and never past the cap).
  const workerCeiling = Math.min(o.maxWorkers, Math.max(1, itemCount));
  const desiredWorkers = clamp(Math.ceil(totalCost / o.targetChunkCost), 1, workerCeiling);

  // Tiny workloads (0 or 1 items, or a sub-target total) collapse to one worker.
  if (desiredWorkers <= 1) {
    const branching = 1;
    const coordinatorLevels = 0;
    const root = buildBalancedHierarchy(branching, coordinatorLevels);
    return {
      branching,
      coordinatorLevels,
      workers: 1,
      root,
      estimatedMakespanMs: makespanFor(costs, 1, coordinatorLevels, o.hopCostMs),
    };
  }

  const L_MAX = 64; // safety bound; B^(L+1) reaches any cap long before this.

  // Hard ceiling on leaf/worker count: never more workers than the cap OR than
  // there are items (idle leaves are pure waste and break the contract).
  const leafCeiling = workerCeiling; // = min(maxWorkers, max(1, itemCount))

  let best: Candidate | null = null; // makespan-optimal shape with leaves <= leafCeiling
  let smallestValid: Candidate | null = null; // fewest leaves that still cover desiredWorkers

  const better = (a: Candidate, b: Candidate | null): boolean => {
    if (!b) return true;
    if (a.makespan !== b.makespan) return a.makespan < b.makespan;
    return a.nodes < b.nodes; // tie-break toward fewer total nodes (lighter footprint)
  };

  for (let B = 2; B <= o.maxBranching; B++) {
    for (let L = 0; L <= L_MAX; L++) {
      const leaves = B ** (L + 1);
      // Never provision beyond the ceiling; deeper trees for this B only overshoot.
      if (leaves > leafCeiling) break;

      const cand: Candidate = {
        branching: B,
        coordinatorLevels: L,
        leaves,
        makespan: makespanFor(costs, leaves, L, o.hopCostMs),
        nodes: totalNodes(B, L),
      };

      // Makespan-optimal within the cap (the performance objective).
      if (better(cand, best)) best = cand;

      // Also track the smallest shape that still reaches the chunk-cost-desired
      // worker count, as a lighter-footprint alternative when makespan ties.
      if (leaves >= desiredWorkers) {
        if (!smallestValid || leaves < smallestValid.leaves || (leaves === smallestValid.leaves && cand.nodes < smallestValid.nodes)) {
          smallestValid = cand;
        }
      }
    }
  }

  // Prefer the makespan-optimal shape; fall back to the smallest valid tree, then
  // to a single worker (guarantees a result for any positive input).
  const chosen = best ?? smallestValid;
  if (!chosen) {
    // Only reachable if leafCeiling < 2 (tiny workload) — handled above, but be safe.
    const root = buildBalancedHierarchy(1, 0);
    return { branching: 1, coordinatorLevels: 0, workers: 1, root, estimatedMakespanMs: makespanFor(costs, 1, 0, o.hopCostMs) };
  }

  const root = buildBalancedHierarchy(chosen.branching, chosen.coordinatorLevels);
  return {
    branching: chosen.branching,
    coordinatorLevels: chosen.coordinatorLevels,
    workers: chosen.leaves,
    root,
    estimatedMakespanMs: chosen.makespan,
  };
}

/**
 * Compare the adaptive plan's makespan against a naive fixed tree for the SAME
 * workload. `improvement` is `fixedMs / adaptiveMs` — a value ≥ 1 means the
 * adaptive plan is at least as fast (usually much faster, since it sizes the
 * worker pool to the job instead of the fixed leaf count).
 */
export function compareToFixed(
  estimate: WorkloadEstimate,
  fixed: { branching: number; coordinatorLevels: number },
  opts?: AdaptivePlanOptions,
): { adaptiveMs: number; fixedMs: number; improvement: number } {
  const o = resolveOptions(opts);
  const costs = costArray(estimate);

  const adaptiveMs = planAdaptiveHierarchy(estimate, opts).estimatedMakespanMs;

  const fixedLeaves = Math.max(1, fixed.branching) ** (Math.max(0, fixed.coordinatorLevels) + 1);
  const fixedMs = makespanFor(costs, fixedLeaves, Math.max(0, fixed.coordinatorLevels), o.hopCostMs);

  const improvement = adaptiveMs === 0 ? 1 : fixedMs / adaptiveMs;
  return { adaptiveMs, fixedMs, improvement };
}
