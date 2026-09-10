/**
 * ADVERSARIAL VERIFICATION of the Styx S5 Verified-Work Market
 * (`src/hades/styx/market.ts`): `settlementPayment`, `VerifiedWorkMarket`
 * (selectBids / settle / ledger / stats), certificate gating, and the
 * Brier-style incentive mechanism.
 *
 * These tests do NOT try to make the market look good. They ATTACK the
 * economics:
 *
 *   1. INCENTIVE COMPATIBILITY IS REAL (headline) — strategic workers with a
 *      true pass-rate p = 0.7 over a long deterministic (hash-based) pass/fail
 *      sequence. If lying (over- or under-claiming) earns more total money
 *      than truth-telling, the mechanism is broken and these assertions FAIL.
 *      A full sweep over claims c ∈ {0.1..0.9} must put the empirical
 *      payment argmax within ±0.1 of p.
 *   2. CERTIFICATE GATING CANNOT BE BYPASSED — verifiedPass=true but
 *      certified=false must pay exactly 0 with reason "uncertified", for any
 *      claim. No certificate, no money.
 *   3. SELECTION REWARDS VALUE, NOT BLUSTER — and the KNOWN MECHANISM GAP:
 *      selection ranks by CLAIMED confidence / price, so a same-price
 *      blusterer beats an honest lower claim at selection — then bleeds money
 *      at settlement. Both facts are asserted; this is the designed two-stage
 *      defense (selection is claim-gullible, settlement is claim-punishing).
 *   4. CONSERVATION + LEDGER HONESTY — totalPaid <= totalPriced, no negative
 *      payments, paymentsByWorker sums to totalPaid, truthfulnessGap exposes
 *      the overclaimer.
 *   5. EDGE/ROBUSTNESS — invalid bids rejected with reasons, clamping
 *      contract, determinism, maxPricePerTask enforcement.
 *
 * Fully deterministic: no Math.random, no clock, no I/O.
 */

import { describe, expect, it } from "vitest";
import {
  settlementPayment,
  VerifiedWorkMarket,
  type LedgerEntry,
  type WorkBid,
  type WorkExecutor,
  type WorkResult,
} from "../styx/market";

// ---------------------------------------------------------------------------
// Deterministic pass/fail sequence with empirical pass-rate ~ 0.7.
// Integer hash (splitmix-style avalanche) — no Math.random anywhere.
// ---------------------------------------------------------------------------

const TRUE_P = 0.7;
const N_TASKS = 2000;

