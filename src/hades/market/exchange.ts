/**
 * market/exchange — the Trust-Gated Work Exchange.
 *
 * An order book where TASK ORDERS carry hard requirements (domain, tags,
 * minimum reputation, tier, deadline, reserve) and WORK OFFERS compete for
 * them. This module closes a documented mechanism gap: the S5 market
 * (`styx/market.ts`, see `__tests__/styx-market-adversarial.test.ts`,
 * "KNOWN MECHANISM GAP") ranks offers by the bidder's OWN CLAIMED confidence
 * divided by price — a same-price blusterer with a bad track record beats an
 * honest bidder with a good one at SELECTION time, and only bleeds money
 * later at settlement. That two-stage defense (gullible selection, punishing
 * settlement) is real, but selection itself stays exploitable. This module
 * fixes selection directly: offers are ranked by REPUTATION-ADJUSTED expected
 * verified value per dollar, so bluster never wins in the first place.
 *
 * ---------------------------------------------------------------------------
 * 1. SHRINKAGE — from claimed confidence to adjusted confidence
 * ---------------------------------------------------------------------------
 * `shrinkClaim` pulls a participant's claimed P(correct) toward their own
 * EMPIRICAL track record (`ReputationState.passRate`, the observed frequency
 * of verified passes across their full recorded history — itself the output
 * of the ledger's own calibration machinery), Bayesian-blended with weight
 * `n / (n + priorStrength)`:
 *
 *   adjusted = (1 - w) * claim + w * passRate,   w = n / (n + priorStrength)
 *
 * As evidence `n` accumulates, weight shifts from "trust the claim" toward
 * "trust the track record" — exactly the shrinkage a rational principal
 * applies to a chronic over- or under-claimer. `ReputationState` carries only
 * the ledger's AGGREGATE calibration statistics (not the raw per-bin curve —
 * `shrinkClaim`'s signature is locked to take a `ReputationState`, not a
 * `ReputationLedger`), so `passRate` — the participant's true empirical
 * verified-pass rate — is the correct, honest anchor available at this
 * boundary; `calibrationGap` and `meanClaim` are already baked into how that
 * `ReputationState` was computed upstream.
 *
 * A participant with NO recorded history (`state === null`) has no track
 * record to shrink toward at all, so their claim is IGNORED outright: they
 * are blended straight to `populationPrior` and hard-capped at
 * `maxUnknownClaim`. This is what makes sybil identities powerless — see
 * §3 below: a fresh identity claiming 0.99 is treated as claiming at most
 * `maxUnknownClaim` (default 0.6), full stop.
 *
 * A participant whose ledger `score === 0` (this is unconditional whenever
 * `fabricatedN > 0`, per `reputation.ts`) adjusts to a HARD `0`, always. Zero
 * adjusted confidence means zero `expectedVerifiedValue` at any price, which
 * (see §3) makes them structurally unable to ever be selected as a winner —
 * fabrication is not merely penalized, it is disqualifying.
 *
 * ---------------------------------------------------------------------------
 * 2. RANKING — the total, deterministic tie-break order
 * ---------------------------------------------------------------------------
 * Offers for a task are ordered by:
 *   1. higher `expectedVerifiedValue = adjustedPCorrect / price`  (primary)
 *   2. lower `price`
 *   3. higher reputation `score`
 *   4. lexicographically smaller `participantId`
 *   5. original offer array index
 * This chain is TOTAL (no two distinct offers ever compare equal), so the
 * result of `clear()` is independent of the order offers were submitted in —
 * see the determinism tests, which shuffle the offer array ten ways and
 * assert byte-identical output.
 *
 * ---------------------------------------------------------------------------
 * 3. CLEARING — second price in VALUE space, and why it is truthful
 * ---------------------------------------------------------------------------
 * A winner's `adjustedPCorrect` (call it A) does not depend on the PRICE they
 * quote — only on their claim and their own reputation history. Their
 * ranking value is `V(P) = A / P`, strictly decreasing in price `P`. Suppose
 * offer W wins against runner-up R with value `V_r = A_r / P_r` (R's own
 * price and adjusted confidence). Define the BREAKEVEN price
 *
 *   P* = A_w / V_r
 *
 * — the price at which W's value would exactly equal R's. Because W actually
 * won, `A_w / P_w > V_r`, which rearranges (A_w > 0) to `P_w < P*`: the
 * breakeven price STRICTLY EXCEEDS the winner's own quoted price whenever a
 * real, positive-value runner-up exists. The exchange charges the requester
 * exactly `clearingPrice = P*` in that case — this is the genuine second
 * price, and the winner is paid MORE than they asked, never less (see the
 * gating/allocation sections below for the reserve floor and the two
 * degenerate cases where there is no real runner-up to derive `P*` from).
 *
 * INCENTIVE ARGUMENT (why this is truthful, the analogue of `styx/market.ts`'s
 * derivative proof): fix a rival book. A participant's own quoted price `P`
 * affects ONLY whether they win (win iff `P <= P*`, since `A` does not depend
 * on `P`) — NOT what they are paid if they win (`clearingPrice = P*`,
 * independent of `P`, whenever a real runner-up exists). So:
 *   - Quoting *below* your true reservation cost still nets exactly the same
 *     surplus `P* - cost` as quoting at cost, as long as you still win — it
 *     never pays MORE to shade your price down.
 *   - Quoting *above* true cost risks losing the auction outright (surplus
 *     drops from `P* - cost` to `0`) the moment `P` crosses `P*`, for zero
 *     benefit while still winning.
 *   Truthful pricing (quoting your true reservation cost) is therefore always
 *   a WEAKLY dominant strategy: it lands inside the winning region whenever
 *   winning is profitable, and never yields less surplus than any other
 *   price that also wins. See "second-price truthfulness swept numerically"
 *   in the test suite, which sweeps ≥40 price points and confirms exactly
 *   this shape.
 *
 * The reserve floor and the own-offer-price cap only ever DO anything in two
 * DEGENERATE cases — never in the ordinary contested one, where `P* > P_w
 * >= reservePrice` always holds by construction, so both bounds are already
 * satisfied without clamping:
 *   - No runner-up survives (single bidder, or every rival already spent
 *     this round's one win elsewhere): the reserve price stands in for the
 *     missing competitive threat (`clearingPrice := reservePrice` when set),
 *     so an uncontested winner is paid the requester's own declared floor
 *     rather than their full ask; with no reserve either, they are simply
 *     paid what they asked (`clearingPrice := offerPrice`) — there is no
 *     information to do otherwise.
 *   - The runner-up would derive an ill-defined/infinite breakeven price
 *     (their own adjusted value is non-positive) — capped at the winner's
 *     own ask so no clearing price is ever infinite.
 *
 * ---------------------------------------------------------------------------
 * 4. ALLOCATION — one winner per task, one win per participant per round
 * ---------------------------------------------------------------------------
 * Tasks are cleared in the order given in `orders` (deduplicated by
 * `taskId`, first occurrence wins). For each task, in that fixed order, the
 * highest-ranked candidate (by §2) who has not already won a DIFFERENT task
 * earlier in this same `clear()` call is selected; the next-ranked
 * still-available candidate (if any) becomes that match's `runnerUp`. A
 * participant can therefore hold at most one winning match per round, and
 * bidding on many tasks never risks losing all of them to itself.
 *
 * ---------------------------------------------------------------------------
 * 5. GATING
 * ---------------------------------------------------------------------------
 * Before ranking, every offer is checked, in this fixed order, against its
 * named task: domain match, required tags (subset check), tier sufficiency
 * (a participant with no declared `capability.maxTier` is treated as
 * qualified only for the weakest tier, `T4-consistency` — fail CLOSED),
 * deadline feasibility (`readyBy <= deadline`), price ceiling (`maxPrice`),
 * reserve floor (`reservePrice`), minimum reputation, and standing
 * (`demoted`/`banned` participants are excluded; `probation` is not gated
 * here — it already depresses `score`, which the ranking and
 * `minReputation` gate both read). Structurally malformed offers, offers
 * naming an unknown task, and duplicate (participant, task) submissions are
 * rejected before gating even runs.
 *
 * ---------------------------------------------------------------------------
 * REAL-VS-MOCK POLICY
 * ---------------------------------------------------------------------------
 * Pure and fully deterministic. No `Math.random`, no `Date.now`, no `fs`, no
 * network. `now` is always caller-provided. Standing arrives exclusively
 * through the injected `standingOf` callback (default: everyone `"active"`)
 * — this file does not import `./economy`, so there is no import cycle.
 * `clear()` never throws: hostile/malformed offers land in `rejected` with a
 * documented reason instead of raising.
 */

