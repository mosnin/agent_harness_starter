/**
 * `src/hades/trust/emission-adapters.ts` — adapts every EMISSION-side
 * verifier into the shared `UniversalVerifier` shape from `./registry.ts`:
 * two REAL wrapped subsystem verifiers (memory-write contradiction
 * detection, the independent user-model auditor) plus two NEW,
 * self-contained deterministic verifiers for the two domains this build had
 * no verifier for at all — outbound messages and procedure executions.
 *
 * ---------------------------------------------------------------------------
 * Non-negotiable discipline
 * ---------------------------------------------------------------------------
 * The two WRAPPED adapters never re-score, re-derive, or raise a tier/prior:
 * `memoryWriteVerifier()`'s tier/prior are read verbatim from the REAL
 * `memoryWriteCalibration()` in `../memory/guard.ts`; `userModelVerifier()`'s
 * from the REAL `userModelCalibration()` in `../memory/user-model-verifier.ts`.
 * The underlying `verifyMemoryWrite`/`auditUserModel` functions are the REAL
 * shipped implementations — this file calls them, it does not reimplement or
 * mock them.
 *
 * The two NEW adapters (`outboundMessageVerifier()`, `procedureRunVerifier()`)
 * are self-contained deterministic checkers built directly against the real
 * cryptographic primitives in `../styx/certificate.ts` (`sha256Hex`,
 * `verifyCertificate`, `certifiesOutput`) — see each function's own TSDoc for
 * its check list, reason-code vocabulary, and calibration justification.
 *
 * `./action-adapters.ts` and this file never import from each other.
 *
 * ---------------------------------------------------------------------------
 * `TrustSubject` field mapping this file uses
 * ---------------------------------------------------------------------------
 * `TrustSubject.output` is documented in `./registry.ts` as "the EXACT text
 * to be delivered/persisted/sent — what a cert binds". This file follows
 * that contract literally for every emission domain: the text actually being
 * emitted (a memory fact, an outbound message body, a procedure's claimed
 * result) is always read from `subject.output`, never `subject.input`
 * (`input` is the request that produced it, which none of these four
 * verifiers need).
 *
 * `memoryWriteVerifier()`  domain "memory"
 *   subject.output                       the candidate fact text
 *   subject.evidence.existingRecords     `MemoryRecord[]` to check against
 *   subject.evidence.salienceFloor?      optional override (see `guard.ts`)
 *
 * `userModelVerifier()`  domain "memory"
 *   subject.evidence.model               a `DialecticUserModel` (duck-typed:
 *                                        only `.all()` is ever called on it,
 *                                        matching the real auditor's own
 *                                        independence discipline)
 *   subject.evidence.ledger?             an `EvidenceLedger` to cross-check
 *   subject.evidence.assertFloor?        optional override
 *   subject.evidence.now?                optional reference instant
 *
 * `outboundMessageVerifier()`  domain "message"
 *   subject.output                       the message body text
 *   subject.evidence.citedCertificates?  `VerificationCertificate[]` the
 *                                        message cites as backing evidence
 *                                        (default: `[]` — a message that
 *                                        cites nothing and claims nothing is
 *                                        a legitimate, passing subject)
 *
 * `procedureRunVerifier()`  domain "procedure"
 *   subject.output                       the claimed final output text
 *   subject.trace                        the REAL `TrustTraceStep[]` from
 *                                        `./registry.ts` — the steps
 *                                        actually present in the execution
 *                                        record, in execution order. This
 *                                        file's convention: `step.kind` is
 *                                        the step's NAME (matched against
 *                                        `evidence.declaredSteps`) and
 *                                        `step.detail` is that step's output
 *                                        text.
 *   subject.evidence.declaredSteps       `string[]` — the step names the
 *                                        procedure declared it would run, in
 *                                        order
 *   subject.evidence.toolStepNames?      `string[]` — the subset of declared
 *                                        names that are TOOL invocations
 *                                        (require a provenance binding);
 *                                        default `[]`
 *   subject.evidence.stepProvenance?     `(ProcedureStepProvenance|null)[]`,
 *                                        positionally aligned with
 *                                        `subject.trace` by array index;
 *                                        default `[]` (every tool step then
 *                                        reports provenance-missing)
 *
 * Absent or wrong-typed required evidence always ABSTAINS
 * (`passed:false, confidence:0, abstained:true`, a documented reason code)
 * — never a fabricated pass, never a thrown error.
 */

