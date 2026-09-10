/**
 * Conformal route risk control — the gate that decides what the router
 * actually DOES with a calibrated score.
 *
 * This module sits directly on top of the shipped STYX conformal machinery
 * (`../styx/gate`, `../styx/tiers`) and never re-derives it: every threshold
 * this module reports comes from a real {@link ConformalGate} instance (or
 * the pure {@link conformalThreshold} helper it wraps), fit per Mondrian
 * stratum. This module's own job is everything ABOVE the threshold math:
 *
 *   - **Mondrian stratification** — a threshold fit on "arm X at tier Y" is
 *     honest about its own evidence; it must never silently borrow a looser
 *     bound from a bigger, unrelated pool. A stratum with too little
 *     evidence either falls back to an explicit, labelled pooled model
 *     (`source: "pooled"`) or abstains outright (`source: "none"`,
 *     `threshold: Infinity`) — the caller can always see which happened.
 *   - **Split epsilon budget** — optionally Bonferroni-splits the base ε
 *     across the live strata so that running many parallel per-arm gates
 *     does not silently inflate the *combined* silent-wrong rate above ε.
 *   - **The accept/escalate/fan-out/abstain policy** — turns a single
 *     calibrated `pCorrect` into an actual routing action: accept the
 *     current (cheapest-that-verifies) arm, escalate to a stronger one
 *     (chosen by expected verified-value per MARGINAL dollar), fan out to
 *     several arms and require a quorum, or abstain — never emitting an
 *     "accept" when the underlying stratum could not be calibrated.
 *   - **Correlation-aware fan-out aggregation** — arms sharing a `provider`
 *     are not independent evidence. Naive probability multiplication across
 *     "independent" votes is the single easiest way to manufacture false
 *     confidence out of correlated failures (three calls to the same
 *     provider agreeing is not three independent checks); this module
 *     discounts repeated same-provider agreement so a fan-out of N
 *     same-provider arms never earns the confidence of N independent ones.
 *
 * ## Where the ε bound comes from, and where it can break
 *
 * Every stratum threshold is the real split-conformal threshold documented
 * in `../styx/gate`: distribution-free, exchangeability-only, with the
 * `(k+1)/(n+1)` finite-sample correction. That guarantee is MARGINAL (holds
 * on average over draws of the calibration set) and breaks under
 * distribution shift exactly as `../styx/gate` documents — recalibrate
 * whenever the arm roster, the verifier ensemble, or the task mix changes.
 * `docs/STYX_ARCHITECTURE.md` describes the wider verification thesis this
 * module is one gate inside of.
 *
 * ## The accept bar
 *
 * `acceptBar = max(stratumThreshold, tierConfidenceFloor(tier, epsilon))`,
 * unless the caller supplies `confidenceFloor` explicitly (in which case
 * that value is used as the floor instead of the tier-derived one). Because
 * this is a `max`, the floor can only TIGHTEN the bar the conformal
 * threshold already set — it can never loosen it below what calibration
 * earned. `threshold === Infinity` therefore always survives the `max` and
 * always produces `abstain`, never `accept` — this is the one path where a
 * silent-wrong could leak, so it is structural, not a special case.
 *
 * Pure and deterministic: no `Math.random`, no clock, no I/O. Identical
 * inputs (in any calibration-point ordering) produce identical profiles and
 * identical verdicts.
 *
 * @module hades/routing/risk
 */

import {
  ConformalGate,
  conformalThreshold,
  type CalibrationPoint,
  type GateStats,
  type GateDecision,
} from "../styx/gate";
import { type TierId, tierConfidenceFloor, routeTier, type TaskSignals } from "../styx/tiers";

// `conformalThreshold` is the pure function `ConformalGate` (used below)
// fits every stratum threshold with — imported per the locked contract so
// this module's dependency on the SAME conformal math is typo-checked, even
// though `ConformalGate.calibrate` (not the free function directly) is what
// this file calls. `GateDecision`, `routeTier`, and `TaskSignals` are
// likewise imported per the locked contract as the shared STYX vocabulary
// this module stays interoperable with (a caller routes `TaskSignals` ->
// `routeTier` -> the `tier` this module's `profile`/`decide` accept), even
// though `decide`/`profile` deliberately take an already-decided `tier`
// rather than calling `routeTier` themselves.

// ===========================================================================
// Locked public types
// ===========================================================================

/** How calibration points are grouped into Mondrian strata. */
export type Stratum = "arm" | "arm+tier" | "tier";

