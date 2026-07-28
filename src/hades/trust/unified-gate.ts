/**
 * The unified trust gate — the single object every accepted output in this
 * repo must pass through before it is allowed to leave the agent.
 *
 * This is where the four separate STYX/registry primitives are wired into
 * ONE admission decision:
 *
 *   1. `VerifierRegistry` (Phase 14 spine, `./registry`) selects, runs, and
 *      fuses whatever `UniversalVerifier`s apply to a `TrustSubject` into a
 *      single calibrated `FusedVerification` (score, weakest contributing
 *      tier, verifier id+versions).
 *   2. `ConformalGate` (`../styx/gate`) turns a PER-DOMAIN calibration set
 *      into a split-conformal threshold τ and applies it to the fused score:
 *      `P(wrong | emitted) ≤ ε` is a distribution-free, math-backed bound,
 *      not a vibe.
 *   3. `tierConfidenceFloor` (`../styx/tiers`) enforces a SECOND, independent
 *      bar: even a score that clears τ must also clear the calibrated
 *      confidence floor for the WEAKEST tier that actually voted — a T4
 *      self-consistency check can never quietly borrow a T0 oracle's budget.
 *   4. `CertificateAuthority` (`../styx/certificate`) issues a REAL
 *      ed25519-signed `VerificationCertificate` binding the exact output
 *      text, the exact canonical execution trace, and every contributing
 *      verifier's id+version — but ONLY when every gate above says yes.
 *
 * A `TrustBudgetPort` (optional) is consulted immediately before issuance
 * (`quote`) and immediately after a successful issuance (`spend`); a budget
 * that refuses either call rolls the admission back to an abstention and the
 * signed certificate that was already built is discarded, never returned.
 *
 * ## The central invariant
 *
 * For every `Admission` this gate ever produces:
 *
 *     admission.accepted === (admission.certificate !== undefined)
 *
 * An abstained subject NEVER receives a certificate, under any code path.
 * Every accepted subject receives a certificate that (a) verifies under the
 * real `verifyCertificate`, (b) `certifiesOutput` the EXACT `subject.output`
 * it was issued for, and (c) fails `certifiesOutput` for any other text.
 *
 * ## Abstention is first-class, not an exception
 *
 * `admit()` never throws for a routine "this subject doesn't clear the bar"
 * outcome — it returns `{ accepted: false, abstention: { code, message } }`
 * with one of the eight `AbstentionCode`s below. Throwing is reserved for
 * genuine programmer errors (bad config at construction time).
 *
 * ## The verifier-conflict veto
 *
 * `WeakVerifierEnsemble` fuses many weak votes into one score by
 * reliability-weighted majority — which means a crowd of cheap, weak-tier
 * PASSes can numerically outvote a single strong-tier (T0/T1) FAIL and push
 * the fused score above threshold. That is exactly the overclaim a trust
 * gate must refuse to launder: a strong verifier's dissent is evidence a
 * weak-tier majority cannot buy off with volume. So before any
 * threshold/floor/budget check runs, this gate looks at the STRONGEST tier
 * among the subject's actually-contributing (non-abstained) verdicts; if
 * any verdict at that strongest tier FAILED while a WEAKER tier PASSED, the
 * subject abstains with `"verifier-conflict"` regardless of what the fused
 * score says. This is a hard veto, not a score adjustment.
 *
 * ## Degraded evidence
 *
 * `VerifierRegistry.verify()` marks a subject `degraded: true,
 * degradedReason: "single-verifier"` when exactly one verifier contributed a
 * vote — with nothing else to agree or disagree with, the registry hands
 * back that lone verifier's own prior-damped confidence, never a genuine
 * ensemble estimate (see `./registry`'s module doc). This gate treats that
 * as `"degraded-evidence"` and abstains unconditionally: a lone voter's
 * opinion is never enough to sign a certificate, no matter how confident it
 * claims to be. `"no-verifier"` (nothing registered for the domain) and
 * `"all-abstained"` (everything selected declined to vote) get their own
 * dedicated codes for the same reason — none of the three degraded shapes
 * carry real ensemble signal.
 *
 * Pure and deterministic: no `Date.now`, no randomness, no I/O in this
 * module. The caller injects the clock (`cfg.now`) and, when used, the
 * budget port; every certificate is issued through the real
 * `CertificateAuthority` and every threshold through the real
 * `ConformalGate`.
 *
 * @module hades/trust/unified-gate
 */