import { verifyMemoryWrite, memoryWriteCalibration, type MemoryWriteVerdict } from "../memory/guard";
import type { MemoryRecord } from "../memory/store";
import { auditUserModel, userModelCalibration, type BeliefAuditFinding } from "../memory/user-model-verifier";
import type { DialecticUserModel } from "../memory/user-model";
import type { EvidenceLedger } from "../memory/belief-evidence";
import { sha256Hex, verifyCertificate, certifiesOutput, type VerificationCertificate } from "../styx/certificate";
import type { TierId } from "../styx/tiers";
import type { TrustSubject, TrustTraceStep, UniversalVerdict, UniversalVerifier } from "./registry";

export const EMISSION_ADAPTER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Abstain — never fabricate a pass, never throw. */
function abstain(source: UniversalVerifier, reason: string): UniversalVerdict {
  return {
    verifierId: source.id,
    version: source.version,
    tier: source.tier,
    passed: false,
    confidence: 0,
    reasons: [reason],
    abstained: true,
  };
}

// ===========================================================================
// memoryWriteVerifier — wraps the REAL verifyMemoryWrite (../memory/guard.ts)
// ===========================================================================

const MEMORY_WRITE_VERIFIER_ID = "verify.memory-write";

function isMemoryRecordArray(x: unknown): x is MemoryRecord[] {
  if (!Array.isArray(x)) return false;
  return x.every(
    (r) =>
      r !== null &&
      typeof r === "object" &&
      typeof (r as { id?: unknown }).id === "string" &&
      typeof (r as { fact?: unknown }).fact === "string" &&
      typeof (r as { salience?: unknown }).salience === "number",
  );
}

/**
 * Adapts the REAL `verifyMemoryWrite` (deterministic lexical contradiction
 * detection) into a `UniversalVerifier`. `passed`/`confidence`/`reasons` are
 * copied verbatim from the real `MemoryWriteVerdict` — this adapter performs
 * no detection logic of its own. `tier`/`prior` are read verbatim from the
 * real `memoryWriteCalibration()`.
 */
export function memoryWriteVerifier(): UniversalVerifier {
  const calibration = memoryWriteCalibration();

  const source: UniversalVerifier = {
    id: MEMORY_WRITE_VERIFIER_ID,
    version: EMISSION_ADAPTER_VERSION,
    domain: "memory",
    tier: calibration.tier,
    prior: clamp01(calibration.prior),
    appliesTo(subject: TrustSubject): boolean {
      return !!subject && subject.domain === "memory" && Array.isArray(subject.evidence?.existingRecords);
    },
    verify(subject: TrustSubject): UniversalVerdict {
      if (!subject || subject.domain !== "memory") {
        return abstain(source, "SUBJECT_DOMAIN_MISMATCH");
      }
      if (typeof subject.output !== "string") {
        return abstain(source, "OUTPUT_NOT_STRING");
      }
      const existingRecords = subject.evidence ? subject.evidence.existingRecords : undefined;
      if (!isMemoryRecordArray(existingRecords)) {
        return abstain(source, "EXISTING_RECORDS_MISSING_OR_INVALID");
      }
      const salienceFloorRaw = subject.evidence.salienceFloor;
      const opts =
        typeof salienceFloorRaw === "number" && Number.isFinite(salienceFloorRaw)
          ? { salienceFloor: salienceFloorRaw }
          : undefined;

      const verdict: MemoryWriteVerdict = verifyMemoryWrite(subject.output, existingRecords, opts);
      return {
        verifierId: source.id,
        version: source.version,
        tier: source.tier,
        passed: verdict.passed,
        confidence: clamp01(verdict.confidence),
        reasons: [...verdict.reasons],
        abstained: false,
      };
    },
  };
  return source;
}

