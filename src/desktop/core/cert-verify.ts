/**
 * Certificate verification — the Trust surface's "drop in a certificate" flow.
 *
 * The STYX thesis made tangible: a user pastes a Verification Certificate JSON
 * and this module checks it with the REAL ed25519 crypto from
 * `src/hades/styx/certificate.ts`. No fake "valid: true"; a forged, tampered,
 * or malformed certificate returns `valid: false` with a specific reason and
 * NEVER throws.
 *
 * Pure and testable: no DOM, no I/O, no ambient time. The rendering half lives
 * in `../ui/cert-view.ts`; this module owns the logic and the typed result.
 */

import {
  verifyCertificate,
  certifiesOutput,
  sha256Hex,
  type VerificationCertificate,
  type CertificatePayload,
} from "../../hades/styx/certificate";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CertCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface CertVerifyResult {
  valid: boolean;
  reason: string;
  payload?: CertificatePayload;
  publicKey?: string;
  checks: CertCheck[];
}

export type ParseResult =
  | { ok: true; cert: VerificationCertificate }
  | { ok: false; error: string };

export interface VerifyDroppedOptions {
  /**
   * The delivered output text this certificate is claimed to certify. When
   * supplied, an extra check recomputes its sha256 and requires it to match
   * `payload.outputSha256` (via the real `certifiesOutput`). Omit to check
   * signature + integrity only.
   */
  output?: string;
}

// ---------------------------------------------------------------------------
// Parsing — strict shape check of pasted JSON. Never throws.
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

/**
 * Validate that `x` has the exact shape of a {@link CertificatePayload}.
 * Returns null on success or a specific human-readable reason on failure.
 */
function payloadShapeError(x: unknown): string | null {
  if (!isPlainObject(x)) return "payload is not an object";
  if (typeof x.outputSha256 !== "string") return "payload.outputSha256 must be a string";
  if (typeof x.taskId !== "string") return "payload.taskId must be a string";
  if (typeof x.verifierTier !== "string") return "payload.verifierTier must be a string";
  if (!isFiniteNumber(x.ensembleScore)) return "payload.ensembleScore must be a finite number";
  if (!isFiniteNumber(x.pCorrect)) return "payload.pCorrect must be a finite number";
  if (!isFiniteNumber(x.epsilon)) return "payload.epsilon must be a finite number";
  if (typeof x.traceSha256 !== "string") return "payload.traceSha256 must be a string";
  if (!isStringArray(x.verifierVersions)) return "payload.verifierVersions must be a string array";
  if (!isFiniteNumber(x.issuedAt)) return "payload.issuedAt must be a finite number";
  return null;
}

/**
 * Strictly parse and shape-check pasted certificate JSON. Never throws:
 * invalid JSON or a wrong shape returns `{ ok: false, error }`.
 */
export function parseCertificate(input: string): ParseResult {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: "empty input: paste a certificate JSON" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: "invalid JSON: could not parse the pasted text" };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: "certificate must be a JSON object" };
  }
  if (typeof parsed.signature !== "string") {
    return { ok: false, error: "certificate.signature must be a string" };
  }
  if (typeof parsed.publicKey !== "string") {
    return { ok: false, error: "certificate.publicKey must be a string" };
  }
  const payloadErr = payloadShapeError(parsed.payload);
  if (payloadErr !== null) {
    return { ok: false, error: payloadErr };
  }

  // Shape is validated; narrow to the concrete type.
  const cert: VerificationCertificate = {
    payload: parsed.payload as CertificatePayload,
    signature: parsed.signature,
    publicKey: parsed.publicKey,
  };
  return { ok: true, cert };
}

// ---------------------------------------------------------------------------
// Verification — runs the REAL ed25519 check. Never throws.
// ---------------------------------------------------------------------------

/**
 * Parse then cryptographically verify a pasted certificate.
 *
 * Checks, in order:
 *  1. parses          — valid JSON with the right certificate shape
 *  2. signature valid — real ed25519 over canonicalize(payload)
 *  3. output match     — (only when `opts.output` is supplied) sha256 of the
 *                        delivered text equals payload.outputSha256
 *
 * `valid` is true only when every applicable check passes. A malformed,
 * forged, or tampered certificate yields `valid: false` with a specific
 * reason. This function never throws.
 */
export async function verifyDropped(
  input: string,
  opts: VerifyDroppedOptions = {},
): Promise<CertVerifyResult> {
  const checks: CertCheck[] = [];

  const parseResult = parseCertificate(input);
  if (!parseResult.ok) {
    checks.push({ name: "Parses", passed: false, detail: parseResult.error });
    return { valid: false, reason: parseResult.error, checks };
  }

  const cert = parseResult.cert;
  checks.push({
    name: "Parses",
    passed: true,
    detail: "valid certificate JSON with a well-formed payload",
  });

  // Real ed25519 verification. verifyCertificate is itself throw-safe, but we
  // keep our own guard so this function can never surface an exception.
  let signatureValid = false;
  try {
    signatureValid = await verifyCertificate(cert);
  } catch {
    signatureValid = false;
  }
  checks.push({
    name: "Signature valid",
    passed: signatureValid,
    detail: signatureValid
      ? "ed25519 signature verifies against the payload and public key"
      : "ed25519 signature does not verify: forged, tampered, or wrong key",
  });

  // Optional output-match check.
  let outputPassed = true;
  if (opts.output !== undefined) {
    let matches = false;
    try {
      matches = await certifiesOutput(cert, opts.output);
    } catch {
      matches = false;
    }
    outputPassed = matches;
    const expected = cert.payload.outputSha256.toLowerCase();
    const actual = sha256Hex(opts.output);
    checks.push({
      name: "Output match",
      passed: matches,
      detail: matches
        ? "sha256 of the delivered output matches payload.outputSha256"
        : `output hash mismatch: expected ${expected}, delivered text hashes to ${actual}`,
    });
  }

  const valid = signatureValid && outputPassed;
  let reason: string;
  if (!signatureValid) {
    reason = "signature verification failed";
  } else if (!outputPassed) {
    reason = "signature is valid but does not certify the supplied output";
  } else if (opts.output !== undefined) {
    reason = "certificate is authentic and certifies the supplied output";
  } else {
    reason = "certificate signature is authentic";
  }

  return {
    valid,
    reason,
    payload: cert.payload,
    publicKey: cert.publicKey,
    checks,
  };
}
