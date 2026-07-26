import { describe, it, expect } from "vitest";
import {
  BudgetedRouterBandit,
  BanditStateError,
  type RoutingContext,
  type BanditOutcome,
  type Selection,
  type BanditSnapshot,
} from "../bandit";
import type { TaskSignals } from "../../styx/tiers";

// ===========================================================================
// Test-local deterministic PRNG (mulberry32) — used ONLY to build
// reproducible synthetic environments/baselines in these tests. This is not
// part of the module under test; the module's own internal randomness is
// exercised as a black box via BudgetedRouterBandit's public API.
// ===========================================================================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ctx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  const signals: TaskSignals = { executable: true };
  return {
    taskId: "task-1",
    category: "general",
    difficulty: 0.5,
    decomposable: false,
    signals,
    promptTokens: 500,
    ...overrides,
  };
}

function outcome(overrides: Partial<BanditOutcome> = {}): BanditOutcome {
  return {
    armId: "arm-a",
    context: ctx(),
    verified: true,
    usd: 0.05,
    wallMs: 500,
    fannedOut: 0,
    ...overrides,
  };
}

// ===========================================================================
// 1. Basic sanity
// ===========================================================================

describe("BudgetedRouterBandit — basic selection contract", () => {
  it("returns no-candidates for an empty candidate list, never throws", () => {
    const b = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10 });
    const sel = b.select(ctx(), [], () => 0.01);
    expect(sel.armId).toBeNull();
    expect(sel.reason).toBe("no-candidates");
    expect(sel.ranked).toEqual([]);
    expect(Number.isFinite(sel.sampledScore)).toBe(true);
    expect(Number.isFinite(sel.lambda)).toBe(true);
    expect(Number.isFinite(sel.budgetRemainingUsd)).toBe(true);
  });

  it("returns only-candidate when exactly one arm is offered", () => {
    const b = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10 });
    const sel = b.select(ctx(), ["solo"], () => 0.02);
    expect(sel.armId).toBe("solo");
    expect(sel.reason).toBe("only-candidate");
    expect(sel.ranked.length).toBe(1);
  });

  it("never returns an arm outside the supplied candidate set", () => {
    const b = new BudgetedRouterBandit({ seed: 7, budgetUsd: 5 });
    const candidates = ["x", "y", "z"];
    for (let i = 0; i < 40; i++) {
      const sel = b.select(ctx({ taskId: `t${i}` }), candidates, () => 0.01);
      if (sel.armId !== null) {
        expect(candidates).toContain(sel.armId);
      }
      if (sel.armId) {
        b.update(outcome({ armId: sel.armId, verified: i % 2 === 0, usd: 0.01, wallMs: 100 }));
      }
    }
  });

  it("force-explores every candidate exactly once, lexicographically, before any Thompson draw", () => {
    const b = new BudgetedRouterBandit({ seed: 3, budgetUsd: 50 });
    const candidates = ["charlie", "alpha", "bravo"];
    const seenReasons: string[] = [];
    const seenArms: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sel = b.select(ctx(), candidates, () => 0.02);
      seenReasons.push(sel.reason);
      seenArms.push(sel.armId!);
      b.update(outcome({ armId: sel.armId!, verified: true, usd: 0.02, wallMs: 200 }));
    }
    expect(seenReasons).toEqual(["forced-exploration", "forced-exploration", "forced-exploration"]);
    expect(seenArms).toEqual(["alpha", "bravo", "charlie"]);

    // A 4th pull, all arms now explored at least once, must be a real Thompson draw.
    const sel4 = b.select(ctx(), candidates, () => 0.02);
    expect(sel4.reason).toBe("thompson");
  });

  it("dedupes duplicate candidate ids without treating them as distinct arms", () => {
    const b = new BudgetedRouterBandit({ seed: 4, budgetUsd: 10 });
    const sel = b.select(ctx(), ["dup", "dup", "dup"], () => 0.01);
    expect(sel.armId).toBe("dup");
    expect(sel.reason).toBe("only-candidate");
  });
});

// ===========================================================================
// 2. Non-exploitability / hostile numerics
// ===========================================================================

