/**
 * CostAwareRouteBandit — Phase 16: a cost-aware routing bandit over
 * {@link BackendManager}. It answers the question `manager.select()` (see
 * `./manager.ts`) deliberately does NOT: "which backend has, empirically,
 * produced the most VERIFIED work per dollar spent, and how much should we
 * keep exploring the others?"
 *
 * This module reimplements nothing from `./manager.ts` or `./descriptor.ts` —
 * it composes them. Candidate discovery goes through the real
 * {@link BackendManager.descriptors} + {@link BackendManager.probe} (the same
 * TTL-cached availability check every other consumer uses — there is no
 * parallel availability model here), hard filtering goes through the real
 * {@link matchesRequirements}, and cost data comes from the real
 * {@link BackendManager.telemetry}. The only things this module adds are (1)
 * a UCB1 exploration/exploitation policy over outcomes the CALLER measures
 * and reports via {@link CostAwareRouteBandit.recordOutcome}, and (2)
 * serializable state so a host process can persist and resume the bandit's
 * learned history.
 *
 * ## Reward formula — every input labelled measured or configured
 *
 * For an arm (backend name) with `pulls >= 1` recorded outcomes:
 *
 * - `verifiedShare = verified / pulls` — **measured**: the fraction of
 *   recorded outcomes the caller reported as `verified: true`.
 * - `spentPerVerified = (totalUsd + telemetry(name).accruedUsd / max(1, pulls)) / max(1, verified)`
 *   — **measured**: `totalUsd` is the sum of caller-reported `usd` per
 *   outcome; `telemetry(name).accruedUsd` is the manager's real accrued
 *   run-cost for that backend (rate x elapsed, per `./manager.ts`), amortized
 *   per pull so a bandit that outlives many provisions doesn't double-count
 *   cost accrued before this arm's outcomes were recorded. Division is by
 *   `max(1, verified)` so an arm with zero verified outcomes still yields a
 *   finite (very high, i.e. cost-heavy) "spend per verified unit" rather than
 *   a division by zero.
 * - `baselineCost = baselineUsdPerHour * (totalElapsedMs / pulls) / 3_600_000`
 *   — `baselineUsdPerHour` is an **explicitly configured** normalization
 *   constant (see {@link RouteBanditOptions.baselineUsdPerHour}), never a
 *   measured or real price; `totalElapsedMs / pulls` (mean wall-clock time
 *   per outcome) is **measured**, reported by the caller. `baselineCost` is
 *   purely an internal normalization scale, never surfaced to callers as a
 *   dollar figure.
 * - `costEfficiency = baselineCost / (baselineCost + spentPerVerified)`, or
 *   `1` when both terms are `0` (nothing spent yet and nothing to compare
 *   against — treated as maximally efficient rather than `NaN`, matching the
 *   "no evidence yet -> neutral/best prior" convention `./descriptor.ts` uses
 *   for zeroed telemetry). Always finite, always in `[0, 1]`.
 * - `meanReward = verifiedShare * costEfficiency` — always finite, always in
 *   `[0, 1]`.
 *
 * `ucb = meanReward + explorationC * sqrt(ln(totalPulls) / pulls)`, the
 * standard UCB1 bonus, where `totalPulls` is the sum of `pulls` across every
 * arm this bandit instance has ever recorded an outcome for (not just the
 * current candidate set — adding/removing unrelated requirements should not
 * change an untouched arm's UCB score). `explorationC` is an **explicitly
 * configured** exploration-vs-exploitation weight (default `1.4`, the
 * conventional `sqrt(2)`-ish UCB1 constant rounded for a slightly wider
 * exploration budget). No randomness is used anywhere: forced exploration and
 * UCB ties both break lexicographically by name, so an identical history of
 * `choose()`/`recordOutcome()` calls always produces an identical decision
 * sequence.
 *
 * ## Policy
 *
 * `choose()` filters `manager.descriptors()` by {@link matchesRequirements}
 * AND a real `await manager.probe(name)`, then:
 *
 * 1. If any surviving candidate has never been pulled, it is chosen
 *    (`reason: "forced-exploration"`), lexicographically smallest name first
 *    among the never-pulled survivors. Every arm is visited exactly once
 *    this way before any UCB-based decision is made for that candidate set.
 * 2. Otherwise the surviving candidate with the highest `ucb` is chosen
 *    (`reason: "ucb-best"`); ties break lexicographically by name.
 *
 * `choose()` returns `undefined` (never throws) when nothing survives.
 */

