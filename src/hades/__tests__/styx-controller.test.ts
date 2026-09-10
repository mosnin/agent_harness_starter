import { describe, expect, it } from "vitest";
import { BranchTree, type BranchNode } from "../styx/branches";
import {
  BanditController,
  type ControllerOptions,
  type WorkerOracle,
} from "../styx/controller";

/**
 * Deterministic work+verify oracle. Fitness is a fixed function of the branch's
 * strategy (a lookup table of "true qualities") and a fixed per-step cost. Each
 * step closes half the remaining gap between the branch's current fitness and
 * the strategy's true quality — so fitness climbs monotonically toward q and the
 * marginal gain halves every step (a saturating, diminishing-returns process).
 *
 * NO Math.random, NO clock: purely a function of `branch` state, so the oracle
 * can be safely "peeked" by the controller and two runs are byte-identical.
 */
interface OracleConfig {
  qualities: Record<string, number>;
  cost?: number;
  /** Force done at this step count (used to test frontier-empty). */
  doneAtStep?: number;
  /** Force done once the remaining gap to q drops below this. */
  doneEps?: number;
  /** Default quality for strategies not in the table. */
  defaultQuality?: number;
}

function qualityOf(strategy: string, cfg: OracleConfig): number {
  // Derived strategies ("s+refine", "s+alt") inherit their base strategy's
  // quality so expansion doesn't invent artificially-good branches.
  const base = strategy.split("+")[0].trim();
  if (base in cfg.qualities) return cfg.qualities[base];
  return cfg.defaultQuality ?? 0.5;
}

function makeOracle(cfg: OracleConfig): WorkerOracle {
  const cost = cfg.cost ?? 1;
  const eps = cfg.doneEps ?? 1e-4;
  return {
    step(branch: BranchNode) {
      const q = qualityOf(branch.strategy, cfg);
      const prev = branch.fitness; // 0 until first advance sets it
      const next = prev + (q - prev) * 0.5;
      const nextStepCount = branch.steps + 1;
      const done =
        (cfg.doneAtStep !== undefined && nextStepCount >= cfg.doneAtStep) ||
        q - next <= eps;
      return {
        output: `${branch.strategy}#${nextStepCount}`,
        fitness: next,
        cost,
        done,
        provenance: `worker:${branch.strategy}`,
      };
    },
  };
}

/** Uniform baseline: spend budget/K on each root, no reallocation, no pruning. */
function uniformBaseline(
  roots: string[],
  cfg: OracleConfig,
  budget: number
): { bestFitness: number; spent: number } {
  const tree = new BranchTree(roots);
  const oracle = makeOracle(cfg);
  const cost = cfg.cost ?? 1;
  const perRoot = budget / roots.length;
  let spent = 0;
  for (const root of tree.root()) {
    let localSpent = 0;
    // eslint-disable-next-line no-constant-condition
    while (localSpent + cost <= perRoot + 1e-12) {
      const node = tree.get(root.id)!;
      if (node.state === "done" || node.state === "pruned") break;
      const res = oracle.step(node);
      tree.advance(root.id, {
        output: res.output,
        fitness: res.fitness,
        costDelta: res.cost,
        steps: 1,
      });
      localSpent += res.cost;
      spent += res.cost;
      if (res.done) {
        tree.complete(root.id);
        break;
      }
    }
    // Verify whatever fitness this root reached so best() can see it.
    const node = tree.get(root.id)!;
    if (node.state !== "done" && node.state !== "pruned" && node.fitness > 0) {
      tree.markVerified(root.id, node.fitness);
    }
  }
  return { bestFitness: tree.best()?.fitness ?? 0, spent };
}

function run(roots: string[], cfg: OracleConfig, opts: ControllerOptions) {
  const tree = new BranchTree(roots);
  const oracle = makeOracle(cfg);
  const controller = new BanditController(tree, oracle, opts);
  return { report: controller.run(), tree };
}

describe("BanditController — budget safety", () => {
  it("never spends more than the budget (spent <= budget, always)", () => {
    for (const budget of [1, 3, 7, 10, 25]) {
      const { report, tree } = run(
        ["A", "B", "C"],
        { qualities: { A: 0.9, B: 0.5, C: 0.15 }, cost: 1 },
        { budget }
      );
      expect(report.spent).toBeLessThanOrEqual(budget);
      // The report's spend equals the tree's honest total-cost accounting.
      expect(report.spent).toBeCloseTo(tree.stats().totalCost, 10);
    }
  });

  it("respects a fractional / awkward budget without overshoot", () => {
    const { report } = run(
      ["A", "B"],
      { qualities: { A: 0.8, B: 0.3 }, cost: 2 },
      { budget: 7 } // 3 steps of cost 2 = 6 fit; a 4th (8) would not
    );
    expect(report.spent).toBeLessThanOrEqual(7);
    expect(report.stoppedReason === "budget" || report.stoppedReason === "frontier-empty").toBe(
      true
    );
  });
});

describe("BanditController — allocation quality", () => {
  it("gives a clearly-best strategy more allocation than a clearly-bad one", () => {
    const { report } = run(
      ["good", "bad"],
      { qualities: { good: 0.92, bad: 0.08 }, cost: 1 },
      { budget: 20, pruneAfter: 2, pruneBelow: 0.2 }
    );
    // b0 = "good", b1 = "bad" (root ids are assigned in constructor order).
    expect(report.allocations["b0"]).toBeGreaterThan(report.allocations["b1"]);
  });

  it("best() is a high-fitness branch", () => {
    const { report } = run(
      ["good", "mid", "bad"],
      { qualities: { good: 0.95, mid: 0.5, bad: 0.1 }, cost: 1 },
      { budget: 30 }
    );
    expect(report.best).toBeDefined();
    expect(report.best!.fitness).toBeGreaterThan(0.8);
    // The winning branch descends from the "good" root.
    expect(report.best!.id.startsWith("b0")).toBe(true);
  });
});

