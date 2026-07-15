/**
 * Styx primitive #4 — the Budget-Optimal Bandit Controller.
 *
 * ===========================================================================
 * WHAT THIS IS
 * ===========================================================================
 * An *online* allocator that spends a fixed dollar budget across a live,
 * speculatively-expanding {@link BranchTree}. At every step it decides which
 * branch to advance / expand / prune, driving a single objective:
 *
 *     V-TPH$  —  verified-work-per-dollar, maximized *inside* the loop.
 *
 * It is the piece the architecture (docs/STYX_ARCHITECTURE.md, primitive #4)
 * calls the "budget-optimal bandit whose reward is verified-work-per-dollar".
 * Unlike test-time-compute schemes that allocate over i.i.d. answer samples,
 * this runs a bandit over a *tree* of divergent decompositions that grows while
 * it is being searched, and treats the verifier's calibrated fitness as the
 * reward signal — never a training gradient.
 *
 * ===========================================================================
 * THE BANDIT — UCB OVER BRANCHES, REWARD = FITNESS-GAIN / $
 * ===========================================================================
 * Each live frontier branch is an *arm*. For arm i we track the number of times
 * we have sampled it (n_i) and its mean calibrated fitness (mu_i), updated from
 * every {@link WorkerOracle.step}. Selection is deterministic UCB1 over visit
 * counts (NO randomness, NO clock):
 *
 *     UCB_i = mu_i
 *           + c * sqrt( ln(N + 1) / (n_i + 1) )      // exploration (visit-count)
 *           - lambda * (estCost_i / budget)          // cost penalty
 *
 * where N is the total number of samples taken so far and c is `explore`.
 *
 * Why the cost penalty? The objective is verified-work-per-DOLLAR, not per
 * step. Two branches with equal fitness are not equally good if one costs twice
 * as much to advance — the cheaper one yields more V-TPH$. Subtracting a
 * budget-normalized cost term makes the argmax prefer cheaper progress, so the
 * controller optimizes fitness *per dollar* rather than fitness per pull. When
 * costs are uniform the penalty is constant across arms and quality (mu_i) alone
 * drives the choice, exactly as a plain bandit would.
 *
 * We pick the max-UCB frontier arm *whose next step still fits in the remaining
 * budget* and advance it one unit of work via the oracle. The oracle is pure
 * (a function of branch state), so we "peek" it to learn the step's cost and
 * only actually charge the tree (via `advance`) when spent + cost <= budget.
 * This is what guarantees the hard invariant `spent <= budget` at all times.
 *
 * ===========================================================================
 * EXPAND / ADVANCE / PRUNE / STOP
 * ===========================================================================
 *  - ADVANCE: `oracle.step` -> `tree.advance(id,{output,fitness,costDelta,...})`.
 *    Update mu_i and n_i. If the oracle reports the branch is final, `complete`
 *    it (it becomes a shippable candidate for `best()`).
 *  - PRUNE: once an arm has been sampled >= `pruneAfter` times, if its mean
 *    fitness mu_i < `pruneBelow`, `prune` it. Pruning is the *selection
 *    operator*: reclaiming budget from a dead line and redirecting it is the
 *    productive act, not waste.
 *  - EXPAND: a branch whose mean fitness clears a promising bar is `expand`-ed
 *    once into a couple of deterministic child strategies (`${s}+refine`,
 *    `${s}+alt`) to search deeper. Expansion is bounded (count + depth capped)
 *    so the tree cannot blow up.
 *  - STOP, in priority order, when:
 *      * the frontier is empty                         -> "frontier-empty"
 *      * no affordable next step exists                -> "budget"
 *      * best frontier expected gain/$ < minGainPerDollar (all arms sampled)
 *                                                      -> "converged"
 *      * the hard iteration cap is hit                 -> "max-steps"
 *    The convergence rule is the marginal V-TPH$ test: stop when even the best
 *    remaining branch's expected calibrated-fitness gain per dollar has dropped
 *    below the caller's floor. Unexplored arms score +Infinity so the loop
 *    always explores every arm at least once before it can "converge".
 *
 * `allocations` attributes every node's cost to its ROOT ancestor (subtree-
 * summed), so the report shows exactly where the budget went. `best` is
 * `tree.best()` — the highest-fitness verified|done branch.
 *
 * ===========================================================================
 * DETERMINISM
 * ===========================================================================
 * Given a deterministic oracle the entire run is a pure function of the option
 * set: UCB uses visit counts only, ties break by branch-id order, and there is
 * no Math.random and no clock anywhere. Two runs produce byte-identical reports.
 */

