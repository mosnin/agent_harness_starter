import { describe, it, expect } from "vitest";
import {
  PerVerifierCalibrator,
  CalibrationError,
  isotonicFit,
  type CalibratorSnapshot,
  type VerifierObservation,
  type ScoredVote,
} from "../calibration";
import { brierDecomposition } from "../../market/reputation";
import { tierConfidenceFloor } from "../../styx/tiers";

// ===========================================================================
// Test-local deterministic PRNG (mulberry32) -- used ONLY to build
// reproducible synthetic datasets in these tests. Not part of the module
// under test.
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

function obs(overrides: Partial<VerifierObservation> = {}): VerifierObservation {
  return {
    verifierId: "v1",
    armId: "arm-a",
    score: 0.5,
    passed: true,
    correct: true,
    at: 0,
    ...overrides,
  };
}

// ===========================================================================
// isotonicFit -- hand-computed fixtures
// ===========================================================================

describe("isotonicFit", () => {
  it("fixture 1: a single violation pools the two offending points to their weighted mean", () => {
    // y-sequence 0, 1, 0 at x=0,1,2 (equal weights): pooling the (1,1) and
    // (2,0) block yields mean y = 0.5 for both.
    const fit = isotonicFit([
      { x: 0, y: 0, w: 1 },
      { x: 1, y: 1, w: 1 },
      { x: 2, y: 0, w: 1 },
    ]);
    expect(fit.knots).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0.5 },
      { x: 2, y: 0.5 },
    ]);
  });

  it("fixture 2: an already-monotone sequence is returned unchanged", () => {
    const fit = isotonicFit([
      { x: 0, y: 0.1, w: 1 },
      { x: 1, y: 0.5, w: 1 },
      { x: 2, y: 0.9, w: 1 },
    ]);
    expect(fit.knots).toEqual([
      { x: 0, y: 0.1 },
      { x: 1, y: 0.5 },
      { x: 2, y: 0.9 },
    ]);
  });

  it("fixture 3: duplicate x values are pooled by weighted mean before PAVA runs", () => {
    // x=0 has two points (y=0,w=1) and (y=1,w=1) -> weighted mean 0.5.
    // x=1 has a single point y=0.5. Already monotone (0.5, 0.5) after pooling.
    const fit = isotonicFit([
      { x: 0, y: 0, w: 1 },
      { x: 0, y: 1, w: 1 },
      { x: 1, y: 0.5, w: 2 },
    ]);
    expect(fit.knots).toEqual([
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
    ]);
  });

  it("fixture 4: an unweighted duplicate-x pool with unequal weights is a true weighted mean", () => {
    // x=0: y=0 with weight 3, y=1 with weight 1 -> weighted mean = 0.25.
    const fit = isotonicFit([
      { x: 0, y: 0, w: 3 },
      { x: 0, y: 1, w: 1 },
      { x: 1, y: 0.9, w: 1 },
    ]);
    expect(fit.knots[0]).toEqual({ x: 0, y: 0.25 });
    expect(fit.knots[1]).toEqual({ x: 1, y: 0.9 });
  });

  it("linearly interpolates between knots", () => {
    const fit = isotonicFit([
      { x: 0, y: 0, w: 1 },
      { x: 10, y: 1, w: 1 },
    ]);
    expect(fit.predict(5)).toBeCloseTo(0.5, 10);
    expect(fit.predict(2.5)).toBeCloseTo(0.25, 10);
  });

  it("clamps outside the knot range to the boundary knot's y", () => {
    const fit = isotonicFit([
      { x: 0.2, y: 0.3, w: 1 },
      { x: 0.8, y: 0.7, w: 1 },
    ]);
    expect(fit.predict(-5)).toBe(0.3);
    expect(fit.predict(5)).toBe(0.7);
    expect(fit.predict(0)).toBe(0.3);
    expect(fit.predict(1)).toBe(0.7);
  });

  it("empty input predicts a neutral 0.5 everywhere and has no knots", () => {
    const fit = isotonicFit([]);
    expect(fit.knots).toEqual([]);
    expect(fit.predict(0.5)).toBe(0.5);
    expect(fit.predict(-3)).toBe(0.5);
  });

  it("rejects non-finite point fields and non-positive weights", () => {
    expect(() => isotonicFit([{ x: NaN, y: 0, w: 1 }])).toThrow(RangeError);
    expect(() => isotonicFit([{ x: 0, y: Infinity, w: 1 }])).toThrow(RangeError);
    expect(() => isotonicFit([{ x: 0, y: 0, w: 0 }])).toThrow(RangeError);
    expect(() => isotonicFit([{ x: 0, y: 0, w: -1 }])).toThrow(RangeError);
  });

  it("property: monotone non-decreasing knots and predictions on 200 seeded random datasets", () => {
    const rand = mulberry32(1337);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rand() * 40);
      const points: { x: number; y: number; w: number }[] = [];
      for (let i = 0; i < n; i++) {
        // Bias toward duplicate x's roughly 1/3 of the time to exercise tie pooling.
        const x = rand() < 0.33 && points.length > 0 ? points[Math.floor(rand() * points.length)].x : Math.round(rand() * 1000) / 1000;
        const y = Math.round(rand() * 1000) / 1000;
        const w = 0.01 + rand() * 5;
        points.push({ x, y, w });
      }

      const fit = isotonicFit(points);

      // Knots strictly increasing in x (deduplicated) and non-decreasing in y.
      for (let i = 1; i < fit.knots.length; i++) {
        expect(fit.knots[i].x).toBeGreaterThan(fit.knots[i - 1].x);
        expect(fit.knots[i].y).toBeGreaterThanOrEqual(fit.knots[i - 1].y - 1e-9);
      }

      // predict() at each knot's own x returns exactly that knot's y.
      for (const k of fit.knots) {
        expect(fit.predict(k.x)).toBeCloseTo(k.y, 9);
      }

      // predict() is non-decreasing when sampled across (and beyond) the domain.
      const samples: number[] = [];
      for (let i = 0; i <= 20; i++) samples.push(-0.5 + (2 / 20) * i);
      let prev = -Infinity;
      for (const xx of samples) {
        const yy = fit.predict(xx);
        expect(yy).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(yy).toBeGreaterThanOrEqual(0);
        expect(yy).toBeLessThanOrEqual(1);
        prev = yy;
      }
    }
  });
});