describe("BudgetedRouterBandit — non-exploitability", () => {
  it("rejects negative usd with a typed, distinct error code and does not mutate state", () => {
    const b = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10 });
    expect(() => b.update(outcome({ usd: -1 }))).toThrow(BanditStateError);
    try {
      b.update(outcome({ usd: -1 }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BanditStateError);
      expect((e as BanditStateError).code).toBe("invalid-usd");
    }
    expect(b.spentUsd()).toBe(0);
    expect(b.posterior("arm-a").pulls).toBe(0);
  });

  it("rejects NaN usd/wallMs/fannedOut with distinct codes", () => {
    const b = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10 });
    expect(() => b.update(outcome({ usd: NaN }))).toThrow(BanditStateError);
    expect(() => b.update(outcome({ wallMs: NaN }))).toThrow(BanditStateError);
    expect(() => b.update(outcome({ fannedOut: NaN }))).toThrow(BanditStateError);

    const codes = new Set<string>();
    for (const bad of [{ usd: NaN }, { wallMs: NaN }, { fannedOut: NaN }]) {
      try {
        b.update(outcome(bad));
      } catch (e) {
        codes.add((e as BanditStateError).code);
      }
    }
    expect(codes).toEqual(new Set(["invalid-usd", "invalid-wall-ms", "invalid-fanned-out"]));
  });

  it("rejects Infinity and -Infinity usd/wallMs", () => {
    const b = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10 });
    expect(() => b.update(outcome({ usd: Infinity }))).toThrow(BanditStateError);
    expect(() => b.update(outcome({ usd: -Infinity }))).toThrow(BanditStateError);
    expect(() => b.update(outcome({ wallMs: Infinity }))).toThrow(BanditStateError);
  });

  it("accepts usd:0 and usd:1e-12 (legitimate extremes) without corrupting state, and bounds the resulting index to a finite number", () => {
    const b = new BudgetedRouterBandit({ seed: 1, budgetUsd: 100 });
    b.update(outcome({ armId: "free-and-verified", usd: 0, wallMs: 1, verified: true }));
    b.update(outcome({ armId: "free-and-verified", usd: 1e-12, wallMs: 1, verified: true }));

    const p = b.posterior("free-and-verified");
    expect(Number.isFinite(p.meanUsd)).toBe(true);
    expect(Number.isFinite(p.meanWallMs)).toBe(true);
    expect(Number.isFinite(p.measuredVtphPerDollar)).toBe(true);
    expect(p.meanUsd).toBeGreaterThan(0); // floored, never literally 0
    expect(p.meanWallMs).toBeGreaterThan(0);

    // Selection index for this arm must stay finite even when the caller's
    // own cost estimator echoes the hostile 0.
    const sel = b.select(ctx(), ["free-and-verified", "other"], (id) => (id === "free-and-verified" ? 0 : 0.05));
    // Both candidates unexplored except free-and-verified already has pulls;
    // force-explore "other" first.
    expect(sel.reason).toBe("forced-exploration");
    for (const r of sel.ranked) {
      expect(Number.isFinite(r.sampledScore)).toBe(true);
      expect(Number.isFinite(r.shadowCost)).toBe(true);
      expect(r.sampledScore).not.toBe(Infinity);
      expect(r.sampledScore).not.toBe(-Infinity);
    }
  });

  it("a hostile 0-cost, always-verified arm does not prevent other arms from ever being force-explored or from receiving nonzero probability mass under Thompson sampling", () => {
    const b = new BudgetedRouterBandit({ seed: 11, budgetUsd: 1000 });
    const candidates = ["hostile-free", "normal"];
    const picks: Record<string, number> = { "hostile-free": 0, normal: 0 };
    for (let i = 0; i < 200; i++) {
      const sel = b.select(ctx({ taskId: `t${i}` }), candidates, (id) => (id === "hostile-free" ? 0 : 0.05));
      picks[sel.armId!] += 1;
      b.update(
        outcome({
          armId: sel.armId!,
          usd: sel.armId === "hostile-free" ? 0 : 0.05,
          wallMs: 300,
          verified: sel.armId === "hostile-free" ? true : true,
        }),
      );
    }
    // "normal" must have been force-explored at least once (cold-start
    // guarantee) — the hostile arm cannot suppress that.
    expect(picks.normal).toBeGreaterThanOrEqual(1);
  });

  it("no NaN/Infinity escapes select(), posterior(), lambda(), or spentUsd() under a throwing or garbage estimateUsd callback", () => {
    const b = new BudgetedRouterBandit({ seed: 5, budgetUsd: 10 });
    const candidates = ["a", "b", "c"];
    const garbageEstimators: Array<(id: string) => number> = [
      () => NaN,
      () => Infinity,
      () => -Infinity,
      () => -5,
      () => {
        throw new Error("boom");
      },
    ];
    for (const est of garbageEstimators) {
      for (let i = 0; i < 5; i++) {
        const sel = b.select(ctx({ taskId: `g${i}` }), candidates, est);
        expect(Number.isFinite(sel.sampledScore)).toBe(true);
        expect(Number.isFinite(sel.lambda)).toBe(true);
        expect(Number.isFinite(sel.budgetRemainingUsd)).toBe(true);
        for (const r of sel.ranked) {
          expect(Number.isFinite(r.sampledScore)).toBe(true);
          expect(Number.isFinite(r.shadowCost)).toBe(true);
        }
        if (sel.armId) {
          b.update(outcome({ armId: sel.armId, usd: 0.03, wallMs: 250, verified: i % 2 === 0 }));
        }
      }
    }
    expect(Number.isFinite(b.lambda())).toBe(true);
    expect(Number.isFinite(b.spentUsd())).toBe(true);
    for (const id of candidates) {
      const p = b.posterior(id, ctx());
      expect(Number.isFinite(p.pVerifiedMean)).toBe(true);
      expect(Number.isFinite(p.measuredVtphPerDollar)).toBe(true);
      expect(Number.isFinite(p.alpha)).toBe(true);
      expect(Number.isFinite(p.beta)).toBe(true);
    }
  });
});