// ===========================================================================
// userModelVerifier — wraps the REAL auditUserModel (../memory/user-model-verifier.ts)
// ===========================================================================

const USER_MODEL_VERIFIER_ID = "verify.user-model";

const AUDIT_FINDING_KIND_ORDER: readonly BeliefAuditFinding["kind"][] = [
  "confidence-exceeds-evidence",
  "asserted-below-floor",
  "asserted-while-contested",
  "evidence-hash-mismatch",
  "invalid-certificate-trusted",
  "ledger-mismatch",
];

function isDialecticUserModelLike(x: unknown): x is DialecticUserModel {
  return x !== null && typeof x === "object" && typeof (x as { all?: unknown }).all === "function";
}

/**
 * Adapts the REAL `auditUserModel` (an independent structural/cryptographic
 * auditor over a `DialecticUserModel` snapshot) into a `UniversalVerifier`.
 * `passed`/`confidence` are copied verbatim from the real
 * `UserModelAuditReport`. `reasons` is DERIVED (this report's own shape has
 * no `reasons: string[]` field, only a `findings[]` array) into the fixed
 * `AUDIT_FINDING_KIND_ORDER`, one `audit.<kind>` code per distinct finding
 * kind present — mirroring `../tools/verifiers.ts`'s reasons-code
 * convention without inventing any new pass/fail judgment: every code
 * present corresponds 1:1 to a finding the real auditor actually produced.
 * `tier`/`prior` are read verbatim from the real `userModelCalibration()`.
 *
 * Async, matching the real `auditUserModel`'s own signature (it awaits
 * `verifyCertificate` per evidence item).
 */
export function userModelVerifier(): UniversalVerifier {
  const calibration = userModelCalibration();

  const source: UniversalVerifier = {
    id: USER_MODEL_VERIFIER_ID,
    version: EMISSION_ADAPTER_VERSION,
    domain: "memory",
    tier: calibration.tier,
    prior: clamp01(calibration.prior),
    appliesTo(subject: TrustSubject): boolean {
      return !!subject && subject.domain === "memory" && isDialecticUserModelLike(subject.evidence?.model);
    },
    async verify(subject: TrustSubject): Promise<UniversalVerdict> {
      if (!subject || subject.domain !== "memory") {
        return abstain(source, "SUBJECT_DOMAIN_MISMATCH");
      }
      const model = subject.evidence ? subject.evidence.model : undefined;
      if (!isDialecticUserModelLike(model)) {
        return abstain(source, "MODEL_MISSING_OR_INVALID");
      }
      const ledgerRaw = subject.evidence.ledger;
      const ledger = ledgerRaw instanceof Object ? (ledgerRaw as EvidenceLedger) : undefined;
      const assertFloorRaw = subject.evidence.assertFloor;
      const assertFloor = typeof assertFloorRaw === "number" && Number.isFinite(assertFloorRaw) ? assertFloorRaw : undefined;
      const nowRaw = subject.evidence.now;
      const now = typeof nowRaw === "number" && Number.isFinite(nowRaw) ? nowRaw : undefined;

      const report = await auditUserModel(model, { ledger, assertFloor, now });
      const kindsPresent = new Set(report.findings.map((f) => f.kind));
      const reasons = AUDIT_FINDING_KIND_ORDER.filter((k) => kindsPresent.has(k)).map((k) => `audit.${k}`);

      return {
        verifierId: source.id,
        version: source.version,
        tier: source.tier,
        passed: report.passed,
        confidence: clamp01(report.confidence),
        reasons,
        abstained: false,
      };
    },
  };
  return source;
}

// ===========================================================================
// outboundMessageVerifier — NEW, self-contained. domain "message".
// ===========================================================================

const OUTBOUND_MESSAGE_VERIFIER_ID = "verify.outbound-message";

/**
 * A citation marker wraps a span of message text the message presents as
 * independently verified: `[[verified:N]]...exact span...[[/verified]]`,
 * where `N` is a zero-based index into `evidence.citedCertificates`. The
 * wrapped span must, byte-for-byte, be the SAME text a real Verification
 * Certificate at that index actually certifies (`certifiesOutput`) — a
 * paraphrase, a superset, or a subset does not match, by design: this
 * verifier proves binding, not semantic equivalence.
 */
