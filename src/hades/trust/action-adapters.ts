/**
 * `src/hades/trust/action-adapters.ts` — adapts every ACTION-side verifier
 * this build already ships (the ten `toolVerifiers()` entries plus a new
 * exec-provenance-ledger check) into the shared `UniversalVerifier` shape
 * from `./registry.ts`, so a single `VerifierRegistry` can score any tool
 * call or code-exec provenance ledger without knowing which subsystem
 * produced the underlying verdict.
 *
 * ---------------------------------------------------------------------------
 * Non-negotiable discipline
 * ---------------------------------------------------------------------------
 * This file NEVER re-scores, re-derives, or raises a tier/prior. Every
 * `UniversalVerifier` here carries `tier`/`prior` read verbatim out of the
 * REAL `calibrationTable()` in `../tools/verifiers.ts` (for tool calls) or
 * set once, honestly justified in `execProvenanceCalibration()`'s TSDoc, for
 * `verify.exec-provenance`. The underlying `ToolOutputVerifier`s and
 * `ProvenanceLedger` are the REAL shipped modules — this file imports and
 * calls them; it does not reimplement, wrap-and-mock, or duplicate their
 * logic.
 *
 * `action-adapters.ts` and `../trust/emission-adapters.ts` never import from
 * each other (see that file's own header) — each is a self-contained
 * adaptation of a disjoint set of subsystems into the same shared shape.
 *
 * ---------------------------------------------------------------------------
 * `TrustSubject` field mapping this file uses
 * ---------------------------------------------------------------------------
 * Tool-call adapters (`toolCallVerifiers()`), one per real tool verifier:
 *   subject.domain               must be "tool"
 *   subject.subjectId            the tool name — must equal this adapter's
 *                                 own `ToolOutputVerifier.toolName`; a call
 *                                 routed at the wrong tool's adapter is
 *                                 excluded by `appliesTo` and, if called
 *                                 directly anyway, abstains rather than
 *                                 silently verifying against the wrong
 *                                 contract
 *   subject.input                 the tool's input string
 *   subject.evidence.toolResult   the real `ToolResult` ({ ok, output })
 *
 * Exec-provenance adapter (`execProvenanceVerifier()`):
 *   subject.domain                must be "tool"
 *   subject.evidence.ledgerJSON   the JSON string a `ProvenanceLedger`
 *                                 produced via `toJSON()` — re-verified with
 *                                 the REAL `ProvenanceLedger.verifyJSON`
 *
 * Absent or wrong-typed required evidence always ABSTAINS
 * (`passed:false, confidence:0, abstained:true`, a documented reason code)
 * — it never fabricates a pass and never throws.
 */

import { toolVerifiers, calibrationTable } from "../tools/verifiers";
import type { ToolOutputVerifier, ToolVerdict } from "../tools/verifiers";
import type { ToolResult } from "../agent/tools";
import { ProvenanceLedger } from "../exec/provenance";
import type { LedgerVerification } from "../exec/provenance";
import type { TierId } from "../styx/tiers";
import type { TrustSubject, UniversalVerdict, UniversalVerifier } from "./registry";

export const ACTION_ADAPTER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function isToolResult(x: unknown): x is ToolResult {
  return (
    x !== null &&
    typeof x === "object" &&
    typeof (x as { ok?: unknown }).ok === "boolean" &&
    typeof (x as { output?: unknown }).output === "string"
  );
}

/** Abstain — never fabricate a pass, never throw. `tier` is always the
 *  verifier's own registered ceiling (an abstention never claims a tier at
 *  all, but the field is required by the `UniversalVerdict` shape). */
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

/** Map a real `ToolVerdict` into the shared `UniversalVerdict` shape,
 *  verbatim on `passed`/`confidence`/`reasons` — no re-scoring, no
 *  smoothing, exactly the fidelity requirement this adapter exists to meet. */
function adaptToolVerdict(source: UniversalVerifier, verdict: ToolVerdict): UniversalVerdict {
  return {
    verifierId: source.id,
    version: source.version,
    tier: source.tier,
    passed: verdict.passed,
    confidence: clamp01(verdict.confidence),
    reasons: [...verdict.reasons],
    abstained: false,
  };
}

// ---------------------------------------------------------------------------
// toolCallVerifiers — one adapter per REAL toolVerifiers() entry
// ---------------------------------------------------------------------------

