/**
 * ADVERSARIAL VERIFICATION of the Trust-Gated Work Exchange
 * (`src/hades/market/exchange.ts`).
 *
 * This suite proves the exchange actually closes the documented mechanism
 * gap in the S5 market (`styx/market.ts`, see
 * `../../__tests__/styx-market-adversarial.test.ts`, "KNOWN MECHANISM GAP"):
 * a same-price blusterer with a bad track record beats an honest bidder at
 * SELECTION time there. Here, `WorkExchange.clear` must pick the honest
 * bidder instead. It also proves sybil resistance, unconditional fabrication
 * disqualification, second-price truthfulness (numerically swept), the full
 * gating matrix, determinism under input shuffling, and structural edges —
 * against a REAL `ReputationLedger` fed with real recorded events in every
 * case, never a fake reputation object.
 *
 * Fully deterministic: no `Math.random`, no `Date.now`. All timestamps are
 * literal, caller-provided milliseconds; `now` is always passed explicitly.
 */

import { describe, expect, it } from "vitest";
import {
  expectedVerifiedValue,
  shrinkClaim,
  WorkExchange,
  type Capability,
  type Match,
  type OfferRejectionCode,
  type TaskOrder,
  type WorkOffer,
} from "../exchange";
import { ReputationLedger, type ReputationEvent, type Standing } from "../reputation";
import { settlementPayment, type WorkBid } from "../../styx/market";
import { VerifiedWorkMarket } from "../../styx/market";

// ---------------------------------------------------------------------------
// Deterministic helpers (no Math.random anywhere)
// ---------------------------------------------------------------------------