// ===========================================================================
// PerVerifierCalibrator -- hierarchy
// ===========================================================================

describe("PerVerifierCalibrator hierarchy", () => {
  it("calibrate() before any fit() returns the tier prior with a warning, never throws or stales", () => {
    const c = new PerVerifierCalibrator({ table: { v1: { tier: "T2-genrm", prior: 0.7 } } });
    c.observe(obs({ score: 0.9, correct: true }));
    const cs = c.calibrate("v1", "arm-a", 0.5);
    expect(cs.source).toBe("tier-prior");
    expect(cs.pCorrect).toBe(0.7);
    expect(cs.informative).toBe(false);
    expect(cs.warnings.some((w) => /not been fit/i.test(w))).toBe(true);
  });

  it("uses (verifier,arm) once n >= minSamplesArm and the signal is informative", () => {
    const c = new PerVerifierCalibrator({
      table: { v1: { tier: "T1-reference", prior: 0.6 } },
      minSamplesArm: 6,
      minSamplesVerifier: 100,
      shrinkage: 1, // small pseudo-count so the arm-level fit dominates quickly
    });
    // A clean, strongly discriminating verifier: score >= 0.5 -> correct, else incorrect.
    for (let i = 0; i < 30; i++) {
      c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.9, passed: true, correct: true, at: i }));
      c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.1, passed: false, correct: false, at: i }));
    }
    c.fit(1000);
    const cs = c.calibrate("v1", "arm-a", 0.9);
    expect(cs.source).toBe("verifier+arm");
    expect(cs.n).toBe(60);
    expect(cs.informative).toBe(true);
    expect(cs.pCorrect).toBeGreaterThan(0.8);

    const csLow = c.calibrate("v1", "arm-a", 0.1);
    expect(csLow.pCorrect).toBeLessThan(0.2);
  });

  it("falls back to (verifier) pooled across arms when the specific arm is under minSamplesArm", () => {
    const c = new PerVerifierCalibrator({
      table: { v1: { tier: "T1-reference", prior: 0.6 } },
      minSamplesArm: 50,
      minSamplesVerifier: 10,
      shrinkage: 1,
    });
    // arm-b has plenty of data and genuinely discriminates (not degenerate:
    // both passed/correct vary); arm-a (the one we'll query) has only 2 points.
    for (let i = 0; i < 20; i++) {
      const correct = i % 2 === 0;
      c.observe(obs({ verifierId: "v1", armId: "arm-b", score: correct ? 0.9 : 0.1, passed: correct, correct, at: i }));
    }
    c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.9, passed: true, correct: true, at: 0 }));
    c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.9, passed: true, correct: true, at: 1 }));
    c.fit(1000);

    const cs = c.calibrate("v1", "arm-a", 0.9);
    expect(cs.source).toBe("verifier");
    expect(cs.n).toBe(22);
    expect(cs.pCorrect).toBeGreaterThan(0.6);
  });

  it("falls back to the tier prior when neither level has enough samples", () => {
    const c = new PerVerifierCalibrator({ table: { v1: { tier: "T3-agreement", prior: 0.42 } }, minSamplesArm: 10, minSamplesVerifier: 10 });
    c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.9, correct: true }));
    c.fit(1000);
    const cs = c.calibrate("v1", "arm-a", 0.9);
    expect(cs.source).toBe("tier-prior");
    expect(cs.pCorrect).toBe(0.42);
    expect(cs.tier).toBe("T3-agreement");
  });

  it("falls back to 0.5 for a verifier entirely absent from the table", () => {
    const c = new PerVerifierCalibrator({ table: {} });
    c.fit(0);
    const cs = c.calibrate("unknown-verifier", "arm-a", 0.9);
    expect(cs.source).toBe("tier-prior");
    expect(cs.pCorrect).toBe(0.5);
    expect(cs.tier).toBe("T4-consistency");
  });

  it("uses the REAL calibrationTable() by default (no injected table)", () => {
    const c = new PerVerifierCalibrator();
    c.fit(0);
    const cs = c.calibrate("verify.file_ops", "arm-x", 0.5);
    // verify.file_ops's real shipped prior is 0.65 at T4-consistency.
    expect(cs.pCorrect).toBe(0.65);
    expect(cs.tier).toBe("T4-consistency");
  });

  it("never reports source verifier+arm below minSamplesArm, even with n = minSamplesArm - 1", () => {
    const c = new PerVerifierCalibrator({ minSamplesArm: 10, minSamplesVerifier: 10 });
    for (let i = 0; i < 9; i++) {
      c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.9, correct: true, at: i }));
    }
    c.fit(1000);
    const cs = c.calibrate("v1", "arm-a", 0.9);
    expect(cs.source).not.toBe("verifier+arm");
  });

  it("annotates warnings with the REAL tierConfidenceFloor when pCorrect falls short of it", () => {
    const c = new PerVerifierCalibrator({ table: { v1: { tier: "T4-consistency", prior: 0.3 } } });
    c.fit(0);
    const cs = c.calibrate("v1", "arm-a", 0.5);
    const floor = tierConfidenceFloor("T4-consistency", 0.1);
    expect(cs.pCorrect).toBeLessThan(floor);
    expect(cs.warnings.some((w) => w.includes(floor.toFixed(4)))).toBe(true);
  });
});

