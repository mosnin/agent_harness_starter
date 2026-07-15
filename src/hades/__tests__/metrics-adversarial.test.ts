import { describe, it, expect } from "vitest";
import { MetricsCollector } from "../metrics/collector";
import type { MetricsSnapshot, NodeSnapshot } from "../metrics/collector";

/* ------------------------------------------------------------------ */
/* fake clock harness — a mutable `t` we fully control                */
/* ------------------------------------------------------------------ */

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    adv: (dt: number) => {
      t += dt;
    },
    get: () => t,
  };
}

function nodeById(s: MetricsSnapshot, id: string): NodeSnapshot {
  const n = s.nodes.find((x) => x.nodeId === id);
  if (!n) throw new Error(`node ${id} not found in snapshot`);
  return n;
}

/* ================================================================== */
/* 1. EXACT COUNTS                                                     */
/* ================================================================== */

describe("exact counts", () => {
  it("tracks processed/errors/inFlight/queueDepth to the exact integer", () => {
    const clk = makeClock(1000);
    const m = new MetricsCollector({ now: clk.now });

    // enqueue 5
    for (let i = 0; i < 5; i++) m.onEnqueue("A");
    let s = m.snapshot();
    expect(nodeById(s, "A").queueDepth).toBe(5);
    expect(nodeById(s, "A").inFlight).toBe(0);
    expect(nodeById(s, "A").processed).toBe(0);

    // start 3 → queueDepth 2, inFlight 3
    const st: number[] = [];
    for (let i = 0; i < 3; i++) st.push(m.onStart("A"));
    s = m.snapshot();
    expect(nodeById(s, "A").queueDepth).toBe(2);
    expect(nodeById(s, "A").inFlight).toBe(3);

    // onStart must return the current clock value
    expect(st.every((v) => v === 1000)).toBe(true);

    // complete 2 ok, 1 error
    clk.adv(5);
    m.onComplete("A", st[0], true);
    m.onComplete("A", st[1]); // ok defaults to true
    m.onComplete("A", st[2], false);
    s = m.snapshot();
    const a = nodeById(s, "A");
    expect(a.processed).toBe(3);
    expect(a.errors).toBe(1);
    expect(a.inFlight).toBe(0);
    expect(a.queueDepth).toBe(2);
  });

  it("floors queueDepth at 0 on extra onStart (nothing queued)", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });
    // start with nothing enqueued — queueDepth must not go negative
    m.onStart("A");
    m.onStart("A");
    const s = m.snapshot();
    const a = nodeById(s, "A");
    expect(a.queueDepth).toBe(0);
    // inFlight tracks the two starts
    expect(a.inFlight).toBe(2);
  });

  it("floors inFlight at 0 on extra onComplete", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });
    // complete with nothing in flight — inFlight must not go negative
    m.onComplete("A", 0, true);
    m.onComplete("A", 0, true);
    const s = m.snapshot();
    const a = nodeById(s, "A");
    expect(a.inFlight).toBe(0);
    expect(a.processed).toBe(2);
  });
});

/* ================================================================== */
/* 2. PEAKS                                                            */
/* ================================================================== */

describe("peaks", () => {
  it("peakQueueDepth and peakInFlight equal true maxima and never decrease", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });

    // enqueue 4 → queueDepth peaks at 4
    for (let i = 0; i < 4; i++) m.onEnqueue("N");
    // start 3 → queueDepth 1, inFlight peaks at 3
    const s1 = m.onStart("N");
    const s2 = m.onStart("N");
    const s3 = m.onStart("N");
    let snap = m.snapshot();
    expect(nodeById(snap, "N").peakQueueDepth).toBe(4);
    expect(nodeById(snap, "N").peakInFlight).toBe(3);

    // complete all → inFlight drops to 0, queueDepth to 1
    m.onComplete("N", s1);
    m.onComplete("N", s2);
    m.onComplete("N", s3);
    snap = m.snapshot();
    // peaks must NOT decrease
    expect(nodeById(snap, "N").peakQueueDepth).toBe(4);
    expect(nodeById(snap, "N").peakInFlight).toBe(3);
    expect(nodeById(snap, "N").inFlight).toBe(0);
    expect(nodeById(snap, "N").queueDepth).toBe(1);

    // now enqueue 1 more (total queued 2) — still below peak 4
    m.onEnqueue("N");
    snap = m.snapshot();
    expect(nodeById(snap, "N").peakQueueDepth).toBe(4);
  });
});

/* ================================================================== */
/* 3. LATENCY PERCENTILES — nearest-rank, EXACT                       */
/* ================================================================== */