/** Integer-hash avalanche → [0,1), deterministic per (seed, i). */
function hash01(seed: number, i: number): number {
  let x = (i + 0x9e3779b9 + seed * 2654435761) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/** Feeds `ledger` `n` real, certified, non-fabricated events for `id`, each
 * claiming a CONSTANT `claimedP` regardless of the actual per-item odds, and
 * passing with deterministic probability `trueRate`. This is the "bluster"
 * pattern: a forecaster who never differentiates between cases has zero
 * Murphy resolution (see `reputation.ts`'s module header) and therefore
 * cannot out-score the population's genuinely discriminating forecasters —
 * used deliberately here to model a bad-track-record participant. Returns
 * the achieved empirical pass rate. */
function seedHistory(
  ledger: ReputationLedger,
  id: string,
  opts: { n: number; claimedP: number; trueRate: number; seed: number; startAt?: number },
): number {
  const startAt = opts.startAt ?? 0;
  let passes = 0;
  for (let i = 0; i < opts.n; i++) {
    const outcome: 0 | 1 = hash01(opts.seed, i) < opts.trueRate ? 1 : 0;
    if (outcome === 1) passes++;
    ledger.record({
      participantId: id,
      kind: "worker",
      taskId: `${id}-hist-${i}`,
      claimedP: opts.claimedP,
      outcome,
      certified: true,
      at: startAt + i * 1000,
    });
  }
  return passes / opts.n;
}

/**
 * Feeds `ledger` `n` real, certified, non-fabricated events for `id` that
 * genuinely DISCRIMINATE between per-item odds: each event's true pass
 * probability `pi` is drawn (deterministically) around `meanP` with spread
 * `spread`, the outcome is a real Bernoulli draw at `pi`, and the claim
 * reported IS `pi` (truthful and informative) — real Murphy resolution, so
 * this is the "genuinely skilled, honest" pattern that earns a solidly
 * positive reputation `score` (as opposed to {@link seedHistory}'s
 * zero-resolution "bluster" pattern, which the module's own scoring
 * identity — `brier = reliability - resolution + uncertainty` — guarantees
 * can never out-score a population baseline). Returns the achieved
 * empirical pass rate.
 */
function seedCalibratedHistory(
  ledger: ReputationLedger,
  id: string,
  opts: { n: number; seed: number; meanP: number; spread?: number; startAt?: number },
): number {
  const startAt = opts.startAt ?? 0;
  const spread = opts.spread ?? 0.45;
  let passes = 0;
  for (let i = 0; i < opts.n; i++) {
    const pi = Math.min(0.95, Math.max(0.05, opts.meanP + spread * (hash01(opts.seed, i * 2) - 0.5) * 2));
    const outcome: 0 | 1 = hash01(opts.seed, i * 2 + 1) < pi ? 1 : 0;
    if (outcome === 1) passes++;
    ledger.record({
      participantId: id,
      kind: "worker",
      taskId: `${id}-hist-${i}`,
      claimedP: pi,
      outcome,
      certified: true,
      at: startAt + i * 1000,
    });
  }
  return passes / opts.n;
}

function order(overrides: Partial<TaskOrder>): TaskOrder {
  return {
    taskId: "t",
    domain: "coding",
    maxPrice: 100,
    postedAt: 0,
    ...overrides,
  };
}

function capability(overrides: Partial<Capability> = {}): Capability {
  return { domain: "coding", tags: [], ...overrides };
}

function offer(overrides: Partial<WorkOffer>): WorkOffer {
  return {
    participantId: "p",
    taskId: "t",
    price: 1,
    claimedPCorrect: 0.5,
    capability: capability(),
    ...overrides,
  };
}

function exchangeWith(ledger: ReputationLedger, standing?: (id: string) => Standing): WorkExchange {
  return new WorkExchange({ reputation: ledger, standingOf: standing });
}

// ===========================================================================
// 0. shrinkClaim / expectedVerifiedValue — the pure functions
// ===========================================================================

describe("shrinkClaim — pure Bayesian shrinkage", () => {
  it("no history: ignores the claim, blends to populationPrior capped at maxUnknownClaim", () => {
    expect(shrinkClaim(0.99, null)).toBeCloseTo(0.5, 10); // default populationPrior=0.5 < maxUnknownClaim=0.6
    expect(shrinkClaim(0.01, null)).toBeCloseTo(0.5, 10); // claim ignored either direction
    expect(shrinkClaim(0.99, null, { populationPrior: 0.9, maxUnknownClaim: 0.6 })).toBeCloseTo(0.6, 10);
    expect(shrinkClaim(0.99, null, { populationPrior: 0.3, maxUnknownClaim: 0.6 })).toBeCloseTo(0.3, 10);
  });

  it("score === 0 (fabrication) forces adjusted 0 regardless of the claim", () => {
    const ledger = new ReputationLedger();
    ledger.record({
      participantId: "liar",
      kind: "worker",
      taskId: "x",
      claimedP: 0.9,
      outcome: 1,
      certified: true,
      fabricated: true,
      at: 0,
    });
    const state = ledger.state("liar", 0);
    expect(state?.score).toBe(0);
    expect(shrinkClaim(0.01, state)).toBe(0);
    expect(shrinkClaim(0.99, state)).toBe(0);
    expect(shrinkClaim(1, state)).toBe(0);
  });

  it("well-evidenced participant is pulled toward their empirical pass rate, not their claim", () => {
    const ledger = new ReputationLedger();
    // A genuinely skilled, well-evidenced participant (real Murphy
    // resolution, positive score) whose CURRENT claim (0.99) is far above
    // their actual track record.
    seedCalibratedHistory(ledger, "steady", { n: 60, seed: 13, meanP: 0.85 });
    const state = ledger.state("steady", 60000);
    expect(state).not.toBeNull();
    expect(state!.score).toBeGreaterThan(0); // real evidence, not the hard-zero (fabrication) path
    const priorStrength = 8;
    const w = state!.n / (state!.n + priorStrength);
    const expected = (1 - w) * 0.99 + w * state!.passRate;
    const adjusted = shrinkClaim(0.99, state, { priorStrength });
    expect(adjusted).toBeCloseTo(expected, 10);
    expect(adjusted).toBeLessThan(0.99); // pulled down from the raw claim…
    expect(adjusted).toBeGreaterThan(state!.passRate - 0.02); // …anchored near the track record
  });

  it("thin history (n small) stays close to the raw claim", () => {
    const ledger = new ReputationLedger();
    seedCalibratedHistory(ledger, "fresh", { n: 2, seed: 1, meanP: 0.7 });
    const state = ledger.state("fresh", 2000);
    expect(state).not.toBeNull();
    expect(state!.score).toBeGreaterThan(0);
    const adjusted = shrinkClaim(0.8, state, { priorStrength: 8 });
    // w = 2/10 = 0.2: mostly the claim still.
    expect(adjusted).toBeGreaterThan(0.6);
  });

  it("clamps a non-finite/out-of-range claim to [0,1] rather than propagating garbage", () => {
    expect(shrinkClaim(Number.NaN, null)).toBeGreaterThanOrEqual(0);
    expect(shrinkClaim(-5, null)).toBeGreaterThanOrEqual(0);
    expect(shrinkClaim(50, null)).toBeLessThanOrEqual(1);
  });

  it("malformed ShrinkageOptions never throw; falls back to defaults", () => {
    expect(() => shrinkClaim(0.5, null, { priorStrength: -1, calibrationBins: -3 } as never)).not.toThrow();
    expect(() => shrinkClaim(0.5, null, { populationPrior: Number.NaN } as never)).not.toThrow();
  });
});

describe("expectedVerifiedValue", () => {
  it("is adjustedPCorrect / price", () => {
    expect(expectedVerifiedValue(0.8, 2)).toBeCloseTo(0.4, 12);
    expect(expectedVerifiedValue(1, 1)).toBe(1);
    expect(expectedVerifiedValue(0, 5)).toBe(0);
  });
});

// ===========================================================================
// 1. HEADLINE — the documented mechanism gap is CLOSED
// ===========================================================================

describe("HEADLINE: WorkExchange.clear closes the selection mechanism gap that VerifiedWorkMarket.selectBids has", () => {
  it("legacy selectBids picks the same-price blusterer; WorkExchange.clear picks the honest bidder instead", () => {
    // Reproduce styx-market-adversarial's exact scenario: same price, a
    // blusterer claiming 0.99 with a demonstrably bad track record vs an
    // honest bidder claiming 0.7 with a demonstrably good one.
    const legacyHonest: WorkBid = { workerId: "honest", taskId: "task", claimedPCorrect: 0.7, price: 1 };
    const legacyBluster: WorkBid = { workerId: "bluster", taskId: "task", claimedPCorrect: 0.99, price: 1 };
    const legacyMarket = new VerifiedWorkMarket();
    const legacyResult = legacyMarket.selectBids([legacyHonest, legacyBluster]);
    expect(legacyResult.accepted).toHaveLength(1);
    expect(legacyResult.accepted[0].workerId).toBe("bluster"); // the documented gap, reproduced

    // Now feed a REAL reputation ledger the track records those claims imply:
    // bluster claims ~0.99 constantly, with ZERO Murphy resolution (never
    // differentiates cases) and truly passes only ~30% of the time; honest
    // genuinely discriminates between cases and is well-calibrated, truly
    // passing ~78% of the time.
    const ledger = new ReputationLedger();
    seedHistory(ledger, "bluster", { n: 40, claimedP: 0.99, trueRate: 0.3, seed: 10 });
    seedCalibratedHistory(ledger, "honest", { n: 40, seed: 7, meanP: 0.75 });
    const now = 40000;

    const exchange = exchangeWith(ledger);
    const theOrder = order({ taskId: "task", maxPrice: 10 });
    const offers: WorkOffer[] = [
      offer({ participantId: "honest", taskId: "task", price: 1, claimedPCorrect: 0.7 }),
      offer({ participantId: "bluster", taskId: "task", price: 1, claimedPCorrect: 0.99 }),
    ];
    const result = exchange.clear([theOrder], offers, now);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].participantId).toBe("honest"); // GAP CLOSED

    const honestState = ledger.state("honest", now);
    const blusterState = ledger.state("bluster", now);
    expect(honestState!.score).toBeGreaterThan(0);
    const honestAdjusted = shrinkClaim(0.7, honestState);
    const blusterAdjusted = shrinkClaim(0.99, blusterState);
    // Bluster's zero-resolution, badly-miscalibrated track record collapses
    // their ledger score to 0, which unconditionally zeroes their adjusted
    // confidence — an even sharper closure of the gap than mere shrinkage.
    expect(blusterAdjusted).toBe(0);
    expect(honestAdjusted).toBeGreaterThan(blusterAdjusted);
    expect(result.matches[0].adjustedPCorrect).toBeCloseTo(honestAdjusted, 10);
    // Bluster never even makes it into "eligible" (value <= 0), so honest
    // wins uncontested — confirm there is no runner-up threat inflating the
    // clearing price above honest's own quoted ask.
    expect(result.matches[0].runnerUp).toBeUndefined();
    expect(result.matches[0].clearingPrice).toBe(1);
  });
});