// ===========================================================================
// Adversarial verifier detection
// ===========================================================================

describe("adversarial verifier detection", () => {
  it("flags an always-pass verifier as uninformative, weights it ~zero, and drops it", () => {
    const c = new PerVerifierCalibrator({
      table: { good: { tier: "T2-genrm", prior: 0.5 }, bad: { tier: "T2-genrm", prior: 0.5 } },
      minSamplesArm: 5,
      minSamplesVerifier: 5,
    });
    for (let i = 0; i < 20; i++) {
      const correct = i % 2 === 0;
      // "bad" always claims pass regardless of ground truth.
      c.observe(obs({ verifierId: "bad", armId: "arm-a", score: 0.9, passed: true, correct, at: i }));
      // "good" discriminates cleanly.
      c.observe(obs({ verifierId: "good", armId: "arm-a", score: correct ? 0.9 : 0.1, passed: correct, correct, at: i }));
    }
    c.fit(1000);

    const badQ = c.quality("bad", "arm-a")!;
    expect(badQ.informative).toBe(false);
    expect(badQ.positiveRate).toBe(1);

    const csBad = c.calibrate("bad", "arm-a", 0.9);
    expect(csBad.source).toBe("uninformative");
    expect(csBad.pCorrect).toBe(0.5); // bounded by (equal to) the tier prior
    expect(csBad.informative).toBe(false);

    const votes: ScoredVote[] = [
      { verifierId: "bad", passed: true, score: 0.9 },
      { verifierId: "good", passed: true, score: 0.9 },
    ];
    const ens = c.ensembleProbability("arm-a", votes);
    expect(ens.droppedVerifiers).toContain("bad");
    expect(ens.usedVerifiers).toContain("good");
    expect(ens.weights.bad).toBeLessThanOrEqual(1e-9);
  });

  it("flags an always-fail verifier as uninformative the same way", () => {
    const c = new PerVerifierCalibrator({ table: { bad: { tier: "T2-genrm", prior: 0.5 } }, minSamplesArm: 5 });
    for (let i = 0; i < 10; i++) {
      c.observe(obs({ verifierId: "bad", armId: "arm-a", score: 0.1, passed: false, correct: i % 2 === 0, at: i }));
    }
    c.fit(1000);
    expect(c.quality("bad", "arm-a")!.positiveRate).toBe(0);
    expect(c.quality("bad", "arm-a")!.informative).toBe(false);
  });

  it("flags an anti-correlated verifier, degrades it to the tier prior, and never inverts it into confidence", () => {
    const c = new PerVerifierCalibrator({ table: { evil: { tier: "T2-genrm", prior: 0.5 } }, minSamplesArm: 5, minSamplesVerifier: 5 });
    // High score -> wrong; low score -> right. A naive "just trust the score"
    // reading would call a 0.95 score very confident.
    for (let i = 0; i < 20; i++) {
      const highScore = i % 2 === 0;
      c.observe(obs({ verifierId: "evil", armId: "arm-a", score: highScore ? 0.95 : 0.05, passed: highScore, correct: !highScore, at: i }));
    }
    c.fit(1000);

    const q = c.quality("evil", "arm-a")!;
    expect(q.antiCorrelated).toBe(true);
    expect(q.informative).toBe(false);
    expect(q.auc).toBeLessThan(0.4);

    const cs = c.calibrate("evil", "arm-a", 0.95);
    expect(cs.source).toBe("uninformative");
    // Bounded by the prior -- NOT inverted into near-certainty.
    expect(cs.pCorrect).toBeLessThanOrEqual(0.5);
    expect(cs.pCorrect).toBe(0.5);

    const ens = c.ensembleProbability("arm-a", [{ verifierId: "evil", passed: true, score: 0.95 }]);
    expect(ens.droppedVerifiers).toContain("evil");
  });
});

