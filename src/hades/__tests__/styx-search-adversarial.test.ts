/**
 * ADVERSARIAL VERIFICATION of the Styx S2 search kernel — the two keyless
 * primitives on which the "budget-optimal bandit whose reward is
 * verified-work-per-dollar" thesis stands or falls:
 *
 *   - src/hades/styx/branches.ts   — speculative decomposition tree (substrate)
 *   - src/hades/styx/controller.ts — budget-optimal bandit controller
 *
 * These tests do NOT try to make the kernel look good. The mandate is EXTERNAL
 * VALIDITY, not it-runs. Specifically we attack the design doc's falsifiable
 * claim #3 head-on: "The bandit controller beats uniform allocation by >= 20%
 * verified-work-per-$ at equal budget." We construct a KNOWN separable problem,
 * independently implement a uniform baseline, and MEASURE the ratio. Where a
 * guarantee holds the attack fails (test passes); where it is broken the
 * assertion encodes the CORRECT behaviour and is left to FAIL so the bug is
 * reported, not hidden.
 *
 * Fully deterministic: every "random-ish" number is a hash of a string
 * (splitmix / mulberry32 avalanche). NO Math.random, NO Date.now/clock, NO
 * network. Everything is synchronous.
 */
import { describe, it, expect } from "vitest";
import { BranchTree } from "../styx/branches";
import type { BranchNode } from "../styx/branches";
import { BanditController } from "../styx/controller";
import type { WorkerOracle, ControllerOptions } from "../styx/controller";

// ===========================================================================
// Deterministic pseudo-randomness — hash-based, NO Math.random anywhere.
// ===========================================================================

/** FNV-1a + a final avalanche → a uint32 hash of a string. */
function hash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // splitmix-style finalization avalanche
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic float in [0,1) from a string key. */
function unit(key: string): number {
  return hash32(key) / 4294967296;
}

/** Classic mulberry32 PRNG — seeded, deterministic, NO Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Root ("bX") index of any node id: "b3.1.0" -> 3. Mirrors the id scheme. */
function rootIndexOf(id: string): number {
  return parseInt(id.slice(1).split(".")[0], 10);
}

// ===========================================================================
// Deterministic oracles (pure functions of branch state — NO clock/random).
// ===========================================================================

interface SeparableOpts {
  cost?: number;
  /** Branch becomes done once branch.steps >= doneAt (undefined => never). */
  doneAt?: number;
  /** Amplitude of deterministic hash-based fitness noise. */
  noiseAmp?: number;
}

/**
 * A KNOWN separable problem: each root has a fixed true quality; a branch's
 * fitness ~= quality of its ROOT ancestor plus tiny deterministic noise. Cost
 * is fixed per step. This is the "ground truth" world S2 exists to be tested
 * against (per the architecture doc, S2 uses simulated workers with known
 * ground truth so allocation optimality is *testable*).
 */
function separableOracle(qualities: number[], opts: SeparableOpts = {}): WorkerOracle {
  const cost = opts.cost ?? 1;
  const doneAt = opts.doneAt;
  const noiseAmp = opts.noiseAmp ?? 0;
  return {
    step(branch: BranchNode) {
      const q = qualities[rootIndexOf(branch.id)] ?? 0;
      const noise =
        noiseAmp > 0 ? (unit(`${branch.id}:${branch.steps}`) * 2 - 1) * noiseAmp : 0;
      let f = q + noise;
      if (f < 0) f = 0;
      if (f > 1) f = 1;
      const done = doneAt !== undefined && branch.steps >= doneAt;
      return {
        output: `${branch.id}@${branch.steps}`,
        fitness: f,
        cost,
        done,
        provenance: `w:${branch.id}`,
      };
    },
  };
}

/**
 * A hostile, varied oracle: cost and fitness are hash-derived (so they jump
 * around unpredictably yet reproducibly), and `done` fires stochastically. Used
 * to hammer the budget-safety invariant across many parameterisations.
 */
function chaoticOracle(seed: number, doneChance: number): WorkerOracle {
  return {
    step(branch: BranchNode) {
      const h = hash32(`${seed}|${branch.id}|${branch.steps}`);
      const cost = 0.3 + ((h % 1000) / 1000) * 2.2; // [0.3, 2.5]
      const fitness = ((h >>> 10) % 1000) / 1000; // [0, 1)
      const done = ((h >>> 20) % 1000) / 1000 < doneChance;
      return { output: "x", fitness, cost, done, provenance: `c:${branch.id}` };
    },
  };
}

// ===========================================================================
// Metrics helpers.
// ===========================================================================

