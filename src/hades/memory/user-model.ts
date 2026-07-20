/**
 * Phase-5 Dialectic User Model — canonical type vocabulary + engine.
 *
 * This module is the SINGLE source of truth for the shape of an evolving,
 * evidence-backed user profile inside Hades. Every other Phase-5 module
 * (persistence, prompt assembly, the memory guard integration, the TUI
 * profile view) imports its types from here rather than redeclaring them.
 *
 * The one invariant everything else leans on: `UserBelief.confidence` is
 * NEVER free-set. It is always the output of `combineEvidence()` run over
 * that belief's evidence ledger. There is no code path — not construction,
 * not reinforcement, not JSON round-trip — that lets a stored confidence
 * exceed what the evidence actually supports. A belief that would need to
 * be reported above the assert floor but whose evidence doesn't clear it is
 * reported as ABSTAINED, never asserted with a padded number.
 *
 * Design notes (the parts the locked contract leaves to this file's author):
 *
 *  - `UserBelief.evidence` holds the ledger for the belief's CURRENT value.
 *    A `revised` decision resets the ledger to just the new evidence (the
 *    old value's supporting evidence is retired — its outcome survives only
 *    as a string in `supersededValues`, per the locked interface shape).
 *    `reinforced` / `contested` / `ignored` append to the existing ledger
 *    (deduped by evidence id) so that contradicting-but-not-quite-enough
 *    evidence still measurably erodes confidence via the noisy-OR penalty
 *    term, even though it didn't win outright.
 *  - `BeliefStatus` includes `"superseded"` for API completeness (a
 *    persistence layer that keeps historical belief snapshots around revise
 *    events can stamp it on an archived record); this single-slot,
 *    in-memory engine never assigns it itself — a live belief is always
 *    asserted / abstained / contested / retracted while it holds the map
 *    slot for its attribute.
 *  - `UserBelief.confidence` and `.salience` are both "as of `updatedAt`"
 *    snapshots (confidence literally IS `combineEvidence(evidence,
 *    updatedAt, halfLifeMs)`; salience is decayed-then-boosted at each
 *    mutation using the belief's *previous* `updatedAt` as the decay
 *    anchor). Live decay past `updatedAt` to an arbitrary later instant is
 *    exposed only through `decayedConfidence(belief, now)`, mirroring how
 *    the locked contract already distinguishes the stored field from the
 *    live query — asking "what would this look like right now" never
 *    requires (or performs) a mutation.
 *  - Same-value evidence whose polarity is `"contradicts"` (evidence that
 *    disputes the very value being restated) is treated as `"contested"` —
 *    not covered explicitly by the locked rule list, but the closest fit
 *    among the six decisions, and it correctly routes the belief into
 *    abstention rather than silently reinforcing a value evidence just
 *    argued against.
 */

import type { TierId } from "../styx/tiers";
import { tierConfidenceFloor } from "../styx/tiers";
import type { VerificationCertificate } from "../styx/certificate";
import { memoryWriteCalibration } from "./guard";

// ===========================================================================
// Types (locked vocabulary)
// ===========================================================================

export type BeliefStatus = "asserted" | "abstained" | "contested" | "retracted" | "superseded";

export type EvidencePolarity = "supports" | "contradicts" | "retracts";

export interface BeliefEvidence {
  /** sha256Hex of canonical content, computed by the producer. */
  id: string;
  /** verbatim source line. */
  excerpt: string;
  excerptSha256: string;
  sessionId?: string;
  polarity: EvidencePolarity;
  tier: TierId;
  /** calibrated contribution in [0,1], already tier-capped by the producer. */
  weight: number;
  certificate?: VerificationCertificate;
  certificateValid?: boolean;
  verdict?: { verifierId: string; passed: boolean; confidence: number };
  at: number;
}

export interface UserBelief {
  /** canonical lowercase dotted key. */
  attribute: string;
  value: string;
  /** in [0,1], ALWAYS === combineEvidence(evidence, updatedAt, halfLifeMs). */
  confidence: number;
  status: BeliefStatus;
  salience: number;
  evidence: BeliefEvidence[];
  createdAt: number;
  updatedAt: number;
  revisions: number;
  supersededValues: string[];
}

