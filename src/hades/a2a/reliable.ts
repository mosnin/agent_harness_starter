/**
 * Reliable-ordered A2A delivery over an UNRELIABLE channel.
 *
 * The wire underneath may drop, reorder, or duplicate frames. This layer turns
 * it into an exactly-once, in-order stream for the application:
 *
 *   - {@link ReliableSender} assigns a monotonic `seq` (from 0), transmits a
 *     `data` frame, and retransmits it on a timer until the matching `ack`
 *     arrives (at-least-once on the wire). After `maxRetries` retransmits it
 *     gives up and reports the seq via `onGiveUp`.
 *   - {@link ReliableReceiver} ACKs every `data` frame it sees (even duplicates,
 *     so a sender whose ack was lost stops retransmitting), dedupes already-seen
 *     seqs, buffers out-of-order frames, and releases the contiguous in-order
 *     prefix to `deliver`. Each payload reaches `deliver` EXACTLY ONCE, in send
 *     order, regardless of drops/reorders/duplicates (given enough retransmits).
 *
 * All timers are injectable, so retransmit behavior tests deterministically.
 */

export type Frame =
  | { kind: "data"; seq: number; payload: unknown }
  | { kind: "ack"; seq: number };

export interface SenderOptions {
  /** Retransmit an unacked data frame after this long. Default 100. */
  ackTimeoutMs?: number;
  /** Give up (and count) after this many retransmits. Default 5. */
  maxRetries?: number;
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void;
  /** Called when a seq is abandoned after exhausting retries. */
  onGiveUp?: (seq: number) => void;
}

interface Unacked {
  frame: Extract<Frame, { kind: "data" }>;
  timer: ReturnType<typeof setTimeout>;
  retries: number;
}

/**
 * Sender side of the reliable layer. Assigns sequence numbers, transmits data
 * frames, and retransmits any frame not acknowledged within `ackTimeoutMs`,
 * up to `maxRetries` times before giving up.
 */
export class ReliableSender {
  private seq = 0;
  private retransmitCount = 0;
  private readonly unacked = new Map<number, Unacked>();
  private readonly ackTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => void;
  private readonly onGiveUp?: (seq: number) => void;

  constructor(
    private readonly transmit: (frame: Frame) => void,
    opts: SenderOptions = {}
  ) {
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 100;
    this.maxRetries = opts.maxRetries ?? 5;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((t) => clearTimeout(t));
    this.onGiveUp = opts.onGiveUp;
  }

  /**
   * Assign the next seq, transmit a data frame, schedule its retransmit, and
   * return the assigned seq.
   */
  send(payload: unknown): number {
    const seq = this.seq++;
    const frame: Extract<Frame, { kind: "data" }> = { kind: "data", seq, payload };
    const entry: Unacked = {
      frame,
      retries: 0,
      timer: this.schedule(seq),
    };
    this.unacked.set(seq, entry);
    this.transmit(frame);
    return seq;
  }

  /** Stop retransmitting the acked seq. Idempotent — a duplicate ack is harmless. */
  handleAck(frame: Frame): void {
    if (frame.kind !== "ack") return;
    const entry = this.unacked.get(frame.seq);
    if (!entry) return;
    this.clearTimeoutFn(entry.timer);
    this.unacked.delete(frame.seq);
  }

  /** Number of unacked data frames still in flight. */
  pending(): number {
    return this.unacked.size;
  }

  /** Total retransmissions performed so far. */
  retransmits(): number {
    return this.retransmitCount;
  }

  private schedule(seq: number): ReturnType<typeof setTimeout> {
    return this.setTimeoutFn(() => this.onTimeout(seq), this.ackTimeoutMs);
  }

  private onTimeout(seq: number): void {
    const entry = this.unacked.get(seq);
    if (!entry) return;
    if (entry.retries >= this.maxRetries) {
      this.clearTimeoutFn(entry.timer);
      this.unacked.delete(seq);
      this.onGiveUp?.(seq);
      return;
    }
    entry.retries++;
    this.retransmitCount++;
    entry.timer = this.schedule(seq);
    this.transmit(entry.frame);
  }
}

/**
 * Receiver side of the reliable layer. ACKs every data frame, dedupes seqs it
 * has already delivered or buffered, holds out-of-order frames, and releases the
 * contiguous in-order prefix to `deliver`.
 */
export class ReliableReceiver {
  private expected = 0;
  private readonly bufferMap = new Map<number, unknown>();
  private readonly onDuplicate?: (seq: number) => void;

  constructor(
    private readonly deliver: (payload: unknown, seq: number) => void,
    private readonly transmitAck: (frame: Frame) => void,
    opts: { onDuplicate?: (seq: number) => void } = {}
  ) {
    this.onDuplicate = opts.onDuplicate;
  }

  /**
   * ACK the frame, dedupe, buffer out-of-order, and release the in-order prefix
   * to `deliver`.
   */
  handleData(frame: Frame): void {
    if (frame.kind !== "data") return;
    const seq = frame.seq;
    // Always ACK, even a duplicate, so the sender stops retransmitting.
    this.transmitAck({ kind: "ack", seq });

    if (seq < this.expected) {
      // Already delivered.
      this.onDuplicate?.(seq);
      return;
    }
    if (seq === this.expected) {
      this.deliver(frame.payload, seq);
      this.expected++;
      this.drain();
      return;
    }
    // seq > expected: hold out-of-order, deduping against the buffer.
    if (this.bufferMap.has(seq)) {
      this.onDuplicate?.(seq);
      return;
    }
    this.bufferMap.set(seq, frame.payload);
  }

  /** The next seq that will be delivered. */
  nextExpected(): number {
    return this.expected;
  }

  /** Number of out-of-order frames currently held. */
  buffered(): number {
    return this.bufferMap.size;
  }

  private drain(): void {
    while (this.bufferMap.has(this.expected)) {
      const payload = this.bufferMap.get(this.expected);
      this.bufferMap.delete(this.expected);
      this.deliver(payload, this.expected);
      this.expected++;
    }
  }
}