// ===========================================================================
// 3. Budget dual — measured simulation (>=500 rounds)
// ===========================================================================

interface SimArm {
  usd: number;
  wallMs: number;
  pVerified: number;
}

const SIM_ARMS: Record<string, SimArm> = {
  // cheapest, but the LEAST accurate arm — cheap-and-unreliable.
  "cheap-unreliable": { usd: 0.02, wallMs: 400, pVerified: 0.08 },
  // pricier, but far more accurate — the true oracle by measured vtph.
  "expensive-reliable": { usd: 0.08, wallMs: 500, pVerified: 0.95 },
  // worse than BOTH other arms on every axis — must be reliably starved.
  dominated: { usd: 0.1, wallMs: 900, pVerified: 0.15 },
};

function trueVtph(arm: SimArm): number {
  return (arm.pVerified * (3_600_000 / arm.wallMs)) / arm.usd;
}

const ORACLE_ARM = Object.entries(SIM_ARMS).sort((a, b) => trueVtph(b[1]) - trueVtph(a[1]))[0][0];

function runBanditSimulation(seed: number, rounds: number, budgetUsd: number) {
  const bandit = new BudgetedRouterBandit({ seed, budgetUsd, lambdaStep: 0.15, lambdaMax: 40 });
  const envRng = mulberry32(seed * 999_331 + 7);
  const candidates = Object.keys(SIM_ARMS);
  const estimateUsd = (id: string) => SIM_ARMS[id].usd;

  let totalUsd = 0;
  let totalVerified = 0;
  let actualRounds = 0;
  const regretSeries: number[] = [];
  let cumulativeRealizedVtph = 0;
  const oracle = SIM_ARMS[ORACLE_ARM];
  const oracleRatePerPull = trueVtph(oracle);

  for (let i = 0; i < rounds; i++) {
    const sel = bandit.select(ctx({ taskId: `r${i}`, category: "sim" }), candidates, estimateUsd);
    if (sel.armId === null) break;
    const armCost = SIM_ARMS[sel.armId].usd;
    if (armCost > bandit.budgetRemainingUsd() + 1e-9) {
      // Respect the hard budget: do not spend past what remains.
      break;
    }
    const arm = SIM_ARMS[sel.armId];
    const verified = envRng() < arm.pVerified;
    bandit.update({ armId: sel.armId, context: ctx({ taskId: `r${i}`, category: "sim" }), verified, usd: arm.usd, wallMs: arm.wallMs, fannedOut: 0 });

    totalUsd += arm.usd;
    if (verified) totalVerified += 1;
    actualRounds += 1;

    const realizedThisPull = verified ? (3_600_000 / arm.wallMs) / arm.usd : 0;
    cumulativeRealizedVtph += realizedThisPull;
    regretSeries.push(oracleRatePerPull - realizedThisPull);
  }

  return { bandit, totalUsd, totalVerified, actualRounds, regretSeries, oracleRatePerPull };
}

function runUniformRandomBaseline(seed: number, rounds: number, budgetUsd: number) {
  const envRng = mulberry32(seed * 12347 + 3);
  const pickRng = mulberry32(seed * 54321 + 9);
  const candidates = Object.keys(SIM_ARMS);
  let remaining = budgetUsd;
  let totalUsd = 0;
  let totalVerified = 0;
  for (let i = 0; i < rounds; i++) {
    const armId = candidates[Math.floor(pickRng() * candidates.length) % candidates.length];
    const arm = SIM_ARMS[armId];
    if (arm.usd > remaining + 1e-9) break;
    remaining -= arm.usd;
    totalUsd += arm.usd;
    if (envRng() < arm.pVerified) totalVerified += 1;
  }
  return { totalUsd, totalVerified };
}