export interface BeliefAssertion {
  attribute: string;
  value: string;
  /** default "supports". */
  polarity?: EvidencePolarity;
  evidence: BeliefEvidence;
  now?: number;
}

export type DialecticDecision = "created" | "reinforced" | "revised" | "contested" | "retracted" | "ignored";

export interface UserModelSnapshot {
  version: 1;
  beliefs: UserBelief[];
}

export interface DialecticModelOptions {
  now?: () => number;
  /** default 30 days. */
  halfLifeMs?: number;
  /** default 0.55. */
  assertFloor?: number;
  /** default 0.15. */
  contestMargin?: number;
}

// ===========================================================================
// Internal constants
// ===========================================================================

const DEFAULT_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_ASSERT_FLOOR = 0.55;
const DEFAULT_CONTEST_MARGIN = 0.15;
/** Salience recovered on a create/reinforce/revise touch, on top of decay. */
const SALIENCE_TOUCH_BOOST = 0.3;

const KNOWN_TIERS: readonly TierId[] = [
  "T0-execution",
  "T1-reference",
  "T2-genrm",
  "T3-agreement",
  "T4-consistency",
];

// ===========================================================================
// Small pure helpers
// ===========================================================================

function isTierId(t: unknown): t is TierId {
  return typeof t === "string" && (KNOWN_TIERS as readonly string[]).includes(t);
}

/**
 * Clamp into [0,1]. NaN (no well-defined direction to clamp toward) becomes
 * 0; +Infinity clamps to 1 and -Infinity clamps to 0 (both ARE well-defined
 * directions) exactly like any other out-of-range number. Non-numbers also
 * fall back to 0. This is the single place "never NaN out" is enforced for
 * unit-interval quantities (weights, confidences, salience).
 */