import type { BranchNode } from "./branches";
import { BranchTree } from "./branches";

/**
 * The work+verify oracle for one unit of work on a branch. Injectable: a real
 * one runs a worker LLM + a calibrated verifier ensemble; the test one is a
 * deterministic function of the branch. It MUST be pure w.r.t. branch state so
 * the controller can peek the cost of a step before committing budget to it.
 */
export interface WorkerOracle {
  /**
   * Do one unit of work on `branch`; return the produced output, its calibrated
   * fitness in [0,1], the dollar cost incurred, and whether this branch is now
   * final (done).
   */
  step(branch: BranchNode): {
    output: string;
    fitness: number;
    cost: number;
    done: boolean;
    provenance?: string;
  };
}

export interface ControllerOptions {
  /** Total $ the controller may spend. `spent <= budget` is an invariant. */
  budget: number;
  /** UCB exploration constant c (default 0.5). */
  explore?: number;
  /** After a branch has been sampled >= pruneAfter times, prune if mean fitness < this (default 0.2). */
  pruneBelow?: number;
  /** Min samples before a branch is eligible to prune (default 2). */
  pruneAfter?: number;
  /** Stop when best expected fitness-gain/$ < this (default 0 — never converge on gain). */
  minGainPerDollar?: number;
  /** Hard cap on iterations (safety), default 10000. */
  maxSteps?: number;
}

export interface ControllerReport {
  best: BranchNode | undefined;
  spent: number;
  steps: number;
  branchesExplored: number;
  pruned: number;
  /** $ spent per root-branch id (subtree-summed). */
  allocations: Record<string, number>;
  stoppedReason: "budget" | "converged" | "frontier-empty" | "max-steps";
}

/** Per-arm running statistics the bandit maintains. */
interface ArmStat {
  /** number of oracle steps taken on this branch */
  n: number;
  /** sum of observed calibrated fitness values (mean = sum / n) */
  sumFitness: number;
  /** dollar cost of the most recent step */
  lastCost: number;
  /** calibrated-fitness gain from the most recent step (>= 0) */
  lastGain: number;
  /** whether this branch has already been expanded (expand at most once) */
  expanded: boolean;
}

/** Weight on the budget-normalized cost penalty in the UCB score. */
const COST_PENALTY = 0.5;
/** A branch whose mean fitness clears this bar may be expanded to search deeper. */
const PROMISING_BAR = 0.85;
/** Do not expand nodes deeper than this (bounds tree growth). */
const MAX_EXPAND_DEPTH = 2;