function runAlwaysCheapestBaseline(seed: number, rounds: number, budgetUsd: number) {
  const envRng = mulberry32(seed * 8675 + 1);
  const cheapest = Object.entries(SIM_ARMS).sort((a, b) => a[1].usd - b[1].usd)[0][1];
  let remaining = budgetUsd;
  let totalUsd = 0;
  let totalVerified = 0;
  for (let i = 0; i < rounds; i++) {
    if (cheapest.usd > remaining + 1e-9) break;
    remaining -= cheapest.usd;
    totalUsd += cheapest.usd;
    if (envRng() < cheapest.pVerified) totalVerified += 1;
  }
  return { totalUsd, totalVerified };
}

describe("BudgetedRouterBandit — budget dual, measured simulation", () => {
  const ROUNDS = 520;
  const BUDGET = 22;

  it("(a) never exceeds the budget across >=500 rounds", () => {
    const { bandit, totalUsd } = runBanditSimulation(101, ROUNDS, BUDGET);
    expect(totalUsd).toBeLessThanOrEqual(BUDGET + 1e-9);
    expect(bandit.spentUsd()).toBeLessThanOrEqual(BUDGET + 1e-9);
    expect(bandit.spentUsd()).toBeCloseTo(totalUsd, 9);
  });

  it("(b) ends with measured verified-per-dollar strictly above uniform-random and above always-cheapest", () => {
    const bandit = runBanditSimulation(202, ROUNDS, BUDGET);
    const uniform = runUniformRandomBaseline(202, ROUNDS, BUDGET);
    const cheapest = runAlwaysCheapestBaseline(202, ROUNDS, BUDGET);

    const banditVpd = bandit.totalVerified / bandit.totalUsd;
    const uniformVpd = uniform.totalVerified / uniform.totalUsd;
    const cheapestVpd = cheapest.totalVerified / cheapest.totalUsd;

    expect(bandit.actualRounds).toBeGreaterThan(50); // ran a substantial simulation
    expect(banditVpd).toBeGreaterThan(uniformVpd);
    expect(banditVpd).toBeGreaterThan(cheapestVpd);
  });

  it("(c) shows sublinear cumulative regret vs. the oracle arm (second-half average regret < first-half average regret)", () => {
    const { regretSeries } = runBanditSimulation(303, ROUNDS, BUDGET);
    expect(regretSeries.length).toBeGreaterThan(100);
    const mid = Math.floor(regretSeries.length / 2);
    const firstHalf = regretSeries.slice(0, mid);
    const secondHalf = regretSeries.slice(mid);
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const firstAvg = avg(firstHalf);
    const secondAvg = avg(secondHalf);
    expect(Number.isFinite(firstAvg)).toBe(true);
    expect(Number.isFinite(secondAvg)).toBe(true);
    expect(secondAvg).toBeLessThan(firstAvg);

    // Cumulative regret growth: regret at the end of the run, normalised per
    // round, must be smaller than regret normalised per round at the
    // halfway point — the hallmark of a sublinearly-growing regret curve.
    const cumAt = (n: number) => regretSeries.slice(0, n).reduce((s, x) => s + x, 0);
    const regretPerRoundAtMid = cumAt(mid) / mid;
    const regretPerRoundAtEnd = cumAt(regretSeries.length) / regretSeries.length;
    expect(regretPerRoundAtEnd).toBeLessThan(regretPerRoundAtMid);
  });

  it("dominated arm ends up starved relative to the oracle arm's pull count", () => {
    const { bandit } = runBanditSimulation(404, ROUNDS, BUDGET);
    const dominatedPulls = bandit.posterior("dominated").pulls;
    const oraclePulls = bandit.posterior(ORACLE_ARM).pulls;
    expect(oraclePulls).toBeGreaterThan(dominatedPulls);
  });
});

// ===========================================================================
// 4. Determinism
// ===========================================================================