function hash01(i: number): number {
  let x = (i + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296; // [0, 1)
}

/** True iff task i passes verification. Deterministic, rate ≈ TRUE_P. */
const passesAt = (i: number): boolean => hash01(i) < TRUE_P;

const PASS_SEQUENCE: boolean[] = Array.from({ length: N_TASKS }, (_, i) => passesAt(i));
const EMPIRICAL_RATE = PASS_SEQUENCE.filter(Boolean).length / N_TASKS;

function bid(workerId: string, taskId: string, claimedPCorrect: number, price: number): WorkBid {
  return { workerId, taskId, claimedPCorrect, price };
}

/** Total realized payment for a fixed claim over the shared pass sequence. */
function totalPaymentForClaim(claim: number, price = 1): number {
  let total = 0;
  for (let i = 0; i < N_TASKS; i++) {
    total += settlementPayment(bid("w", `t${i}`, claim, price), PASS_SEQUENCE[i]);
  }
  return total;
}

// ---------------------------------------------------------------------------
// 1. INCENTIVE COMPATIBILITY IS REAL (headline)
// ---------------------------------------------------------------------------

describe("S5 market — 1. incentive compatibility under strategic play", () => {
  it("the deterministic pass sequence really has empirical rate ≈ 0.7", () => {
    expect(N_TASKS).toBeGreaterThanOrEqual(1000);
    expect(Math.abs(EMPIRICAL_RATE - TRUE_P)).toBeLessThan(0.02);
  });

  it("truthful worker (claims 0.7) out-earns both the overclaimer (0.99) and the underclaimer (0.3)", () => {
    const truthful = totalPaymentForClaim(0.7);
    const overclaimer = totalPaymentForClaim(0.99);
    const underclaimer = totalPaymentForClaim(0.3);

    // If either liar earns >= the truth-teller, the scoring rule is NOT
    // proper in practice and the market is economically broken.
    expect(truthful).toBeGreaterThan(overclaimer);
    expect(truthful).toBeGreaterThan(underclaimer);

    // The gap must be economically material, not float noise: with
    // pay-per-task in [0,1] and n=2000, Brier theory predicts a gap of
    // n*(c-p)^2 ≈ 168 vs the overclaimer and ≈ 320 vs the underclaimer.
    expect(truthful - overclaimer).toBeGreaterThan(50);
    expect(truthful - underclaimer).toBeGreaterThan(50);
  });

  it("sweep c ∈ {0.1..0.9}: empirical-payment argmax is within ±0.1 of the true p = 0.7", () => {
    const claims = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    let bestClaim = claims[0];
    let bestPay = -Infinity;
    for (const c of claims) {
      const pay = totalPaymentForClaim(c);
      if (pay > bestPay) {
        bestPay = pay;
        bestClaim = c;
      }
    }
    // Argmax of realized payment must sit at the worker's true skill level.
    expect(Math.abs(bestClaim - TRUE_P)).toBeLessThanOrEqual(0.1 + 1e-12);
    // And payment must be strictly unimodal-decreasing away from p on this
    // grid — otherwise a strategic worker finds a profitable deviation.
    expect(totalPaymentForClaim(0.7)).toBeGreaterThan(totalPaymentForClaim(0.9));
    expect(totalPaymentForClaim(0.7)).toBeGreaterThan(totalPaymentForClaim(0.5));
  });

  it("full market run: truthful worker's ledger earnings beat both liars end-to-end", () => {
    // Same true skill (the shared pass sequence), separate tasks per worker
    // so all three get settled; identical prices.
    const market = new VerifiedWorkMarket();
    const workers: Array<[string, number]> = [
      ["truthful", 0.7],
      ["overclaimer", 0.99],
      ["underclaimer", 0.3],
    ];
    const taskIndex = (taskId: string): number => Number(taskId.split("#")[1]);
    const exec: WorkExecutor = (b): WorkResult => ({
      output: `work:${b.taskId}`,
      certified: true,
      verifiedPass: passesAt(taskIndex(b.taskId)),
    });

    for (let i = 0; i < N_TASKS; i++) {
      const round: WorkBid[] = workers.map(([w, c]) => bid(w, `${w}#${i}`, c, 1));
      market.settle(round, exec);
    }

    const { paymentsByWorker } = market.stats();
    expect(paymentsByWorker.truthful).toBeGreaterThan(paymentsByWorker.overclaimer);
    expect(paymentsByWorker.truthful).toBeGreaterThan(paymentsByWorker.underclaimer);
  });
});

// ---------------------------------------------------------------------------
// 2. CERTIFICATE GATING CANNOT BE BYPASSED
// ---------------------------------------------------------------------------

describe("S5 market — 2. certificate gating", () => {
  const lyingExecutor: WorkExecutor = (b): WorkResult => ({
    output: `unverifiable:${b.taskId}`,
    certified: false,
    verifiedPass: true, // executor CLAIMS the work passed…
  });

  it("verifiedPass=true but certified=false pays exactly 0 with reason 'uncertified'", () => {
    const market = new VerifiedWorkMarket();
    const entries = market.settle([bid("cheat", "t0", 0.99, 100)], lyingExecutor);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.accepted).toBe(true);
    expect(entry.certified).toBe(false);
    expect(entry.verifiedPass).toBe(true); // the claim is recorded…
    expect(entry.payment).toBe(0); // …but pays NOTHING
    expect(entry.reason).toBe("uncertified");
  });

  it("no claim value can extract money from uncertified work", () => {
    const market = new VerifiedWorkMarket();
    const claims = [0, 0.1, 0.5, 0.7, 0.99, 1];
    claims.forEach((c, i) => {
      market.settle([bid("cheat", `u${i}`, c, 1000)], lyingExecutor);
    });
    const stats = market.stats();
    expect(stats.totalPaid).toBe(0);
    expect(stats.paymentsByWorker.cheat).toBe(0);
    for (const entry of market.ledger()) {
      expect(entry.payment).toBe(0);
      expect(entry.reason).toBe("uncertified");
    }
  });

  it("certified-but-failed work settles via the Brier rule (confident claim → 0)", () => {
    const market = new VerifiedWorkMarket();
    const failExec: WorkExecutor = () => ({ output: "x", certified: true, verifiedPass: false });
    const [confident] = market.settle([bid("w", "f0", 1, 10)], failExec);
    expect(confident.certified).toBe(true);
    expect(confident.payment).toBe(0); // price * (1 - (1-0)^2) = 0
    expect(confident.reason).toBe("settled: verified fail");

    const [humble] = market.settle([bid("w", "f1", 0.2, 10)], failExec);
    expect(humble.payment).toBeCloseTo(10 * (1 - 0.04), 10); // 9.6
  });
});

