/**
 * ADVERSARIAL VERIFICATION of the reputation kernel
 * (`src/hades/market/reputation.ts`).
 *
 * This suite proves — numerically, not just asserts — the Murphy
 * decomposition identity on seeded (including degenerate) datasets; that
 * every malformed field is rejected without mutating the ledger; that
 * tampering with a deserialized ledger's entries or hash chain is always
 * caught with the exact broken `{participantId, seq}`; the anti-gaming
 * economics (cherry-picking, padding, sybil identities, fabrication) the
 * scoring formula is supposed to resist; exact half-life decay semantics;
 * deterministic serialize/deserialize round-tripping; and calibration-curve
 * bin coverage. No `Math.random`, no `Date.now` — every timestamp below is
 * a literal, caller-provided millisecond value.
 */

import { describe, expect, it } from "vitest";
import {
  brierDecomposition,
  REPUTATION_GENESIS,
  ReputationLedger,
  ReputationValidationError,
  reputationScore,
  wilsonLowerBound,
  type ReputationEvent,
  type ReputationState,
} from "../reputation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Directly-computed (not via the module under test) weighted Brier score — the ground truth `brierDecomposition` must reproduce. */
function directWeightedBrier(points: ReadonlyArray<{ p: number; outcome: 0 | 1; weight?: number }>): number {
  let sumW = 0;
  let sumWE = 0;
  for (const pt of points) {
    const w = pt.weight ?? 1;
    const err = pt.p - pt.outcome;
    sumW += w;
    sumWE += w * err * err;
  }
  return sumWE / sumW;
}

function baseEvent(overrides: Partial<ReputationEvent>): ReputationEvent {
  return {
    participantId: "p",
    kind: "agent",
    taskId: "t",
    claimedP: 0.5,
    outcome: 1,
    certified: true,
    at: 0,
    ...overrides,
  };
}

// ===========================================================================
// 1. brierDecomposition — Murphy identity on seeded + degenerate datasets
// ===========================================================================

describe("brierDecomposition — Murphy identity", () => {
  const datasets: Array<{ name: string; points: Array<{ p: number; outcome: 0 | 1; weight?: number }>; bins?: number }> = [
    {
      // Distinct claim values chosen so no two land in the same bin — the
      // classical reliability/resolution split (which uses each bin's MEAN
      // claim) only reconstructs the raw per-point Brier exactly when a
      // bin's members share one value; that is a real mathematical
      // property, not a shortcut, so seeded datasets here avoid collisions.
      name: "all-outcome-1",
      points: [
        { p: 0.9, outcome: 1 },
        { p: 0.3, outcome: 1 },
        { p: 0.6, outcome: 1 },
        { p: 0.05, outcome: 1 },
      ],
    },
    {
      name: "all-outcome-0",
      points: [
        { p: 0.9, outcome: 0 },
        { p: 0.1, outcome: 0 },
        { p: 0.5, outcome: 0 },
      ],
    },
    {
      name: "single-point",
      points: [{ p: 0.73, outcome: 1 }],
    },
    {
      name: "all-claims-identical",
      points: [
        { p: 0.4, outcome: 1 },
        { p: 0.4, outcome: 0 },
        { p: 0.4, outcome: 1 },
        { p: 0.4, outcome: 0 },
        { p: 0.4, outcome: 1 },
      ],
    },
    {
      // Exact dyadic bin-edge values (representable exactly in binary
      // floating point, so there is no float-rounding ambiguity about which
      // side of an edge a point falls on) for bins=8, chosen so p=1.0's
      // clamp into the top bin does not collide with another distinct value.
      name: "claims-exactly-on-bin-edges",
      points: [
        { p: 0.0, outcome: 0 },
        { p: 0.125, outcome: 1 },
        { p: 0.375, outcome: 0 },
        { p: 0.625, outcome: 1 },
        { p: 1.0, outcome: 1 },
      ],
      bins: 8,
    },
    {
      name: "weighted-mixed",
      points: [
        { p: 0.2, outcome: 0, weight: 3 },
        { p: 0.85, outcome: 1, weight: 1 },
        { p: 0.5, outcome: 1, weight: 7 },
        { p: 0.5, outcome: 0, weight: 2 },
      ],
    },
  ];

  for (const ds of datasets) {
    it(`holds within 1e-12 for: ${ds.name}`, () => {
      const decomp = brierDecomposition(ds.points, ds.bins ?? 10);
      const direct = directWeightedBrier(ds.points);
      expect(Math.abs(decomp.brier - direct)).toBeLessThan(1e-12);
      expect(Math.abs(decomp.brier - (decomp.reliability - decomp.resolution + decomp.uncertainty))).toBeLessThan(1e-12);
      expect(decomp.uncertainty).toBeGreaterThanOrEqual(0);
      expect(decomp.reliability).toBeGreaterThanOrEqual(-1e-12);
    });
  }

  it("returns all-zero for an empty point set", () => {
    const decomp = brierDecomposition([], 10);
    expect(decomp).toEqual({ brier: 0, reliability: 0, resolution: 0, uncertainty: 0 });
  });

  it("rejects a non-positive-integer bins", () => {
    expect(() => brierDecomposition([{ p: 0.5, outcome: 1 }], 0)).toThrow(ReputationValidationError);
    expect(() => brierDecomposition([{ p: 0.5, outcome: 1 }], 2.5)).toThrow(ReputationValidationError);
  });

  it("rejects out-of-range points", () => {
    expect(() => brierDecomposition([{ p: 1.5, outcome: 1 }])).toThrow(ReputationValidationError);
    expect(() => brierDecomposition([{ p: 0.5, outcome: 1, weight: -1 }])).toThrow(ReputationValidationError);
  });
});

