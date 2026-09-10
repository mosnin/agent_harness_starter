import { describe, it, expect } from "vitest";
import { CreditController, BackpressuredChannel } from "../a2a/backpressure";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const micro = () => Promise.resolve();

describe("CreditController", () => {
  it("throws on capacity < 1", () => {
    expect(() => new CreditController(0)).toThrow();
    expect(() => new CreditController(-1)).toThrow();
    expect(() => new CreditController(1)).not.toThrow();
  });

  it("capacity 2: two acquires resolve immediately, third pends until release", async () => {
    const c = new CreditController(2);
    let a = false;
    let b = false;
    let third = false;

    await c.acquire().then(() => (a = true));
    await c.acquire().then(() => (b = true));
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(c.inFlight()).toBe(2);
    expect(c.available()).toBe(0);

    void c.acquire().then(() => (third = true));
    await micro();
    expect(third).toBe(false);
    expect(c.waiting()).toBe(1);

    // release with a waiter: credit passes directly, available stays 0, waiting drops
    c.release();
    await micro();
    expect(third).toBe(true);
    expect(c.available()).toBe(0);
    expect(c.inFlight()).toBe(2);
    expect(c.waiting()).toBe(0);

    // release with no waiter: credit returns to pool, available rises
    c.release();
    expect(c.available()).toBe(1);
    expect(c.inFlight()).toBe(1);
  });

  it("FIFO fairness: pending acquirers resolve in queue order as releases happen", async () => {
    const c = new CreditController(1);
    await c.acquire(); // take the only credit

    const order: number[] = [];
    void c.acquire().then(() => order.push(1));
    void c.acquire().then(() => order.push(2));
    void c.acquire().then(() => order.push(3));
    await micro();
    expect(c.waiting()).toBe(3);
    expect(order).toEqual([]);

    c.release();
    await micro();
    expect(order).toEqual([1]);

    c.release();
    await micro();
    expect(order).toEqual([1, 2]);

    c.release();
    await micro();
    expect(order).toEqual([1, 2, 3]);
  });

  it("release never drives inFlight negative (over-release is a no-op)", () => {
    const c = new CreditController(2);
    expect(c.inFlight()).toBe(0);
    c.release();
    c.release();
    c.release();
    expect(c.inFlight()).toBe(0);
    expect(c.available()).toBe(2);
  });
});

describe("BackpressuredChannel", () => {
  it("core proof: fast producer, slow consumer, in-flight bounded by capacity", async () => {
    const N = 500;
    const CAP = 4;
    const seen: number[] = [];

    const ch = new BackpressuredChannel<number>(CAP, async (item) => {
      // slow consumer: yield the event loop several times
      await tick();
      await tick();
      await micro();
      seen.push(item);
    });

    for (let i = 0; i < N; i++) {
      await ch.send(i);
    }
    await ch.drain();

    const s = ch.stats();
    expect(s.sent).toBe(N);
    expect(s.consumed).toBe(N);
    expect(s.maxInFlight).toBeLessThanOrEqual(CAP);
    expect(s.maxInFlight).toBeGreaterThan(0);
  });

  it("no loss: every distinct item consumed exactly once", async () => {
    const N = 200;
    const CAP = 3;
    const seen: number[] = [];

    const ch = new BackpressuredChannel<number>(CAP, async (item) => {
      await tick();
      seen.push(item);
    });

    const sent = new Set<number>();
    for (let i = 0; i < N; i++) {
      sent.add(i);
      await ch.send(i);
    }
    await ch.drain();

    expect(seen.length).toBe(N);
    expect(new Set(seen)).toEqual(sent);
    // exactly once: no duplicates
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("drain() on an idle channel resolves immediately", async () => {
    const ch = new BackpressuredChannel<number>(2, async () => {
      await tick();
    });
    let resolved = false;
    void ch.drain().then(() => (resolved = true));
    await micro();
    expect(resolved).toBe(true);
    expect(ch.stats()).toEqual({ sent: 0, consumed: 0, maxInFlight: 0 });
  });

  it("drain() after sends waits for all consumes to finish", async () => {
    const ch = new BackpressuredChannel<number>(2, async () => {
      await tick();
      await tick();
    });

    await ch.send(1);
    await ch.send(2);

    let drained = false;
    void ch.drain().then(() => (drained = true));

    // not done yet: consumes still running
    await micro();
    expect(drained).toBe(false);
    expect(ch.stats().consumed).toBeLessThan(2);

    await ch.drain();
    expect(drained).toBe(true);
    expect(ch.stats().consumed).toBe(2);
  });
});