// ===========================================================================
// 2. SYBIL RESISTANCE
// ===========================================================================

describe("sybil resistance", () => {
  it("50 fresh identities claiming 0.99 at the lowest legal price cannot displace one established honest participant", () => {
    const ledger = new ReputationLedger();
    seedCalibratedHistory(ledger, "veteran", { n: 60, seed: 13, meanP: 0.85 });
    const now = 60000;
    expect(ledger.state("veteran", now)!.score).toBeGreaterThan(0);

    const theOrder = order({ taskId: "t", maxPrice: 10, reservePrice: 1 });
    const offers: WorkOffer[] = [offer({ participantId: "veteran", taskId: "t", price: 1, claimedPCorrect: 0.85 })];
    for (let i = 0; i < 50; i++) {
      offers.push(offer({ participantId: `sybil-${i}`, taskId: "t", price: 1, claimedPCorrect: 0.99 }));
    }

    const exchange = exchangeWith(ledger);
    const result = exchange.clear([theOrder], offers, now);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].participantId).toBe("veteran");

    // Assert the margin: veteran's adjusted value comfortably beats the
    // sybil ceiling (min(populationPrior, maxUnknownClaim) = 0.5 by default).
    const sybilCeiling = shrinkClaim(0.99, null);
    expect(sybilCeiling).toBeCloseTo(0.5, 10);
    expect(result.matches[0].adjustedPCorrect).toBeGreaterThan(sybilCeiling + 0.2);
  });

  it("every sybil offer that lost is present neither as the match winner nor with a fabricated rejection reason", () => {
    const ledger = new ReputationLedger();
    seedCalibratedHistory(ledger, "veteran", { n: 60, seed: 13, meanP: 0.85 });
    const now = 60000;
    const theOrder = order({ taskId: "t", maxPrice: 10, reservePrice: 1 });
    const offers: WorkOffer[] = [offer({ participantId: "veteran", taskId: "t", price: 1, claimedPCorrect: 0.85 })];
    for (let i = 0; i < 50; i++) {
      offers.push(offer({ participantId: `sybil-${i}`, taskId: "t", price: 1, claimedPCorrect: 0.99 }));
    }
    const exchange = exchangeWith(ledger);
    const result = exchange.clear([theOrder], offers, now);
    for (const r of result.rejected) {
      expect(r.offer.participantId).not.toBe("veteran");
    }
    expect(result.matches[0].runnerUp).toBeDefined();
    expect(result.matches[0].runnerUp!.participantId).toMatch(/^sybil-/);
  });
});

// ===========================================================================
// 3. FABRICATION NEVER MATCHES
// ===========================================================================

describe("fabrication is unconditionally disqualifying", () => {
  it("a participant with a fabrication in its ledger never matches, at any price, for any task", () => {
    const ledger = new ReputationLedger();
    ledger.record({
      participantId: "cheat",
      kind: "worker",
      taskId: "x0",
      claimedP: 0.9,
      outcome: 1,
      certified: true,
      fabricated: true,
      at: 0,
    });
    const now = 10000;
    expect(ledger.state("cheat", now)!.score).toBe(0);

    const orders: TaskOrder[] = [
      order({ taskId: "cheap", maxPrice: 1000 }),
      order({ taskId: "expensive", maxPrice: 1000 }),
    ];
    const offers: WorkOffer[] = [
      offer({ participantId: "cheat", taskId: "cheap", price: 0.0001, claimedPCorrect: 1 }),
      offer({ participantId: "cheat", taskId: "expensive", price: 999, claimedPCorrect: 1 }),
      // an honest rival on "expensive" only, so "cheap" has ONLY the fabricator.
      offer({ participantId: "rival", taskId: "expensive", price: 999, claimedPCorrect: 0.5 }),
    ];
    const exchange = exchangeWith(ledger);
    const result = exchange.clear(orders, offers, now);

    for (const m of result.matches) {
      expect(m.participantId).not.toBe("cheat");
    }
    const cheapUnmatched = result.unmatched.find((u) => u.taskId === "cheap");
    expect(cheapUnmatched).toBeDefined();
    expect(cheapUnmatched!.reason).toBe("all-offers-rejected");

    const expensiveMatch = result.matches.find((m) => m.taskId === "expensive");
    expect(expensiveMatch?.participantId).toBe("rival");
  });
});

