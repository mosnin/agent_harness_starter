/**
 * Phase 6 ecosystem exit — the MCP certificate handoff.
 *
 * A {@link CertifiedHandoff} is the wire envelope that carries a Styx
 * {@link VerificationCertificate} (see `../styx/certificate`) across the MCP
 * boundary, bound to the exact result text it certifies. It exists so that an
 * EXTERNAL MCP client — one that trusts nothing about this process, only the
 * bytes it read off the wire — can independently re-derive and re-verify:
 *
 *   1. the sha256 of the delivered result text matches the handoff's claimed
 *      `resultSha256`,
 *   2. the certificate's own payload binds that SAME hash (no "binding
 *      confusion" where the certificate silently certifies different bytes),
 *   3. the ed25519 signature over the certificate payload is valid.
 *
 * All crypto is delegated to `../styx/certificate` (`sha256Hex`,
 * `CertificateAuthority`, `verifyCertificate`) — nothing here hand-rolls a
 * hash or a signature. `issueHandoffCertificate` is the trusted ISSUING side
 * (runs next to the swarm engine, holds the private key indirectly via the
 * injected {@link CertificateAuthority}); `verifyHandoffAtBoundary` is the
 * UNTRUSTED-INPUT CLIENT side (treats `raw` as fully adversarial JSON off the
 * wire) and never throws — every failure is collected into `reasons` rather
 * than short-circuited, so a caller sees the full adversarial picture in one
 * verification pass.
 */

import {
  sha256Hex,
  verifyCertificate,
  type CertificateAuthority,
  type CertificatePayload,
  type VerificationCertificate,
} from "../styx/certificate";

// ---------------------------------------------------------------------------
// Locked contract
// ---------------------------------------------------------------------------

export const HANDOFF_VERSION = 1;

export interface CertifiedHandoff {
  version: number;
  taskId: string;
  objective: string;
  resultText: string;
  /** sha256Hex(resultText) via the real ../styx/certificate sha256Hex. */
  resultSha256: string;
  certificate: VerificationCertificate;
}

export interface HandoffIssueInput {
  authority: CertificateAuthority;
  taskId: string;
  objective: string;
  resultText: string;
  verdict: "accept" | "abstain";
  score: number;
  verifierVersions: string[];
  now?: () => number;
}

export interface HandoffVerdict {
  ok: boolean;
  /** Empty iff ok. One human-readable string per failed check. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Verifier-tier / verdict mapping into the Styx CertificatePayload shape.
//
// `CertificatePayload` has no `verdict` field of its own (it is a
// correctness/integrity envelope, not a gate-outcome record) — the handoff
// honestly folds the gate's verdict into `verifierTier` (a plain, greppable
// string) so a re-verifier can see exactly what was certified without this
// module inventing a new field on the pinned Styx type.
// ---------------------------------------------------------------------------

const HANDOFF_TIER_PREFIX = "mcp-handoff";

function tierFor(verdict: "accept" | "abstain"): string {
  return `${HANDOFF_TIER_PREFIX}:${verdict}`;
}

// ---------------------------------------------------------------------------
// Issue — trusted side
// ---------------------------------------------------------------------------

/**
 * Build a {@link CertificatePayload} over `resultText` and sign it with the
 * real {@link CertificateAuthority}, then wrap the signed certificate plus
 * the plaintext result into a {@link CertifiedHandoff}. Every
 * `CertificatePayload` field is populated honestly from the caller's inputs —
 * nothing is fabricated:
 *
 *  - `outputSha256`      = sha256Hex(resultText)          (the real hash)
 *  - `taskId`             = input.taskId                   (verbatim)
 *  - `verifierTier`       = "mcp-handoff:<verdict>"         (honest gate outcome)
 *  - `ensembleScore`      = input.score                     (verbatim)
 *  - `pCorrect`           = input.score                     (the handoff has no
 *                           separate calibration step beyond the gate's own
 *                           score; using the gate score directly, rather than
 *                           inventing a distinct calibrated figure, is the
 *                           honest choice)
 *  - `epsilon`            = 0 for "accept" (the gate already enforced its own
 *                           abstention bound before returning "accept"; the
 *                           handoff adds no further conformal slack) — for
 *                           "abstain" epsilon is 1 (no correctness guarantee
 *                           at all is being claimed)
 *  - `traceSha256`        = sha256Hex of the canonical JSON `{taskId, objective}`
 *                           record identifying which run this handoff traces
 *                           back to (the handoff carries no separate execution
 *                           trace of its own — this module never fabricates one)
 *  - `verifierVersions`   = input.verifierVersions          (verbatim)
 *  - `issuedAt`           = input.now?.() ?? Date.now()
 */
export async function issueHandoffCertificate(
  input: HandoffIssueInput,
): Promise<CertifiedHandoff> {
  const now = input.now ?? Date.now;
  const resultSha256 = sha256Hex(input.resultText);
  const traceRecord = JSON.stringify({ taskId: input.taskId, objective: input.objective });

  const payload: CertificatePayload = {
    outputSha256: resultSha256,
    taskId: input.taskId,
    verifierTier: tierFor(input.verdict),
    ensembleScore: input.score,
    pCorrect: input.score,
    epsilon: input.verdict === "accept" ? 0 : 1,
    traceSha256: sha256Hex(traceRecord),
    verifierVersions: [...input.verifierVersions],
    issuedAt: now(),
  };

  const certificate = await input.authority.issue(payload);

  return {
    version: HANDOFF_VERSION,
    taskId: input.taskId,
    objective: input.objective,
    resultText: input.resultText,
    resultSha256,
    certificate,
  };
}

// ---------------------------------------------------------------------------
// Encode / decode — the wire format
// ---------------------------------------------------------------------------

/** JSON-encode a handoff for transmission. */
export function encodeHandoff(h: CertifiedHandoff): string {
  return JSON.stringify(h);
}

/**
 * Decode raw wire bytes into an `unknown` value for {@link verifyHandoffAtBoundary}
 * to judge. Never throws: malformed JSON decodes to `undefined`.
 */
export function decodeHandoff(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Verify — untrusted client side
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Structural + string-field checks only (no crypto, no hashing) — collects
 * every violation. Returns the narrowed record so later stages can read
 * fields that passed their own individual check, even if other fields failed.
 */
function checkShape(raw: unknown, reasons: string[]): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    reasons.push("handoff is not a plain object");
    return undefined;
  }