/** Sum of fitness over branches that are verified|done (the "verified work"). */
function verifiedWork(tree: BranchTree): number {
  let vw = 0;
  for (const n of tree.all()) {
    if (n.state === "verified" || n.state === "done") vw += n.fitness;
  }
  return vw;
}

/** Sum of every node's costSpent — the honest total (pruned cost included). */
function totalNodeCost(tree: BranchTree): number {
  let c = 0;
  for (const n of tree.all()) c += n.costSpent;
  return c;
}

/**
 * The UNIFORM baseline: independently implemented, deliberately naive. Spend an
 * equal share (budget/K) on each root, sequentially, with NO reallocation, NO
 * pruning, NO bandit and NO expansion. It uses the SAME oracle so the only
 * variable is the allocation policy. Each worked root is "verified" at its final
 * fitness (or completed if the oracle says done) — a naive allocator ships every
 * branch it touched. Returns the resulting tree and dollars actually spent.
 */
function runUniform(
  strategies: string[],
  oracle: WorkerOracle,
  budget: number
): { tree: BranchTree; spent: number } {
  const K = strategies.length;
  const tree = new BranchTree(strategies);
  const perRoot = budget / K;
  let spent = 0;
  for (const root of tree.root()) {
    let rSpent = 0;
    while (true) {
      const node = tree.get(root.id)!;
      if (node.state === "done" || node.state === "pruned") break;
      const res = oracle.step(node);
      if (rSpent + res.cost > perRoot + 1e-9) break;
      if (spent + res.cost > budget + 1e-9) break;
      tree.advance(root.id, {
        output: res.output,
        fitness: res.fitness,
        costDelta: res.cost,
        steps: 1,
      });
      rSpent += res.cost;
      spent += res.cost;
      if (res.done) {
        tree.complete(root.id);
        break;
      }
    }
    const n = tree.get(root.id)!;
    if (n.state !== "done" && n.state !== "pruned" && n.steps > 0) {
      tree.markVerified(root.id, n.fitness);
    }
  }
  return { tree, spent };
}

/** Six-root separable world: two strong (~0.9), four weak (~0.15). */
const SEP_QUALITIES = [0.9, 0.9, 0.15, 0.15, 0.15, 0.15];
const SEP_STRATEGIES = SEP_QUALITIES.map((_, i) => `strategy-${i}`);
const GOOD_ROOTS = ["b0", "b1"];
const BAD_ROOTS = ["b2", "b3", "b4", "b5"];

// ===========================================================================
// ATTACK 1 — BUDGET IS NEVER EXCEEDED (hard safety invariant).
// ===========================================================================
describe("ATTACK 1: budget is never exceeded (safety)", () => {
  const budgets = [0.5, 1, 3.7, 8, 17, 50, 123.45];
  const seeds = [1, 7, 42, 99, 12345];
  const doneChances = [0, 0.1, 0.4];

  for (const budget of budgets) {
    for (const seed of seeds) {
      for (const dc of doneChances) {
        it(`spent<=budget & accounting honest (budget=${budget}, seed=${seed}, done=${dc})`, () => {
          const strategies = Array.from({ length: 5 }, (_, i) => `s${i}`);
          const tree = new BranchTree(strategies);
          const oracle = chaoticOracle(seed, dc);
          const report = new BanditController(tree, oracle, {
            budget,
            // low prune bar + expansion enabled -> stress the whole machine
            pruneAfter: 2,
            pruneBelow: 0.3,
          }).run();

          // (a) the headline invariant — never, ever overspend.
          expect(report.spent).toBeLessThanOrEqual(budget + 1e-9);

          // (b) sum of allocations <= budget and equals actual spend.
          const allocSum = Object.values(report.allocations).reduce((a, b) => a + b, 0);
          expect(allocSum).toBeLessThanOrEqual(budget + 1e-9);
          expect(allocSum).toBeCloseTo(report.spent, 9);

          // (c) every dollar is accounted: sum of node.costSpent == spent, and
          // the tree's own totalCost (pruned included) agrees. Nothing hidden.
          expect(totalNodeCost(tree)).toBeCloseTo(report.spent, 9);
          expect(tree.stats().totalCost).toBeCloseTo(report.spent, 9);

          // spend is non-negative and steps consistent.
          expect(report.spent).toBeGreaterThanOrEqual(0);
          expect(report.steps).toBeGreaterThanOrEqual(0);
        });
      }
    }
  }
});