// ===========================================================================
// 2. wilsonLowerBound
// ===========================================================================

describe("wilsonLowerBound", () => {
  it("is exactly 0 at n=0", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it("is strictly below the raw proportion (it is a lower bound)", () => {
    const lb = wilsonLowerBound(70, 100);
    expect(lb).toBeGreaterThan(0);
    expect(lb).toBeLessThan(0.7);
  });

  it("is monotonically tighter (closer to phat) with more evidence at the same proportion", () => {
    const small = wilsonLowerBound(7, 10);
    const large = wilsonLowerBound(700, 1000);
    expect(large).toBeGreaterThan(small);
  });
});

// ===========================================================================
// 3. Validation — every invalid field rejects, ledger left unchanged
// ===========================================================================

describe("ReputationLedger.record — validation", () => {
  function expectRejectedAndUnchanged(bad: ReputationEvent, field: string) {
    const ledger = new ReputationLedger();
    const good = ledger.record(baseEvent({ participantId: "anchor", taskId: "t0", at: 0 }));
    const lenBefore = ledger.entries().length;

    let caught: unknown;
    try {
      ledger.record(bad);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReputationValidationError);
    expect((caught as ReputationValidationError).field).toBe(field);
    expect(ledger.entries().length).toBe(lenBefore);
    expect(ledger.entries()[ledger.entries().length - 1].hash).toBe(good.hash);
  }

  it("rejects NaN claimedP", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", claimedP: NaN }), "claimedP");
  });
  it("rejects claimedP > 1", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", claimedP: 1.2 }), "claimedP");
  });
  it("rejects claimedP = -Infinity", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", claimedP: -Infinity }), "claimedP");
  });
  it("rejects an outcome that is not 0 or 1", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", outcome: 2 as unknown as 0 | 1 }), "outcome");
  });
  it("rejects weight = 0", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", weight: 0 }), "weight");
  });
  it("rejects negative weight", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", weight: -3 }), "weight");
  });
  it("rejects difficulty out of [0,1]", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", difficulty: 1.5 }), "difficulty");
  });
  it("rejects a non-finite `at`", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", at: NaN }), "at");
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", at: Infinity }), "at");
  });
  it("rejects an empty participantId", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "" }), "participantId");
  });
  it("rejects a whitespace-only participantId", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "   " }), "participantId");
  });
  it("rejects a non-string taskId", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", taskId: 123 as unknown as string }), "taskId");
  });
  it("rejects an unrecognized kind", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", kind: "bogus" as unknown as ReputationEvent["kind"] }), "kind");
  });
  it("rejects a non-boolean certified", () => {
    expectRejectedAndUnchanged(baseEvent({ participantId: "bad", certified: "yes" as unknown as boolean }), "certified");
  });

  it("options validation rejects a bad halfLifeMs/window/priorStrength/uncertifiedPenalty/bins", () => {
    expect(() => new ReputationLedger({ halfLifeMs: 0 })).toThrow(ReputationValidationError);
    expect(() => new ReputationLedger({ window: 0 })).toThrow(ReputationValidationError);
    expect(() => new ReputationLedger({ priorStrength: -1 })).toThrow(ReputationValidationError);
    expect(() => new ReputationLedger({ uncertifiedPenalty: 1.5 })).toThrow(ReputationValidationError);
    expect(() => new ReputationLedger({ bins: 0 })).toThrow(ReputationValidationError);
  });
});