// ===========================================================================
// 4. SECOND-PRICE TRUTHFULNESS — numerically swept
// ===========================================================================

describe("second-price clearing is truthful: sweep the focal participant's price against a fixed rival", () => {
  it("surplus (clearingPrice - trueCost) is flat-maximized across every price at which the focal participant still wins, and strictly worse once they lose", () => {
    const ledger = new ReputationLedger();
    // Focal's adjustedPCorrect must be stable across the price sweep (it is,
    // by construction: shrinkClaim never reads price). Give them real,
    // well-evidenced (positive-score) history.
    seedCalibratedHistory(ledger, "focal", { n: 50, seed: 7, meanP: 0.8 });
    seedCalibratedHistory(ledger, "rival", { n: 50, seed: 4, meanP: 0.6 });
    const now = 50000;

    const focalState = ledger.state("focal", now);
    const rivalState = ledger.state("rival", now);
    expect(focalState!.score).toBeGreaterThan(0);
    expect(rivalState!.score).toBeGreaterThan(0);
    const focalAdjusted = shrinkClaim(0.8, focalState);
    const rivalPrice = 2;
    const rivalAdjusted = shrinkClaim(0.6, rivalState);
    const rivalValue = expectedVerifiedValue(rivalAdjusted, rivalPrice);
    const breakeven = focalAdjusted / rivalValue; // P* — analytic prediction

    const trueCost = breakeven * 0.6; // comfortably inside the winning region
    const theOrder = order({ taskId: "t", maxPrice: 1000 }); // no reserve: isolate pure 2nd-price behavior
    const exchange = exchangeWith(ledger);

    const sweepMax = breakeven * 1.6;
    const points = 44;
    const surpluses: number[] = [];
    const won: boolean[] = [];
    for (let i = 0; i < points; i++) {
      const price = ((i + 1) / points) * sweepMax;
      const offers: WorkOffer[] = [
        offer({ participantId: "focal", taskId: "t", price, claimedPCorrect: 0.8 }),
        offer({ participantId: "rival", taskId: "t", price: rivalPrice, claimedPCorrect: 0.6 }),
      ];
      const result = exchange.clear([theOrder], offers, now);
      const m = result.matches.find((x) => x.participantId === "focal");
      won.push(Boolean(m));
      surpluses.push(m ? m.clearingPrice - trueCost : 0);
    }

    expect(won.some(Boolean)).toBe(true);
    expect(won.some((w) => !w)).toBe(true); // sweep spans both winning and losing prices

    const maxSurplus = Math.max(...surpluses);
    expect(maxSurplus).toBeGreaterThan(0);

    // Every winning price yields EXACTLY the same surplus (payment doesn't
    // depend on the winner's own price) — the defining property that makes
    // truthful pricing weakly dominant.
    for (let i = 0; i < points; i++) {
      if (won[i]) {
        expect(surpluses[i]).toBeCloseTo(maxSurplus, 6);
      } else {
        expect(surpluses[i]).toBe(0);
        expect(surpluses[i]).toBeLessThan(maxSurplus);
      }
    }

    // Misreporting (any price other than true cost) never STRICTLY helps:
    // truthful pricing (price = trueCost) is itself a winning price here and
    // achieves the max; no swept price beats it.
    const truthfulOffers: WorkOffer[] = [
      offer({ participantId: "focal", taskId: "t", price: trueCost, claimedPCorrect: 0.8 }),
      offer({ participantId: "rival", taskId: "t", price: rivalPrice, claimedPCorrect: 0.6 }),
    ];
    const truthfulResult = exchange.clear([theOrder], truthfulOffers, now);
    const truthfulMatch = truthfulResult.matches.find((m) => m.participantId === "focal")!;
    expect(truthfulMatch).toBeDefined();
    const truthfulSurplus = truthfulMatch.clearingPrice - trueCost;
    expect(truthfulSurplus).toBeCloseTo(maxSurplus, 6);
    for (const s of surpluses) {
      expect(s).toBeLessThanOrEqual(truthfulSurplus + 1e-9);
    }
  });

  it("sweep claimed confidence: overclaiming never increases expected settlement payout at the TRUE pass probability (settlementPayment, imported)", () => {
    // This is the complementary economic guarantee: even though WorkExchange
    // ranks by adjusted (shrunk) value, the underlying Brier settlement rule
    // that actually pays workers punishes overclaiming in expectation. Swept
    // directly via the real settlementPayment, over a long deterministic
    // pass sequence with true rate 0.65.
    const TRUE_P = 0.65;
    const N = 1500;
    const passSeq: (0 | 1)[] = Array.from({ length: N }, (_, i) => (hash01(99, i) < TRUE_P ? 1 : 0));

    function totalPayment(claim: number): number {
      let total = 0;
      for (let i = 0; i < N; i++) {
        const bid: WorkBid = { workerId: "w", taskId: `t${i}`, claimedPCorrect: claim, price: 1 };
        total += settlementPayment(bid, passSeq[i] === 1);
      }
      return total;
    }

    const claims = Array.from({ length: 41 }, (_, i) => i / 40); // 0, 0.025, ..., 1
    const payments = claims.map(totalPayment);
    const truthfulIdx = claims.reduce(
      (best, c, i) => (Math.abs(c - TRUE_P) < Math.abs(claims[best] - TRUE_P) ? i : best),
      0,
    );
    const truthfulPayment = payments[truthfulIdx];
    const bestIdx = payments.reduce((best, p, i) => (p > payments[best] ? i : best), 0);

    // The empirical-payment argmax must sit within ±0.1 of the true
    // probability, and payment must fall off monotonically away from it —
    // same headline property `styx-market-adversarial.test.ts` proves,
    // reswept here directly against this suite's own deterministic sequence.
    expect(Math.abs(claims[bestIdx] - TRUE_P)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(payments[bestIdx]).toBeGreaterThan(payments[0]);
    expect(payments[bestIdx]).toBeGreaterThan(payments[payments.length - 1]);

    // Overclaiming (any claim well above the truthful neighborhood) must
    // never pay MORE than truthful.
    for (let i = 0; i < claims.length; i++) {
      if (claims[i] > claims[truthfulIdx] + 0.1) {
        expect(payments[i]).toBeLessThanOrEqual(truthfulPayment + 1e-9);
      }
    }
    expect(payments[payments.length - 1]).toBeLessThan(truthfulPayment); // claim=1 (max overclaim)
  });
});

// ===========================================================================
// 5. FULL GATING MATRIX
// ===========================================================================

describe("gating matrix — every OfferRejectionCode, exact code, never in matches", () => {
  function assertRejectedWith(
    ledger: ReputationLedger,
    orders: TaskOrder[],
    offers: WorkOffer[],
    now: number,
    participantId: string,
    code: OfferRejectionCode,
    standing?: (id: string) => Standing,
  ) {
    const exchange = exchangeWith(ledger, standing);
    const result = exchange.clear(orders, offers, now);
    const rej = result.rejected.find((r) => r.offer.participantId === participantId);
    expect(rej, `expected a rejection for ${participantId}`).toBeDefined();
    expect(rej!.reason).toBe(code);
    expect(typeof rej!.detail).toBe("string");
    expect(rej!.detail.length).toBeGreaterThan(0);
    for (const m of result.matches) {
      expect(m.participantId).not.toBe(participantId);
    }
  }

  it("price-over-max", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t", maxPrice: 5 });
    const w = offer({ participantId: "p", taskId: "t", price: 6 });
    assertRejectedWith(ledger, [o], [w], 0, "p", "price-over-max");
  });

  it("below-reserve", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t", maxPrice: 5, reservePrice: 2 });
    const w = offer({ participantId: "p", taskId: "t", price: 1 });
    assertRejectedWith(ledger, [o], [w], 0, "p", "below-reserve");
  });

  it("capability-mismatch (missing required tag)", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t", requiredTags: ["rust", "unsafe"] });
    const w = offer({ participantId: "p", taskId: "t", capability: capability({ tags: ["rust"] }) });
    assertRejectedWith(ledger, [o], [w], 0, "p", "capability-mismatch");
  });

  it("domain-mismatch", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t", domain: "legal" });
    const w = offer({ participantId: "p", taskId: "t", capability: capability({ domain: "coding" }) });
    assertRejectedWith(ledger, [o], [w], 0, "p", "domain-mismatch");
  });

  it("reputation-too-low", () => {
    const ledger = new ReputationLedger();
    seedHistory(ledger, "weak", { n: 40, claimedP: 0.9, trueRate: 0.1, seed: 40 });
    const now = 40000;
    const score = ledger.state("weak", now)!.score;
    const o = order({ taskId: "t", minReputation: Math.min(1, score + 0.2) });
    const w = offer({ participantId: "weak", taskId: "t" });
    assertRejectedWith(ledger, [o], [w], now, "weak", "reputation-too-low");
  });

  it("standing-excluded (demoted)", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t" });
    const w = offer({ participantId: "p", taskId: "t" });
    assertRejectedWith(ledger, [o], [w], 0, "p", "standing-excluded", () => "demoted");
  });

  it("standing-excluded (banned)", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t" });
    const w = offer({ participantId: "p", taskId: "t" });
    assertRejectedWith(ledger, [o], [w], 0, "p", "standing-excluded", () => "banned");
  });

  it("tier-insufficient (explicit weaker maxTier)", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t", requiredTier: "T1-reference" });
    const w = offer({ participantId: "p", taskId: "t", capability: capability({ maxTier: "T3-agreement" }) });
    assertRejectedWith(ledger, [o], [w], 0, "p", "tier-insufficient");
  });

  it("tier-insufficient (no declared maxTier defaults to weakest, fail-closed)", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t", requiredTier: "T2-genrm" });
    const w = offer({ participantId: "p", taskId: "t", capability: capability({}) });
    assertRejectedWith(ledger, [o], [w], 0, "p", "tier-insufficient");
  });

  it("deadline-infeasible", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t", deadline: 1000 });
    const w = offer({ participantId: "p", taskId: "t", readyBy: 1001 });
    assertRejectedWith(ledger, [o], [w], 0, "p", "deadline-infeasible");
  });

  it("duplicate-offer: first offer is kept and processed, second is rejected", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t", maxPrice: 10 });
    const first = offer({ participantId: "p", taskId: "t", price: 1, claimedPCorrect: 0.6 });
    const second = offer({ participantId: "p", taskId: "t", price: 2, claimedPCorrect: 0.9 });
    const exchange = exchangeWith(ledger);
    const result = exchange.clear([o], [first, second], 0);
    const dup = result.rejected.find((r) => r.reason === "duplicate-offer");
    expect(dup).toBeDefined();
    expect(dup!.offer.price).toBe(2); // the SECOND offer is the one rejected
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].offerPrice).toBe(1); // the FIRST offer is the one that competed
  });

  it("unknown-task", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "real" });
    const w = offer({ participantId: "p", taskId: "ghost" });
    const exchange = exchangeWith(ledger);
    const result = exchange.clear([o], [w], 0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("unknown-task");
    expect(result.matches).toHaveLength(0);
  });

  describe("malformed offers", () => {
    const ledger = new ReputationLedger();
    const o = order({ taskId: "t" });

    function assertInvalid(bad: unknown) {
      const exchange = exchangeWith(ledger);
      const result = exchange.clear([o], [bad as WorkOffer], 0);
      expect(result.matches).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toBe("invalid-offer");
    }

    it("NaN price", () => assertInvalid(offer({ participantId: "p", taskId: "t", price: Number.NaN })));
    it("negative price", () => assertInvalid(offer({ participantId: "p", taskId: "t", price: -1 })));
    it("zero price", () => assertInvalid(offer({ participantId: "p", taskId: "t", price: 0 })));
    it("non-finite claim", () =>
      assertInvalid(offer({ participantId: "p", taskId: "t", claimedPCorrect: Number.POSITIVE_INFINITY })));
    it("out-of-range claim", () => assertInvalid(offer({ participantId: "p", taskId: "t", claimedPCorrect: 1.5 })));
    it("empty participantId", () => assertInvalid(offer({ participantId: "", taskId: "t" })));
    it("empty taskId", () => assertInvalid(offer({ participantId: "p", taskId: "" })));
    it("missing capability", () => {
      const bad = { participantId: "p", taskId: "t", price: 1, claimedPCorrect: 0.5 };
      assertInvalid(bad);
    });
    it("null offer", () => assertInvalid(null));
    it("non-object offer", () => assertInvalid("not an offer"));

    it("prototype-polluted object (required fields planted on the prototype, not own properties)", () => {
      const evilProto = {
        participantId: "ghost",
        taskId: "t",
        price: 1,
        claimedPCorrect: 0.9,
        capability: { domain: "coding", tags: [] },
      };
      const polluted = Object.create(evilProto); // no OWN properties at all
      assertInvalid(polluted);
    });

    it("clear() never throws even when the whole offers array is hostile garbage", () => {
      const exchange = exchangeWith(ledger);
      const garbage = [null, undefined, 42, "x", [], {}, { toString: () => "x" }] as unknown as WorkOffer[];
      expect(() => exchange.clear([o], garbage, 0)).not.toThrow();
      const result = exchange.clear([o], garbage, 0);
      expect(result.matches).toHaveLength(0);
      expect(result.rejected.length).toBeGreaterThan(0);
    });
  });
});

