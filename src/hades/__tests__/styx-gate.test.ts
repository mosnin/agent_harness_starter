import { describe, expect, it } from "vitest";
import {
  type CalibrationPoint,
  ConformalGate,
  conformalThreshold,
} from "../styx/gate";

/** Deterministic hash → [0, 1). No Math.random anywhere in this file. */
function hash01(i: number, salt: number): number {
  let x = (Math.imul(i, 0x9e3779b1) + Math.imul(salt, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x045d9f3b) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x045d9f3b) >>> 0;
  x ^= x >>> 16;
  return x / 2 ** 32;
}

/** scores 1..10, wrong at 1,2,3, correct at 4..10 */
const handSet: CalibrationPoint[] = Array.from({ length: 10 }, (_, k) => ({
  score: k + 1,
  correct: k + 1 >= 4,
}));

describe("conformalThreshold (pure helper)", () => {
  it("matches the hand-computed tau under the (+1)/(+1) rule", () => {
    // epsilon = 0.2, candidates ascending:
    //   t=1: S=10, wrong=3 -> 4/11 ≈ 0.364 > 0.2
    //   t=2: S=9,  wrong=2 -> 3/10 = 0.300 > 0.2
    //   t=3: S=8,  wrong=1 -> 2/9  ≈ 0.222 > 0.2
    //   t=4: S=7,  wrong=0 -> 1/8  = 0.125 <= 0.2  ← smallest feasible
    expect(conformalThreshold(handSet, 0.2)).toBe(4);
    // epsilon = 0.25: t=3 gives 2/9 ≈ 0.222 <= 0.25, t=2 gives 0.3 > 0.25
    expect(conformalThreshold(handSet, 0.25)).toBe(3);
    // epsilon just below 1/8: even the all-correct suffix cannot certify it
    // at t=4 (1/8), but t must go higher: t=5 -> 1/7? no, larger. So +Inf?
    // t=10: 1/2, t=9: 1/3 ... best possible is t=1's suffix n=10 -> min 1/11.
    // For eps = 0.10: t=4 -> 1/8 = 0.125 > 0.1; t=1..3 have wrongs; +Infinity.
    expect(conformalThreshold(handSet, 0.1)).toBe(Infinity);
  });

  it("scans all candidates (feasibility is not monotone in t)", () => {
    // Highest-scoring point is wrong: every high threshold is infeasible,
    // but lower thresholds that dilute with correct points become feasible.
    // Wrong at scores 1, 2, 10; correct at 3..9. epsilon = 0.25:
    //   t=10..5: infeasible (e.g. t=5: n=6, wrong=1 -> 2/7 ≈ 0.286 > 0.25)
    //   t=4: n=7, wrong=1 -> 2/8 = 0.25  <= 0.25 (feasible)
    //   t=3: n=8, wrong=1 -> 2/9 ≈ 0.222 <= 0.25 (feasible, smaller)
    //   t=2: n=9, wrong=2 -> 3/10 = 0.3  > 0.25
    //   t=1: n=10, wrong=3 -> 4/11 ≈ 0.364 > 0.25
    const pts: CalibrationPoint[] = Array.from({ length: 10 }, (_, k) => ({
      score: k + 1,
      correct: k + 1 >= 3 && k + 1 <= 9,
    }));
    expect(conformalThreshold(pts, 0.25)).toBe(3);
  });

  it("returns +Infinity for an empty calibration set", () => {
    expect(conformalThreshold([], 0.5)).toBe(Infinity);
  });

  it("is order-independent (does not mutate or depend on input order)", () => {
    const shuffled = [...handSet].reverse();
    const copy = shuffled.map((p) => ({ ...p }));
    expect(conformalThreshold(shuffled, 0.2)).toBe(4);
    expect(shuffled).toEqual(copy);
  });
});