function clamp01(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * Exponential decay factor for a timestamp `at` relative to `now`, with
 * half-life `halfLifeMs`. Always finite and in [0,1] — non-finite inputs and
 * future-dated evidence (which would otherwise amplify past 1) are clamped,
 * never propagated as NaN/Infinity.
 */
function decayFactor(at: number, now: number, halfLifeMs: number): number {
  const safeHalfLife = Number.isFinite(halfLifeMs) && halfLifeMs > 0 ? halfLifeMs : Number.POSITIVE_INFINITY;
  const dt = now - at;
  if (!Number.isFinite(dt)) return dt <= 0 ? 1 : 0;
  const exponent = dt / safeHalfLife;
  const raw = Math.pow(0.5, exponent);
  return Number.isFinite(raw) ? clamp01(raw) : dt <= 0 ? 1 : 0;
}

/**
 * The hard confidence ceiling a piece of evidence at `tier` may contribute
 * toward. Follows the `memoryWriteCalibration()` convention (see
 * `memory/guard.ts`): T4-consistency (self-agreement only, the weakest,
 * most gameable edge) is capped at the guard's own calibrated prior — read
 * LIVE from `memoryWriteCalibration()` (never hardcoded here) so a future
 * recalibration in `guard.ts` propagates to this module and to
 * `belief-evidence.ts`'s exported `tierCap` in lockstep, instead of the two
 * caps silently diverging. Every stronger tier's cap is read straight off
 * `tierConfidenceFloor` at a 0.05 base error budget. Unknown tier values
 * (only reachable via malformed external data) fall back to the
 * conservative T4 cap rather than throwing — this function must never
 * explode combineEvidence's purity guarantee.
 */
function t4Cap(): number {
  return clamp01(memoryWriteCalibration().prior);
}

function tierCap(tier: TierId): number {
  if (tier === "T4-consistency") return t4Cap();
  if (!isTierId(tier)) return t4Cap();
  try {
    return tierConfidenceFloor(tier, 0.05);
  } catch {
    return t4Cap();
  }
}

// ===========================================================================
// normalizeAttribute / normalizeValue
// ===========================================================================

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Canonical attribute key: lowercase, Unicode-whitespace-collapsed, trimmed.
 * Throws TypeError on non-string or empty/whitespace-only input — an empty
 * attribute key can never be a valid ledger slot.
 */
export function normalizeAttribute(s: string): string {
  if (typeof s !== "string") {
    throw new TypeError(`normalizeAttribute: expected a string, got ${typeof s}`);
  }
  const norm = collapseWhitespace(s).toLowerCase();
  if (norm.length === 0) {
    throw new TypeError("normalizeAttribute: attribute must not be empty or whitespace-only");
  }
  return norm;
}

/**
 * Canonical comparison form of a value: lowercase, whitespace-collapsed,
 * trimmed. Unlike `normalizeAttribute` this never throws — an empty value is
 * a legitimate (if unusual) comparison key, and `UserBelief.value` always
 * keeps the original casing regardless of what this function returns.
 */
export function normalizeValue(s: string): string {
  if (typeof s !== "string") {
    throw new TypeError(`normalizeValue: expected a string, got ${typeof s}`);
  }
  return collapseWhitespace(s).toLowerCase();
}

// ===========================================================================
// combineEvidence — the confidence oracle
// ===========================================================================

/**
 * PURE. Combine an evidence ledger into a single calibrated confidence in
 * [0,1] as of `now`.
 *
 *  - Supporting evidence combines via noisy-OR: 1 − Π(1 − wᵢ·decayᵢ).
 *  - Contradicting/retracting evidence then multiplies that result by
 *    Π(1 − wⱼ·decayⱼ) — a penalty term, never a floor-raiser.
 *  - The result is hard-capped at the strongest `tierCap` among the
 *    SUPPORTING evidence only (contradicting evidence never raises a cap).
 *  - No supporting evidence (empty ledger, or only contradicting/retracting
 *    entries) → 0.
 *  - Every weight and timestamp is sanitized on the way in: non-finite
 *    weights clamp to 0, non-finite timestamps fall back to `now` (i.e. no
 *    decay), so this function can never emit NaN/Infinity regardless of how
 *    corrupted its input is.
 */
export function combineEvidence(evidence: BeliefEvidence[], now: number, halfLifeMs: number): number {
  const list = Array.isArray(evidence) ? evidence : [];
  const safeNow = Number.isFinite(now) ? now : 0;

  let supportComplement = 1;
  let penaltyComplement = 1;
  let sawSupport = false;
  let cap = 0;

  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const w = clamp01(typeof e.weight === "number" ? e.weight : 0);
    const at = Number.isFinite(e.at) ? e.at : safeNow;
    const decay = decayFactor(at, safeNow, halfLifeMs);
    const contribution = clamp01(w * decay);

    if (e.polarity === "supports") {
      sawSupport = true;
      supportComplement *= 1 - contribution;
      const c = tierCap(e.tier);
      if (c > cap) cap = c;
    } else if (e.polarity === "contradicts" || e.polarity === "retracts") {
      penaltyComplement *= 1 - contribution;
    }
    // Unknown polarity values (malformed data) contribute nothing either way.
  }

  if (!sawSupport) return 0;

  const noisyOr = 1 - supportComplement;
  const combined = noisyOr * penaltyComplement;
  return clamp01(Math.min(combined, cap));
}

// ===========================================================================
// reconcileBelief — the dialectic decision function
// ===========================================================================

/**
 * PURE. Decide how `incoming` updates (or doesn't) the belief `existing`
 * holds for its attribute. See the module doc comment for the two
 * extensions this file makes beyond the six literally-specified rules
 * (same-value `"contradicts"`, and how `"retracts"`/`"contradicts"` on a
 * DIFFERENT value fall naturally out of the general comparison because they
 * contribute no support to their own hypothetical).
 */
export function reconcileBelief(
  existing: UserBelief | undefined,
  incoming: BeliefAssertion,
  opts: Required<Pick<DialecticModelOptions, "halfLifeMs" | "contestMargin">> & { now: number },
): DialecticDecision {
  if (!existing) return "created";

  const polarity: EvidencePolarity = incoming.polarity ?? incoming.evidence?.polarity ?? "supports";
  const sameValue = normalizeValue(incoming.value) === normalizeValue(existing.value);

  if (sameValue) {
    if (polarity === "retracts") return "retracted";
    if (polarity === "contradicts") return "contested";
    return "reinforced";
  }

  // Different value: compare what the incoming evidence would be worth on
  // its own against the existing belief's confidence decayed to `now`.
  const hypotheticalEvidence: BeliefEvidence[] = [{ ...incoming.evidence, polarity }];
  const hypothetical = combineEvidence(hypotheticalEvidence, opts.now, opts.halfLifeMs);
  const existingDecayed = combineEvidence(existing.evidence, opts.now, opts.halfLifeMs);
  const diff = hypothetical - existingDecayed;
  const margin = clamp01(opts.contestMargin);

  if (diff > margin) return "revised";
  if (diff >= -margin) return "contested";
  return "ignored";
}