// ===========================================================================
// 4. Tamper-evidence
// ===========================================================================

describe("ReputationLedger — tamper-evidence", () => {
  function buildPristineJson(): string {
    const ledger = new ReputationLedger();
    for (let i = 0; i < 5; i++) {
      ledger.record(
        baseEvent({
          participantId: "victim",
          taskId: `t${i}`,
          claimedP: 0.3 + i * 0.1,
          outcome: i % 2 === 0 ? 1 : 0,
          weight: i === 2 ? 2 : 1,
          at: i * 1000,
        }),
      );
    }
    return ledger.serialize();
  }

  function tamper(json: string, mutate: (chain: any[]) => void): string {
    const parsed = JSON.parse(json);
    mutate(parsed.chains.victim);
    return JSON.stringify(parsed);
  }

  const pristine = buildPristineJson();

  it("sanity: the pristine ledger verifies clean", () => {
    const ledger = ReputationLedger.deserialize(pristine);
    expect(ledger.verifyChain().ok).toBe(true);
    expect(ledger.entries("victim").length).toBe(5);
  });

  const tamperCases: Array<[string, (chain: any[]) => void]> = [
    ["claimedP", (chain: any[]): void => { chain[2].claimedP = 0.999; }],
    ["outcome", (chain: any[]): void => { chain[2].outcome = chain[2].outcome === 1 ? 0 : 1; }],
    ["weight", (chain: any[]): void => { chain[2].weight = 999; }],
    ["prevHash", (chain: any[]): void => { chain[2].prevHash = "0".repeat(64); }],
  ];

  it.each(tamperCases)("detects a tampered %s at the exact broken seq, and survives re-serialization", (_label, mutate) => {
    const tamperedJson = tamper(pristine, mutate);
    const tampered = ReputationLedger.deserialize(tamperedJson);

    const first = tampered.verifyChain();
    expect(first.ok).toBe(false);
    expect(first.brokenAt).toEqual({ participantId: "victim", seq: 2 });

    const roundTripped = ReputationLedger.deserialize(tampered.serialize());
    const second = roundTripped.verifyChain();
    expect(second.ok).toBe(false);
    expect(second.brokenAt).toEqual({ participantId: "victim", seq: 2 });
  });

  it("REPUTATION_GENESIS is a 64-char lowercase-hex sha256 digest", () => {
    expect(REPUTATION_GENESIS).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ===========================================================================
// 5. Adversarial economics
// ===========================================================================

describe("ReputationLedger — adversarial economics", () => {
  it("a cherry-picker (only near-certain tasks) does NOT outrank an honest, resolving forecaster", () => {
    const ledger = new ReputationLedger();

    // Cherry-picker: 100 events, difficulty 0.95, always claims 0.95, right
    // 95% of the time — perfectly calibrated to its own (easy) task pool but
    // demonstrates ZERO resolution (never distinguishes cases).
    for (let i = 0; i < 100; i++) {
      ledger.record(
        baseEvent({
          participantId: "cherrypicker",
          taskId: `cp${i}`,
          difficulty: 0.95,
          claimedP: 0.95,
          outcome: i < 95 ? 1 : 0,
          at: i,
        }),
      );
    }

    // Honest forecaster: 100 events on genuinely hard (difficulty 0.5)
    // tasks, but DIFFERENTIATES: claims 0.9 when confident (right 90% of
    // those) and 0.5 when unsure (right 50% of those) — real resolution,
    // overall 70% pass rate.
    for (let i = 0; i < 100; i++) {
      const confident = i < 50;
      const outcome = confident ? (i < 45 ? 1 : 0) : (i < 75 ? 1 : 0);
      ledger.record(
        baseEvent({
          participantId: "honest",
          taskId: `h${i}`,
          difficulty: 0.5,
          claimedP: confident ? 0.9 : 0.5,
          outcome,
          at: i,
        }),
      );
    }

    const cp = ledger.state("cherrypicker")!;
    const honest = ledger.state("honest")!;

    expect(cp.decomposition.resolution).toBeLessThan(1e-9);
    expect(honest.decomposition.resolution).toBeGreaterThan(0.01);
    expect(honest.score).toBeGreaterThan(cp.score);
  });

  it("a padder (500 trivially-certain events) cannot exceed its own calibration — score stays near the climatology floor", () => {
    const ledger = new ReputationLedger();
    for (let i = 0; i < 500; i++) {
      ledger.record(
        baseEvent({
          participantId: "padder",
          taskId: `pad${i}`,
          difficulty: 0.99,
          claimedP: 0.99,
          outcome: i < 495 ? 1 : 0,
          at: i,
        }),
      );
    }
    const state = ledger.state("padder")!;
    expect(state.n).toBe(500);
    expect(state.score).toBeLessThan(0.05);
  });

  it("a fresh sybil (n=1, claims 0.99) ranks below an established honest participant", () => {
    const ledger = new ReputationLedger();
    for (let i = 0; i < 200; i++) {
      const confident = i < 100;
      const outcome = confident ? (i < 90 ? 1 : 0) : (i < 150 ? 1 : 0);
      ledger.record(
        baseEvent({
          participantId: "established",
          taskId: `e${i}`,
          difficulty: 0.5,
          claimedP: confident ? 0.9 : 0.5,
          outcome,
          at: i,
        }),
      );
    }
    ledger.record(
      baseEvent({
        participantId: "sybil",
        taskId: "s0",
        difficulty: 0.5,
        claimedP: 0.99,
        outcome: 1,
        at: 0,
      }),
    );

    const established = ledger.state("established")!;
    const sybil = ledger.state("sybil")!;
    expect(sybil.n).toBe(1);
    expect(established.n).toBe(200);
    expect(sybil.score).toBeLessThan(established.score);
  });

  it("one fabrication among 1000 perfect events still scores EXACTLY 0 and is banned", () => {
    const ledger = new ReputationLedger();
    for (let i = 0; i < 1000; i++) {
      ledger.record(
        baseEvent({
          participantId: "fabricator",
          taskId: `f${i}`,
          difficulty: 0.5,
          claimedP: 1,
          outcome: 1,
          at: i,
        }),
      );
    }
    ledger.record(
      baseEvent({
        participantId: "fabricator",
        taskId: "the-lie",
        claimedP: 0.5,
        outcome: 1,
        fabricated: true,
        at: 1000,
      }),
    );

    const state = ledger.state("fabricator")!;
    expect(state.fabricatedN).toBe(1);
    expect(state.n).toBe(1001);
    expect(state.score).toBe(0);
    expect(state.standingHint).toBe("banned");
  });

  it("reputationScore itself forces 0 whenever fabricatedN > 0, regardless of otherwise-perfect stats", () => {
    const perfect: Omit<ReputationState, "score" | "standingHint"> = {
      participantId: "x",
      kind: "agent",
      n: 100,
      verifiedN: 100,
      fabricatedN: 1,
      brier: 0,
      decayedBrier: 0,
      decomposition: { brier: 0, reliability: 0, resolution: 0.25, uncertainty: 0.25 },
      passRate: 1,
      wilsonLower: 1,
      meanClaim: 1,
      calibrationGap: 0,
      lastAt: 0,
    };
    expect(reputationScore(perfect)).toBe(0);
  });

  it("declared difficulty discounts near-certain events relative to genuinely hard ones within the same record", () => {
    // X: a bad miss on a near-certain task (heavily discounted) plus a good call on a hard task (full weight).
    // Both events share `at: 0` so decay is identical for both and cancels out of the comparison.
    const ledgerX = new ReputationLedger();
    ledgerX.record(baseEvent({ participantId: "x", taskId: "easy-miss", difficulty: 0.99, claimedP: 0.9, outcome: 0, at: 0 }));
    ledgerX.record(baseEvent({ participantId: "x", taskId: "hard-hit", difficulty: 0.5, claimedP: 0.1, outcome: 0, at: 0 }));

    // Y: the SAME two errors, but with difficulty swapped — the bad miss is now on the hard (full-weight) task.
    const ledgerY = new ReputationLedger();
    ledgerY.record(baseEvent({ participantId: "y", taskId: "hard-miss", difficulty: 0.5, claimedP: 0.9, outcome: 0, at: 0 }));
    ledgerY.record(baseEvent({ participantId: "y", taskId: "easy-hit", difficulty: 0.99, claimedP: 0.1, outcome: 0, at: 0 }));

    const dbX = ledgerX.state("x")!.decayedBrier;
    const dbY = ledgerY.state("y")!.decayedBrier;

    // w(easy)=4*0.99*0.01=0.0396, w(hard)=1: dbX=(0.0396*0.81+1*0.01)/1.0396, dbY=(1*0.81+0.0396*0.01)/1.0396.
    const wEasy = 4 * 0.99 * 0.01;
    const wHard = 1;
    const expectedX = (wEasy * 0.81 + wHard * 0.01) / (wEasy + wHard);
    const expectedY = (wHard * 0.81 + wEasy * 0.01) / (wEasy + wHard);
    expect(dbX).toBeLessThan(dbY);
    expect(dbX).toBeCloseTo(expectedX, 10);
    expect(dbY).toBeCloseTo(expectedY, 10);
  });

  it("uncertified events contribute uncertifiedPenalty weight to credit but full weight to penalty", () => {
    const ledger = new ReputationLedger({ uncertifiedPenalty: 0.5 });
    // A perfect uncertified forecast should be treated as if half-credited (effective error 0.5, not 0).
    ledger.record(baseEvent({ participantId: "goodUncert", taskId: "g0", difficulty: 0.5, claimedP: 1, outcome: 1, certified: false, at: 0 }));
    // A maximally wrong uncertified forecast is NOT discounted at all (full penalty).
    ledger.record(baseEvent({ participantId: "badUncert", taskId: "b0", difficulty: 0.5, claimedP: 1, outcome: 0, certified: false, at: 0 }));

    const good = ledger.state("goodUncert")!;
    const bad = ledger.state("badUncert")!;
    expect(good.decayedBrier).toBeCloseTo(0.5, 10);
    expect(bad.decayedBrier).toBeCloseTo(1, 10);
  });
});

// ===========================================================================
// 6. Decay monotonicity + exact half-life semantics
// ===========================================================================

describe("ReputationLedger — time decay", () => {
  const H = 1000; // halfLifeMs

  function buildLedger(): ReputationLedger {
    const ledger = new ReputationLedger({ halfLifeMs: H });
    // Errors chosen so p^2 gives a clean squared error: bad -> medium -> good, arriving over time.
    ledger.record(baseEvent({ participantId: "d", taskId: "t0", difficulty: 0.5, claimedP: 0.9, outcome: 0, at: 0 })); // err 0.81
    ledger.record(baseEvent({ participantId: "d", taskId: "t1", difficulty: 0.5, claimedP: 0.5, outcome: 0, at: H })); // err 0.25
    ledger.record(baseEvent({ participantId: "d", taskId: "t2", difficulty: 0.5, claimedP: 0.1, outcome: 0, at: 2 * H })); // err 0.01
    return ledger;
  }

  it("moves decayedBrier monotonically toward the recent (better) window as asOf advances", () => {
    const ledger = buildLedger();
    const at0 = ledger.state("d", 0)!.decayedBrier;
    const atH = ledger.state("d", H)!.decayedBrier;
    const at2H = ledger.state("d", 2 * H)!.decayedBrier;
    expect(at0).toBeCloseTo(0.81, 10);
    expect(at0).toBeGreaterThan(atH);
    expect(atH).toBeGreaterThan(at2H);
  });

  it("asserts exact half-life weighting at one and two half-lives", () => {
    const ledger = buildLedger();
    // asOf = H: weights are decay(age=H)=0.5 for t0, decay(age=0)=1 for t1.
    const atH = ledger.state("d", H)!.decayedBrier;
    expect(atH).toBeCloseTo((0.5 * 0.81 + 1 * 0.25) / 1.5, 10);
    // asOf = 2H: weights are decay(age=2H)=0.25 for t0, decay(age=H)=0.5 for t1, decay(age=0)=1 for t2.
    const at2H = ledger.state("d", 2 * H)!.decayedBrier;
    expect(at2H).toBeCloseTo((0.25 * 0.81 + 0.5 * 0.25 + 1 * 0.01) / 1.75, 10);
  });
});

// ===========================================================================
// 7. Serialization — determinism, round-tripping, malformed rejection
// ===========================================================================

describe("ReputationLedger — serialize/deserialize", () => {
  function feed(ledger: ReputationLedger): void {
    ledger.record(baseEvent({ participantId: "a", taskId: "a0", claimedP: 0.6, outcome: 1, at: 0 }));
    ledger.record(baseEvent({ participantId: "b", taskId: "b0", claimedP: 0.4, outcome: 0, weight: 2, difficulty: 0.3, at: 1 }));
    ledger.record(baseEvent({ participantId: "a", taskId: "a1", claimedP: 0.7, outcome: 1, certified: false, at: 2 }));
  }

  it("is byte-identical across two independently-fed, identically-constructed ledgers", () => {
    const ledgerA = new ReputationLedger();
    const ledgerB = new ReputationLedger();
    feed(ledgerA);
    feed(ledgerB);
    expect(ledgerA.serialize()).toBe(ledgerB.serialize());
  });

  it("round-trips every field and preserves chain verification", () => {
    const ledger = new ReputationLedger();
    feed(ledger);
    const json = ledger.serialize();
    const restored = ReputationLedger.deserialize(json);

    expect(restored.serialize()).toBe(json);
    expect(restored.verifyChain().ok).toBe(true);
    expect(restored.entries()).toEqual(ledger.entries());
    expect(restored.state("a")).toEqual(ledger.state("a"));
    expect(restored.state("b")).toEqual(ledger.state("b"));
  });

  it("rejects invalid JSON with a typed error, not an empty ledger", () => {
    expect(() => ReputationLedger.deserialize("{not json")).toThrow(ReputationValidationError);
  });

  it("rejects truncated JSON with a typed error", () => {
    const ledger = new ReputationLedger();
    feed(ledger);
    const truncated = ledger.serialize().slice(0, 40);
    expect(() => ReputationLedger.deserialize(truncated)).toThrow(ReputationValidationError);
  });

  it("rejects the wrong envelope version with a typed error", () => {
    const ledger = new ReputationLedger();
    feed(ledger);
    const parsed = JSON.parse(ledger.serialize());
    parsed.version = 2;
    expect(() => ReputationLedger.deserialize(JSON.stringify(parsed))).toThrow(ReputationValidationError);
  });

  it("rejects a genesis mismatch with a typed error", () => {
    const ledger = new ReputationLedger();
    feed(ledger);
    const parsed = JSON.parse(ledger.serialize());
    parsed.genesis = "0".repeat(64);
    expect(() => ReputationLedger.deserialize(JSON.stringify(parsed))).toThrow(ReputationValidationError);
  });

  it("rejects malformed chain entries (missing required field) with a typed error", () => {
    const ledger = new ReputationLedger();
    feed(ledger);
    const parsed = JSON.parse(ledger.serialize());
    delete parsed.chains.a[0].claimedP;
    expect(() => ReputationLedger.deserialize(JSON.stringify(parsed))).toThrow(ReputationValidationError);
  });
});

// ===========================================================================
// 8. Calibration curve — half-open bins, full coverage, no lost points, no NaN
// ===========================================================================

describe("ReputationLedger.calibrationCurve", () => {
  it("covers [0,1] exactly with contiguous half-open bins, never loses a point, and never NaNs an empty bin", () => {
    const ledger = new ReputationLedger();
    const claims = [0.05, 0.15, 0.15, 0.55, 0.95, 0.95, 0.95, 1.0];
    claims.forEach((p, i) => {
      ledger.record(baseEvent({ participantId: "cal", taskId: `c${i}`, claimedP: p, outcome: i % 2 === 0 ? 1 : 0, at: i }));
    });

    const bins = ledger.calibrationCurve("cal", 10);
    expect(bins.length).toBe(10);
    expect(bins[0].lo).toBe(0);
    expect(bins[bins.length - 1].hi).toBe(1);
    for (let k = 0; k < bins.length - 1; k++) {
      expect(bins[k].hi).toBeCloseTo(bins[k + 1].lo, 12);
    }
    expect(bins.reduce((acc, b) => acc + b.n, 0)).toBe(claims.length);

    const emptyBin = bins.find((b) => b.n === 0);
    expect(emptyBin).toBeDefined();
    expect(Number.isNaN(emptyBin!.meanClaim)).toBe(false);
    expect(Number.isNaN(emptyBin!.observedRate)).toBe(false);
    expect(emptyBin!.meanClaim).toBe(0);
    expect(emptyBin!.observedRate).toBe(0);

    // The top bin [0.9,1.0] holds the three 0.95 claims AND the 1.0 claim
    // (1.0 has no bin of its own above it, so it clamps into the last bin).
    const bin9 = bins[9];
    expect(bin9.n).toBe(4);
    expect(bin9.meanClaim).toBeCloseTo((0.95 * 3 + 1.0) / 4, 10);
  });

  it("returns an empty-but-well-formed curve for a participant with no events", () => {
    const ledger = new ReputationLedger();
    const bins = ledger.calibrationCurve("nobody", 4);
    expect(bins.length).toBe(4);
    expect(bins.every((b) => b.n === 0 && b.meanClaim === 0 && b.observedRate === 0)).toBe(true);
  });
});

// ===========================================================================
// 9. Basic API surface sanity
// ===========================================================================

describe("ReputationLedger — basic API sanity", () => {
  it("state() returns null for an unknown participant", () => {
    const ledger = new ReputationLedger();
    expect(ledger.state("nobody")).toBeNull();
  });

  it("states() returns one entry per participant with events, in first-seen order", () => {
    const ledger = new ReputationLedger();
    ledger.record(baseEvent({ participantId: "second", taskId: "x", at: 0 }));
    ledger.record(baseEvent({ participantId: "first", taskId: "y", at: 1 }));
    const all = ledger.states();
    expect(all.map((s) => s.participantId)).toEqual(["second", "first"]);
  });

  it("entries(id) round-trips claimedP/outcome/weight for a known participant and hash-chains seq 0 to REPUTATION_GENESIS", () => {
    const ledger = new ReputationLedger();
    const e = ledger.record(baseEvent({ participantId: "p1", taskId: "t0", claimedP: 0.42, outcome: 1, weight: 3, at: 5 }));
    expect(e.seq).toBe(0);
    expect(e.prevHash).toBe(REPUTATION_GENESIS);
    const entries = ledger.entries("p1");
    expect(entries.length).toBe(1);
    expect(entries[0].claimedP).toBe(0.42);
    expect(entries[0].weight).toBe(3);
  });
});
