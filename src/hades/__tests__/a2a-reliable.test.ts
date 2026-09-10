import { describe, it, expect } from "vitest";
import { Frame, ReliableSender, ReliableReceiver, SenderOptions } from "../a2a/reliable";

/** A manual scheduler: capture retransmit callbacks and fire them on demand. */
class ManualClock {
  private cbs: Array<() => void> = [];
  readonly setTimeoutFn: SenderOptions["setTimeoutFn"] = (cb) => {
    this.cbs.push(cb);
    return this.cbs.length as unknown as ReturnType<typeof setTimeout>;
  };
  readonly clearTimeoutFn: SenderOptions["clearTimeoutFn"] = (t) => {
    const idx = (t as unknown as number) - 1;
    // Mark as cleared so a later fireAll skips it.
    this.cbs[idx] = () => {};
  };
  /** Fire the timer registered as index `idx` (0-based over all registrations). */
  fire(idx: number): void {
    const cb = this.cbs[idx];
    if (cb) cb();
  }
  /** Fire the most recently scheduled (still-live) callback. */
  fireLast(): void {
    this.fire(this.cbs.length - 1);
  }
  count(): number {
    return this.cbs.length;
  }
}

describe("ReliableSender + ReliableReceiver", () => {
  it("clean path: 5 payloads through a perfect channel deliver in order", () => {
    const clock = new ManualClock();
    const delivered: Array<{ payload: unknown; seq: number }> = [];

    let sender!: ReliableSender;
    const receiver = new ReliableReceiver(
      (payload, seq) => delivered.push({ payload, seq }),
      (ack) => sender.handleAck(ack)
    );
    sender = new ReliableSender(
      (frame) => receiver.handleData(frame),
      { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn }
    );

    for (let i = 0; i < 5; i++) sender.send({ i });

    expect(delivered.map((d) => d.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(delivered.map((d) => (d.payload as { i: number }).i)).toEqual([0, 1, 2, 3, 4]);
    expect(sender.pending()).toBe(0);
    expect(sender.retransmits()).toBe(0);
    expect(receiver.nextExpected()).toBe(5);
  });

  it("dropped data + retransmit: first transmission of seq 2 is dropped", () => {
    const clock = new ManualClock();
    const delivered: number[] = [];

    let sender!: ReliableSender;
    const receiver = new ReliableReceiver(
      (_p, seq) => delivered.push(seq),
      (ack) => sender.handleAck(ack)
    );

    let dropNextSeq2 = true;
    sender = new ReliableSender(
      (frame) => {
        if (frame.kind === "data" && frame.seq === 2 && dropNextSeq2) {
          dropNextSeq2 = false; // drop only the first transmission
          return;
        }
        receiver.handleData(frame);
      },
      { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn }
    );

    sender.send({ i: 0 });
    sender.send({ i: 1 });
    sender.send({ i: 2 }); // dropped on first transmit
    sender.send({ i: 3 });
    sender.send({ i: 4 });

    // seq 2's data never reached the receiver; 3 and 4 are buffered (but ACKed).
    expect(delivered).toEqual([0, 1]);
    expect(receiver.buffered()).toBe(2);
    expect(sender.pending()).toBe(1); // only seq 2 unacked (its data was dropped)

    // Fire seq 2's retransmit timer (registered at index 2).
    clock.fire(2);

    expect(delivered).toEqual([0, 1, 2, 3, 4]);
    expect(sender.retransmits()).toBeGreaterThanOrEqual(1);
    expect(sender.pending()).toBe(0);
    expect(receiver.buffered()).toBe(0);
  });

  it("reordered delivery: seq 2 arrives before seq 1", () => {
    const delivered: number[] = [];
    let sender!: ReliableSender;
    const receiver = new ReliableReceiver(
      (_p, seq) => delivered.push(seq),
      (ack) => sender.handleAck(ack)
    );
    // No-op transmit; we drive the receiver directly to control ordering.
    sender = new ReliableSender(() => {});

    const f0: Frame = { kind: "data", seq: 0, payload: "a" };
    const f1: Frame = { kind: "data", seq: 1, payload: "b" };
    const f2: Frame = { kind: "data", seq: 2, payload: "c" };

    receiver.handleData(f0);
    expect(delivered).toEqual([0]);

    receiver.handleData(f2); // out of order → buffered
    expect(delivered).toEqual([0]);
    expect(receiver.buffered()).toBe(1);

    receiver.handleData(f1); // fills the gap → 1 then buffered 2 drain
    expect(delivered).toEqual([0, 1, 2]);
    expect(receiver.buffered()).toBe(0);
  });

  it("duplicate data: seq 1 delivered twice on the wire, delivered once", () => {
    const delivered: number[] = [];
    const acks: number[] = [];
    const dupes: number[] = [];
    const receiver = new ReliableReceiver(
      (_p, seq) => delivered.push(seq),
      (ack) => {
        if (ack.kind === "ack") acks.push(ack.seq);
      },
      { onDuplicate: (seq) => dupes.push(seq) }
    );

    receiver.handleData({ kind: "data", seq: 0, payload: "a" });
    receiver.handleData({ kind: "data", seq: 1, payload: "b" });
    receiver.handleData({ kind: "data", seq: 1, payload: "b" }); // duplicate

    expect(delivered).toEqual([0, 1]);
    expect(dupes).toEqual([1]);
    // ACK sent for every data frame, including the duplicate.
    expect(acks).toEqual([0, 1, 1]);
  });

  it("dropped ACK causes retransmit but receiver dedupes (no redelivery)", () => {
    const clock = new ManualClock();
    const delivered: number[] = [];
    const dupes: number[] = [];

    let sender!: ReliableSender;
    let dropAckForSeq0 = true;
    const receiver = new ReliableReceiver(
      (_p, seq) => delivered.push(seq),
      (ack) => {
        if (ack.kind === "ack" && ack.seq === 0 && dropAckForSeq0) {
          dropAckForSeq0 = false; // drop only the first ack for seq 0
          return;
        }
        sender.handleAck(ack);
      },
      { onDuplicate: (seq) => dupes.push(seq) }
    );
    sender = new ReliableSender(
      (frame) => receiver.handleData(frame),
      { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn }
    );

    sender.send({ i: 0 });
    // Data 0 delivered; its ack was dropped, so the sender still thinks it's pending.
    expect(delivered).toEqual([0]);
    expect(sender.pending()).toBe(1);

    // Fire the retransmit timer → data 0 re-sent → receiver dedupes + re-acks.
    clock.fire(0);

    expect(delivered).toEqual([0]); // NOT redelivered
    expect(dupes).toEqual([0]);
    expect(sender.retransmits()).toBe(1);
    expect(sender.pending()).toBe(0); // second ack got through
  });

  it("maxRetries exhaustion: a black-hole channel gives up after maxRetries", () => {
    const clock = new ManualClock();
    const gaveUp: number[] = [];

    const sender = new ReliableSender(
      () => {}, // black hole: nothing is delivered, no acks ever come back
      {
        maxRetries: 3,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        onGiveUp: (seq) => gaveUp.push(seq),
      }
    );

    sender.send({ i: 0 });
    expect(sender.pending()).toBe(1);

    // Fire the seq-0 timer maxRetries times (retransmits), then once more (give up).
    clock.fire(0); // retransmit 1
    clock.fire(0); // retransmit 2
    clock.fire(0); // retransmit 3
    expect(sender.retransmits()).toBe(3);
    expect(gaveUp).toEqual([]);
    expect(sender.pending()).toBe(1);

    clock.fire(0); // exhausted → give up
    expect(gaveUp).toEqual([0]);
    expect(sender.pending()).toBe(0);
    expect(sender.retransmits()).toBe(3);
  });
});
