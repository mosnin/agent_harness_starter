import { describe, it, expect } from "vitest";
import { CreditController, BackpressuredChannel } from "../a2a/backpressure";
import type { FlowStats } from "../a2a/backpressure";

/* ------------------------------------------------------------------ *
 * Adversarial suite for the A2A credit-based backpressure primitives. *
 * These tests try to BREAK a correct implementation. Every assertion  *
 * encodes a contract clause; a failure names the probable bug.        *
 * ------------------------------------------------------------------ */

/* ---------------------------- helpers ----------------------------- */

/** Deterministic PRNG so any flaky failure is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Flush `n` microtask turns (never advances macrotask timers). */
async function microtasks(n: number) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * Blast `n` items through a channel of the given capacity with a
 * consumer whose delay VARIES per item. An independent live counter
 * (incremented at consume entry, decremented at exit) tracks the true
 * peak concurrency — we do NOT trust stats() to police itself.
 *
 * The first `capacity * 3` items each hold across a real macrotask
 * (setTimeout 0). Because the send loop only advances on microtasks,
 * this GUARANTEES the ceiling is actually reached (peak === capacity)
 * without ever being allowed to breach it — the rest of the stream
 * uses mixed immediate / micro / macro delays so the invariant is
 * exercised under genuinely irregular completion timing.
 */
async function blast(capacity: number, n: number, seed: number) {
  const rand = rng(seed);
  let live = 0;
  let peak = 0;
  const consumedItems: number[] = [];

  const consume = async (item: number): Promise<void> => {
    live++;
    if (live > peak) peak = live;
    try {
      if (item < capacity * 3) {
        // guaranteed-ceiling segment: park across a macrotask
        await sleep(0);
      } else {
        const r = rand();
        if (r < 0.35) {
          /* resolve immediately (no await) */
        } else if (r < 0.6) {
          await Promise.resolve();
        } else if (r < 0.8) {
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        } else {
          await sleep(0);
        }
      }
      consumedItems.push(item);
    } finally {
      live--;
    }
  };

  const ch = new BackpressuredChannel<number>(capacity, consume);
  for (let i = 0; i < n; i++) await ch.send(i);
  await ch.drain();

  return { peak, consumedItems, stats: ch.stats() as FlowStats };
}

/* ---------------------------------------------------------------- *
 * 1 + 2. Hard invariant: maxInFlight <= capacity, ALWAYS, and the  *
 * independently instrumented peak agrees with stats().             *
 * ---------------------------------------------------------------- */

describe("maxInFlight never breaches capacity (blast of 2000)", () => {
  for (const capacity of [1, 3, 7]) {
    it(`capacity ${capacity}: peak hits the ceiling but never exceeds it`, async () => {
      const n = 2000;
      const { peak, consumedItems, stats } = await blast(capacity, n, 0xc0ffee + capacity);

      // (2) independent instrument: my own live counter's peak.
      expect(peak).toBeLessThanOrEqual(capacity); // BREACH => concurrency bug
      expect(peak).toBe(capacity); // ceiling must actually be reached

      // (1) stats must agree with the independent instrument and obey the cap.
      expect(stats.maxInFlight).toBeLessThanOrEqual(capacity); // BREACH
      expect(stats.maxInFlight).toBe(capacity);
      expect(stats.maxInFlight).toBe(peak); // stats miscomputed maxInFlight?

      // no lost / duplicated work.
      expect(stats.consumed).toBe(n);
      expect(stats.sent).toBe(n);
      expect(consumedItems.length).toBe(n);
      expect(new Set(consumedItems).size).toBe(n); // exactly-once
    });
  }
});

/* ---------------------------------------------------------------- *
 * send() must NOT await consume — it resolves on credit acquire.   *
 * ---------------------------------------------------------------- */

describe("send resolves on credit acquisition, not on consume completion", () => {
  it("returns while the consume is still running", async () => {
    let consumeDone = false;
    const ch = new BackpressuredChannel<number>(1, async () => {
      await sleep(30);
      consumeDone = true;
    });
    await ch.send(0);
    // If send awaited consume, consumeDone would already be true here.
    expect(consumeDone).toBe(false);
    await ch.drain();
    expect(consumeDone).toBe(true);
  });

  it("applies backpressure: a second send blocks until a credit frees", async () => {
    const ch = new BackpressuredChannel<number>(1, async () => {
      await sleep(30);
    });
    await ch.send(0); // takes the only credit
    let secondResolved = false;
    const second = ch.send(1).then(() => {
      secondResolved = true;
    });
    await microtasks(5);
    expect(secondResolved).toBe(false); // still blocked — no credit available
    await second;
    expect(secondResolved).toBe(true);
    await ch.drain();
  });
});