const CITATION_MARKER_SOURCE = String.raw`\[\[verified:(\d+)\]\]([\s\S]*?)\[\[\/verified\]\]`;

/**
 * A FRESH sticky-free global matcher per call. This must never be a shared
 * module-level `RegExp`: `outboundMessageVerifier().verify()` is async and
 * `await`s `certifiesOutput` INSIDE its `exec` loop, so two concurrent
 * verifications (exactly what `VerifierRegistry.verifyBatch` does — it
 * `Promise.all`s every subject) would interleave on one shared object's
 * `lastIndex` and silently skip or re-scan markers. A skipped marker is a
 * missed `CITED_SPAN_HASH_MISMATCH`, i.e. a fabricated pass — precisely the
 * failure this verifier exists to prevent.
 */
function citationMarkerMatcher(): RegExp {
  return new RegExp(CITATION_MARKER_SOURCE, "gi");
}

/** Free-text trust-claim vocabulary. Deliberately narrow (word-boundary
 *  matches only) — this is a keyword scan, not an NLP claim detector; see
 *  the calibration TSDoc below for the honest limitation this implies. */
const TRUST_CLAIM_RE = /\b(verified|confirmed)\b/i;

const OUTBOUND_MESSAGE_REASON_ORDER = [
  "TRUST_CLAIM_WITHOUT_CITATION",
  "CITATION_INDEX_OUT_OF_RANGE",
  "CITED_CERTIFICATE_INVALID",
  "CITED_SPAN_HASH_MISMATCH",
] as const;

function isCertificateArray(x: unknown): x is VerificationCertificate[] {
  if (!Array.isArray(x)) return false;
  return x.every(
    (c) =>
      c !== null &&
      typeof c === "object" &&
      typeof (c as { signature?: unknown }).signature === "string" &&
      typeof (c as { publicKey?: unknown }).publicKey === "string" &&
      (c as { payload?: unknown }).payload !== null &&
      typeof (c as { payload?: unknown }).payload === "object",
  );
}

/**
 * This adapter's honest tier + calibrated prior.
 *
 * The core binding check — re-verifying an ed25519 signature and recomputing
 * a sha256 to test `outputSha256` equality — is EXACT, deterministic
 * cryptographic recomputation, the same class of decisive check as
 * `../memory/user-model-verifier.ts`'s `userModelCalibration()` (0.65) and
 * `./action-adapters.ts`'s `execProvenanceCalibration()` (0.7). But this
 * verifier ALSO layers a free-text keyword scan (`TRUST_CLAIM_RE`) on top,
 * to catch the "asserts verified with nothing cited" anti-fabrication case —
 * and that layer is comparatively weak: a real trust claim phrased without
 * the literal words "verified"/"confirmed" is a false negative this scan
 * cannot see, exactly the same honest limitation
 * `../tools/verifiers.ts`'s `vision_describe` banned-word scan (prior 0.4,
 * the weakest in the documented T4 range) documents for its own keyword
 * approach. The prior (0.6) sits mid-pack: below the pure-cryptographic
 * checks because of that keyword-scan weak spot, and set equal to
 * `memoryWriteCalibration()`'s 0.6 — both combine one exact/structural leg
 * with one fuzzy lexical leg, and neither should overclaim the other. Never
 * above the highest existing T4 prior (`backendsFleetCalibration()`, 0.72).
 */
export function outboundMessageCalibration(): { tier: TierId; prior: number } {
  return { tier: "T4-consistency", prior: 0.6 };
}

