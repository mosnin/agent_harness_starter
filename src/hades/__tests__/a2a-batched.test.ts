import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { MessagePool } from "../a2a/pool";
import { BatchedA2ATransport } from "../a2a/batched";
import { MessageFactory } from "../a2a/types";
import type { A2AMessage } from "../a2a/types";
import { benchBatchedThroughput } from "../bench/a2a-batch-bench";

interface Box {
  n: number;
  tag: string;
}

const makeBox = (): Box => ({ n: 0, tag: "" });
const resetBox = (b: Box): void => {
  b.n = 0;
  b.tag = "";
};

describe("MessagePool", () => {
  it("reuses released objects instead of creating new ones", () => {
    const pool = new MessagePool<Box>(makeBox, resetBox);
    const N = 8;

    const first = Array.from({ length: N }, () => pool.acquire());
    expect(pool.stats().created).toBe(N);
    expect(pool.stats().reused).toBe(0);
    expect(pool.stats().inUse).toBe(N);

    for (const b of first) pool.release(b);
    expect(pool.idleCount()).toBe(N);
    expect(pool.stats().inUse).toBe(0);

    const second = Array.from({ length: N }, () => pool.acquire());
    const s = pool.stats();
    expect(s.created).toBe(N); // no new objects built
    expect(s.reused).toBe(N); // whole second round reused
    expect(s.acquired).toBe(2 * N);
    expect(s.inUse).toBe(N);
    expect(s.idle).toBe(0);
    // Objects are recycled instances from the first round.
    expect(second.every((b) => first.includes(b))).toBe(true);
  });

  it("resets objects on release so re-acquired ones are clean", () => {
    const pool = new MessagePool<Box>(makeBox, resetBox);
    const b = pool.acquire();
    b.n = 42;
    b.tag = "dirty";
    pool.release(b);

    const again = pool.acquire();
    expect(again).toBe(b); // same instance
    expect(again.n).toBe(0);
    expect(again.tag).toBe("");
  });

  it("caps the idle set at maxIdle, dropping excess releases", () => {
    const maxIdle = 4;
    const pool = new MessagePool<Box>(makeBox, resetBox, { maxIdle });
    const objs = Array.from({ length: 10 }, () => pool.acquire());
    for (const b of objs) pool.release(b);

    expect(pool.idleCount()).toBe(maxIdle);
    expect(pool.stats().idle).toBe(maxIdle);
    expect(pool.stats().released).toBe(10);
    expect(pool.stats().inUse).toBe(0);
  });
});

describe("BatchedA2ATransport", () => {
  function pair(inner: InMemoryA2ATransport) {
    const receiver = new AgentEndpoint({ agentId: "receiver", team: "t" }, inner, { idPrefix: "r" });
    const factory = new MessageFactory({ agentId: "sender", team: "t" }, { idPrefix: "s" });
    const got: A2AMessage[] = [];
    receiver.on((m) => got.push(m));
    return { receiver, factory, got };
  }

  it("preserves per-link order across a flush", () => {
    const inner = new InMemoryA2ATransport();
    const { receiver, factory, got } = pair(inner);
    const batched = new BatchedA2ATransport(inner);

    const labels = ["A", "B", "C", "D", "E"];
    for (const label of labels) {
      batched.publish(factory.event(receiver.address, { label }));
    }
    expect(got.length).toBe(0); // nothing delivered until flush
    batched.flush();

    expect(got.map((m) => (m.payload as { label: string }).label)).toEqual(labels);
  });

  it("delivers all messages exactly once (none dropped or duplicated)", () => {
    const inner = new InMemoryA2ATransport();
    const { receiver, factory, got } = pair(inner);
    const batched = new BatchedA2ATransport(inner, { maxBatch: 1000 });

    const N = 500;
    for (let i = 0; i < N; i++) {
      batched.publish(factory.event(receiver.address, { n: i }));
    }
    batched.flush();

    expect(got.length).toBe(N);
    const seq = got.map((m) => (m.payload as { n: number }).n);
    expect(seq).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it("flushes synchronously when the queue reaches maxBatch", () => {
    const inner = new InMemoryA2ATransport();
    const { receiver, factory, got } = pair(inner);
    // A scheduleFlush we NEVER invoke — so any delivery must be the sync path.
    let scheduledCalls = 0;
    const batched = new BatchedA2ATransport(inner, {
      maxBatch: 3,
      scheduleFlush: () => {
        scheduledCalls++;
      },
    });

    batched.publish(factory.event(receiver.address, { n: 0 }));
    batched.publish(factory.event(receiver.address, { n: 1 }));
    expect(batched.pending()).toBe(2);
    expect(got.length).toBe(0);

    // Third publish hits maxBatch → synchronous flush.
    batched.publish(factory.event(receiver.address, { n: 2 }));
    expect(batched.pending()).toBe(0);
    expect(got.length).toBe(3);
  });

  it("uses an injectable scheduleFlush; pending clears when the callback runs", () => {
    const inner = new InMemoryA2ATransport();
    const { receiver, factory, got } = pair(inner);
    let captured: (() => void) | null = null;
    const batched = new BatchedA2ATransport(inner, {
      maxBatch: 100,
      scheduleFlush: (cb) => {
        captured = cb;
      },
    });

    batched.publish(factory.event(receiver.address, { n: 0 }));
    batched.publish(factory.event(receiver.address, { n: 1 }));
    expect(batched.pending()).toBe(2);
    expect(captured).not.toBeNull();

    // Invoke the captured flush callback.
    (captured as unknown as () => void)();
    expect(batched.pending()).toBe(0);
    expect(got.length).toBe(2);
  });

  it("benchBatchedThroughput reports positive throughput and real flushes", async () => {
    const r = await benchBatchedThroughput({ messages: 2000, maxBatch: 128 });
    expect(r.messages).toBe(2000);
    expect(r.batchedMsgsPerSec).toBeGreaterThan(0);
    expect(r.directMsgsPerSec).toBeGreaterThan(0);
    expect(r.flushes).toBeGreaterThan(0);
  });
});