describe("BanditController — pruning", () => {
  it("prunes low-fitness branches after pruneAfter samples", () => {
    const { report, tree } = run(
      ["good", "bad"],
      { qualities: { good: 0.9, bad: 0.05 }, cost: 1 },
      { budget: 25, pruneAfter: 2, pruneBelow: 0.2 }
    );
    expect(report.pruned).toBeGreaterThanOrEqual(1);
    expect(tree.get("b1")!.state).toBe("pruned");
    // The good branch is never pruned.
    expect(tree.get("b0")!.state).not.toBe("pruned");
  });

  it("does not prune before pruneAfter samples are taken", () => {
    // Budget only allows a single step total; the bad branch can't reach
    // pruneAfter=3 samples, so it must NOT be pruned.
    const { report } = run(
      ["bad"],
      { qualities: { bad: 0.05 }, cost: 1 },
      { budget: 1, pruneAfter: 3, pruneBelow: 0.2 }
    );
    expect(report.pruned).toBe(0);
  });
});

describe("BanditController — stop rules", () => {
  it('converges (stops "converged") when one branch dominates and minGainPerDollar > 0', () => {
    // Single branch, quality 0.7: gains are 0.35, 0.175, 0.0875, 0.04375, ...
    // With minGainPerDollar 0.05 the 4th step's gain/$ (0.04375) trips the stop.
    const { report } = run(
      ["solo"],
      { qualities: { solo: 0.7 }, cost: 1, doneEps: 1e-6 },
      { budget: 1000, minGainPerDollar: 0.05 }
    );
    expect(report.stoppedReason).toBe("converged");
    expect(report.spent).toBeLessThan(1000); // stopped on marginal value, not budget
    expect(report.best).toBeDefined();
    expect(report.best!.fitness).toBeGreaterThan(0.5);
  });

  it('stops "frontier-empty" when every branch completes or is pruned', () => {
    // good -> done at step 3; bad -> pruned after 2 low samples. Frontier drains.
    const { report, tree } = run(
      ["good", "bad"],
      { qualities: { good: 0.8, bad: 0.05 }, cost: 1, doneAtStep: 3 },
      { budget: 1000, pruneAfter: 2, pruneBelow: 0.2 }
    );
    expect(report.stoppedReason).toBe("frontier-empty");
    expect(tree.frontier().length).toBe(0);
    expect(tree.get("b0")!.state).toBe("done");
    expect(tree.get("b1")!.state).toBe("pruned");
  });

  it('stops "budget" when no next step fits', () => {
    const { report } = run(
      ["a", "b"],
      { qualities: { a: 0.9, b: 0.9 }, cost: 1, doneEps: 1e-9 },
      { budget: 5 } // will exhaust budget long before either saturates
    );
    expect(report.stoppedReason).toBe("budget");
    expect(report.spent).toBeLessThanOrEqual(5);
  });

  it('honors the maxSteps safety cap ("max-steps")', () => {
    const { report } = run(
      ["a", "b"],
      { qualities: { a: 0.9, b: 0.85 }, cost: 1, doneEps: 1e-12 },
      { budget: 1_000_000, maxSteps: 4 }
    );
    expect(report.stoppedReason).toBe("max-steps");
    expect(report.steps).toBe(4);
  });
});

describe("BanditController — determinism", () => {
  it("produces byte-identical reports across two runs", () => {
    const cfg: OracleConfig = {
      qualities: { A: 0.9, B: 0.6, C: 0.2, D: 0.05 },
      cost: 1,
    };
    const opts: ControllerOptions = { budget: 40, pruneAfter: 2, pruneBelow: 0.2 };
    const a = run(["A", "B", "C", "D"], cfg, opts).report;
    const b = run(["A", "B", "C", "D"], cfg, opts).report;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("BanditController — V-TPH$ vs uniform baseline", () => {
  it("reaches at least as much verified work per dollar as uniform allocation, and typically more", () => {
    // Same oracle, same budget. Uniform splits budget/K across roots with no
    // reallocation; the controller concentrates spend on the winners and prunes
    // the losers. Verified-work metric = the best calibrated fitness reached.
    const roots = ["s0", "s1", "s2", "s3", "s4"];
    const cfg: OracleConfig = {
      qualities: { s0: 0.9, s1: 0.85, s2: 0.3, s3: 0.15, s4: 0.1 },
      cost: 1,
    };
    const budget = 20;

    const { report } = run(roots, cfg, {
      budget,
      pruneAfter: 2,
      pruneBelow: 0.2,
    });
    const uniform = uniformBaseline(roots, cfg, budget);

    const controllerBest = report.best?.fitness ?? 0;

    // Neither exceeds budget.
    expect(report.spent).toBeLessThanOrEqual(budget);
    expect(uniform.spent).toBeLessThanOrEqual(budget + 1e-9);

    // The controller is at least as good...
    expect(controllerBest).toBeGreaterThanOrEqual(uniform.bestFitness);
    // ...and on this problem strictly better: concentrating budget on s0 pushes
    // its saturating fitness higher than uniform's few steps ever could.
    expect(controllerBest).toBeGreaterThan(uniform.bestFitness);

    // And the winners soak up the budget: the two good roots together get the
    // lion's share, the three bad roots almost none (pruned early).
    const goodSpend = report.allocations["b0"] + report.allocations["b1"];
    const badSpend =
      report.allocations["b2"] + report.allocations["b3"] + report.allocations["b4"];
    expect(goodSpend).toBeGreaterThan(badSpend);
  });
});