/**
 * Self-contained, deterministic outbound-message verifier — the
 * anti-fabrication check this build had no verifier for at all.
 *
 * Checks (all always evaluated; `reasons` lists every failed code, in
 * `OUTBOUND_MESSAGE_REASON_ORDER`):
 *
 *  1. `TRUST_CLAIM_WITHOUT_CITATION` — the message body matches
 *     `TRUST_CLAIM_RE` (contains "verified"/"confirmed") while
 *     `evidence.citedCertificates` is empty. A message that neither claims
 *     nor cites anything passes cleanly; a message that claims WITHOUT
 *     citing anything is the hard anti-fabrication failure this verifier
 *     exists to catch.
 *  2. `CITATION_INDEX_OUT_OF_RANGE` — any `[[verified:N]]` marker's `N` is
 *     not a valid index into `citedCertificates`.
 *  3. `CITED_CERTIFICATE_INVALID` — any certificate in `citedCertificates`
 *     fails REAL ed25519 signature re-verification (`verifyCertificate`) —
 *     catches a tampered payload field directly, regardless of whether a
 *     marker references it.
 *  4. `CITED_SPAN_HASH_MISMATCH` — any `[[verified:N]]span[[/verified]]`
 *     marker's span does not hash-match certificate `N`'s bound output
 *     (`certifiesOutput`) — catches a certificate that is genuinely valid
 *     for a DIFFERENT output being pasted alongside a new, uncertified
 *     claim, and catches prompt-injection text that introduces a citation
 *     marker with no real binding behind it (an out-of-range or
 *     non-matching index always fails one of checks 2-4 above; there is no
 *     marker syntax this verifier trusts without independently
 *     re-deriving the hash/signature match itself).
 *
 * `evidence.citedCertificates` defaults to `[]` when absent (a message that
 * cites nothing is a legitimate subject, not missing evidence) but ABSTAINS
 * with `CITED_CERTIFICATES_MALFORMED` if present with the wrong type.
 * `subject.output` not being a string ABSTAINS with `OUTPUT_NOT_STRING`.
 *
 * Confidence: this is exact cryptographic/hash recomputation plus a
 * deterministic regex scan — a finding is a proven mismatch, not a
 * probabilistic estimate, so `confidence` is the calibrated prior on a
 * clean pass and `0` on any failure (the same style
 * `userModelCalibration()`'s auditor uses), never fractionally damped.
 */
export function outboundMessageVerifier(): UniversalVerifier {
  const calibration = outboundMessageCalibration();

  const source: UniversalVerifier = {
    id: OUTBOUND_MESSAGE_VERIFIER_ID,
    version: EMISSION_ADAPTER_VERSION,
    domain: "message",
    tier: calibration.tier,
    prior: clamp01(calibration.prior),
    appliesTo(subject: TrustSubject): boolean {
      return !!subject && subject.domain === "message";
    },
    async verify(subject: TrustSubject): Promise<UniversalVerdict> {
      if (!subject || subject.domain !== "message") {
        return abstain(source, "SUBJECT_DOMAIN_MISMATCH");
      }
      if (typeof subject.output !== "string") {
        return abstain(source, "OUTPUT_NOT_STRING");
      }
      const rawCerts = subject.evidence ? subject.evidence.citedCertificates : undefined;
      let citedCertificates: VerificationCertificate[];
      if (rawCerts === undefined) {
        citedCertificates = [];
      } else if (isCertificateArray(rawCerts)) {
        citedCertificates = rawCerts;
      } else {
        return abstain(source, "CITED_CERTIFICATES_MALFORMED");
      }

      const message = subject.output;
      const failed = new Set<string>();

      if (TRUST_CLAIM_RE.test(message) && citedCertificates.length === 0) {
        failed.add("TRUST_CLAIM_WITHOUT_CITATION");
      }

      // Check 3: every cited certificate's own signature, independent of
      // whether any marker references it.
      for (const cert of citedCertificates) {
        if (!(await verifyCertificate(cert))) {
          failed.add("CITED_CERTIFICATE_INVALID");
          break;
        }
      }

      // Checks 2 + 4: every marker in the message body. The whole scan is
      // done SYNCHRONOUSLY first (into a plain array) and only then awaited
      // over, so no `await` ever suspends the loop while a RegExp's
      // `lastIndex` is mid-flight — see `citationMarkerMatcher()`.
      const markers: { idx: number; span: string }[] = [];
      const matcher = citationMarkerMatcher();
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(message)) !== null) {
        markers.push({ idx: Number.parseInt(match[1], 10), span: match[2] });
        if (match[0].length === 0) matcher.lastIndex++; // zero-width guard
      }
      for (const marker of markers) {
        if (!Number.isInteger(marker.idx) || marker.idx < 0 || marker.idx >= citedCertificates.length) {
          failed.add("CITATION_INDEX_OUT_OF_RANGE");
          continue;
        }
        const cert = citedCertificates[marker.idx];
        if (!(await certifiesOutput(cert, marker.span))) {
          failed.add("CITED_SPAN_HASH_MISMATCH");
        }
      }

      const reasons = OUTBOUND_MESSAGE_REASON_ORDER.filter((c) => failed.has(c));
      const passed = reasons.length === 0;

      return {
        verifierId: source.id,
        version: source.version,
        tier: source.tier,
        passed,
        confidence: passed ? clamp01(calibration.prior) : 0,
        reasons,
        abstained: false,
      };
    },
  };
  return source;
}