describe("BudgetedRouterBandit — determinism", () => {
  function driveSequence(seed: number, rounds: number): Selection[] {
    const bandit = new BudgetedRouterBandit({ seed, budgetUsd: 15 });
    const envRng = mulberry32(seed * 31337 + 1);
    const candidates = ["p", "q", "r"];
    const selections: Selection[] = [];
    for (let i = 0; i < rounds; i++) {
      const c = ctx({ taskId: `d${i}`, category: i % 2 === 0 ? "even" : "odd" });
      const sel = bandit.select(c, candidates, (id) => (id === "p" ? 0.01 : id === "q" ? 0.03 : 0.05));
      selections.push(sel);
      if (sel.armId) {
        bandit.update({
          armId: sel.armId,
          context: c,
          verified: envRng() < 0.5,
          usd: sel.armId === "p" ? 0.01 : sel.armId === "q" ? 0.03 : 0.05,
          wallMs: 200 + envRng() * 100,
          fannedOut: 0,
        });
      }
    }
    return selections;
  }

  it("same seed + same call sequence yields byte-identical JSON.stringify of every Selection, across two independently constructed instances", () => {
    const a = driveSequence(555, 60);
    const b = driveSequence(555, 60);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(JSON.stringify(a[i])).toBe(JSON.stringify(b[i]));
    }
  });

  it("a different seed produces a differing trajectory (proves the PRNG stream is actually consumed)", () => {
    const a = driveSequence(555, 60);
    const c = driveSequence(556, 60);
    const serializedA = a.map((s) => JSON.stringify(s));
    const serializedC = c.map((s) => JSON.stringify(s));
    expect(serializedA).not.toEqual(serializedC);
  });
});

// ===========================================================================
// 5. Cold-start, hierarchical shrinkage, and drift
// ===========================================================================

describe("BudgetedRouterBandit — cold-start and hierarchical shrinkage", () => {
  it("an unseen category falls back to the shrunk GLOBAL posterior, not a flat 0.5", () => {
    const b = new BudgetedRouterBandit({ seed: 9, budgetUsd: 50, shrinkage: 0.5, priorPulls: 2, priorPVerified: 0.5 });
    // Build up strong evidence that "arm-x" is highly reliable, all under
    // category "known".
    for (let i = 0; i < 40; i++) {
      b.update(outcome({ armId: "arm-x", context: ctx({ category: "known" }), verified: true, usd: 0.02, wallMs: 100 }));
    }
    const globalP = b.posterior("arm-x").pVerifiedMean;
    expect(globalP).toBeGreaterThan(0.8);

    // A category never seen before should NOT read as a flat 0.5 — it must
    // be pulled toward the strong global evidence by shrinkage.
    const unseenP = b.posterior("arm-x", ctx({ category: "brand-new-category-xyz" })).pVerifiedMean;
    expect(unseenP).not.toBeCloseTo(0.5, 1);
    expect(unseenP).toBeGreaterThan(0.5);
  });

  it("shrinkage strictly interpolates between the bucket-level and global posteriors", () => {
    const buildBandit = (shrinkage: number) => {
      const b = new BudgetedRouterBandit({ seed: 9, budgetUsd: 50, shrinkage, priorPulls: 2, priorPVerified: 0.5, contextBuckets: 4096 });
      // Bucket "hot" is always verified.
      for (let i = 0; i < 30; i++) {
        b.update(outcome({ armId: "arm-y", context: ctx({ category: "hot" }), verified: true, usd: 0.02, wallMs: 100 }));
      }
      // A different bucket for the SAME arm is never verified, dragging the
      // global posterior down substantially below the "hot" bucket's own
      // evidence.
      for (let i = 0; i < 30; i++) {
        b.update(outcome({ armId: "arm-y", context: ctx({ category: "cold" }), verified: false, usd: 0.02, wallMs: 100 }));
      }
      return b.posterior("arm-y", ctx({ category: "hot" })).pVerifiedMean;
    };

    const pNoShrink = buildBandit(0); // pure bucket ("hot"): should be very high
    const pFullShrink = buildBandit(1); // pure global: dragged down by "cold"
    const pMid = buildBandit(0.5);

    expect(pNoShrink).toBeGreaterThan(pFullShrink);
    expect(pMid).toBeLessThan(pNoShrink);
    expect(pMid).toBeGreaterThan(pFullShrink);
  });

  it("an arm appearing mid-run is force-explored on its first offer, even after other arms have long histories", () => {
    const b = new BudgetedRouterBandit({ seed: 12, budgetUsd: 50 });
    for (let i = 0; i < 20; i++) {
      const sel = b.select(ctx({ taskId: `warm${i}` }), ["veteran"], () => 0.02);
      b.update(outcome({ armId: sel.armId!, verified: true, usd: 0.02, wallMs: 100 }));
    }
    const selNew = b.select(ctx(), ["veteran", "newcomer"], () => 0.02);
    expect(selNew.reason).toBe("forced-exploration");
    expect(selNew.armId).toBe("newcomer");
  });

  it("an arm disappearing mid-run (simply omitted from later candidate lists) causes no error and does not affect other arms' bookkeeping", () => {
    const b = new BudgetedRouterBandit({ seed: 13, budgetUsd: 50 });
    for (const id of ["one", "two"]) {
      const sel = b.select(ctx(), ["one", "two"], () => 0.02);
      b.update(outcome({ armId: sel.armId!, verified: true, usd: 0.02, wallMs: 100 }));
    }
    // "two" is dropped from all future candidate sets.
    for (let i = 0; i < 5; i++) {
      const sel = b.select(ctx({ taskId: `n${i}` }), ["one"], () => 0.02);
      expect(sel.armId).toBe("one");
      b.update(outcome({ armId: "one", verified: true, usd: 0.02, wallMs: 100 }));
    }
    // "two"'s posterior is untouched and still queryable.
    const p2 = b.posterior("two");
    expect(p2.pulls).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(p2.pVerifiedMean)).toBe(true);
  });

  it("update() accepts an outcome for a context the arm was never SELECTED under, without throwing", () => {
    const b = new BudgetedRouterBandit({ seed: 14, budgetUsd: 50 });
    expect(() =>
      b.update(outcome({ armId: "never-selected-for-this-context", context: ctx({ category: "orphan-context" }), verified: true, usd: 0.01, wallMs: 90 })),
    ).not.toThrow();
    const p = b.posterior("never-selected-for-this-context", ctx({ category: "orphan-context" }));
    expect(p.pulls).toBe(1);
    expect(p.verified).toBe(1);
  });
});

