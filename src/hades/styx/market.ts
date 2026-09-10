/**
 * Styx S5 — the Verified-Work Market.
 *
 * Workers bid to perform tasks, quoting a price and a CLAIMED probability
 * that their work will pass verification. Bids are settled AGAINST the
 * verifier: payment is gated on certification and scaled by a Brier-style
 * proper scoring rule over the claimed confidence, so truthful confidence
 * reporting is incentive-compatible.
 *
 * INCENTIVE-COMPATIBILITY (the key property, documented as required):
 *
 *   payment(c, outcome) = price * (base - (c - outcome)^2) / base, floored at 0
 *   where outcome = 1 if the verifier PASSED the work, else 0.
 *
 *   For a worker whose work truly passes with probability p, the expected
 *   payment as a function of claimed confidence c is
 *
 *     E[pay](c) = price * (base - p*(c-1)^2 - (1-p)*c^2) / base
 *
 *   Differentiating: d/dc E[pay] = price * (-2p(c-1) - 2(1-p)c) / base
 *                                = price * 2(p - c) / base,
 *   which is zero exactly at c = p, positive for c < p and negative for
 *   c > p — so E[pay] is strictly maximized at c = p (the second derivative
 *   is -2*price/base < 0). Truthful reporting of the worker's true P(correct)
 *   maximizes expected payment; overclaiming on shaky work loses money in
 *   expectation, and sandbagging on solid work does too.
 *
 * CERTIFICATE GATING: an uncertified result pays 0 regardless of what the
 * worker claims or even whether verification nominally passed — no
 * certificate, no money. A certified-but-failed result settles with the
 * Brier payment at outcome 0, which is small/zero for confident claims.
 *
 * Pure and deterministic: no Math.random, no clock, no network. All work
 * execution is injected via the WorkExecutor.
 */

// ---------------------------------------------------------------------------
// Bids and settlement rule
// ---------------------------------------------------------------------------

export interface WorkBid {
  workerId: string;
  taskId: string;
  /** Worker's claimed probability the work passes verification, in [0,1]. */
  claimedPCorrect: number;
  /** Asking price; must be > 0. */
  price: number;
}

export interface SettlementRule {
  /** Payment scale, default 1. */
  base: number;
  /** Proper scoring rule used for the confidence component. */
  scoring: "brier";
}

const DEFAULT_RULE: SettlementRule = { base: 1, scoring: "brier" };

function resolveRule(rule?: Partial<SettlementRule>): SettlementRule {
  const base = rule?.base ?? DEFAULT_RULE.base;
  const scoring = rule?.scoring ?? DEFAULT_RULE.scoring;
  if (!Number.isFinite(base) || base <= 0) {
    throw new RangeError(`settlement base must be a finite number > 0, got ${base}`);
  }
  if (scoring !== "brier") {
    throw new RangeError(`unsupported scoring rule: ${String(scoring)}`);
  }
  return { base, scoring };
}

