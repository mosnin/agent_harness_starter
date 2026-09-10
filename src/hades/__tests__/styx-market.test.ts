import { describe, expect, it } from "vitest";

import {
  VerifiedWorkMarket,
  settlementPayment,
  type LedgerEntry,
  type WorkBid,
  type WorkExecutor,
} from "../styx/market";

function bid(workerId: string, taskId: string, claimedPCorrect: number, price: number): WorkBid {
  return { workerId, taskId, claimedPCorrect, price };
}

/** E[pay](c) for true pass probability p, price 1, base 1. */
function expectedPayment(c: number, p: number): number {
  const b: WorkBid = bid("w", "t", c, 1);
  return p * settlementPayment(b, true) + (1 - p) * settlementPayment(b, false);
}

describe("settlementPayment (Brier)", () => {
  it("hand-computed Brier payments", () => {
    // c=1, pass -> full price
    expect(settlementPayment(bid("w", "t", 1, 10), true)).toBeCloseTo(10, 12);
    // c=1, fail -> 0
    expect(settlementPayment(bid("w", "t", 1, 10), false)).toBeCloseTo(0, 12);
    // c=0.5 -> price * 0.75 either way
    expect(settlementPayment(bid("w", "t", 0.5, 4), true)).toBeCloseTo(3, 12);
    expect(settlementPayment(bid("w", "t", 0.5, 4), false)).toBeCloseTo(3, 12);
    // c=0, fail -> full price; c=0, pass -> 0
    expect(settlementPayment(bid("w", "t", 0, 2), false)).toBeCloseTo(2, 12);
    expect(settlementPayment(bid("w", "t", 0, 2), true)).toBeCloseTo(0, 12);
    // custom base: base=2, c=1 fail -> price*(2-1)/2 = price/2
    expect(settlementPayment(bid("w", "t", 1, 8), false, { base: 2 })).toBeCloseTo(4, 12);
  });

  it("clamps claimedPCorrect into [0,1] and never pays negative", () => {
    expect(settlementPayment(bid("w", "t", 1.7, 5), true)).toBeCloseTo(5, 12);
    expect(settlementPayment(bid("w", "t", -0.4, 5), false)).toBeCloseTo(5, 12);
    expect(settlementPayment(bid("w", "t", Number.NaN, 5), false)).toBeCloseTo(5, 12); // NaN -> 0
    expect(settlementPayment(bid("w", "t", 2, 5), false)).toBe(0); // clamped to 1, fail
  });

  it("throws RangeError on invalid price and invalid base", () => {
    expect(() => settlementPayment(bid("w", "t", 0.5, 0), true)).toThrow(RangeError);
    expect(() => settlementPayment(bid("w", "t", 0.5, -3), true)).toThrow(RangeError);
    expect(() => settlementPayment(bid("w", "t", 0.5, Number.NaN), true)).toThrow(RangeError);
    expect(() => settlementPayment(bid("w", "t", 0.5, Number.POSITIVE_INFINITY), true)).toThrow(RangeError);
    expect(() => settlementPayment(bid("w", "t", 0.5, 1), true, { base: 0 })).toThrow(RangeError);
    expect(() => settlementPayment(bid("w", "t", 0.5, 1), true, { base: -1 })).toThrow(RangeError);
  });

  it("expected payment is maximized at c = p (argmax over grid, p = 0.7)", () => {
    const p = 0.7;
    let bestC = -1;
    let bestE = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const c = i / 100;
      const e = expectedPayment(c, p);
      if (e > bestE) {
        bestE = e;
        bestC = c;
      }
    }
    expect(bestC).toBeCloseTo(p, 10);
    // Strictly worse on either side of p.
    expect(expectedPayment(p, p)).toBeGreaterThan(expectedPayment(p - 0.05, p));
    expect(expectedPayment(p, p)).toBeGreaterThan(expectedPayment(p + 0.05, p));
  });

  it("overclaimer earns less than truthful worker over a deterministic pass sequence at rate p", () => {
    // 7 passes, 3 fails -> realized rate 0.7 (deterministic, no randomness).
    const outcomes = [true, true, true, false, true, true, false, true, true, false];
    const total = (c: number) =>
      outcomes.reduce((sum, pass) => sum + settlementPayment(bid("w", "t", c, 1), pass), 0);
    const truthful = total(0.7);
    const overclaim = total(0.95);
    const sandbag = total(0.3);
    expect(truthful).toBeCloseTo(7 * 0.91 + 3 * 0.51, 10); // 7.90
    expect(overclaim).toBeCloseTo(7 * 0.9975 + 3 * 0.0975, 10); // 7.275
    expect(truthful).toBeGreaterThan(overclaim);
    expect(truthful).toBeGreaterThan(sandbag);
  });
});