  const REQUIRED_STRING_FIELDS = ["taskId", "objective", "resultText", "resultSha256"] as const;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof raw[field] !== "string") {
      reasons.push(`missing or non-string field '${field}'`);
    }
  }

  if (typeof raw.version !== "number") {
    reasons.push("missing or non-number field 'version'");
  } else if (raw.version !== HANDOFF_VERSION) {
    reasons.push(`unsupported handoff version ${JSON.stringify(raw.version)} (expected ${HANDOFF_VERSION})`);
  }

  if (!isPlainObject(raw.certificate)) {
    reasons.push("missing or non-object field 'certificate'");
  } else {
    const cert = raw.certificate;
    if (!isPlainObject(cert.payload)) {
      reasons.push("certificate is missing its 'payload' object");
    } else if (typeof cert.payload.outputSha256 !== "string") {
      reasons.push("certificate payload is missing string field 'outputSha256'");
    }
    if (typeof cert.signature !== "string") {
      reasons.push("certificate is missing string field 'signature'");
    }
    if (typeof cert.publicKey !== "string") {
      reasons.push("certificate is missing string field 'publicKey'");
    }
  }

  return raw;
}

/**
 * Verify an untrusted, decoded-off-the-wire value against every check the
 * locked contract requires, collecting ALL failures rather than
 * short-circuiting on the first one:
 *
 *   1. structural shape + version
 *   2. resultSha256 === sha256Hex(resultText) (recomputed, not trusted)
 *   3. the certificate payload's bound hash (outputSha256) === resultSha256
 *      (binding confusion: a certificate that is cryptographically valid but
 *      certifies DIFFERENT bytes than the ones actually delivered)
 *   4. verifyCertificate(certificate) — the real ed25519 check
 *
 * Never throws. `ok` is true iff `reasons` is empty.
 */
export async function verifyHandoffAtBoundary(raw: unknown): Promise<HandoffVerdict> {
  const reasons: string[] = [];

  const shaped = checkShape(raw, reasons);

  // Hash / binding checks only run against fields that individually passed
  // their own shape check — reading a non-string field here would just
  // duplicate a reason already recorded by checkShape.
  let resultText: string | undefined;
  let claimedSha: string | undefined;
  if (shaped) {
    if (typeof shaped.resultText === "string") resultText = shaped.resultText;
    if (typeof shaped.resultSha256 === "string") claimedSha = shaped.resultSha256;
  }

  let recomputedSha: string | undefined;
  if (resultText !== undefined && claimedSha !== undefined) {
    recomputedSha = sha256Hex(resultText);
    if (recomputedSha !== claimedSha) {
      reasons.push(
        `resultSha256 mismatch: claimed ${claimedSha} but sha256Hex(resultText) is ${recomputedSha}`,
      );
    }
  } else {
    reasons.push("cannot verify resultSha256: resultText or resultSha256 missing/invalid");
  }

  let certificate: VerificationCertificate | undefined;
  if (shaped && isPlainObject(shaped.certificate)) {
    const cert = shaped.certificate;
    if (
      isPlainObject(cert.payload) &&
      typeof cert.payload.outputSha256 === "string" &&
      typeof cert.signature === "string" &&
      typeof cert.publicKey === "string"
    ) {
      certificate = cert as unknown as VerificationCertificate;
    }
  }

  if (certificate && claimedSha !== undefined) {
    const boundHash = certificate.payload.outputSha256;
    if (boundHash !== claimedSha) {
      reasons.push(
        `certificate payload binds a different hash: outputSha256=${boundHash} but handoff resultSha256=${claimedSha}`,
      );
    }
  } else if (!certificate) {
    reasons.push("cannot check certificate hash binding: certificate is structurally invalid");
  }

  if (certificate) {
    const publicKey = typeof certificate.publicKey === "string" ? certificate.publicKey : "<unknown>";
    const sigValid = await verifyCertificate(certificate);
    if (!sigValid) {
      reasons.push(
        `certificate signature is invalid for publicKey=${publicKey} (ed25519 verifyCertificate returned false)`,
      );
    }
  } else {
    reasons.push("cannot verify certificate signature: certificate is structurally invalid");
  }

  return { ok: reasons.length === 0, reasons };
}