/* ---------------------------------------------------------------- *
 * 3. FIFO credit fairness under contention.                        *
 * ---------------------------------------------------------------- */

describe("FIFO credit fairness", () => {
  it("waiters resolve in exact enqueue order as releases fire one-by-one", async () => {
    const cc = new CreditController(1);
    await cc.acquire(); // hold the single credit
    expect(cc.inFlight()).toBe(1);
    expect(cc.available()).toBe(0);

    const order: number[] = [];
    const ps: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      const id = i;
      ps.push(cc.acquire().then(() => order.push(id)));
    }
    await microtasks(3);
    expect(cc.waiting()).toBe(5);
    expect(cc.inFlight()).toBe(1); // waiters do not count as in-flight

    for (let i = 0; i < 5; i++) {
      cc.release(); // hands credit to the oldest waiter, inFlight unchanged
      await microtasks(2);
      // a credit handed to a waiter keeps inFlight pinned at capacity
      expect(cc.inFlight()).toBe(1);
    }
    await Promise.all(ps);

    expect(order).toEqual([0, 1, 2, 3, 4]); // any other order => unfair queue
    expect(cc.waiting()).toBe(0);
    expect(cc.inFlight()).toBe(1); // last waiter still holds the credit
  });
});

/* ---------------------------------------------------------------- *
 * 4. Exactly-once under a chaotic consumer + throwing-consume probe *
 * ---------------------------------------------------------------- */

describe("no lost / duplicated items under chaotic delays", () => {
  it("every item consumed exactly once", async () => {
    const rand = rng(777);
    const seen: number[] = [];
    const consume = async (x: number) => {
      const r = rand();
      if (r < 0.4) {
        /* immediate */
      } else if (r < 0.75) {
        await Promise.resolve();
      } else {
        await sleep(0);
      }
      seen.push(x);
    };
    const ch = new BackpressuredChannel<number>(4, consume);
    const n = 500;
    for (let i = 0; i < n; i++) await ch.send(i);
    await ch.drain();

    expect(seen.length).toBe(n);
    expect(new Set(seen).size).toBe(n);
    // every id 0..n-1 present
    seen.sort((a, b) => a - b);
    expect(seen[0]).toBe(0);
    expect(seen[n - 1]).toBe(n - 1);
  });

  it("a REJECTING consume still releases its credit (no deadlock)", async () => {
    // Contract read: release must happen when consume *settles*, reject
    // included. If the impl only releases on fulfilment, the channel
    // deadlocks and drain never resolves — caught by the timeout race.
    const ok: number[] = [];
    const consume = async (x: number) => {
      if (x % 3 === 0) {
        await Promise.resolve();
        throw new Error(`boom on ${x}`);
      }
      await sleep(0);
      ok.push(x);
    };
    const ch = new BackpressuredChannel<number>(2, consume);
    const n = 60;
    // send() itself may reject if the impl surfaces consume errors through
    // it; guard each so the producer loop cannot be derailed by that choice.
    for (let i = 0; i < n; i++) {
      await ch.send(i).catch(() => {});
    }

    const outcome = await Promise.race([
      ch.drain().then(
        () => "drained" as const,
        () => "drain-rejected" as const,
      ),
      sleep(1500).then(() => "timeout" as const),
    ]);

    // A deadlock (credit leaked on rejection) surfaces here as "timeout".
    expect(outcome).not.toBe("timeout");
    expect(outcome).toBe("drained");

    // Non-throwing items must still have been delivered exactly once.
    const expectedOk = Array.from({ length: n }, (_, i) => i).filter(
      (i) => i % 3 !== 0,
    );
    ok.sort((a, b) => a - b);
    expect(ok).toEqual(expectedOk);
  });
});

/* ---------------------------------------------------------------- *
 * 5. drain correctness.                                            *
 * ---------------------------------------------------------------- */

describe("drain correctness", () => {
  it("(a) drain on a fresh channel resolves immediately", async () => {
    const ch = new BackpressuredChannel<number>(3, async () => {});
    let drained = false;
    const d = ch.drain().then(() => {
      drained = true;
    });
    await microtasks(3);
    expect(drained).toBe(true);
    await d;
  });

  it("(b) drain stays pending while consumes are outstanding, (c) resolves after the last", async () => {
    const ch = new BackpressuredChannel<number>(2, async () => {
      await sleep(20); // macrotask — cannot complete during microtask flush
    });

    // fire a burst without awaiting; 2 acquire, the rest queue in acquire.
    const sends: Promise<void>[] = [];
    for (let i = 0; i < 6; i++) sends.push(ch.send(i));

    let drained = false;
    const d = ch.drain().then(() => {
      drained = true;
    });

    // race drain against a microtask flag: consumes are on real timers, so
    // draining now would be draining EARLY.
    await microtasks(8);
    expect(drained).toBe(false); // early-resolve => drain ignores outstanding work

    await Promise.all(sends);
    await d; // (c) resolves once the last consume settles
    expect(drained).toBe(true);
    expect(ch.stats().consumed).toBe(6);
    expect(ch.stats().sent).toBe(6);
  });
});

