import { randomUUID } from "node:crypto";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";
import { InMemoryIdentityStore, IdentityLinker } from "./continuity";
import type { ChannelRef } from "./continuity";
import { InMemoryTrustStore } from "./trust-store";
import type { TrustLevel, TrustRecord } from "./trust-store";

/** A pairing code an owner hands out of-band (voice, another channel, a CLI). */
export interface PairingCode {
  code: string;
  expiresAt: number;
}

export interface PairingGuardOptions {
  trust: InMemoryTrustStore;
  identities: InMemoryIdentityStore;
  linker: IdentityLinker;
  /** When true, untrusted handles' plain text still reaches the handler (commands stay gated). Default false. */
  openAccess?: boolean;
  /** Time source (ms). Injectable for deterministic tests. Default Date.now. */
  now?: () => number;
  /** Generate a short human-typable pairing code. Default a 6-char uppercase slice of a UUID. */
  generateCode?: () => string;
  /** How long an issued pairing code stays valid. Default 10 minutes. */
  codeTtlMs?: number;
  /** Wrong-code attempts allowed per handle before lockout. Default 5. */
  maxAttempts?: number;
  /** How long a handle stays locked out after exhausting its attempt budget. Default 15 minutes. */
  lockoutMs?: number;
  /** Reply sent to untrusted handles instead of running the handler. */
  pairingPrompt?: string;
}

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;
const DEFAULT_PAIRING_PROMPT =
  'This handle isn\'t paired yet. Ask the owner for a pairing code, then reply with "/pair YOURCODE".';
const LOCKOUT_REPLY: OutboundReply = {
  text: "Too many failed pairing attempts. Try again later.",
  accepted: false,
};

// Strict, anchored, whole-trimmed-message regexes. `i` covers the verb only —
// code/argument comparisons downstream stay exact/case-sensitive. The
// separator is `[ \t]+`, not `\s+`, so an embedded newline (e.g. a second
// "/pair" hidden on the next line of the same message) can never slide a
// second command past the anchors — the whole multi-line string simply fails
// to match and falls back to plain text. Anchoring on a literal ASCII "/"
// also means unicode homoglyph slashes (fullwidth "／", division "∕", …)
// never trigger a command; no unicode normalization is applied anywhere here
// on purpose.
const RE_PAIR = /^\/pair[ \t]+([A-Za-z0-9]{4,12})$/i;
const RE_LINK_NOARG = /^\/link$/i;
const RE_LINK_ARG = /^\/link[ \t]+(\S{1,128})$/i;
const RE_WHOAMI = /^\/whoami$/i;
const RE_UNLINK = /^\/unlink[ \t]+(\S{1,256})$/i;

function keyOf(ref: ChannelRef): string {
  return `${ref.platform}:${ref.user}`;
}

function isTrustedOrOwner(record: TrustRecord | undefined): boolean {
  return record?.level === "trusted" || record?.level === "owner";
}

interface AttemptState {
  failures: number;
  /** 0 = never locked. */
  lockedUntil: number;
}

/**
 * Wraps a gateway handler so unknown handles must pair before the agent ever
 * responds to them. In-band `/pair`, `/link`, `/whoami`, `/unlink` commands
 * drive the existing {@link IdentityLinker} / {@link InMemoryIdentityStore}
 * continuity machinery; trust decisions live in the injected
 * {@link InMemoryTrustStore} (swap in {@link FileTrustStore} for durability).
 *
 * See {@link PairingGuard.wrap} for the exact, ordered gating rules.
 */
export class PairingGuard {
  private readonly trust: InMemoryTrustStore;
  private readonly identities: InMemoryIdentityStore;
  private readonly linker: IdentityLinker;
  private readonly openAccess: boolean;
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private readonly codeTtlMs: number;
  private readonly maxAttempts: number;
  private readonly lockoutMs: number;
  private readonly pairingPrompt: string;

  /** Codes issued via {@link issuePairingCode}, keyed by the code itself. Single-use. */
  private readonly pendingCodes = new Map<string, { level: Exclude<TrustLevel, "blocked">; expiresAt: number }>();
  /** Brute-force tracking, keyed by `platform:user` — independent per handle. */
  private readonly attempts = new Map<string, AttemptState>();

  constructor(opts: PairingGuardOptions) {
    this.trust = opts.trust;
    this.identities = opts.identities;
    this.linker = opts.linker;
    this.openAccess = opts.openAccess ?? false;
    this.now = opts.now ?? (() => Date.now());
    this.generateCode = opts.generateCode ?? (() => randomUUID().slice(0, 6).toUpperCase());
    this.codeTtlMs = opts.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.lockoutMs = opts.lockoutMs ?? DEFAULT_LOCKOUT_MS;
    this.pairingPrompt = opts.pairingPrompt ?? DEFAULT_PAIRING_PROMPT;
  }

