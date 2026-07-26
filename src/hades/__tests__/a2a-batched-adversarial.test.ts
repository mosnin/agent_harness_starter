import { describe, it, expect, vi } from "vitest";
import { MessagePool } from "../a2a/pool";
import { BatchedA2ATransport } from "../a2a/batched";
import { InMemoryA2ATransport } from "../a2a/bus";
import type { A2ATransport } from "../a2a/bus";
import type { A2AMessage, AgentAddress } from "../a2a/types";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

interface Cell {
  v: number;
  tag: string;
}
function makePool(opts?: { maxIdle?: number }) {
  let built = 0;
  const factory = (): Cell => {
    built++;
    return { v: -1, tag: "fresh" };
  };
  const reset = (c: Cell) => {
    c.v = 0;
    c.tag = "reset";
  };
  const pool = new MessagePool<Cell>(factory, reset, opts);
  return { pool, builtCount: () => built };
}

// deterministic PRNG so a flaky failure is reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function msg(from: string, to: string, seq: number): A2AMessage<{ seq: number }> {
  return {
    id: `${from}#${seq}`,
    from: { agentId: from },
    to: { agentId: to },
    kind: "event",
    payload: { seq },
    ts: 0,
  };
}
const seqOf = (m: A2AMessage) => (m.payload as { seq: number }).seq;

/** Records everything inner.publish receives; also usable as the inner transport. */
function recordingInner() {
  const t = new InMemoryA2ATransport();
  const got: A2AMessage[] = [];
  t.register({ agentId: "recv" }, (m) => got.push(m));
  return { transport: t as A2ATransport, got };
}

/** A bare inner that only counts publishes — for no-op assertions. */
function countingInner() {
  let publishes = 0;
  const got: A2AMessage[] = [];
  const transport: A2ATransport = {
    publish(m: A2AMessage) {
      publishes++;
      got.push(m);
    },
    register(_addr: AgentAddress, _handler: (m: A2AMessage) => void) {
      return () => {};
    },
  };
  return { transport, got, publishCount: () => publishes };
}

/* ================================================================== */
/* POOL                                                               */
/* ================================================================== */