// ===========================================================================
// procedureRunVerifier — NEW, self-contained. domain "procedure".
// ===========================================================================

const PROCEDURE_RUN_VERIFIER_ID = "verify.procedure-run";

/** Provenance binding for one tool step, positionally aligned with
 *  `subject.trace` by array index (see module docstring). This verifier
 *  recomputes both hashes itself — it never trusts the stored hex strings on
 *  faith. `outputSha256` is checked against the trace step's OWN `detail`
 *  (what the trace claims that step produced), binding the two together;
 *  `inputSha256` is checked against `input` for the provenance record's own
 *  internal self-consistency. */
export interface ProcedureStepProvenance {
  input: string;
  inputSha256: string;
  outputSha256: string;
}

const PROCEDURE_REASON_ORDER = [
  "PHANTOM_STEP",
  "STEP_COUNT_MISMATCH",
  "STEP_ORDER_MISMATCH",
  "TOOL_STEP_PROVENANCE_MISSING",
  "TOOL_STEP_PROVENANCE_HASH_MISMATCH",
  "CLAIMED_OUTPUT_NOT_FROM_LAST_STEP",
] as const;

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}

function isTraceStepArray(x: unknown): x is TrustTraceStep[] {
  if (!Array.isArray(x)) return false;
  return x.every(
    (s) =>
      s !== null &&
      typeof s === "object" &&
      typeof (s as { seq?: unknown }).seq === "number" &&
      typeof (s as { kind?: unknown }).kind === "string" &&
      typeof (s as { detail?: unknown }).detail === "string",
  );
}

function isProvenanceEntry(x: unknown): x is ProcedureStepProvenance {
  return (
    x !== null &&
    typeof x === "object" &&
    typeof (x as { input?: unknown }).input === "string" &&
    typeof (x as { inputSha256?: unknown }).inputSha256 === "string" &&
    typeof (x as { outputSha256?: unknown }).outputSha256 === "string"
  );
}

function isProvenanceArray(x: unknown): x is (ProcedureStepProvenance | null | undefined)[] {
  return Array.isArray(x) && x.every((e) => e === null || e === undefined || isProvenanceEntry(e));
}

/**
 * This adapter's honest tier + calibrated prior.
 *
 * Every check this verifier runs is EXACT: a positional name comparison
 * against the declared step list, a sha256 recomputation (`sha256Hex` from
 * `../styx/certificate.ts`) against a claimed provenance hash, and a
 * string-equality check that the claimed output IS the trace's last step's
 * output. None of it is a probabilistic estimate — a failure is a proven
 * structural mismatch, exactly the class of check
 * `./action-adapters.ts`'s `execProvenanceCalibration()` (0.7) and
 * `../backends/verifier.ts`'s `backendsFleetCalibration()` (0.72, the
 * highest existing T4 prior) describe. The prior (0.68) is set just below
 * `execProvenanceCalibration()`'s 0.7 — deliberately not above the highest
 * existing T4 prior — because unlike a `ProvenanceLedger`'s hash CHAIN (each
 * record's hash binds the previous record's hash too, so tampering anywhere
 * in history is detectable from the hash alone), this verifier's per-step
 * provenance hashes are independent commitments with no chain linkage
 * between steps: a step silently deleted from the MIDDLE of a trace and the
 * two neighbours spliced together would still show each remaining step's
 * own hash recomputing correctly (the `STEP_COUNT_MISMATCH` /
 * `STEP_ORDER_MISMATCH` / `PHANTOM_STEP` checks are what catch that case
 * here, not a cryptographic chain).
 *
 * Like every verifier in this build, this stays T4-consistency, never T0: a
 * procedure that self-consistently reports a trace matching its own declared
 * steps, with every hash recomputing, has proven the RECORD is internally
 * honest — it has not proven the underlying tool calls did anything correct
 * or true in the world.
 */