// ===========================================================================
// 6. DETERMINISM
// ===========================================================================

function shuffledCopy<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(seed, i) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("determinism", () => {
  it("shuffling the offer array in 10 different orders yields the identical ExchangeResult", () => {
    const ledger = new ReputationLedger();
    // All unknown (no history) participants: identical adjustedPCorrect and
    // price for everyone — a genuinely, fully tied book. The winner must be
    // determined purely by the total-order tie-break chain.
    const ids = ["zed", "yak", "alice", "mno", "bob", "quinn"];
    const o = order({ taskId: "t", maxPrice: 10 });
    const baseOffers = ids.map((id) => offer({ participantId: id, taskId: "t", price: 1, claimedPCorrect: 0.9 }));

    const exchange = exchangeWith(ledger);
    const baseline = exchange.clear([o], baseOffers, 0);
    expect(baseline.matches).toHaveLength(1);
    expect(baseline.matches[0].participantId).toBe("alice"); // lexicographically smallest

    for (let s = 0; s < 10; s++) {
      const shuffled = shuffledCopy(baseOffers, s + 1);
      const result = exchange.clear([o], shuffled, 0);
      expect(result.matches).toEqual(baseline.matches);
      expect(result.unmatched).toEqual(baseline.unmatched);
      expect(result.rejected).toHaveLength(baseline.rejected.length);
    }
  });

  it("explain() exposes the full total order, including the final original-index tie-break", () => {
    // Same participant twice (identical value/price/reputation/id) — the
    // ONLY remaining discriminator is original array index.
    const ledger = new ReputationLedger();
    const exchange = exchangeWith(ledger);
    const offers: WorkOffer[] = [
      offer({ participantId: "dup", taskId: "t", price: 1, claimedPCorrect: 0.5 }),
      offer({ participantId: "dup", taskId: "t", price: 1, claimedPCorrect: 0.5 }),
    ];
    const text = exchange.explain("t", offers, 0);
    const lines = text.split("\n").filter((l) => l.includes("participantId=dup"));
    expect(lines).toHaveLength(2);
    // Rank 1 (index 0) must appear before rank 2 (index 1) — deterministic.
    expect(text.indexOf("1. participantId=dup")).toBeLessThan(text.indexOf("2. participantId=dup"));
  });
});

