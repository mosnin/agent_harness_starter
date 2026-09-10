/**
 * Styx primitive #1 — the Speculative Decomposition Tree.
 *
 * ===========================================================================
 * WHAT THIS IS
 * ===========================================================================
 * A pure, deterministic data structure holding a *tree of speculative
 * decomposition branches* plus the small set of operations a budget-optimal
 * bandit controller needs to race them. The speculator seeds K *divergent* root
 * strategies (different ways to split the task — NOT K samples of one plan); the
 * controller then expands promising nodes, records the work/cost/fitness a
 * worker+verifier produced on each, prunes losing subtrees, and reads the live
 * frontier + the current best verified branch.
 *
 * There is no LLM, no worker, no verifier, no clock and no randomness in here.
 * This file is the *substrate* those things act on. Everything is a pure
 * function of the operation sequence applied to it, so an adversary replaying
 * the same operations always gets a byte-identical tree — which is exactly what
 * makes the controller's allocation decisions and the V-TPH$ scoreboard
 * reproducible and testable.
 *
 * ===========================================================================
 * WHY PRUNING IS THE MECHANISM, NOT WASTE
 * ===========================================================================
 * Classical speculative execution (speculative decoding, SpecBranch, Sherlock)
 * is *latency-first and lossless*: it runs the same trajectory faster and throws
 * away only mispredictions. Styx inverts this. Styx is *quality-first*: it
 * deliberately launches DIVERGENT branches, expects MOST of them to lose, and
 * *pruning the losers is the productive act* — it is how compute is reclaimed
 * from a dead line of attack and redirected toward a live one. A pruned branch
 * is a resolved question ("this decomposition doesn't clear the bar"), not a
 * failure. Selection, not coverage, is the bottleneck (Large Language Monkeys,
 * 2407.21787); prune() is the selection operator on the search tree.
 *
 * Consequently `prune` marks a branch AND its entire subtree "pruned" and is
 * idempotent — re-pruning an already-dead line is a no-op, because the question
 * was already answered.
 *
 * ===========================================================================
 * WHY PRUNED-BRANCH COST IS RETAINED IN totalCost
 * ===========================================================================
 * Racing has a real price. Every branch — including the ones we later prune —
 * spent real dollars on cheap workers and verifiers *before* we knew it would
 * lose. `stats().totalCost` therefore sums `costSpent` over ALL nodes, pruned
 * included. This is the honest accounting the V-TPH$ (verified-work-per-dollar)
 * math depends on: the controller's job is not to avoid spending on branches
 * that die, it is to make the surviving branch pay for all of them. Hiding
 * pruned cost would let a controller look budget-optimal while quietly burning
 * money on speculation. `best()` and `bestFitness`, by contrast, look ONLY at
 * live verified|done branches — pruned fitness is irrelevant to what we ship,
 * even though pruned cost is central to what we paid.
 *
 * ===========================================================================
 * DETERMINISTIC ID SCHEME (locked — controller + adversary code against it)
 * ===========================================================================
 *   - Roots are "b0", "b1", "b2", … in constructor order.
 *   - A child of "bX" is "bX.0", "bX.1", … assigned in expansion order. The
 *     index is the count of children the parent already has, so repeated
 *     expand() calls keep counting upward and never reuse an id.
 *   - Ids are never recycled: a pruned node keeps its id and stays in the tree
 *     (it still holds its cost). Same operation sequence ⇒ same ids ⇒ same tree.
 */

export type BranchState = "pending" | "active" | "verified" | "pruned" | "done";

export interface BranchNode {
  id: string;
  parentId: string | null;
  depth: number;
  /** The decomposition strategy/plan this branch represents. */
  strategy: string;
  state: BranchState;
  /** Latest calibrated P(correct) in [0,1]; 0 until verified. */
  fitness: number;
  /** Cumulative $ spent on this branch (accumulated, never overwritten). */
  costSpent: number;
  steps: number;
  output?: string;
  provenance: string[];
}

export interface BranchTreeStats {
  total: number;
  pending: number;
  active: number;
  verified: number;
  pruned: number;
  done: number;
  bestFitness: number;
  totalCost: number;
}