// ===========================================================================
// Small-sample honesty / shrinkage
// ===========================================================================

describe("small-sample honesty and shrinkage", () => {
  it("shrinkage strictly interpolates toward the raw estimate as n grows", () => {
    const table = { v1: { tier: "T2-genrm" as const, prior: 0.5 } };
    const results: number[] = [];
    for (const n of [1, 3, 10, 60]) {
      const c = new PerVerifierCalibrator({ table, minSamplesArm: 1, minSamplesVerifier: 1000, shrinkage: 5 });
      // n copies of a high, correct score, plus two fixed low/incorrect
      // anchor points so `passed` genuinely varies (not degenerate) without
      // materially perturbing the isotonic curve's value at x=0.95.
      c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.05, passed: false, correct: false, at: -1 }));
      c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.05, passed: false, correct: false, at: -2 }));
      for (let i = 0; i < n; i++) {
        c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.95, passed: true, correct: true, at: i }));
      }
      c.fit(1000);
      const cs = c.calibrate("v1", "arm-a", 0.95);
      expect(cs.source).toBe("verifier+arm");
      results.push(cs.pCorrect);
    }
    // Strictly increasing toward 1 (the raw isotonic value) as n grows, since
    // the parent (tier prior 0.5) is below the raw estimate (~1).
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThan(results[i - 1]);
    }
    expect(results[results.length - 1]).toBeGreaterThan(0.85);
  });

  it("bounds a single observation's pull on pCorrect by 1/(1+shrinkage)", () => {
    const shrinkage = 5;
    const table = { v1: { tier: "T2-genrm" as const, prior: 0.5 } };
    const c = new PerVerifierCalibrator({ table, minSamplesArm: 1, minSamplesVerifier: 1000, shrinkage });
    c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.99, passed: true, correct: true, at: 0 }));
    c.fit(1000);
    const cs = c.calibrate("v1", "arm-a", 0.99);
    expect(cs.source).toBe("verifier+arm");
    const bound = 1 / (1 + shrinkage);
    expect(Math.abs(cs.pCorrect - 0.5)).toBeLessThanOrEqual(bound + 1e-9);
    // And it does move at least a little (strict interpolation, not a no-op).
    expect(cs.pCorrect).toBeGreaterThan(0.5);
  });
});