describe("MessagePool — adversarial", () => {
  it("never hands out an aliased in-use object; reuses idle and resets it", () => {
    const { pool } = makePool();
    const a = pool.acquire();
    const b = pool.acquire();
    expect(a).not.toBe(b); // two in-use objects are distinct references

    a.v = 99;
    a.tag = "dirty";
    pool.release(a);

    const c = pool.acquire();
    expect(c).toBe(a); // the released object is recycled
    expect(c.v).toBe(0); // reset() ran
    expect(c.tag).toBe("reset");
    expect(pool.stats().reused).toBe(1);

    // c (== a) is now in use again — a further acquire must NOT re-issue it.
    const d = pool.acquire();
    expect(d).not.toBe(c);
    expect(d).not.toBe(b);

    const s = pool.stats();
    expect(s.created).toBe(3); // a, b, d
    expect(s.acquired).toBe(4); // a, b, c(reuse), d
    expect(s.reused).toBe(1);
    expect(s.inUse).toBe(3); // b, c(=a), d checked out; only a was released
  });

  it("keeps stats invariants across a randomized acquire/release sequence", () => {
    const { pool } = makePool();
    const rand = rng(0xc0ffee);
    const seen = new Set<Cell>();
    const checkedOut: Cell[] = [];
    let expCreated = 0;
    let expReused = 0;
    let acquires = 0;
    let releases = 0;

    for (let i = 0; i < 600; i++) {
      const doAcquire = checkedOut.length === 0 || rand() < 0.6;
      if (doAcquire) {
        const idleBefore = pool.idleCount();
        const o = pool.acquire();
        acquires++;
        // aliasing guard: acquired object must not already be checked out.
        expect(checkedOut.includes(o)).toBe(false);
        if (idleBefore > 0) {
          expReused++; // reuse ONLY when an idle object was available
        } else {
          expCreated++;
          expect(seen.has(o)).toBe(false); // a genuinely new object
        }
        seen.add(o);
        checkedOut.push(o);
      } else {
        const idx = Math.floor(rand() * checkedOut.length);
        const o = checkedOut.splice(idx, 1)[0];
        pool.release(o);
        releases++;
      }
    }

    const s = pool.stats();
    expect(s.created).toBe(seen.size); // created == distinct objects ever made
    expect(s.created).toBe(expCreated);
    expect(s.reused).toBe(expReused);
    expect(s.acquired).toBe(s.reused + s.created); // acquired == reused + created
    expect(s.inUse).toBe(s.acquired - s.released); // inUse == acquired - released
    expect(s.inUse).toBe(checkedOut.length);
    expect(s.idle).toBe(pool.idleCount());
    expect(s.acquired).toBe(acquires);
    expect(s.released).toBe(releases);
  });

  it("enforces a hard maxIdle bound; dropped objects are never reused", () => {
    const { pool } = makePool({ maxIdle: 2 });
    const first = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()];
    const original = new Set(first);
    expect(original.size).toBe(5);
    expect(pool.stats().created).toBe(5);

    for (const o of first) pool.release(o);
    expect(pool.idleCount()).toBe(2); // hard cap: only 2 retained, 3 dropped

    // Next acquires: exactly 2 come from the retained idle set, the rest are new.
    const second = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()];
    const reusedOnes = second.filter((o) => original.has(o));
    const createdOnes = second.filter((o) => !original.has(o));
    expect(reusedOnes.length).toBe(2); // only the 2 pooled were reusable
    expect(createdOnes.length).toBe(3); // the 3 dropped forced fresh allocations

    const s = pool.stats();
    expect(s.reused).toBe(2);
    expect(s.created).toBe(8); // 5 + 3 new
    // No dropped object was silently handed back twice.
    expect(new Set(second).size).toBe(5);
  });
});

/* ================================================================== */
/* BATCHED TRANSPORT                                                  */
/* ================================================================== */

