export interface RateLimiterOptions {
  /** Tokens (messages) allowed per window. */
  capacity: number;
  /** Refill: `capacity` tokens per this many ms. */
  refillMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Per-key token-bucket rate limiter — protects the gateway (and downstream
 * swarm) from a chatty or abusive channel/user. Pure token math with an
 * injectable clock, so it tests deterministically without real time.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillMs: number;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions) {
    this.capacity = opts.capacity;
    this.refillMs = opts.refillMs;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Try to consume one token for `key`. Returns false if rate-limited. */
  tryAcquire(key: string): boolean {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, lastRefill: now };
    // Continuous refill proportional to elapsed time.
    const elapsed = now - b.lastRefill;
    if (elapsed > 0) {
      const refill = (elapsed / this.refillMs) * this.capacity;
      b.tokens = Math.min(this.capacity, b.tokens + refill);
      b.lastRefill = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return true;
    }
    this.buckets.set(key, b);
    return false;
  }

  /** Remaining whole tokens for a key (for diagnostics). */
  remaining(key: string): number {
    return Math.floor(this.buckets.get(key)?.tokens ?? this.capacity);
  }
}