// ===========================================================================
// Metrics: ECE / AUC / Brier
// ===========================================================================

describe("metrics", () => {
  it("cross-checks the real brierDecomposition: reliability + resolution - uncertainty == brier, and matches an independent recomputation", () => {
    const c = new PerVerifierCalibrator({ minSamplesArm: 5 });
    const points: { score: number; correct: boolean }[] = [
      { score: 0.9, correct: true },
      { score: 0.9, correct: true },
      { score: 0.9, correct: false },
      { score: 0.2, correct: false },
      { score: 0.2, correct: false },
      { score: 0.2, correct: true },
      { score: 0.5, correct: true },
      { score: 0.5, correct: false },
    ];
    points.forEach((p, i) => c.observe(obs({ verifierId: "v1", armId: "arm-a", score: p.score, passed: p.score >= 0.5, correct: p.correct, at: i })));
    c.fit(1000);
    const q = c.quality("v1", "arm-a")!;

    // Murphy decomposition identity: brier = reliability - resolution + uncertainty.
    expect(q.brier.reliability - q.brier.resolution + q.brier.uncertainty).toBeCloseTo(q.brier.brier, 9);

    // Independent recomputation of the raw (undecayed weight, halfLifeMs=Infinity) Brier score.
    const direct = brierDecomposition(
      points.map((p) => ({ p: p.score, outcome: (p.correct ? 1 : 0) as 0 | 1 })),
      10,
    );
    expect(q.brier.brier).toBeCloseTo(direct.brier, 9);
    expect(q.brier.reliability).toBeCloseTo(direct.reliability, 9);
  });

  it("computes AUC = 1 for a perfectly discriminating verifier and ~0.5 for a random one", () => {
    const c = new PerVerifierCalibrator({ minSamplesArm: 4 });
    for (let i = 0; i < 10; i++) {
      c.observe(obs({ verifierId: "perfect", armId: "arm-a", score: 0.9, passed: true, correct: true, at: i }));
      c.observe(obs({ verifierId: "perfect", armId: "arm-a", score: 0.1, passed: false, correct: false, at: i + 100 }));
    }
    // Random: score alternates but bears no relation to correctness.
    for (let i = 0; i < 10; i++) {
      c.observe(obs({ verifierId: "random", armId: "arm-a", score: i % 2 === 0 ? 0.9 : 0.1, passed: true, correct: i % 3 === 0, at: i }));
    }
    c.fit(1000);
    expect(c.quality("perfect", "arm-a")!.auc).toBe(1);
  });

  it("ECE reflects a genuinely miscalibrated verifier (confident but wrong) as a large gap", () => {
    const c = new PerVerifierCalibrator({ minSamplesArm: 4, eceBins: 10 });
    for (let i = 0; i < 20; i++) {
      // Always claims score=0.95 ("very confident") but is right only half the time.
      c.observe(obs({ verifierId: "overconfident", armId: "arm-a", score: 0.95, passed: true, correct: i % 2 === 0, at: i }));
    }
    c.fit(1000);
    const q = c.quality("overconfident", "arm-a")!;
    expect(q.ece).toBeGreaterThan(0.3);
  });
});

// ===========================================================================
// Recency decay
// ===========================================================================

describe("recency decay", () => {
  it("a verifier that regressed after a distribution shift loses calibration weight and pCorrect falls", () => {
    const buildAndCalibrate = (halfLifeMs: number): number => {
      const c = new PerVerifierCalibrator({
        table: { v1: { tier: "T2-genrm", prior: 0.5 } },
        minSamplesArm: 5,
        minSamplesVerifier: 1000,
        shrinkage: 0.001, // near-pure raw fit so decay's effect is visible
        halfLifeMs,
      });
      // A handful of unambiguous low-score/incorrect anchor points in both
      // regimes so `passed` genuinely varies (not the degenerate always-pass
      // case) without perturbing the isotonic curve's value at x=0.9.
      for (let i = 0; i < 5; i++) {
        c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.1, passed: false, correct: false, at: i }));
        c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.1, passed: false, correct: false, at: 1000 + i }));
      }
      // Old regime (t=5..34): score=0.9 reliably means correct.
      for (let i = 0; i < 30; i++) {
        c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.9, passed: true, correct: true, at: 5 + i }));
      }
      // Regression (t=1005..1034, right before `now`): score=0.9 now means incorrect.
      for (let i = 0; i < 30; i++) {
        c.observe(obs({ verifierId: "v1", armId: "arm-a", score: 0.9, passed: true, correct: false, at: 1005 + i }));
      }
      c.fit(1035);
      return c.calibrate("v1", "arm-a", 0.9).pCorrect;
    };

    const withoutDecay = buildAndCalibrate(Infinity);
    const withDecay = buildAndCalibrate(50); // half-life far shorter than the 1000-tick gap

    // Without decay the two regimes average out toward ~0.5. With a short
    // half-life, the recent (bad) regime dominates and pCorrect falls below it.
    expect(withDecay).toBeLessThan(withoutDecay);
  });
});