// ---------------------------------------------------------------------------
// 3. SELECTION REWARDS VALUE, NOT BLUSTER — and the known two-stage gap
// ---------------------------------------------------------------------------

describe("S5 market — 3. selection economics", () => {
  it("honest (0.8 conf, $1) beats blusterer (0.99 conf, $5): value 0.8 > 0.198", () => {
    const market = new VerifiedWorkMarket();
    const honest = bid("honest", "task", 0.8, 1);
    const bluster = bid("bluster", "task", 0.99, 5);
    const { accepted, rejected } = market.selectBids([bluster, honest]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].workerId).toBe("honest");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].bid.workerId).toBe("bluster");
    expect(rejected[0].reason).toBe("outbid");
  });

  it("KNOWN MECHANISM GAP: at equal price, selection favors the CLAIMED-confidence liar", () => {
    // Selection uses claimedPCorrect/price — it cannot see true skill. A
    // blusterer who matches the honest price wins the auction every time.
    // This is asserted deliberately: stage 1 of the defense is gullible.
    const market = new VerifiedWorkMarket();
    const honest = bid("honest", "task", 0.7, 1);
    const bluster = bid("bluster", "task", 0.99, 1);
    const { accepted, rejected } = market.selectBids([honest, bluster]);

    expect(accepted[0].workerId).toBe("bluster"); // liar wins selection…
    expect(rejected[0].bid.workerId).toBe("honest");
    expect(rejected[0].reason).toBe("outbid");
  });

  it("…but stage 2 (settlement) punishes the winner: the liar's per-task take is lower than truthful settlement on identical work", () => {
    // Both workers have the SAME true pass process (p ≈ 0.7). The blusterer
    // wins every same-price auction, yet earns less per task than the
    // truthful claim would have settled for on the very same outcomes.
    const market = new VerifiedWorkMarket();
    const exec: WorkExecutor = (b): WorkResult => ({
      output: "w",
      certified: true,
      verifiedPass: passesAt(Number(b.taskId.slice(1))),
    });

    let truthfulCounterfactual = 0;
    for (let i = 0; i < N_TASKS; i++) {
      const honest = bid("honest", `t${i}`, 0.7, 1);
      const bluster = bid("bluster", `t${i}`, 0.99, 1);
      const entries = market.settle([honest, bluster], exec);
      const settled = entries.find((e) => e.accepted);
      expect(settled?.bid.workerId).toBe("bluster"); // liar takes every task
      truthfulCounterfactual += settlementPayment(honest, PASS_SEQUENCE[i]);
    }

    const { paymentsByWorker, tasksSettled } = market.stats();
    expect(tasksSettled).toBe(N_TASKS);
    expect(paymentsByWorker.honest ?? 0).toBe(0); // outbid everywhere
    // Two-stage defense: selection let the liar in, settlement bled them.
    expect(paymentsByWorker.bluster).toBeLessThan(truthfulCounterfactual);
    expect(truthfulCounterfactual - paymentsByWorker.bluster).toBeGreaterThan(50);
  });

  it("ties on value break by lower price, then lexicographic workerId", () => {
    const market = new VerifiedWorkMarket();
    // Same value 0.4: (0.8, $2) vs (0.4, $1) → lower price wins.
    const cheap = bid("zed", "t", 0.4, 1);
    const dear = bid("abe", "t", 0.8, 2);
    expect(market.selectBids([dear, cheap]).accepted[0].workerId).toBe("zed");
    // Identical value AND price → smaller workerId.
    const a = bid("alice", "u", 0.5, 1);
    const b = bid("bob", "u", 0.5, 1);
    expect(market.selectBids([b, a]).accepted[0].workerId).toBe("alice");
  });
});

// ---------------------------------------------------------------------------
// 4. CONSERVATION + LEDGER HONESTY
// ---------------------------------------------------------------------------

