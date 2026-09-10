import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";

describe("A2A routing performance", () => {
  it("dispatches a direct message in O(1) regardless of roster size", async () => {
    const t = new InMemoryA2ATransport();
    // 10k agents connected.
    const endpoints = Array.from({ length: 10_000 }, (_, i) =>
      new AgentEndpoint({ agentId: `w${i}`, team: "big" }, t, { idPrefix: `w${i}` })
    );
    const sender = endpoints[0];
    const target = endpoints[9999];

    t.routeScans = 0;
    void sender.emit(target.address, { ping: true });
    // Exactly ONE subscriber comparison — not 10k.
    expect(t.routeScans).toBe(1);
    const got = await target.receive();
    expect(got.from.agentId).toBe("w0");
  });

  it("10k point-to-point sends stay O(1) each (no quadratic blowup)", () => {
    const t = new InMemoryA2ATransport();
    const a = new AgentEndpoint({ agentId: "a", team: "x" }, t, { idPrefix: "a" });
    const b = new AgentEndpoint({ agentId: "b", team: "x" }, t, { idPrefix: "b" });
    // Pad the roster so an O(N) scan would explode.
    for (let i = 0; i < 5000; i++) new AgentEndpoint({ agentId: `pad${i}` }, t, { idPrefix: `p${i}` });

    t.routeScans = 0;
    b.on(() => {});
    for (let i = 0; i < 10_000; i++) void a.emit(b.address, { i });
    // 10k sends × 1 scan each = 10k, not 10k × 5002.
    expect(t.routeScans).toBe(10_000);
  });

  it("broadcast fans out but only to its team", () => {
    const t = new InMemoryA2ATransport();
    const a = new AgentEndpoint({ agentId: "a", team: "t1" }, t, { idPrefix: "a" });
    new AgentEndpoint({ agentId: "b", team: "t1" }, t, { idPrefix: "b" });
    new AgentEndpoint({ agentId: "c", team: "t2" }, t, { idPrefix: "c" });

    t.routeScans = 0;
    void a.broadcast({ n: 1 }, { team: "t1" });
    // Scans all 3 subscribers (fan-out), delivers to the one t1 teammate.
    expect(t.routeScans).toBe(3);
  });
});