// ===========================================================================
// fit() idempotency
// ===========================================================================

describe("fit() idempotency", () => {
  it("calling fit() twice with the same now produces identical fits and quality", () => {
    const c = new PerVerifierCalibrator({ minSamplesArm: 3 });
    for (let i = 0; i < 10; i++) {
      c.observe(obs({ verifierId: "v1", armId: "arm-a", score: i / 10, correct: i % 2 === 0, at: i }));
    }
    c.fit(500);
    const report1 = JSON.stringify(c.report());
    const cal1 = JSON.stringify(c.calibrate("v1", "arm-a", 0.5));
    c.fit(500);
    const report2 = JSON.stringify(c.report());
    const cal2 = JSON.stringify(c.calibrate("v1", "arm-a", 0.5));
    expect(report1).toBe(report2);
    expect(cal1).toBe(cal2);
  });
});

// ===========================================================================
// Determinism across insertion order
// ===========================================================================

describe("determinism", () => {
  it("identical observation multisets in different insertion orders produce identical fits and report() ordering", () => {
    const rand = mulberry32(99);
    const all: VerifierObservation[] = [];
    const verifiers = ["alpha", "beta", "gamma"];
    const arms = ["arm-1", "arm-2"];
    for (let i = 0; i < 60; i++) {
      const v = verifiers[Math.floor(rand() * verifiers.length)];
      const a = arms[Math.floor(rand() * arms.length)];
      const correct = rand() < 0.6;
      all.push(obs({ verifierId: v, armId: a, score: Math.round(rand() * 100) / 100, passed: rand() < 0.6, correct, at: i }));
    }

    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const c1 = new PerVerifierCalibrator({ minSamplesArm: 3, minSamplesVerifier: 5 });
    const c2 = new PerVerifierCalibrator({ minSamplesArm: 3, minSamplesVerifier: 5 });
    for (const o of all) c1.observe(o);
    for (const o of shuffled) c2.observe(o);
    c1.fit(1000);
    c2.fit(1000);

    expect(JSON.stringify(c1.report())).toBe(JSON.stringify(c2.report()));
    for (const v of verifiers) {
      for (const a of arms) {
        expect(JSON.stringify(c1.calibrate(v, a, 0.5))).toBe(JSON.stringify(c2.calibrate(v, a, 0.5)));
      }
    }
  });
});

// ===========================================================================
// No NaN/Infinity escapes
// ===========================================================================

describe("robustness against hostile scores", () => {
  it("clamps NaN/Infinity/out-of-range scores in calibrate() and always returns pCorrect in [0,1]", () => {
    const c = new PerVerifierCalibrator({ table: { v1: { tier: "T2-genrm", prior: 0.6 } } });
    for (let i = 0; i < 10; i++) c.observe(obs({ verifierId: "v1", armId: "arm-a", score: i / 10, correct: i % 2 === 0, at: i }));
    c.fit(100);
    for (const bad of [NaN, Infinity, -Infinity, -5, 1e10]) {
      const cs = c.calibrate("v1", "arm-a", bad);
      expect(Number.isFinite(cs.pCorrect)).toBe(true);
      expect(cs.pCorrect).toBeGreaterThanOrEqual(0);
      expect(cs.pCorrect).toBeLessThanOrEqual(1);
      expect(cs.warnings.length).toBeGreaterThan(0);
    }
  });

  it("observe() rejects non-finite / out-of-range scores instead of silently absorbing them", () => {
    const c = new PerVerifierCalibrator();
    expect(() => c.observe(obs({ score: NaN }))).toThrow(CalibrationError);
    expect(() => c.observe(obs({ score: 1.5 }))).toThrow(CalibrationError);
    expect(() => c.observe(obs({ score: -0.1 }))).toThrow(CalibrationError);
    try {
      c.observe(obs({ score: NaN }));
      expect.unreachable();
    } catch (e) {
      expect((e as CalibrationError).code).toBe("invalid-score");
    }
  });
});

