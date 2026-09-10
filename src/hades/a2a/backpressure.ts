/**
 * Credit-based backpressure (flow control).
 *
 * A sender must hold a *credit* to send. Credits are bounded by `capacity`, so
 * the number of in-flight items can NEVER exceed capacity — even under a fast
 * producer / slow consumer. This is the primitive that prevents the unbounded
 * buffering that OOMs naive pipelines: instead of queueing work without limit,
 * a fast producer simply *blocks* on `send` until a credit frees up. It is a
 * throttle, not a flag.
 */

/**
 * Bounded pool of credits with FIFO fairness.
 *
 * `inFlight` counts credits currently held. `acquire` takes a credit (or queues
 * a resolver when none are free); `release` hands a credit directly to the
 * oldest waiter, or returns it to the pool when nobody is waiting. `inFlight`
 * never exceeds `capacity` and never goes below zero.
 */
export class CreditController {
  readonly capacity: number;
  private _inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error(`CreditController capacity must be >= 1, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  /**
   * Resolve immediately if a credit is free (incrementing in-flight), otherwise
   * queue FIFO and resolve when a future `release` hands a credit over.
   */
  acquire(): Promise<void> {
    if (this._inFlight < this.capacity) {
      this._inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Release a credit. If a waiter is queued, the credit passes directly to the
   * oldest one (in-flight unchanged). Otherwise the credit returns to the pool
   * (in-flight decremented, floored at 0 — over-release is a safe no-op).
   */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    if (this._inFlight > 0) this._inFlight--;
  }

  /** Credits currently free. */
  available(): number {
    return this.capacity - this._inFlight;
  }

  /** Credits currently held. */
  inFlight(): number {
    return this._inFlight;
  }

  /** Number of queued acquirers awaiting a credit. */
  waiting(): number {
    return this.waiters.length;
  }
}

export interface FlowStats {
  sent: number;
  consumed: number;
  maxInFlight: number;
}

/**
 * A channel that paces a producer against a consumer using credits.
 *
 * `send` acquires a credit before starting the consume — so a fast producer
 * awaiting `send` is naturally throttled and in-flight work is bounded by
 * `capacity` (never buffered without limit). The credit is released when the
 * consume settles, freeing the next blocked `send`.
 */
export class BackpressuredChannel<T> {
  private readonly credits: CreditController;
  private readonly consume: (item: T) => Promise<void>;
  private _sent = 0;
  private _consumed = 0;
  private _current = 0;
  private _maxInFlight = 0;
  private readonly drainWaiters: Array<() => void> = [];

  constructor(capacity: number, consume: (item: T) => Promise<void>) {
    this.credits = new CreditController(capacity);
    this.consume = consume;
  }

  /**
   * Acquire a credit (BLOCKING the producer when capacity is reached — the
   * backpressure point), then start consuming the item without awaiting it. The
   * credit is released when consume settles. Resolves once the credit is
   * acquired, not when consume finishes.
   */
  async send(item: T): Promise<void> {
    await this.credits.acquire();
    this._sent++;
    this._current++;
    if (this._current > this._maxInFlight) this._maxInFlight = this._current;

    void Promise.resolve()
      .then(() => this.consume(item))
      .then(
        () => this.onSettled(),
        () => this.onSettled()
      );
  }

  private onSettled(): void {
    this._current--;
    this._consumed++;
    this.credits.release();
    this.maybeDrain();
  }

  private maybeDrain(): void {
    if (this._consumed === this._sent && this.credits.inFlight() === 0) {
      while (this.drainWaiters.length) this.drainWaiters.shift()!();
    }
  }

  /** Resolve once every sent item has finished consuming and no credits are outstanding. */
  drain(): Promise<void> {
    if (this._consumed === this._sent && this.credits.inFlight() === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  stats(): FlowStats {
    return { sent: this._sent, consumed: this._consumed, maxInFlight: this._maxInFlight };
  }
}
