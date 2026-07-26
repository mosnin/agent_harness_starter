import { describe, it, expect } from "vitest";
import {
  routeTier,
  tierConfidenceFloor,
  TIER_ORDER,
  WeakVerifierEnsemble,
  type TaskSignals,
  type VerifierVote,
} from "../styx/tiers";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — no Math.random anywhere, so the synthetic
// verifier data is byte-identical on every run.
// ---------------------------------------------------------------------------
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

/**
 * Build 200 items with known labels and verifiers of known true accuracy.
 * label_i is balanced (alternating). A verifier of accuracy `acc` votes its
 * belief = (rand < acc ? label : !label), so its empirical accuracy ≈ acc.
 */
function synth(): {
  votes: VerifierVote[][];
  labels: boolean[];
  trueAcc: Record<string, number>;
} {
  const rng = mulberry32(0xc0ffee);
  const specs = [
    { id: "good-a", acc: 0.9 },
    { id: "good-b", acc: 0.9 },
    { id: "good-c", acc: 0.9 },
    { id: "adversary", acc: 0.1 },
  ];
  const N = 200;
  const labels: boolean[] = [];
  const votes: VerifierVote[][] = [];
  for (let i = 0; i < N; i++) {
    const label = i % 2 === 0;
    labels.push(label);
    const item: VerifierVote[] = specs.map((s) => ({
      verifierId: s.id,
      passed: rng() < s.acc ? label : !label,
    }));
    votes.push(item);
  }
  const trueAcc: Record<string, number> = {};
  for (const s of specs) trueAcc[s.id] = s.acc;
  return { votes, labels, trueAcc };
}

// ===========================================================================
// #2 — router
// ===========================================================================

describe("routeTier", () => {
  it("picks the strongest applicable tier by strict priority", () => {
    expect(routeTier({ executable: true, hasReference: true })).toBe("T0-execution");
    expect(routeTier({ hasReference: true, rubricAvailable: true })).toBe("T1-reference");
    expect(routeTier({ rubricAvailable: true, multiModelAvailable: true })).toBe("T2-genrm");
    expect(routeTier({ multiModelAvailable: true })).toBe("T3-agreement");
  });

  it("falls back to T4-consistency when no stronger signal is present", () => {
    expect(routeTier({})).toBe("T4-consistency");
    expect(routeTier({ executable: false, hasReference: false })).toBe("T4-consistency");
  });
});