export function procedureRunCalibration(): { tier: TierId; prior: number } {
  return { tier: "T4-consistency", prior: 0.68 };
}

/**
 * Self-contained, deterministic procedure-execution verifier — the second
 * domain this build had no verifier for at all.
 *
 * Checks (all always evaluated; `reasons` lists every failed code, in
 * `PROCEDURE_REASON_ORDER`):
 *
 *  1. `PHANTOM_STEP` — a trace step's `kind` (this file's step-name
 *     convention — see module docstring) does not appear anywhere in
 *     `declaredSteps` — a step that was never declared was appended.
 *  2. `STEP_COUNT_MISMATCH` — `trace.length !== declaredSteps.length` — a
 *     declared step is missing, or extra steps were appended.
 *  3. `STEP_ORDER_MISMATCH` — at some position `i`, `trace[i].kind !==
 *     declaredSteps[i]` — steps were reordered or substituted.
 *  4. `TOOL_STEP_PROVENANCE_MISSING` — a trace step whose `kind` is in
 *     `toolStepNames` has no provenance entry at its array index. This is a
 *     HARD FAIL, never a pass-with-lower-confidence: an unattested tool step
 *     is exactly the gap this verifier exists to close.
 *  5. `TOOL_STEP_PROVENANCE_HASH_MISMATCH` — a tool step's provenance entry
 *     is present but `sha256Hex(provenance.input) !== provenance.inputSha256`
 *     or `sha256Hex(trace[i].detail) !== provenance.outputSha256` — the
 *     claimed hash does not match the claimed text, so the binding cannot be
 *     trusted.
 *  6. `CLAIMED_OUTPUT_NOT_FROM_LAST_STEP` — `subject.output` is not exactly
 *     equal to the last trace step's `detail` (including the case where
 *     `trace` is empty, so there is no last step to derive from).
 *
 * `evidence.declaredSteps` / `subject.trace` / `subject.output` absent or
 * wrong-typed always ABSTAINS with a documented reason code.
 * `evidence.toolStepNames` / `evidence.stepProvenance` default to `[]` when
 * absent, but ABSTAIN if present with the wrong type.
 *
 * Confidence: exact structural/cryptographic recomputation — the calibrated
 * prior on a clean pass, `0` on any failure, never fractionally damped (see
 * `procedureRunCalibration()`).
 */