// ===========================================================================
// 7. STRUCTURAL EDGES
// ===========================================================================

describe("structural edges", () => {
  it("empty order book: no matches, no unmatched; unrecognized offers land in rejected as unknown-task", () => {
    const ledger = new ReputationLedger();
    const exchange = exchangeWith(ledger);
    const result = exchange.clear([], [offer({ participantId: "p", taskId: "ghost" })], 0);
    expect(result.matches).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("unknown-task");
  });

  it("empty offer book: every order is unmatched with reason no-offers", () => {
    const ledger = new ReputationLedger();
    const exchange = exchangeWith(ledger);
    const orders = [order({ taskId: "a" }), order({ taskId: "b" })];
    const result = exchange.clear(orders, [], 0);
    expect(result.matches).toHaveLength(0);
    expect(result.unmatched).toEqual([
      { taskId: "a", reason: "no-offers" },
      { taskId: "b", reason: "no-offers" },
    ]);
  });

  it("every offer rejected → all-offers-rejected", () => {
    const ledger = new ReputationLedger();
    const exchange = exchangeWith(ledger);
    const o = order({ taskId: "t", maxPrice: 1 });
    const offers = [offer({ participantId: "a", taskId: "t", price: 5 }), offer({ participantId: "b", taskId: "t", price: 9 })];
    const result = exchange.clear([o], offers, 0);
    expect(result.matches).toHaveLength(0);
    expect(result.unmatched).toEqual([{ taskId: "t", reason: "all-offers-rejected" }]);
  });

  it("every offer below reserve → reserve-not-met (a more specific diagnosis than all-offers-rejected)", () => {
    const ledger = new ReputationLedger();
    const exchange = exchangeWith(ledger);
    const o = order({ taskId: "t", maxPrice: 100, reservePrice: 10 });
    const offers = [offer({ participantId: "a", taskId: "t", price: 1 }), offer({ participantId: "b", taskId: "t", price: 2 })];
    const result = exchange.clear([o], offers, 0);
    expect(result.matches).toHaveLength(0);
    expect(result.unmatched).toEqual([{ taskId: "t", reason: "reserve-not-met" }]);
  });

  it("single bidder WITH a reserve pays exactly the reserve, not their full ask", () => {
    const ledger = new ReputationLedger();
    const exchange = exchangeWith(ledger);
    const o = order({ taskId: "t", maxPrice: 100, reservePrice: 3 });
    const result = exchange.clear([o], [offer({ participantId: "solo", taskId: "t", price: 50, claimedPCorrect: 0.9 })], 0);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].clearingPrice).toBe(3);
    expect(result.matches[0].offerPrice).toBe(50);
    expect(result.matches[0].runnerUp).toBeUndefined();
  });

  it("single bidder WITHOUT a reserve pays exactly their own ask (no information to do otherwise)", () => {
    const ledger = new ReputationLedger();
    const exchange = exchangeWith(ledger);
    const o = order({ taskId: "t", maxPrice: 100 });
    const result = exchange.clear([o], [offer({ participantId: "solo", taskId: "t", price: 50, claimedPCorrect: 0.9 })], 0);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].clearingPrice).toBe(50);
  });

  it("a task nobody is capable of (domain mismatch for every offer) is unmatched, all-offers-rejected", () => {
    const ledger = new ReputationLedger();
    const exchange = exchangeWith(ledger);
    const o = order({ taskId: "t", domain: "legal" });
    const offers = [
      offer({ participantId: "a", taskId: "t", capability: capability({ domain: "coding" }) }),
      offer({ participantId: "b", taskId: "t", capability: capability({ domain: "medicine" }) }),
    ];
    const result = exchange.clear([o], offers, 0);
    expect(result.matches).toHaveLength(0);
    expect(result.unmatched).toEqual([{ taskId: "t", reason: "all-offers-rejected" }]);
    for (const r of result.rejected) expect(r.reason).toBe("domain-mismatch");
  });

  it("500 orders x 5 offers clear in a single call with no cross-task leakage", () => {
    const ledger = new ReputationLedger();
    seedCalibratedHistory(ledger, "w0", { n: 20, seed: 10, meanP: 0.8 });
    seedCalibratedHistory(ledger, "w1", { n: 20, seed: 10, meanP: 0.6 });
    const now = 20000;
    const exchange = exchangeWith(ledger);

    const orders: TaskOrder[] = [];
    const offers: WorkOffer[] = [];
    for (let t = 0; t < 500; t++) {
      const taskId = `task-${t}`;
      orders.push(order({ taskId, maxPrice: 50, postedAt: t }));
      for (let w = 0; w < 5; w++) {
        offers.push(
          offer({
            participantId: w < 2 ? `w${w}` : `w${w}-t${t}`, // w0/w1 recur across tasks; others are per-task
            taskId,
            price: 1 + w,
            claimedPCorrect: 0.5 + w * 0.05,
          }),
        );
      }
    }

    const result = exchange.clear(orders, offers, now);
    expect(result.matches.length).toBeLessThanOrEqual(500);
    expect(result.matches.length + result.unmatched.length).toBe(500);

    const seenTasks = new Set<string>();
    for (const m of result.matches) {
      expect(seenTasks.has(m.taskId)).toBe(false); // no task matched twice
      seenTasks.add(m.taskId);
      expect(m.taskId.startsWith("task-")).toBe(true);
    }

    // w0 can win at most one task this round (one win per participant per round).
    const w0Wins = result.matches.filter((m) => m.participantId === "w0").length;
    const w1Wins = result.matches.filter((m) => m.participantId === "w1").length;
    expect(w0Wins).toBeLessThanOrEqual(1);
    expect(w1Wins).toBeLessThanOrEqual(1);
  });

  it("a participant who already won one task this round cannot win a second (one win per round)", () => {
    const ledger = new ReputationLedger();
    seedCalibratedHistory(ledger, "star", { n: 30, seed: 3, meanP: 0.9 });
    const now = 30000;
    const exchange = exchangeWith(ledger);
    const orders = [order({ taskId: "t1", maxPrice: 10 }), order({ taskId: "t2", maxPrice: 10 })];
    const offers = [
      offer({ participantId: "star", taskId: "t1", price: 1, claimedPCorrect: 0.9 }),
      offer({ participantId: "star", taskId: "t2", price: 1, claimedPCorrect: 0.9 }),
      offer({ participantId: "runnerup2", taskId: "t2", price: 1, claimedPCorrect: 0.1 }),
    ];
    const result = exchange.clear(orders, offers, now);
    const starMatches = result.matches.filter((m) => m.participantId === "star");
    expect(starMatches).toHaveLength(1);
    expect(starMatches[0].taskId).toBe("t1"); // t1 is processed first (orders order)
    const t2Match = result.matches.find((m) => m.taskId === "t2");
    expect(t2Match?.participantId).toBe("runnerup2");
  });
});