describe("tierConfidenceFloor", () => {
  it("is monotonic non-decreasing as the tier weakens, all in [0,1]", () => {
    for (const eps of [0, 0.01, 0.1, 0.5, 1]) {
      const floors = TIER_ORDER.map((t) => tierConfidenceFloor(t, eps));
      for (const f of floors) {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
      for (let i = 1; i < floors.length; i++) {
        expect(floors[i]).toBeGreaterThanOrEqual(floors[i - 1]);
      }
      // T0 sits at ~1-eps, T4 nearly 1.
      expect(floors[0]).toBeCloseTo(1 - eps, 10);
      expect(floors[floors.length - 1]).toBeGreaterThanOrEqual(floors[0]);
    }
  });

  it("clamps a nonsensical baseEpsilon into range", () => {
    expect(tierConfidenceFloor("T0-execution", 5)).toBe(0); // eps clamped to 1
    expect(tierConfidenceFloor("T0-execution", -3)).toBe(1); // eps clamped to 0
  });
});

// ===========================================================================
// #3 — label-free ensemble
// ===========================================================================

describe("WeakVerifierEnsemble reliability recovery (label-free)", () => {
  it("recovers per-verifier accuracy from agreement alone, no labels", () => {
    const { votes, trueAcc } = synth();
    const ens = new WeakVerifierEnsemble();
    ens.fitPredict(votes);
    const rel = ens.reliabilities();

    // Good verifiers estimated near their true 0.9.
    for (const id of ["good-a", "good-b", "good-c"]) {
      expect(rel[id]).toBeGreaterThan(0.8);
      expect(Math.abs(rel[id] - trueAcc[id])).toBeLessThan(0.1);
    }
    // Always-wrong verifier down-weighted well below 0.5, near its true 0.1.
    expect(rel["adversary"]).toBeLessThan(0.5);
    expect(rel["adversary"]).toBeLessThan(0.25);
  });

  it("calibrated weighted score beats raw unweighted majority in accuracy", () => {
    const { votes, labels } = synth();
    const ens = new WeakVerifierEnsemble();
    const results = ens.fitPredict(votes);

    let ensCorrect = 0;
    let rawCorrect = 0;
    for (let i = 0; i < votes.length; i++) {
      const ensPass = results[i].score > 0.5;
      if (ensPass === labels[i]) ensCorrect++;
      const rawPass = results[i].agreement > 0.5; // unweighted majority
      if (rawPass === labels[i]) rawCorrect++;
    }
    const ensAcc = ensCorrect / votes.length;
    const rawAcc = rawCorrect / votes.length;
    expect(ensAcc).toBeGreaterThan(0.85);
    expect(ensAcc).toBeGreaterThanOrEqual(rawAcc);
  });
});

describe("WeakVerifierEnsemble edge cases", () => {
  it("single verifier is self-consistent and its score follows its vote", () => {
    const ens = new WeakVerifierEnsemble();
    const res = ens.fitPredict([
      [{ verifierId: "solo", passed: true }],
      [{ verifierId: "solo", passed: false }],
    ]);
    expect(ens.reliabilities()["solo"]).toBeCloseTo(1, 10);
    expect(res[0].score).toBeGreaterThan(0.99); // pass
    expect(res[1].score).toBeLessThan(0.01); // fail
  });

  it("unanimous votes drive the score to ~1 or ~0", () => {
    const ens = new WeakVerifierEnsemble();
    const res = ens.fitPredict([
      [
        { verifierId: "a", passed: true },
        { verifierId: "b", passed: true },
        { verifierId: "c", passed: true },
      ],
      [
        { verifierId: "a", passed: false },
        { verifierId: "b", passed: false },
        { verifierId: "c", passed: false },
      ],
    ]);
    expect(res[0].score).toBeCloseTo(1, 10);
    expect(res[1].score).toBeCloseTo(0, 10);
    expect(res[0].agreement).toBe(1);
    expect(res[1].agreement).toBe(0);
  });

  it("empty item yields the documented neutral 0.5 score and agreement", () => {
    const ens = new WeakVerifierEnsemble();
    const res = ens.fitPredict([[], [{ verifierId: "a", passed: true }]]);
    expect(res[0].score).toBe(0.5);
    expect(res[0].agreement).toBe(0.5);
  });

  it("scoreItem uses learned reliabilities; unseen verifier is neutral", () => {
    const { votes } = synth();
    const ens = new WeakVerifierEnsemble();
    ens.fitPredict(votes);
    // Three good verifiers all pass ⇒ high score.
    const s = ens.scoreItem([
      { verifierId: "good-a", passed: true },
      { verifierId: "good-b", passed: true },
      { verifierId: "good-c", passed: true },
    ]);
    expect(s).toBeGreaterThan(0.5);
    // A single unseen verifier (neutral 0.5 weight) still produces a finite score.
    const u = ens.scoreItem([{ verifierId: "brand-new", passed: true }]);
    expect(u).toBeGreaterThan(0.99);
    // scoreItem before fit throws.
    expect(() => new WeakVerifierEnsemble().scoreItem([])).toThrow();
  });

  it("is deterministic: identical votes ⇒ identical weights and scores", () => {
    const { votes } = synth();
    const a = new WeakVerifierEnsemble();
    const b = new WeakVerifierEnsemble();
    const ra = a.fitPredict(votes);
    const rb = b.fitPredict(votes);
    expect(a.reliabilities()).toEqual(b.reliabilities());
    expect(ra.map((r) => r.score)).toEqual(rb.map((r) => r.score));
  });
});
