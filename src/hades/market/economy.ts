/**
 * The Verified-Work Economy (T3 — escrow, slashing, standing).
 *
 * This is where an adjudicated claim (`../market/claims.ts`) becomes money
 * and consequence. Workers are AWARDED tasks against an escrowed stake;
 * settling a claim resolves that escrow one of four ways:
 *
 *   - "verified" + gate PASS  -> full Brier-settlement payment (capped at the
 *     posted reward), full stake refund. The honest, successful case.
 *   - "verified" + gate FAIL  -> the certificate is cryptographically genuine
 *     but honestly discloses that the work did not pass verification (its
 *     certified `pCorrect` is below the pass/fail midpoint). This is an
 *     HONEST failure WITH PROOF, distinct from mere abstention: the Brier
 *     settlement rule is applied at outcome=0 (small/zero for a confident
 *     claim, near-full for an honestly-low claim — Brier is
 *     incentive-compatible either way), and only `refundOnHonestFail` of the
 *     stake returns; the rest is forfeit to the treasury.
 *   - "unverified" -> no certificate was ever attached. Honest abstention,
 *     not a lie (see `claims.ts`'s own module doc) — zero payment, but still
 *     only a PARTIAL stake refund (`refundOnHonestFail`): an escrowed stake
 *     that is never proven either way is not a free option.
 *   - "fabricated" -> the participant asserted verified work backed by a
 *     certificate that fails independent re-derivation. Zero payment, the
 *     stake is slashed to the treasury (by default entirely), a
 *     `fabricated: true` reputation event is recorded, and standing
 *     transitions straight to "banned" IN THE SAME SETTLEMENT — no
 *     intermediate warning, no grace period.
 *
 * CONSERVATION: every token in the system is always sitting in exactly one
 * of: a participant's `balance`, a participant's `escrowed`, or the
 * treasury. `totalTokens()` is therefore invariant across every mutating
 * call EXCEPT `register(..., openingBalance)`, which is capitalization (it
 * mints exactly `openingBalance` new tokens into the system, same as the
 * treasury's own `EconomyPolicy.openingBalance` at construction) — every
 * other operation only ever MOVES tokens between those three buckets. A
 * slash never destroys value: whatever a participant does not get refunded
 * (whether from an honest partial-refund or a fabrication slash) is credited
 * to the treasury, in full, in the same settlement.
 *
 * STANDING — a hysteresis-guarded state machine (active -> probation ->
 * demoted -> banned), deliberately asymmetric so a participant hovering
 * right at a threshold does not flap standing every settlement:
 *
 *   - active -> probation the moment EITHER a fast trip-wire fires
 *     (`consecutiveOverclaims >= probationStreak`, i.e. a streak of
 *     non-passing settlements) OR a slow one does (this participant's own
 *     decayed Brier error, read straight from the real `ReputationLedger`,
 *     exceeds `probationBrier`).
 *   - probation -> demoted only on the slow trip-wire escalating further
 *     (decayed Brier > `demoteBrier`).
 *   - probation/demoted -> active ONLY by completing `rehabCertifiedPasses`
 *     CONSECUTIVE verified passes — never by a single good result, and never
 *     merely because decayed Brier happens to dip back under threshold. A
 *     single non-pass mid-streak resets the counter to zero. This is the
 *     genuine rehabilitation path: an honest participant that hits probation
 *     after a bad run earns its way back by being reliably correct again,
 *     not by getting lucky once.
 *   - demoted participants may still be awarded work, but only at
 *     `probationStakeMultiplier`x the normal stake and under a
 *     correspondingly reduced price ceiling (`reward / probationStakeMultiplier`)
 *     — bigger collateral, smaller jobs.
 *   - banned is terminal: reachable ONLY via a proven fabrication, and
 *     `eligible()` refuses a banned participant forever after.
 *
 * This module owns the actual enforced `Standing` transition logic; the
 * `ReputationLedger` it reads from (`./reputation`) only ever emits an
 * ADVISORY `standingHint` on its own `state()` result and says so explicitly
 * in its own module doc — the decayed-Brier NUMBER it computes per
 * participant is real and is not re-derived here (per the locked contract),
 * but the hysteresis-guarded decision of what to DO with that number belongs
 * to `Economy`, not to the ledger.
 *
 * REAL-VS-MOCK: settlement math is the REAL `settlementPayment` from
 * `../styx/market` (never re-derived), claim truth is the REAL
 * `ClaimAdjudicator` from `./claims` (real ed25519 certificates end to end
 * in tests), and calibration bookkeeping is the REAL `ReputationLedger` from
 * `./reputation`. Deterministic: every timestamp this module ever touches is
 * caller-supplied (`postedAt` / `awardedAt` / `claim.submittedAt`) — no
 * `Date.now`, no `Math.random`, no filesystem, no network.
 */