describe("S5 market — 4. conservation and ledger honesty", () => {
  function runMixedMarket(): VerifiedWorkMarket {
    const market = new VerifiedWorkMarket();
    const workers: Array<[string, number]> = [
      ["truthful", 0.7],
      ["overclaimer", 0.99],
      ["underclaimer", 0.3],
    ];
    const exec: WorkExecutor = (b): WorkResult => {
      const i = Number(b.taskId.split("#")[1]);
      return {
        output: "w",
        certified: i % 17 !== 0, // sprinkle uncertified results in too
        verifiedPass: passesAt(i),
      };
    };
    for (let i = 0; i < 600; i++) {
      market.settle(
        workers.map(([w, c]) => bid(w, `${w}#${i}`, c, 1 + (i % 3) * 0.5)),
        exec,
      );
    }
    return market;
  }

  it("totalPaid <= totalPriced and every settled payment is >= 0 and <= its price", () => {
    const market = runMixedMarket();
    const stats = market.stats();
    expect(stats.totalPaid).toBeLessThanOrEqual(stats.totalPriced);
    expect(stats.tasksSettled).toBeGreaterThan(0);
    for (const entry of market.ledger()) {
      if (entry.payment === undefined) continue;
      expect(entry.payment).toBeGreaterThanOrEqual(0);
      // With base=1 the Brier multiplier is in [0,1]: no entry may ever be
      // paid more than its asking price (money conjured from nowhere).
      expect(entry.payment).toBeLessThanOrEqual(entry.bid.price + 1e-12);
      expect(Number.isFinite(entry.payment)).toBe(true);
    }
  });

  it("paymentsByWorker sums exactly to totalPaid", () => {
    const stats = runMixedMarket().stats();
    const sum = Object.values(stats.paymentsByWorker).reduce((a, x) => a + x, 0);
    expect(sum).toBeCloseTo(stats.totalPaid, 8);
  });

  it("truthfulnessGap exposes the overclaimer: gap(overclaimer) > gap(truthful)", () => {
    const { truthfulnessGap } = runMixedMarket().stats();
    expect(truthfulnessGap.overclaimer).toBeGreaterThan(truthfulnessGap.truthful);
    // The truthful worker's calibration error should be small (≈ |0.7 - r|).
    expect(truthfulnessGap.truthful).toBeLessThan(0.05);
    expect(truthfulnessGap.overclaimer).toBeGreaterThan(0.2);
  });

  it("ledger() returns copies — mutating the returned entries cannot cook the books", () => {
    const market = new VerifiedWorkMarket();
    market.settle([bid("w", "t", 0.7, 1)], () => ({
      output: "x",
      certified: true,
      verifiedPass: true,
    }));
    const before = market.stats().totalPaid;
    const leaked = market.ledger();
    leaked[0].payment = 1e9; // attempted ledger tampering
    expect(market.stats().totalPaid).toBe(before);
    expect(market.ledger()[0].payment).not.toBe(1e9);
  });
});

// ---------------------------------------------------------------------------
// 5. EDGE / ROBUSTNESS
// ---------------------------------------------------------------------------

