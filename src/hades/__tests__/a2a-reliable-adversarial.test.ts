import { describe, it, expect } from "vitest";
import { ReliableSender, ReliableReceiver } from "../a2a/reliable";
import type { Frame, SenderOptions } from "../a2a/reliable";

/* ================================================================== *
 * ADVERSARIAL + PROPERTY-BASED VERIFIER for the reliable A2A channel.
 *
 * Contract under test (exactly-once, in-order delivery over an
 * unreliable network that DROPS / DUPLICATES / REORDERS frames):
 *   - seq numbers start at 0.
 *   - Sender retransmits unacked data on an injectable timer, up to
 *     maxRetries, then calls onGiveUp. handleAck removes the pending
 *     entry and is idempotent.
 *   - Receiver ACKs every data frame (even duplicates), delivers each
 *     payload EXACTLY ONCE in send order, buffers out-of-order frames,
 *     and dedupes (seq < nextExpected OR already-buffered -> onDuplicate
 *     then drop).
 * The whole point: exactly-once + in-order despite chaos.
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * Seeded PRNG — mulberry32 (inline, NEVER Math.random). Deterministic
 * so any failing seed reproduces bit-for-bit.
 * ------------------------------------------------------------------ */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Injectable fake clock. Sender schedules retransmit timers through
 * setTimeoutFn; we advance "time" by firing a whole ROUND of timers.
 * A round snapshots the currently-scheduled callbacks, clears them,
 * then invokes them — timers rescheduled *during* the round belong to
 * the NEXT round (models one ackTimeout elapsing for everything).
 * ------------------------------------------------------------------ */