/** Configuration for a {@link ConformalRouteRisk}. */
export interface RouteRiskConfig {
  /** Base silent-wrong risk budget, strictly in (0, 1). */
  epsilon: number;
  /** Grouping granularity for calibration. Default `"arm+tier"`. */
  stratifyBy?: Stratum;
  /**
   * Minimum calibration points a stratum needs before it gets its OWN
   * conformal threshold. Below this, `fallback` decides what happens.
   * Default 20 (matches `ConformalGate`'s own default).
   */
  minCalibration?: number;
  /**
   * What an under-calibrated stratum does: borrow a single global pooled
   * threshold (`"pooled"`, only if the POOL itself has ≥ `minCalibration`
   * points — otherwise it degrades further to `"none"`), or abstain
   * outright (`"abstain"`, `threshold: Infinity`). Default `"abstain"` —
   * pooling is opt-in because it changes what the ε bound is measured over.
   */
  fallback?: "pooled" | "abstain";
  /**
   * `"bonferroni"` divides `epsilon` by the number of LIVE strata (strata
   * that individually clear `minCalibration` and get `source: "stratum"`)
   * before fitting each one's threshold, so running many parallel gates
   * does not inflate the combined silent-wrong rate above the base ε.
   * `"none"` (default) fits every stratum threshold at the full `epsilon`.
   * Pooled/abstain-fallback strata are not part of the split — the pooled
   * model is fit once, at the full `epsilon`, and shared.
   */
  epsilonSplit?: "bonferroni" | "none";
  /**
   * How much a REPEATED vote from a provider already represented in a
   * fan-out group counts, in `aggregateFanOut`: the first arm from a
   * provider contributes weight 1, every subsequent arm from that SAME
   * provider (agreeing or not, tallied per output group) contributes this
   * weight instead of 1. Must be in [0, 1]. Default 0.5 — a second
   * same-provider vote is worth half an independent one.
   */
  independenceDiscount?: number;
  /**
   * Hard cap on how many `"escalate"` verdicts `decide` will hand out for a
   * single request chain (tracked by the caller via `escalations` on each
   * call). Once `escalations >= maxEscalations`, `decide` will not propose
   * another escalation (though it may still propose fan-out, or abstain).
   * Default `Infinity` (uncapped).
   */
  maxEscalations?: number;
}

/** One labeled calibration example for the route-risk gate. */
export interface RiskCalibrationPoint {
  armId: string;
  tier: TierId;
  score: number;
  correct: boolean;
}

/** The fitted (or explicitly unfitted) risk profile of one Mondrian stratum. */
export interface ArmRiskProfile {
  /** Stable internal key identifying this stratum (implementation detail, but deterministic). */
  key: string;
  /** The arm this profile describes, or `null` if `stratifyBy` doesn't key on arm. */
  armId: string | null;
  /** The tier this profile describes, or `null` if `stratifyBy` doesn't key on tier. */
  tier: TierId | null;
  /** The accept threshold on the calibration score scale. `Infinity` ⇒ never accept from this profile alone. */
  threshold: number;
  /** The ε actually used to fit `threshold` (post Bonferroni split, if any). */
  epsilonUsed: number;
  /** Fraction of this stratum's OWN calibration points at/above `threshold` (0 for `source: "none"`). */
  coverage: number;
  /** Empirical wrong-rate among this stratum's OWN calibration points at/above `threshold` (1 for `source: "none"`). */
  empiricalRisk: number;
  /** How many calibration points THIS stratum itself contributed (not the pool it may have borrowed from). */
  calibrationSize: number;
  /** Where `threshold` came from: this stratum's own fit, a shared pooled fit, or nothing at all. */
  source: "stratum" | "pooled" | "none";
}

export interface RouteDecisionInput {
  armId: string;
  tier: TierId;
  pCorrect: number;
  /** Overrides the tier-derived confidence floor if supplied. Must be in [0, 1]. */
  confidenceFloor?: number;
  /** Candidate arms to escalate to, in caller-supplied (not necessarily value-ranked) order. */
  escalationLadder: readonly string[];
  /** Candidate arms to consider fanning out to. */
  fanOutCandidates: readonly string[];
  /** Marginal USD cost of pulling a given arm. Must return a finite number ≥ 0. */
  costOf: (armId: string) => number;
  spentUsd: number;
  budgetUsd: number;
  /** How many escalations have already happened in this request chain. */
  escalations: number;
}

export type EscalateReason = "below-threshold" | "below-tier-floor" | "uncalibrated-stratum";
export type AbstainReason =
  | "no-calibration"
  | "threshold-infinite"
  | "budget-exhausted"
  | "ladder-exhausted"
  | "fan-out-no-quorum";

