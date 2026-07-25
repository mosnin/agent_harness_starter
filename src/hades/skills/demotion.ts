/**
 * demotion — a pure, deterministic trust-policy engine for skills.
 *
 * A skill earns trust from its {@link SkillTrackSummary} (produced by
 * `track-record.ts`'s hash-chained ledger): the Wilson lower bound on its
 * recent success rate, and its recent Brier calibration. This module turns
 * that summary into a {@link SkillTrustStatus} transition — `active` ->
 * `probation` -> `demoted` on regression, and back up only through
 * sustained, *verified* recovery — using a fixed, auditable rulebook rather
 * than ad-hoc thresholds sprinkled through the caller.
 *
 * REAL-VS-MOCK POLICY: this module is pure math. It performs zero I/O, owns
 * no clock, and generates no randomness — `evaluateSkillTrust` is a total,
 * referentially transparent function of its four arguments (including the
 * caller-supplied `now`), and `applyOutcomeToStreak` is a total function of
 * its two. The only import from elsewhere in Hades is a *type-only* import
 * of `SkillTrackSummary` from `./track-record`, so this module can be
 * fuzzed, replayed, and reasoned about without a filesystem, a clock, or a
 * PRNG in the loop. Persistence of `SkillTrustState` is intentionally out of
 * scope here: {@link serializeTrustStates} / {@link parseTrustStates} are
 * pure (de)serializers: the CLI team owns the actual file writes, using the
 * same atomic tmp+rename pattern as `track-record.ts`.
 *
 * THE RULEBOOK (implemented exactly, see {@link evaluateSkillTrust}):
 *
 *  - `n < minSamples`            -> never demote; status held as-is, full
 *                                    stop (too few samples for any threshold
 *                                    comparison to be trustworthy).
 *  - any status -> `demoted`     -> `n >= minSamples AND wilsonLower <
 *                                    demoteBelowWilson`.
 *  - `active` -> `probation`     -> `wilsonLower < probationBelowWilson OR
 *                                    recentBrier > brierCeiling`.
 *  - `demoted` -> `probation`    -> ONLY exit from `demoted` (never jumps
 *                                    straight to `active`); requires
 *                                    `wilsonLower >= recoverAboveWilson +
 *                                    hysteresis AND streak >= recoveryStreak`.
 *  - `probation` -> `active`     -> the *same* recovery bar, evaluated
 *                                    against a streak that started fresh
 *                                    the moment the skill entered
 *                                    `probation` (streak resets on every
 *                                    status change, see below).
 *
 * The `hysteresis` term is what stops flapping: it widens the gap between
 * the down-trigger (`probationBelowWilson`) and the up-trigger
 * (`recoverAboveWilson + hysteresis`), so a skill oscillating tightly around
 * `probationBelowWilson` demotes once and then simply *stays* on probation
 * until it clears the (deliberately higher) recovery bar — it never
 * round-trips back and forth across a single shared threshold.
 */

import type { SkillTrackSummary } from "./track-record";

// ---------------------------------------------------------------------------
// Types (locked contract)
// ---------------------------------------------------------------------------

export type SkillTrustStatus = "active" | "probation" | "demoted";

export interface SkillTrustPolicy {
  /** Below this sample count, never demote; status stays as-is. Default 5. */
  minSamples: number;
  /** Demote when `wilsonLower < demoteBelowWilson`. Default 0.5. */
  demoteBelowWilson: number;
  /** Downgrade `active` -> `probation` when `wilsonLower` falls below this. Default 0.7. */
  probationBelowWilson: number;
  /** `recentBrier` above this forces at least `probation`. Default 0.35. */
  brierCeiling: number;
  /** Recovery requires `wilsonLower >= recoverAboveWilson + hysteresis`. Default 0.75. */
  recoverAboveWilson: number;
  /** Consecutive verified successes required to leave `probation` (or for `demoted` to reach `probation`). Default 3. */
  recoveryStreak: number;
  /** Band added to `recoverAboveWilson` on the way back up, so status cannot flap across a single threshold. Default 0.05. */
  hysteresis: number;
}

export function defaultSkillTrustPolicy(): SkillTrustPolicy {
  return {
    minSamples: 5,
    demoteBelowWilson: 0.5,
    probationBelowWilson: 0.7,
    brierCeiling: 0.35,
    recoverAboveWilson: 0.75,
    recoveryStreak: 3,
    hysteresis: 0.05,
  };
}

export interface SkillTrustState {
  skillName: string;
  status: SkillTrustStatus;
  /** Timestamp (caller's clock units) since which `status` has held. */
  since: number;
  /** Current consecutive verified-success streak, counted since the last status change. */
  streak: number;
  reasons: string[];
}