import { BackendManager } from "./manager";
import type { BackendRequirements } from "./descriptor";
import { matchesRequirements } from "./descriptor";

// ===========================================================================
// Public types
// ===========================================================================

/** One caller-measured outcome of routing a unit of work to a backend. Every
 *  field must be a real measurement the caller took — never fabricated. */
export interface RouteOutcome {
  /** Whether the routed work passed verification. */
  verified: boolean;
  /** Real measured wall-clock duration in ms. Must be finite and `>= 0`. */
  elapsedMs: number;
  /** Real measured USD cost attributable to this outcome. Must be finite and `>= 0`. */
  usd: number;
}

/** Public view of one arm's accumulated history plus its derived reward/UCB. */
export interface BanditArm {
  pulls: number;
  verified: number;
  totalElapsedMs: number;
  totalUsd: number;
  /** `verifiedShare * costEfficiency` (see file header). `0` when `pulls === 0`. */
  meanReward: number;
  /** UCB1 score, or `null` when `pulls === 0` (never pulled -> not yet computable). */
  ucb: number | null;
}

export interface RouteDecision {
  name: string;
  reason: "forced-exploration" | "ucb-best";
  /** The chosen arm's UCB score, or `null` for a forced-exploration decision
   *  (that choice was not UCB-driven). */
  ucb: number | null;
  /** Every surviving candidate this decision was made among, in
   *  deterministic (lexicographic by name) order. */
  candidates: Array<{ name: string; pulls: number; ucb: number | null }>;
}

export const ROUTE_BANDIT_STATE_VERSION = 1;

export interface RouteBanditState {
  version: number;
  arms: Record<string, { pulls: number; verified: number; totalElapsedMs: number; totalUsd: number }>;
}

export interface RouteBanditOptions {
  manager: BackendManager;
  /** UCB1 exploration weight. Must be finite and `>= 0`. Default `1.4`. */
  explorationC?: number;
  /** Configured normalization constant (NOT a real price) used to scale the
   *  cost-efficiency term. Must be finite and `> 0`. Default `0.10`. */
  baselineUsdPerHour?: number;
  onDecision?: (d: RouteDecision) => void;
}

// ===========================================================================
// Internals
// ===========================================================================

const DEFAULT_EXPLORATION_C = 1.4;
const DEFAULT_BASELINE_USD_PER_HOUR = 0.1;
const MS_PER_HOUR = 3_600_000;

/** Mutable per-arm accumulator (the public view is the derived {@link BanditArm}). */
interface MutableArm {
  pulls: number;
  verified: number;
  totalElapsedMs: number;
  totalUsd: number;
}

function zeroArm(): MutableArm {
  return { pulls: 0, verified: 0, totalElapsedMs: 0, totalUsd: 0 };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Validate one raw `state.arms[name]` entry. Never throws; `undefined` means "drop it". */
function validateArmEntry(raw: unknown): MutableArm | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { pulls, verified, totalElapsedMs, totalUsd } = raw;
  if (typeof pulls !== "number" || !Number.isFinite(pulls) || !Number.isInteger(pulls) || pulls < 0) return undefined;
  if (
    typeof verified !== "number" ||
    !Number.isFinite(verified) ||
    !Number.isInteger(verified) ||
    verified < 0 ||
    verified > pulls
  ) {
    return undefined;
  }
  if (!isFiniteNonNegative(totalElapsedMs)) return undefined;
  if (!isFiniteNonNegative(totalUsd)) return undefined;
  return { pulls, verified, totalElapsedMs, totalUsd };
}

// ===========================================================================
// CostAwareRouteBandit
// ===========================================================================

export class CostAwareRouteBandit {
  private readonly manager: BackendManager;
  private readonly explorationC: number;
  private readonly baselineUsdPerHour: number;
  private readonly onDecisionCb?: (d: RouteDecision) => void;

  private readonly armsByName = new Map<string, MutableArm>();