function makeToolCallAdapter(verifierId: string, toolVerifier: ToolOutputVerifier): UniversalVerifier {
  // Snapshot the calibration entry once at construction — it is a pure,
  // static table read from the real shipped module, never mutated per call.
  const calibration = calibrationTable()[verifierId] ?? { tier: "T4-consistency" as TierId, prior: 0 };

  const source: UniversalVerifier = {
    id: verifierId,
    version: ACTION_ADAPTER_VERSION,
    domain: "tool",
    tier: calibration.tier,
    prior: clamp01(calibration.prior),
    appliesTo(subject: TrustSubject): boolean {
      return !!subject && subject.domain === "tool" && subject.subjectId === toolVerifier.toolName;
    },
    verify(subject: TrustSubject): UniversalVerdict {
      if (!subject || subject.domain !== "tool") {
        return abstain(source, "SUBJECT_DOMAIN_MISMATCH");
      }
      if (typeof subject.subjectId !== "string" || subject.subjectId.length === 0) {
        return abstain(source, "SUBJECT_ID_MISSING");
      }
      if (subject.subjectId !== toolVerifier.toolName) {
        // A call for a DIFFERENT tool routed at this adapter — verifying it
        // anyway would silently score input/output against the wrong
        // contract. Abstain rather than guess.
        return abstain(source, "SUBJECT_TOOL_MISMATCH");
      }
      if (typeof subject.input !== "string") {
        return abstain(source, "INPUT_NOT_STRING");
      }
      const toolResult = subject.evidence ? subject.evidence.toolResult : undefined;
      if (!isToolResult(toolResult)) {
        return abstain(source, "TOOL_RESULT_MISSING_OR_INVALID");
      }

      const verdict = toolVerifier.verify(subject.input, toolResult);
      return adaptToolVerdict(source, verdict);
    },
  };
  return source;
}

/**
 * Exactly one `UniversalVerifier` per entry of the REAL `toolVerifiers()`
 * map (currently ten: `verify.browser`, `verify.backends`,
 * `verify.web_search`, `verify.fetch_extract`, `verify.file_ops`,
 * `verify.shell`, `verify.http_request`, `verify.image_gen`, `verify.tts`,
 * `verify.vision_describe`). Adding a tool verifier upstream automatically
 * adds an adapter here on the next call — nothing in this file enumerates
 * tool names by hand.
 */
export function toolCallVerifiers(): UniversalVerifier[] {
  const verifiers = toolVerifiers();
  const out: UniversalVerifier[] = [];
  for (const [verifierId, toolVerifier] of verifiers) {
    out.push(makeToolCallAdapter(verifierId, toolVerifier));
  }
  return out;
}

// ---------------------------------------------------------------------------
// execProvenanceVerifier — domain "tool", id "verify.exec-provenance"
// ---------------------------------------------------------------------------

const EXEC_PROVENANCE_VERIFIER_ID = "verify.exec-provenance";

/**
 * This adapter's honest tier + calibrated prior for a REAL
 * `ProvenanceLedger.verifyJSON` chain-verification result.
 *
 * WHAT THIS ATTESTS TO — INTEGRITY, NOT CORRECTNESS. Re-walking a hash chain
 * proves the ledger is exactly what it claims to be: no record was edited,
 * reordered, spliced, duplicated, or dropped after the fact, and the `seq`
 * sequence has no gaps. It does NOT prove any of the underlying tool calls
 * actually produced correct or truthful results — a fully fabricated but
 * self-consistently hashed trace passes every check here, exactly as
 * `../backends/verifier.ts`'s own chain-hash checklist documents for its
 * analogous case. That is why this stays T4-consistency, never T0 — "the
 * chain is intact" is not "the oracle ran". A genuinely valid chain earns no
 * stronger claim than any other structural self-consistency check in this
 * build.
 *
 * PRIOR (0.7). Chain verification here is EXACT, deterministic
 * recomputation with zero ambiguity (every record's hash either recomputes
 * bit-for-bit or it doesn't) — the same class of decisive structural check
 * as `../backends/verifier.ts`'s `backendsFleetCalibration()` (0.72,
 * currently the highest prior in the shipped T4-consistency range: an
 * eleven-check hash-chain-plus-lifecycle audit) and
 * `../memory/user-model-verifier.ts`'s `userModelCalibration()` (0.65: exact
 * hash/signature recomputation). 0.7 is set just below backends' 0.72 —
 * deliberately NOT above the highest existing T4 prior — because this
 * adapter checks ONLY the hash-chain's own internal consistency (via
 * `ProvenanceLedger.verifyJSON`), with no additional cross-checks against a
 * second independent source of truth (backends' checklist additionally
 * cross-validates handle lifecycle state transitions against the chain, a
 * second axis of internal consistency this adapter does not have).
 */
export function execProvenanceCalibration(): { tier: TierId; prior: number } {
  return { tier: "T4-consistency", prior: 0.7 };
}

