import { describe, it, expect, vi } from "vitest";
import { PairingGuard } from "../gateway/pairing";
import { InMemoryTrustStore } from "../gateway/trust-store";
import { InMemoryIdentityStore, IdentityLinker } from "../gateway/continuity";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

function inbound(platform: string, user: string, text: string, channel?: string): InboundMessage {
  return { platform: platform as InboundMessage["platform"], user, channel, text };
}

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (d: number) => {
      t += d;
    },
  };
}

interface SetupOverrides {
  openAccess?: boolean;
  now?: () => number;
  maxAttempts?: number;
  lockoutMs?: number;
  codeTtlMs?: number;
  pairingPrompt?: string;
}

const PAIRING_PROMPT = "PAIRING_PROMPT";

function setup(overrides: SetupOverrides = {}) {
  const trust = new InMemoryTrustStore();
  const identities = new InMemoryIdentityStore();
  const now = overrides.now ?? (() => 0);

  let linkCodeSeq = 0;
  const linker = new IdentityLinker(identities, {
    now,
    generateCode: () => `LINK${++linkCodeSeq}`,
  });

  let pairCodeSeq = 0;
  const guard = new PairingGuard({
    trust,
    identities,
    linker,
    openAccess: overrides.openAccess,
    now,
    generateCode: () => `PAIR${++pairCodeSeq}`,
    codeTtlMs: overrides.codeTtlMs,
    maxAttempts: overrides.maxAttempts,
    lockoutMs: overrides.lockoutMs,
    pairingPrompt: overrides.pairingPrompt ?? PAIRING_PROMPT,
  });

  const handler = vi.fn(async (_msg: InboundMessage): Promise<OutboundReply> => ({ text: "handled", accepted: true }));

  return { trust, identities, linker, guard, handler };
}

// ── (1) blocked ──────────────────────────────────────────────────────────