// ===========================================================================
// ATTACK 2 — THE CONTROLLER BEATS UNIFORM ALLOCATION (the headline claim).
// ===========================================================================
describe("ATTACK 2: controller beats uniform allocation (falsifiable claim #3)", () => {
  const BUDGET = 120;
  // done after 3 samples (steps>=2 at peek); prune fires at 2 samples for weak
  // roots, so weak branches are pruned BEFORE they could ever complete.
  const oracleOpts: SeparableOpts = { cost: 1, doneAt: 2, noiseAmp: 0.02 };

  function runController() {
    const tree = new BranchTree(SEP_STRATEGIES);
    const oracle = separableOracle(SEP_QUALITIES, oracleOpts);
    const report = new BanditController(tree, oracle, {
      budget: BUDGET,
      pruneAfter: 2,
      pruneBelow: 0.2,
    }).run();
    return { tree, report };
  }

  it("controller's best-fitness >= uniform's best-fitness", () => {
    const { tree: cTree } = runController();
    const oracle = separableOracle(SEP_QUALITIES, oracleOpts);
    const { tree: uTree } = runUniform(SEP_STRATEGIES, oracle, BUDGET);

    const cBest = cTree.best()?.fitness ?? 0;
    const uBest = uTree.best()?.fitness ?? 0;
    // The controller must never find a WORSE answer than dumb uniform.
    expect(cBest).toBeGreaterThanOrEqual(uBest - 1e-9);
    // And on this separable problem it should actually clear the strong bar.
    expect(cBest).toBeGreaterThan(0.8);
  });

  it("controller's verified-work-per-$ >= 1.2x uniform's (the >=20% claim)", () => {
    const { tree: cTree, report } = runController();
    const oracle = separableOracle(SEP_QUALITIES, oracleOpts);
    const { tree: uTree, spent: uSpent } = runUniform(SEP_STRATEGIES, oracle, BUDGET);

    const cVW = verifiedWork(cTree);
    const uVW = verifiedWork(uTree);
    const cPerDollar = cVW / report.spent;
    const uPerDollar = uVW / uSpent;
    const ratio = cPerDollar / uPerDollar;

    // Surface the measured numbers so the adversary's verdict is data-backed.
    // eslint-disable-next-line no-console
    console.log(
      `[ATTACK 2] controller VW=${cVW.toFixed(3)} spent=${report.spent} -> ${cPerDollar.toFixed(
        4
      )}/$   |   uniform VW=${uVW.toFixed(3)} spent=${uSpent} -> ${uPerDollar.toFixed(
        4
      )}/$   |   RATIO=${ratio.toFixed(3)}x`
    );

    expect(uPerDollar).toBeGreaterThan(0);
    expect(cPerDollar).toBeGreaterThan(0);
    // The falsifiable design claim: >= 20% better verified-work-per-dollar.
    expect(ratio).toBeGreaterThanOrEqual(1.2);
  });
});

// ===========================================================================
// ATTACK 3 — ALLOCATION IS ACTUALLY SKEWED TO GOOD BRANCHES.
// ===========================================================================
describe("ATTACK 3: allocation skews to high-quality roots", () => {
  it("every good root gets strictly more $ than every bad root", () => {
    const tree = new BranchTree(SEP_STRATEGIES);
    const oracle = separableOracle(SEP_QUALITIES, { cost: 1, doneAt: 2, noiseAmp: 0.02 });
    const report = new BanditController(tree, oracle, {
      budget: 120,
      pruneAfter: 2,
      pruneBelow: 0.2,
    }).run();

    const goodSpend = GOOD_ROOTS.map((r) => report.allocations[r] ?? 0);
    const badSpend = BAD_ROOTS.map((r) => report.allocations[r] ?? 0);
    const minGood = Math.min(...goodSpend);
    const maxBad = Math.max(...badSpend);

    // eslint-disable-next-line no-console
    console.log(`[ATTACK 3] good allocations=${JSON.stringify(goodSpend)} bad=${JSON.stringify(badSpend)}`);

    // If the bandit works, the strong lines are funded and the weak ones starved.
    expect(minGood).toBeGreaterThan(maxBad);
    // Sanity: it did explore each root (bad roots carry their pre-prune cost).
    for (const b of badSpend) expect(b).toBeGreaterThan(0);
  });
});

