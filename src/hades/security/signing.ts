import { createHmac, timingSafeEqual } from "node:crypto";
import type { A2ATransport } from "../a2a/bus";
import type { A2AMessage } from "../a2a/types";
import type { CapabilityToken } from "./tokens";

/**
 * Injectable signer. Production uses {@link HmacSigner} (HMAC-SHA256 over a
 * shared team secret); tests can inject a fake. Sign/verify operate on a
 * canonical string so both ends agree on exactly what was signed.
 */
export interface Signer {
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

/** HMAC-SHA256 signer with constant-time verification. */
export class HmacSigner implements Signer {
  constructor(private readonly secret: string) {}
  sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }
  verify(payload: string, signature: string): boolean {
    const expected = this.sign(payload);
    if (expected.length !== signature.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
}

/** Stable canonical string for an A2A envelope, excluding the signature. */
export function canonicalMessage(msg: A2AMessage): string {
  const { sig: _sig, ...body } = msg;
  void _sig;
  return JSON.stringify([
    body.id,
    body.from,
    body.to,
    body.kind,
    body.topic ?? null,
    body.correlationId ?? null,
    body.payload,
    body.ts,
  ]);
}

/** Canonical string for a capability token, excluding its signature. */
export function canonicalToken(token: CapabilityToken): string {
  return JSON.stringify([
    token.tokenId,
    token.agentId,
    token.team,
    [...token.capabilities].sort(),
    token.issuedAt,
    token.expiresAt ?? null,
  ]);
}

export function signToken(token: CapabilityToken, signer: Signer): CapabilityToken {
  return { ...token, signature: signer.sign(canonicalToken(token)) };
}

export function verifyToken(token: CapabilityToken, signer: Signer): boolean {
  if (!token.signature) return false;
  return signer.verify(canonicalToken(token), token.signature);
}

export interface SigningTransportOptions {
  /** Drop unsigned/invalid messages silently (default true). */
  dropInvalid?: boolean;
  /** Called when a message fails verification (audit hook). */
  onReject?: (msg: A2AMessage, reason: string) => void;
}

/**
 * Wraps an {@link A2ATransport} to **sign every outgoing message and verify every
 * incoming one**, dropping anything unsigned or tampered before it reaches an
 * agent's mailbox. With a shared team secret, a spoofed or modified A2A message
 * never gets delivered — closing the gap where a rogue process could inject
 * traffic. All crypto is behind the injectable {@link Signer}.
 */
export class SigningA2ATransport implements A2ATransport {
  constructor(
    private readonly inner: A2ATransport,
    private readonly signer: Signer,
    private readonly opts: SigningTransportOptions = {}
  ) {}

  publish(msg: A2AMessage): void | Promise<void> {
    const signed: A2AMessage = { ...msg, sig: this.signer.sign(canonicalMessage(msg)) };
    return this.inner.publish(signed);
  }

  register(address: Parameters<A2ATransport["register"]>[0], handler: (msg: A2AMessage) => void): () => void {
    return this.inner.register(address, (msg) => {
      const ok = !!msg.sig && this.signer.verify(canonicalMessage(msg), msg.sig);
      if (!ok) {
        this.opts.onReject?.(msg, msg.sig ? "bad signature" : "unsigned");
        if (this.opts.dropInvalid ?? true) return;
      }
      handler(msg);
    });
  }
}