import { settlementPayment, type WorkBid } from "../styx/market";
import {
  type ClaimAdjudication,
  ClaimAdjudicator,
  type ClaimRejectionCode,
  type ClaimStatus,
  type VerifiedClaim,
} from "./claims";
import {
  type ParticipantId,
  type ParticipantKind,
  REPUTATION_UNCERTAINTY_EPS,
  ReputationLedger,
  type Standing,
} from "./reputation";
import type { TierId } from "../styx/tiers";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EconomyErrorCode =
  | "unknown-participant"
  | "unknown-task"
  | "duplicate-task"
  | "duplicate-award"
  | "duplicate-claim"
  | "no-award"
  | "insufficient-balance"
  | "stake-below-minimum"
  | "participant-not-eligible"
  | "deadline-passed"
  | "invalid-amount"
  | "already-settled"
  | "reputation-too-low";

export class EconomyError extends Error {
  readonly code: EconomyErrorCode;

  constructor(code: EconomyErrorCode, message: string) {
    super(message);
    this.name = "EconomyError";
    this.code = code;
    Object.setPrototypeOf(this, EconomyError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface EconomyPolicy {
  /** fraction of price escrowed, default 0.25 */
  stakeFraction: number;
  minStake: number;
  /** fraction of stake burned to treasury on a proven fabrication, default 1 */
  slashOnFabrication: number;
  /** fraction of stake refunded on an honest (unverified or honest-fail) miss, default 0.5 */
  refundOnHonestFail: number;
  /** decayed-Brier threshold (from the real ReputationLedger) that trips active -> probation */
  probationBrier: number;
  /** decayed-Brier threshold that trips probation -> demoted */
  demoteBrier: number;
  /** consecutive non-passing settlements that trip active -> probation, independent of decayed Brier */
  probationStreak: number;
  /** consecutive verified passes required to leave probation/demoted -> active */
  rehabCertifiedPasses: number;
  /** stake multiplier applied to demoted participants' awards */
  probationStakeMultiplier: number;
  /** minimum reputation score (see ReputationLedger.state().score) required to be eligible to bid */
  minReputationToBid: number;
  /** the participant id used to label the treasury bucket in reporting */
  treasuryId: ParticipantId;
  /** the treasury's opening balance, minted at Economy construction */
  openingBalance: number;
}

export function defaultEconomyPolicy(): EconomyPolicy {
  return {
    stakeFraction: 0.25,
    minStake: 1,
    slashOnFabrication: 1,
    refundOnHonestFail: 0.5,
    probationBrier: 0.3,
    demoteBrier: 0.55,
    probationStreak: 3,
    rehabCertifiedPasses: 3,
    probationStakeMultiplier: 2,
    minReputationToBid: 0.05,
    treasuryId: "treasury",
    openingBalance: 100_000,
  };
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ParticipantAccount {
  id: ParticipantId;
  kind: ParticipantKind;
  balance: number;
  escrowed: number;
  standing: Standing;
  consecutiveVerifiedPasses: number;
  consecutiveOverclaims: number;
  settledN: number;
  fabricatedN: number;
}

export interface TaskPosting {
  taskId: string;
  domain: string;
  reward: number;
  difficulty?: number;
  requiredTier?: TierId;
  deadline?: number;
  postedAt: number;
}

export interface AwardRequest {
  taskId: string;
  participantId: ParticipantId;
  price: number;
  claimedPCorrect: number;
  awardedAt: number;
}

export interface AwardRecord extends AwardRequest {
  stake: number;
}

export interface SettlementRecord {
  taskId: string;
  participantId: ParticipantId;
  status: ClaimStatus;
  codes: ClaimRejectionCode[];
  payment: number;
  slashed: number;
  refundedStake: number;
  treasuryDelta: number;
  standingBefore: Standing;
  standingAfter: Standing;
  scoreBefore: number;
  scoreAfter: number;
  settledAt: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const STANDINGS: ReadonlySet<unknown> = new Set<Standing>(["active", "probation", "demoted", "banned"]);

interface AwardEntry {
  record: AwardRecord;
  /** set synchronously the instant a submitClaim() call is accepted, before the async adjudicate() await — blocks a concurrent second submitClaim() for the same task with "duplicate-claim". */
  claimed: boolean;
  /** set once settlement has actually completed — blocks any later submitClaim() for the same task with "already-settled". */
  settled: boolean;
}

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

export class Economy {
  private readonly adjudicator: ClaimAdjudicator;
  private readonly reputationLedger: ReputationLedger;
  private readonly policy: EconomyPolicy;

  private readonly accountsById = new Map<ParticipantId, ParticipantAccount>();
  private readonly tasksById = new Map<string, TaskPosting>();
  private readonly awardsByTaskId = new Map<string, AwardEntry>();
  private readonly settlementHistory: SettlementRecord[] = [];
  private treasuryBalance: number;

  constructor(opts: {
    adjudicator: ClaimAdjudicator;
    reputation?: ReputationLedger;
    policy?: Partial<EconomyPolicy>;
  }) {
    this.adjudicator = opts.adjudicator;
    this.reputationLedger = opts.reputation ?? new ReputationLedger();
    this.policy = { ...defaultEconomyPolicy(), ...opts.policy };
    if (!Number.isFinite(this.policy.openingBalance) || this.policy.openingBalance < 0) {
      throw new RangeError(
        `EconomyPolicy.openingBalance must be a finite number >= 0, got ${this.policy.openingBalance}`,
      );
    }
    this.treasuryBalance = this.policy.openingBalance;
  }

  // ---------------------------------------------------------------------------
  // Registration & posting
  // ---------------------------------------------------------------------------

  register(id: ParticipantId, kind: ParticipantKind, openingBalance = 0): ParticipantAccount {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("participant id must be a non-empty string");
    }
    if (this.accountsById.has(id)) {
      throw new TypeError(`participant "${id}" is already registered`);
    }
    if (!Number.isFinite(openingBalance) || openingBalance < 0) {
      throw new RangeError(`openingBalance must be a finite number >= 0, got ${openingBalance}`);
    }
    const account: ParticipantAccount = {
      id,
      kind,
      balance: openingBalance,
      escrowed: 0,
      standing: "active",
      consecutiveVerifiedPasses: 0,
      consecutiveOverclaims: 0,
      settledN: 0,
      fabricatedN: 0,
    };
    this.accountsById.set(id, account);
    return { ...account };
  }

  postTask(t: TaskPosting): void {
    if (typeof t.taskId !== "string" || t.taskId.length === 0) {
      throw new EconomyError("invalid-amount", "TaskPosting.taskId must be a non-empty string");
    }
    if (!Number.isFinite(t.reward) || t.reward <= 0) {
      throw new EconomyError(
        "invalid-amount",
        `TaskPosting.reward must be a finite number > 0, got ${t.reward}`,
      );
    }
    if (this.tasksById.has(t.taskId)) {
      throw new EconomyError("duplicate-task", `task "${t.taskId}" has already been posted`);
    }
    this.tasksById.set(t.taskId, { ...t });
  }

  // ---------------------------------------------------------------------------
  // Eligibility & award
  // ---------------------------------------------------------------------------

  /**
   * `banned` is checked first and is terminal. The `minReputationToBid` gate
   * is then applied ONLY when this participant's score is actually defined.
   *
   * WHY THE SECOND CONDITION EXISTS (a real cold-start lockout, found while
   * integrating these modules, not a theoretical one): `ReputationLedger`'s
   * score is a Brier SKILL score — `1 - decayedBrier / uncertainty`, where
   * `uncertainty` is the variance of that participant's OWN realized
   * outcomes. Until a participant has both a pass and a fail on record that
   * variance is exactly 0, the skill score is undefined, and the ledger's
   * documented fallback reports `0` for any non-exact forecast. So a
   * perfectly honest worker who settles one task successfully at a calibrated
   * 0.9 scores 0 and — without this condition — is permanently barred from
   * ever bidding again by the very first job they did right. That is a gate
   * misreading "not scoreable yet" as "scored terribly".
   *
   * A participant with NO recorded events at all is still gated (their
   * bootstrap score is 1.0, so any `minReputationToBid > 1` still excludes
   * everyone, deliberately). Fabrication is unaffected: it bans, and the ban
   * is checked above without ever consulting the score.
   */
  eligible(id: ParticipantId): { ok: boolean; reason?: EconomyErrorCode } {
    const account = this.accountsById.get(id);
    if (!account) return { ok: false, reason: "unknown-participant" };
    if (account.standing === "banned") return { ok: false, reason: "participant-not-eligible" };
    if (this.scoreIsDefined(id) && this.scoreOf(id) < this.policy.minReputationToBid) {
      return { ok: false, reason: "reputation-too-low" };
    }
    return { ok: true };
  }

  award(a: AwardRequest): AwardRecord {
    const account = this.accountsById.get(a.participantId);
    if (!account) {
      throw new EconomyError(
        "unknown-participant",
        `cannot award: participant "${a.participantId}" is not registered`,
      );
    }
    const task = this.tasksById.get(a.taskId);
    if (!task) {
      throw new EconomyError("unknown-task", `cannot award: task "${a.taskId}" was never posted`);
    }
    if (this.awardsByTaskId.has(a.taskId)) {
      throw new EconomyError("duplicate-award", `task "${a.taskId}" has already been awarded`);
    }
    if (!Number.isFinite(a.price) || a.price <= 0 || !Number.isFinite(a.claimedPCorrect)) {
      throw new EconomyError(
        "invalid-amount",
        `AwardRequest.price must be a finite number > 0 (got ${a.price}) and claimedPCorrect must be finite (got ${a.claimedPCorrect})`,
      );
    }
    if (task.deadline !== undefined && a.awardedAt > task.deadline) {
      throw new EconomyError(
        "deadline-passed",
        `task "${a.taskId}"'s deadline (${task.deadline}) has passed as of ${a.awardedAt}`,
      );
    }

    const elig = this.eligible(a.participantId);
    if (!elig.ok) {
      throw new EconomyError(
        elig.reason as EconomyErrorCode,
        `participant "${a.participantId}" is not eligible for award: ${elig.reason}`,
      );
    }

    const demoted = account.standing === "demoted";
    if (demoted) {
      const ceiling = task.reward / this.policy.probationStakeMultiplier;
      if (a.price > ceiling) {
        throw new EconomyError(
          "participant-not-eligible",
          `demoted participant "${a.participantId}" price ${a.price} exceeds reduced ceiling ${ceiling} (reward/${this.policy.probationStakeMultiplier})`,
        );
      }
    }

    const stakeMultiplier = demoted ? this.policy.probationStakeMultiplier : 1;
    const stake = a.price * this.policy.stakeFraction * stakeMultiplier;
    if (stake < this.policy.minStake) {
      throw new EconomyError(
        "stake-below-minimum",
        `computed stake ${stake} is below the minimum ${this.policy.minStake}`,
      );
    }
    if (stake > account.balance) {
      throw new EconomyError(
        "insufficient-balance",
        `participant "${a.participantId}" balance ${account.balance} is insufficient to cover stake ${stake}`,
      );
    }

    account.balance -= stake;
    account.escrowed += stake;

    const record: AwardRecord = { ...a, stake };
    this.awardsByTaskId.set(a.taskId, { record, claimed: false, settled: false });
    return { ...record };
  }

  // ---------------------------------------------------------------------------
  // Settlement
  // ---------------------------------------------------------------------------

  async submitClaim(claim: VerifiedClaim): Promise<SettlementRecord> {
    const entry = this.awardsByTaskId.get(claim.taskId);
    if (!entry || entry.record.participantId !== claim.participantId) {
      throw new EconomyError(
        "no-award",
        `no award exists for task "${claim.taskId}" and participant "${claim.participantId}"`,
      );
    }
    if (entry.settled) {
      throw new EconomyError(
        "already-settled",
        `the award for task "${claim.taskId}" has already been settled`,
      );
    }
    if (entry.claimed) {
      throw new EconomyError(
        "duplicate-claim",
        `a claim for task "${claim.taskId}" is already being processed`,
      );
    }
    // Synchronous re-entrancy guard, set BEFORE the async adjudicate() await,
    // so a second submitClaim() fired before this one resolves is rejected
    // immediately rather than racing the settlement.
    entry.claimed = true;

    const safeAt = Number.isFinite(claim.submittedAt) ? claim.submittedAt : 0;
    let adjudication: ClaimAdjudication;
    try {
      adjudication = await this.adjudicator.adjudicate(claim, safeAt);
    } catch (err) {
      entry.claimed = false;
      throw err;
    }

    const award = entry.record;
    const task = this.tasksById.get(award.taskId);
    const account = this.accountsById.get(award.participantId);
    /* istanbul ignore next -- invariant: an award always has a live task and account */
    if (!task || !account) {
      entry.claimed = false;
      throw new EconomyError(
        "unknown-task",
        `internal invariant violated: award for "${award.taskId}" outlived its task/account`,
      );
    }
    const stake = award.stake;

    const standingBefore = account.standing;
    const scoreBefore = this.scoreOf(award.participantId);

    let payment = 0;
    let refundedStake = 0;
    let slashed = 0;
    let gateOutcome: 0 | 1 = 0;
    let isVerifiedPassEvent = false;
    let certified = false;
    let fabricated = false;
    let reason: string;

    if (adjudication.status === "verified") {
      certified = true;
      const certifiedPCorrect = adjudication.pCorrect ?? 0;
      const gatePassed = certifiedPCorrect >= 0.5;
      gateOutcome = gatePassed ? 1 : 0;
      const bid: WorkBid = {
        workerId: award.participantId,
        taskId: award.taskId,
        claimedPCorrect: award.claimedPCorrect,
        price: award.price,
      };
      const rawPayment = settlementPayment(bid, gatePassed);
      // Two ceilings, both hard: the posted reward (a task never pays more
      // than it advertised) and the treasury's actual balance. The second is
      // solvency — every payment is drawn FROM the treasury, and without this
      // a long run of successful settlements would drive `treasury()`
      // negative, i.e. the economy would pay out tokens that do not exist
      // while `totalTokens()` still "conserved". Conservation across three
      // buckets is not solvency; this is.
      payment = Math.min(rawPayment, task.reward, Math.max(0, this.treasuryBalance));
      if (gatePassed) {
        isVerifiedPassEvent = true;
        refundedStake = stake;
        reason = `verified: certificate genuine, gate outcome PASS (certified pCorrect=${certifiedPCorrect.toFixed(6)}) — Brier payment ${payment.toFixed(6)} (capped at reward ${task.reward}), full stake refund`;
      } else {
        refundedStake = stake * this.policy.refundOnHonestFail;
        reason = `verified: certificate genuine, gate outcome FAIL (certified pCorrect=${certifiedPCorrect.toFixed(6)}) — honest disclosed failure, Brier payment ${payment.toFixed(6)} at outcome 0, ${(this.policy.refundOnHonestFail * 100).toFixed(0)}% stake refund`;
      }
      slashed = stake - refundedStake;
    } else if (adjudication.status === "unverified") {
      certified = false;
      payment = 0;
      refundedStake = stake * this.policy.refundOnHonestFail;
      slashed = stake - refundedStake;
      reason = `unverified: no certificate attached (${adjudication.codes.join(", ") || "no-certificate"}) — honest abstention, zero payment, ${(this.policy.refundOnHonestFail * 100).toFixed(0)}% stake refund`;
    } else {
      certified = false;
      fabricated = true;
      payment = 0;
      slashed = stake * this.policy.slashOnFabrication;
      refundedStake = stake - slashed;
      reason = `fabricated: certificate rejected (${adjudication.codes.join(", ")}) — full stake forfeit to treasury, standing -> banned`;
    }

    const claimedP = clamp01(award.claimedPCorrect);
    this.reputationLedger.record({
      participantId: award.participantId,
      kind: account.kind,
      taskId: award.taskId,
      claimedP,
      outcome: gateOutcome,
      certified,
      fabricated,
      ...(task.difficulty !== undefined ? { difficulty: task.difficulty } : {}),
      at: safeAt,
      ...(adjudication.certSha256 !== undefined ? { certSha256: adjudication.certSha256 } : {}),
    });

    const scoreAfter = this.scoreOf(award.participantId);
    const decayedBrierAfter = this.decayedBrierOf(award.participantId);

    if (isVerifiedPassEvent) {
      account.consecutiveVerifiedPasses += 1;
      account.consecutiveOverclaims = 0;
    } else {
      account.consecutiveOverclaims += 1;
      account.consecutiveVerifiedPasses = 0;
    }
    account.settledN += 1;
    if (fabricated) account.fabricatedN += 1;

    let standingAfter: Standing;
    if (fabricated) {
      standingAfter = "banned";
    } else {
      standingAfter = standingBefore;
      if (standingBefore === "active") {
        if (
          account.consecutiveOverclaims >= this.policy.probationStreak ||
          decayedBrierAfter > this.policy.probationBrier
        ) {
          standingAfter = "probation";
        }
      } else if (standingBefore === "probation") {
        if (decayedBrierAfter > this.policy.demoteBrier) {
          standingAfter = "demoted";
        } else if (account.consecutiveVerifiedPasses >= this.policy.rehabCertifiedPasses) {
          standingAfter = "active";
        }
      } else if (standingBefore === "demoted") {
        if (account.consecutiveVerifiedPasses >= this.policy.rehabCertifiedPasses) {
          standingAfter = "active";
        }
      }
      // "banned" is terminal and unreachable here except via `fabricated`
      // above — a banned participant can never be awarded again, so this
      // branch never actually observes standingBefore === "banned".
    }
    account.standing = standingAfter;

    account.escrowed -= stake;
    account.balance += refundedStake + payment;
    this.treasuryBalance += slashed - payment;

    entry.settled = true;

    const settlementRecord: SettlementRecord = {
      taskId: award.taskId,
      participantId: award.participantId,
      status: adjudication.status,
      codes: [...adjudication.codes],
      payment,
      slashed,
      refundedStake,
      treasuryDelta: slashed - payment,
      standingBefore,
      standingAfter,
      scoreBefore,
      scoreAfter,
      settledAt: safeAt,
      reason,
    };
    this.settlementHistory.push(settlementRecord);
    return { ...settlementRecord, codes: [...settlementRecord.codes] };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  account(id: ParticipantId): ParticipantAccount {
    const account = this.accountsById.get(id);
    if (!account) {
      throw new EconomyError("unknown-participant", `no participant registered with id "${id}"`);
    }
    return { ...account };
  }

  accounts(): ParticipantAccount[] {
    return [...this.accountsById.values()].map((a) => ({ ...a }));
  }

  standing(id: ParticipantId): Standing {
    return this.account(id).standing;
  }

  balances(): Record<ParticipantId, number> {
    const out: Record<ParticipantId, number> = {};
    for (const a of this.accountsById.values()) out[a.id] = a.balance;
    return out;
  }

  treasury(): number {
    return this.treasuryBalance;
  }

  /** Sum of every balance + every escrowed amount + the treasury. Invariant across every operation except `register(..., openingBalance)`. */
  totalTokens(): number {
    let total = this.treasuryBalance;
    for (const a of this.accountsById.values()) {
      total += a.balance + a.escrowed;
    }
    return total;
  }

  reputation(): ReputationLedger {
    return this.reputationLedger;
  }

  history(): readonly SettlementRecord[] {
    return this.settlementHistory.map((r) => ({ ...r, codes: [...r.codes] }));
  }

  serialize(): string {
    const accountsOut = [...this.accountsById.values()];
    const tasksOut = [...this.tasksById.values()];
    const awardsOut = [...this.awardsByTaskId.entries()].map(([taskId, e]) => ({
      taskId,
      record: e.record,
      claimed: e.claimed,
      settled: e.settled,
    }));
    return JSON.stringify({
      policy: this.policy,
      treasuryBalance: this.treasuryBalance,
      accounts: accountsOut,
      tasks: tasksOut,
      awards: awardsOut,
      history: this.settlementHistory,
      reputationLedger: JSON.parse(this.reputationLedger.serialize()),
    });
  }

  /** Every award ever made, in the order it was made — open and settled alike. */
  awards(): AwardRecord[] {
    return [...this.awardsByTaskId.values()].map((e) => ({ ...e.record }));
  }

  /** Every posted task, in posting order. */
  tasks(): TaskPosting[] {
    return [...this.tasksById.values()].map((t) => ({ ...t }));
  }

  /** Awards that have been made but not yet settled — the live escrow book. */
  openAwards(): AwardRecord[] {
    return [...this.awardsByTaskId.values()].filter((e) => !e.settled).map((e) => ({ ...e.record }));
  }

  /**
   * Rebuild an `Economy` from {@link serialize} output, restoring the
   * treasury, every account (balance, escrow, standing, streak counters),
   * every posted task, every award with its exact claimed/settled flags, the
   * full settlement history, and the hash-chained reputation ledger.
   *
   * The caller supplies the adjudicator because it holds the trust policy
   * (and the replay registry, which has its own
   * `ClaimAdjudicator.serializeReplayRegistry()` persistence) — key material
   * and issuer policy are never written into economy state.
   *
   * Throws `TypeError` on any malformed envelope rather than returning a
   * partially-restored economy: a half-loaded escrow book would silently
   * violate the conservation invariant this class exists to hold.
   */
  static deserialize(json: string, opts: { adjudicator: ClaimAdjudicator }): Economy {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new TypeError(`economy state is not valid JSON: ${(err as Error).message}`);
    }
    if (!isRecord(parsed)) throw new TypeError("unrecognized economy envelope: not an object");
    const {
      policy,
      treasuryBalance,
      accounts,
      tasks,
      awards,
      history,
      reputationLedger,
    } = parsed as Record<string, unknown>;

    if (!isRecord(policy)) throw new TypeError("unrecognized economy envelope: missing policy");
    if (typeof treasuryBalance !== "number" || !Number.isFinite(treasuryBalance)) {
      throw new TypeError("unrecognized economy envelope: treasuryBalance must be a finite number");
    }
    if (!Array.isArray(accounts) || !Array.isArray(tasks) || !Array.isArray(awards) || !Array.isArray(history)) {
      throw new TypeError("unrecognized economy envelope: accounts/tasks/awards/history must be arrays");
    }
    if (!isRecord(reputationLedger)) {
      throw new TypeError("unrecognized economy envelope: missing reputationLedger");
    }

    const ledger = ReputationLedger.deserialize(JSON.stringify(reputationLedger));
    const economy = new Economy({
      adjudicator: opts.adjudicator,
      reputation: ledger,
      policy: policy as Partial<EconomyPolicy>,
    });
    economy.treasuryBalance = treasuryBalance;

    for (const raw of accounts) {
      if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
        throw new TypeError("malformed economy account entry");
      }
      const a = raw as unknown as ParticipantAccount;
      for (const k of ["balance", "escrowed", "consecutiveVerifiedPasses", "consecutiveOverclaims", "settledN", "fabricatedN"] as const) {
        if (typeof a[k] !== "number" || !Number.isFinite(a[k])) {
          throw new TypeError(`malformed economy account "${a.id}": ${k} must be a finite number`);
        }
      }
      if (!STANDINGS.has(a.standing)) {
        throw new TypeError(`malformed economy account "${a.id}": unknown standing ${String(a.standing)}`);
      }
      economy.accountsById.set(a.id, { ...a });
    }
    for (const raw of tasks) {
      if (!isRecord(raw) || typeof raw.taskId !== "string" || raw.taskId.length === 0) {
        throw new TypeError("malformed economy task entry");
      }
      economy.tasksById.set(raw.taskId as string, { ...(raw as unknown as TaskPosting) });
    }
    for (const raw of awards) {
      if (
        !isRecord(raw) ||
        typeof raw.taskId !== "string" ||
        !isRecord(raw.record) ||
        typeof raw.claimed !== "boolean" ||
        typeof raw.settled !== "boolean"
      ) {
        throw new TypeError("malformed economy award entry");
      }
      const record = raw.record as unknown as AwardRecord;
      if (typeof record.stake !== "number" || !Number.isFinite(record.stake)) {
        throw new TypeError(`malformed economy award for task "${raw.taskId}": stake must be a finite number`);
      }
      economy.awardsByTaskId.set(raw.taskId, {
        record: { ...record },
        // A claim that was mid-flight when the process died is NOT settled;
        // restoring `claimed: true` would wedge that award forever with
        // "duplicate-claim". Only `settled` is authoritative across a restart.
        claimed: raw.settled,
        settled: raw.settled,
      });
    }
    for (const raw of history) {
      if (!isRecord(raw) || typeof raw.taskId !== "string") {
        throw new TypeError("malformed economy settlement-history entry");
      }
      const rec = raw as unknown as SettlementRecord;
      economy.settlementHistory.push({ ...rec, codes: Array.isArray(rec.codes) ? [...rec.codes] : [] });
    }
    return economy;
  }

  // ---------------------------------------------------------------------------
  // private
  // ---------------------------------------------------------------------------

  private scoreOf(id: ParticipantId): number {
    const s = this.reputationLedger.state(id);
    return s ? s.score : 1;
  }

  /**
   * True iff `id`'s reputation score is a meaningful measurement rather than
   * the ledger's undefined-skill-score fallback. See {@link eligible}.
   * A participant with no events at all reports `true`: their bootstrap
   * score (1.0) is a real, deliberate policy value, not a degenerate one.
   */
  private scoreIsDefined(id: ParticipantId): boolean {
    const s = this.reputationLedger.state(id);
    if (!s) return true;
    if (s.fabricatedN > 0) return true; // a hard zero, and it means exactly what it says
    return s.decomposition.uncertainty > REPUTATION_UNCERTAINTY_EPS;
  }

  private decayedBrierOf(id: ParticipantId): number {
    const s = this.reputationLedger.state(id);
    return s ? s.decayedBrier : 0;
  }
}