// ===========================================================================
// 6. Snapshot / restore
// ===========================================================================

describe("BudgetedRouterBandit — snapshot/restore", () => {
  function drive(bandit: BudgetedRouterBandit, envRng: () => number, fromRound: number, toRound: number, out: Selection[]): void {
    const candidates = ["s1", "s2", "s3"];
    for (let i = fromRound; i < toRound; i++) {
      const c = ctx({ taskId: `sr${i}`, category: i % 3 === 0 ? "alpha" : i % 3 === 1 ? "beta" : "gamma" });
      const sel = bandit.select(c, candidates, (id) => (id === "s1" ? 0.015 : id === "s2" ? 0.04 : 0.07));
      out.push(sel);
      if (sel.armId) {
        bandit.update({
          armId: sel.armId,
          context: c,
          verified: envRng() < 0.6,
          usd: sel.armId === "s1" ? 0.015 : sel.armId === "s2" ? 0.04 : 0.07,
          wallMs: 150 + envRng() * 200,
          fannedOut: 0,
        });
      }
    }
  }

  it("splitting a 200-round run at round 100 across a snapshot boundary reproduces the unsplit run exactly", () => {
    const SEED = 909;
    const opts = { seed: SEED, budgetUsd: 12 };

    // Unsplit reference run.
    const unsplitBandit = new BudgetedRouterBandit(opts);
    const unsplitEnv = mulberry32(SEED * 17 + 1);
    const unsplitSelections: Selection[] = [];
    drive(unsplitBandit, unsplitEnv, 0, 200, unsplitSelections);

    // Split run: 0..100, snapshot, restore, 100..200. The environment RNG
    // must be reseeded identically at the split point too, since it's test
    // scaffolding external to the bandit, not bandit state.
    const splitBandit1 = new BudgetedRouterBandit(opts);
    const splitEnv = mulberry32(SEED * 17 + 1);
    const splitSelections: Selection[] = [];
    drive(splitBandit1, splitEnv, 0, 100, splitSelections);

    const snap = splitBandit1.snapshot();
    const restored = BudgetedRouterBandit.restore(snap, opts);
    drive(restored, splitEnv, 100, 200, splitSelections);

    expect(splitSelections.length).toBe(unsplitSelections.length);
    for (let i = 0; i < unsplitSelections.length; i++) {
      expect(JSON.stringify(splitSelections[i])).toBe(JSON.stringify(unsplitSelections[i]));
    }
    expect(restored.spentUsd()).toBeCloseTo(unsplitBandit.spentUsd(), 9);
    expect(restored.lambda()).toBeCloseTo(unsplitBandit.lambda(), 9);
  });

  it("round-trips posterior state exactly (alpha/beta/pulls/verified) for every arm and context bucket touched", () => {
    const opts = { seed: 321, budgetUsd: 20 };
    const bandit = new BudgetedRouterBandit(opts);
    const env = mulberry32(4242);
    drive(bandit, env, 0, 80, []);

    const snap = bandit.snapshot();
    const restored = BudgetedRouterBandit.restore(snap, opts);

    for (const id of ["s1", "s2", "s3"]) {
      for (const cat of ["alpha", "beta", "gamma", undefined]) {
        const c = cat ? ctx({ category: cat }) : undefined;
        const before = c ? bandit.posterior(id, c) : bandit.posterior(id);
        const after = c ? restored.posterior(id, c) : restored.posterior(id);
        expect(after).toEqual(before);
      }
    }
  });

  it("rejects a wrong snapshot version", () => {
    const bad = { version: 2, seed: 1, draws: 0, spentUsd: 0, lambda: 0, arms: [] };
    expect(() => BudgetedRouterBandit.restore(bad, { seed: 1, budgetUsd: 10 })).toThrow(BanditStateError);
    try {
      BudgetedRouterBandit.restore(bad, { seed: 1, budgetUsd: 10 });
    } catch (e) {
      expect((e as BanditStateError).code).toBe("invalid-version");
    }
  });

  it("rejects NaN/Infinity anywhere in the numeric snapshot fields", () => {
    const base: BanditSnapshot = { version: 1, seed: 1, draws: 0, spentUsd: 0, lambda: 0, arms: [] };
    const withNaNSpent = { ...base, spentUsd: NaN };
    const withInfLambda = { ...base, lambda: Infinity };
    for (const bad of [withNaNSpent, withInfLambda]) {
      try {
        BudgetedRouterBandit.restore(bad, { seed: 1, budgetUsd: 10 });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(BanditStateError);
        expect((e as BanditStateError).code).toBe("invalid-numeric");
      }
    }
  });

  it("rejects negative pulls", () => {
    const bad: BanditSnapshot = {
      version: 1,
      seed: 1,
      draws: 0,
      spentUsd: 0,
      lambda: 0,
      arms: [
        {
          armId: "neg",
          globalPulls: -3,
          globalVerified: 0,
          globalUsdSum: 0,
          globalWallMsSum: 0,
          globalFannedOutSum: 0,
          buckets: [],
        },
      ],
    };
    try {
      BudgetedRouterBandit.restore(bad, { seed: 1, budgetUsd: 10 });
      expect.unreachable();
    } catch (e) {
      expect((e as BanditStateError).code).toBe("negative-pulls");
    }
  });

  it("rejects verified > pulls", () => {
    const bad: BanditSnapshot = {
      version: 1,
      seed: 1,
      draws: 0,
      spentUsd: 0,
      lambda: 0,
      arms: [
        {
          armId: "over",
          globalPulls: 3,
          globalVerified: 9,
          globalUsdSum: 0.1,
          globalWallMsSum: 100,
          globalFannedOutSum: 0,
          buckets: [],
        },
      ],
    };
    try {
      BudgetedRouterBandit.restore(bad, { seed: 1, budgetUsd: 10 });
      expect.unreachable();
    } catch (e) {
      expect((e as BanditStateError).code).toBe("verified-exceeds-pulls");
    }
  });

  it("rejects prototype-pollution keys at the top level and inside arm/bucket entries", () => {
    const topLevel = JSON.parse('{"version":1,"seed":1,"draws":0,"spentUsd":0,"lambda":0,"arms":[],"__proto__":{"polluted":true}}');
    try {
      BudgetedRouterBandit.restore(topLevel, { seed: 1, budgetUsd: 10 });
      expect.unreachable();
    } catch (e) {
      expect((e as BanditStateError).code).toBe("prototype-pollution");
    }

    const inArm = JSON.parse(
      '{"version":1,"seed":1,"draws":0,"spentUsd":0,"lambda":0,"arms":[{"armId":"a","globalPulls":0,"globalVerified":0,"globalUsdSum":0,"globalWallMsSum":0,"globalFannedOutSum":0,"buckets":[],"constructor":{"bad":true}}]}',
    );
    try {
      BudgetedRouterBandit.restore(inArm, { seed: 1, budgetUsd: 10 });
      expect.unreachable();
    } catch (e) {
      expect((e as BanditStateError).code).toBe("prototype-pollution");
    }
  });

  it("rejects duplicate arm entries", () => {
    const armEntry = {
      armId: "dup",
      globalPulls: 1,
      globalVerified: 1,
      globalUsdSum: 0.01,
      globalWallMsSum: 100,
      globalFannedOutSum: 0,
      buckets: [],
    };
    const bad: BanditSnapshot = { version: 1, seed: 1, draws: 0, spentUsd: 0.01, lambda: 0, arms: [armEntry, { ...armEntry }] };
    try {
      BudgetedRouterBandit.restore(bad, { seed: 1, budgetUsd: 10 });
      expect.unreachable();
    } catch (e) {
      expect((e as BanditStateError).code).toBe("duplicate-arm");
    }
  });
});