describe("VerifiedWorkMarket.selectBids", () => {
  it("picks the highest claimedPCorrect/price per task with deterministic tie-breaks", () => {
    const market = new VerifiedWorkMarket();
    const { accepted, rejected } = market.selectBids([
      bid("a", "t1", 0.9, 3), // value 0.3
      bid("b", "t1", 0.8, 2), // value 0.4 -> wins t1
      bid("c", "t2", 0.5, 1), // value 0.5, price 1
      bid("d", "t2", 1.0, 2), // value 0.5, price 2 -> tie broken by lower price: c wins
      bid("b", "t3", 0.6, 2), // value 0.3, same price -> tie broken by workerId: a wins
      bid("a", "t3", 0.6, 2),
    ]);
    expect(accepted).toEqual([bid("b", "t1", 0.8, 2), bid("c", "t2", 0.5, 1), bid("a", "t3", 0.6, 2)]);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) expect(r.reason).toBe("outbid");
  });

  it("rejects invalid bids and bids over maxPricePerTask with reasons", () => {
    const market = new VerifiedWorkMarket({ maxPricePerTask: 5 });
    const { accepted, rejected } = market.selectBids([
      bid("a", "t1", 0.9, -1),
      bid("b", "t1", 0.9, 0),
      bid("c", "t1", Number.NaN, 1),
      bid("d", "t1", 0.9, 6), // over cap
      bid("", "t1", 0.9, 1), // bad workerId
      bid("e", "", 0.9, 1), // bad taskId
      bid("f", "t1", 0.9, 2), // only valid one
    ]);
    expect(accepted).toEqual([bid("f", "t1", 0.9, 2)]);
    expect(rejected).toHaveLength(6);
    expect(rejected.find((r) => r.bid.workerId === "a")?.reason).toMatch(/invalid price/);
    expect(rejected.find((r) => r.bid.workerId === "b")?.reason).toMatch(/invalid price/);
    expect(rejected.find((r) => r.bid.workerId === "c")?.reason).toMatch(/invalid claimedPCorrect/);
    expect(rejected.find((r) => r.bid.workerId === "d")?.reason).toMatch(/exceeds maxPricePerTask/);
    expect(rejected.find((r) => r.bid.workerId === "")?.reason).toMatch(/invalid workerId/);
    expect(rejected.find((r) => r.bid.taskId === "")?.reason).toMatch(/invalid taskId/);
  });
});