export type RouteVerdict =
  | { action: "accept"; armId: string; threshold: number; pCorrect: number; profile: ArmRiskProfile }
  | { action: "escalate"; nextArmId: string; reason: EscalateReason; threshold: number; expectedGainPerUsd: number }
  | { action: "fan-out"; armIds: readonly string[]; quorum: number; estimatedUsd: number; effectiveN: number }
  | { action: "abstain"; reason: AbstainReason; threshold: number; pCorrect: number };

/** One arm's result from an actual fan-out execution, ready to aggregate. */
export interface FanOutResult {
  armId: string;
  pCorrect: number;
  provider: string;
  output: string;
}

export interface FanOutVerdict {
  pCorrect: number;
  agreeingArms: readonly string[];
  majorityOutput: string | null;
  effectiveN: number;
  verdict: "accept" | "abstain";
}

/** Typed error for every validation failure and unrecoverable-state throw in this module. */
export class RouteRiskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RouteRiskError";
    this.code = code;
  }
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/** A fan-out cost/division-by-zero floor: never let a $0 arm produce Infinity value-per-dollar. */
const COST_FLOOR_USD = 1e-6;

interface PooledFit {
  threshold: number;
  epsilonUsed: number;
  coverage: number;
  empiricalRisk: number;
  calibrationSize: number;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function keyFor(stratifyBy: Stratum, armId: string, tier: TierId): string {
  switch (stratifyBy) {
    case "arm":
      return `arm:${armId}`;
    case "tier":
      return `tier:${tier}`;
    case "arm+tier":
      return `arm+tier:${armId}\u0001${tier}`;
  }
}

function identityFor(
  stratifyBy: Stratum,
  armId: string,
  tier: TierId,
): { armId: string | null; tier: TierId | null } {
  if (stratifyBy === "arm") return { armId, tier: null };
  if (stratifyBy === "tier") return { armId: null, tier };
  return { armId, tier };
}

function validateCalibrationPoint(p: RiskCalibrationPoint): void {
  if (!p || typeof p !== "object") {
    throw new RouteRiskError("invalid-calibration-point", "calibrate: each point must be an object");
  }
  if (typeof p.armId !== "string" || p.armId.length === 0) {
    throw new RouteRiskError("invalid-arm-id", "calibrate: armId must be a non-empty string");
  }
  if (typeof p.tier !== "string" || p.tier.length === 0) {
    throw new RouteRiskError("invalid-tier", "calibrate: tier must be a non-empty string");
  }
  if (typeof p.score !== "number" || !Number.isFinite(p.score)) {
    throw new RouteRiskError("invalid-score", `calibrate: score must be a finite number; got ${p.score}`);
  }
  if (typeof p.correct !== "boolean") {
    throw new RouteRiskError("invalid-correct", "calibrate: correct must be a boolean");
  }
}

function assertNoDuplicates(arr: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const a of arr) {
    if (seen.has(a)) {
      throw new RouteRiskError("duplicate-arm-id", `decide: ${label} contains duplicate arm id "${a}"`);
    }
    seen.add(a);
  }
}

function validateDecisionInput(input: RouteDecisionInput): void {
  if (!input || typeof input !== "object") {
    throw new RouteRiskError("invalid-input", "decide: input must be an object");
  }
  if (typeof input.armId !== "string" || input.armId.length === 0) {
    throw new RouteRiskError("invalid-arm-id", "decide: armId must be a non-empty string");
  }
  if (typeof input.pCorrect !== "number" || !Number.isFinite(input.pCorrect) || input.pCorrect < 0 || input.pCorrect > 1) {
    throw new RouteRiskError("invalid-pcorrect", `decide: pCorrect must be a finite number in [0,1]; got ${input.pCorrect}`);
  }
  if (input.confidenceFloor !== undefined) {
    if (typeof input.confidenceFloor !== "number" || !Number.isFinite(input.confidenceFloor) || input.confidenceFloor < 0 || input.confidenceFloor > 1) {
      throw new RouteRiskError(
        "invalid-confidence-floor",
        `decide: confidenceFloor must be a finite number in [0,1]; got ${input.confidenceFloor}`,
      );
    }
  }
  if (!Array.isArray(input.escalationLadder)) {
    throw new RouteRiskError("invalid-ladder", "decide: escalationLadder must be an array");
  }
  for (const a of input.escalationLadder) {
    if (typeof a !== "string" || a.length === 0) {
      throw new RouteRiskError("invalid-ladder", "decide: escalationLadder entries must be non-empty strings");
    }
  }
  assertNoDuplicates(input.escalationLadder, "escalationLadder");
  if (!Array.isArray(input.fanOutCandidates)) {
    throw new RouteRiskError("invalid-fan-out-candidates", "decide: fanOutCandidates must be an array");
  }
  for (const a of input.fanOutCandidates) {
    if (typeof a !== "string" || a.length === 0) {
      throw new RouteRiskError("invalid-fan-out-candidates", "decide: fanOutCandidates entries must be non-empty strings");
    }
  }
  assertNoDuplicates(input.fanOutCandidates, "fanOutCandidates");
  if (typeof input.costOf !== "function") {
    throw new RouteRiskError("invalid-cost-fn", "decide: costOf must be a function");
  }
  if (typeof input.spentUsd !== "number" || !Number.isFinite(input.spentUsd) || input.spentUsd < 0) {
    throw new RouteRiskError("invalid-spent", `decide: spentUsd must be a finite number >= 0; got ${input.spentUsd}`);
  }
  if (typeof input.budgetUsd !== "number" || !Number.isFinite(input.budgetUsd) || input.budgetUsd < 0) {
    throw new RouteRiskError("invalid-budget", `decide: budgetUsd must be a finite number >= 0; got ${input.budgetUsd}`);
  }
  if (typeof input.escalations !== "number" || !Number.isInteger(input.escalations) || input.escalations < 0) {
    throw new RouteRiskError("invalid-escalations", `decide: escalations must be a non-negative integer; got ${input.escalations}`);
  }
}