// ===========================================================================
// ATTACK 4 — PRUNING WORKS AND IS HONEST (no cost refund).
// ===========================================================================
describe("ATTACK 4: pruning is real and honest", () => {
  it("weak roots reach state 'pruned', keep their cost, and leave the frontier", () => {
    const tree = new BranchTree(SEP_STRATEGIES);
    const oracle = separableOracle(SEP_QUALITIES, { cost: 1, doneAt: 2, noiseAmp: 0.02 });
    const report = new BanditController(tree, oracle, {
      budget: 120,
      pruneAfter: 2,
      pruneBelow: 0.2,
    }).run();

    // (a) every weak root ends pruned.
    for (const r of BAD_ROOTS) {
      expect(tree.get(r)!.state).toBe("pruned");
    }
    expect(report.pruned).toBeGreaterThanOrEqual(BAD_ROOTS.length);

    // (b) pruning does NOT refund: pruned nodes retain costSpent, and that cost
    // is still inside totalCost / spent. Honest accounting.
    let prunedCost = 0;
    for (const n of tree.all()) if (n.state === "pruned") prunedCost += n.costSpent;
    expect(prunedCost).toBeGreaterThan(0);
    expect(tree.stats().totalCost).toBeCloseTo(report.spent, 9);
    expect(totalNodeCost(tree)).toBeCloseTo(report.spent, 9);

    // (c) no pruned branch sits on the live frontier.
    const frontierIds = new Set(tree.frontier().map((n) => n.id));
    for (const r of BAD_ROOTS) expect(frontierIds.has(r)).toBe(false);
  });
});

// ===========================================================================
// ATTACK 5 — STOP CONDITIONS ARE REAL AND REACHABLE.
// ===========================================================================
describe("ATTACK 5: every stop reason is reachable and correct", () => {
  it("'converged': stops on marginal-gain floor without spending the whole budget", () => {
    // Constant fitness -> gain collapses to 0 once every arm is sampled twice.
    const tree = new BranchTree(["a", "b", "c"]);
    const oracle = separableOracle([0.5, 0.5, 0.5], { cost: 1 }); // no noise, no done
    const report = new BanditController(tree, oracle, {
      budget: 1000, // huge on purpose
      minGainPerDollar: 0.1,
      pruneBelow: 0, // never prune (0.5 > 0 anyway); keep arms alive to test convergence
    }).run();

    expect(report.stoppedReason).toBe("converged");
    expect(report.spent).toBeLessThan(1000); // stopped WELL short of budget
    expect(report.spent).toBeGreaterThan(0);
  });

  it("'budget': a tiny budget stops on affordability", () => {
    const tree = new BranchTree(["a", "b", "c"]);
    const oracle = separableOracle([0.5, 0.5, 0.5], { cost: 1 });
    const report = new BanditController(tree, oracle, { budget: 0.5 }).run();

    expect(report.stoppedReason).toBe("budget");
    expect(report.spent).toBe(0); // couldn't even afford one step
    expect(report.spent).toBeLessThanOrEqual(0.5);
  });

  it("'frontier-empty': draining the frontier is reachable", () => {
    // Oracle marks every branch done on its first touch -> frontier drains.
    const tree = new BranchTree(["a", "b", "c"]);
    const oracle = separableOracle([0.5, 0.5, 0.5], { cost: 1, doneAt: 0 });
    const report = new BanditController(tree, oracle, { budget: 1000 }).run();

    expect(report.stoppedReason).toBe("frontier-empty");
    expect(tree.frontier().length).toBe(0);
  });

  it("'max-steps': the hard iteration cap is reachable", () => {
    const tree = new BranchTree(["a", "b", "c"]);
    const oracle = separableOracle([0.5, 0.5, 0.5], { cost: 1 });
    const report = new BanditController(tree, oracle, { budget: 1000, maxSteps: 3 }).run();

    expect(report.stoppedReason).toBe("max-steps");
    expect(report.steps).toBe(3);
  });
});

// ===========================================================================
// ATTACK 6 — DETERMINISM (same tree+oracle+opts -> identical report).
// ===========================================================================
describe("ATTACK 6: determinism", () => {
  it("two independent runs produce byte-identical reports", () => {
    const opts: ControllerOptions = { budget: 90, pruneAfter: 2, pruneBelow: 0.2 };

    function once() {
      const tree = new BranchTree(SEP_STRATEGIES);
      const oracle = separableOracle(SEP_QUALITIES, { cost: 1, doneAt: 2, noiseAmp: 0.02 });
      return new BanditController(tree, oracle, opts).run();
    }

    const r1 = once();
    const r2 = once();

    expect(r2.best?.id).toBe(r1.best?.id);
    expect(r2.spent).toBe(r1.spent);
    expect(r2.steps).toBe(r1.steps);
    expect(r2.branchesExplored).toBe(r1.branchesExplored);
    expect(r2.pruned).toBe(r1.pruned);
    expect(r2.stoppedReason).toBe(r1.stoppedReason);
    expect(r2.allocations).toEqual(r1.allocations);
  });
});

