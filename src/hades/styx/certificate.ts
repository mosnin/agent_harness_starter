/**
 * Styx primitive #6 — the Verification Certificate.
 *
 * An ed25519-signed envelope that binds an agent output to its verification
 * evidence, keeping the two legs of trust explicitly separate:
 *
 *  - CORRECTNESS leg: verifier tier, calibrated ensemble score, calibrated
 *    P(correct) at emission, and the conformal epsilon bound the abstention
 *    gate enforced. This leg says "how likely is this right, and under what
 *    guarantee".
 *  - INTEGRITY leg: sha256 of the delivered output, sha256 of the full
 *    execution trace, the ids+versions of every verifier that scored it, and
 *    the ed25519 signature over the canonical payload. This leg says "this is
 *    exactly what ran and exactly what was delivered".
 *
 * Provenance is not truth: the signature proves the payload was issued by the
 * holder of the private key and has not been altered — it never upgrades the
 * correctness leg. Neither leg may masquerade as the other.
 *
 * Crypto: REAL ed25519 via @noble/ed25519 (v3 API, sync path wired to
 * node:crypto SHA-512), REAL sha256 via node:crypto. No home-rolled crypto.
 * No ambient nondeterminism: `issuedAt` is caller-provided and key-generation
 * randomness is injectable.
 */

import { createHash, randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";

// ---------------------------------------------------------------------------
// @noble/ed25519 v3 requires a SHA-512 implementation for its synchronous API
// (`ed.hashes.sha512`). Wire it to node:crypto once at module load.
// ---------------------------------------------------------------------------
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (message: Uint8Array): Uint8Array<ArrayBuffer> =>
    new Uint8Array(createHash("sha512").update(message).digest());
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CertificatePayload {
  /** hex sha256 of the delivered output text */
  outputSha256: string;
  taskId: string;
  /** e.g. "T0-execution" | "T2-genrm" ... */
  verifierTier: string;
  /** raw calibrated ensemble score in [0,1] */
  ensembleScore: number;
  /** calibrated P(correct) at emission */
  pCorrect: number;
  /** the conformal bound the abstention gate enforced */
  epsilon: number;
  /** hex sha256 of the full execution trace (JSON) */
  traceSha256: string;
  /** ids+versions of every verifier that scored it */
  verifierVersions: string[];
  /** ms timestamp (caller-provided — no Date.now inside this library) */
  issuedAt: number;
}

export interface VerificationCertificate {
  payload: CertificatePayload;
  /** hex ed25519 signature over the UTF-8 bytes of canonicalize(payload) */
  signature: string;
  /** hex ed25519 public key of the issuing authority */
  publicKey: string;
}

// ---------------------------------------------------------------------------
// Hashing & canonicalization
// ---------------------------------------------------------------------------

/** Real sha256 (node:crypto) of the UTF-8 bytes of `data`, as lowercase hex. */
export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Deterministic JSON serialization: object keys sorted lexicographically at
 * every level, array element order preserved, numbers/strings via the JSON
 * default. Two payloads with identical field values always canonicalize to
 * the same string regardless of property insertion order.
 */
export function canonicalize(payload: CertificatePayload): string {
  return stableStringify(payload);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    if (out === undefined) {
      throw new TypeError(`canonicalize: unserializable value of type ${typeof value}`);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

// ---------------------------------------------------------------------------
// Hex helpers (strict — reject odd length / non-hex rather than mis-decode)
// ---------------------------------------------------------------------------

const HEX_RE = /^[0-9a-fA-F]*$/;

function hexToBytes(hex: string, expectedBytes?: number): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new TypeError("invalid hex string");
  }
  if (expectedBytes !== undefined && hex.length !== expectedBytes * 2) {
    throw new RangeError(`expected ${expectedBytes} bytes of hex, got ${hex.length / 2}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Generate a 32-byte ed25519 private-key seed as hex.
 * Uses node:crypto randomBytes by default; pass `rng` for deterministic tests.
 */
export function generatePrivateKeyHex(rng?: (bytes: number) => Uint8Array): string {
  const bytes = rng ? rng(32) : new Uint8Array(randomBytes(32));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new RangeError("rng must return exactly 32 bytes");
  }
  return bytesToHex(bytes);
}

// ---------------------------------------------------------------------------
// Certificate authority
// ---------------------------------------------------------------------------

export class CertificateAuthority {
  private readonly seed: Uint8Array;
  private readonly pubHex: string;

  /** privateKey: 32-byte hex seed (RFC 8032 secret-key seed). */
  constructor(privateKeyHex: string) {
    this.seed = hexToBytes(privateKeyHex, 32);
    this.pubHex = bytesToHex(ed.getPublicKey(this.seed));
  }

  publicKeyHex(): string {
    return this.pubHex;
  }

  /** Sign canonicalize(payload) (UTF-8 bytes) and wrap into a certificate. */
  async issue(payload: CertificatePayload): Promise<VerificationCertificate> {
    const message = utf8Bytes(canonicalize(payload));
    const signature = await ed.signAsync(message, this.seed);
    return {
      // Deep-copy so later mutation of the caller's payload object cannot
      // silently desynchronize the certificate from what was signed.
      payload: { ...payload, verifierVersions: [...payload.verifierVersions] },
      signature: bytesToHex(signature),
      publicKey: this.pubHex,
    };
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify cert.signature over canonicalize(cert.payload) against
 * cert.publicKey. Returns false on ANY mismatch — malformed hex, wrong
 * lengths, garbage signatures, tampered fields — and never throws.
 */
export async function verifyCertificate(cert: VerificationCertificate): Promise<boolean> {
  try {
    if (cert === null || typeof cert !== "object") return false;
    if (cert.payload === null || typeof cert.payload !== "object") return false;
    const message = utf8Bytes(canonicalize(cert.payload));
    const signature = hexToBytes(cert.signature, 64);
    const publicKey = hexToBytes(cert.publicKey, 32);
    return await ed.verifyAsync(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * Convenience: does this certificate bind exactly `outputText`?
 * Recomputes sha256 of the text, requires equality with payload.outputSha256
 * AND a valid signature. A valid cert for output A returns false for output B.
 */
export async function certifiesOutput(
  cert: VerificationCertificate,
  outputText: string,
): Promise<boolean> {
  try {
    if (cert === null || typeof cert !== "object") return false;
    if (cert.payload === null || typeof cert.payload !== "object") return false;
    if (typeof cert.payload.outputSha256 !== "string") return false;
    if (sha256Hex(outputText) !== cert.payload.outputSha256.toLowerCase()) return false;
    return await verifyCertificate(cert);
  } catch {
    return false;
  }
}