  constructor(opts: RouteBanditOptions) {
    if (!opts || !(opts.manager instanceof BackendManager)) {
      throw new RangeError("CostAwareRouteBandit: opts.manager must be a BackendManager instance");
    }
    const explorationC = opts.explorationC ?? DEFAULT_EXPLORATION_C;
    if (typeof explorationC !== "number" || !Number.isFinite(explorationC) || explorationC < 0) {
      throw new RangeError("CostAwareRouteBandit: explorationC must be a finite number >= 0");
    }
    const baselineUsdPerHour = opts.baselineUsdPerHour ?? DEFAULT_BASELINE_USD_PER_HOUR;
    if (typeof baselineUsdPerHour !== "number" || !Number.isFinite(baselineUsdPerHour) || baselineUsdPerHour <= 0) {
      throw new RangeError("CostAwareRouteBandit: baselineUsdPerHour must be a finite number > 0");
    }
    this.manager = opts.manager;
    this.explorationC = explorationC;
    this.baselineUsdPerHour = baselineUsdPerHour;
    this.onDecisionCb = opts.onDecision;
  }

  // ---------------------------------------------------------------------
  // Decision
  // ---------------------------------------------------------------------

  /**
   * Choose a backend for `r`. Filters `manager.descriptors()` by
   * {@link matchesRequirements} and a real `manager.probe()`, then applies
   * forced-exploration-first UCB1 (see file header). Returns `undefined`
   * (never throws) when no candidate survives filtering + probing.
   */
  async choose(r: BackendRequirements = {}): Promise<RouteDecision | undefined> {
    const filtered = this.manager.descriptors().filter((d) => matchesRequirements(d, r));
    const survivors: string[] = [];
    for (const d of filtered) {
      // Sequential, real, TTL-cached probes through the manager — never a
      // parallel or fabricated availability model.
      if (await this.manager.probe(d.name)) survivors.push(d.name);
    }
    if (survivors.length === 0) return undefined;
    survivors.sort();

    const totalPulls = this.totalPulls();
    const candidates = survivors.map((name) => this.candidateInfo(name, totalPulls));

    const unpulled = candidates.filter((c) => c.pulls === 0).map((c) => c.name);
    let decision: RouteDecision;
    if (unpulled.length > 0) {
      // Already lexicographic: `candidates` was built from sorted `survivors`.
      decision = { name: unpulled[0], reason: "forced-exploration", ucb: null, candidates };
    } else {
      let best = candidates[0];
      for (const c of candidates) {
        if ((c.ucb as number) > (best.ucb as number)) best = c;
      }
      decision = { name: best.name, reason: "ucb-best", ucb: best.ucb, candidates };
    }

    this.onDecisionCb?.(decision);
    return decision;
  }

  // ---------------------------------------------------------------------
  // Outcome recording
  // ---------------------------------------------------------------------