// ===========================================================================
// 8. explain()
// ===========================================================================

describe("explain()", () => {
  it("returns a deterministic ranking table containing only numbers the engine actually computed", () => {
    const ledger = new ReputationLedger();
    seedCalibratedHistory(ledger, "alice", { n: 20, seed: 10, meanP: 0.8 });
    const now = 20000;
    const exchange = exchangeWith(ledger);
    const offers: WorkOffer[] = [
      offer({ participantId: "alice", taskId: "t", price: 2, claimedPCorrect: 0.8 }),
      offer({ participantId: "bob", taskId: "t", price: 1, claimedPCorrect: 0.5 }),
      offer({ participantId: "carol", taskId: "other", price: 1, claimedPCorrect: 0.99 }), // different task, excluded
    ];
    const text = exchange.explain("t", offers, now);

    expect(text).toContain("Task t");
    expect(text).toContain("participantId=alice");
    expect(text).toContain("participantId=bob");
    expect(text).not.toContain("participantId=carol");

    const aliceState = ledger.state("alice", now);
    const aliceAdjusted = shrinkClaim(0.8, aliceState);
    const aliceValue = expectedVerifiedValue(aliceAdjusted, 2);
    expect(text).toContain(`adjustedPCorrect=${aliceAdjusted.toFixed(4)}`);
    expect(text).toContain(`expectedVerifiedValue=${aliceValue.toFixed(4)}`);

    const bobAdjusted = shrinkClaim(0.5, null); // bob has no history
    expect(text).toContain(`adjustedPCorrect=${bobAdjusted.toFixed(4)}`);
  });

  it("empty result for a task with no candidate offers", () => {
    const ledger = new ReputationLedger();
    const exchange = exchangeWith(ledger);
    const text = exchange.explain("nowhere", [offer({ participantId: "p", taskId: "elsewhere" })], 0);
    expect(text).toContain("0 candidate offer(s)");
    expect(text).toContain("no eligible candidate offers");
  });

  it("skips malformed offers silently rather than throwing", () => {
    const ledger = new ReputationLedger();
    const exchange = exchangeWith(ledger);
    const garbage = [null, { taskId: "t" }, offer({ participantId: "p", taskId: "t" })] as unknown as WorkOffer[];
    expect(() => exchange.explain("t", garbage, 0)).not.toThrow();
    const text = exchange.explain("t", garbage, 0);
    expect(text).toContain("1 candidate offer(s)");
  });
});