// ===========================================================================
// ensembleProbability
// ===========================================================================

describe("ensembleProbability", () => {
  it("falls back to the real label-free WeakVerifierEnsemble when the arm has never been labelled", () => {
    const c = new PerVerifierCalibrator();
    c.fit(0);
    const votes: ScoredVote[] = [
      { verifierId: "a", passed: true, score: 0.9 },
      { verifierId: "b", passed: true, score: 0.8 },
      { verifierId: "c", passed: false, score: 0.2 },
    ];
    const result = c.ensembleProbability("never-seen-arm", votes);
    expect(result.source).toBe("label-free-ensemble");
    expect(result.pCorrect).toBeGreaterThanOrEqual(0);
    expect(result.pCorrect).toBeLessThanOrEqual(1);
    expect(Object.keys(result.weights).sort()).toEqual(["a", "b", "c"]);
  });

  it("uses the calibrated path once the arm has labelled history, weighting good verifiers over dropped ones", () => {
    const c = new PerVerifierCalibrator({
      table: { good: { tier: "T2-genrm", prior: 0.5 }, bad: { tier: "T2-genrm", prior: 0.5 } },
      minSamplesArm: 5,
    });
    for (let i = 0; i < 20; i++) {
      const correct = i % 2 === 0;
      c.observe(obs({ verifierId: "good", armId: "arm-a", score: correct ? 0.95 : 0.05, passed: correct, correct, at: i }));
      c.observe(obs({ verifierId: "bad", armId: "arm-a", score: 0.9, passed: true, correct, at: i })); // always-pass
    }
    c.fit(1000);
    const result = c.ensembleProbability("arm-a", [
      { verifierId: "good", passed: true, score: 0.95 },
      { verifierId: "bad", passed: true, score: 0.9 },
    ]);
    expect(result.source).toBe("calibrated");
    expect(result.usedVerifiers).toEqual(["good"]);
    expect(result.droppedVerifiers).toEqual(["bad"]);
    expect(result.pCorrect).toBeGreaterThan(0.7);
  });

  it("handles an empty vote list without throwing", () => {
    const c = new PerVerifierCalibrator();
    c.fit(0);
    const result = c.ensembleProbability("arm-a", []);
    expect(result.pCorrect).toBe(0.5);
    expect(result.usedVerifiers).toEqual([]);
  });
});

// ===========================================================================
// Snapshot / restore
// ===========================================================================