// ===========================================================================
// Evidence sanitation (shared by assert() and fromJSON())
// ===========================================================================

/**
 * Validate + defensively copy a raw (possibly external/untrusted) value into
 * a `BeliefEvidence`. Structural identity fields (id/excerpt/excerptSha256/
 * polarity/tier) throw TypeError with an actionable message when missing or
 * malformed — they cannot be sanely defaulted. Numeric fields (weight/at)
 * are clamped/defaulted instead of throwing, per the "never NaN out"
 * contract.
 */
function sanitizeEvidence(raw: unknown, fallbackNow: number): BeliefEvidence {
  if (!raw || typeof raw !== "object") {
    throw new TypeError("BeliefEvidence: expected an object");
  }
  const e = raw as Record<string, unknown>;

  if (typeof e.id !== "string" || e.id.length === 0) {
    throw new TypeError("BeliefEvidence.id must be a non-empty string");
  }
  if (typeof e.excerpt !== "string") {
    throw new TypeError(`BeliefEvidence.excerpt must be a string (evidence id=${e.id})`);
  }
  if (typeof e.excerptSha256 !== "string" || e.excerptSha256.length === 0) {
    throw new TypeError(`BeliefEvidence.excerptSha256 must be a non-empty string (evidence id=${e.id})`);
  }
  if (e.polarity !== "supports" && e.polarity !== "contradicts" && e.polarity !== "retracts") {
    throw new TypeError(`BeliefEvidence.polarity invalid for evidence id=${e.id}: ${String(e.polarity)}`);
  }
  if (!isTierId(e.tier)) {
    throw new TypeError(`BeliefEvidence.tier invalid for evidence id=${e.id}: ${String(e.tier)}`);
  }

  const weight = clamp01(typeof e.weight === "number" ? (e.weight as number) : 0);
  const at = Number.isFinite(e.at) ? (e.at as number) : fallbackNow;

  const evidence: BeliefEvidence = {
    id: e.id,
    excerpt: e.excerpt,
    excerptSha256: e.excerptSha256,
    polarity: e.polarity,
    tier: e.tier,
    weight,
    at,
  };
  if (typeof e.sessionId === "string") evidence.sessionId = e.sessionId;
  if (e.certificate && typeof e.certificate === "object") {
    evidence.certificate = e.certificate as VerificationCertificate;
  }
  if (typeof e.certificateValid === "boolean") evidence.certificateValid = e.certificateValid;
  if (e.verdict && typeof e.verdict === "object") {
    const v = e.verdict as Record<string, unknown>;
    if (typeof v.verifierId === "string" && typeof v.passed === "boolean") {
      evidence.verdict = {
        verifierId: v.verifierId,
        passed: v.passed,
        confidence: clamp01(typeof v.confidence === "number" ? (v.confidence as number) : 0),
      };
    }
  }
  return evidence;
}

function cloneEvidence(e: BeliefEvidence): BeliefEvidence {
  const copy: BeliefEvidence = {
    id: e.id,
    excerpt: e.excerpt,
    excerptSha256: e.excerptSha256,
    polarity: e.polarity,
    tier: e.tier,
    weight: e.weight,
    at: e.at,
  };
  if (e.sessionId !== undefined) copy.sessionId = e.sessionId;
  if (e.certificate !== undefined) copy.certificate = { ...e.certificate };
  if (e.certificateValid !== undefined) copy.certificateValid = e.certificateValid;
  if (e.verdict !== undefined) copy.verdict = { ...e.verdict };
  return copy;
}

function cloneBelief(b: UserBelief): UserBelief {
  return {
    attribute: b.attribute,
    value: b.value,
    confidence: b.confidence,
    status: b.status,
    salience: b.salience,
    evidence: b.evidence.map(cloneEvidence),
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    revisions: b.revisions,
    supersededValues: [...b.supersededValues],
  };
}

