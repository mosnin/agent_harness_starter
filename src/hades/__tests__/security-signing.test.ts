import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { HmacSigner, SigningA2ATransport, signToken, verifyToken } from "../security/signing";
import { CapabilityMinter } from "../security/tokens";
import type { A2AMessage } from "../a2a/types";

describe("HmacSigner", () => {
  it("verifies its own signatures and rejects tampering", () => {
    const s = new HmacSigner("team-secret");
    const sig = s.sign("hello");
    expect(s.verify("hello", sig)).toBe(true);
    expect(s.verify("hell0", sig)).toBe(false);
    expect(new HmacSigner("other").verify("hello", sig)).toBe(false);
  });
});

describe("token signing", () => {
  it("round-trips and detects mutation", () => {
    const signer = new HmacSigner("k");
    const minter = new CapabilityMinter({ now: () => 0 });
    const tok = signToken(minter.mint({ agentId: "a", team: "t", capabilities: ["code"] }), signer);
    expect(verifyToken(tok, signer)).toBe(true);

    const tampered = { ...tok, capabilities: ["code", "deploy"] }; // privilege escalation attempt
    expect(verifyToken(tampered, signer)).toBe(false);
  });
});

describe("SigningA2ATransport", () => {
  function team(secret: string) {
    const inner = new InMemoryA2ATransport();
    const transport = new SigningA2ATransport(inner, new HmacSigner(secret));
    const alice = new AgentEndpoint({ agentId: "alice", team: "t" }, transport, { idPrefix: "a" });
    const bob = new AgentEndpoint({ agentId: "bob", team: "t" }, transport, { idPrefix: "b" });
    return { inner, alice, bob };
  }

  it("signs outgoing and delivers verified messages", async () => {
    const { alice, bob } = team("shared");
    void alice.emit(bob.address, { hello: true });
    const got = await bob.receive();
    expect(got.from.agentId).toBe("alice");
    expect(got.sig).toBeTruthy();
  });

  it("drops a tampered message before it reaches the mailbox", async () => {
    const inner = new InMemoryA2ATransport();
    const rejects: string[] = [];
    const transport = new SigningA2ATransport(inner, new HmacSigner("shared"), {
      onReject: (_m, reason) => rejects.push(reason),
    });
    const bob = new AgentEndpoint({ agentId: "bob", team: "t" }, transport, { idPrefix: "b" });
    let delivered = 0;
    bob.on(() => delivered++);

    // A rogue publishes directly on the inner transport with a forged/absent signature.
    const forged: A2AMessage = {
      id: "x1",
      from: { agentId: "attacker", team: "t" },
      to: bob.address,
      kind: "event",
      payload: { evil: true },
      ts: 1,
      sig: "deadbeef",
    };
    inner.publish(forged);
    expect(delivered).toBe(0);
    expect(rejects).toContain("bad signature");
  });

  it("drops messages signed with the wrong team secret", async () => {
    const inner = new InMemoryA2ATransport();
    const good = new SigningA2ATransport(inner, new HmacSigner("real"));
    const bob = new AgentEndpoint({ agentId: "bob", team: "t" }, good, { idPrefix: "b" });
    let delivered = 0;
    bob.on(() => delivered++);

    // Attacker signs with a different secret but publishes to the same inner bus.
    const evilTransport = new SigningA2ATransport(inner, new HmacSigner("wrong"));
    const mallory = new AgentEndpoint({ agentId: "mallory", team: "t" }, evilTransport, { idPrefix: "m" });
    void mallory.emit(bob.address, { spoof: true });
    expect(delivered).toBe(0);
  });
});