describe("S5 market — 5. edges and robustness", () => {
  const okExec: WorkExecutor = () => ({ output: "x", certified: true, verifiedPass: true });

  it("invalid bids are rejected with explanatory reasons", () => {
    const market = new VerifiedWorkMarket();
    const { accepted, rejected } = market.selectBids([
      bid("w", "t1", 0.5, 0), // price <= 0
      bid("w", "t2", 0.5, -3), // negative price
      bid("w", "t3", 0.5, Number.NaN), // NaN price
      bid("w", "t4", Number.NaN, 1), // NaN confidence → rejected per contract
      bid("", "t5", 0.5, 1), // empty workerId
      bid("w", "", 0.5, 1), // empty taskId
      bid("w", "ok", 0.5, 1), // the one valid bid
    ]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].taskId).toBe("ok");
    expect(rejected).toHaveLength(6);
    const reasonFor = (taskId: string, workerId = "w") =>
      rejected.find((r) => r.bid.taskId === taskId && r.bid.workerId === workerId)?.reason ?? "";
    expect(reasonFor("t1")).toMatch(/invalid price/);
    expect(reasonFor("t2")).toMatch(/invalid price/);
    expect(reasonFor("t3")).toMatch(/invalid price/);
    expect(reasonFor("t4")).toMatch(/invalid claimedPCorrect/);
    expect(reasonFor("t5", "")).toMatch(/invalid workerId/);
    expect(reasonFor("", "w")).toMatch(/invalid taskId/);
  });

  it("settlementPayment: out-of-range confidence clamps to [0,1]; non-finite clamps to 0; bad price throws", () => {
    // clamp high: claim 5 → 1 → full price on a pass
    expect(settlementPayment(bid("w", "t", 5, 2), true)).toBeCloseTo(2, 12);
    // clamp low: claim -3 → 0 → zero on a pass
    expect(settlementPayment(bid("w", "t", -3, 2), true)).toBe(0);
    // non-finite claims clamp to 0 (documented contract) — even +Infinity.
    // So a NaN claim on a FAIL pays full (claim 0 was "right")…
    expect(settlementPayment(bid("w", "t", Number.NaN, 2), false)).toBeCloseTo(2, 12);
    // …and an Infinity claim on a PASS pays 0: absurd claims earn nothing.
    expect(settlementPayment(bid("w", "t", Number.POSITIVE_INFINITY, 2), true)).toBe(0);
    // invalid prices throw RangeError — no silent free money / negative pay
    expect(() => settlementPayment(bid("w", "t", 0.5, 0), true)).toThrow(RangeError);
    expect(() => settlementPayment(bid("w", "t", 0.5, -1), true)).toThrow(RangeError);
    expect(() => settlementPayment(bid("w", "t", 0.5, Number.NaN), true)).toThrow(RangeError);
    // invalid rule bases throw rather than corrupt the payout scale
    expect(() => settlementPayment(bid("w", "t", 0.5, 1), true, { base: 0 })).toThrow(RangeError);
    expect(() => settlementPayment(bid("w", "t", 0.5, 1), true, { base: -2 })).toThrow(RangeError);
  });

  it("custom base scales the rule correctly: base=2, claim=1, fail → price*(2-1)/2", () => {
    expect(settlementPayment(bid("w", "t", 1, 10), false, { base: 2 })).toBeCloseTo(5, 12);
    expect(settlementPayment(bid("w", "t", 1, 10), true, { base: 2 })).toBeCloseTo(10, 12);
  });

  it("maxPricePerTask is enforced at selection with an explicit reason", () => {
    const market = new VerifiedWorkMarket({ maxPricePerTask: 10 });
    const { accepted, rejected } = market.selectBids([
      bid("gouger", "t", 0.99, 11),
      bid("fair", "t", 0.5, 9),
    ]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].workerId).toBe("fair");
    expect(rejected[0].reason).toMatch(/exceeds maxPricePerTask/);
    // constructor also rejects nonsense caps
    expect(() => new VerifiedWorkMarket({ maxPricePerTask: 0 })).toThrow(RangeError);
    expect(() => new VerifiedWorkMarket({ maxPricePerTask: Number.NaN })).toThrow(RangeError);
  });

  it("determinism: two identical markets given identical settles produce identical ledgers and stats", () => {
    const build = (): VerifiedWorkMarket => {
      const m = new VerifiedWorkMarket({ maxPricePerTask: 100 });
      const exec: WorkExecutor = (b): WorkResult => {
        const i = Number(b.taskId.slice(1));
        return { output: `o${i}`, certified: i % 5 !== 0, verifiedPass: passesAt(i) };
      };
      for (let i = 0; i < 200; i++) {
        m.settle(
          [
            bid("alpha", `t${i}`, 0.7, 1),
            bid("beta", `t${i}`, 0.9, 2),
            bid("gamma", `t${i}`, Number.NaN, 1),
          ],
          exec,
        );
      }
      return m;
    };
    const m1 = build();
    const m2 = build();
    expect(JSON.stringify(m1.ledger())).toBe(JSON.stringify(m2.ledger()));
    expect(JSON.stringify(m1.stats())).toBe(JSON.stringify(m2.stats()));
  });

  it("rejected bids appear in the ledger unaccepted, without payments", () => {
    const market = new VerifiedWorkMarket();
    market.settle([bid("w", "t", 0.5, -1)], okExec);
    const entries: LedgerEntry[] = market.ledger();
    expect(entries).toHaveLength(1);
    expect(entries[0].accepted).toBe(false);
    expect(entries[0].payment).toBeUndefined();
    expect(entries[0].reason).toMatch(/invalid price/);
    // Unexecuted bids never count as settled and never move money.
    const stats = market.stats();
    expect(stats.tasksSettled).toBe(0);
    expect(stats.totalPaid).toBe(0);
  });
});