  /**
   * Mint a one-time pairing code an owner hands to a new user out-of-band.
   * Redeeming it via `/pair CODE` from an unknown handle promotes that handle
   * to `level` (default `"trusted"`) and resolves/creates its identity.
   */
  issuePairingCode(level: Exclude<TrustLevel, "blocked"> = "trusted"): PairingCode {
    const code = this.generateCode();
    const expiresAt = this.now() + this.codeTtlMs;
    this.pendingCodes.set(code, { level, expiresAt });
    return { code, expiresAt };
  }

  /** Current trust level for a handle, or undefined if it has never been decided. */
  trustOf(ref: ChannelRef): TrustLevel | undefined {
    return this.trust.get(keyOf(ref))?.level;
  }

  /** Explicitly deny a handle. Existing identity linkage (if any) is preserved on the record. */
  block(ref: ChannelRef, note?: string): void {
    const key = keyOf(ref);
    const existing = this.trust.get(key);
    this.trust.set({ key, level: "blocked", identityId: existing?.identityId, addedAt: this.now(), note });
  }

  /**
   * Clear a handle's trust record entirely (blocked or otherwise). The handle
   * returns to "unknown" and must pair again — unblocking does not restore
   * whatever trust it had before being blocked.
   */
  unblock(ref: ChannelRef): boolean {
    return this.trust.remove(keyOf(ref));
  }

  /**
   * Wrap a gateway handler with pairing/trust gating. Order of decisions,
   * evaluated fresh on every message:
   *
   * 1. Blocked handle → `{ text: "", accepted: false }`. The wrapped handler
   *    is never invoked and nothing about the message is echoed back.
   * 2. If the trimmed text starts with `/`, it is tested against the known
   *    command regexes (`/pair`, `/link`, `/whoami`, `/unlink`, in that
   *    order). A match is handled entirely by the guard — the wrapped
   *    handler is never called for a recognized command. Text that starts
   *    with `/` but matches none of them falls through to step 3 exactly
   *    like plain text (so an unrelated slash-command meant for the wrapped
   *    agent still reaches it once the handle is trusted).
   * 3. Trusted/owner (or `openAccess`) → delegate to the wrapped handler.
   *    Untrusted and not `openAccess` → the pairing prompt, handler not called.
   */
  wrap(handler: (msg: InboundMessage) => Promise<OutboundReply>): (msg: InboundMessage) => Promise<OutboundReply> {
    return async (msg: InboundMessage): Promise<OutboundReply> => {
      const ref: ChannelRef = { platform: msg.platform, user: msg.user, channel: msg.channel };
      const key = keyOf(ref);
      const record = this.trust.get(key);

      // (1) Blocked → silent drop. Checked before anything else, including commands.
      if (record?.level === "blocked") {
        return { text: "", accepted: false };
      }

      const trimmed = msg.text.trim();
      if (trimmed.startsWith("/")) {
        const commandReply = this.tryHandleCommand(trimmed, ref, key, record);
        if (commandReply) return commandReply;
      }

      // (3) Plain text (or an unrecognized slash-command).
      if (isTrustedOrOwner(record) || this.openAccess) {
        return handler(msg);
      }
      return { text: this.pairingPrompt, accepted: false };
    };
  }

  // ── command handlers ────────────────────────────────────────────────────

  private tryHandleCommand(
    trimmed: string,
    ref: ChannelRef,
    key: string,
    record: TrustRecord | undefined
  ): OutboundReply | undefined {
    let m: RegExpMatchArray | null;

    if ((m = trimmed.match(RE_PAIR))) return this.handlePair(m[1], ref, key, record);
    if (RE_LINK_NOARG.test(trimmed)) return this.handleLinkIssue(ref, record);
    if ((m = trimmed.match(RE_LINK_ARG))) return this.handleLinkRedeem(m[1], ref, record);
    if (RE_WHOAMI.test(trimmed)) return this.handleWhoami(ref, record);
    if ((m = trimmed.match(RE_UNLINK))) return this.handleUnlink(m[1], ref, record);
    return undefined;
  }

  /** `/pair CODE` — redeem an owner-issued code, subject to per-key brute-force lockout. */
  private handlePair(code: string, ref: ChannelRef, key: string, record: TrustRecord | undefined): OutboundReply {
    if (isTrustedOrOwner(record)) {
      return { text: "This handle is already paired.", accepted: false };
    }

    const now = this.now();
    const state = this.attempts.get(key);

    if (state && state.lockedUntil > 0) {
      if (now < state.lockedUntil) {
        // Locked out: reject without ever comparing the code, and with the
        // exact same reply every time, so a locked-out attacker learns
        // nothing about whether any given code is right.
        return LOCKOUT_REPLY;
      }
      // Lockout window elapsed — attempts reset.
      this.attempts.delete(key);
    }

    // Codes are valid strictly while now() < expiresAt; at now() === expiresAt
    // (and beyond) the code is treated as expired. `pendingCodes` entries are
    // single-use and removed on successful redemption below.
    const pending = this.pendingCodes.get(code);
    if (!pending || !(now < pending.expiresAt)) {
      this.recordFailure(key, now);
      return { text: "That pairing code is invalid or has expired.", accepted: false };
    }

    this.pendingCodes.delete(code);
    this.attempts.delete(key);
    const identity = this.identities.resolveOrCreate(ref);
    this.trust.set({ key, level: pending.level, identityId: identity.id, addedAt: now });
    return {
      text: `Paired. You're now ${pending.level} (identity ${identity.id.slice(0, 8)}).`,
      accepted: true,
    };
  }