describe("wrap(): blocked handles", () => {
  it("silently drops plain text from a blocked handle without calling the handler", async () => {
    const { guard, handler, trust } = setup();
    trust.set({ key: "telegram:1", level: "blocked", addedAt: 0, note: "spammer" });
    const wrapped = guard.wrap(handler);

    const r = await wrapped(inbound("telegram", "1", "hello there"));
    expect(r).toEqual({ text: "", accepted: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("silently drops even a well-formed /pair from a blocked handle", async () => {
    const { guard, handler, trust } = setup();
    trust.set({ key: "telegram:1", level: "blocked", addedAt: 0 });
    const wrapped = guard.wrap(handler);
    const { code } = guard.issuePairingCode();

    const r = await wrapped(inbound("telegram", "1", `/pair ${code}`));
    expect(r).toEqual({ text: "", accepted: false });
    expect(handler).not.toHaveBeenCalled();
    expect(guard.trustOf({ platform: "telegram", user: "1" })).toBe("blocked");
  });
});

// ── (2)/(6)/(7) untrusted plain text / openAccess ───────────────────────

describe("wrap(): untrusted handles and the pairing gate", () => {
  it("replies with the pairing prompt and never calls the handler", async () => {
    const { guard, handler } = setup();
    const wrapped = guard.wrap(handler);

    const r = await wrapped(inbound("telegram", "1", "hello there"));
    expect(r).toEqual({ text: PAIRING_PROMPT, accepted: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("delegates plain text to the handler once a handle is trusted", async () => {
    const { guard, handler, trust } = setup();
    trust.set({ key: "telegram:1", level: "trusted", addedAt: 0 });
    const wrapped = guard.wrap(handler);

    const r = await wrapped(inbound("telegram", "1", "what's the weather"));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ text: "handled", accepted: true });
  });

  it("openAccess:true still enforces block", async () => {
    const { guard, handler, trust } = setup({ openAccess: true });
    trust.set({ key: "telegram:1", level: "blocked", addedAt: 0 });
    const wrapped = guard.wrap(handler);

    const r = await wrapped(inbound("telegram", "1", "hello"));
    expect(r).toEqual({ text: "", accepted: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("openAccess:true routes untrusted plain text straight to the handler", async () => {
    const { guard, handler } = setup({ openAccess: true });
    const wrapped = guard.wrap(handler);

    const r = await wrapped(inbound("telegram", "1", "hello"));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ text: "handled", accepted: true });
  });

  it("openAccess:true still gates /whoami behind trust", async () => {
    const { guard, handler } = setup({ openAccess: true });
    const wrapped = guard.wrap(handler);

    const r = await wrapped(inbound("telegram", "1", "/whoami"));
    expect(r).toEqual({ text: PAIRING_PROMPT, accepted: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("openAccess:true still lets /link succeed and promote the handle to trusted", async () => {
    const { guard, handler, linker, identities } = setup({ openAccess: true });
    const wrapped = guard.wrap(handler);
    const identity = identities.resolveOrCreate({ platform: "telegram", user: "owner1" });
    const linkCode = linker.issueLinkCode(identity.id);

    const r = await wrapped(inbound("signal", "sig1", `/link ${linkCode}`));
    expect(r.accepted).toBe(true);
    expect(guard.trustOf({ platform: "signal", user: "sig1" })).toBe("trusted");
  });

  it("passes an unrecognized slash-command through to the handler once trusted, but gates it while untrusted", async () => {
    const { guard, handler, trust } = setup();
    const wrapped = guard.wrap(handler);

    const untrusted = await wrapped(inbound("telegram", "1", "/help"));
    expect(untrusted).toEqual({ text: PAIRING_PROMPT, accepted: false });
    expect(handler).not.toHaveBeenCalled();

    trust.set({ key: "telegram:1", level: "trusted", addedAt: 0 });
    const trusted = await wrapped(inbound("telegram", "1", "/help"));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(trusted).toEqual({ text: "handled", accepted: true });
  });
});

// ── /pair ────────────────────────────────────────────────────────────────

describe("wrap(): /pair", () => {
  it("promotes an unknown handle to trusted and resolves/creates its identity", async () => {
    const { guard, handler, identities } = setup();
    const wrapped = guard.wrap(handler);
    const { code } = guard.issuePairingCode();

    const r = await wrapped(inbound("telegram", "1", `/pair ${code}`));
    expect(r.accepted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(guard.trustOf({ platform: "telegram", user: "1" })).toBe("trusted");
    expect(identities.resolve({ platform: "telegram", user: "1" })).toBeDefined();
  });

  it("can mint an owner-level code", async () => {
    const { guard, handler } = setup();
    const wrapped = guard.wrap(handler);
    const { code } = guard.issuePairingCode("owner");

    const r = await wrapped(inbound("telegram", "1", `/pair ${code}`));
    expect(r.accepted).toBe(true);
    expect(guard.trustOf({ platform: "telegram", user: "1" })).toBe("owner");
  });

  it("is single-use: a second redemption of the same code fails", async () => {
    const { guard, handler } = setup();
    const wrapped = guard.wrap(handler);
    const { code } = guard.issuePairingCode();

    const r1 = await wrapped(inbound("telegram", "1", `/pair ${code}`));
    expect(r1.accepted).toBe(true);

    const r2 = await wrapped(inbound("telegram", "2", `/pair ${code}`));
    expect(r2.accepted).toBe(false);
    expect(guard.trustOf({ platform: "telegram", user: "2" })).toBeUndefined();
  });

  it("rejects a code redeemed exactly at its expiresAt", async () => {
    const clock = makeClock(0);
    const { guard, handler } = setup({ now: clock.now });
    const wrapped = guard.wrap(handler);
    const { code, expiresAt } = guard.issuePairingCode();

    clock.set(expiresAt);
    const r = await wrapped(inbound("telegram", "1", `/pair ${code}`));
    expect(r.accepted).toBe(false);
    expect(guard.trustOf({ platform: "telegram", user: "1" })).toBeUndefined();
  });

  it("accepts a code redeemed one tick before its expiresAt", async () => {
    const clock = makeClock(0);
    const { guard, handler } = setup({ now: clock.now });
    const wrapped = guard.wrap(handler);
    const { code, expiresAt } = guard.issuePairingCode();

    clock.set(expiresAt - 1);
    const r = await wrapped(inbound("telegram", "1", `/pair ${code}`));
    expect(r.accepted).toBe(true);
    expect(guard.trustOf({ platform: "telegram", user: "1" })).toBe("trusted");
  });

  it("replies without re-pairing or calling the handler when already trusted", async () => {
    const { guard, handler, trust } = setup();
    trust.set({ key: "telegram:1", level: "trusted", addedAt: 0 });
    const wrapped = guard.wrap(handler);
    const { code } = guard.issuePairingCode();

    const r = await wrapped(inbound("telegram", "1", `/pair ${code}`));
    expect(r.accepted).toBe(false);
    expect(r.text.toLowerCase()).toContain("already paired");
    expect(handler).not.toHaveBeenCalled();
  });

  it("locks a key out after maxAttempts wrong codes; a correct code during lockout still fails; attempts reset once lockoutMs elapses", async () => {
    const clock = makeClock(0);
    const { guard, handler } = setup({ now: clock.now, maxAttempts: 5, lockoutMs: 60_000 });
    const wrapped = guard.wrap(handler);
    const { code } = guard.issuePairingCode();
    const ref = { platform: "telegram", user: "1" };

    for (let i = 0; i < 5; i++) {
      const r = await wrapped(inbound("telegram", "1", "/pair WRONG1"));
      expect(r.accepted).toBe(false);
    }

    // Locked: even the genuinely correct code is rejected, without comparison.
    const rLocked = await wrapped(inbound("telegram", "1", `/pair ${code}`));
    expect(rLocked.accepted).toBe(false);
    expect(rLocked.text).toBe("Too many failed pairing attempts. Try again later.");
    expect(guard.trustOf(ref)).toBeUndefined();

    clock.advance(59_999);
    const rStillLocked = await wrapped(inbound("telegram", "1", `/pair ${code}`));
    expect(rStillLocked.accepted).toBe(false);

    clock.advance(1); // exactly lockoutMs elapsed
    const rOk = await wrapped(inbound("telegram", "1", `/pair ${code}`));
    expect(rOk.accepted).toBe(true);
    expect(guard.trustOf(ref)).toBe("trusted");
  });

  it("scopes brute-force lockout to a single platform:user key", async () => {
    const { guard, handler } = setup({ maxAttempts: 5, lockoutMs: 60_000 });
    const wrapped = guard.wrap(handler);

    for (let i = 0; i < 5; i++) {
      await wrapped(inbound("telegram", "attacker", "/pair WRONG1"));
    }
    const lockedReply = await wrapped(inbound("telegram", "attacker", "/pair WRONG2"));
    expect(lockedReply.text).toBe("Too many failed pairing attempts. Try again later.");

    // A different handle's first wrong attempt gets the normal (non-lockout) message.
    const otherReply = await wrapped(inbound("signal", "newguy", "/pair WRONG1"));
    expect(otherReply.text).not.toBe(lockedReply.text);
    expect(otherReply.text.toLowerCase()).toContain("invalid or has expired");

    // And that other handle can still successfully pair with a real code.
    const { code } = guard.issuePairingCode();
    const okReply = await wrapped(inbound("signal", "newguy", `/pair ${code}`));
    expect(okReply.accepted).toBe(true);
  });
});

// ── /link ────────────────────────────────────────────────────────────────

describe("wrap(): /link", () => {
  it("no-arg /link from an untrusted handle gets the pairing prompt, not a code", async () => {
    const { guard, handler } = setup();
    const wrapped = guard.wrap(handler);

    const r = await wrapped(inbound("telegram", "1", "/link"));
    expect(r).toEqual({ text: PAIRING_PROMPT, accepted: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("round-trips: trusted telegram issues a code, signal redeems it, both handles resolve to one identity, signal becomes trusted", async () => {
    const { guard, handler, identities, trust } = setup();
    const wrapped = guard.wrap(handler);

    const { code: pairCode } = guard.issuePairingCode();
    await wrapped(inbound("telegram", "1", `/pair ${pairCode}`));
    expect(guard.trustOf({ platform: "telegram", user: "1" })).toBe("trusted");

    const linkIssueReply = await wrapped(inbound("telegram", "1", "/link"));
    expect(linkIssueReply.accepted).toBe(true);
    const m = linkIssueReply.text.match(/Link code: (\S+)/);
    expect(m).not.toBeNull();
    const linkCode = m![1];

    const redeemReply = await wrapped(inbound("signal", "sig1", `/link ${linkCode}`));
    expect(redeemReply.accepted).toBe(true);
    expect(redeemReply.text).toContain("signal");
    expect(redeemReply.text).toContain("telegram");

    const tgIdentity = identities.resolve({ platform: "telegram", user: "1" });
    const sigIdentity = identities.resolve({ platform: "signal", user: "sig1" });
    expect(tgIdentity).toBeDefined();
    expect(tgIdentity?.id).toBe(sigIdentity?.id);
    expect(guard.trustOf({ platform: "signal", user: "sig1" })).toBe("trusted");
    expect(trust.get("signal:sig1")?.identityId).toBe(tgIdentity?.id);
  });

  it("redemption failure is generic, giving no oracle for unknown vs. expired codes", async () => {
    const clock = makeClock(0);
    const { guard, handler, linker } = setup({ now: clock.now });
    const wrapped = guard.wrap(handler);

    const unknown = await wrapped(inbound("signal", "s1", "/link NOPE12"));
    expect(unknown.accepted).toBe(false);

    const { identities } = setup(); // separate store, just need a real identity id
    const identity = identities.resolveOrCreate({ platform: "telegram", user: "owner1" });
    const expiredCode = linker.issueLinkCode(identity.id);
    clock.set(10 * 60 * 1000 + 1); // one tick past IdentityLinker's default 10-minute ttl
    const expired = await wrapped(inbound("signal", "s2", `/link ${expiredCode}`));
    expect(expired.accepted).toBe(false);
    expect(expired.text).toBe(unknown.text);
  });
});

// ── /whoami ──────────────────────────────────────────────────────────────

describe("wrap(): /whoami", () => {
  it("untrusted handle gets only the pairing prompt", async () => {
    const { guard, handler } = setup();
    const wrapped = guard.wrap(handler);
    const r = await wrapped(inbound("telegram", "1", "/whoami"));
    expect(r).toEqual({ text: PAIRING_PROMPT, accepted: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("trusted handle gets identity id prefix, linked handles, and session presence", async () => {
    const { guard, handler, identities, trust } = setup();
    const wrapped = guard.wrap(handler);
    const identity = identities.resolveOrCreate({ platform: "telegram", user: "1" });
    trust.set({ key: "telegram:1", level: "trusted", identityId: identity.id, addedAt: 0 });

    const r = await wrapped(inbound("telegram", "1", "/whoami"));
    expect(r.accepted).toBe(true);
    expect(r.text).toContain(identity.id.slice(0, 8));
    expect(r.text).toContain("telegram:1");
    expect(r.text).toContain("no active session");

    identities.setSession(identity.id, "sess-abc123");
    const r2 = await wrapped(inbound("telegram", "1", "/whoami"));
    expect(r2.text).toContain("active session");
    expect(r2.text).not.toContain("no active session");
  });
});

// ── /unlink ──────────────────────────────────────────────────────────────

describe("wrap(): /unlink", () => {
  async function pairAndLink(guard: PairingGuard, handler: ReturnType<typeof vi.fn>) {
    const wrapped = guard.wrap(handler);
    const { code: pairCode } = guard.issuePairingCode();
    await wrapped(inbound("telegram", "1", `/pair ${pairCode}`));
    const linkIssueReply = await wrapped(inbound("telegram", "1", "/link"));
    const linkCode = linkIssueReply.text.match(/Link code: (\S+)/)![1];
    await wrapped(inbound("signal", "sig1", `/link ${linkCode}`));
    return wrapped;
  }

  it("removes trust for a handle on the caller's own identity", async () => {
    const { guard, handler, trust } = setup();
    const wrapped = await pairAndLink(guard, handler);
    expect(trust.get("signal:sig1")).toBeDefined();

    const r = await wrapped(inbound("telegram", "1", "/unlink signal:sig1"));
    expect(r.accepted).toBe(true);
    expect(trust.get("signal:sig1")).toBeUndefined();

    // The unlinked handle is unknown again, back behind the pairing gate.
    const after = await wrapped(inbound("signal", "sig1", "hello"));
    expect(after).toEqual({ text: PAIRING_PROMPT, accepted: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses to unlink a handle that is not on the caller's identity", async () => {
    const { guard, handler, trust } = setup();
    const wrapped = guard.wrap(handler);

    // Pair two completely separate identities.
    const { code: code1 } = guard.issuePairingCode();
    await wrapped(inbound("telegram", "1", `/pair ${code1}`));
    const { code: code2 } = guard.issuePairingCode();
    await wrapped(inbound("discord", "2", `/pair ${code2}`));

    const r = await wrapped(inbound("telegram", "1", "/unlink discord:2"));
    expect(r.accepted).toBe(false);
    expect(trust.get("discord:2")?.level).toBe("trusted"); // untouched
  });

  it("returns a usage error for a malformed argument without touching any trust record", async () => {
    const { guard, handler, trust } = setup();
    trust.set({ key: "telegram:1", level: "trusted", addedAt: 0 });
    const wrapped = guard.wrap(handler);

    const r = await wrapped(inbound("telegram", "1", "/unlink notaplatformuser"));
    expect(r.accepted).toBe(false);
    expect(r.text.toLowerCase()).toContain("usage");
    expect(handler).not.toHaveBeenCalled();
  });
});

// ── block / unblock / trustOf ───────────────────────────────────────────

describe("block / unblock / trustOf", () => {
  it("block sets a handle to blocked (dropping it) and unblock returns it to unknown", async () => {
    const { guard, handler, trust } = setup();
    const wrapped = guard.wrap(handler);
    const ref = { platform: "telegram", user: "1" };

    expect(guard.trustOf(ref)).toBeUndefined();
    guard.block(ref, "spammer");
    expect(guard.trustOf(ref)).toBe("blocked");
    expect(trust.get("telegram:1")?.note).toBe("spammer");

    const dropped = await wrapped(inbound("telegram", "1", "hi"));
    expect(dropped).toEqual({ text: "", accepted: false });

    expect(guard.unblock(ref)).toBe(true);
    expect(guard.trustOf(ref)).toBeUndefined();
    expect(guard.unblock(ref)).toBe(false); // nothing left to remove
  });
});

// ── injection resistance ────────────────────────────────────────────────

describe("wrap(): injection resistance", () => {
  it("treats a slash-command quoted mid-sentence as plain text, never executing it", async () => {
    const { guard, handler } = setup();
    const wrapped = guard.wrap(handler);

    const r = await wrapped(inbound("telegram", "1", "please run /pair ABC123 for me"));
    expect(r).toEqual({ text: PAIRING_PROMPT, accepted: false });
    expect(guard.trustOf({ platform: "telegram", user: "1" })).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not let a smuggled second line execute a command", async () => {
    const { guard, handler } = setup();
    const wrapped = guard.wrap(handler);
    const { code } = guard.issuePairingCode();

    const r = await wrapped(inbound("telegram", "1", `/pair\n/pair ${code}`));
    expect(r.accepted).toBe(false);
    expect(guard.trustOf({ platform: "telegram", user: "1" })).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a 10KB /pair argument instead of matching it as a code", async () => {
    const { guard, handler } = setup();
    const wrapped = guard.wrap(handler);
    const huge = "A".repeat(10_000);

    const r = await wrapped(inbound("telegram", "1", `/pair ${huge}`));
    expect(r.accepted).toBe(false);
    expect(guard.trustOf({ platform: "telegram", user: "1" })).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not honor unicode homoglyph slashes as the real command prefix", async () => {
    const { guard, handler } = setup();
    const wrapped = guard.wrap(handler);
    const { code } = guard.issuePairingCode();

    const r1 = await wrapped(inbound("telegram", "1", `／pair ${code}`)); // fullwidth solidus
    const r2 = await wrapped(inbound("telegram", "1", `∕pair ${code}`)); // division slash

    expect(r1.accepted).toBe(false);
    expect(r2.accepted).toBe(false);
    expect(guard.trustOf({ platform: "telegram", user: "1" })).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