import type { ParticipantId, ReputationLedger, ReputationState, Standing } from "./reputation";
import { TIER_ORDER, type TierId } from "../styx/tiers";

// ---------------------------------------------------------------------------
// Locked contract — types
// ---------------------------------------------------------------------------

export type OfferRejectionCode =
  | "invalid-offer"
  | "unknown-task"
  | "price-over-max"
  | "below-reserve"
  | "capability-mismatch"
  | "domain-mismatch"
  | "reputation-too-low"
  | "standing-excluded"
  | "tier-insufficient"
  | "deadline-infeasible"
  | "duplicate-offer";

export type NoMatchReason = "no-offers" | "all-offers-rejected" | "reserve-not-met";

export interface Capability {
  domain: string;
  tags: readonly string[];
  maxTier?: TierId;
}

export interface TaskOrder {
  taskId: string;
  domain: string;
  maxPrice: number;
  reservePrice?: number;
  requiredTags?: readonly string[];
  requiredTier?: TierId;
  minReputation?: number;
  deadline?: number;
  difficulty?: number;
  postedAt: number;
}

export interface WorkOffer {
  participantId: ParticipantId;
  taskId: string;
  price: number;
  claimedPCorrect: number;
  capability: Capability;
  readyBy?: number;
}

export interface ShrinkageOptions {
  /** pseudo-count, default 8 */
  priorStrength?: number;
  /** default 0.5 */
  populationPrior?: number;
  calibrationBins?: number;
  /** ceiling applied to a participant with no history, default 0.6 */
  maxUnknownClaim?: number;
}