function safeCost(costOf: (armId: string) => number, armId: string): number {
  const c = costOf(armId);
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0) {
    throw new RouteRiskError("invalid-cost-value", `decide: costOf("${armId}") must return a finite number >= 0; got ${c}`);
  }
  return c;
}

function tierFloorOrThrow(tier: TierId, epsilon: number): number {
  try {
    return tierConfidenceFloor(tier, epsilon);
  } catch (err) {
    throw new RouteRiskError(
      "invalid-tier",
      `invalid tier ${JSON.stringify(tier)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ===========================================================================
// ConformalRouteRisk
// ===========================================================================

export class ConformalRouteRisk {
  private readonly epsilon: number;
  private readonly stratifyBy: Stratum;
  private readonly minCalibration: number;
  private readonly fallback: "pooled" | "abstain";
  private readonly epsilonSplit: "bonferroni" | "none";
  private readonly independenceDiscount: number;
  private readonly maxEscalations: number;

  private profiles: Map<string, ArmRiskProfile> = new Map();
  private pooledFit: PooledFit | null = null;
  private calibrated = false;

  constructor(cfg: RouteRiskConfig) {
    if (!cfg || typeof cfg !== "object") {
      throw new RouteRiskError("invalid-config", "ConformalRouteRisk: config must be an object");
    }

    const { epsilon } = cfg;
    if (typeof epsilon !== "number" || !Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 1) {
      throw new RouteRiskError("invalid-epsilon", `ConformalRouteRisk: epsilon must be strictly in (0,1); got ${epsilon}`);
    }
    this.epsilon = epsilon;

    const stratifyBy = cfg.stratifyBy ?? "arm+tier";
    if (stratifyBy !== "arm" && stratifyBy !== "tier" && stratifyBy !== "arm+tier") {
      throw new RouteRiskError(
        "invalid-stratify-by",
        `ConformalRouteRisk: stratifyBy must be "arm" | "arm+tier" | "tier"; got ${JSON.stringify(stratifyBy)}`,
      );
    }
    this.stratifyBy = stratifyBy;

    const minCalibration = cfg.minCalibration ?? 20;
    if (!Number.isInteger(minCalibration) || minCalibration < 1) {
      throw new RouteRiskError(
        "invalid-min-calibration",
        `ConformalRouteRisk: minCalibration must be a positive integer; got ${minCalibration}`,
      );
    }
    this.minCalibration = minCalibration;

    const fallback = cfg.fallback ?? "abstain";
    if (fallback !== "pooled" && fallback !== "abstain") {
      throw new RouteRiskError(
        "invalid-fallback",
        `ConformalRouteRisk: fallback must be "pooled" | "abstain"; got ${JSON.stringify(fallback)}`,
      );
    }
    this.fallback = fallback;

    const epsilonSplit = cfg.epsilonSplit ?? "none";
    if (epsilonSplit !== "bonferroni" && epsilonSplit !== "none") {
      throw new RouteRiskError(
        "invalid-epsilon-split",
        `ConformalRouteRisk: epsilonSplit must be "bonferroni" | "none"; got ${JSON.stringify(epsilonSplit)}`,
      );
    }
    this.epsilonSplit = epsilonSplit;

    const independenceDiscount = cfg.independenceDiscount ?? 0.5;
    if (
      typeof independenceDiscount !== "number" ||
      !Number.isFinite(independenceDiscount) ||
      independenceDiscount < 0 ||
      independenceDiscount > 1
    ) {
      throw new RouteRiskError(
        "invalid-independence-discount",
        `ConformalRouteRisk: independenceDiscount must be in [0,1]; got ${independenceDiscount}`,
      );
    }
    this.independenceDiscount = independenceDiscount;

    const maxEscalations = cfg.maxEscalations ?? Infinity;
    if (
      typeof maxEscalations !== "number" ||
      Number.isNaN(maxEscalations) ||
      maxEscalations < 0 ||
      (Number.isFinite(maxEscalations) && !Number.isInteger(maxEscalations))
    ) {
      throw new RouteRiskError(
        "invalid-max-escalations",
        `ConformalRouteRisk: maxEscalations must be a non-negative integer or Infinity; got ${maxEscalations}`,
      );
    }
    this.maxEscalations = maxEscalations;
  }

  /**
   * Fit one {@link ArmRiskProfile} per distinct stratum key observed in
   * `points` (grouped per `stratifyBy`), using REAL `ConformalGate`
   * instances — never a hand-rolled quantile. Recalibrating replaces all
   * prior state. Returns a fresh `Map` (safe to mutate by the caller
   * without touching internal state).
   *
   * @throws {RouteRiskError} on any malformed calibration point.
   */
  calibrate(points: readonly RiskCalibrationPoint[]): Map<string, ArmRiskProfile> {
    if (!Array.isArray(points)) {
      throw new RouteRiskError("invalid-calibration-points", "calibrate: points must be an array");
    }

    const grouped = new Map<string, RiskCalibrationPoint[]>();
    for (const p of points) {
      validateCalibrationPoint(p);
      const key = keyFor(this.stratifyBy, p.armId, p.tier);
      let arr = grouped.get(key);
      if (!arr) {
        arr = [];
        grouped.set(key, arr);
      }
      arr.push(p);
    }

    // Live strata: those that will actually get their OWN conformal fit.
    // Only these participate in a Bonferroni epsilon split.
    let liveCount = 0;
    for (const arr of grouped.values()) {
      if (arr.length >= this.minCalibration) liveCount += 1;
    }
    const perStratumEpsilon =
      this.epsilonSplit === "bonferroni" && liveCount > 0 ? this.epsilon / liveCount : this.epsilon;

    // Pooled fallback model: fit once, at the FULL (unsplit) epsilon, over
    // every calibration point regardless of stratum. Only attempted when
    // `fallback === "pooled"` and the pool itself clears minCalibration —
    // otherwise under-calibrated strata degrade all the way to "none"
    // rather than borrow a fit that was never actually validated.
    let pooledFit: PooledFit | null = null;
    if (this.fallback === "pooled" && points.length >= this.minCalibration) {
      const pooledPoints: CalibrationPoint[] = points.map((p) => ({ score: p.score, correct: p.correct }));
      const gate = new ConformalGate({ epsilon: this.epsilon, minCalibration: this.minCalibration });
      const gs: GateStats = gate.calibrate(pooledPoints);
      pooledFit = {
        threshold: gs.threshold,
        epsilonUsed: this.epsilon,
        coverage: gs.coverageAtThreshold,
        empiricalRisk: gs.empiricalRiskAtThreshold,
        calibrationSize: points.length,
      };
    }
    this.pooledFit = pooledFit;

    const profiles = new Map<string, ArmRiskProfile>();
    for (const [key, arr] of grouped) {
      const sample = arr[0];
      const { armId, tier } = identityFor(this.stratifyBy, sample.armId, sample.tier);
      profiles.set(key, this.buildProfile(key, armId, tier, arr, perStratumEpsilon));
    }

    this.profiles = profiles;
    this.calibrated = true;
    return new Map(profiles);
  }

  /**
   * Look up (or, for a stratum never seen at calibration time, freshly
   * derive) the {@link ArmRiskProfile} for `(armId, tier)` under the
   * configured `stratifyBy`. Never throws for an unseen combination — it
   * resolves to the same fallback logic `calibrate` uses (pooled or none).
   *
   * @throws {RouteRiskError} if `calibrate` has never been called, or
   *   `armId`/`tier` are malformed.
   */
  profile(armId: string, tier: TierId): ArmRiskProfile {
    if (!this.calibrated) {
      throw new RouteRiskError("not-calibrated", "profile: calibrate() has not been called yet");
    }
    if (typeof armId !== "string" || armId.length === 0) {
      throw new RouteRiskError("invalid-arm-id", "profile: armId must be a non-empty string");
    }
    if (typeof tier !== "string" || tier.length === 0) {
      throw new RouteRiskError("invalid-tier", "profile: tier must be a non-empty string");
    }
    const key = keyFor(this.stratifyBy, armId, tier);
    const existing = this.profiles.get(key);
    if (existing) return { ...existing };
    const { armId: idArm, tier: idTier } = identityFor(this.stratifyBy, armId, tier);
    return this.buildProfile(key, idArm, idTier, [], this.epsilon);
  }

  /**
   * Turn a calibrated `pCorrect` into a routing action. Builds ON
   * `this.profile(...)` and `tierConfidenceFloor` — never invents its own
   * threshold math. See the module doc for the accept-bar and escalation
   * rules.
   *
   * @throws {RouteRiskError} on any malformed input, or if `calibrate` has
   *   never been called.
   */
  decide(input: RouteDecisionInput): RouteVerdict {
    if (!this.calibrated) {
      throw new RouteRiskError("not-calibrated", "decide: calibrate() has not been called yet");
    }
    validateDecisionInput(input);

    const profile = this.profile(input.armId, input.tier);
    const floor = input.confidenceFloor !== undefined ? input.confidenceFloor : tierFloorOrThrow(input.tier, this.epsilon);
    // `max` structurally guarantees the floor can only TIGHTEN the bar —
    // never loosen a threshold calibration already earned. In particular
    // `threshold === Infinity` survives the `max` unconditionally, so an
    // uncalibrated stratum can never be accepted from regardless of floor.
    const acceptBar = Math.max(profile.threshold, floor);

    if (Number.isFinite(acceptBar) && input.pCorrect >= acceptBar) {
      return { action: "accept", armId: input.armId, threshold: acceptBar, pCorrect: input.pCorrect, profile };
    }

    // Why did the current arm not clear the bar? Drives the escalate reason.
    let escalateReason: EscalateReason;
    if (!Number.isFinite(profile.threshold)) {
      escalateReason = "uncalibrated-stratum";
    } else if (input.pCorrect < profile.threshold) {
      escalateReason = "below-threshold";
    } else {
      escalateReason = "below-tier-floor";
    }

    // --- Try to escalate: rank ladder candidates by expected verified
    // value per MARGINAL dollar (expected P(correct) at the candidate's own
    // calibrated stratum, divided by the candidate's cost), bounded by
    // maxEscalations, and pick the highest-value AFFORDABLE one. Never
    // returns an arm outside the supplied ladder; never escalates to self.
    const ladder = input.escalationLadder.filter((a) => a !== input.armId);
    let ladderBlockedByBudget = false;
    if (input.escalations < this.maxEscalations && ladder.length > 0) {
      const scored = ladder.map((armId, idx) => {
        const candProfile = this.profile(armId, input.tier);
        const expectedP =
          Number.isFinite(candProfile.threshold) && candProfile.calibrationSize > 0
            ? clamp01(1 - candProfile.empiricalRisk)
            : 0;
        const cost = safeCost(input.costOf, armId);
        const marginal = Math.max(cost, COST_FLOOR_USD);
        return { armId, idx, cost, expectedGainPerUsd: expectedP / marginal };
      });
      scored.sort((a, b) => b.expectedGainPerUsd - a.expectedGainPerUsd || a.idx - b.idx);

      // Budget exhaustion short-circuits BEFORE proposing a spend that
      // would exceed budgetUsd: only an affordable candidate is returned.
      const affordable = scored.find((c) => input.spentUsd + c.cost <= input.budgetUsd);
      if (affordable) {
        return {
          action: "escalate",
          nextArmId: affordable.armId,
          reason: escalateReason,
          threshold: acceptBar,
          expectedGainPerUsd: affordable.expectedGainPerUsd,
        };
      }
      ladderBlockedByBudget = true;
    }

    // --- Escalation unavailable/exhausted: try fan-out (parallel quorum)
    // as a last resort before abstaining. All-or-nothing over the supplied
    // candidate set — never proposes a spend the budget can't cover.
    let fanOutNoQuorum = false;
    let fanOutBlockedByBudget = false;
    const fanOutCandidates = input.fanOutCandidates;
    if (fanOutCandidates.length >= 2) {
      const quorum = Math.floor(fanOutCandidates.length / 2) + 1;
      const estimatedUsd = fanOutCandidates.reduce((sum, a) => sum + safeCost(input.costOf, a), 0);
      if (input.spentUsd + estimatedUsd <= input.budgetUsd) {
        return {
          action: "fan-out",
          armIds: fanOutCandidates,
          quorum,
          estimatedUsd,
          effectiveN: fanOutCandidates.length,
        };
      }
      fanOutBlockedByBudget = true;
    } else if (fanOutCandidates.length === 1) {
      // A single candidate can never form a meaningful quorum.
      fanOutNoQuorum = true;
    }

    // --- Abstain, with the most specific honest reason available.
    let reason: AbstainReason;
    if (!Number.isFinite(profile.threshold) && profile.calibrationSize === 0) {
      reason = "no-calibration";
    } else if (!Number.isFinite(profile.threshold)) {
      reason = "threshold-infinite";
    } else if (ladderBlockedByBudget || fanOutBlockedByBudget) {
      reason = "budget-exhausted";
    } else if (fanOutNoQuorum) {
      reason = "fan-out-no-quorum";
    } else {
      reason = "ladder-exhausted";
    }

    return { action: "abstain", reason, threshold: acceptBar, pCorrect: input.pCorrect };
  }

  /**
   * Aggregate real fan-out results into one correlation-aware verdict.
   * Arms sharing a `provider` are NOT independent evidence: within the
   * winning output's agreeing group, the first arm from a given provider
   * counts as a full vote, every subsequent arm from that SAME provider
   * counts as `independenceDiscount` of a vote (both for the quorum check
   * and for `effectiveN`), and the aggregated `pCorrect` is an
   * independence-weighted AVERAGE of the agreeing arms' own `pCorrect`
   * (never a naive `1 - Π(1 - pᵢ)` product, which is exactly what would
   * inflate confidence from correlated agreement). Ties in the majority
   * vote break deterministically by first appearance in `results`.
   *
   * @throws {RouteRiskError} on empty/malformed results, a duplicate armId,
   *   or `quorum` outside `[1, results.length]`.
   */
  aggregateFanOut(results: readonly FanOutResult[], quorum: number): FanOutVerdict {
    if (!Array.isArray(results) || results.length === 0) {
      throw new RouteRiskError("invalid-fan-out-results", "aggregateFanOut: results must be a non-empty array");
    }
    if (typeof quorum !== "number" || !Number.isInteger(quorum) || quorum < 1) {
      throw new RouteRiskError("invalid-quorum", `aggregateFanOut: quorum must be a positive integer; got ${quorum}`);
    }
    if (quorum > results.length) {
      throw new RouteRiskError(
        "quorum-too-large",
        `aggregateFanOut: quorum (${quorum}) exceeds candidate count (${results.length})`,
      );
    }

    const seenArms = new Set<string>();
    for (const r of results) {
      if (!r || typeof r !== "object") {
        throw new RouteRiskError("invalid-fan-out-results", "aggregateFanOut: each result must be an object");
      }
      if (typeof r.armId !== "string" || r.armId.length === 0) {
        throw new RouteRiskError("invalid-arm-id", "aggregateFanOut: each result needs a non-empty armId");
      }
      if (seenArms.has(r.armId)) {
        throw new RouteRiskError("duplicate-arm-id", `aggregateFanOut: duplicate armId "${r.armId}"`);
      }
      seenArms.add(r.armId);
      if (typeof r.provider !== "string" || r.provider.length === 0) {
        throw new RouteRiskError("invalid-fan-out-results", `aggregateFanOut: result for "${r.armId}" needs a non-empty provider`);
      }
      if (typeof r.output !== "string") {
        throw new RouteRiskError("invalid-fan-out-results", `aggregateFanOut: result for "${r.armId}" needs a string output`);
      }
      if (typeof r.pCorrect !== "number" || !Number.isFinite(r.pCorrect) || r.pCorrect < 0 || r.pCorrect > 1) {
        throw new RouteRiskError("invalid-pcorrect", `aggregateFanOut: pCorrect for "${r.armId}" must be in [0,1]; got ${r.pCorrect}`);
      }
    }

    const discount = this.independenceDiscount;

    // Group by output, preserving first-appearance order for deterministic
    // tie-breaking.
    const outputOrder: string[] = [];
    const byOutput = new Map<string, FanOutResult[]>();
    for (const r of results) {
      let arr = byOutput.get(r.output);
      if (!arr) {
        arr = [];
        byOutput.set(r.output, arr);
        outputOrder.push(r.output);
      }
      arr.push(r);
    }

    const effectiveVotes = (group: readonly FanOutResult[]): number => {
      const byProvider = new Map<string, number>();
      for (const r of group) byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + 1);
      let total = 0;
      for (const count of byProvider.values()) total += 1 + (count - 1) * discount;
      return total;
    };

    let bestOutput: string | null = null;
    let bestVotes = -Infinity;
    for (const output of outputOrder) {
      const votes = effectiveVotes(byOutput.get(output)!);
      // Strict `>` keeps the FIRST output reaching the max — deterministic,
      // documented tie-break by original array order.
      if (votes > bestVotes) {
        bestVotes = votes;
        bestOutput = output;
      }
    }

    const majorityGroup = bestOutput !== null ? byOutput.get(bestOutput)! : [];
    const agreeingArms = majorityGroup.map((r) => r.armId);

    // Global effective evidence mass, independent of which output won —
    // this is what `effectiveN` reports. Same provider-discount rule.
    const byProviderAll = new Map<string, number>();
    for (const r of results) byProviderAll.set(r.provider, (byProviderAll.get(r.provider) ?? 0) + 1);
    let effectiveN = 0;
    for (const count of byProviderAll.values()) effectiveN += 1 + (count - 1) * discount;

    // Independence-weighted AVERAGE (never a product) of the agreeing arms'
    // own pCorrect — this is a convex combination, so it can never exceed
    // the max individual input and can never be inflated toward ~1 by
    // agreement alone.
    const seenProviderInMajority = new Map<string, number>();
    let weightedSum = 0;
    let weightTotal = 0;
    for (const r of majorityGroup) {
      const seenCount = seenProviderInMajority.get(r.provider) ?? 0;
      const weight = seenCount === 0 ? 1 : discount;
      seenProviderInMajority.set(r.provider, seenCount + 1);
      weightedSum += weight * r.pCorrect;
      weightTotal += weight;
    }
    const pCorrect = weightTotal > 0 ? weightedSum / weightTotal : 0;

    const verdict: "accept" | "abstain" = bestVotes >= quorum ? "accept" : "abstain";

    return { pCorrect, agreeingArms, majorityOutput: bestOutput, effectiveN, verdict };
  }

  /**
   * Real counts from the most recent `calibrate()` call.
   *
   * @throws {RouteRiskError} if `calibrate` has never been called.
   */
  stats(): { strata: number; calibrated: number; pooledFallbacks: number; abstainingStrata: number; epsilon: number } {
    if (!this.calibrated) {
      throw new RouteRiskError("not-calibrated", "stats: calibrate() has not been called yet");
    }
    let calibratedCount = 0;
    let pooledCount = 0;
    let abstainingCount = 0;
    for (const p of this.profiles.values()) {
      if (p.source === "stratum") calibratedCount += 1;
      else if (p.source === "pooled") pooledCount += 1;
      else abstainingCount += 1;
    }
    return {
      strata: this.profiles.size,
      calibrated: calibratedCount,
      pooledFallbacks: pooledCount,
      abstainingStrata: abstainingCount,
      epsilon: this.epsilon,
    };
  }

  /**
   * Build the profile for one stratum key from its own points (`arr`),
   * honoring `minCalibration` and `fallback`. Shared by `calibrate` (real
   * data) and `profile` (an empty `arr` for a never-seen combination) so
   * both paths degrade identically: never silently borrow a looser
   * threshold than what was actually fit and validated.
   */
  private buildProfile(
    key: string,
    armId: string | null,
    tier: TierId | null,
    arr: readonly RiskCalibrationPoint[],
    perStratumEpsilon: number,
  ): ArmRiskProfile {
    if (arr.length >= this.minCalibration) {
      const gatePoints: CalibrationPoint[] = arr.map((p) => ({ score: p.score, correct: p.correct }));
      const gate = new ConformalGate({ epsilon: perStratumEpsilon, minCalibration: this.minCalibration });
      const gs: GateStats = gate.calibrate(gatePoints);
      return {
        key,
        armId,
        tier,
        threshold: gs.threshold,
        epsilonUsed: perStratumEpsilon,
        coverage: gs.coverageAtThreshold,
        empiricalRisk: gs.empiricalRiskAtThreshold,
        calibrationSize: arr.length,
        source: "stratum",
      };
    }
    if (this.fallback === "pooled" && this.pooledFit) {
      return {
        key,
        armId,
        tier,
        threshold: this.pooledFit.threshold,
        epsilonUsed: this.pooledFit.epsilonUsed,
        coverage: this.pooledFit.coverage,
        empiricalRisk: this.pooledFit.empiricalRisk,
        calibrationSize: arr.length,
        source: "pooled",
      };
    }
    return {
      key,
      armId,
      tier,
      threshold: Infinity,
      epsilonUsed: this.epsilon,
      coverage: 0,
      empiricalRisk: 1,
      calibrationSize: arr.length,
      source: "none",
    };
  }
}