/**
 * Compare two Styx branch ids by numeric segments (mirrors branches.ts):
 * "b0" < "b1" < ... < "b10", and "b0" < "b0.0" < "b1". Used only for
 * deterministic tie-breaking; branches.ts owns the canonical version.
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

export class BanditController {
  private readonly tree: BranchTree;
  private readonly oracle: WorkerOracle;
  private readonly budget: number;
  private readonly explore: number;
  private readonly pruneBelow: number;
  private readonly pruneAfter: number;
  private readonly minGainPerDollar: number;
  private readonly maxSteps: number;

  private readonly stats = new Map<string, ArmStat>();
  /** Total samples across all arms (the N in UCB's ln(N+1)). */
  private totalSamples = 0;
  /** Running sum of every step cost, for a global average cost estimate. */
  private globalCostSum = 0;

  private spent = 0;
  private steps = 0;
  private prunedCount = 0;

  constructor(tree: BranchTree, oracle: WorkerOracle, opts: ControllerOptions) {
    this.tree = tree;
    this.oracle = oracle;
    this.budget = opts.budget;
    this.explore = opts.explore ?? 0.5;
    this.pruneBelow = opts.pruneBelow ?? 0.2;
    this.pruneAfter = opts.pruneAfter ?? 2;
    this.minGainPerDollar = opts.minGainPerDollar ?? 0;
    this.maxSteps = opts.maxSteps ?? 10000;
  }

  private arm(id: string): ArmStat {
    let s = this.stats.get(id);
    if (!s) {
      s = { n: 0, sumFitness: 0, lastCost: 0, lastGain: 0, expanded: false };
      this.stats.set(id, s);
    }
    return s;
  }

  private mean(id: string): number {
    const s = this.stats.get(id);
    return s && s.n > 0 ? s.sumFitness / s.n : 0;
  }

  /** Expected calibrated-fitness gain per dollar for a branch; +Inf if unexplored. */
  private gainPerDollar(id: string): number {
    const s = this.stats.get(id);
    if (!s || s.n === 0) return Infinity; // unexplored: worth a look, never converge on it
    if (s.lastCost <= 0) return s.lastGain > 0 ? Infinity : 0;
    return s.lastGain / s.lastCost;
  }

  /** Best guess of the branch's next-step cost, for budget pre-filtering & UCB. */
  private costEstimate(id: string): number {
    const s = this.stats.get(id);
    if (s && s.n > 0) return s.lastCost;
    return this.totalSamples > 0 ? this.globalCostSum / this.totalSamples : 0;
  }

  private ucb(node: BranchNode): number {
    const s = this.arm(node.id);
    const mu = s.n > 0 ? s.sumFitness / s.n : 0;
    const exploration =
      this.explore * Math.sqrt(Math.log(this.totalSamples + 1) / (s.n + 1));
    const penalty =
      this.budget > 0 ? COST_PENALTY * (this.costEstimate(node.id) / this.budget) : 0;
    return mu + exploration - penalty;
  }

  /** The root ("bX") ancestor of a node — used to attribute subtree cost. */
  private rootAncestorId(node: BranchNode): string {
    let cur = node;
    while (cur.parentId !== null) {
      const parent = this.tree.get(cur.parentId);
      if (!parent) break;
      cur = parent;
    }
    return cur.id;
  }

  private buildAllocations(): Record<string, number> {
    const alloc: Record<string, number> = {};
    for (const root of this.tree.root()) alloc[root.id] = 0;
    for (const node of this.tree.all()) {
      const rootId = this.rootAncestorId(node);
      alloc[rootId] = (alloc[rootId] ?? 0) + node.costSpent;
    }
    return alloc;
  }

  /**
   * Ensure `tree.best()` reflects the leading explored branch. If the run stops
   * (budget/converged/max-steps) with the highest-fitness branch still live on
   * the frontier — never `complete`d — `best()` (which only sees verified|done)
   * would miss it. Verify that leading branch as the shipped answer.
   */
  private finalizeBest(): void {
    const curBest = this.tree.best();
    let lead: BranchNode | undefined;
    for (const node of this.tree.frontier()) {
      if (node.fitness <= 0) continue;
      if (!lead || node.fitness > lead.fitness) lead = node; // frontier is id-sorted -> ties keep lowest id
    }
    if (lead && (!curBest || lead.fitness > curBest.fitness)) {
      this.tree.markVerified(lead.id, lead.fitness);
    }
  }

  /** Run the allocation loop to budget/convergence; returns the report with the best branch found. */
  run(): ControllerReport {
    let stoppedReason: ControllerReport["stoppedReason"] = "frontier-empty";

    while (true) {
      if (this.steps >= this.maxSteps) {
        stoppedReason = "max-steps";
        break;
      }

      const frontier = this.tree.frontier();
      if (frontier.length === 0) {
        stoppedReason = "frontier-empty";
        break;
      }

      // --- UCB selection: rank arms, then take the highest-UCB affordable one.
      const ranked = frontier
        .map((node) => ({ node, score: this.ucb(node) }))
        .sort((a, b) =>
          b.score !== a.score ? b.score - a.score : compareIds(a.node.id, b.node.id)
        );

      let picked: { node: BranchNode; res: ReturnType<WorkerOracle["step"]> } | undefined;
      for (const { node } of ranked) {
        // Cheap pre-filter: a known step cost that already can't fit is skipped
        // without doing (paying for) the work.
        const est = this.costEstimate(node.id);
        const s = this.stats.get(node.id);
        if (s && s.n > 0 && this.spent + est > this.budget + 1e-12) continue;
        // Peek the pure oracle to learn the actual cost of this step.
        const res = this.oracle.step(node);
        if (this.spent + res.cost <= this.budget + 1e-12) {
          picked = { node, res };
          break;
        }
        // Didn't fit — remember its true cost so we don't re-peek needlessly.
        this.arm(node.id).lastCost = res.cost;
      }

      if (!picked) {
        // No affordable next step on any frontier arm.
        stoppedReason = "budget";
        break;
      }

      // --- ADVANCE: commit the work and charge the tree.
      const { node, res } = picked;
      const before = node.fitness;
      this.tree.advance(node.id, {
        output: res.output,
        fitness: res.fitness,
        costDelta: res.cost,
        steps: 1,
        provenance: res.provenance !== undefined ? [res.provenance] : undefined,
      });
      this.spent += res.cost;
      this.steps += 1;
      this.totalSamples += 1;
      this.globalCostSum += res.cost;

      const arm = this.arm(node.id);
      arm.n += 1;
      arm.sumFitness += res.fitness;
      arm.lastCost = res.cost;
      arm.lastGain = Math.max(0, res.fitness - before);

      // --- RESOLVE the branch: done -> complete; else maybe prune; else expand.
      if (res.done) {
        this.tree.complete(node.id);
      } else if (arm.n >= this.pruneAfter && this.mean(node.id) < this.pruneBelow) {
        this.tree.prune(node.id, "low-fitness");
        this.prunedCount += 1;
      } else {
        this.maybeExpand(node);
      }

      // --- CONVERGENCE: stop if even the best frontier arm's gain/$ is too low.
      if (this.minGainPerDollar > 0) {
        const front = this.tree.frontier();
        if (front.length > 0) {
          let bestGain = -Infinity;
          for (const f of front) {
            const g = this.gainPerDollar(f.id);
            if (g > bestGain) bestGain = g;
          }
          if (bestGain < this.minGainPerDollar) {
            stoppedReason = "converged";
            break;
          }
        }
      }
    }

    this.finalizeBest();

    let branchesExplored = 0;
    for (const s of this.stats.values()) if (s.n > 0) branchesExplored += 1;

    return {
      best: this.tree.best(),
      spent: this.spent,
      steps: this.steps,
      branchesExplored,
      pruned: this.prunedCount,
      allocations: this.buildAllocations(),
      stoppedReason,
    };
  }

  /**
   * Expand a promising branch once, into two deterministic child strategies, to
   * search deeper. Bounded: only branches at or below MAX_EXPAND_DEPTH whose
   * mean fitness clears PROMISING_BAR, and only if a child step could still be
   * afforded. Expanding at most once per branch keeps growth linear.
   */
  private maybeExpand(node: BranchNode): void {
    const arm = this.arm(node.id);
    if (arm.expanded) return;
    if (node.depth >= MAX_EXPAND_DEPTH) return;
    if (this.mean(node.id) < PROMISING_BAR) return;
    // Only worth expanding if we can plausibly afford to work a child.
    if (this.spent + this.costEstimate(node.id) > this.budget + 1e-12) return;
    arm.expanded = true;
    this.tree.expand(node.id, [`${node.strategy}+refine`, `${node.strategy}+alt`]);
  }
}