function reasonForVerification(v: LedgerVerification): string {
  switch (v.reason) {
    case "malformed":
      return "LEDGER_MALFORMED";
    case "hash_mismatch":
      return "LEDGER_HASH_MISMATCH";
    case "chain_break":
      return "LEDGER_CHAIN_BREAK";
    case "seq_gap":
      return "LEDGER_SEQ_GAP";
    default:
      // verifyJSON's contract always sets `reason` when ok is false; this
      // branch only guards against a future new reason value.
      return "LEDGER_MALFORMED";
  }
}

/** The fixed reason-code vocabulary this adapter can emit, for callers that
 *  want to branch on codes without string-matching the detail suffix. */
export const EXEC_PROVENANCE_REASON_CODES = [
  "LEDGER_JSON_MISSING_OR_INVALID",
  "LEDGER_MALFORMED",
  "LEDGER_HASH_MISMATCH",
  "LEDGER_CHAIN_BREAK",
  "LEDGER_SEQ_GAP",
] as const;

/**
 * Adapts the REAL `ProvenanceLedger.verifyJSON` chain check into a
 * `UniversalVerifier`. `subject.evidence.ledgerJSON` must be the exact
 * string a `ProvenanceLedger` produced via `toJSON()` — absent or
 * wrong-typed evidence abstains (`LEDGER_JSON_MISSING_OR_INVALID`) rather
 * than fabricating a pass.
 *
 * `passed`/`reasons` map directly off the real `LedgerVerification`: a
 * genuinely valid chain passes; any tamper (flipped byte producing a hash
 * mismatch, a spliced/reordered record breaking the chain link, a seq gap)
 * fails and reports the same `reason` `ProvenanceLedger.verifyJSON` computed
 * — including the real `firstBadSeq`, carried into the reason text so a
 * caller does not have to re-run the check to locate the tamper.
 */
export function execProvenanceVerifier(): UniversalVerifier {
  const calibration = execProvenanceCalibration();

  const source: UniversalVerifier = {
    id: EXEC_PROVENANCE_VERIFIER_ID,
    version: ACTION_ADAPTER_VERSION,
    domain: "tool",
    tier: calibration.tier,
    prior: clamp01(calibration.prior),
    appliesTo(subject: TrustSubject): boolean {
      return !!subject && subject.domain === "tool" && typeof subject.evidence?.ledgerJSON === "string";
    },
    verify(subject: TrustSubject): UniversalVerdict {
      if (!subject || subject.domain !== "tool") {
        return abstain(source, "SUBJECT_DOMAIN_MISMATCH");
      }
      const ledgerJSON = subject.evidence ? subject.evidence.ledgerJSON : undefined;
      if (typeof ledgerJSON !== "string" || ledgerJSON.length === 0) {
        return abstain(source, "LEDGER_JSON_MISSING_OR_INVALID");
      }

      const verification = ProvenanceLedger.verifyJSON(ledgerJSON);
      if (verification.ok) {
        return {
          verifierId: source.id,
          version: source.version,
          tier: source.tier,
          passed: true,
          confidence: clamp01(calibration.prior),
          reasons: [],
          abstained: false,
        };
      }

      const code = reasonForVerification(verification);
      const detail =
        verification.firstBadSeq !== undefined ? `${code}(firstBadSeq=${verification.firstBadSeq})` : code;
      return {
        verifierId: source.id,
        version: source.version,
        tier: source.tier,
        passed: false,
        // This is exact deterministic hash-chain recomputation: a failure is
        // a proven tamper, not a probabilistic suspicion — report certainty,
        // matching the FAILURE_DETECTION_CONFIDENCE convention used
        // throughout `../tools/verifiers.ts` for its own certain-failure
        // paths (unparsable output / result.ok === false), which is
        // deliberately reported UNDAMPED by prior at this layer (raw
        // verifier output) — `VerifierRegistry`'s `normalizeVerdict` is the
        // single choke point that caps confidence at the registered prior
        // when this verdict is consumed through the registry, exactly as it
        // does for every other verifier adapted in this file.
        confidence: 0.99,
        reasons: [detail],
        abstained: false,
      };
    },
  };
  return source;
}

// ---------------------------------------------------------------------------
// actionVerifiers — the union
// ---------------------------------------------------------------------------

/** `toolCallVerifiers()` plus `execProvenanceVerifier()` — every action-side
 *  `UniversalVerifier` this build ships. */
export function actionVerifiers(): UniversalVerifier[] {
  return [...toolCallVerifiers(), execProvenanceVerifier()];
}
