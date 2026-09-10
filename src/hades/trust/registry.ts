/**
 * Phase 14 spine — the ONE canonical verification shape every subsystem in
 * this repo speaks, plus the registry that selects, runs, and fuses
 * verifiers for a subject.
 *
 * This module is deliberately narrow: it does not know about tools,
 * procedures, memory, or messages (that is the per-domain adapters' job), it
 * does not gate anything (that is the abstention gate's / certificate
 * authority's job), and it does not re-implement label-free reliability
 * estimation — it imports the REAL `WeakVerifierEnsemble` from
 * `../styx/tiers` and defers to it entirely. What lives here is the
 * contract: `TrustSubject` (what is being verified), `UniversalVerifier`
 * (anything that can vote on a subject), `UniversalVerdict` (a single,
 * structurally-safe vote), and `FusedVerification` (many verdicts collapsed
 * into one calibrated signal).
 *
 * ---------------------------------------------------------------------------
 * WHY single-verifier fusion is DEGRADED
 * ---------------------------------------------------------------------------
 * `WeakVerifierEnsemble` estimates each verifier's reliability from
 * INTER-VERIFIER AGREEMENT across many votes — it is a Dawid–Skene fixed
 * point, not a heuristic, and it needs disagreement to have signal. With
 * exactly one contributing (non-abstained) verifier voting on a single
 * subject there is no other vote to agree or disagree with: any "reliability"
 * the ensemble could report is a bootstrap artifact of the algorithm's own
 * 0.5 initialisation, not an empirical estimate. Reporting it as ensemble
 * output would be manufacturing certainty that was never earned. So
 * `VerifierRegistry.verify()` — the single-subject path — refuses to run the
 * ensemble in that case: it hands back the lone verdict's own prior-damped
 * confidence untouched, tags the report `degraded: true,
 * degradedReason: "single-verifier"`, and reports that verifier's registered
 * *prior* (its a-priori trust, not an empirically-estimated reliability) as
 * its weight. `VerifierRegistry.verifyBatch()` is different on purpose: many
 * subjects scored in one `fitPredict` call give the SAME lone verifier other
 * votes elsewhere in the batch to agree or disagree with, so its reliability
 * genuinely can be estimated even though any single item in that batch only
 * has one voter. That is why batching is where the reliability signal lives.
 *
 * ---------------------------------------------------------------------------
 * WHY the WEAKEST tier wins
 * ---------------------------------------------------------------------------
 * `FusedVerification.tier` is not "the best tier anyone reached" — it is the
 * WEAKEST tier among the verifiers that actually contributed a vote. A
 * verification claim is only as strong as its weakest voting link: if a
 * T0-execution oracle and a T4-consistency self-check both vote on the same
 * subject and happen to agree, the fused claim must still be reported at
 * T4-consistency strength, because a downstream reader (the gate, a
 * certificate, an auditor) cannot tell, from `FusedVerification` alone,
 * *which* verifier's evidence is load-bearing for a given subject. Letting
 * the strongest tier "leak upward" through mere co-voting would let a cheap
 * T4 self-agreement check borrow an oracle's credibility for free — exactly
 * the overclaim this module exists to make structurally impossible. The same
 * logic gates individual verdicts: `normalizeVerdict` clamps any verdict that
 * *claims* a stronger tier than its verifier's REGISTERED tier back down to
 * that registered tier, and flags the clamp in `reasons`.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE NOTE (reconciliation)
 * ---------------------------------------------------------------------------
 * A prior stopgap version of this file existed with a different, narrower
 * shape (no `version`/`abstained` on verdicts, no `appliesTo`/`tier`/`prior`
 * on verifiers, no `VerifierRegistry`, no fusion) authored against a spec
 * that predates this file's LOCKED cross-team contract, so that
 * `./action-adapters.ts` and `./emission-adapters.ts` had something to
 * type-import against. This file REPLACES that stopgap with the locked
 * contract; any subsystem adapter still importing the old shape needs a
 * follow-up reconciliation pass (out of scope here — see this cycle's
 * integration notes).
 */

import {
  TIER_ORDER,
  WeakVerifierEnsemble,
  tierConfidenceFloor,
  type TierId,
  type VerifierVote,
  type EnsembleResult,
} from "../styx/tiers";
import { sha256Hex } from "../styx/certificate";

// ===========================================================================
// Public types
// ===========================================================================

/** The four kinds of thing this repo can bind a verification claim to. */
export type TrustDomain = "tool" | "procedure" | "memory" | "message";

