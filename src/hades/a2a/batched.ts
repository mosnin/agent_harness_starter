/**
 * A coalescing {@link A2ATransport} wrapper. A burst of `publish` calls is
 * queued and drained together on a single scheduler turn instead of paying
 * per-message scheduling overhead. FIFO order is preserved end-to-end, so
 * per-link ordering (A before B before C on a given link) is never disturbed —
 * batching only changes *when* messages hit the inner transport, not their
 * relative order.
 */

import type { A2ATransport } from "./bus";
import type { A2AMessage, AgentAddress } from "./types";

export interface BatchedOptions {
  /** Flush synchronously once the queue reaches this size (default 64). */
  maxBatch?: number;
  /** Schedule an async flush; defaults to `queueMicrotask`. */
  scheduleFlush?: (cb: () => void) => void;
  /** Observability hook fired with the size of each flushed batch. */
  onFlush?: (batchSize: number) => void;
}

export class BatchedA2ATransport implements A2ATransport {
  private readonly queue: A2AMessage[] = [];
  private readonly maxBatch: number;
  private readonly scheduleFlush: (cb: () => void) => void;
  private readonly onFlush?: (batchSize: number) => void;
  private scheduled = false;

  constructor(
    private readonly inner: A2ATransport,
    opts: BatchedOptions = {}
  ) {
    this.maxBatch = opts.maxBatch ?? 64;
    this.scheduleFlush = opts.scheduleFlush ?? ((cb) => queueMicrotask(cb));
    this.onFlush = opts.onFlush;
  }

  publish(msg: A2AMessage): void {
    this.queue.push(msg);
    // A full queue flushes immediately (sync), bounding memory and latency.
    if (this.queue.length >= this.maxBatch) {
      this.flush();
      return;
    }
    if (!this.scheduled) {
      this.scheduled = true;
      this.scheduleFlush(() => this.flush());
    }
  }

  flush(): void {
    // Reset the scheduled flag up front so publishes during draining re-arm it.
    this.scheduled = false;
    const batchSize = this.queue.length;
    if (batchSize === 0) {
      return;
    }
    // Drain in FIFO order to preserve per-link ordering.
    for (let i = 0; i < batchSize; i++) {
      // `queue[i]` is defined for i < batchSize; splice-free iteration is faster.
      void this.inner.publish(this.queue[i]!);
    }
    this.queue.length = 0;
    this.onFlush?.(batchSize);
  }

  register(address: AgentAddress, handler: (msg: A2AMessage) => void): () => void {
    return this.inner.register(address, handler);
  }

  /** Number of messages queued but not yet flushed. */
  pending(): number {
    return this.queue.length;
  }
}