  private recordFailure(key: string, now: number): void {
    const state = this.attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
    state.failures += 1;
    if (state.failures >= this.maxAttempts) {
      state.lockedUntil = now + this.lockoutMs;
    }
    this.attempts.set(key, state);
  }

  /** `/link` (no code) — a trusted handle issues a link code for one of its other handles to redeem. */
  private handleLinkIssue(ref: ChannelRef, record: TrustRecord | undefined): OutboundReply {
    if (!isTrustedOrOwner(record)) {
      return { text: this.pairingPrompt, accepted: false };
    }
    const identity = this.identityFor(ref, record);
    if (!identity) {
      return { text: "No identity on file for this handle yet — pair first with /pair.", accepted: false };
    }
    const code = this.linker.issueLinkCode(identity.id);
    // The linker owns its own TTL internally and doesn't expose it; this
    // reports the guard's own codeTtlMs as the expected validity window.
    // Construct the injected IdentityLinker with a matching ttlMs if you
    // want this number to be exact rather than approximate.
    const minutes = Math.max(1, Math.round(this.codeTtlMs / 60000));
    return {
      text: `Link code: ${code} (valid ~${minutes} min). From the other handle, send "/link ${code}".`,
      accepted: true,
    };
  }

  /** `/link CODE` — any non-blocked handle may attempt to redeem; success inherits "trusted". */
  private handleLinkRedeem(code: string, ref: ChannelRef, record: TrustRecord | undefined): OutboundReply {
    const identity = this.linker.redeemLinkCode(code, ref);
    if (!identity) {
      // Deliberately generic: no oracle about "unknown" vs "expired" vs "reused".
      return { text: "That link code is invalid or has expired.", accepted: false };
    }
    const level: TrustLevel = record?.level === "owner" ? "owner" : "trusted";
    this.trust.set({ key: keyOf(ref), level, identityId: identity.id, addedAt: this.now() });
    const platforms = [...new Set(identity.links.map((l) => l.platform))].join(", ");
    return { text: `Linked. This identity now spans: ${platforms}.`, accepted: true };
  }

  /** `/whoami` — trusted handles get identity + link + session info; untrusted just get the pairing prompt. */
  private handleWhoami(ref: ChannelRef, record: TrustRecord | undefined): OutboundReply {
    if (!isTrustedOrOwner(record)) {
      return { text: this.pairingPrompt, accepted: false };
    }
    const identity = this.identityFor(ref, record);
    if (!identity) {
      return { text: "No identity on file for this handle yet.", accepted: false };
    }
    const links = identity.links.map((l) => keyOf(l)).join(", ") || "(none)";
    const session = identity.sessionId ? `active session ${identity.sessionId.slice(0, 8)}` : "no active session";
    return {
      text: `Identity ${identity.id.slice(0, 8)} — trust: ${record?.level}. Linked handles: ${links}. ${session}.`,
      accepted: true,
    };
  }

  /**
   * `/unlink platform:user` — a trusted handle removes the trust record for
   * one of its own linked handles. Refused for any handle not on the
   * caller's own identity. Note: this only removes the {@link TrustRecord};
   * the underlying identity's `links` list (owned by InMemoryIdentityStore)
   * is left untouched, so `/whoami` bookkeeping and continuity history for
   * that handle survive — only its standing to talk to the agent is revoked.
   */
  private handleUnlink(arg: string, ref: ChannelRef, record: TrustRecord | undefined): OutboundReply {
    if (!isTrustedOrOwner(record)) {
      return { text: this.pairingPrompt, accepted: false };
    }
    const sep = arg.indexOf(":");
    if (sep <= 0 || sep === arg.length - 1) {
      return { text: "Usage: /unlink platform:user", accepted: false };
    }
    const targetKey = `${arg.slice(0, sep)}:${arg.slice(sep + 1)}`;

    const callerIdentity = this.identityFor(ref, record);
    const owns = callerIdentity?.links.some((l) => keyOf(l) === targetKey) ?? false;
    if (!callerIdentity || !owns) {
      return { text: "That handle is not linked to your identity.", accepted: false };
    }

    const removed = this.trust.remove(targetKey);
    return {
      text: removed ? `Unlinked ${targetKey}.` : `${targetKey} had no trust record to remove.`,
      accepted: true,
    };
  }

  private identityFor(ref: ChannelRef, record: TrustRecord | undefined) {
    return this.identities.resolve(ref) ?? (record?.identityId ? this.identities.get(record.identityId) : undefined);
  }
}