// ===========================================================================
// ATTACK 7 — TREE ACCOUNTING (the substrate must be honest).
// ===========================================================================
describe("ATTACK 7: tree accounting is honest", () => {
  it("advance ACCUMULATES cost (two advances of 1 -> costSpent 2)", () => {
    const tree = new BranchTree(["only"]);
    tree.advance("b0", { costDelta: 1 });
    tree.advance("b0", { costDelta: 1 });
    expect(tree.get("b0")!.costSpent).toBe(2);
    expect(tree.get("b0")!.steps).toBe(0); // steps only accumulate when provided
    tree.advance("b0", { costDelta: 0.5, steps: 1 });
    expect(tree.get("b0")!.costSpent).toBe(2.5);
    expect(tree.get("b0")!.steps).toBe(1);
  });

  it("advance rejects a negative costDelta (no free money)", () => {
    const tree = new BranchTree(["only"]);
    expect(() => tree.advance("b0", { costDelta: -1 })).toThrow();
  });

  it("prune CASCADES to the whole subtree and removes it from the frontier", () => {
    const tree = new BranchTree(["root"]);
    tree.expand("b0", ["c0", "c1"]); // b0.0, b0.1
    tree.expand("b0.0", ["g0", "g1"]); // b0.0.0, b0.0.1
    // spend on everything so cost is retained through the prune.
    for (const id of ["b0", "b0.0", "b0.1", "b0.0.0", "b0.0.1"]) {
      tree.advance(id, { costDelta: 1 });
    }

    tree.prune("b0.0", "dead-line");

    // the mid node and BOTH grandchildren are pruned; the sibling is not.
    for (const id of ["b0.0", "b0.0.0", "b0.0.1"]) {
      expect(tree.get(id)!.state).toBe("pruned");
    }
    expect(tree.get("b0.1")!.state).not.toBe("pruned");

    // none of the pruned subtree remains on the frontier.
    const frontierIds = new Set(tree.frontier().map((n) => n.id));
    for (const id of ["b0.0", "b0.0.0", "b0.0.1"]) {
      expect(frontierIds.has(id)).toBe(false);
    }
    expect(frontierIds.has("b0.1")).toBe(true);
  });

  it("prune is idempotent (re-pruning a dead line is a no-op, reason not doubled)", () => {
    const tree = new BranchTree(["root"]);
    tree.expand("b0", ["c0"]);
    tree.prune("b0", "reason-x");
    const provLenAfterFirst = tree.get("b0")!.provenance.length;
    tree.prune("b0", "reason-x");
    expect(tree.get("b0")!.provenance.length).toBe(provLenAfterFirst);
  });

  it("totalCost INCLUDES pruned nodes' cost (pruning never refunds)", () => {
    const tree = new BranchTree(["root"]);
    tree.expand("b0", ["c0"]);
    tree.advance("b0", { costDelta: 2 });
    tree.advance("b0.0", { costDelta: 3 });
    const before = tree.stats().totalCost;
    expect(before).toBe(5);
    tree.prune("b0", "dead");
    // cost is unchanged by pruning — honest accounting.
    expect(tree.stats().totalCost).toBe(5);
  });

  it("best() IGNORES pruned nodes even when a pruned node holds the max fitness", () => {
    const tree = new BranchTree(["a", "b"]);
    // b1 becomes the legitimate verified best at 0.5 ...
    tree.markVerified("b1", 0.5);
    // ... while b0 is driven to a HIGHER fitness and then pruned.
    tree.advance("b0", { costDelta: 1, fitness: 0.99 });
    tree.prune("b0", "gamed");
    const best = tree.best();
    expect(best?.id).toBe("b1"); // NOT the 0.99 pruned node
    expect(best?.fitness).toBe(0.5);
  });

  it("expand/advance/verify on pruned|done|missing branches THROW", () => {
    const tree = new BranchTree(["a", "b", "c"]);
    tree.prune("b0", "x");
    tree.complete("b1"); // done

    // pruned
    expect(() => tree.expand("b0", ["z"]))?.toThrow();
    expect(() => tree.advance("b0", { costDelta: 1 })).toThrow();
    expect(() => tree.markVerified("b0", 0.5)).toThrow();
    expect(() => tree.complete("b0")).toThrow();
    // done
    expect(() => tree.expand("b1", ["z"]))?.toThrow();
    expect(() => tree.advance("b1", { costDelta: 1 })).toThrow();
    // missing
    expect(() => tree.advance("bZZ", { costDelta: 1 })).toThrow();
    expect(() => tree.expand("bZZ", ["z"]))?.toThrow();
    expect(() => tree.prune("bZZ", "x")).toThrow();
  });
});