/** One step of the execution trace that produced `TrustSubject.output`. */
export interface TrustTraceStep {
  seq: number;
  kind: string;
  detail: string;
}

/**
 * The thing being verified. `output` is the EXACT text a cert binds — not a
 * summary or a pointer to it. `evidence` is untrusted, structured side
 * information a verifier MAY use (retrieved sources, tool return values,
 * rubric text, …); it is never itself proof of anything and no verifier may
 * treat its mere presence as a pass.
 */
export interface TrustSubject {
  domain: TrustDomain;
  /** tool name / procedure id / memory key / channel id */
  subjectId: string;
  taskId: string;
  /** the request that produced the output */
  input: string;
  /** the EXACT text to be delivered/persisted/sent — what a cert binds */
  output: string;
  /** structured side-evidence; never trusted as truth */
  evidence: Readonly<Record<string, unknown>>;
  trace: readonly TrustTraceStep[];
}

/**
 * A single verifier's vote on a `TrustSubject`, after normalization. Every
 * `UniversalVerdict` in the wild was produced by `normalizeVerdict` — never
 * construct one by hand outside this module and expect it to be trusted.
 */
export interface UniversalVerdict extends VerifierVote {
  verifierId: string;
  version: string;
  tier: TierId;
  passed: boolean;
  /** in [0,1]; already clamped and prior-capped. 0 when `abstained`. */
  confidence: number;
  /** machine-readable + human-readable reason codes (never empty on abstain) */
  reasons: string[];
  /** true iff this verdict casts NO vote — never counted as a pass or a fail */
  abstained: boolean;
}

/**
 * Anything that can vote on a `TrustSubject`. `tier` and `prior` are this
 * verifier's REGISTERED ceiling: no verdict it emits may claim a stronger
 * tier, and no verdict's confidence may exceed `prior` — both are enforced
 * by `normalizeVerdict`, not by the verifier's own good behavior.
 */
export interface UniversalVerifier {
  id: string;
  version: string;
  domain: TrustDomain;
  tier: TierId;
  /** a-priori trust ceiling in [0,1]; hard-caps every confidence this verifier emits */
  prior: number;
  /** must return true only for subjects this verifier is actually equipped to judge */
  appliesTo(subject: TrustSubject): boolean;
  verify(subject: TrustSubject): UniversalVerdict | Promise<UniversalVerdict>;
}

/** Many verdicts on one subject, collapsed into one calibrated signal. */
export interface FusedVerification {
  subjectKey: string;
  domain: TrustDomain;
  /** the WEAKEST tier among contributing (non-abstained) verifiers, never the strongest */
  tier: TierId;
  score: number;
  agreement: number;
  weights: Record<string, number>;
  verdicts: UniversalVerdict[];
  verifierVersions: string[];
  abstainedIds: string[];
  degraded: boolean;
  degradedReason?: "no-verifier" | "all-abstained" | "single-verifier";
}

/** Diagnostic explaining why `select()` did or didn't include a verifier. */
export interface SelectionDiagnostic {
  verifier: UniversalVerifier;
  included: boolean;
  reason?: string;
}

// ===========================================================================
// Canonicalization / hashing
// ===========================================================================

/**
 * Deterministic, cert-bindable string encoding of a trace. Each step is
 * JSON-encoded with an EXPLICIT, fixed field order (`seq`, `kind`, `detail`)
 * so the output never depends on how the caller happened to build the step
 * object; the steps are then joined preserving ARRAY order, because trace
 * order is semantically significant (step 1 then step 2 is a different
 * execution than step 2 then step 1) and must never be normalized away.
 *
 * JSON-encoding each field (rather than joining raw strings with a
 * delimiter like `|`) makes this injection-proof: a naive
 * `a + "|" + b` join lets `a="x|y", b="z"` collide with `a="x", b="y|z"`.
 * JSON's quoting/escaping means the two only ever encode to
 * `"x|y"` / `"z"` vs `"x"` / `"y|z"` — texts that cannot collide.
 */
export function canonicalTrace(trace: readonly TrustTraceStep[]): string {
  const steps = Array.isArray(trace) ? trace : [];
  const parts = steps.map((step) =>
    JSON.stringify({
      seq: typeof step?.seq === "number" ? step.seq : null,
      kind: String(step?.kind ?? ""),
      detail: String(step?.detail ?? ""),
    }),
  );
  return `[${parts.join(",")}]`;
}