function appendEvidenceDeduped(list: BeliefEvidence[], ev: BeliefEvidence): void {
  // Identical evidence id ⇒ identical canonical content (the producer's
  // contract). Re-asserting it must not inflate confidence via a duplicated
  // noisy-OR term, so it's a silent no-op rather than a second ledger entry.
  if (list.some((existing) => existing.id === ev.id)) return;
  list.push(ev);
}

// ===========================================================================
// DialecticUserModel
// ===========================================================================

export class DialecticUserModel {
  private readonly beliefs = new Map<string, UserBelief>();
  private readonly nowFn: () => number;
  private readonly halfLifeMs: number;
  private readonly assertFloor: number;
  private readonly contestMargin: number;

  constructor(opts: DialecticModelOptions = {}) {
    this.nowFn = typeof opts.now === "function" ? opts.now : () => Date.now();
    this.halfLifeMs =
      opts.halfLifeMs !== undefined && Number.isFinite(opts.halfLifeMs) && opts.halfLifeMs > 0
        ? opts.halfLifeMs
        : DEFAULT_HALF_LIFE_MS;
    this.assertFloor = opts.assertFloor !== undefined ? clamp01(opts.assertFloor) : DEFAULT_ASSERT_FLOOR;
    this.contestMargin = opts.contestMargin !== undefined ? clamp01(opts.contestMargin) : DEFAULT_CONTEST_MARGIN;
  }

  private now(): number {
    const n = this.nowFn();
    return Number.isFinite(n) ? n : 0;
  }

  private resolveNow(now?: number): number {
    return now !== undefined && Number.isFinite(now) ? now : this.now();
  }

  /** Decay `belief.salience` from its previous `updatedAt` up to `now`, then add `boost`. */
  private touchSalience(belief: UserBelief, now: number, boost: number): void {
    const decayed = clamp01(belief.salience * decayFactor(belief.updatedAt, now, this.halfLifeMs));
    belief.salience = clamp01(decayed + boost);
  }

  private recomputeConfidence(belief: UserBelief, now: number): void {
    belief.confidence = combineEvidence(belief.evidence, now, this.halfLifeMs);
  }

  private applyFloorStatus(belief: UserBelief): void {
    belief.status = belief.confidence >= this.assertFloor ? "asserted" : "abstained";
  }

  /**
   * Assert one piece of evidence for (attribute, value). Recomputes
   * confidence from the FULL evidence ledger after every mutation — the
   * returned decision explains what happened, but the belief's stored
   * confidence is never taken from the caller.
   */
  assert(a: BeliefAssertion): DialecticDecision {
    if (!a || typeof a !== "object") {
      throw new TypeError("DialecticUserModel.assert: assertion must be an object");
    }
    const attrKey = normalizeAttribute(a.attribute);
    if (typeof a.value !== "string") {
      throw new TypeError("DialecticUserModel.assert: value must be a string");
    }

    const now = a.now !== undefined && Number.isFinite(a.now) ? a.now : this.now();
    const existing = this.beliefs.get(attrKey);
    const decision = reconcileBelief(existing, a, {
      now,
      halfLifeMs: this.halfLifeMs,
      contestMargin: this.contestMargin,
    });

    const polarity: EvidencePolarity = a.polarity ?? a.evidence?.polarity ?? "supports";
    const storedEvidence = sanitizeEvidence({ ...a.evidence, polarity }, now);

    switch (decision) {
      case "created": {
        const belief: UserBelief = {
          attribute: attrKey,
          value: a.value,
          confidence: 0,
          status: "abstained",
          salience: 1,
          evidence: [storedEvidence],
          createdAt: now,
          updatedAt: now,
          revisions: 0,
          supersededValues: [],
        };
        this.recomputeConfidence(belief, now);
        this.applyFloorStatus(belief);
        this.beliefs.set(attrKey, belief);
        return decision;
      }

      case "reinforced": {
        const belief = existing as UserBelief;
        this.touchSalience(belief, now, SALIENCE_TOUCH_BOOST);
        appendEvidenceDeduped(belief.evidence, storedEvidence);
        belief.updatedAt = now;
        this.recomputeConfidence(belief, now);
        this.applyFloorStatus(belief);
        return decision;
      }

      case "revised": {
        const belief = existing as UserBelief;
        if (!belief.supersededValues.includes(belief.value)) {
          belief.supersededValues.push(belief.value);
        }
        this.touchSalience(belief, now, SALIENCE_TOUCH_BOOST);
        belief.value = a.value;
        belief.evidence = [storedEvidence];
        belief.revisions += 1;
        belief.updatedAt = now;
        this.recomputeConfidence(belief, now);
        this.applyFloorStatus(belief);
        return decision;
      }

      case "contested": {
        const belief = existing as UserBelief;
        this.touchSalience(belief, now, 0);
        appendEvidenceDeduped(belief.evidence, storedEvidence);
        belief.updatedAt = now;
        this.recomputeConfidence(belief, now);
        belief.status = "contested";
        return decision;
      }

      case "retracted": {
        const belief = existing as UserBelief;
        this.touchSalience(belief, now, 0);
        appendEvidenceDeduped(belief.evidence, storedEvidence);
        belief.updatedAt = now;
        this.recomputeConfidence(belief, now);
        belief.status = "retracted";
        return decision;
      }

      case "ignored": {
        const belief = existing as UserBelief;
        this.touchSalience(belief, now, 0);
        // Still ledgered — the contradiction is visible to audit and erodes
        // confidence via combineEvidence's penalty term — even though it
        // didn't win the dialectic.
        appendEvidenceDeduped(belief.evidence, storedEvidence);
        belief.updatedAt = now;
        this.recomputeConfidence(belief, now);
        if (belief.status === "asserted" || belief.status === "abstained") {
          this.applyFloorStatus(belief);
        }
        return decision;
      }

      default:
        return decision;
    }
  }