describe("latency percentiles (nearest-rank, exact)", () => {
  it("durations 1..100 → p50=50 p90=90 p99=99 max=100 min=1 mean=50.5 count=100", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });
    for (let d = 1; d <= 100; d++) {
      // start at t=0, complete at t=d → latency exactly d
      clk.set(0);
      const st = m.onStart("A"); // st === 0
      clk.set(d);
      m.onComplete("A", st, true);
    }
    const a = nodeById(m.snapshot(), "A").latency;
    expect(a.count).toBe(100);
    expect(a.min).toBe(1);
    expect(a.max).toBe(100);
    expect(a.mean).toBeCloseTo(50.5, 10);
    // nearest-rank: p(q)=sorted[ceil(q/100*n)-1]
    expect(a.p50).toBe(50); // sorted[ceil(50)-1]=sorted[49]=50
    expect(a.p90).toBe(90); // sorted[89]=90
    expect(a.p99).toBe(99); // sorted[98]=99
  });

  it("tiny set {10,20,30} → nearest-rank p50=20 p90=30 p99=30 max=30 min=10 mean=20", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });
    for (const d of [10, 20, 30]) {
      clk.set(0);
      const st = m.onStart("B");
      clk.set(d);
      m.onComplete("B", st, true);
    }
    const l = nodeById(m.snapshot(), "B").latency;
    expect(l.count).toBe(3);
    expect(l.min).toBe(10);
    expect(l.max).toBe(30);
    expect(l.mean).toBeCloseTo(20, 10);
    // n=3: p50=sorted[ceil(1.5)-1]=sorted[1]=20
    expect(l.p50).toBe(20);
    // p90=sorted[ceil(2.7)-1]=sorted[2]=30 ; p99=sorted[2]=30
    expect(l.p90).toBe(30);
    expect(l.p99).toBe(30);
  });

  it("count===0 → all latency fields are 0", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });
    m.onEnqueue("C"); // node exists, but nothing completed
    const l = nodeById(m.snapshot(), "C").latency;
    expect(l).toEqual({
      count: 0,
      mean: 0,
      p50: 0,
      p90: 0,
      p99: 0,
      max: 0,
      min: 0,
    });
  });
});

/* ================================================================== */
/* 4. RING-BUFFER EVICTION                                            */
/* ================================================================== */

describe("ring-buffer eviction", () => {
  it("historySize=4, push durations 1..10 → retains last 4 {7,8,9,10}", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now, historySize: 4 });
    for (let d = 1; d <= 10; d++) {
      clk.set(0);
      const st = m.onStart("R");
      clk.set(d);
      m.onComplete("R", st, true);
    }
    const node = nodeById(m.snapshot(), "R");
    // processed counts ALL ops
    expect(node.processed).toBe(10);
    const l = node.latency;
    // latency stats only over retained {7,8,9,10}
    expect(l.count).toBe(4);
    expect(l.min).toBe(7);
    expect(l.max).toBe(10);
    expect(l.mean).toBeCloseTo(8.5, 10);
    // nearest-rank p50 = sorted[ceil(0.5*4)-1]=sorted[1]=8
    expect(l.p50).toBe(8);
  });
});

/* ================================================================== */
/* 5. THROUGHPUT                                                       */
/* ================================================================== */

describe("throughput", () => {
  it("4 completes over 2 seconds → 2/sec exactly", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });
    // Establish the throughput window start by first activity at t=0.
    // 4 ops complete; wall clock advances a total of 2000ms.
    for (let i = 0; i < 4; i++) {
      const st = m.onStart("T"); // instantaneous starts
      m.onComplete("T", st, true);
    }
    clk.set(2000); // elapsed since first-seen = 2 seconds
    const node = nodeById(m.snapshot(), "T");
    expect(node.processed).toBe(4);
    expect(node.throughputPerSec).toBeCloseTo(2, 10);
  });

  it("no NaN/Infinity when elapsed is 0", () => {
    const clk = makeClock(5000);
    const m = new MetricsCollector({ now: clk.now });
    // complete ops but NEVER advance the clock → elapsed 0
    for (let i = 0; i < 3; i++) {
      const st = m.onStart("Z");
      m.onComplete("Z", st, true);
    }
    const node = nodeById(m.snapshot(), "Z");
    expect(Number.isFinite(node.throughputPerSec)).toBe(true);
    expect(Number.isNaN(node.throughputPerSec)).toBe(false);
  });

  it("throughput is 0 when processed is 0", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });
    m.onEnqueue("Q");
    clk.set(10000);
    const node = nodeById(m.snapshot(), "Q");
    expect(node.throughputPerSec).toBe(0);
  });
});

/* ================================================================== */
/* 6. SNAPSHOT PURITY                                                  */
/* ================================================================== */