export interface DemotionDecision {
  previous: SkillTrustStatus;
  next: SkillTrustStatus;
  changed: boolean;
  /** Every threshold comparison that fired, with the actual numbers interpolated. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
}

/**
 * Pure evaluation of one trust-policy step. No clock reads (the caller
 * supplies `now`), no randomness, no mutation of any argument — see the
 * determinism tests for the exact guarantee (frozen inputs, replayed calls
 * deep-equal).
 */
export function evaluateSkillTrust(
  state: SkillTrustState,
  summary: SkillTrackSummary,
  policy: SkillTrustPolicy,
  now: number,
): { state: SkillTrustState; decision: DemotionDecision } {
  const previous = state.status;
  const { n, wilsonLower, recentBrier } = summary;

  if (n < policy.minSamples) {
    const reasons = [
      `n=${n} < minSamples=${policy.minSamples}: insufficient samples, status held at "${previous}"`,
    ];
    return {
      state: {
        skillName: state.skillName,
        status: previous,
        since: state.since,
        streak: state.streak,
        reasons,
      },
      decision: { previous, next: previous, changed: false, reasons },
    };
  }

  const reasons: string[] = [];
  let next: SkillTrustStatus = previous;

  const demoteTriggered = wilsonLower < policy.demoteBelowWilson;
  const recoveryBar = policy.recoverAboveWilson + policy.hysteresis;
  const recoveryMet = wilsonLower >= recoveryBar && state.streak >= policy.recoveryStreak;

  if (demoteTriggered) {
    reasons.push(
      `wilsonLower=${fmt(wilsonLower)} < demoteBelowWilson=${fmt(policy.demoteBelowWilson)} ` +
        `(n=${n} >= minSamples=${policy.minSamples}): demote`,
    );
    next = "demoted";
  } else if (previous === "demoted") {
    if (recoveryMet) {
      reasons.push(
        `wilsonLower=${fmt(wilsonLower)} >= recoverAboveWilson+hysteresis=${fmt(recoveryBar)} ` +
          `and streak=${state.streak} >= recoveryStreak=${policy.recoveryStreak}: ` +
          `sustained recovery, promote demoted -> probation`,
      );
      next = "probation";
    } else {
      if (wilsonLower < recoveryBar) {
        reasons.push(
          `wilsonLower=${fmt(wilsonLower)} < recoverAboveWilson+hysteresis=${fmt(recoveryBar)}: ` +
            `demoted stays demoted (sticky)`,
        );
      }
      if (state.streak < policy.recoveryStreak) {
        reasons.push(
          `streak=${state.streak} < recoveryStreak=${policy.recoveryStreak}: ` +
            `demoted stays demoted (sticky, streak insufficient)`,
        );
      }
      next = "demoted";
    }
  } else if (previous === "probation") {
    if (recoveryMet) {
      reasons.push(
        `wilsonLower=${fmt(wilsonLower)} >= recoverAboveWilson+hysteresis=${fmt(recoveryBar)} ` +
          `and streak=${state.streak} >= recoveryStreak=${policy.recoveryStreak}: ` +
          `sustained recovery, promote probation -> active`,
      );
      next = "active";
    } else {
      if (wilsonLower < policy.probationBelowWilson) {
        reasons.push(
          `wilsonLower=${fmt(wilsonLower)} < probationBelowWilson=${fmt(policy.probationBelowWilson)}: ` +
            `remains on probation`,
        );
      }
      if (recentBrier > policy.brierCeiling) {
        reasons.push(
          `recentBrier=${fmt(recentBrier)} > brierCeiling=${fmt(policy.brierCeiling)}: ` +
            `remains on probation`,
        );
      }
      if (wilsonLower < recoveryBar) {
        reasons.push(
          `wilsonLower=${fmt(wilsonLower)} < recoverAboveWilson+hysteresis=${fmt(recoveryBar)}: ` +
            `recovery bar not met`,
        );
      } else if (state.streak < policy.recoveryStreak) {
        reasons.push(
          `streak=${state.streak} < recoveryStreak=${policy.recoveryStreak}: ` +
            `recovery bar not met (streak insufficient)`,
        );
      }
      next = "probation";
    }
  } else {
    // previous === "active"
    const belowProbation = wilsonLower < policy.probationBelowWilson;
    const brierBad = recentBrier > policy.brierCeiling;
    if (belowProbation || brierBad) {
      if (belowProbation) {
        reasons.push(
          `wilsonLower=${fmt(wilsonLower)} < probationBelowWilson=${fmt(policy.probationBelowWilson)}: ` +
            `demote active -> probation`,
        );
      }
      if (brierBad) {
        reasons.push(
          `recentBrier=${fmt(recentBrier)} > brierCeiling=${fmt(policy.brierCeiling)}: ` +
            `demote active -> probation`,
        );
      }
      next = "probation";
    } else {
      next = "active";
    }
  }

  const changed = next !== previous;
  const newState: SkillTrustState = {
    skillName: state.skillName,
    status: next,
    since: changed ? now : state.since,
    // Streak resets on every status change: both `demoted -> probation` and
    // `probation -> active` require the *same* recovery bar met again on a
    // fresh streak, so a status change always zeroes it.
    streak: changed ? 0 : state.streak,
    reasons,
  };
  const decision: DemotionDecision = { previous, next, changed, reasons };
  return { state: newState, decision };
}

/**
 * Folds one observed outcome into `state.streak`. Only a *verified*
 * success (gate-checked, not merely self-reported) extends the streak — an
 * unverified success neither advances nor erases progress (a skill cannot
 * launder its way off probation with ungated wins, but a single ungated win
 * also doesn't cost it the progress it already earned). Any failure
 * (verified or not) resets the streak to zero.
 */
export function applyOutcomeToStreak(
  state: SkillTrustState,
  outcome: { success: boolean; verified: boolean },
): SkillTrustState {
  if (!outcome.success) {
    return {
      skillName: state.skillName,
      status: state.status,
      since: state.since,
      streak: 0,
      reasons: state.reasons,
    };
  }
  if (outcome.verified) {
    return {
      skillName: state.skillName,
      status: state.status,
      since: state.since,
      streak: state.streak + 1,
      reasons: state.reasons,
    };
  }
  return {
    skillName: state.skillName,
    status: state.status,
    since: state.since,
    streak: state.streak,
    reasons: state.reasons,
  };
}

// ---------------------------------------------------------------------------
// Pure (de)serialization — persistence is the CLI team's job
// ---------------------------------------------------------------------------

export interface TrustStateStoreShape {
  version: 1;
  states: Record<string, SkillTrustState>;
}

export function serializeTrustStates(states: Map<string, SkillTrustState>): string {
  const shape: TrustStateStoreShape = { version: 1, states: {} };
  for (const [skillName, state] of states) {
    shape.states[skillName] = state;
  }
  return JSON.stringify(shape);
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const TRUST_STATUSES: ReadonlySet<string> = new Set<SkillTrustStatus>([
  "active",
  "probation",
  "demoted",
]);

function isWellFormedTrustState(v: unknown): v is SkillTrustState {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.skillName === "string" &&
    v.skillName.length > 0 &&
    typeof v.status === "string" &&
    TRUST_STATUSES.has(v.status) &&
    typeof v.since === "number" &&
    Number.isFinite(v.since) &&
    typeof v.streak === "number" &&
    Number.isInteger(v.streak) &&
    v.streak >= 0 &&
    Array.isArray(v.reasons) &&
    v.reasons.every((r) => typeof r === "string")
  );
}

/**
 * Parses a {@link TrustStateStoreShape} JSON document. Rejects unknown
 * versions and malformed states honestly (`ok: false`, no partial map) —
 * this never throws. Own-enumerable keys that could be used for a
 * prototype-pollution attempt (`__proto__`, `constructor`, `prototype`) are
 * skipped rather than materialized into the returned `Map`, whether or not
 * their value happens to look like a well-formed state; note that
 * `JSON.parse` itself never mutates `Object.prototype` (it creates a real
 * own data property named `"__proto__"`, not the exotic accessor), so this
 * is defense-in-depth against a caller that later merges the parsed data
 * some other way, not a fix for an exploit that exists in this function.
 */
export function parseTrustStates(
  json: string,
): { ok: boolean; states: Map<string, SkillTrustState>; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      states: new Map(),
      error: `invalid JSON: ${(err as Error).message}`,
    };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, states: new Map(), error: "root value is not an object" };
  }
  if (parsed.version !== 1) {
    return {
      ok: false,
      states: new Map(),
      error: `unsupported version: ${JSON.stringify(parsed.version)}`,
    };
  }
  const rawStates = parsed.states;
  if (!isPlainObject(rawStates)) {
    return { ok: false, states: new Map(), error: '"states" is not an object' };
  }

  const result = new Map<string, SkillTrustState>();
  for (const key of Object.keys(rawStates)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(rawStates, key)) continue;
    const candidate = rawStates[key];
    if (!isWellFormedTrustState(candidate)) {
      return {
        ok: false,
        states: new Map(),
        error: `malformed state for skill "${key}"`,
      };
    }
    result.set(key, candidate);
  }

  return { ok: true, states: result };
}
