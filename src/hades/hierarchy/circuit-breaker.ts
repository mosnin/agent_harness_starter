/**
 * Circuit breaker state machine + a per-call timeout helper.
 *
 * ## Why a breaker matters
 * In a swarm, a hierarchy of agents delegates work down a tree. When some
 * subtree is persistently broken (a dead backend, a crashed peer, a poisoned
 * tool), naively retrying it forever is the worst outcome: every hop pays the
 * full latency to discover the failure, wasted work compounds, and the failure
 * fans back up the tree amplified. A circuit breaker lets the caller *fail
 * fast* — after enough consecutive failures it "opens" and short-circuits
 * subsequent calls immediately (throwing {@link CircuitOpenError} instead of
 * invoking the dead dependency), bounding both wasted work and tail latency.
 * After a cooldown it lets a single trial ("half-open") through to probe
 * recovery; one success closes it, one failure re-opens it.
 *
 * ## Determinism
 * Everything time-related is injectable. The clock is `opts.now` (defaults to
 * `Date.now`) and the only time-driven transition — OPEN → HALF-OPEN once the
 * cooldown has elapsed — happens *lazily* inside {@link CircuitBreaker.state}
 * and {@link CircuitBreaker.canPass} rather than via a real timer. That makes
 * the whole machine drivable by a fake clock in tests: advance the injected
 * `now()` and re-query, no wall-clock sleeping and no scheduler races.
 * Likewise {@link withTimeout} takes injectable `setTimeoutFn`/`clearTimeoutFn`
 * so timeout behavior can be exercised with fake timers.
 *
 * @module
 */

import type { SetTimeoutFn, ClearTimeoutFn } from "./timers";

export type BreakerState = "closed" | "open" | "half-open";

/** Thrown by {@link CircuitBreaker.exec} when a call is short-circuited (breaker not passing). */
export class CircuitOpenError extends Error {
  constructor(message = "circuit breaker is open") {
    super(message);
    this.name = "CircuitOpenError";
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

/** Thrown by {@link withTimeout} when a call exceeds its deadline. */
export class TimeoutError extends Error {
  constructor(message = "operation timed out") {
    super(message);
    this.name = "TimeoutError";
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip closed→open. Default 5. */
  failureThreshold?: number;
  /** Time (ms) a breaker stays open before allowing a half-open trial. Default 1000. */
  cooldownMs?: number;
  /** Consecutive successes in half-open that close it. Default 1. */
  successesToClose?: number;
  /** ms clock. Default () => Date.now(). */
  now?: () => number;
  /** Observability hook fired on every state transition. */
  onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly successesToClose: number;
  private readonly now: () => number;
  private readonly onStateChange?: (from: BreakerState, to: BreakerState) => void;

  private _state: BreakerState = "closed";
  /** Consecutive failures in CLOSED (toward failureThreshold). */
  private failureRun = 0;
  /** Consecutive successes in HALF-OPEN (toward successesToClose). */
  private halfOpenSuccesses = 0;
  /** Timestamp (per now()) at which the breaker last opened. */
  private openedAt = 0;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 1000;
    this.successesToClose = opts.successesToClose ?? 1;
    this.now = opts.now ?? (() => Date.now());
    this.onStateChange = opts.onStateChange;
  }

  private transition(to: BreakerState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    this.onStateChange?.(from, to);
  }

  /** Lazily promote OPEN → HALF-OPEN once cooldownMs has elapsed since opening. */
  private maybeHalfOpen(): void {
    if (this._state === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.halfOpenSuccesses = 0;
      this.transition("half-open");
    }
  }

  private open(): void {
    this.openedAt = this.now();
    this.failureRun = 0;
    this.halfOpenSuccesses = 0;
    this.transition("open");
  }

  private close(): void {
    this.failureRun = 0;
    this.halfOpenSuccesses = 0;
    this.transition("closed");
  }

  /**
   * Current state. Pure query except for the intentional, required lazy
   * OPEN → HALF-OPEN transition when the cooldown has elapsed.
   */
  state(): BreakerState {
    this.maybeHalfOpen();
    return this._state;
  }

  /** True if a call may proceed right now (closed, or half-open with trial budget remaining). */
  canPass(): boolean {
    const s = this.state();
    if (s === "closed") return true;
    if (s === "half-open") return this.halfOpenSuccesses < this.successesToClose;
    return false;
  }

  /** Record a completed success. */
  onSuccess(): void {
    // Resolve any pending lazy transition first so a success recorded after the
    // cooldown counts as a half-open trial, not a closed-state no-op.
    this.maybeHalfOpen();
    if (this._state === "half-open") {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.successesToClose) {
        this.close();
      }
      return;
    }
    // CLOSED: a success clears the consecutive-failure run. (OPEN: ignored.)
    this.failureRun = 0;
  }

  /** Record a failure. */
  onFailure(): void {
    this.maybeHalfOpen();
    if (this._state === "half-open") {
      // A single failure in half-open re-opens immediately (fresh openedAt).
      this.open();
      return;
    }
    if (this._state === "open") return;
    // CLOSED:
    this.failureRun += 1;
    if (this.failureRun >= this.failureThreshold) {
      this.open();
    }
  }

  /**
   * If `!canPass()` → throw {@link CircuitOpenError} WITHOUT calling fn.
   * Else run fn, record success/failure, and rethrow fn's original error.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canPass()) {
      throw new CircuitOpenError();
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Current consecutive-failure count (toward failureThreshold, in CLOSED). */
  failures(): number {
    return this.failureRun;
  }
}

/**
 * Reject with {@link TimeoutError} if `fn()` does not settle within `ms`.
 *
 * Uses injectable timers so tests are deterministic. On timeout the pending
 * `fn` promise is abandoned — its later settlement is ignored (guarded by a
 * `settled` flag). If `fn` settles first the timer is cleared. `ms <= 0` means
 * "no timeout": `fn()` is returned directly.
 */
export function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  opts: {
    setTimeoutFn?: SetTimeoutFn;
    clearTimeoutFn?: ClearTimeoutFn;
  } = {},
): Promise<T> {
  if (ms <= 0) {
    return fn();
  }
  const setTimeoutFn = opts.setTimeoutFn ?? ((cb, delay) => setTimeout(cb, delay));
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((t) => clearTimeout(t));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError());
    }, ms);

    fn().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        reject(err);
      },
    );
  });
}