/**
 * sha256 over a canonical encoding of `subject`. Every field is JSON-encoded
 * individually with an explicit key order (`domain`, `subjectId`, `taskId`,
 * `input`, `output`, `evidence`, `trace`) so distinct subjects can never
 * collide via delimiter-boundary tricks (see `canonicalTrace`). Deliberately
 * UNLIKE `certificate.ts`'s `canonicalize`, this does NOT sort the keys of
 * `evidence` — insertion order is preserved and folded into the hash, so two
 * evidence objects built by inserting the same key/value pairs in a
 * different order hash to DIFFERENT subject keys. That is intentional
 * paranoia for a routing key (it must never silently conflate two callers'
 * distinct construction paths), not a general-purpose equality notion —
 * callers that need order-independent evidence equality must normalize
 * before constructing the `TrustSubject`.
 */
export function subjectKey(subject: TrustSubject): string {
  const encoded = JSON.stringify({
    domain: subject.domain,
    subjectId: subject.subjectId,
    taskId: subject.taskId,
    input: subject.input,
    output: subject.output,
    evidence: safeJson(subject.evidence),
    trace: canonicalTrace(subject.trace),
  });
  return sha256Hex(encoded);
}

/** JSON.stringify guarded against circular references / exotic values. */
function safeJson(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      if (typeof v === "bigint") return `${v.toString()}n`;
      return v;
    });
  } catch {
    return "[unserializable-evidence]";
  }
}

// ===========================================================================
// Verdict normalization
// ===========================================================================

const TIER_SET = new Set<string>(TIER_ORDER);
const VALID_DOMAINS = new Set<string>(["tool", "procedure", "memory", "message"] satisfies TrustDomain[]);

/**
 * Informational base error budget used ONLY to flag (never to reject) a
 * verdict whose confidence is already below the calibrated floor its own
 * tier would need to emit safely (see `tierConfidenceFloor` in
 * `../styx/tiers`). This module does not gate — that is the abstention
 * gate's job — so this never changes `passed`/`abstained`; it only appends
 * a `"below-tier-floor"` reason code so downstream consumers (and the gate)
 * have the signal without this module pretending to act on it.
 */
const SANITY_BASE_EPSILON = 0.1;

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

/** The weakest (highest-index) tier among `tiers`; T4-consistency (the
 *  safest fallback) if `tiers` is empty. */
function weakestTier(tiers: readonly TierId[]): TierId {
  if (tiers.length === 0) return TIER_ORDER[TIER_ORDER.length - 1];
  let worst = 0;
  for (const t of tiers) worst = Math.max(worst, tierIndex(t));
  return TIER_ORDER[worst];
}

function abstainVerdict(source: UniversalVerifier, reasonCode: string, extra: string[] = []): UniversalVerdict {
  return {
    verifierId: source.id,
    version: source.version,
    tier: source.tier,
    passed: false,
    confidence: 0,
    reasons: [reasonCode, ...extra],
    abstained: true,
  };
}

/**
 * Turn an arbitrary (possibly hostile or broken) verifier return value into
 * a trustworthy `UniversalVerdict`. This is the ONE choke point every raw
 * verifier output passes through, and it is adversary-first:
 *
 *  - not an object (null/undefined/primitive)         → abstain, "invalid-verdict-shape"
 *  - explicit `abstained: true`                        → honored as a self-abstain
 *  - `passed` not a boolean                             → abstain, "invalid-passed-field"
 *  - `confidence` not a finite number                   → abstain, "non-finite-confidence"
 *  - `confidence` outside [0,1]                         → abstain, "confidence-out-of-range"
 *  - `confidence` finite & in-range but > `source.prior` → CLAMPED to `prior`, reason appended
 *  - `tier` claims a STRONGER tier than `source.tier`    → CLAMPED down, reason appended
 *  - `tier` missing/invalid/weaker-or-equal              → used/kept as reported (or `source.tier`)
 *
 * A malformed or overclaiming verdict is NEVER counted as a pass: it is
 * either abstained outright, or clamped and still passed/failed as reported
 * but at a truthful strength.
 */