describe("snapshot/restore", () => {
  function buildFittedCalibrator(): PerVerifierCalibrator {
    const c = new PerVerifierCalibrator({ table: { v1: { tier: "T2-genrm", prior: 0.5 } }, minSamplesArm: 4 });
    for (let i = 0; i < 10; i++) {
      c.observe(obs({ verifierId: "v1", armId: "arm-a", score: i / 10, passed: i >= 5, correct: i >= 5, at: i }));
    }
    c.fit(1000);
    return c;
  }

  it("round-trips: restore(snapshot()) reproduces identical calibrate()/report() output", () => {
    const c1 = buildFittedCalibrator();
    const snap = c1.snapshot();
    const c2 = PerVerifierCalibrator.restore(snap, { table: { v1: { tier: "T2-genrm", prior: 0.5 } }, minSamplesArm: 4 });
    expect(JSON.stringify(c2.report())).toBe(JSON.stringify(c1.report()));
    expect(JSON.stringify(c2.calibrate("v1", "arm-a", 0.7))).toBe(JSON.stringify(c1.calibrate("v1", "arm-a", 0.7)));
  });

  it("rejects a wrong version", () => {
    const snap = buildFittedCalibrator().snapshot();
    const bad = { ...snap, version: 2 } as unknown;
    expect(() => PerVerifierCalibrator.restore(bad)).toThrow(CalibrationError);
    try {
      PerVerifierCalibrator.restore(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as CalibrationError).code).toBe("unsupported-version");
    }
  });

  it("rejects NaN/Infinity scores in observations", () => {
    const snap = buildFittedCalibrator().snapshot();
    const bad: CalibratorSnapshot = { ...snap, observations: [{ ...snap.observations[0], score: NaN }] };
    expect(() => PerVerifierCalibrator.restore(bad)).toThrow(CalibrationError);
    try {
      PerVerifierCalibrator.restore(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as CalibrationError).code).toBe("invalid-score");
    }
  });

  it("rejects scores outside [0,1]", () => {
    const snap = buildFittedCalibrator().snapshot();
    const bad: CalibratorSnapshot = { ...snap, observations: [{ ...snap.observations[0], score: 5 }] };
    try {
      PerVerifierCalibrator.restore(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as CalibrationError).code).toBe("score-out-of-range");
    }
  });

  it("rejects non-monotone injected knots in the fits array", () => {
    const snap = buildFittedCalibrator().snapshot();
    const bad: CalibratorSnapshot = {
      ...snap,
      fits: [
        {
          id: "v1",
          armId: null,
          knots: [
            { x: 0, y: 0.9 },
            { x: 0.5, y: 0.1 }, // decreasing y -- non-monotone
          ],
        },
        ...snap.fits.filter((f) => !(f.id === "v1" && f.armId === null)),
      ],
    };
    try {
      PerVerifierCalibrator.restore(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as CalibrationError).code).toBe("non-monotone-knots");
    }
  });

  it("rejects prototype-pollution-shaped verifier ids", () => {
    const snap = buildFittedCalibrator().snapshot();
    const bad: CalibratorSnapshot = { ...snap, observations: [{ ...snap.observations[0], verifierId: "__proto__" }] };
    try {
      PerVerifierCalibrator.restore(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as CalibrationError).code).toBe("unsafe-key");
    }
  });

  it("rejects duplicate verifier/arm ids in the fits array", () => {
    const snap = buildFittedCalibrator().snapshot();
    const dupe = snap.fits.find((f) => f.id === "v1" && f.armId === "arm-a")!;
    const bad: CalibratorSnapshot = { ...snap, fits: [...snap.fits, { ...dupe }] };
    try {
      PerVerifierCalibrator.restore(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as CalibrationError).code).toBe("duplicate-verifier-id");
    }
  });

  it("rejects a malformed (non-object) snapshot", () => {
    try {
      PerVerifierCalibrator.restore("not-a-snapshot");
      expect.unreachable();
    } catch (e) {
      expect((e as CalibrationError).code).toBe("malformed-snapshot");
    }
    try {
      PerVerifierCalibrator.restore({ version: 1 });
      expect.unreachable();
    } catch (e) {
      expect((e as CalibrationError).code).toBe("malformed-snapshot");
    }
  });

  it("never trusts injected knots for actual state -- restore always recomputes via fit()", () => {
    const c1 = buildFittedCalibrator();
    const snap = c1.snapshot();
    // Tamper with a (still valid, monotone) knot value; restore must ignore
    // it and recompute from the replayed observations instead.
    const tampered: CalibratorSnapshot = {
      ...snap,
      fits: snap.fits.map((f) => (f.id === "v1" && f.armId === "arm-a" ? { ...f, knots: f.knots.map((k) => ({ x: k.x, y: 0.5 })) } : f)),
    };
    const c2 = PerVerifierCalibrator.restore(tampered, { table: { v1: { tier: "T2-genrm", prior: 0.5 } }, minSamplesArm: 4 });
    expect(c2.calibrate("v1", "arm-a", 0.9).pCorrect).toBe(c1.calibrate("v1", "arm-a", 0.9).pCorrect);
  });
});

// ===========================================================================
// CalibratorOptions validation
// ===========================================================================

describe("options validation", () => {
  it("rejects invalid constructor options with CalibrationError", () => {
    expect(() => new PerVerifierCalibrator({ minSamplesArm: 0 })).toThrow(CalibrationError);
    expect(() => new PerVerifierCalibrator({ minSamplesVerifier: -1 })).toThrow(CalibrationError);
    expect(() => new PerVerifierCalibrator({ eceBins: 0 })).toThrow(CalibrationError);
    expect(() => new PerVerifierCalibrator({ halfLifeMs: 0 })).toThrow(CalibrationError);
    expect(() => new PerVerifierCalibrator({ halfLifeMs: -5 })).toThrow(CalibrationError);
    expect(() => new PerVerifierCalibrator({ shrinkage: -1 })).toThrow(CalibrationError);
  });

  it("rejects observe() with an unsafe key", () => {
    const c = new PerVerifierCalibrator();
    try {
      c.observe(obs({ verifierId: "__proto__" }));
      expect.unreachable();
    } catch (e) {
      expect((e as CalibrationError).code).toBe("unsafe-key");
    }
  });
});