function makeClock() {
  let nextId = 1;
  let timers = new Map<number, () => void>();
  const opts = {
    setTimeoutFn: ((cb: () => void, _ms: number) => {
      const id = nextId++;
      timers.set(id, cb);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as NonNullable<SenderOptions["setTimeoutFn"]>,
    clearTimeoutFn: ((t: ReturnType<typeof setTimeout>) => {
      timers.delete(t as unknown as number);
    }) as NonNullable<SenderOptions["clearTimeoutFn"]>,
  };
  return {
    opts,
    hasTimers: () => timers.size > 0,
    pendingTimers: () => timers.size,
    /** Fire every timer scheduled at the start of this round; return count fired. */
    fireRound(): number {
      const snapshot = [...timers.values()];
      timers = new Map();
      for (const cb of snapshot) cb();
      return snapshot.length;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Deterministic UNRELIABLE network. Holds in-flight frames tagged with
 * a destination. Each `step` pops a frame (front, or a random index
 * when reordering), then per-probability DROPS it, otherwise routes it
 * and maybe re-enqueues a DUPLICATE. Reorder = random insertion/removal
 * position. All randomness comes from the seeded PRNG.
 * ------------------------------------------------------------------ */
type Dest = "recv" | "sender";
interface InFlight {
  frame: Frame;
  dest: Dest;
}
interface NetProbs {
  drop: number;
  dup: number;
  reorder: number;
}
class UnreliableNetwork {
  q: InFlight[] = [];
  dropped = 0;
  duplicated = 0;
  routed = 0;
  constructor(
    private rand: () => number,
    private p: NetProbs,
    private routeData: (f: Frame) => void,
    private routeAck: (f: Frame) => void,
  ) {}
  private clone(f: Frame): Frame {
    return { ...f } as Frame;
  }
  enqueue(frame: Frame, dest: Dest) {
    const item: InFlight = { frame: this.clone(frame), dest };
    if (this.rand() < this.p.reorder && this.q.length > 0) {
      const idx = Math.floor(this.rand() * (this.q.length + 1));
      this.q.splice(idx, 0, item);
    } else {
      this.q.push(item);
    }
  }
  size() {
    return this.q.length;
  }
  /** Process one in-flight frame. Returns false only when the queue is empty. */
  step(): boolean {
    if (this.q.length === 0) return false;
    const idx =
      this.rand() < this.p.reorder ? Math.floor(this.rand() * this.q.length) : 0;
    const item = this.q.splice(idx, 1)[0];
    if (this.rand() < this.p.drop) {
      this.dropped++;
      return true;
    }
    this.routed++;
    if (item.dest === "recv") this.routeData(item.frame);
    else this.routeAck(item.frame);
    if (this.rand() < this.p.dup) {
      this.duplicated++;
      this.enqueue(item.frame, item.dest);
    }
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * An instrumented receiver whose `deliver` enforces STRICT MONOTONIC
 * ordering (seq === prev + 1, starting at 0) on every single call —
 * no gaps, no repeats, no spurious early delivery. A violation throws
 * immediately with the exact divergence, so a real ordering bug is
 * reported precisely instead of silently passing.
 * ------------------------------------------------------------------ */
function makeOrderedSink(label: string) {
  let prev = -1;
  const seqs: number[] = [];
  const payloads: unknown[] = [];
  const deliver = (payload: unknown, seq: number) => {
    if (seq !== prev + 1) {
      throw new Error(
        `${label}: spurious/out-of-order delivery — expected seq ${
          prev + 1
        } but got ${seq}. history=[${seqs.join(",")}]`,
      );
    }
    prev = seq;
    seqs.push(seq);
    payloads.push(payload);
  };
  return { deliver, seqs, payloads };
}

/* ------------------------------------------------------------------ *
 * Wire a sender + receiver together through an unreliable network and
 * drive the simulation until every payload is delivered or the step
 * budget is hit. Returns bookkeeping for assertions.
 * ------------------------------------------------------------------ */
function runChaos(opts: {
  seed: number;
  n: number;
  probs: NetProbs;
  maxRetries: number;
  budget: number;
}) {
  const rand = mulberry32(opts.seed);
  const clock = makeClock();
  const sink = makeOrderedSink(`seed ${opts.seed}`);

  const dupSeqs: number[] = [];
  let receiver!: ReliableReceiver;
  let sender!: ReliableSender;
  let network!: UnreliableNetwork;

  receiver = new ReliableReceiver(
    (payload, seq) => sink.deliver(payload, seq),
    (frame) => network.enqueue(frame, "sender"),
    { onDuplicate: (seq) => dupSeqs.push(seq) },
  );
  sender = new ReliableSender((frame) => network.enqueue(frame, "recv"), {
    ...clock.opts,
    ackTimeoutMs: 10,
    maxRetries: opts.maxRetries,
    onGiveUp: (seq) => {
      throw new Error(`seed ${opts.seed}: unexpected give-up on seq ${seq}`);
    },
  });
  network = new UnreliableNetwork(
    rand,
    opts.probs,
    (f) => receiver.handleData(f),
    (f) => sender.handleAck(f),
  );

  // The known payload sequence: distinct, order-sensitive values.
  const sent = Array.from({ length: opts.n }, (_, i) => `payload#${i}`);
  const sentSeqs = sent.map((p) => sender.send(p));

  // Drive: process in-flight frames; when the wire is idle but delivery
  // is incomplete, fire a retransmit round so at-least-once wins.
  let steps = 0;
  while (sink.seqs.length < opts.n && steps < opts.budget) {
    if (network.size() > 0) {
      network.step();
    } else if (clock.hasTimers()) {
      clock.fireRound();
    } else {
      break; // nothing in flight and no timers: genuinely stuck
    }
    steps++;
  }

  return { sender, receiver, sink, dupSeqs, sent, sentSeqs, steps, network };
}

/* ================================================================== */
/* Tests                                                              */
/* ================================================================== */

describe("ReliableSender/ReliableReceiver — adversarial network properties", () => {
  /* 1. HEADLINE PROPERTY: exactly-once + in-order under full chaos. */
  it("property: exactly-once, in-order delivery across ~30 seeds under drop/dup/reorder", () => {
    const N = 25;
    const SEEDS = 30;
    const failures: string[] = [];

    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = runChaos({
        seed,
        n: N,
        probs: { drop: 0.3, dup: 0.2, reorder: 0.4 },
        maxRetries: 100000, // effectively never give up
        budget: 500000,
      });

      // Must have terminated by delivering everything (not by budget).
      if (r.sink.seqs.length !== N) {
        failures.push(
          `seed ${seed}: only ${r.sink.seqs.length}/${N} delivered after ${r.steps} steps`,
        );
        continue;
      }
      // seqs are exactly 0..N-1 in order (the ordered sink already
      // asserts strict monotonicity on each call).
      const expectedSeqs = Array.from({ length: N }, (_, i) => i);
      if (JSON.stringify(r.sink.seqs) !== JSON.stringify(expectedSeqs)) {
        failures.push(`seed ${seed}: seq order = [${r.sink.seqs.join(",")}]`);
        continue;
      }
      // Payloads delivered exactly once, in the exact send order.
      if (JSON.stringify(r.sink.payloads) !== JSON.stringify(r.sent)) {
        failures.push(
          `seed ${seed}: payloads = [${r.sink.payloads.join(",")}] expected [${r.sent.join(
            ",",
          )}]`,
        );
        continue;
      }
      // send() returned monotonic seqs starting at 0.
      expect(r.sentSeqs).toEqual(expectedSeqs);
      // Receiver has fully advanced and buffered nothing.
      expect(r.receiver.nextExpected()).toBe(N);
      expect(r.receiver.buffered()).toBe(0);
    }

    if (failures.length) {
      throw new Error(
        `exactly-once+in-order property FAILED for ${failures.length}/${SEEDS} seeds:\n` +
          failures.join("\n"),
      );
    }
    // All seeds upheld the guarantee.
    expect(failures.length).toBe(0);
  });

  /* 2. Duplicates never double-deliver; onDuplicate counts exact extras. */
  it("duplicates: 3x every data frame -> each delivered once, onDuplicate == extra copies routed", () => {
    const N = 8;
    const clock = makeClock();
    const sink = makeOrderedSink("dup");
    const dupSeqs: number[] = [];
    const acks: number[] = [];

    const receiver = new ReliableReceiver(
      (p, s) => sink.deliver(p, s),
      (f) => {
        if (f.kind === "ack") acks.push(f.seq);
      },
      { onDuplicate: (seq) => dupSeqs.push(seq) },
    );
    const sender = new ReliableSender(() => {}, {
      ...clock.opts,
      maxRetries: 3,
    });

    // Capture the data frames the sender emits, then route each 3x
    // (1 original + 2 extra duplicates) in order.
    const frames: Frame[] = [];
    const capturing = new ReliableSender((f) => frames.push(f), { ...clock.opts });
    for (let i = 0; i < N; i++) capturing.send(`v${i}`);
    void sender;

    let extraRouted = 0;
    for (const f of frames) {
      receiver.handleData(f); // 1st -> delivers
      receiver.handleData({ ...f }); // dup -> onDuplicate
      receiver.handleData({ ...f }); // dup -> onDuplicate
      extraRouted += 2;
    }

    expect(sink.seqs).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(sink.payloads.length).toBe(N); // each exactly once
    expect(dupSeqs.length).toBe(extraRouted); // == extra copies actually routed
    expect(acks.length).toBe(N * 3); // ACK sent for EVERY data frame, dupes included

    // Also exercise the "already-buffered duplicate" branch: buffer seq 1
    // (out of order), then re-send it before seq 0 arrives.
    const sink2 = makeOrderedSink("dup2");
    const dup2: number[] = [];
    let ack2 = 0;
    const rx2 = new ReliableReceiver(
      (p, s) => sink2.deliver(p, s),
      () => {
        ack2++;
      },
      { onDuplicate: (seq) => dup2.push(seq) },
    );
    rx2.handleData({ kind: "data", seq: 1, payload: "b1" }); // buffered
    expect(rx2.buffered()).toBe(1);
    rx2.handleData({ kind: "data", seq: 1, payload: "b1" }); // already-buffered dup
    expect(dup2).toEqual([1]);
    expect(rx2.buffered()).toBe(1); // not double-buffered
    expect(ack2).toBe(2); // ACKed both times
    rx2.handleData({ kind: "data", seq: 0, payload: "b0" }); // flush
    expect(sink2.seqs).toEqual([0, 1]);
  });

  /* 3. Reorder stress: fully-reversed arrival -> correct order, peak buffered N-1. */
  it("reorder: fully-reversed delivery still emits 0..N-1 in order; peak buffered == N-1", () => {
    const N = 10;
    const sink = makeOrderedSink("rev");
    let acks = 0;
    let peakBuffered = 0;
    const receiver = new ReliableReceiver(
      (p, s) => sink.deliver(p, s),
      () => {
        acks++;
      },
    );

    // Arrive in fully-reversed order: 9,8,...,1,0.
    for (let seq = N - 1; seq >= 0; seq--) {
      receiver.handleData({ kind: "data", seq, payload: `r${seq}` });
      peakBuffered = Math.max(peakBuffered, receiver.buffered());
    }

    expect(sink.seqs).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(sink.payloads).toEqual(Array.from({ length: N }, (_, i) => `r${i}`));
    expect(peakBuffered).toBe(N - 1); // all but seq 0 held before the flush
    expect(receiver.buffered()).toBe(0); // fully drained after seq 0
    expect(receiver.nextExpected()).toBe(N);
    expect(acks).toBe(N); // every data frame ACKed
  });

  /* 4. Ack idempotency: replaying the same ack must not corrupt state. */
  it("ack idempotency: replaying one ack many times leaves sender state consistent", () => {
    const clock = makeClock();
    const sent: Frame[] = [];
    const sender = new ReliableSender((f) => sent.push(f), {
      ...clock.opts,
      maxRetries: 5,
    });

    const seq = sender.send("only");
    expect(seq).toBe(0);
    expect(sender.pending()).toBe(1);

    // Replay the identical ack 50 times.
    for (let i = 0; i < 50; i++) {
      expect(() => sender.handleAck({ kind: "ack", seq: 0 })).not.toThrow();
    }
    expect(sender.pending()).toBe(0); // removed exactly once, stays removed
    expect(sender.retransmits()).toBe(0); // acked before any timer fired

    // Acks for never-sent seqs are harmless no-ops.
    expect(() => sender.handleAck({ kind: "ack", seq: 999 })).not.toThrow();
    expect(sender.pending()).toBe(0);

    // Firing timers now must NOT resurrect the acked frame.
    clock.fireRound();
    clock.fireRound();
    expect(sender.retransmits()).toBe(0);
    expect(sender.pending()).toBe(0);
  });

  /* 5. Black hole -> bounded retries then give up; provably terminates. */
  it("black hole: drop-everything network -> onGiveUp fires, retransmits == maxRetries, no infinite loop", () => {
    const clock = makeClock();
    const maxRetries = 4;
    const giveUps: number[] = [];
    // transmit is a black hole: frames never reach any receiver.
    const sender = new ReliableSender(() => {}, {
      ...clock.opts,
      maxRetries,
      onGiveUp: (seq) => giveUps.push(seq),
    });

    const seq = sender.send("lost-forever");
    expect(seq).toBe(0);
    expect(sender.pending()).toBe(1);

    // Fire retransmit rounds until nothing is scheduled — this loop can
    // only terminate if the sender eventually stops rescheduling.
    const CAP = 1000;
    let rounds = 0;
    while (clock.hasTimers() && rounds < CAP) {
      clock.fireRound();
      rounds++;
    }

    expect(rounds).toBeLessThan(CAP); // terminated (no infinite retransmit loop)
    expect(giveUps).toEqual([0]); // gave up on the stuck seq exactly once
    expect(sender.retransmits()).toBe(maxRetries); // capped at maxRetries
    expect(clock.hasTimers()).toBe(false); // no lingering timers

    // Post-give-up: further rounds are inert (bounded, no resurrection).
    expect(clock.fireRound()).toBe(0);
    expect(sender.retransmits()).toBe(maxRetries);

    // Multiple stuck frames each give up independently.
    const clock2 = makeClock();
    const gu2: number[] = [];
    const s2 = new ReliableSender(() => {}, {
      ...clock2.opts,
      maxRetries,
      onGiveUp: (q) => gu2.push(q),
    });
    s2.send("a");
    s2.send("b");
    let r2 = 0;
    while (clock2.hasTimers() && r2 < CAP) {
      clock2.fireRound();
      r2++;
    }
    expect(r2).toBeLessThan(CAP);
    expect(gu2.sort()).toEqual([0, 1]);
    expect(s2.retransmits()).toBe(maxRetries * 2); // maxRetries per stuck frame
  });

  /* 6. No spurious delivery: strict monotonic on EVERY deliver call. */
  it("no spurious delivery: every deliver call is prev+1 (no gaps/repeats/early)", () => {
    // The ordered sink throws on any violation, so if a seed released a
    // buffered frame early or re-delivered, runChaos would surface it.
    const N = 20;
    for (let seed = 100; seed < 108; seed++) {
      const r = runChaos({
        seed,
        n: N,
        probs: { drop: 0.25, dup: 0.35, reorder: 0.5 },
        maxRetries: 100000,
        budget: 500000,
      });
      expect(r.sink.seqs.length).toBe(N);
      // Independent re-derivation of strict monotonicity from the record.
      for (let i = 0; i < r.sink.seqs.length; i++) {
        expect(r.sink.seqs[i]).toBe(i);
      }
      expect(r.sink.payloads).toEqual(r.sent);
    }
  });
});
