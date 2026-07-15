import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { RpcPeer } from "../a2a/rpc";

function pair() {
  const t = new InMemoryA2ATransport();
  const alice = new AgentEndpoint({ agentId: "alice", team: "t1" }, t, { idPrefix: "a" });
  const bob = new AgentEndpoint({ agentId: "bob", team: "t1" }, t, { idPrefix: "b" });
  return { alice, bob };
}

describe("RpcPeer", () => {
  it("round-trips a request to a served handler", async () => {
    const { alice, bob } = pair();
    new RpcPeer(bob).serve(async (payload) => {
      const { a, b } = payload as { a: number; b: number };
      return { sum: a + b };
    });
    const client = new RpcPeer(alice);

    const res = await client.request<{ sum: number }>(bob.address, { a: 2, b: 3 });
    expect(res.sum).toBe(5);
    expect(client.inFlight()).toBe(0);
  });

  it("propagates a handler error as a rejected promise", async () => {
    const { alice, bob } = pair();
    new RpcPeer(bob).serve(async () => {
      throw new Error("boom in handler");
    });
    const client = new RpcPeer(alice);
    await expect(client.request(bob.address, {})).rejects.toThrow("boom in handler");
    expect(client.inFlight()).toBe(0);
  });

  it("rejects on timeout when no response arrives", async () => {
    const { alice, bob } = pair();
    // Manual scheduler: capture the timeout callback and fire it on demand.
    let fire: (() => void) | undefined;
    const client = new RpcPeer(alice, {
      setTimeoutFn: (cb) => {
        fire = cb;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
    });
    // bob has no server → never responds.
    const p = client.request(bob.address, {}, { timeoutMs: 50 });
    expect(client.inFlight()).toBe(1);
    fire!();
    await expect(p).rejects.toThrow(/timed out after 50ms/);
    expect(client.inFlight()).toBe(0);
  });

  it("correlates concurrent requests independently", async () => {
    const { alice, bob } = pair();
    new RpcPeer(bob).serve(async (payload) => {
      const { echo } = payload as { echo: string };
      return { echo };
    });
    const client = new RpcPeer(alice);

    const [r1, r2, r3] = await Promise.all([
      client.request<{ echo: string }>(bob.address, { echo: "one" }),
      client.request<{ echo: string }>(bob.address, { echo: "two" }),
      client.request<{ echo: string }>(bob.address, { echo: "three" }),
    ]);
    expect([r1.echo, r2.echo, r3.echo]).toEqual(["one", "two", "three"]);
  });

  it("rejects in-flight requests when the peer closes", async () => {
    const { alice, bob } = pair();
    const client = new RpcPeer(alice);
    const p = client.request(bob.address, {}, { timeoutMs: 0 });
    client.close();
    await expect(p).rejects.toThrow("RPC peer closed");
  });
});
