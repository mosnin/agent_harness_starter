/**
 * The trust badge: an honest, unforgeable "verified / abstained / unverified"
 * stamp on every outbound gateway message, derived exclusively from the real
 * STYX gate decision and ed25519 certificate for THAT exact reply text.
 *
 * There is no code path that lets a caller hand this module a badge string
 * directly — {@link assessReply} is the only producer of a {@link
 * StampedReply}, and it always re-derives the verdict from evidence:
 *
 *  - "verified" requires BOTH the gate having emitted (`decision.emit ===
 *    true`) AND a certificate that cryptographically certifies this exact
 *    reply text (`certifiesOutput`, which recomputes sha256 of the text and
 *    verifies the ed25519 signature over the certificate's payload). A cert
 *    copied from a different message, a payload tampered after signing, or
 *    text edited after certification all fail `certifiesOutput` and can
 *    never render as verified.
 *  - "abstained" reports an honest gate refusal — the gate outranks the
 *    certificate: even a perfectly valid certificate cannot promote a
 *    message the gate declined to emit.
 *  - "unverified" is the fail-closed default for missing evidence, a
 *    mismatched certificate, or a `certifiesOutput` call that throws.
 *
 * @module hades/gateway/badge
 */

import type { GateDecision } from "../styx/gate";
import { certifiesOutput, sha256Hex, type VerificationCertificate } from "../styx/certificate";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";
import { renderBadge } from "./message-format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustBadge = "verified" | "abstained" | "unverified";

/** The raw STYX evidence a handler may attach to a reply for assessment. */
export interface BadgeEvidence {
  decision?: GateDecision;
  certificate?: VerificationCertificate;
}

export interface StampedReply {
  badge: TrustBadge;
  reason: string;
  /** First 12 hex chars of sha256(certificate.signature). Only set when verified. */
  certFingerprint?: string;
  /** certificate.payload.pCorrect. Only set when verified. */
  pCorrect?: number;
}

// ---------------------------------------------------------------------------
// assessReply — the sole producer of a StampedReply
// ---------------------------------------------------------------------------

/**
 * Assess `replyText` against the STYX evidence that accompanied it and
 * derive the one honest {@link StampedReply} for it.
 *
 * Precedence (checked in this order):
 *  1. `decision.emit === false` -> "abstained". The gate's refusal is
 *     reported regardless of any certificate present — abstention is never
 *     overridden by crypto that happens to check out.
 *  2. `decision.emit === true` and a certificate is present -> re-verify the
 *     certificate against `replyText` with the real `certifiesOutput`
 *     (sha256 + ed25519, never re-implemented here). A match -> "verified"
 *     with a fingerprint and pCorrect pulled straight from the certificate.
 *     A miss (or a `certifiesOutput` call that throws, e.g. malformed hex)
 *     -> "unverified", reason explicitly explains the mismatch.
 *  3. `decision.emit === true` with no certificate -> "unverified": a gate
 *     pass alone is not proof; nothing was cryptographically bound to this
 *     text.
 *  4. No decision at all -> "unverified": there is no gate evidence to trust.
 */
export async function assessReply(
  replyText: string,
  evidence: BadgeEvidence,
): Promise<StampedReply> {
  const { decision, certificate } = evidence;

  if (decision === undefined) {
    return {
      badge: "unverified",
      reason: "no gate decision was attached to this reply",
    };
  }

  if (decision.emit === false) {
    return {
      badge: "abstained",
      reason: `gate abstained: score ${decision.score.toFixed(3)} below threshold ${decision.threshold.toFixed(3)}`,
    };
  }

  // decision.emit === true from here on.
  if (certificate === undefined) {
    return {
      badge: "unverified",
      reason: "gate emitted but no certificate was attached to this reply",
    };
  }

  let matches: boolean;
  try {
    matches = await certifiesOutput(certificate, replyText);
  } catch {
    // certifiesOutput is documented to never throw, but a malformed or
    // hostile certificate object (or a mocked implementation, in tests)
    // must still fail closed rather than crash the gateway.
    matches = false;
  }

  if (!matches) {
    return {
      badge: "unverified",
      reason: "certificate did not match this message",
    };
  }

  return {
    badge: "verified",
    reason: `gate emitted (score ${decision.score.toFixed(3)} >= threshold ${decision.threshold.toFixed(3)}) and certificate cryptographically matches this reply`,
    certFingerprint: sha256Hex(certificate.signature).slice(0, 12),
    pCorrect: certificate.payload.pCorrect,
  };
}

// ---------------------------------------------------------------------------
// BadgeStamper — wraps a gateway handler so every reply is stamped
// ---------------------------------------------------------------------------

export class BadgeStamper {
  private readonly render: (s: StampedReply, platform: string) => string;

  constructor(opts?: { render?: (s: StampedReply, platform: string) => string }) {
    this.render = opts?.render ?? renderBadge;
  }

  /**
   * Wrap a gateway handler that may attach `evidence` to its reply. The
   * returned handler awaits the inner handler, assesses the evidence against
   * the exact reply text, appends the rendered badge line separated by a
   * blank line, and strips the non-serializable `evidence` field before
   * returning — so no certificate material ever reaches the wire. An
   * empty-text reply (e.g. an ignored/unauthorized message) is returned
   * untouched, unstamped.
   */
  wrap(
    handler: (msg: InboundMessage) => Promise<OutboundReply & { evidence?: BadgeEvidence }>,
  ): (msg: InboundMessage) => Promise<OutboundReply> {
    return async (msg: InboundMessage): Promise<OutboundReply> => {
      const reply = await handler(msg);
      const { evidence, ...rest } = reply;

      if (!rest.text) {
        return rest;
      }

      const stamped = await assessReply(rest.text, evidence ?? {});
      const badgeLine = this.render(stamped, msg.platform);
      return { ...rest, text: `${rest.text}\n\n${badgeLine}` };
    };
  }
}