describe("BatchedA2ATransport — adversarial", () => {
  it("preserves per-sender FIFO order when two senders interleave", () => {
    const { transport, got } = recordingInner();
    let flushCb: (() => void) | null = null;
    const b = new BatchedA2ATransport(transport, {
      scheduleFlush: (cb) => {
        flushCb = cb;
      },
    });

    // Interleave s1 and s2, each with a monotonic per-sender seq.
    const order: Array<[string, number]> = [
      ["s1", 0],
      ["s2", 0],
      ["s1", 1],
      ["s1", 2],
      ["s2", 1],
      ["s2", 2],
      ["s1", 3],
      ["s2", 3],
      ["s2", 4],
      ["s1", 4],
    ];
    for (const [from, seq] of order) b.publish(msg(from, "recv", seq));

    expect(got.length).toBe(0); // nothing delivered before flush
    b.flush();

    // Global order equals publish order (FIFO drain).
    expect(got.map((m) => [m.from.agentId, seqOf(m)])).toEqual(order);
    // Per-sender subsequence is strictly the sender's send order.
    expect(got.filter((m) => m.from.agentId === "s1").map(seqOf)).toEqual([0, 1, 2, 3, 4]);
    expect(got.filter((m) => m.from.agentId === "s2").map(seqOf)).toEqual([0, 1, 2, 3, 4]);
    expect(b.pending()).toBe(0);
    // A scheduled flush was requested at least once but drove no duplicate delivery.
    expect(flushCb).not.toBeNull();
  });

  it("loses and duplicates nothing across multiple flush cycles", () => {
    const { transport, got } = recordingInner();
    const b = new BatchedA2ATransport(transport, { scheduleFlush: () => {} });

    for (let i = 0; i < 30; i++) b.publish(msg("s1", "recv", i));
    expect(b.pending()).toBe(30);
    b.flush();
    expect(b.pending()).toBe(0);
    expect(got.length).toBe(30);

    for (let i = 30; i < 50; i++) b.publish(msg("s1", "recv", i));
    expect(b.pending()).toBe(20);
    b.flush();
    expect(b.pending()).toBe(0);

    const seqs = got.map(seqOf);
    expect(seqs.length).toBe(50);
    expect(new Set(seqs).size).toBe(50); // no duplication
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i)); // no loss, in order
  });

  it("flushes synchronously at maxBatch and delivers the tail on manual flush", () => {
    const { transport, got } = recordingInner();
    const sizes: number[] = [];
    // scheduleFlush is provided but NEVER invoked — only sync flushes may fire.
    const scheduleFlush = vi.fn();
    const b = new BatchedA2ATransport(transport, {
      maxBatch: 10,
      scheduleFlush,
      onFlush: (n) => sizes.push(n),
    });

    for (let i = 0; i < 25; i++) b.publish(msg("s1", "recv", i));

    expect(sizes).toEqual([10, 10]); // two synchronous flushes at 10 and 20
    expect(got.length).toBe(20);
    expect(b.pending()).toBe(5); // remainder queued, not yet flushed

    b.flush();
    expect(sizes).toEqual([10, 10, 5]); // manual flush drains the tail
    expect(b.pending()).toBe(0);
    expect(got.map(seqOf)).toEqual(Array.from({ length: 25 }, (_, i) => i)); // all in order
  });

  it("treats an empty flush as a no-op (no inner.publish, no onFlush)", () => {
    const { transport, publishCount } = countingInner();
    const onFlush = vi.fn();
    const b = new BatchedA2ATransport(transport, { scheduleFlush: () => {}, onFlush });

    b.flush();
    b.flush();

    expect(publishCount()).toBe(0);
    expect(onFlush).not.toHaveBeenCalled();
    expect(b.pending()).toBe(0);
  });

  it("schedules a flush at most once per pending batch (double-schedule guard)", () => {
    const { transport, got } = recordingInner();
    let scheduled: (() => void) | null = null;
    const scheduleFlush = vi.fn((cb: () => void) => {
      scheduled = cb;
    });
    const b = new BatchedA2ATransport(transport, { maxBatch: 1000, scheduleFlush });

    for (let i = 0; i < 5; i++) b.publish(msg("s1", "recv", i));
    expect(scheduleFlush).toHaveBeenCalledTimes(1); // ONE schedule for 5 publishes
    expect(b.pending()).toBe(5);
    expect(got.length).toBe(0);

    // Run the scheduled flush; the scheduled flag must reset.
    expect(scheduled).not.toBeNull();
    scheduled!();
    expect(b.pending()).toBe(0);
    expect(got.length).toBe(5);

    // A new publish must schedule again (flag was reset).
    b.publish(msg("s1", "recv", 5));
    expect(scheduleFlush).toHaveBeenCalledTimes(2);
  });

  it("delegates register() to the inner transport", () => {
    const registered: AgentAddress[] = [];
    let unsubbed = false;
    const inner: A2ATransport = {
      publish() {},
      register(addr) {
        registered.push(addr);
        return () => {
          unsubbed = true;
        };
      },
    };
    const b = new BatchedA2ATransport(inner);
    const off = b.register({ agentId: "recv" }, () => {});
    expect(registered).toEqual([{ agentId: "recv" }]);
    off();
    expect(unsubbed).toBe(true);
  });

  it("uses queueMicrotask by default to flush asynchronously", async () => {
    const { transport, got } = recordingInner();
    const b = new BatchedA2ATransport(transport); // no scheduleFlush → default microtask

    b.publish(msg("s1", "recv", 0));
    b.publish(msg("s1", "recv", 1));
    expect(got.length).toBe(0); // not flushed synchronously
    expect(b.pending()).toBe(2);

    await Promise.resolve(); // let the microtask run
    expect(got.map(seqOf)).toEqual([0, 1]);
    expect(b.pending()).toBe(0);
  });
});