import {
  ConformalGate,
  type CalibrationPoint,
  type GateStats,
  type GateDecision,
} from "../styx/gate";
import {
  type CertificateAuthority,
  type CertificatePayload,
  type VerificationCertificate,
  sha256Hex,
} from "../styx/certificate";
import { TIER_ORDER, tierConfidenceFloor, type TierId } from "../styx/tiers";
import {
  type VerifierRegistry,
  type TrustSubject,
  type TrustDomain,
  type FusedVerification,
  canonicalTrace,
  subjectKey,
} from "./registry";

// ===========================================================================
// Locked public surface
// ===========================================================================

export type AbstentionCode =
  | "uncalibrated"
  | "no-verifier"
  | "all-abstained"
  | "below-threshold"
  | "tier-floor"
  | "budget-exhausted"
  | "degraded-evidence"
  | "verifier-conflict";

/** Every {@link AbstentionCode}, for building zero-initialized tallies. */
const ALL_ABSTENTION_CODES: readonly AbstentionCode[] = [
  "uncalibrated",
  "no-verifier",
  "all-abstained",
  "below-threshold",
  "tier-floor",
  "budget-exhausted",
  "degraded-evidence",
  "verifier-conflict",
] as const;

/** Every {@link TrustDomain}, for pre-populating per-domain state. */
const ALL_DOMAINS: readonly TrustDomain[] = ["tool", "procedure", "memory", "message"] as const;

export interface TrustBudgetPort {
  quote(req: { domain: string; taskId: string; risk: number }): {
    allowed: boolean;
    reason?: string;
    remaining: number;
  };
  spend(req: {
    domain: string;
    taskId: string;
    risk: number;
    subjectSha256: string;
    issuedAt: number;
  }): { accepted: boolean; remaining: number; entrySha256: string };
}

export interface UnifiedGateConfig {
  /** global default, strictly in (0,1) */
  epsilon: number;
  perDomain?: Partial<Record<TrustDomain, { epsilon: number; minCalibration?: number }>>;
  /** REAL ../styx/certificate CA */
  issuer: CertificateAuthority;
  /** REAL ./registry */
  registry: VerifierRegistry;
  /** injected clock; no Date.now inside */
  now: () => number;
  budget?: TrustBudgetPort;
}

export interface Admission {
  accepted: boolean;
  domain: TrustDomain;
  subjectId: string;
  taskId: string;
  subjectSha256: string;
  tier: TierId;
  score: number;
  threshold: number;
  pCorrect: number;
  epsilon: number;
  spentRisk: number;
  verifierVersions: string[];
  certificate?: VerificationCertificate;
  abstention?: { code: AbstentionCode; message: string; escalateTo?: TierId };
}

export interface TrustGateReport {
  perDomain: Record<
    TrustDomain,
    {
      calibrated: boolean;
      stats: GateStats | null;
      admitted: number;
      abstained: number;
      spentRisk: number;
      abstentionsByCode: Record<AbstentionCode, number>;
    }
  >;
  totalAdmitted: number;
  totalAbstained: number;
  coverage: number;
  totalSpentRisk: number;
}

// ===========================================================================
// Internals
// ===========================================================================

function emptyAbstentionCounts(): Record<AbstentionCode, number> {
  const out = {} as Record<AbstentionCode, number>;
  for (const code of ALL_ABSTENTION_CODES) out[code] = 0;
  return out;
}