export interface Match {
  taskId: string;
  participantId: ParticipantId;
  offerPrice: number;
  clearingPrice: number;
  claimedPCorrect: number;
  adjustedPCorrect: number;
  expectedVerifiedValue: number;
  reputationScore: number;
  runnerUp?: { participantId: ParticipantId; expectedVerifiedValue: number };
}

export interface ExchangeResult {
  matches: Match[];
  unmatched: Array<{ taskId: string; reason: NoMatchReason }>;
  rejected: Array<{ offer: WorkOffer; reason: OfferRejectionCode; detail: string }>;
}

// ---------------------------------------------------------------------------
// Small numeric/shape guards
// ---------------------------------------------------------------------------

const TIER_SET: ReadonlySet<string> = new Set(TIER_ORDER);
const WEAKEST_TIER: TierId = TIER_ORDER[TIER_ORDER.length - 1];

function tierRank(tier: TierId): number {
  const idx = TIER_ORDER.indexOf(tier);
  return idx === -1 ? TIER_ORDER.length : idx;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

const SHRINK_DEFAULTS = {
  priorStrength: 8,
  populationPrior: 0.5,
  calibrationBins: 10,
  maxUnknownClaim: 0.6,
} as const;

// ---------------------------------------------------------------------------
// shrinkClaim / expectedVerifiedValue — the two locked pure functions
// ---------------------------------------------------------------------------

/**
 * See module header §1. Pure, deterministic, never throws: malformed
 * `claimedP` clamps to 0; malformed options fall back to documented
 * defaults.
 */
export function shrinkClaim(claimedP: number, state: ReputationState | null, opts?: ShrinkageOptions): number {
  const priorStrength =
    opts?.priorStrength !== undefined && Number.isFinite(opts.priorStrength) && opts.priorStrength >= 0
      ? opts.priorStrength
      : SHRINK_DEFAULTS.priorStrength;
  const populationPrior =
    opts?.populationPrior !== undefined && Number.isFinite(opts.populationPrior)
      ? clamp01(opts.populationPrior)
      : SHRINK_DEFAULTS.populationPrior;
  const maxUnknownClaim =
    opts?.maxUnknownClaim !== undefined && Number.isFinite(opts.maxUnknownClaim)
      ? clamp01(opts.maxUnknownClaim)
      : SHRINK_DEFAULTS.maxUnknownClaim;
  // `calibrationBins` is accepted for symmetry with `ReputationLedger`'s own
  // calibration-curve bin count, but the `ReputationState` this function
  // receives already carries the ledger's own AGGREGATE calibration
  // statistics (computed with the ledger's own bin count) — there is no raw
  // per-bin curve at this boundary to re-bin, so this option is otherwise
  // inert. Deliberately unread beyond this comment; never throws either way.

  const c = clamp01(claimedP);

  if (state === null) {
    return Math.min(populationPrior, maxUnknownClaim);
  }
  if (state.score === 0) {
    return 0;
  }

  const n = Math.max(0, state.n);
  const w = n / (n + priorStrength);
  const observed = clamp01(state.passRate);
  const blended = (1 - w) * c + w * observed;
  return clamp01(blended);
}

/** `adjustedPCorrect / price` — reputation-adjusted expected verified value per dollar. */
export function expectedVerifiedValue(adjustedPCorrect: number, price: number): number {
  return adjustedPCorrect / price;
}

// ---------------------------------------------------------------------------
// Internal candidate representation + total ordering
// ---------------------------------------------------------------------------

interface InternalCandidate {
  offer: WorkOffer;
  index: number;
  participantId: ParticipantId;
  reputationScore: number;
  adjustedPCorrect: number;
  value: number;
}

function compareCandidates(a: InternalCandidate, b: InternalCandidate): number {
  if (a.value !== b.value) return b.value - a.value; // higher value first
  if (a.offer.price !== b.offer.price) return a.offer.price - b.offer.price; // lower price first
  if (a.reputationScore !== b.reputationScore) return b.reputationScore - a.reputationScore; // higher reputation first
  if (a.participantId !== b.participantId) return a.participantId < b.participantId ? -1 : 1; // lexicographically smaller id
  return a.index - b.index; // original offer order
}

// ---------------------------------------------------------------------------
// Structural validation of hostile/malformed input
// ---------------------------------------------------------------------------

function isUsableOrder(o: unknown): o is TaskOrder {
  if (o === null || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.taskId === "string" &&
    r.taskId.length > 0 &&
    typeof r.domain === "string" &&
    r.domain.length > 0 &&
    typeof r.maxPrice === "number" &&
    Number.isFinite(r.maxPrice) &&
    r.maxPrice > 0 &&
    typeof r.postedAt === "number" &&
    Number.isFinite(r.postedAt)
  );
}

/**
 * True iff `k` is an OWN property of `o` — used throughout
 * {@link validateOfferShape} instead of plain `o.k` reads so that a
 * prototype-pollution payload (required fields planted on the prototype
 * chain rather than as the object's own data) is never mistaken for a
 * genuine offer.
 */
function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Returns `null` if `offer` is a well-formed `WorkOffer`, else a human-readable reason. */
function validateOfferShape(offer: unknown): string | null {
  if (offer === null || typeof offer !== "object") {
    return "offer must be a non-null object";
  }
  const o = offer as Record<string, unknown>;
  if (!hasOwn(o, "participantId") || typeof o.participantId !== "string" || o.participantId.length === 0) {
    return "participantId must be an own, non-empty string property";
  }
  if (!hasOwn(o, "taskId") || typeof o.taskId !== "string" || o.taskId.length === 0) {
    return "taskId must be an own, non-empty string property";
  }
  if (!hasOwn(o, "price") || typeof o.price !== "number" || !Number.isFinite(o.price) || o.price <= 0) {
    return `price must be an own finite number > 0, got ${String(o.price)}`;
  }
  if (
    !hasOwn(o, "claimedPCorrect") ||
    typeof o.claimedPCorrect !== "number" ||
    !Number.isFinite(o.claimedPCorrect) ||
    o.claimedPCorrect < 0 ||
    o.claimedPCorrect > 1
  ) {
    return `claimedPCorrect must be an own finite number in [0,1], got ${String(o.claimedPCorrect)}`;
  }
  if (!hasOwn(o, "capability")) {
    return "capability must be an own property";
  }
  const cap = o.capability;
  if (cap === null || typeof cap !== "object") {
    return "capability must be an object";
  }
  const c = cap as Record<string, unknown>;
  if (!hasOwn(c, "domain") || typeof c.domain !== "string" || c.domain.length === 0) {
    return "capability.domain must be an own, non-empty string property";
  }
  if (!hasOwn(c, "tags") || !Array.isArray(c.tags) || !c.tags.every((t) => typeof t === "string")) {
    return "capability.tags must be an own array of strings";
  }
  if (c.maxTier !== undefined && (!hasOwn(c, "maxTier") || typeof c.maxTier !== "string" || !TIER_SET.has(c.maxTier))) {
    return `capability.maxTier must be a valid TierId, got ${String(c.maxTier)}`;
  }
  if (o.readyBy !== undefined && (!hasOwn(o, "readyBy") || typeof o.readyBy !== "number" || !Number.isFinite(o.readyBy))) {
    return "readyBy must be a finite number when present";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

function gateOffer(
  offer: WorkOffer,
  order: TaskOrder,
  reputationScore: number,
  standing: Standing,
): OfferRejectionCode | null {
  if (offer.capability.domain !== order.domain) return "domain-mismatch";

  if (order.requiredTags && order.requiredTags.length > 0) {
    const tagSet = new Set(offer.capability.tags);
    for (const tag of order.requiredTags) {
      if (!tagSet.has(tag)) return "capability-mismatch";
    }
  }

  if (order.requiredTier !== undefined) {
    const participantRank = tierRank(offer.capability.maxTier ?? WEAKEST_TIER);
    const requiredRank = tierRank(order.requiredTier);
    if (participantRank > requiredRank) return "tier-insufficient";
  }

  if (order.deadline !== undefined && offer.readyBy !== undefined && offer.readyBy > order.deadline) {
    return "deadline-infeasible";
  }

  if (offer.price > order.maxPrice) return "price-over-max";

  if (order.reservePrice !== undefined && offer.price < order.reservePrice) return "below-reserve";

  if (order.minReputation !== undefined && reputationScore < order.minReputation) return "reputation-too-low";

  if (standing === "demoted" || standing === "banned") return "standing-excluded";

  return null;
}

function gateDetail(reason: OfferRejectionCode, offer: WorkOffer, order: TaskOrder, reputationScore: number, standing: Standing): string {
  switch (reason) {
    case "domain-mismatch":
      return `offer capability.domain="${offer.capability.domain}" does not match task domain="${order.domain}"`;
    case "capability-mismatch":
      return `offer capability.tags=[${offer.capability.tags.join(",")}] missing one of requiredTags=[${(order.requiredTags ?? []).join(",")}]`;
    case "tier-insufficient":
      return `offer capability.maxTier="${offer.capability.maxTier ?? WEAKEST_TIER}" is weaker than requiredTier="${order.requiredTier}"`;
    case "deadline-infeasible":
      return `offer readyBy=${offer.readyBy} is after task deadline=${order.deadline}`;
    case "price-over-max":
      return `offer price=${offer.price} exceeds task maxPrice=${order.maxPrice}`;
    case "below-reserve":
      return `offer price=${offer.price} is below task reservePrice=${order.reservePrice}`;
    case "reputation-too-low":
      return `participant reputation score=${reputationScore} is below task minReputation=${order.minReputation}`;
    case "standing-excluded":
      return `participant standing="${standing}" is excluded from matching`;
    default:
      return reason;
  }
}

// ---------------------------------------------------------------------------
// Clearing price (module header §3)
// ---------------------------------------------------------------------------

function computeClearingPrice(winner: InternalCandidate, runnerUp: InternalCandidate | undefined, order: TaskOrder): number {
  const reserve = order.reservePrice;
  let price: number;
  if (runnerUp && runnerUp.value > 0) {
    // The genuine second price (breakeven vs. the runner-up). Provably
    // >= winner.offer.price whenever the winner actually beat the runner-up
    // (module header §3) — the "capped at its own offer price" contract
    // clause is therefore mathematically inert on this branch, not an
    // active clamp: forcing it here would silently collapse the mechanism
    // to first-price and break truthfulness (see the incentive proof).
    price = winner.adjustedPCorrect / runnerUp.value;
    if (!Number.isFinite(price)) price = winner.offer.price; // degenerate safety net only
  } else if (reserve !== undefined) {
    // No real competitive threat: the reserve stands in for one.
    price = reserve;
  } else {
    // No competition and no reserve: nothing else to anchor to.
    price = winner.offer.price;
  }
  if (reserve !== undefined && price < reserve) price = reserve; // floor
  if (!(runnerUp && runnerUp.value > 0) && price > winner.offer.price) price = winner.offer.price; // cap only in the degenerate branches
  // BUDGET CEILING. The breakeven price P* = A_w / V_r is unbounded above: a
  // weak runner-up (tiny V_r) drives it arbitrarily high, so without this the
  // exchange could charge a requester far MORE than the `maxPrice` they
  // declared and every offer was gated against — the requester's own budget
  // is a hard constraint of the order, not a suggestion. Clamping here is
  // safe for truthfulness because `maxPrice` is a property of the ORDER, not
  // of the winner's quoted price: the payment stays independent of what the
  // winner bid, which is the only thing the dominant-strategy argument in the
  // module header needs.
  if (price > order.maxPrice) price = order.maxPrice;
  return price;
}

// ---------------------------------------------------------------------------
// WorkExchange
// ---------------------------------------------------------------------------

export class WorkExchange {
  private readonly reputation: ReputationLedger;
  private readonly standingOf: (id: ParticipantId) => Standing;
  private readonly shrinkage?: ShrinkageOptions;

  constructor(opts: { reputation: ReputationLedger; standingOf?: (id: ParticipantId) => Standing; shrinkage?: ShrinkageOptions }) {
    this.reputation = opts.reputation;
    this.standingOf = opts.standingOf ?? (() => "active");
    this.shrinkage = opts.shrinkage;
  }

  /**
   * Clear `orders` against `offers` as of `now`. See module header for the
   * full mechanism (shrinkage, ranking, clearing, allocation, gating). Never
   * throws.
   */
  clear(orders: readonly TaskOrder[], offers: readonly WorkOffer[], now: number): ExchangeResult {
    const rejected: ExchangeResult["rejected"] = [];

    const ordersById = new Map<string, TaskOrder>();
    const orderIdsInOrder: string[] = [];
    for (const raw of Array.isArray(orders) ? orders : []) {
      if (!isUsableOrder(raw)) continue;
      if (!ordersById.has(raw.taskId)) {
        ordersById.set(raw.taskId, raw);
        orderIdsInOrder.push(raw.taskId);
      }
    }

    const rawCountByTask = new Map<string, number>();
    const perTaskCandidates = new Map<string, InternalCandidate[]>();
    const perTaskRejectionReasons = new Map<string, OfferRejectionCode[]>();
    const seenPairs = new Set<string>();

    const offerList = Array.isArray(offers) ? offers : [];
    offerList.forEach((offer, index) => {
      try {
        const shapeError = validateOfferShape(offer);
        if (shapeError) {
          rejected.push({ offer: offer as WorkOffer, reason: "invalid-offer", detail: shapeError });
          return;
        }
        const valid = offer as WorkOffer;
        const taskId = valid.taskId;
        rawCountByTask.set(taskId, (rawCountByTask.get(taskId) ?? 0) + 1);

        if (!ordersById.has(taskId)) {
          rejected.push({ offer: valid, reason: "unknown-task", detail: `no TaskOrder with taskId="${taskId}"` });
          return;
        }

        const pairKey = `${valid.participantId}\u0000${taskId}`;
        if (seenPairs.has(pairKey)) {
          rejected.push({
            offer: valid,
            reason: "duplicate-offer",
            detail: `participant "${valid.participantId}" already submitted an offer for task "${taskId}"; the first offer is kept`,
          });
          return;
        }
        seenPairs.add(pairKey);

        const order = ordersById.get(taskId)!;
        const standing = this.standingOf(valid.participantId);
        const repState = this.reputation.state(valid.participantId, now);
        const reputationScore = repState ? repState.score : 0;

        const gateReason = gateOffer(valid, order, reputationScore, standing);
        if (gateReason) {
          rejected.push({ offer: valid, reason: gateReason, detail: gateDetail(gateReason, valid, order, reputationScore, standing) });
          const list = perTaskRejectionReasons.get(taskId);
          if (list) list.push(gateReason);
          else perTaskRejectionReasons.set(taskId, [gateReason]);
          return;
        }

        const adjustedPCorrect = shrinkClaim(valid.claimedPCorrect, repState, this.shrinkage);
        const value = expectedVerifiedValue(adjustedPCorrect, valid.price);
        const candidate: InternalCandidate = {
          offer: valid,
          index,
          participantId: valid.participantId,
          reputationScore,
          adjustedPCorrect,
          value,
        };
        const list = perTaskCandidates.get(taskId);
        if (list) list.push(candidate);
        else perTaskCandidates.set(taskId, [candidate]);
      } catch (err) {
        rejected.push({
          offer: offer as WorkOffer,
          reason: "invalid-offer",
          detail: `unexpected error while processing offer: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    const matches: Match[] = [];
    const unmatched: ExchangeResult["unmatched"] = [];
    const globallyWon = new Set<ParticipantId>();

    for (const taskId of orderIdsInOrder) {
      const order = ordersById.get(taskId)!;
      const candidates = perTaskCandidates.get(taskId) ?? [];
      const sorted = [...candidates].sort(compareCandidates);
      const eligible = sorted.filter((c) => c.value > 0 && !globallyWon.has(c.participantId));

      if (eligible.length === 0) {
        const raw = rawCountByTask.get(taskId) ?? 0;
        let reason: NoMatchReason;
        if (raw === 0) {
          reason = "no-offers";
        } else if (candidates.length === 0) {
          const reasons = perTaskRejectionReasons.get(taskId) ?? [];
          reason = reasons.length > 0 && reasons.every((r) => r === "below-reserve") ? "reserve-not-met" : "all-offers-rejected";
        } else {
          reason = "all-offers-rejected";
        }
        unmatched.push({ taskId, reason });
        continue;
      }

      const winner = eligible[0];
      const runnerUp = eligible[1] as InternalCandidate | undefined;
      const clearingPrice = computeClearingPrice(winner, runnerUp, order);

      const match: Match = {
        taskId,
        participantId: winner.participantId,
        offerPrice: winner.offer.price,
        clearingPrice,
        claimedPCorrect: winner.offer.claimedPCorrect,
        adjustedPCorrect: winner.adjustedPCorrect,
        expectedVerifiedValue: winner.value,
        reputationScore: winner.reputationScore,
      };
      if (runnerUp) {
        match.runnerUp = { participantId: runnerUp.participantId, expectedVerifiedValue: runnerUp.value };
      }
      matches.push(match);
      globallyWon.add(winner.participantId);
    }

    return { matches, unmatched, rejected };
  }

  /**
   * A deterministic, human-readable ranking table for `taskId` over
   * `offers` as of `now`. Every number shown is one the engine actually
   * computed (`shrinkClaim`/`expectedVerifiedValue`, driven by the real
   * `ReputationLedger`) — this does not apply task-specific gating (no
   * `TaskOrder` is available here), it is purely the reputation-adjusted
   * ranking view.
   */
  explain(taskId: string, offers: readonly WorkOffer[], now: number): string {
    const offerList = Array.isArray(offers) ? offers : [];
    const rows: InternalCandidate[] = [];
    offerList.forEach((offer, index) => {
      if (validateOfferShape(offer) !== null) return;
      const valid = offer as WorkOffer;
      if (valid.taskId !== taskId) return;
      const repState = this.reputation.state(valid.participantId, now);
      const reputationScore = repState ? repState.score : 0;
      const adjustedPCorrect = shrinkClaim(valid.claimedPCorrect, repState, this.shrinkage);
      const value = expectedVerifiedValue(adjustedPCorrect, valid.price);
      rows.push({ offer: valid, index, participantId: valid.participantId, reputationScore, adjustedPCorrect, value });
    });
    rows.sort(compareCandidates);

    const header = `Task ${taskId} — ${rows.length} candidate offer(s), ranked by reputation-adjusted expected verified value per dollar:`;
    if (rows.length === 0) {
      return `${header}\n  (no eligible candidate offers)`;
    }
    const lines = rows.map((r, i) => {
      const rank = String(i + 1).padStart(2, " ");
      return (
        `  ${rank}. participantId=${r.participantId} price=${r.offer.price.toFixed(4)} ` +
        `claimedPCorrect=${r.offer.claimedPCorrect.toFixed(4)} reputationScore=${r.reputationScore.toFixed(4)} ` +
        `adjustedPCorrect=${r.adjustedPCorrect.toFixed(4)} expectedVerifiedValue=${r.value.toFixed(4)}`
      );
    });
    return [header, ...lines].join("\n");
  }
}
