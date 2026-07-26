import { describe, it, expect } from "vitest";
import { summarize, measure, BenchSuite } from "../bench/harness";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { RpcPeer } from "../a2a/rpc";

describe("summarize", () => {
  it("computes throughput and latency percentiles", () => {
    const s = summarize([10, 20, 30, 40]);
    expect(s.count).toBe(4);
    expect(s.meanMs).toBe(25);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.p50).toBe(20);
    expect(s.p95).toBe(40);
    expect(s.opsPerSec).toBeCloseTo(1000 / 25, 5);
  });

  it("handles the empty case", () => {
    expect(summarize([])).toMatchObject({ count: 0, opsPerSec: 0 });
  });
});

describe("measure", () => {
  it("times each op deterministically with an injected clock", async () => {
    // now() returns pairs: (0,5),(5,12),(12,20) → durations 5,7,8.
    const ticks = [0, 5, 5, 12, 12, 20];
    let i = 0;
    const now = () => ticks[i++];
    const stats = await measure(async () => undefined, 3, now);
    expect(stats.count).toBe(3);
    expect(stats.min).toBe(5);
    expect(stats.max).toBe(8);
    expect(stats.totalMs).toBe(20);
  });
});

describe("BenchSuite A2A round-trip", () => {
  it("benchmarks RPC round-trips and renders a table", async () => {
    const transport = new InMemoryA2ATransport();
    const alice = new AgentEndpoint({ agentId: "alice", team: "t" }, transport, { idPrefix: "a" });
    const bob = new AgentEndpoint({ agentId: "bob", team: "t" }, transport, { idPrefix: "b" });
    new RpcPeer(bob).serve(async (p) => p);
    const client = new RpcPeer(alice);

    // Deterministic clock: 2ms per op.
    let t = 0;
    const suite = new BenchSuite(() => (t += 2));
    const stats = await suite.run("a2a.roundtrip", async () => {
      await client.request(bob.address, { ping: true });
    }, 5);

    expect(stats.count).toBe(5);
    expect(suite.report()).toHaveLength(1);
    expect(suite.table()).toContain("a2a.roundtrip");
  });
});