  /**
   * Record one caller-measured outcome for `name`. Works even for a name the
   * manager has never registered (the bandit's history can outlive backend
   * registrations); such an arm simply has no manager telemetry to blend in,
   * so its reward is derived purely from the outcomes recorded here.
   *
   * @throws RangeError if any field is not a finite, correctly-signed value.
   */
  recordOutcome(name: string, o: RouteOutcome): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new RangeError("CostAwareRouteBandit.recordOutcome: name must be a non-empty string");
    }
    if (typeof o?.verified !== "boolean") {
      throw new RangeError("CostAwareRouteBandit.recordOutcome: outcome.verified must be a boolean");
    }
    if (typeof o.elapsedMs !== "number" || !Number.isFinite(o.elapsedMs) || o.elapsedMs < 0) {
      throw new RangeError("CostAwareRouteBandit.recordOutcome: outcome.elapsedMs must be a finite number >= 0");
    }
    if (typeof o.usd !== "number" || !Number.isFinite(o.usd) || o.usd < 0) {
      throw new RangeError("CostAwareRouteBandit.recordOutcome: outcome.usd must be a finite number >= 0");
    }

    const arm = this.armsByName.get(name) ?? zeroArm();
    arm.pulls += 1;
    if (o.verified) arm.verified += 1;
    arm.totalElapsedMs += o.elapsedMs;
    arm.totalUsd += o.usd;
    this.armsByName.set(name, arm);
  }

  // ---------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------

  /** One arm's current derived view. An unknown name reads as a zeroed, never-pulled arm. */
  arm(name: string): BanditArm {
    const acc = this.armsByName.get(name);
    if (!acc || acc.pulls === 0) {
      return { pulls: 0, verified: 0, totalElapsedMs: 0, totalUsd: 0, meanReward: 0, ucb: null };
    }
    const totalPulls = this.totalPulls();
    const meanReward = this.meanReward(name, acc);
    const ucb = meanReward + this.explorationC * Math.sqrt(Math.log(totalPulls) / acc.pulls);
    return { pulls: acc.pulls, verified: acc.verified, totalElapsedMs: acc.totalElapsedMs, totalUsd: acc.totalUsd, meanReward, ucb };
  }

  /** Every tracked arm, canonically ordered by name. */
  arms(): Record<string, BanditArm> {
    const out: Record<string, BanditArm> = {};
    for (const name of [...this.armsByName.keys()].sort()) {
      out[name] = this.arm(name);
    }
    return out;
  }

  /** Deep-copied, canonical-key-ordered serializable snapshot of this bandit's history. */
  snapshot(): RouteBanditState {
    const arms: RouteBanditState["arms"] = {};
    for (const name of [...this.armsByName.keys()].sort()) {
      const acc = this.armsByName.get(name)!;
      arms[name] = { pulls: acc.pulls, verified: acc.verified, totalElapsedMs: acc.totalElapsedMs, totalUsd: acc.totalUsd };
    }
    return { version: ROUTE_BANDIT_STATE_VERSION, arms };
  }

  /**
   * Reconstruct a bandit from a persisted (or arbitrary, untrusted) snapshot.
   * Never throws: an invalid top-level shape or wrong `version` yields a
   * fresh, empty bandit; individually malformed arm entries are dropped
   * while the rest of the state loads normally (same defensive discipline as
   * `HandleStore.load()` in `./handle-store.ts`).
   */
  static fromState(opts: RouteBanditOptions, state: unknown): CostAwareRouteBandit {
    const bandit = new CostAwareRouteBandit(opts);
    if (!isPlainObject(state)) return bandit;
    const { version, arms } = state;
    if (typeof version !== "number" || version !== ROUTE_BANDIT_STATE_VERSION) return bandit;
    if (!isPlainObject(arms)) return bandit;
    for (const [name, raw] of Object.entries(arms)) {
      if (typeof name !== "string" || name.length === 0) continue;
      const validated = validateArmEntry(raw);
      if (validated) bandit.armsByName.set(name, validated);
    }
    return bandit;
  }

  // ---------------------------------------------------------------------
  // Internal math
  // ---------------------------------------------------------------------

  private totalPulls(): number {
    let sum = 0;
    for (const acc of this.armsByName.values()) sum += acc.pulls;
    return sum;
  }

  /** `meanReward` for an arm with `acc.pulls >= 1` (see file header for the formula). */
  private meanReward(name: string, acc: MutableArm): number {
    const pulls = acc.pulls;
    const verifiedShare = acc.verified / pulls;
    const accruedUsd = this.manager.telemetry(name).accruedUsd;
    const spentPerVerified = (acc.totalUsd + accruedUsd / Math.max(1, pulls)) / Math.max(1, acc.verified);
    const baselineCost = (this.baselineUsdPerHour * (acc.totalElapsedMs / pulls)) / MS_PER_HOUR;
    const denom = baselineCost + spentPerVerified;
    const costEfficiency = denom === 0 ? 1 : baselineCost / denom;
    return verifiedShare * costEfficiency;
  }

  private candidateInfo(name: string, totalPulls: number): { name: string; pulls: number; ucb: number | null } {
    const acc = this.armsByName.get(name);
    const pulls = acc?.pulls ?? 0;
    if (pulls === 0 || !acc) return { name, pulls: 0, ucb: null };
    const ucb = this.meanReward(name, acc) + this.explorationC * Math.sqrt(Math.log(totalPulls) / pulls);
    return { name, pulls, ucb };
  }
}
