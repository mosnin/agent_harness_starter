import { describe, it, expect } from "vitest";
import {
  InMemoryIdentityStore,
  IdentityLinker,
  ContinuityRouter,
} from "../gateway/continuity";
import type { ContinuityContext } from "../gateway/continuity";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

function inbound(platform: string, user: string, text: string, channel?: string): InboundMessage {
  return { platform: platform as InboundMessage["platform"], user, channel, text };
}

describe("InMemoryIdentityStore", () => {
  it("creates one identity per handle and resolves it back", () => {
    const store = new InMemoryIdentityStore();
    const a = store.resolveOrCreate({ platform: "telegram", user: "111" });
    const again = store.resolve({ platform: "telegram", user: "111" });
    expect(again?.id).toBe(a.id);
    expect(store.size()).toBe(1);
    expect(store.resolve({ platform: "slack", user: "U9" })).toBeUndefined();
  });

  it("links a second handle to the same identity", () => {
    const store = new InMemoryIdentityStore();
    const tg = store.resolveOrCreate({ platform: "telegram", user: "111" });
    store.link(tg.id, { platform: "slack", user: "U9" });
    expect(store.resolve({ platform: "slack", user: "U9" })?.id).toBe(tg.id);
    expect(store.size()).toBe(1);
    expect(tg.links).toHaveLength(2);
  });

  it("merges two identities and preserves the target's session", () => {
    const store = new InMemoryIdentityStore();
    const tg = store.resolveOrCreate({ platform: "telegram", user: "111" });
    store.setSession(tg.id, "sess-tg");
    const sl = store.resolveOrCreate({ platform: "slack", user: "U9" });
    store.setSession(sl.id, "sess-sl");

    store.link(tg.id, { platform: "slack", user: "U9" });

    expect(store.size()).toBe(1);
    const merged = store.resolve({ platform: "slack", user: "U9" });
    expect(merged?.id).toBe(tg.id);
    expect(merged?.sessionId).toBe("sess-tg"); // target keeps its own session
  });
});

describe("IdentityLinker", () => {
  it("binds a new channel when a valid code is redeemed", () => {
    const store = new InMemoryIdentityStore();
    const tg = store.resolveOrCreate({ platform: "telegram", user: "111" });
    let t = 1000;
    const linker = new IdentityLinker(store, { generateCode: () => "ABC123", now: () => t, ttlMs: 5000 });

    const code = linker.issueLinkCode(tg.id);
    expect(code).toBe("ABC123");

    const merged = linker.redeemLinkCode("ABC123", { platform: "slack", user: "U9" });
    expect(merged?.id).toBe(tg.id);
    expect(store.resolve({ platform: "slack", user: "U9" })?.id).toBe(tg.id);
  });

  it("rejects unknown, expired, and reused codes", () => {
    const store = new InMemoryIdentityStore();
    const tg = store.resolveOrCreate({ platform: "telegram", user: "111" });
    let t = 1000;
    const linker = new IdentityLinker(store, { generateCode: () => "CODE", now: () => t, ttlMs: 5000 });

    expect(linker.redeemLinkCode("nope", { platform: "slack", user: "U9" })).toBeNull();

    linker.issueLinkCode(tg.id);
    t = 7000; // past ttl
    expect(linker.redeemLinkCode("CODE", { platform: "slack", user: "U9" })).toBeNull();

    t = 8000;
    linker.issueLinkCode(tg.id);
    expect(linker.redeemLinkCode("CODE", { platform: "discord", user: "D1" })?.id).toBe(tg.id);
    // single-use: second redemption fails
    expect(linker.redeemLinkCode("CODE", { platform: "whatsapp", user: "W1" })).toBeNull();
  });
});

describe("ContinuityRouter", () => {
  it("carries one session id across channels and flags the switch", async () => {
    const store = new InMemoryIdentityStore();
    const tg = store.resolveOrCreate({ platform: "telegram", user: "111" });
    store.link(tg.id, { platform: "slack", user: "U9" });

    const seen: ContinuityContext[] = [];
    let counter = 0;
    const handler = async (_msg: InboundMessage, ctx: ContinuityContext): Promise<OutboundReply> => {
      seen.push(ctx);
      return { text: "ok", accepted: true };
    };
    const router = new ContinuityRouter(store, handler, { newSessionId: () => `sess-${++counter}` });

    await router.handle(inbound("telegram", "111", "hi from telegram"));
    await router.handle(inbound("slack", "U9", "continuing on slack"));

    expect(seen[0].sessionId).toBe("sess-1");
    expect(seen[1].sessionId).toBe("sess-1"); // same conversation across channels
    expect(seen[0].switchedChannel).toBe(false);
    expect(seen[1].switchedChannel).toBe(true); // telegram → slack
    expect(seen[0].identity.id).toBe(seen[1].identity.id);
  });

  it("gives separate sessions to unlinked users", async () => {
    const store = new InMemoryIdentityStore();
    const seen: ContinuityContext[] = [];
    let counter = 0;
    const router = new ContinuityRouter(
      store,
      async (_m, ctx) => {
        seen.push(ctx);
        return { text: "ok", accepted: true };
      },
      { newSessionId: () => `sess-${++counter}` }
    );

    await router.handle(inbound("telegram", "111", "a"));
    await router.handle(inbound("telegram", "222", "b"));

    expect(seen[0].sessionId).not.toBe(seen[1].sessionId);
    expect(store.size()).toBe(2);
  });

  it("reports where to reach an identity proactively (last seen channel)", async () => {
    const store = new InMemoryIdentityStore();
    const tg = store.resolveOrCreate({ platform: "telegram", user: "111" });
    store.link(tg.id, { platform: "slack", user: "U9", channel: "C1" });
    const router = new ContinuityRouter(store, async () => ({ text: "ok", accepted: true }));

    await router.handle(inbound("slack", "U9", "hey", "C1"));

    const dest = router.deliveryTargetFor(tg.id);
    expect(dest?.platform).toBe("slack");
    expect(dest?.target).toEqual({ user: "U9", channel: "C1" });
  });
});