/**
 * Compare two branch ids by their numeric segments so ordering is intuitive and
 * stable: "b0" < "b1" < "b2" < … < "b10", and "b0" < "b0.0" < "b0.1" < "b1".
 * A plain lexicographic sort would order "b10" before "b2"; this does not.
 */
function compareIds(a: string, b: string): number {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return pa.length - pb.length;
}

/** Reject NaN / ±Infinity and clamp a fitness score into [0,1]. */
function clampFitness(x: number): number {
  if (typeof x !== "number" || Number.isNaN(x)) {
    throw new RangeError(`fitness must be a finite number, got ${x}`);
  }
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export class BranchTree {
  private nodes = new Map<string, BranchNode>();
  private rootIds: string[] = [];

  /**
   * Seed K divergent root branches — one per strategy — each "pending".
   * Root ids are deterministic: "b0", "b1", … in the given order.
   */
  constructor(rootStrategies: string[]) {
    rootStrategies.forEach((strategy, i) => {
      const id = `b${i}`;
      this.rootIds.push(id);
      this.nodes.set(id, {
        id,
        parentId: null,
        depth: 0,
        strategy,
        state: "pending",
        fitness: 0,
        costSpent: 0,
        steps: 0,
        provenance: [],
      });
    });
  }

  /** The seeded root branches, in id order. */
  root(): BranchNode[] {
    return this.rootIds.map((id) => this.nodes.get(id)!);
  }

  get(id: string): BranchNode | undefined {
    return this.nodes.get(id);
  }

  /** Direct children of a node, sorted by id. */
  children(id: string): BranchNode[] {
    const out: BranchNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.parentId === id) out.push(node);
    }
    out.sort((a, b) => compareIds(a.id, b.id));
    return out;
  }

  /** Walk from a node up to its root; true if any ancestor is pruned. */
  private hasPrunedAncestor(node: BranchNode): boolean {
    let cur = node.parentId;
    while (cur !== null) {
      const parent = this.nodes.get(cur);
      if (!parent) break;
      if (parent.state === "pruned") return true;
      cur = parent.parentId;
    }
    return false;
  }

  /**
   * Branches eligible for further action: state pending or active, AND not
   * itself pruned, AND not sitting under a pruned ancestor. done/verified nodes
   * are already resolved and never appear. Sorted by id.
   */
  frontier(): BranchNode[] {
    const out: BranchNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.state !== "pending" && node.state !== "active") continue;
      if (this.hasPrunedAncestor(node)) continue;
      out.push(node);
    }
    out.sort((a, b) => compareIds(a.id, b.id));
    return out;
  }

  private require(id: string): BranchNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`BranchTree: no such branch "${id}"`);
    return node;
  }

  /**
   * Add child branches to a node. The parent must exist and be neither pruned
   * nor done. Child ids are deterministic under the parent ("bX.0", "bX.1", …),
   * continuing from the parent's existing child count. The parent transitions to
   * "active" (it is now a live, expanded line of attack). Returns the new nodes.
   */
  expand(id: string, childStrategies: string[]): BranchNode[] {
    const parent = this.require(id);
    if (parent.state === "pruned") {
      throw new Error(`BranchTree: cannot expand pruned branch "${id}"`);
    }
    if (parent.state === "done") {
      throw new Error(`BranchTree: cannot expand completed branch "${id}"`);
    }
    let base = this.children(id).length;
    const created: BranchNode[] = [];
    for (const strategy of childStrategies) {
      const childId = `${id}.${base++}`;
      const child: BranchNode = {
        id: childId,
        parentId: id,
        depth: parent.depth + 1,
        strategy,
        state: "pending",
        fitness: 0,
        costSpent: 0,
        steps: 0,
        provenance: [],
      };
      this.nodes.set(childId, child);
      created.push(child);
    }
    parent.state = "active";
    return created;
  }

  /**
   * Record work a worker/verifier produced on a branch. Cost ACCUMULATES
   * (`costSpent += costDelta`); it is never overwritten — the honest running
   * tally of what this branch has cost. `costDelta` must be >= 0. `steps`
   * accumulates likewise. `output`, `fitness` (clamped to [0,1]) and
   * `provenance` (appended) are set when provided. The branch becomes "active".
   * The branch must exist and be neither pruned nor done.
   */
  advance(
    id: string,
    patch: {
      output?: string;
      fitness?: number;
      costDelta: number;
      steps?: number;
      provenance?: string[];
    }
  ): void {
    const node = this.require(id);
    if (node.state === "pruned") {
      throw new Error(`BranchTree: cannot advance pruned branch "${id}"`);
    }
    if (node.state === "done") {
      throw new Error(`BranchTree: cannot advance completed branch "${id}"`);
    }
    if (typeof patch.costDelta !== "number" || Number.isNaN(patch.costDelta)) {
      throw new RangeError(`advance: costDelta must be a finite number, got ${patch.costDelta}`);
    }
    if (patch.costDelta < 0) {
      throw new RangeError(`advance: costDelta must be >= 0, got ${patch.costDelta}`);
    }
    node.costSpent += patch.costDelta;
    if (patch.steps !== undefined) node.steps += patch.steps;
    if (patch.output !== undefined) node.output = patch.output;
    if (patch.fitness !== undefined) node.fitness = clampFitness(patch.fitness);
    if (patch.provenance !== undefined) node.provenance.push(...patch.provenance);
    node.state = "active";
  }

  /**
   * Mark a branch verified with a calibrated fitness score (clamped to [0,1]).
   * The branch must exist and not be pruned/done.
   */
  markVerified(id: string, fitness: number): void {
    const node = this.require(id);
    if (node.state === "pruned") {
      throw new Error(`BranchTree: cannot verify pruned branch "${id}"`);
    }
    if (node.state === "done") {
      throw new Error(`BranchTree: cannot verify completed branch "${id}"`);
    }
    node.fitness = clampFitness(fitness);
    node.state = "verified";
  }

  /**
   * Prune a branch AND its entire subtree — the selection operator on the tree.
   * All affected nodes become "pruned" and `reason` is appended to each one's
   * provenance. Idempotent: nodes already pruned are left untouched (re-pruning a
   * dead line is a no-op), so the reason is not appended twice. The missing-id
   * guard still applies. Pruned nodes retain their id and their costSpent.
   */
  prune(id: string, reason: string): void {
    const root = this.require(id);
    if (root.state === "pruned") return; // idempotent: whole subtree already dead
    // BFS over the subtree; skip nodes already pruned so re-pruning is a no-op.
    const queue: BranchNode[] = [root];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (node.state !== "pruned") {
        node.state = "pruned";
        node.provenance.push(reason);
      }
      for (const child of this.children(node.id)) {
        if (child.state !== "pruned") queue.push(child);
      }
    }
  }

  /**
   * Mark a branch done/final. Must exist and not be pruned.
   */
  complete(id: string): void {
    const node = this.require(id);
    if (node.state === "pruned") {
      throw new Error(`BranchTree: cannot complete pruned branch "${id}"`);
    }
    node.state = "done";
  }

  /**
   * The highest-fitness branch among verified|done branches (pruned ignored).
   * undefined if there are none. Ties broken deterministically by id order.
   */
  best(): BranchNode | undefined {
    let winner: BranchNode | undefined;
    for (const node of this.nodes.values()) {
      if (node.state !== "verified" && node.state !== "done") continue;
      if (
        winner === undefined ||
        node.fitness > winner.fitness ||
        (node.fitness === winner.fitness && compareIds(node.id, winner.id) < 0)
      ) {
        winner = node;
      }
    }
    return winner;
  }

  stats(): BranchTreeStats {
    const s: BranchTreeStats = {
      total: 0,
      pending: 0,
      active: 0,
      verified: 0,
      pruned: 0,
      done: 0,
      bestFitness: 0,
      totalCost: 0,
    };
    for (const node of this.nodes.values()) {
      s.total++;
      s[node.state]++;
      s.totalCost += node.costSpent; // pruned cost included — honest accounting
    }
    s.bestFitness = this.best()?.fitness ?? 0;
    return s;
  }

  /** Every node in the tree, sorted by id. */
  all(): BranchNode[] {
    const out = [...this.nodes.values()];
    out.sort((a, b) => compareIds(a.id, b.id));
    return out;
  }
}