function validateEpsilon(epsilon: number, label: string): void {
  if (typeof epsilon !== "number" || !Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 1) {
    throw new RangeError(
      `UnifiedTrustGate: epsilon for ${label} must be strictly inside (0, 1); got ${String(epsilon)}`,
    );
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function tierIndex(tier: TierId): number {
  const idx = TIER_ORDER.indexOf(tier);
  return idx < 0 ? TIER_ORDER.length - 1 : idx;
}

/** The next STRONGER tier than `tier`, or `undefined` if already T0-execution. */
function strongerTier(tier: TierId): TierId | undefined {
  const idx = tierIndex(tier);
  return idx > 0 ? TIER_ORDER[idx - 1] : undefined;
}

/**
 * The conservative wrong-rate floor implied by a domain's own calibration:
 * `1 / (m + 1)`, where `m` is the number of calibration points at or above
 * the fitted threshold. This is the zero-observed-errors case of the exact
 * `(wrong + 1) / (selected + 1)` rate `conformalThreshold` uses to decide
 * whether a threshold is admissible at all, so it is always <= epsilon for
 * any threshold that was actually accepted.
 *
 * Returns a strictly positive number for every real calibration, and falls
 * back to `1` (charge the maximum) when stats are missing or unusable — a
 * gate that cannot say how much risk it is taking must assume the most, not
 * the least.
 */
function conservativeRiskFloor(stats: GateStats | null): number {
  if (stats === null) return 1;
  const { calibrationSize, coverageAtThreshold } = stats;
  if (!Number.isFinite(calibrationSize) || calibrationSize <= 0) return 1;
  if (!Number.isFinite(coverageAtThreshold) || coverageAtThreshold <= 0) return 1;
  const selected = Math.round(calibrationSize * coverageAtThreshold);
  if (!Number.isFinite(selected) || selected <= 0) return 1;
  return 1 / (selected + 1);
}

interface DomainState {
  readonly gate: ConformalGate;
  readonly epsilon: number;
  calibrated: boolean;
  stats: GateStats | null;
  admitted: number;
  abstained: number;
  spentRisk: number;
  readonly abstentionsByCode: Record<AbstentionCode, number>;
}

// ===========================================================================
// UnifiedTrustGate
// ===========================================================================

/**
 * The centerpiece admission gate. See the module doc for the full pipeline;
 * in short, `admit()` runs a `TrustSubject` through registry fusion → the
 * verifier-conflict veto → the domain's conformal threshold → the tier
 * confidence floor → the trust budget, and issues a real certificate iff all
 * five stages agree.
 */
export class UnifiedTrustGate {
  private readonly cfg: UnifiedGateConfig;
  private readonly domainStates: Map<TrustDomain, DomainState>;

  constructor(cfg: UnifiedGateConfig) {
    validateEpsilon(cfg.epsilon, "the global default");
    const overrides = cfg.perDomain ?? {};
    for (const domain of ALL_DOMAINS) {
      const override = overrides[domain];
      if (override !== undefined) validateEpsilon(override.epsilon, `domain "${domain}"`);
    }

    this.cfg = cfg;
    this.domainStates = new Map();
    for (const domain of ALL_DOMAINS) {
      const override = overrides[domain];
      const epsilon = override?.epsilon ?? cfg.epsilon;
      this.domainStates.set(domain, {
        gate: new ConformalGate({ epsilon, minCalibration: override?.minCalibration }),
        epsilon,
        calibrated: false,
        stats: null,
        admitted: 0,
        abstained: 0,
        spentRisk: 0,
        abstentionsByCode: emptyAbstentionCounts(),
      });
    }
  }

  private requireDomainState(domain: TrustDomain): DomainState {
    const state = this.domainStates.get(domain);
    if (state === undefined) {
      throw new TypeError(`UnifiedTrustGate: unknown trust domain ${JSON.stringify(domain)}`);
    }
    return state;
  }

  /**
   * Fit this domain's split-conformal threshold from labeled calibration
   * data. Calibrating one domain never touches another domain's gate — each
   * `TrustDomain` owns an independent `ConformalGate` instance fitted at its
   * own (possibly per-domain-overridden) epsilon.
   *
   * @throws {RangeError} propagated from the underlying `ConformalGate` if
   *   `points` is smaller than the configured minimum calibration size.
   */
  calibrate(domain: TrustDomain, points: CalibrationPoint[]): GateStats {
    const state = this.requireDomainState(domain);
    const stats = state.gate.calibrate(points);
    state.stats = stats;
    state.calibrated = true;
    return stats;
  }

  /** Calibrate every domain present in `points` (domains absent from the
   *  input are left uncalibrated). */
  calibrateAll(points: Partial<Record<TrustDomain, CalibrationPoint[]>>): Record<string, GateStats> {
    const out: Record<string, GateStats> = {};
    for (const domain of ALL_DOMAINS) {
      const domainPoints = points[domain];
      if (domainPoints !== undefined) {
        out[domain] = this.calibrate(domain, domainPoints);
      }
    }
    return out;
  }

  /**
   * Admit one subject. Never throws for a routine abstention — every
   * ordinary "this doesn't clear the bar" outcome is a first-class
   * `{ accepted: false, abstention }` return, including admitting before
   * `calibrate()` was ever called for the subject's domain (`"uncalibrated"`,
   * never a thrown error, never a certificate).
   */
  async admit(subject: TrustSubject): Promise<Admission> {
    const state = this.requireDomainState(subject.domain);
    if (!state.calibrated) {
      return this.recordAbstention(state, subject, "uncalibrated", this.uncalibratedMessage(subject.domain));
    }
    const fused = await this.cfg.registry.verify(subject);
    return this.decideFromFusion(subject, fused, state);
  }

  /**
   * Admit many subjects, batch-fused via `registry.verifyBatch` — ONE
   * `WeakVerifierEnsemble.fitPredict` call across the whole batch, run
   * before any per-subject gating.
   *
   * DOCUMENTED DIVERGENCE FROM SEQUENTIAL `admit()`: a subject with exactly
   * one contributing (non-abstained) verifier is forced into
   * `degradedReason: "single-verifier"` (→ `"degraded-evidence"` here) when
   * verified one-at-a-time via `admit()`, because a lone voter has nothing
   * else to agree or disagree with in that call. In a batch, the SAME lone
   * voter on one subject may have cast OTHER votes elsewhere in the batch,
   * giving `WeakVerifierEnsemble` real agreement signal to estimate that
   * voter's reliability from — so `registry.verifyBatch` does not force that
   * subject into `"single-verifier"` degradation, and `admitAll` can
   * therefore admit a subject that sequential `admit` would have abstained
   * on as `"degraded-evidence"`. This is `./registry`'s documented behavior
   * (see its module doc), not a bug in this gate: batch fusion legitimately
   * sharpens reliabilities that single-subject fusion cannot.
   */
  async admitAll(subjects: readonly TrustSubject[]): Promise<Admission[]> {
    // Only subjects whose domain is actually calibrated enter the batch. An
    // uncalibrated subject can never be admitted, so running its verifiers
    // would be pure side effect — and, worse, its votes would land in the
    // SAME `WeakVerifierEnsemble.fitPredict` call that decides the calibrated
    // subjects, letting anyone who can append an uncalibrated-domain subject
    // to a batch shift the reliability estimates the real admissions are
    // scored against. Sequential `admit()` short-circuits before verifying
    // for the same reason; this keeps the two paths honest about each other.
    const eligible: number[] = [];
    for (let i = 0; i < subjects.length; i++) {
      const state = this.domainStates.get(subjects[i].domain);
      if (state !== undefined && state.calibrated) eligible.push(i);
    }
    const fusedList = await this.cfg.registry.verifyBatch(eligible.map((i) => subjects[i]));

    const fusedByIndex = new Map<number, FusedVerification>();
    for (let k = 0; k < eligible.length; k++) fusedByIndex.set(eligible[k], fusedList[k]);

    const out: Admission[] = [];
    for (let i = 0; i < subjects.length; i++) {
      const subject = subjects[i];
      const state = this.requireDomainState(subject.domain);
      const fused = fusedByIndex.get(i);
      if (!state.calibrated || fused === undefined) {
        out.push(this.recordAbstention(state, subject, "uncalibrated", this.uncalibratedMessage(subject.domain)));
        continue;
      }
      out.push(await this.decideFromFusion(subject, fused, state));
    }
    return out;
  }

  /** Stats from the most recent calibration of each domain that has one. */
  stats(): Partial<Record<TrustDomain, GateStats>> {
    const out: Partial<Record<TrustDomain, GateStats>> = {};
    for (const domain of ALL_DOMAINS) {
      const state = this.requireDomainState(domain);
      if (state.stats !== null) out[domain] = { ...state.stats };
    }
    return out;
  }

  /** A full per-domain + aggregate snapshot of this gate's lifetime activity. */
  report(): TrustGateReport {
    const perDomain = {} as TrustGateReport["perDomain"];
    let totalAdmitted = 0;
    let totalAbstained = 0;
    let totalSpentRisk = 0;
    for (const domain of ALL_DOMAINS) {
      const state = this.requireDomainState(domain);
      perDomain[domain] = {
        calibrated: state.calibrated,
        stats: state.stats === null ? null : { ...state.stats },
        admitted: state.admitted,
        abstained: state.abstained,
        spentRisk: state.spentRisk,
        abstentionsByCode: { ...state.abstentionsByCode },
      };
      totalAdmitted += state.admitted;
      totalAbstained += state.abstained;
      totalSpentRisk += state.spentRisk;
    }
    const total = totalAdmitted + totalAbstained;
    return {
      perDomain,
      totalAdmitted,
      totalAbstained,
      coverage: total > 0 ? totalAdmitted / total : 0,
      totalSpentRisk,
    };
  }

  // -------------------------------------------------------------------------
  // Decision pipeline (shared by admit() and admitAll())
  // -------------------------------------------------------------------------

  private uncalibratedMessage(domain: TrustDomain): string {
    return `UnifiedTrustGate: domain "${domain}" has not been calibrated; call calibrate("${domain}", ...) before admit().`;
  }

  private async decideFromFusion(
    subject: TrustSubject,
    fused: FusedVerification,
    state: DomainState,
  ): Promise<Admission> {
    const key = subjectKey(subject);
    const subjectSha256 = sha256Hex(subject.output);

    if (fused.degradedReason === "no-verifier") {
      return this.recordAbstention(
        state,
        subject,
        "no-verifier",
        `[${key.slice(0, 12)}] no verifier is registered for domain "${subject.domain}".`,
        fused,
        subjectSha256,
      );
    }
    if (fused.degradedReason === "all-abstained") {
      return this.recordAbstention(
        state,
        subject,
        "all-abstained",
        `[${key.slice(0, 12)}] every selected verifier abstained on this subject.`,
        fused,
        subjectSha256,
      );
    }
    if (fused.degradedReason === "single-verifier") {
      return this.recordAbstention(
        state,
        subject,
        "degraded-evidence",
        `[${key.slice(0, 12)}] only one verifier contributed a vote; a lone voter carries no ` +
          `genuine ensemble reliability signal and cannot be certified.`,
        fused,
        subjectSha256,
      );
    }
    if (fused.degradedReason === "self-attested-only") {
      // Distinct from "single-verifier" on purpose: here two or more verifiers
      // DID vote, so a counter would have said the evidence bar was cleared.
      // It was not. The extra vote(s) came from SELF-ATTESTED verifiers that
      // passed — verifiers that compare answerer-supplied material against
      // other answerer-supplied material, whose pass anyone controlling the
      // subject can obtain at will (see `./registry.ts`
      // `UniversalVerifier.selfAttested`). Counting that as a co-voter is
      // precisely how a false answer buys the second vote that turns an
      // abstention into a signed certificate, so it is refused by name.
      const selfIds = fused.verdicts
        .filter((v) => !v.abstained && v.passed && this.cfg.registry.isSelfAttestedId(v.verifierId))
        .map((v) => `${v.verifierId}@${v.version}`)
        .join(",");
      return this.recordAbstention(
        state,
        subject,
        "degraded-evidence",
        `[${key.slice(0, 12)}] fewer than two INDEPENDENT verifiers contributed a vote: the ` +
          `additional passing verifier(s) [${selfIds}] are self-attested — they check ` +
          `answerer-supplied material against other answerer-supplied material, so their pass is ` +
          `reachable by whoever produced the answer and is not evidence that it is correct.`,
        fused,
        subjectSha256,
      );
    }

    // Verifier-conflict veto: a strong-tier FAIL must never be out-voted by a
    // crowd of weak-tier PASSes into acceptance. Checked BEFORE the score
    // threshold, independent of what the fused score says.
    const contributing = fused.verdicts.filter((v) => !v.abstained);
    if (contributing.length > 0) {
      const strongestIdx = Math.min(...contributing.map((v) => tierIndex(v.tier)));
      const strongFails = contributing.filter((v) => tierIndex(v.tier) === strongestIdx && !v.passed);
      const weakerPasses = contributing.filter((v) => tierIndex(v.tier) > strongestIdx && v.passed);
      if (strongFails.length > 0 && weakerPasses.length > 0) {
        const strongIds = strongFails.map((v) => `${v.verifierId}@${v.version}`).join(",");
        const weakIds = weakerPasses.map((v) => `${v.verifierId}@${v.version}`).join(",");
        return this.recordAbstention(
          state,
          subject,
          "verifier-conflict",
          `[${key.slice(0, 12)}] strongest-tier verifier(s) [${strongIds}] failed while weaker-tier ` +
            `verifier(s) [${weakIds}] passed; a weak-tier majority may never out-vote a strong-tier dissent.`,
          fused,
          subjectSha256,
        );
      }
    }

    const decision = state.gate.decide(fused.score);
    if (!decision.emit) {
      return this.recordAbstention(
        state,
        subject,
        "below-threshold",
        `[${key.slice(0, 12)}] fused score ${fused.score.toFixed(6)} is below the calibrated threshold ` +
          `${Number.isFinite(decision.threshold) ? decision.threshold.toFixed(6) : "+Infinity"} at epsilon ${state.epsilon}.`,
        fused,
        subjectSha256,
        decision,
      );
    }

    const floor = tierConfidenceFloor(fused.tier, state.epsilon);
    if (decision.pCorrectEstimate < floor) {
      return this.recordAbstention(
        state,
        subject,
        "tier-floor",
        `[${key.slice(0, 12)}] calibrated P(correct) ${decision.pCorrectEstimate.toFixed(6)} is below the ` +
          `${fused.tier} confidence floor ${floor.toFixed(6)} at epsilon ${state.epsilon}.`,
        fused,
        subjectSha256,
        decision,
        strongerTier(fused.tier),
      );
    }

    // The residual risk this admission spends from the domain's trust
    // budget: the calibrated wrong-probability of the decision about to
    // emit, floored at the CONSERVATIVE rate the conformal fit itself used
    // to accept this threshold. Always <= epsilon by the conformal
    // guarantee, and always strictly > 0.
    //
    // Why the floor is not padding. `GateDecision.pCorrectEstimate` is
    // documented in `../styx/gate` as `1 - empiricalRiskAtThreshold`, the
    // UNCORRECTED observed rate — so a calibration sample in which no
    // selected point happened to be wrong yields `pCorrectEstimate === 1`
    // and a residual risk of exactly zero. But `conformalThreshold` chose
    // that very threshold under the CORRECTED rate
    // `(wrong + 1) / (selected + 1)`, which is never zero: "zero errors
    // observed in m samples" is not "zero probability of error", and
    // charging nothing for it would let a gate that merely got a clean
    // calibration draw emit without limit while its budget never moved.
    // Charging the same conservative number the fit was accepted under is
    // the gate's own criterion applied consistently — not an invented
    // safety margin.
    const risk = Math.max(clamp01(1 - decision.pCorrectEstimate), conservativeRiskFloor(state.stats));

    if (this.cfg.budget !== undefined) {
      const quote = this.cfg.budget.quote({ domain: subject.domain, taskId: subject.taskId, risk });
      if (!quote.allowed) {
        return this.recordAbstention(
          state,
          subject,
          "budget-exhausted",
          `[${key.slice(0, 12)}] trust budget refused this admission at quote time` +
            (quote.reason ? `: ${quote.reason}` : "") +
            ` (remaining=${quote.remaining}).`,
          fused,
          subjectSha256,
          decision,
        );
      }
    }

    const issuedAt = this.cfg.now();
    const payload: CertificatePayload = {
      outputSha256: subjectSha256,
      taskId: subject.taskId,
      verifierTier: fused.tier,
      ensembleScore: fused.score,
      pCorrect: decision.pCorrectEstimate,
      epsilon: state.epsilon,
      traceSha256: sha256Hex(canonicalTrace(subject.trace)),
      verifierVersions: [...fused.verifierVersions],
      issuedAt,
    };
    const certificate = await this.cfg.issuer.issue(payload);

    if (this.cfg.budget !== undefined) {
      const spend = this.cfg.budget.spend({
        domain: subject.domain,
        taskId: subject.taskId,
        risk,
        subjectSha256,
        issuedAt,
      });
      if (!spend.accepted) {
        // The certificate was already built and signed above, but it is
        // deliberately discarded here and never returned to the caller: a
        // rejected spend rolls the whole admission back to an abstention.
        return this.recordAbstention(
          state,
          subject,
          "budget-exhausted",
          `[${key.slice(0, 12)}] trust budget refused this admission at spend time ` +
            `(remaining=${spend.remaining}); the signed certificate was discarded.`,
          fused,
          subjectSha256,
          decision,
        );
      }
    }

    state.admitted += 1;
    state.spentRisk += risk;
    return {
      accepted: true,
      domain: subject.domain,
      subjectId: subject.subjectId,
      taskId: subject.taskId,
      subjectSha256,
      tier: fused.tier,
      score: fused.score,
      threshold: decision.threshold,
      pCorrect: decision.pCorrectEstimate,
      epsilon: state.epsilon,
      spentRisk: risk,
      verifierVersions: [...fused.verifierVersions],
      certificate,
    };
  }

  private recordAbstention(
    state: DomainState,
    subject: TrustSubject,
    code: AbstentionCode,
    message: string,
    fused?: FusedVerification,
    subjectSha256?: string,
    decision?: GateDecision,
    escalateTo?: TierId,
  ): Admission {
    state.abstained += 1;
    state.abstentionsByCode[code] += 1;
    return {
      accepted: false,
      domain: subject.domain,
      subjectId: subject.subjectId,
      taskId: subject.taskId,
      subjectSha256: subjectSha256 ?? sha256Hex(subject.output),
      tier: fused?.tier ?? "T4-consistency",
      score: fused?.score ?? 0,
      threshold: decision?.threshold ?? state.stats?.threshold ?? Infinity,
      pCorrect: decision?.pCorrectEstimate ?? 0,
      epsilon: state.epsilon,
      spentRisk: 0,
      verifierVersions: fused !== undefined ? [...fused.verifierVersions] : [],
      abstention: escalateTo !== undefined ? { code, message, escalateTo } : { code, message },
    };
  }
}

// ===========================================================================
// Reporting
// ===========================================================================

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Render a `TrustGateReport` as aligned plain ASCII text — CLI/TUI-ready.
 * Never HTML, never markup: this repo's UI is the terminal, not a browser.
 */
export function formatTrustGateReport(r: TrustGateReport): string {
  const domains = (Object.keys(r.perDomain) as TrustDomain[]).sort();
  const headers = ["DOMAIN", "CAL", "ADMIT", "ABSTAIN", "COVERAGE", "SPENT-RISK", "THRESHOLD", "EPSILON"];
  const rows: string[][] = domains.map((domain) => {
    const s = r.perDomain[domain];
    const total = s.admitted + s.abstained;
    const coverage = total > 0 ? s.admitted / total : 0;
    return [
      domain,
      s.calibrated ? "yes" : "no",
      String(s.admitted),
      String(s.abstained),
      coverage.toFixed(3),
      s.spentRisk.toFixed(4),
      s.stats === null ? "-" : Number.isFinite(s.stats.threshold) ? s.stats.threshold.toFixed(4) : "+Inf",
      s.stats === null ? "-" : s.stats.epsilon.toFixed(4),
    ];
  });

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const lines: string[] = [];
  lines.push(headers.map((h, i) => padRight(h, widths[i])).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) lines.push(row.map((c, i) => padRight(c, widths[i])).join("  "));
  lines.push("");
  lines.push(
    `TOTAL  admitted=${r.totalAdmitted}  abstained=${r.totalAbstained}  ` +
      `coverage=${r.coverage.toFixed(4)}  spentRisk=${r.totalSpentRisk.toFixed(4)}`,
  );

  const codeLines: string[] = [];
  for (const domain of domains) {
    const s = r.perDomain[domain];
    const nonzero = (Object.entries(s.abstentionsByCode) as [AbstentionCode, number][]).filter(
      ([, n]) => n > 0,
    );
    if (nonzero.length > 0) {
      codeLines.push(`  ${domain}: ` + nonzero.map(([code, n]) => `${code}=${n}`).join(" "));
    }
  }
  if (codeLines.length > 0) {
    lines.push("");
    lines.push("ABSTENTION CODES");
    lines.push(...codeLines);
  }

  return lines.join("\n");
}