describe("ConformalGate", () => {
  it("calibrate/decide/stats agree with the hand example", () => {
    const gate = new ConformalGate({ epsilon: 0.2, minCalibration: 1 });
    const stats = gate.calibrate(handSet);
    expect(stats.threshold).toBe(4);
    expect(stats.epsilon).toBe(0.2);
    expect(stats.calibrationSize).toBe(10);
    expect(stats.coverageAtThreshold).toBeCloseTo(0.7, 12); // 7 of 10
    expect(stats.empiricalRiskAtThreshold).toBe(0); // all 7 above tau correct

    expect(gate.decide(4)).toEqual({
      emit: true,
      score: 4,
      threshold: 4,
      pCorrectEstimate: 1,
    });
    expect(gate.decide(3.999).emit).toBe(false);
    expect(gate.stats()).toEqual(stats);
  });

  it("holds the risk bound on a large deterministic synthetic set", () => {
    const epsilon = 0.1;
    const n = 2000;
    // Known score -> P(correct) curve: P = 0.2 + 0.75 * score, score in [0,1)
    const all: CalibrationPoint[] = Array.from({ length: n }, (_, i) => {
      const score = hash01(i, 1);
      return { score, correct: hash01(i, 2) < 0.2 + 0.75 * score };
    });
    const calib = all.filter((_, i) => i % 2 === 0); // 1000 points
    const holdout = all.filter((_, i) => i % 2 === 1); // 1000 points

    const gate = new ConformalGate({ epsilon });
    const stats = gate.calibrate(calib);
    expect(Number.isFinite(stats.threshold)).toBe(true);

    const emitted = holdout.filter((p) => gate.decide(p.score).emit);
    expect(emitted.length).toBeGreaterThan(50); // gate actually emits things
    const wrongRate =
      emitted.filter((p) => !p.correct).length / emitted.length;
    expect(wrongRate).toBeLessThanOrEqual(epsilon + 0.05); // bound + slack
  });

  it("is monotone in epsilon: looser bound -> tau never higher, coverage never lower", () => {
    const calib: CalibrationPoint[] = Array.from({ length: 500 }, (_, i) => {
      const score = hash01(i, 7);
      return { score, correct: hash01(i, 8) < 0.1 + 0.85 * score };
    });
    const epsilons = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5];
    let prevTau = Infinity;
    let prevCoverage = -1;
    for (const eps of epsilons) {
      const stats = new ConformalGate({ epsilon: eps }).calibrate(calib);
      expect(stats.threshold).toBeLessThanOrEqual(prevTau);
      expect(stats.coverageAtThreshold).toBeGreaterThanOrEqual(prevCoverage);
      prevTau = stats.threshold;
      prevCoverage = stats.coverageAtThreshold;
    }
  });

  it("all-wrong calibration data -> tau = +Infinity, abstain on everything", () => {
    const allWrong: CalibrationPoint[] = Array.from({ length: 30 }, (_, i) => ({
      score: i,
      correct: false,
    }));
    const gate = new ConformalGate({ epsilon: 0.5 });
    const stats = gate.calibrate(allWrong);
    expect(stats.threshold).toBe(Infinity);
    expect(stats.coverageAtThreshold).toBe(0);
    expect(stats.empiricalRiskAtThreshold).toBe(1);
    const d = gate.decide(Infinity); // even a literal +Inf score abstains
    expect(d.emit).toBe(false);
    expect(d.pCorrectEstimate).toBe(0);
    expect(gate.decide(1e9).emit).toBe(false);
  });

  it("all-correct calibration data -> tau = min score, emit everything above it", () => {
    const scores = Array.from({ length: 25 }, (_, i) => 0.3 + i * 0.01);
    const allCorrect = scores.map((score) => ({ score, correct: true }));
    const gate = new ConformalGate({ epsilon: 0.05 });
    // t = min score: (0+1)/(25+1) = 1/26 ≈ 0.038 <= 0.05
    const stats = gate.calibrate(allCorrect);
    expect(stats.threshold).toBe(0.3);
    expect(stats.coverageAtThreshold).toBe(1);
    expect(stats.empiricalRiskAtThreshold).toBe(0);
    expect(gate.decide(0.3).emit).toBe(true);
    expect(gate.decide(0.29).emit).toBe(false);
  });

  it("handles tied scores as a single block", () => {
    const pts: CalibrationPoint[] = [
      // score 2 x5, all wrong
      ...Array.from({ length: 5 }, () => ({ score: 2, correct: false })),
      // score 5 x4: one wrong, three correct — must enter S together
      { score: 5, correct: false },
      { score: 5, correct: true },
      { score: 5, correct: true },
      { score: 5, correct: true },
      // score 8 x5, all correct
      ...Array.from({ length: 5 }, () => ({ score: 8, correct: true })),
    ];
    // t=8: 1/6 <= 0.3; t=5: (1+1)/(9+1) = 0.2 <= 0.3; t=2: 7/15 > 0.3 -> tau=5
    const gate = new ConformalGate({ epsilon: 0.3, minCalibration: 1 });
    const stats = gate.calibrate(pts);
    expect(stats.threshold).toBe(5);
    expect(stats.coverageAtThreshold).toBeCloseTo(9 / 14, 12);
    // Risk over the whole tie block: 1 wrong of 9 selected
    expect(stats.empiricalRiskAtThreshold).toBeCloseTo(1 / 9, 12);
    expect(gate.decide(5).pCorrectEstimate).toBeCloseTo(8 / 9, 12);
  });

  it("throws RangeError on too little calibration data or bad epsilon", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      score: i,
      correct: true,
    }));
    // default minCalibration = 20: 19 points must throw, 20 must not
    expect(() =>
      new ConformalGate({ epsilon: 0.2 }).calibrate(twenty.slice(0, 19)),
    ).toThrow(RangeError);
    expect(() => new ConformalGate({ epsilon: 0.2 }).calibrate(twenty)).not.toThrow();
    // custom minCalibration
    expect(() =>
      new ConformalGate({ epsilon: 0.2, minCalibration: 30 }).calibrate(twenty),
    ).toThrow(RangeError);
    // epsilon must be strictly inside (0, 1)
    for (const eps of [0, 1, -0.1, 1.5, Number.NaN]) {
      expect(() => new ConformalGate({ epsilon: eps }).calibrate(twenty)).toThrow(
        RangeError,
      );
    }
  });

  it("decide() and stats() before calibrate() throw", () => {
    const gate = new ConformalGate({ epsilon: 0.05 });
    expect(() => gate.decide(0.9)).toThrow(/calibrate/);
    expect(() => gate.stats()).toThrow(/calibrate/);
  });
});
