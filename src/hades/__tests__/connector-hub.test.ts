import { describe, it, expect } from "vitest";
import { RateLimiter } from "../gateway/rate-limiter";
import { ConnectorHub } from "../gateway/connector";
import { InMemoryConnector } from "../gateway/in-memory-connector";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

const echoHandler = async (m: InboundMessage): Promise<OutboundReply> => ({
  text: `echo: ${m.text}`,
  accepted: true,
});

describe("RateLimiter", () => {
  it("allows up to capacity then blocks, refilling over time", () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 2, refillMs: 1000, now: () => t });
    expect(rl.tryAcquire("u")).toBe(true);
    expect(rl.tryAcquire("u")).toBe(true);
    expect(rl.tryAcquire("u")).toBe(false); // empty
    t = 600; // 60% of a window → 1.2 tokens
    expect(rl.tryAcquire("u")).toBe(true);
    expect(rl.tryAcquire("u")).toBe(false);
  });

  it("tracks buckets per key", () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 1, refillMs: 1000, now: () => t });
    expect(rl.tryAcquire("a")).toBe(true);
    expect(rl.tryAcquire("b")).toBe(true); // different key, own bucket
    expect(rl.tryAcquire("a")).toBe(false);
  });
});

describe("ConnectorHub", () => {
  it("routes inbound messages through the handler and delivers replies", async () => {
    const hub = new ConnectorHub(echoHandler);
    const conn = new InMemoryConnector("slack");
    hub.register(conn);
    await hub.startAll();

    const reply = await conn.receive({ user: "U1", channel: "C1", text: "hi" });
    expect(reply.text).toBe("echo: hi");
    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].text).toBe("echo: hi");

    await hub.stopAll();
    expect(conn.isRunning()).toBe(false);
  });

  it("rate-limits a chatty user and mirrors traffic", async () => {
    let t = 0;
    const mirrored: string[] = [];
    const hub = new ConnectorHub(echoHandler, {
      rateLimiter: new RateLimiter({ capacity: 1, refillMs: 10_000, now: () => t }),
      mirror: (e) => mirrored.push(`${e.direction}:${e.text}`),
      rateLimitedReply: "slow down",
    });
    const conn = new InMemoryConnector("telegram");
    hub.register(conn);
    await hub.startAll();

    const first = await conn.receive({ user: "U1", text: "1" });
    expect(first.text).toBe("echo: 1");
    const second = await conn.receive({ user: "U1", text: "2" });
    expect(second.text).toBe("slow down");
    expect(second.accepted).toBe(false);

    expect(mirrored.some((m) => m.startsWith("in:1"))).toBe(true);
    expect(mirrored.some((m) => m.startsWith("out:echo: 1"))).toBe(true);
  });

  it("delivers proactive messages to a registered platform", async () => {
    const hub = new ConnectorHub(echoHandler);
    const conn = new InMemoryConnector("discord");
    hub.register(conn);
    expect(await hub.deliver("discord", { user: "U1" }, "report ready")).toBe(true);
    expect(await hub.deliver("nope", { user: "U1" }, "x")).toBe(false);
    expect(conn.sent[0].text).toBe("report ready");
  });
});