export function procedureRunVerifier(): UniversalVerifier {
  const calibration = procedureRunCalibration();

  const source: UniversalVerifier = {
    id: PROCEDURE_RUN_VERIFIER_ID,
    version: EMISSION_ADAPTER_VERSION,
    domain: "procedure",
    tier: calibration.tier,
    prior: clamp01(calibration.prior),
    // Every input to every check below — `evidence.declaredSteps`,
    // `evidence.stepProvenance`, `subject.trace`, `subject.output` — is written
    // by the same author as the answer. A pass therefore proves this run was
    // internally CONSISTENT with what it said about itself, and nothing about
    // whether the answer is right; anyone who can build the subject can obtain
    // that pass. Declaring it here keeps `VerifierRegistry.verify` from
    // counting that pass as the second, independent vote that clears the
    // evidence bar (a FAIL still counts — a proven structural mismatch is real
    // evidence). Without this flag, a flatly false answer carrying a
    // self-consistent manifest plus one other passing voter was enough to issue
    // a signed certificate at P(correct)=1.
    selfAttested: true,
    appliesTo(subject: TrustSubject): boolean {
      return !!subject && subject.domain === "procedure";
    },
    verify(subject: TrustSubject): UniversalVerdict {
      if (!subject || subject.domain !== "procedure") {
        return abstain(source, "SUBJECT_DOMAIN_MISMATCH");
      }
      const evidence = subject.evidence ?? {};
      const declaredSteps = evidence.declaredSteps;
      if (!isStringArray(declaredSteps)) {
        return abstain(source, "DECLARED_STEPS_MISSING_OR_INVALID");
      }
      const trace = subject.trace;
      if (!isTraceStepArray(trace)) {
        return abstain(source, "TRACE_MISSING_OR_INVALID");
      }
      if (typeof subject.output !== "string") {
        return abstain(source, "OUTPUT_NOT_STRING");
      }
      const toolStepNamesRaw = evidence.toolStepNames;
      let toolStepNames: string[];
      if (toolStepNamesRaw === undefined) {
        toolStepNames = [];
      } else if (isStringArray(toolStepNamesRaw)) {
        toolStepNames = toolStepNamesRaw;
      } else {
        return abstain(source, "TOOL_STEP_NAMES_INVALID");
      }
      const stepProvenanceRaw = evidence.stepProvenance;
      let stepProvenance: (ProcedureStepProvenance | null | undefined)[];
      if (stepProvenanceRaw === undefined) {
        stepProvenance = [];
      } else if (isProvenanceArray(stepProvenanceRaw)) {
        stepProvenance = stepProvenanceRaw;
      } else {
        return abstain(source, "STEP_PROVENANCE_INVALID");
      }

      const failed = new Set<string>();
      const declaredSet = new Set(declaredSteps);
      const toolStepSet = new Set(toolStepNames);

      for (const step of trace) {
        if (!declaredSet.has(step.kind)) failed.add("PHANTOM_STEP");
      }
      if (trace.length !== declaredSteps.length) failed.add("STEP_COUNT_MISMATCH");
      const maxLen = Math.max(trace.length, declaredSteps.length);
      for (let i = 0; i < maxLen; i++) {
        if (trace[i]?.kind !== declaredSteps[i]) {
          failed.add("STEP_ORDER_MISMATCH");
          break;
        }
      }

      for (let i = 0; i < trace.length; i++) {
        const step = trace[i];
        if (!toolStepSet.has(step.kind)) continue;
        const prov = stepProvenance[i];
        if (!prov) {
          failed.add("TOOL_STEP_PROVENANCE_MISSING");
          continue;
        }
        const inputOk = sha256Hex(prov.input) === prov.inputSha256;
        const outputOk = sha256Hex(step.detail) === prov.outputSha256;
        if (!inputOk || !outputOk) failed.add("TOOL_STEP_PROVENANCE_HASH_MISMATCH");
      }

      const lastStep = trace.length > 0 ? trace[trace.length - 1] : undefined;
      if (!lastStep || subject.output !== lastStep.detail) {
        failed.add("CLAIMED_OUTPUT_NOT_FROM_LAST_STEP");
      }

      const reasons = PROCEDURE_REASON_ORDER.filter((c) => failed.has(c));
      const passed = reasons.length === 0;

      return {
        verifierId: source.id,
        version: source.version,
        tier: source.tier,
        passed,
        confidence: passed ? clamp01(calibration.prior) : 0,
        reasons,
        abstained: false,
      };
    },
  };
  return source;
}

// ===========================================================================
// emissionVerifiers — the union
// ===========================================================================

/** Every emission-side `UniversalVerifier` this build ships:
 *  `memoryWriteVerifier()`, `userModelVerifier()`,
 *  `outboundMessageVerifier()`, `procedureRunVerifier()`. */
export function emissionVerifiers(): UniversalVerifier[] {
  return [memoryWriteVerifier(), userModelVerifier(), outboundMessageVerifier(), procedureRunVerifier()];
}
