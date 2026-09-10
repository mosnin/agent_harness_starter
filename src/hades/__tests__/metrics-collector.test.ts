import { describe, it, expect } from "vitest";
import { MetricsCollector } from "../metrics/collector";

/** A deterministic fake clock. `t` is advanced explicitly by tests. */
function fakeClock() {
  const state = { t: 0 };
  return {
    now: () => state.t,
    set: (v: number) => {
      state.t = v;
    },
    advance: (d: number) => {
      state.t += d;
    },
  };
}

describe("MetricsCollector", () => {
  it("counts processed and errors exactly", () => {
    const clk = fakeClock();
    const m = new MetricsCollector({ now: clk.now });
    for (let i = 0; i < 5; i++) {
      const s = m.onStart("a");
      m.onComplete("a", s, i % 2 === 0); // ok for i=0,2,4 ; error for i=1,3
    }
    const node = m.snapshot().nodes[0];
    expect(node.processed).toBe(5);
    expect(node.errors).toBe(2);
  });

  it("tracks queueDepth / inFlight and their peaks, flooring at 0", () => {
    const clk = fakeClock();
    const m = new MetricsCollector({ now: clk.now });
    m.onEnqueue("n");
    m.onEnqueue("n");
    m.onEnqueue("n"); // queueDepth = 3 (peak 3)
    const s1 = m.onStart("n"); // queue 2, inFlight 1
    const s2 = m.onStart("n"); // queue 1, inFlight 2 (peak inFlight 2)
    let snap = m.snapshot().nodes[0];
    expect(snap.queueDepth).toBe(1);
    expect(snap.inFlight).toBe(2);
    expect(snap.peakQueueDepth).toBe(3);
    expect(snap.peakInFlight).toBe(2);

    m.onComplete("n", s1);
    m.onComplete("n", s2);
    // Unbalanced extra completes / starts must not go negative.
    m.onComplete("n", 0); // inFlight already 0 -> stays 0
    m.onStart("n"); // queueDepth is 1 -> becomes 0 (floor holds afterwards)
    m.onStart("n"); // queueDepth already 0 -> stays 0
    snap = m.snapshot().nodes[0];
    expect(snap.queueDepth).toBe(0);
    expect(snap.inFlight).toBeGreaterThanOrEqual(0);
    expect(snap.inFlight).toBe(2); // two starts above, no matching completes
  });

  it("computes nearest-rank percentiles on durations 1..100", () => {
    const clk = fakeClock();
    const m = new MetricsCollector({ now: clk.now, historySize: 1024 });
    for (let d = 1; d <= 100; d++) {
      // start at t=0, complete at t=d so latency == d
      clk.set(0);
      const s = m.onStart("x");
      clk.set(d);
      m.onComplete("x", s);
    }
    const lat = m.snapshot().nodes[0].latency;
    expect(lat.count).toBe(100);
    expect(lat.min).toBe(1);
    expect(lat.max).toBe(100);
    expect(lat.mean).toBeCloseTo(50.5, 10);
    expect(lat.p50).toBe(50);
    expect(lat.p90).toBe(90);
    expect(lat.p99).toBe(99);
  });

  it("evicts oldest samples via the ring buffer (historySize)", () => {
    const clk = fakeClock();
    const m = new MetricsCollector({ now: clk.now, historySize: 3 });
    // Record latencies 10, 20, 30, 40, 50 -> only last 3 (30,40,50) retained.
    for (const d of [10, 20, 30, 40, 50]) {
      clk.set(0);
      const s = m.onStart("r");
      clk.set(d);
      m.onComplete("r", s);
    }
    const lat = m.snapshot().nodes[0].latency;
    expect(lat.count).toBe(3);
    expect(lat.min).toBe(30);
    expect(lat.max).toBe(50);
    expect(lat.mean).toBeCloseTo(40, 10);
  });

  it("throughputPerSec is finite and correct; 0 when nothing processed", () => {
    const clk = fakeClock();
    const m = new MetricsCollector({ now: clk.now });
    clk.set(1000);
    m.onEnqueue("t"); // first activity at t=1000
    const s = m.onStart("t");
    m.onComplete("t", s);
    clk.set(3000); // 2s elapsed since first activity, processed=1
    const node = m.snapshot().nodes[0];
    expect(Number.isFinite(node.throughputPerSec)).toBe(true);
    expect(node.throughputPerSec).toBeCloseTo(0.5, 10); // 1 op / 2s

    // A node with activity but no completions reports 0 (not NaN/Infinity).
    m.onEnqueue("idle");
    const idle = m.snapshot().nodes.find((n) => n.nodeId === "idle")!;
    expect(idle.throughputPerSec).toBe(0);
  });

  it("snapshot is a pure read: twice-equal and non-perturbing", () => {
    const clk = fakeClock();
    const m = new MetricsCollector({ now: clk.now });
    m.onEnqueue("a");
    const s = m.onStart("a");
    m.onComplete("a", s, true);
    m.onEnqueue("b");

    const snap1 = m.snapshot();
    const snap2 = m.snapshot(); // no intervening events, clock unchanged
    expect(snap2.nodes).toEqual(snap1.nodes);
    expect(snap2.totals).toEqual(snap1.totals);

    // Mutating a returned snapshot must not affect the collector or later snapshots.
    snap1.nodes[0].processed = 9999;
    snap1.totals.processed = 9999;
    const snap3 = m.snapshot();
    expect(snap3.totals.processed).toBe(1);
    expect(snap3.nodes[0].processed).toBe(1);
  });

  it("nodes sorted ascending and totals equal elementwise sum of nodes", () => {
    const clk = fakeClock();
    const m = new MetricsCollector({ now: clk.now });
    // Insert out of order to prove sorting.
    m.onEnqueue("charlie");
    m.onEnqueue("alpha");
    m.onEnqueue("bravo");
    const sa = m.onStart("alpha");
    m.onComplete("alpha", sa, false); // error
    const sb = m.onStart("bravo");
    m.onComplete("bravo", sb, true);

    const snap = m.snapshot();
    expect(snap.nodes.map((n) => n.nodeId)).toEqual(["alpha", "bravo", "charlie"]);
    expect(m.nodeIds()).toEqual(["alpha", "bravo", "charlie"]);

    const sum = snap.nodes.reduce(
      (acc, n) => ({
        processed: acc.processed + n.processed,
        errors: acc.errors + n.errors,
        inFlight: acc.inFlight + n.inFlight,
        queueDepth: acc.queueDepth + n.queueDepth,
      }),
      { processed: 0, errors: 0, inFlight: 0, queueDepth: 0 },
    );
    expect(snap.totals).toEqual(sum);
    expect(snap.totals.processed).toBe(2);
    expect(snap.totals.errors).toBe(1);
    expect(snap.totals.queueDepth).toBe(1); // charlie still enqueued
  });

  it("reset zeroes everything", () => {
    const clk = fakeClock();
    const m = new MetricsCollector({ now: clk.now });
    m.onEnqueue("a");
    const s = m.onStart("a");
    m.onComplete("a", s);
    m.reset();
    const snap = m.snapshot();
    expect(snap.nodes).toEqual([]);
    expect(m.nodeIds()).toEqual([]);
    expect(snap.totals).toEqual({ processed: 0, errors: 0, inFlight: 0, queueDepth: 0 });
  });
});