  get(attribute: string): UserBelief | undefined {
    const key = normalizeAttribute(attribute);
    const belief = this.beliefs.get(key);
    return belief ? cloneBelief(belief) : undefined;
  }

  private snapshot(now: number): UserBelief[] {
    const list = Array.from(this.beliefs.values()).map(cloneBelief);
    list.sort((a, b) => this.decayedConfidence(b, now) - this.decayedConfidence(a, now));
    return list;
  }

  /** Defensive copies of every belief, sorted by decayed confidence (desc, stable). */
  all(): UserBelief[] {
    return this.snapshot(this.now());
  }

  asserted(now?: number): UserBelief[] {
    const resolvedNow = this.resolveNow(now);
    return this.snapshot(resolvedNow).filter(
      (b) => b.status === "asserted" && this.decayedConfidence(b, resolvedNow) >= this.assertFloor,
    );
  }

  /**
   * Everything the model is withholding: beliefs explicitly `"abstained"` or
   * `"contested"`, plus `"asserted"` beliefs that have since decayed below
   * the assert floor. `"retracted"` beliefs are excluded — a retraction is
   * an active negation, not a pending abstention.
   */
  abstained(now?: number): UserBelief[] {
    const resolvedNow = this.resolveNow(now);
    return this.snapshot(resolvedNow).filter((b) => {
      if (b.status === "abstained" || b.status === "contested") return true;
      if (b.status === "asserted") return this.decayedConfidence(b, resolvedNow) < this.assertFloor;
      return false;
    });
  }

  /** Live confidence for `b` decayed to `now` (default: the model's clock). Never mutates `b`. */
  decayedConfidence(b: UserBelief, now?: number): number {
    const resolvedNow = this.resolveNow(now);
    return combineEvidence(b.evidence, resolvedNow, this.halfLifeMs);
  }

  /**
   * Prose summary for `ConversationTurnContext.userProfile`. Deterministic
   * and stable-ordered (both sections are sorted by decayed confidence, ties
   * broken by insertion order) so it is prompt-cache friendly across turns
   * where nothing changed. Abstained/contested attributes are named but
   * their disputed/unconfident value is never printed.
   */
  describe(now?: number): string {
    const resolvedNow = this.resolveNow(now);
    if (this.beliefs.size === 0) return "No verified model of the user yet.";

    const assertedList = this.asserted(resolvedNow);
    const abstainedList = this.abstained(resolvedNow);

    const lines: string[] = [];
    for (const b of assertedList) {
      const pct = Math.round(clamp01(this.decayedConfidence(b, resolvedNow)) * 100);
      lines.push(`- ${b.attribute}: ${b.value} (${pct}% confident, ${b.evidence.length} evidence)`);
    }
    if (abstainedList.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("Abstaining on:");
      for (const b of abstainedList) {
        lines.push(`- ${b.attribute}`);
      }
    }

    return lines.length > 0 ? lines.join("\n") : "No verified model of the user yet.";
  }