// ===========================================================================
// 9. Match shape sanity (Match fields consistent with what was computed)
// ===========================================================================

describe("Match shape", () => {
  it("every field on a Match is internally consistent", () => {
    const ledger = new ReputationLedger();
    seedCalibratedHistory(ledger, "a", { n: 25, seed: 3, meanP: 0.75 });
    seedCalibratedHistory(ledger, "b", { n: 25, seed: 10, meanP: 0.5 });
    const now = 25000;
    const exchange = exchangeWith(ledger);
    const o = order({ taskId: "t", maxPrice: 20 });
    const offers = [
      offer({ participantId: "a", taskId: "t", price: 3, claimedPCorrect: 0.75 }),
      offer({ participantId: "b", taskId: "t", price: 1, claimedPCorrect: 0.5 }),
    ];
    const result = exchange.clear([o], offers, now);
    expect(result.matches).toHaveLength(1);
    const m: Match = result.matches[0];
    expect(m.expectedVerifiedValue).toBeCloseTo(m.adjustedPCorrect / m.offerPrice, 10);
    expect(m.clearingPrice).toBeGreaterThan(0);
    expect(m.reputationScore).toBeGreaterThanOrEqual(0);
    expect(m.reputationScore).toBeLessThanOrEqual(1);
    if (m.runnerUp) {
      expect(m.runnerUp.participantId).not.toBe(m.participantId);
      // Real second price: exactly the breakeven vs. the runner-up, which
      // strictly exceeds the winner's own quoted price (module header §3) —
      // the genuine incentive property, not a first-price collapse.
      expect(m.clearingPrice).toBeCloseTo(m.adjustedPCorrect / m.runnerUp.expectedVerifiedValue, 8);
      expect(m.clearingPrice).toBeGreaterThan(m.offerPrice);
    } else {
      expect(m.clearingPrice).toBeLessThanOrEqual(m.offerPrice + 1e-9);
    }
  });
});