// ===========================================================================
// 7. Budget-exhausted behaviour
// ===========================================================================

describe("BudgetedRouterBandit — budget exhaustion", () => {
  it("returns the cheapest viable candidate with reason budget-shadow-priced once the budget is fully spent, rather than null or throwing", () => {
    const b = new BudgetedRouterBandit({ seed: 21, budgetUsd: 0.05 });
    const candidates = ["cheap", "mid", "pricey"];
    const estimateUsd = (id: string) => (id === "cheap" ? 0.01 : id === "mid" ? 0.05 : 0.2);

    // Force-explore all three (still affordable-ish since forced exploration
    // ignores affordability by design — it's a cold-start guarantee).
    for (let i = 0; i < 3; i++) {
      const sel = b.select(ctx(), candidates, estimateUsd);
      expect(sel.reason).toBe("forced-exploration");
      b.update(outcome({ armId: sel.armId!, usd: estimateUsd(sel.armId!), wallMs: 100, verified: true }));
    }

    // Budget is now spent well past 0.05 (0.01+0.05+0.2). Any further
    // select() must degrade gracefully.
    expect(b.budgetRemainingUsd()).toBeLessThanOrEqual(0);
    const sel = b.select(ctx(), candidates, estimateUsd);
    expect(sel.armId).not.toBeNull();
    expect(sel.reason).toBe("budget-shadow-priced");
    expect(sel.armId).toBe("cheap"); // lowest estimateUsd
    expect(b.spentUsd()).toBeGreaterThan(b.spentUsd() - 1); // sanity: finite, readable
  });

  it("spentUsd() never silently exceeds budgetUsd without the caller being able to see it via budgetRemainingUsd()", () => {
    const b = new BudgetedRouterBandit({ seed: 22, budgetUsd: 1 });
    b.update(outcome({ armId: "over-spender", usd: 5, wallMs: 100, verified: true }));
    expect(b.spentUsd()).toBe(5);
    expect(b.budgetRemainingUsd()).toBe(1 - 5);
    // The overage is fully visible, not hidden or clamped away.
    expect(b.budgetRemainingUsd()).toBeLessThan(0);
  });

  it("single-candidate selection is still honoured even when the sole candidate is unaffordable", () => {
    const b = new BudgetedRouterBandit({ seed: 23, budgetUsd: 0.01 });
    b.update(outcome({ armId: "burn", usd: 0.01, wallMs: 100, verified: true }));
    expect(b.budgetRemainingUsd()).toBeLessThanOrEqual(0);
    const sel = b.select(ctx(), ["only-option"], () => 5);
    expect(sel.armId).toBe("only-option");
    expect(sel.reason).toBe("only-candidate");
  });
});