describe("VerifiedWorkMarket.settle", () => {
  const execFrom =
    (table: Record<string, { certified: boolean; verifiedPass: boolean }>): WorkExecutor =>
    (b) => ({ output: `out:${b.taskId}`, ...table[b.taskId] });

  it("gates payment on certification: certified=false pays 0 even when verifiedPass=true", () => {
    const market = new VerifiedWorkMarket();
    const entries = market.settle(
      [bid("w1", "t1", 1, 10)],
      execFrom({ t1: { certified: false, verifiedPass: true } }),
    );
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.accepted).toBe(true);
    expect(e.certified).toBe(false);
    expect(e.verifiedPass).toBe(true);
    expect(e.payment).toBe(0);
    expect(e.reason).toBe("uncertified");
  });

  it("settles certified pass with Brier payment and certified fail at outcome 0", () => {
    const market = new VerifiedWorkMarket();
    const entries = market.settle(
      [bid("w1", "t1", 0.9, 10), bid("w2", "t2", 0.9, 10)],
      execFrom({
        t1: { certified: true, verifiedPass: true },
        t2: { certified: true, verifiedPass: false },
      }),
    );
    const byTask = new Map(entries.map((e) => [e.bid.taskId, e]));
    expect(byTask.get("t1")?.payment).toBeCloseTo(10 * (1 - 0.01), 12); // 9.9
    expect(byTask.get("t2")?.payment).toBeCloseTo(10 * (1 - 0.81), 12); // 1.9 — confident fail nearly wiped out
    expect(byTask.get("t2")?.certified).toBe(true);
  });

  it("records rejected bids in the ledger and accumulates across settle calls", () => {
    const market = new VerifiedWorkMarket({ maxPricePerTask: 100 });
    market.settle(
      [bid("w1", "t1", 0.8, 4), bid("w2", "t1", 0.8, 8), bid("w3", "t2", 0.5, 200)],
      execFrom({ t1: { certified: true, verifiedPass: true } }),
    );
    market.settle(
      [bid("w2", "t3", 0.6, 2)],
      execFrom({ t3: { certified: true, verifiedPass: false } }),
    );
    const ledger = market.ledger();
    expect(ledger).toHaveLength(4);
    const rejectedEntries = ledger.filter((e: LedgerEntry) => !e.accepted);
    expect(rejectedEntries.map((e) => e.bid.workerId).sort()).toEqual(["w2", "w3"]);
    expect(rejectedEntries.find((e) => e.bid.workerId === "w2")?.reason).toBe("outbid");
    expect(rejectedEntries.find((e) => e.bid.workerId === "w3")?.reason).toMatch(/exceeds maxPricePerTask/);
    // Rejected entries carry no settlement fields.
    for (const e of rejectedEntries) {
      expect(e.payment).toBeUndefined();
      expect(e.verifiedPass).toBeUndefined();
    }
    // ledger() returns copies — mutating them must not corrupt the market.
    ledger[0].payment = 999999;
    expect(market.ledger()[0].payment).not.toBe(999999);
  });

  it("stats: totals, paymentsByWorker, and truthfulnessGap per worker", () => {
    const market = new VerifiedWorkMarket();
    // w1: claims 0.9 and 0.7, outcomes pass, fail -> mean claim 0.8, pass rate 0.5, gap 0.3
    // w2: claims 0.6, outcome pass, uncertified -> counted as settled with payment 0; gap |0.6-1| = 0.4
    market.settle(
      [bid("w1", "t1", 0.9, 10)],
      execFrom({ t1: { certified: true, verifiedPass: true } }),
    );
    market.settle(
      [bid("w1", "t2", 0.7, 10)],
      execFrom({ t2: { certified: true, verifiedPass: false } }),
    );
    market.settle(
      [bid("w2", "t3", 0.6, 5)],
      execFrom({ t3: { certified: false, verifiedPass: true } }),
    );
    const stats = market.stats();
    expect(stats.tasksSettled).toBe(3);
    const w1Pay = 10 * (1 - 0.01) + 10 * (1 - 0.49); // 9.9 + 5.1 = 15
    expect(stats.paymentsByWorker.w1).toBeCloseTo(w1Pay, 10);
    expect(stats.paymentsByWorker.w2).toBe(0);
    expect(stats.totalPaid).toBeCloseTo(w1Pay, 10);
    expect(stats.totalPriced).toBeCloseTo(25, 12);
    expect(stats.truthfulnessGap.w1).toBeCloseTo(0.3, 10);
    expect(stats.truthfulnessGap.w2).toBeCloseTo(0.4, 10);
  });

  it("is deterministic: identical inputs produce identical ledgers", () => {
    const run = () => {
      const market = new VerifiedWorkMarket();
      return market.settle(
        [bid("b", "t1", 0.8, 2), bid("a", "t1", 0.8, 2), bid("c", "t2", 0.4, 1)],
        (b) => ({ output: b.taskId, certified: true, verifiedPass: b.taskId === "t1" }),
      );
    };
    expect(run()).toEqual(run());
  });

  it("constructor rejects invalid rule/maxPricePerTask with RangeError", () => {
    expect(() => new VerifiedWorkMarket({ rule: { base: 0 } })).toThrow(RangeError);
    expect(() => new VerifiedWorkMarket({ maxPricePerTask: 0 })).toThrow(RangeError);
    expect(() => new VerifiedWorkMarket({ maxPricePerTask: Number.NaN })).toThrow(RangeError);
  });
});
