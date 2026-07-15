import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { RemoteA2ATransport } from "../a2a/remote-transport";
import { runA2AConformance } from "../a2a/conformance";
import type { A2AMessage } from "../a2a/types";

describe("A2A transport conformance parity", () => {
  it("InMemoryA2ATransport passes the full conformance battery (baseline)", async () => {
    const results = await runA2AConformance(() => new InMemoryA2ATransport());
    for (const r of results) {
      expect(r.ok, `${r.name}: ${r.detail ?? ""}`).toBe(true);
    }
    expect(results.length).toBe(6);
  });

  it("RemoteA2ATransport passes the SAME conformance battery (cross-process parity)", async () => {
    const results = await runA2AConformance(() => new RemoteA2ATransport());
    for (const r of results) {
      expect(r.ok, `${r.name}: ${r.detail ?? ""}`).toBe(true);
    }
    expect(results.length).toBe(6);
  });
});

describe("RemoteA2ATransport routing", () => {
  it("routes a direct send in O(1) — 5000 agents, one scan", async () => {
    const t = new RemoteA2ATransport();
    let target: AgentEndpoint | undefined;
    for (let i = 0; i < 5000; i++) {
      const ep = new AgentEndpoint({ agentId: `agent-${i}`, team: "x" }, t, {
        idPrefix: `agent-${i}`,
        now: () => 1,
      });
      if (i === 2500) target = ep;
    }
    const sender = new AgentEndpoint({ agentId: "sender", team: "x" }, t, {
      idPrefix: "sender",
      now: () => 1,
    });
    const seen: string[] = [];
    target!.on((m: A2AMessage) => seen.push(m.id));

    t.routeScans = 0;
    await sender.emit(target!.address, { hi: true });

    expect(t.routeScans).toBe(1);
    expect(seen.length).toBe(1);
  });

  it("silently drops a message to an unregistered agentId (no throw), still counts the attempt", async () => {
    const t = new RemoteA2ATransport();
    const sender = new AgentEndpoint({ agentId: "sender", team: "x" }, t, {
      idPrefix: "sender",
      now: () => 1,
    });
    t.routeScans = 0;
    expect(() => sender.emit({ agentId: "ghost", team: "x" }, { hi: true })).not.toThrow();
    // Direct sends always count exactly one scan attempt, hit or miss.
    expect(t.routeScans).toBe(1);
  });
});

describe("RemoteA2ATransport wire-safety", () => {
  it("survives a JSON round-trip: received payload deep-equals the sent payload", async () => {
    const t = new RemoteA2ATransport();
    const a = new AgentEndpoint({ agentId: "a", team: "x" }, t, { idPrefix: "a", now: () => 1 });
    const b = new AgentEndpoint({ agentId: "b", team: "x" }, t, { idPrefix: "b", now: () => 1 });

    const payload = {
      title: "héllo ☃ — 日本語",
      nested: { list: [1, 2, { deep: "✓", flag: false }], n: null },
      unicode: "🚀🔥",
    };
    const received: unknown[] = [];
    b.on((m: A2AMessage) => received.push(m.payload));
    await a.emit(b.address, payload);

    expect(received.length).toBe(1);
    // Deep equality proves the nested/unicode structure crossed the wire intact.
    expect(received[0]).toEqual(payload);
  });

  it("naturally drops function and undefined fields (documented JSON behavior)", async () => {
    const t = new RemoteA2ATransport();
    const a = new AgentEndpoint({ agentId: "a", team: "x" }, t, { idPrefix: "a", now: () => 1 });
    const b = new AgentEndpoint({ agentId: "b", team: "x" }, t, { idPrefix: "b", now: () => 1 });

    const payload = { kept: 1, fn: () => 42, missing: undefined };
    const received: Array<Record<string, unknown>> = [];
    b.on((m: A2AMessage) => received.push(m.payload as Record<string, unknown>));
    await a.emit(b.address, payload);

    expect(received.length).toBe(1);
    // JSON.stringify drops functions and undefined values — the wire is JSON, so they vanish.
    expect(received[0]).toEqual({ kept: 1 });
    expect("fn" in received[0]).toBe(false);
    expect("missing" in received[0]).toBe(false);
  });
});