export function normalizeVerdict(v: unknown, source: UniversalVerifier): UniversalVerdict {
  if (v === null || v === undefined || typeof v !== "object") {
    return abstainVerdict(source, "invalid-verdict-shape");
  }
  const raw = v as Record<string, unknown>;
  const reasonsRaw = Array.isArray(raw.reasons) ? raw.reasons.filter((r): r is string => typeof r === "string") : [];

  // Resolve the effective tier first so it is set consistently on every path
  // (abstain or not) — a claimed tier is clamped down if it overclaims the
  // verifier's REGISTERED ceiling, and used as-is otherwise.
  let tier = source.tier;
  const tierReasons: string[] = [];
  if (typeof raw.tier === "string" && TIER_SET.has(raw.tier)) {
    const claimed = raw.tier as TierId;
    if (tierIndex(claimed) < tierIndex(source.tier)) {
      tierReasons.push(`tier-overclaim-clamped:${claimed}->${source.tier}`);
      tier = source.tier;
    } else {
      tier = claimed;
    }
  }

  if (raw.abstained === true) {
    return {
      verifierId: source.id,
      version: source.version,
      tier,
      passed: false,
      confidence: 0,
      reasons: [...reasonsRaw, ...tierReasons, "verifier-self-abstained"],
      abstained: true,
    };
  }

  if (typeof raw.passed !== "boolean") {
    return abstainVerdict(source, "invalid-passed-field", [...reasonsRaw, ...tierReasons]);
  }

  const confidenceRaw = raw.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) {
    return abstainVerdict(source, "non-finite-confidence", [...reasonsRaw, ...tierReasons]);
  }
  if (confidenceRaw < 0 || confidenceRaw > 1) {
    return abstainVerdict(source, "confidence-out-of-range", [...reasonsRaw, ...tierReasons]);
  }

  const prior = clamp01(Number.isFinite(source.prior) ? source.prior : 0);
  const reasons = [...reasonsRaw, ...tierReasons];
  let confidence = confidenceRaw;
  if (confidence > prior) {
    confidence = prior;
    reasons.push("confidence-capped-by-prior");
  }
  if (confidence < tierConfidenceFloor(tier, SANITY_BASE_EPSILON)) {
    reasons.push("below-tier-floor");
  }

  return {
    verifierId: source.id,
    version: source.version,
    tier,
    passed: raw.passed,
    confidence,
    reasons,
    abstained: false,
  };
}

// ===========================================================================
// Per-verifier execution (timeout + throw safe)
// ===========================================================================

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Run one verifier against one subject with full adversary-first isolation:
 * a synchronous throw, a rejected promise, or a promise that never settles
 * within `timeoutMs` all resolve to an abstain verdict — never a thrown
 * exception, never a silent pass. Uses a real timer raced against the
 * verifier's promise (fake timers in tests fast-forward it deterministically
 * without any real sleeping).
 */
