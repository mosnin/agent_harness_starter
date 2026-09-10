import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cryptographic verification for inbound platform webhooks. Every function
 * here is pure (no I/O, no state) and operates on the *exact raw bytes* of
 * the request body — never a re-serialized/re-stringified object, since
 * JSON.stringify(JSON.parse(x)) is not guaranteed to reproduce `x` and would
 * silently break signature verification for some payloads.
 *
 * All comparisons use `crypto.timingSafeEqual` to avoid leaking the number of
 * matching prefix bytes through a timing side-channel. `timingSafeEqual`
 * throws if the two buffers differ in length, so every call site pre-checks
 * lengths and short-circuits to a `false`/rejection result instead of letting
 * the exception propagate — a length mismatch is just "not equal", not an
 * error.
 */

// ── Slack ────────────────────────────────────────────────────────────────

export interface VerifySlackSignatureOptions {
  /** The app's Signing Secret from the Slack app config. */
  signingSecret: string;
  /** Raw `X-Slack-Request-Timestamp` header value. */
  timestampHeader: string | undefined;
  /** Raw `X-Slack-Signature` header value (`v0=<hex>`). */
  signatureHeader: string | undefined;
  /** The exact, unparsed request body bytes. */
  rawBody: Buffer;
  /** Injected clock (ms since epoch) so tests are deterministic. */
  nowMs: number;
  /** Allowed clock skew in either direction, in ms. Default 300_000 (5 min). */
  toleranceMs?: number;
}

export type SlackVerifyReason = "missing-header" | "malformed-timestamp" | "stale-timestamp" | "bad-signature";

export type VerifyResult<Reason extends string> = { ok: true } | { ok: false; reason: Reason };

const DEFAULT_TOLERANCE_MS = 300_000;

/**
 * Verify Slack's v0 request signature scheme:
 * `X-Slack-Signature: v0=HMAC_SHA256(signingSecret, "v0:{timestamp}:{rawBody}")`.
 * Rejects a missing/absent header pair, a non-numeric timestamp, a timestamp
 * outside `toleranceMs` of `nowMs` in *either* direction (protects against
 * both stale-replay and clock-skew-forward-dated forgeries), and a signature
 * that doesn't match byte-for-byte (constant time).
 */
export function verifySlackSignature(opts: VerifySlackSignatureOptions): VerifyResult<SlackVerifyReason> {
  const { signingSecret, timestampHeader, signatureHeader, rawBody, nowMs } = opts;
  const toleranceMs = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;

  if (!timestampHeader || !signatureHeader) return { ok: false, reason: "missing-header" };

  if (!/^-?\d+$/.test(timestampHeader.trim())) return { ok: false, reason: "malformed-timestamp" };
  const timestampSec = Number(timestampHeader);
  if (!Number.isSafeInteger(timestampSec)) return { ok: false, reason: "malformed-timestamp" };

  const skewMs = Math.abs(nowMs - timestampSec * 1000);
  if (skewMs > toleranceMs) return { ok: false, reason: "stale-timestamp" };

  const base = Buffer.concat([Buffer.from(`v0:${timestampHeader}:`, "utf8"), rawBody]);
  const expectedHex = createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = `v0=${expectedHex}`;

  if (!constantTimeEqualStrings(expected, signatureHeader)) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}

// ── Meta (WhatsApp Cloud API) ───────────────────────────────────────────────

export interface VerifyMetaSignatureOptions {
  /** The Meta app's App Secret. */
  appSecret: string;
  /** Raw `X-Hub-Signature-256` header value (`sha256=<hex>`). */
  signatureHeader: string | undefined;
  /** The exact, unparsed request body bytes. */
  rawBody: Buffer;
}

export type MetaVerifyReason = "missing-header" | "malformed-header" | "bad-signature";

/**
 * Verify Meta's `X-Hub-Signature-256: sha256=<hex>` HMAC over the exact raw
 * request bytes (used by the WhatsApp Cloud API webhook).
 */
export function verifyMetaSignature(opts: VerifyMetaSignatureOptions): VerifyResult<MetaVerifyReason> {
  const { appSecret, signatureHeader, rawBody } = opts;
  if (!signatureHeader) return { ok: false, reason: "missing-header" };

  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return { ok: false, reason: "malformed-header" };
  const hex = signatureHeader.slice(prefix.length);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0) return { ok: false, reason: "malformed-header" };

  const expectedHex = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  if (!constantTimeEqualStrings(expectedHex, hex, /* caseInsensitiveHex */ true)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true };
}

// ── Telegram ─────────────────────────────────────────────────────────────

/**
 * Verify Telegram's `X-Telegram-Bot-Api-Secret-Token` header against the
 * secret token configured on `setWebhook`. Constant-time; a missing header
 * or a length mismatch is simply "not equal", never a thrown exception.
 */
export function verifyTelegramSecretToken(expected: string, header: string | undefined): boolean {
  if (!header) return false;
  return constantTimeEqualStrings(expected, header);
}

// ── shared ───────────────────────────────────────────────────────────────

/**
 * Constant-time string comparison via `timingSafeEqual`, with a length
 * pre-check so mismatched lengths never throw. When `caseInsensitiveHex` is
 * set both strings are lower-cased first (hex digests are case-insensitive
 * per RFC; this is not used for arbitrary secrets).
 */
function constantTimeEqualStrings(a: string, b: string, caseInsensitiveHex = false): boolean {
  const av = caseInsensitiveHex ? a.toLowerCase() : a;
  const bv = caseInsensitiveHex ? b.toLowerCase() : b;
  const bufA = Buffer.from(av, "utf8");
  const bufB = Buffer.from(bv, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