  toJSON(): UserModelSnapshot {
    return {
      version: 1,
      beliefs: Array.from(this.beliefs.values()).map(cloneBelief),
    };
  }

  /**
   * Rebuild a model from a snapshot. Structurally validates every belief and
   * evidence entry (throwing TypeError with an actionable message on
   * malformed input) and, critically, NEVER trusts a stored `confidence` —
   * it is re-derived from that belief's evidence ledger at its `updatedAt`.
   * A tampered snapshot with an inflated confidence loads with the honest,
   * evidence-derived number instead.
   */
  static fromJSON(snap: unknown, opts?: DialecticModelOptions): DialecticUserModel {
    if (!snap || typeof snap !== "object") {
      throw new TypeError("UserModelSnapshot: expected an object");
    }
    const s = snap as Record<string, unknown>;
    if (s.version !== 1) {
      throw new TypeError(`UserModelSnapshot: unsupported version ${JSON.stringify(s.version)}`);
    }
    if (!Array.isArray(s.beliefs)) {
      throw new TypeError("UserModelSnapshot: beliefs must be an array");
    }

    const model = new DialecticUserModel(opts);
    for (const raw of s.beliefs) {
      const belief = model.parseBelief(raw);
      model.beliefs.set(normalizeAttribute(belief.attribute), belief);
    }
    return model;
  }

  private parseBelief(raw: unknown): UserBelief {
    if (!raw || typeof raw !== "object") {
      throw new TypeError("UserModelSnapshot: each belief must be an object");
    }
    const r = raw as Record<string, unknown>;

    if (typeof r.attribute !== "string" || collapseWhitespace(r.attribute).length === 0) {
      throw new TypeError(`UserModelSnapshot: belief.attribute must be a non-empty string, got ${JSON.stringify(r.attribute)}`);
    }
    if (typeof r.value !== "string") {
      throw new TypeError(`UserModelSnapshot: belief.value must be a string (attribute=${r.attribute})`);
    }
    if (!Array.isArray(r.evidence)) {
      throw new TypeError(`UserModelSnapshot: belief.evidence must be an array (attribute=${r.attribute})`);
    }

    const validStatuses: readonly BeliefStatus[] = ["asserted", "abstained", "contested", "retracted", "superseded"];
    if (typeof r.status !== "string" || !validStatuses.includes(r.status as BeliefStatus)) {
      throw new TypeError(`UserModelSnapshot: belief.status invalid (attribute=${r.attribute}): ${JSON.stringify(r.status)}`);
    }

    const createdAt = Number.isFinite(r.createdAt) ? (r.createdAt as number) : 0;
    const updatedAt = Number.isFinite(r.updatedAt) ? (r.updatedAt as number) : createdAt;
    const evidence = (r.evidence as unknown[]).map((e) => sanitizeEvidence(e, updatedAt));

    let status = r.status as BeliefStatus;
    const confidence = combineEvidence(evidence, updatedAt, this.halfLifeMs);
    if (status === "asserted" || status === "abstained") {
      status = confidence >= this.assertFloor ? "asserted" : "abstained";
    }

    const revisions = Number.isFinite(r.revisions) && (r.revisions as number) >= 0 ? Math.floor(r.revisions as number) : 0;
    const salience = clamp01(Number.isFinite(r.salience) ? (r.salience as number) : 0);
    const supersededValues = Array.isArray(r.supersededValues)
      ? (r.supersededValues as unknown[]).filter((v): v is string => typeof v === "string")
      : [];

    return {
      attribute: normalizeAttribute(r.attribute),
      value: r.value,
      confidence,
      status,
      salience,
      evidence,
      createdAt,
      updatedAt,
      revisions,
      supersededValues,
    };
  }
}