async function runVerifier(
  verifier: UniversalVerifier,
  subject: TrustSubject,
  timeoutMs: number,
): Promise<UniversalVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<UniversalVerdict>((resolve) => {
    timer = setTimeout(() => resolve(abstainVerdict(verifier, "verifier-timeout")), timeoutMs);
    const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") maybeUnref.call(timer);
  });

  const ran = (async (): Promise<UniversalVerdict> => {
    try {
      const result = await verifier.verify(subject);
      return normalizeVerdict(result, verifier);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return abstainVerdict(verifier, "verifier-threw", [message.slice(0, 200)]);
    }
  })();

  try {
    return await Promise.race([ran, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ===========================================================================
// Registry
// ===========================================================================

/** `^[a-z0-9]` then 1-127 more of `[a-z0-9._-]` — 2 to 128 chars total. */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;

export interface VerifyOpts {
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Selects, runs, and fuses `UniversalVerifier`s for a `TrustSubject`.
 *
 * Registration is append-only and integrity-checked: ids must match
 * `ID_PATTERN`, re-registering the identical (id, version) pair is an
 * idempotent no-op (safe under double-init/hot-reload), but re-registering
 * an id under a DIFFERENT version is a hard error — there is no silent
 * last-write-wins that could quietly downgrade a verifier's calibration.
 */
export class VerifierRegistry {
  private readonly verifiers = new Map<string, UniversalVerifier>();
  private lastEnsemble: WeakVerifierEnsemble | null = null;

  register(v: UniversalVerifier): void {
    if (!v || typeof v !== "object") {
      throw new TypeError("VerifierRegistry.register: verifier must be an object");
    }
    if (typeof v.id !== "string" || !ID_PATTERN.test(v.id)) {
      throw new RangeError(
        `VerifierRegistry.register: invalid verifier id ${JSON.stringify(v.id)} — ids must match ${ID_PATTERN}`,
      );
    }
    if (typeof v.version !== "string" || v.version.length === 0) {
      throw new TypeError(`VerifierRegistry.register: verifier "${v.id}" is missing a version string`);
    }
    if (!VALID_DOMAINS.has(v.domain)) {
      throw new TypeError(`VerifierRegistry.register: verifier "${v.id}" has invalid domain ${JSON.stringify(v.domain)}`);
    }
    if (!TIER_SET.has(v.tier)) {
      throw new TypeError(`VerifierRegistry.register: verifier "${v.id}" has invalid tier ${JSON.stringify(v.tier)}`);
    }
    if (typeof v.prior !== "number" || !Number.isFinite(v.prior) || v.prior < 0 || v.prior > 1) {
      throw new RangeError(
        `VerifierRegistry.register: verifier "${v.id}" has an invalid prior (${String(v.prior)}); prior must be a finite number in [0,1]`,
      );
    }
    if (typeof v.appliesTo !== "function" || typeof v.verify !== "function") {
      throw new TypeError(`VerifierRegistry.register: verifier "${v.id}" must implement appliesTo() and verify()`);
    }

    const existing = this.verifiers.get(v.id);
    if (existing) {
      if (existing.version !== v.version) {
        throw new Error(
          `VerifierRegistry.register: duplicate id "${v.id}" registered with conflicting version ` +
            `(existing "${existing.version}" vs new "${v.version}")`,
        );
      }
      return; // identical (id, version) re-registration: idempotent no-op
    }
    this.verifiers.set(v.id, v);
  }

  registerAll(vs: Iterable<UniversalVerifier>): void {
    for (const v of vs) this.register(v);
  }

  has(id: string): boolean {
    return this.verifiers.has(id);
  }

  /** Deterministic order: sorted by `id`. */
  list(domain?: TrustDomain): UniversalVerifier[] {
    const all = [...this.verifiers.values()].filter((v) => domain === undefined || v.domain === domain);
    return all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  calibration(): Record<string, { tier: TierId; prior: number; domain: TrustDomain }> {
    const out: Record<string, { tier: TierId; prior: number; domain: TrustDomain }> = {};
    for (const v of this.list()) out[v.id] = { tier: v.tier, prior: v.prior, domain: v.domain };
    return out;
  }

  /**
   * Every registered verifier's inclusion/exclusion reasoning for `subject`,
   * in deterministic (`id`-sorted) order. A verifier is excluded — never
   * silently run — if `appliesTo` throws, if it does not apply, or if it
   * claims the subject (`appliesTo` → true) while its REGISTERED `domain`
   * disagrees with `subject.domain`: a mismatched domain claim is a
   * misconfigured or adversarial verifier, not something to trust.
   */
  selectWithDiagnostics(subject: TrustSubject): SelectionDiagnostic[] {
    const out: SelectionDiagnostic[] = [];
    for (const verifier of this.list()) {
      let applies: boolean;
      try {
        applies = verifier.appliesTo(subject);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out.push({ verifier, included: false, reason: `appliesTo-threw:${message.slice(0, 120)}` });
        continue;
      }
      if (!applies) {
        out.push({ verifier, included: false, reason: "not-applicable" });
        continue;
      }
      if (verifier.domain !== subject.domain) {
        out.push({
          verifier,
          included: false,
          reason: `domain-mismatch:verifier=${verifier.domain},subject=${subject.domain}`,
        });
        continue;
      }
      out.push({ verifier, included: true });
    }
    return out;
  }

  /** Deterministic (`id`-sorted) list of verifiers eligible for `subject`. */
  select(subject: TrustSubject): UniversalVerifier[] {
    return this.selectWithDiagnostics(subject)
      .filter((d) => d.included)
      .map((d) => d.verifier);
  }

  /**
   * Verify a single subject. With zero selected verifiers or zero
   * contributing (non-abstained) verdicts, this returns a neutral
   * (score 0.5) degraded report. With exactly one contributing verdict it
   * returns that verdict's own prior-damped confidence, degraded
   * (`"single-verifier"`) — see the module doc for why. With two or more
   * contributing verdicts it runs the REAL `WeakVerifierEnsemble` on this
   * one subject and is not degraded.
   */
  async verify(subject: TrustSubject, opts?: VerifyOpts): Promise<FusedVerification> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const selected = this.select(subject);
    const verdicts = await Promise.all(selected.map((v) => runVerifier(v, subject, timeoutMs)));
    const contributing = verdicts.filter((v) => !v.abstained);

    let score: number;
    let agreement: number;
    let weights: Record<string, number>;
    let degraded: boolean;
    let degradedReason: FusedVerification["degradedReason"];

    if (selected.length === 0) {
      degraded = true;
      degradedReason = "no-verifier";
      score = 0.5;
      agreement = 0.5;
      weights = {};
    } else if (contributing.length === 0) {
      degraded = true;
      degradedReason = "all-abstained";
      score = 0.5;
      agreement = 0.5;
      weights = {};
    } else if (contributing.length === 1) {
      degraded = true;
      degradedReason = "single-verifier";
      const solo = contributing[0];
      score = solo.confidence;
      agreement = solo.passed ? 1 : 0;
      const soloPrior = this.verifiers.get(solo.verifierId)?.prior ?? 0;
      weights = { [solo.verifierId]: clamp01(soloPrior) };
    } else {
      const ensemble = new WeakVerifierEnsemble();
      const votes: VerifierVote[][] = [contributing.map((v) => ({ verifierId: v.verifierId, passed: v.passed }))];
      const [result]: EnsembleResult[] = ensemble.fitPredict(votes);
      this.lastEnsemble = ensemble;
      score = result.score;
      agreement = result.agreement;
      weights = result.weights;
      degraded = false;
    }

    const tier =
      contributing.length === 0 ? weakestTier(verdicts.map((v) => v.tier)) : weakestTier(contributing.map((v) => v.tier));

    return {
      subjectKey: subjectKey(subject),
      domain: subject.domain,
      tier,
      score,
      agreement,
      weights,
      verdicts,
      verifierVersions: verdicts.map((v) => `${v.verifierId}@${v.version}`),
      abstainedIds: verdicts.filter((v) => v.abstained).map((v) => v.verifierId),
      degraded,
      degradedReason,
    };
  }

  /**
   * Verify many subjects with ONE real `WeakVerifierEnsemble.fitPredict`
   * call across the whole batch — this is where reliability estimation has
   * signal, because the same verifier voting on multiple items gives the
   * ensemble something to check its votes against. A subject with only one
   * contributing verifier in the batch is therefore NOT forced into
   * `"single-verifier"` degradation the way single-subject `verify()` is:
   * its lone voter's reliability may still be genuinely informed by that
   * voter's OTHER votes elsewhere in the batch.
   */
  async verifyBatch(subjects: readonly TrustSubject[], opts?: VerifyOpts): Promise<FusedVerification[]> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const perSubject = await Promise.all(
      subjects.map(async (subject) => {
        const selected = this.select(subject);
        const verdicts = await Promise.all(selected.map((v) => runVerifier(v, subject, timeoutMs)));
        return { subject, selected, verdicts };
      }),
    );

    const votes: VerifierVote[][] = perSubject.map(({ verdicts }) =>
      verdicts.filter((v) => !v.abstained).map((v) => ({ verifierId: v.verifierId, passed: v.passed })),
    );

    const ensemble = new WeakVerifierEnsemble();
    const results: EnsembleResult[] = ensemble.fitPredict(votes);
    this.lastEnsemble = ensemble;

    return perSubject.map(({ subject, selected, verdicts }, i) => {
      const contributing = verdicts.filter((v) => !v.abstained);
      const degradedReason: FusedVerification["degradedReason"] =
        selected.length === 0 ? "no-verifier" : contributing.length === 0 ? "all-abstained" : undefined;
      const tier =
        contributing.length === 0
          ? weakestTier(verdicts.map((v) => v.tier))
          : weakestTier(contributing.map((v) => v.tier));
      const result = results[i];

      return {
        subjectKey: subjectKey(subject),
        domain: subject.domain,
        tier,
        score: result.score,
        agreement: result.agreement,
        weights: result.weights,
        verdicts,
        verifierVersions: verdicts.map((v) => `${v.verifierId}@${v.version}`),
        abstainedIds: verdicts.filter((v) => v.abstained).map((v) => v.verifierId),
        degraded: degradedReason !== undefined,
        degradedReason,
      };
    });
  }

  /**
   * The reliabilities learned by the most recent `verify`/`verifyBatch` call
   * that actually ran the ensemble (two-plus contributing verifiers for
   * `verify`, always for `verifyBatch`). Empty if no ensemble has run yet.
   */
  reliabilities(): Record<string, number> {
    return this.lastEnsemble ? this.lastEnsemble.reliabilities() : {};
  }
}