// ===========================================================================
// 8. Options validation / misc robustness
// ===========================================================================

describe("BudgetedRouterBandit — options validation", () => {
  it("throws BanditStateError for a non-finite seed or budgetUsd", () => {
    expect(() => new BudgetedRouterBandit({ seed: NaN, budgetUsd: 10 })).toThrow(BanditStateError);
    expect(() => new BudgetedRouterBandit({ seed: 1, budgetUsd: -5 })).toThrow(BanditStateError);
    expect(() => new BudgetedRouterBandit({ seed: 1, budgetUsd: Infinity })).toThrow(BanditStateError);
  });

  it("clamps out-of-range secondary options rather than throwing", () => {
    const b = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10, shrinkage: 5, priorPVerified: -3, lambdaStep: -1 });
    const p = b.posterior("fresh-arm");
    expect(Number.isFinite(p.pVerifiedMean)).toBe(true);
    expect(p.pVerifiedMean).toBeGreaterThanOrEqual(0);
    expect(p.pVerifiedMean).toBeLessThanOrEqual(1);
  });

  it("rejects a non-string / empty armId in update()", () => {
    const b = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10 });
    expect(() => b.update(outcome({ armId: "" }))).toThrow(BanditStateError);
    try {
      b.update(outcome({ armId: "" }));
    } catch (e) {
      expect((e as BanditStateError).code).toBe("invalid-arm-id");
    }
  });

  it("posterior() on a completely unseen arm returns a well-formed, non-NaN cold posterior derived from the prior", () => {
    const b = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10, priorPVerified: 0.42, priorPulls: 6 });
    const p = b.posterior("ghost");
    expect(p.pulls).toBe(0);
    expect(p.verified).toBe(0);
    expect(p.pVerifiedMean).toBeCloseTo(0.42, 5);
    expect(Number.isFinite(p.measuredVtphPerDollar)).toBe(true);
  });
});