/** Clamp a claimed confidence into [0,1]; non-finite values clamp to 0. */
function clampConfidence(c: number): number {
  if (!Number.isFinite(c)) return 0;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/**
 * Payment for a settled bid:
 *
 *   payment = price * (base - (claimedPCorrect - outcome)^2) / base, floored at 0
 *
 * where outcome = 1 if the verifier PASSED the work else 0. Brier-style:
 * truthful reporting of the worker's true P(correct) maximizes EXPECTED
 * payment (E[pay] = price*(base - p*(c-1)^2 - (1-p)*c^2)/base has derivative
 * 2*price*(p-c)/base, so its unique maximum is at c = p — see module header).
 *
 * `claimedPCorrect` is clamped into [0,1]; `price` must be > 0 (RangeError).
 */
export function settlementPayment(
  bid: WorkBid,
  verifiedPass: boolean,
  rule?: Partial<SettlementRule>,
): number {
  const { base } = resolveRule(rule);
  if (!Number.isFinite(bid.price) || bid.price <= 0) {
    throw new RangeError(`bid price must be a finite number > 0, got ${bid.price}`);
  }
  const c = clampConfidence(bid.claimedPCorrect);
  const outcome = verifiedPass ? 1 : 0;
  const err = c - outcome;
  const payment = (bid.price * (base - err * err)) / base;
  return payment > 0 ? payment : 0;
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  bid: WorkBid;
  accepted: boolean;
  verifiedPass?: boolean;
  payment?: number;
  certified?: boolean;
  reason: string;
}

export interface MarketStats {
  tasksSettled: number;
  totalPaid: number;
  totalPriced: number;
  paymentsByWorker: Record<string, number>;
  /** |mean claimedPCorrect - realized pass rate| per worker (calibration error). */
  truthfulnessGap: Record<string, number>;
}

export interface WorkResult {
  output: string;
  certified: boolean;
  verifiedPass: boolean;
}

/** Injectable: runs the work + verification for an accepted bid. */
export type WorkExecutor = (bid: WorkBid) => WorkResult;

export class VerifiedWorkMarket {
  private readonly rule: SettlementRule;
  private readonly maxPricePerTask?: number;
  private readonly entries: LedgerEntry[] = [];

  constructor(opts?: { rule?: Partial<SettlementRule>; maxPricePerTask?: number }) {
    this.rule = resolveRule(opts?.rule);
    if (opts?.maxPricePerTask !== undefined) {
      if (!Number.isFinite(opts.maxPricePerTask) || opts.maxPricePerTask <= 0) {
        throw new RangeError(
          `maxPricePerTask must be a finite number > 0, got ${opts.maxPricePerTask}`,
        );
      }
      this.maxPricePerTask = opts.maxPricePerTask;
    }
  }

  /**
   * Select the winning bid per task: highest expected VALUE =
   * claimedPCorrect / price (verified-work-per-dollar), ties broken by lower
   * price, then lexicographically smaller workerId, then original bid order.
   * Bids over maxPricePerTask (if set) are rejected with a reason, as are
   * malformed bids. One winner per task; losers are rejected as "outbid".
   */
  selectBids(bids: WorkBid[]): { accepted: WorkBid[]; rejected: Array<{ bid: WorkBid; reason: string }> } {
    const rejected: Array<{ bid: WorkBid; reason: string }> = [];
    const byTask = new Map<string, Array<{ bid: WorkBid; index: number; value: number }>>();

    bids.forEach((bid, index) => {
      const reason = this.rejectReason(bid);
      if (reason !== undefined) {
        rejected.push({ bid, reason });
        return;
      }
      const value = clampConfidence(bid.claimedPCorrect) / bid.price;
      const list = byTask.get(bid.taskId);
      if (list) list.push({ bid, index, value });
      else byTask.set(bid.taskId, [{ bid, index, value }]);
    });

    const accepted: WorkBid[] = [];
    // Iterate tasks in first-seen order for determinism.
    for (const candidates of byTask.values()) {
      candidates.sort((a, b) => {
        if (a.value !== b.value) return b.value - a.value; // higher value first
        if (a.bid.price !== b.bid.price) return a.bid.price - b.bid.price; // lower price
        if (a.bid.workerId !== b.bid.workerId) {
          return a.bid.workerId < b.bid.workerId ? -1 : 1; // smaller workerId
        }
        return a.index - b.index; // original order
      });
      const [winner, ...losers] = candidates;
      accepted.push(winner.bid);
      for (const loser of losers) {
        rejected.push({ bid: loser.bid, reason: "outbid" });
      }
    }
    return { accepted, rejected };
  }

  private rejectReason(bid: WorkBid): string | undefined {
    if (typeof bid.workerId !== "string" || bid.workerId.length === 0) {
      return "invalid workerId";
    }
    if (typeof bid.taskId !== "string" || bid.taskId.length === 0) {
      return "invalid taskId";
    }
    if (!Number.isFinite(bid.price) || bid.price <= 0) {
      return `invalid price: must be a finite number > 0, got ${bid.price}`;
    }
    if (!Number.isFinite(bid.claimedPCorrect)) {
      return `invalid claimedPCorrect: must be finite, got ${bid.claimedPCorrect}`;
    }
    if (this.maxPricePerTask !== undefined && bid.price > this.maxPricePerTask) {
      return `price ${bid.price} exceeds maxPricePerTask ${this.maxPricePerTask}`;
    }
    return undefined;
  }

  /**
   * Execute accepted bids via the executor and SETTLE. Payment is
   * settlementPayment(...) but ONLY IF the result is certified — uncertified
   * work pays 0 (reason "uncertified") regardless of claimed pass. Rejected
   * bids are recorded unaccepted with their rejection reason. Appends and
   * returns the new LedgerEntries.
   */
  settle(bids: WorkBid[], exec: WorkExecutor): LedgerEntry[] {
    const { accepted, rejected } = this.selectBids(bids);
    const appended: LedgerEntry[] = [];

    for (const { bid, reason } of rejected) {
      appended.push({ bid, accepted: false, reason });
    }

    for (const bid of accepted) {
      const result = exec(bid);
      if (!result.certified) {
        appended.push({
          bid,
          accepted: true,
          verifiedPass: result.verifiedPass,
          certified: false,
          payment: 0,
          reason: "uncertified",
        });
        continue;
      }
      const payment = settlementPayment(bid, result.verifiedPass, this.rule);
      appended.push({
        bid,
        accepted: true,
        verifiedPass: result.verifiedPass,
        certified: true,
        payment,
        reason: result.verifiedPass ? "settled: verified pass" : "settled: verified fail",
      });
    }

    this.entries.push(...appended);
    return appended.map((entry) => ({ ...entry }));
  }

  ledger(): LedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  stats(): MarketStats {
    const paymentsByWorker: Record<string, number> = {};
    const truthfulnessGap: Record<string, number> = {};
    const perWorker = new Map<string, { claimSum: number; passes: number; n: number }>();

    let tasksSettled = 0;
    let totalPaid = 0;
    let totalPriced = 0;

    for (const entry of this.entries) {
      // Settled = accepted and executed (verification outcome recorded).
      if (!entry.accepted || entry.verifiedPass === undefined) continue;
      tasksSettled += 1;
      totalPaid += entry.payment ?? 0;
      totalPriced += entry.bid.price;
      const worker = entry.bid.workerId;
      paymentsByWorker[worker] = (paymentsByWorker[worker] ?? 0) + (entry.payment ?? 0);
      const agg = perWorker.get(worker) ?? { claimSum: 0, passes: 0, n: 0 };
      agg.claimSum += clampConfidence(entry.bid.claimedPCorrect);
      agg.passes += entry.verifiedPass ? 1 : 0;
      agg.n += 1;
      perWorker.set(worker, agg);
    }

    for (const [worker, agg] of perWorker) {
      truthfulnessGap[worker] = Math.abs(agg.claimSum / agg.n - agg.passes / agg.n);
    }

    return { tasksSettled, totalPaid, totalPriced, paymentsByWorker, truthfulnessGap };
  }
}