describe("snapshot purity", () => {
  it("mutating the returned snapshot does not affect collector state", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });
    m.onEnqueue("A");
    const st = m.onStart("A");
    m.onComplete("A", st, true);

    const s1 = m.snapshot();
    // vandalize the returned object
    s1.nodes.push({
      nodeId: "INJECTED",
      processed: 9999,
      errors: 9999,
      inFlight: 9999,
      queueDepth: 9999,
      peakQueueDepth: 9999,
      peakInFlight: 9999,
      latency: { count: 1, mean: 1, p50: 1, p90: 1, p99: 1, max: 1, min: 1 },
      throughputPerSec: 9999,
    });
    s1.nodes[0].processed = -12345;
    s1.totals.processed = -12345;

    const s2 = m.snapshot();
    // collector state must be pristine
    expect(s2.nodes.map((n) => n.nodeId)).toEqual(["A"]);
    expect(nodeById(s2, "A").processed).toBe(1);
    expect(s2.totals.processed).toBe(1);
  });

  it("two snapshots with no events between + frozen clock are deep-equal (node data)", () => {
    const clk = makeClock(500);
    const m = new MetricsCollector({ now: clk.now });
    for (let i = 0; i < 3; i++) m.onEnqueue("A");
    const st = m.onStart("A");
    m.onComplete("A", st, true);

    // clock held still → full equality including derived fields
    const s1 = m.snapshot();
    const s2 = m.snapshot();
    expect(s2.nodes).toEqual(s1.nodes);
    expect(s2.totals).toEqual(s1.totals);
    expect(s2.at).toBe(s1.at);
  });

  it("snapshot() is a pure read — calling it repeatedly does not mutate counters/peaks", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });
    for (let i = 0; i < 3; i++) m.onEnqueue("A");
    const a = m.onStart("A");
    const b = m.onStart("A");
    m.onComplete("A", a, true);
    m.onComplete("A", b, false);

    const before = m.snapshot();
    const p = nodeById(before, "A").processed;
    const e = nodeById(before, "A").errors;
    const pk = nodeById(before, "A").peakInFlight;
    const pq = nodeById(before, "A").peakQueueDepth;

    for (let i = 0; i < 5; i++) m.snapshot();

    const after = nodeById(m.snapshot(), "A");
    expect(after.processed).toBe(p);
    expect(after.errors).toBe(e);
    expect(after.peakInFlight).toBe(pk);
    expect(after.peakQueueDepth).toBe(pq);
    expect(after.inFlight).toBe(0);
    expect(after.queueDepth).toBe(1);
  });
});

/* ================================================================== */
/* 7. TOTALS + ORDERING                                               */
/* ================================================================== */

describe("totals + ordering", () => {
  it("nodes/nodeIds sorted ascending; totals == elementwise sum", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });

    // add out of alphabetical order: charlie, alpha, bravo
    m.onEnqueue("charlie");
    m.onEnqueue("alpha");
    m.onEnqueue("bravo");
    // give each some distinct activity
    const cs = m.onStart("charlie");
    m.onComplete("charlie", cs, false); // charlie: processed1 err1, queue0
    const as1 = m.onStart("alpha");
    m.onComplete("alpha", as1, true); // alpha: processed1 err0, queue0
    // bravo stays queued (inFlight 0, queue 1)
    m.onEnqueue("bravo"); // bravo queue now 2
    const bs = m.onStart("bravo"); // bravo queue 1, inFlight 1 (left in flight)
    void bs;

    const s = m.snapshot();
    const ids = s.nodes.map((n) => n.nodeId);
    expect(ids).toEqual(["alpha", "bravo", "charlie"]);
    expect(m.nodeIds()).toEqual(["alpha", "bravo", "charlie"]);

    const sum = (f: (n: NodeSnapshot) => number) =>
      s.nodes.reduce((acc, n) => acc + f(n), 0);
    expect(s.totals.processed).toBe(sum((n) => n.processed));
    expect(s.totals.errors).toBe(sum((n) => n.errors));
    expect(s.totals.inFlight).toBe(sum((n) => n.inFlight));
    expect(s.totals.queueDepth).toBe(sum((n) => n.queueDepth));

    // sanity against hand computation
    expect(s.totals.processed).toBe(2); // charlie + alpha
    expect(s.totals.errors).toBe(1); // charlie
    expect(s.totals.inFlight).toBe(1); // bravo in flight
    expect(s.totals.queueDepth).toBe(1); // bravo queued 1
  });
});

/* ================================================================== */
/* 8. RESET                                                            */
/* ================================================================== */

describe("reset", () => {
  it("reset() zeroes everything and empties nodeIds", () => {
    const clk = makeClock(0);
    const m = new MetricsCollector({ now: clk.now });
    for (let i = 0; i < 4; i++) m.onEnqueue("A");
    const s1 = m.onStart("A");
    const s2 = m.onStart("A");
    clk.set(10);
    m.onComplete("A", s1, true);
    m.onComplete("A", s2, false);
    m.onEnqueue("B");

    // has real state
    expect(m.nodeIds().length).toBeGreaterThan(0);

    m.reset();

    // nodeIds empty OR all-zero nodes — assert the strong form: zeroed everything
    expect(m.nodeIds()).toEqual([]);
    const snap = m.snapshot();
    expect(snap.nodes).toEqual([]);
    expect(snap.totals).toEqual({
      processed: 0,
      errors: 0,
      inFlight: 0,
      queueDepth: 0,
    });
  });
});
