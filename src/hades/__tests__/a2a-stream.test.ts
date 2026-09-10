import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { StreamPeer, AsyncQueue } from "../a2a/stream";

function pair() {
  const t = new InMemoryA2ATransport();
  const alice = new AgentEndpoint({ agentId: "alice", team: "t1" }, t, { idPrefix: "a" });
  const bob = new AgentEndpoint({ agentId: "bob", team: "t1" }, t, { idPrefix: "b" });
  return { alice, bob };
}

describe("AsyncQueue", () => {
  it("yields buffered values in order then completes", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    const out: number[] = [];
    for await (const v of q.iterator()) out.push(v);
    expect(out).toEqual([1, 2]);
  });

  it("flags overflow past the high-water mark", () => {
    const q = new AsyncQueue<number>(2);
    q.push(1);
    q.push(2);
    expect(q.overflowed()).toBe(false);
    q.push(3);
    expect(q.overflowed()).toBe(true);
    expect(q.size()).toBe(3);
  });

  it("propagates failure to the consumer", async () => {
    const q = new AsyncQueue<number>();
    q.fail(new Error("kaboom"));
    await expect(
      (async () => {
        for await (const _ of q.iterator()) void _;
      })()
    ).rejects.toThrow("kaboom");
  });
});

describe("StreamPeer", () => {
  it("streams chunks in order and completes", async () => {
    const { alice, bob } = pair();
    new StreamPeer(bob).serveStream(async function* (payload) {
      const { n } = payload as { n: number };
      for (let i = 1; i <= n; i++) yield { i };
    });
    const client = new StreamPeer(alice);

    const chunks: number[] = [];
    for await (const c of client.requestStream<{ i: number }>(bob.address, { n: 4 })) {
      chunks.push(c.i);
    }
    expect(chunks).toEqual([1, 2, 3, 4]);
  });

  it("surfaces a producer error to the consumer", async () => {
    const { alice, bob } = pair();
    new StreamPeer(bob).serveStream(async function* () {
      yield { ok: 1 };
      throw new Error("producer failed midstream");
    });
    const client = new StreamPeer(alice);

    const got: unknown[] = [];
    await expect(
      (async () => {
        for await (const c of client.requestStream(bob.address, {})) got.push(c);
      })()
    ).rejects.toThrow("producer failed midstream");
    expect(got).toEqual([{ ok: 1 }]); // received the chunk before the failure
  });

  it("runs independent streams concurrently", async () => {
    const { alice, bob } = pair();
    new StreamPeer(bob).serveStream(async function* (payload) {
      const { tag, n } = payload as { tag: string; n: number };
      for (let i = 0; i < n; i++) yield `${tag}${i}`;
    });
    const client = new StreamPeer(alice);

    const collect = async (tag: string, n: number) => {
      const out: string[] = [];
      for await (const c of client.requestStream<string>(bob.address, { tag, n })) out.push(c);
      return out;
    };
    const [a, b] = await Promise.all([collect("a", 3), collect("b", 2)]);
    expect(a).toEqual(["a0", "a1", "a2"]);
    expect(b).toEqual(["b0", "b1"]);
  });
});