/* ---------------------------------------------------------------- *
 * 6. Over-release / underflow safety.                             *
 * ---------------------------------------------------------------- */

describe("over-release and underflow are safe no-ops", () => {
  it("releasing with nothing acquired never underflows or over-credits", async () => {
    const cc = new CreditController(3);
    for (let i = 0; i < 25; i++) {
      cc.release(); // nothing acquired — must be a no-op
      expect(cc.inFlight()).toBe(0); // floored at 0, never negative
      expect(cc.available()).toBe(3); // never exceeds capacity
      expect(cc.available()).toBeLessThanOrEqual(cc.capacity);
      expect(cc.waiting()).toBe(0);
    }
    // pool integrity preserved: a fresh acquire still works.
    await cc.acquire();
    expect(cc.inFlight()).toBe(1);
    expect(cc.available()).toBe(2);

    // and over-releasing back past zero stays floored.
    cc.release();
    cc.release();
    cc.release();
    expect(cc.inFlight()).toBe(0);
    expect(cc.available()).toBe(3);
    expect(cc.waiting()).toBe(0);
  });

  it("acquiring the full capacity then over-releasing returns to a clean pool", async () => {
    const cc = new CreditController(4);
    await Promise.all([cc.acquire(), cc.acquire(), cc.acquire(), cc.acquire()]);
    expect(cc.inFlight()).toBe(4);
    expect(cc.available()).toBe(0);
    for (let i = 0; i < 10; i++) cc.release(); // 4 real + 6 no-ops
    expect(cc.inFlight()).toBe(0);
    expect(cc.available()).toBe(4);
    expect(cc.waiting()).toBe(0);
  });
});

/* ---------------------------------------------------------------- *
 * 7. Interleaving-storm determinism + credit conservation.        *
 * ---------------------------------------------------------------- */

describe("interleaving storm", () => {
  it("channel: seeded random send/await pattern conserves the item count", async () => {
    const capacity = 5;
    const n = 800;
    const rand = rng(0x5eed);
    let live = 0;
    let peak = 0;
    const consume = async (_x: number) => {
      live++;
      if (live > peak) peak = live;
      const r = rand();
      if (r < 0.5) await Promise.resolve();
      else if (r < 0.8) {
        await Promise.resolve();
        await Promise.resolve();
      } else await sleep(0);
      live--;
    };
    const ch = new BackpressuredChannel<number>(capacity, consume);

    let i = 0;
    while (i < n) {
      if (rand() < 0.5) {
        await ch.send(i++);
      } else {
        // fire a small batch, then await them all together
        const batch: Promise<void>[] = [];
        const k = 1 + Math.floor(rand() * 5);
        for (let j = 0; j < k && i < n; j++) batch.push(ch.send(i++));
        await Promise.all(batch);
      }
    }
    await ch.drain();

    const s = ch.stats();
    expect(s.sent).toBe(n);
    expect(s.consumed).toBe(n); // no lost / duplicated items
    expect(peak).toBeLessThanOrEqual(capacity); // never breached under chaos
    expect(s.maxInFlight).toBeLessThanOrEqual(capacity);
    expect(s.maxInFlight).toBe(peak);
  });

  it("controller: all credits returned after a balanced acquire/release storm", async () => {
    const capacity = 4;
    const n = 50;
    const cc = new CreditController(capacity);

    // N acquires: `capacity` resolve, the remainder queue FIFO.
    const ps = Array.from({ length: n }, () => cc.acquire());
    await microtasks(4);
    expect(cc.inFlight()).toBe(capacity);
    expect(cc.waiting()).toBe(n - capacity);

    // Exactly N releases: first (n-capacity) feed waiters, last `capacity`
    // return to the pool. Everything must balance to a pristine controller.
    for (let i = 0; i < n; i++) {
      cc.release();
      await microtasks(1);
    }
    await Promise.all(ps);

    expect(cc.inFlight()).toBe(0); // all credits returned
    expect(cc.available()).toBe(capacity); // pool full again
    expect(cc.available()).toBe(cc.capacity);
    expect(cc.waiting()).toBe(0);
  });
});
