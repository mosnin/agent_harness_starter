/**
 * Per-subtree circuit-breaker registry — the hop-level guard for the hierarchy.
 *
 * ## Why per-subtree breakers
 * A hierarchy of agents delegates work down a tree; each hop targets some
 * subtree/node by id. A single global breaker would be too coarse: one broken
 * branch would trip the breaker for every branch, so a single dead backend
 * would take down calls to healthy siblings. This registry instead keeps **one
 * {@link CircuitBreaker} per subtree/node id**. A bad branch is isolated and
 * short-circuited on its own breaker while healthy branches keep passing —
 * failure is contained to the subtree that actually failed.
 *
 * ## What {@link BreakerRegistry.guard} guarantees
 * `guard(id, fn)` routes the hop through that subtree's breaker via
 * `breaker.exec()`. Once a subtree's breaker is OPEN (after `failureThreshold`
 * consecutive failures), further hops to that id **fail fast** with a
 * {@link CircuitOpenError} and `fn` is *never invoked* — the "short-circuit a
 * persistently failing subtree, don't retry it forever" property. A per-hop
 * timeout (`opts.timeoutMs`) wraps `fn` in {@link withTimeout}, so a *hanging*
 * subtree produces a {@link TimeoutError} that the breaker counts exactly like
 * a thrown error: a hung branch trips its breaker just as an erroring one does.
 *
 * ## Determinism
 * The clock (`now`) and the timers (`setTimeoutFn`/`clearTimeoutFn`) are all
 * injectable through {@link BreakerRegistryOptions} and forwarded to the
 * breakers and to {@link withTimeout}, so the whole registry is drivable by a
 * fake clock plus fake timers with no wall-clock sleeping.
 *
 * @module
 */

import type { SetTimeoutFn, ClearTimeoutFn } from "./timers";

import {
  CircuitBreaker,
  type BreakerState,
  withTimeout,
} from "./circuit-breaker";

export interface BreakerRegistryOptions {
  /** Consecutive failures that trip a subtree's breaker closed→open. Forwarded to each breaker. */
  failureThreshold?: number;
  /** Time (ms) a breaker stays open before allowing a half-open trial. Forwarded to each breaker. */
  cooldownMs?: number;
  /** Consecutive successes in half-open that close a breaker. Forwarded to each breaker. */
  successesToClose?: number;
  /** ms clock. Default () => Date.now(). Forwarded to each breaker. */
  now?: () => number;
  /** Injectable timer for per-hop timeouts. Forwarded to {@link withTimeout}. */
  setTimeoutFn?: SetTimeoutFn;
  /** Injectable timer clear for per-hop timeouts. Forwarded to {@link withTimeout}. */
  clearTimeoutFn?: ClearTimeoutFn;
  /** Observability hook fired on every state transition, tagged with the subtree id. */
  onStateChange?: (id: string, from: BreakerState, to: BreakerState) => void;
}

/**
 * A collection of circuit breakers keyed by subtree/node id — one breaker per
 * hierarchy branch. Lazily creates a breaker on first access to an id and
 * guards each hop through the breaker for that id.
 */
export class BreakerRegistry {
  private readonly opts: BreakerRegistryOptions;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(opts: BreakerRegistryOptions = {}) {
    this.opts = opts;
  }

  /**
   * The breaker for subtree/node `id`, lazily created on first access with the
   * registry's options. Repeated calls with the same id return the **same**
   * cached {@link CircuitBreaker} instance.
   */
  get(id: string): CircuitBreaker {
    let breaker = this.breakers.get(id);
    if (breaker === undefined) {
      breaker = new CircuitBreaker({
        failureThreshold: this.opts.failureThreshold,
        cooldownMs: this.opts.cooldownMs,
        successesToClose: this.opts.successesToClose,
        now: this.opts.now,
        onStateChange: this.opts.onStateChange
          ? (from, to) => this.opts.onStateChange!(id, from, to)
          : undefined,
      });
      this.breakers.set(id, breaker);
    }
    return breaker;
  }

  /**
   * Guard a hop to subtree `id`. If that subtree's breaker won't pass (it is
   * open, or a spent half-open) this throws {@link CircuitOpenError} and does
   * **not** call `fn`. Otherwise `fn` runs under an optional per-hop timeout
   * (`opts.timeoutMs`, via {@link withTimeout}); a timeout OR a thrown error
   * records a failure on the breaker, a completed value records a success, and
   * the original error (`TimeoutError` or `fn`'s own) is rethrown unchanged.
   *
   * After `failureThreshold` consecutive failures (errors or timeouts) to the
   * subtree, subsequent guarded hops fail fast without ever invoking `fn`.
   */
  guard<T>(
    id: string,
    fn: () => Promise<T>,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const breaker = this.get(id);
    const timeoutMs = opts.timeoutMs ?? 0;
    return breaker.exec(() =>
      withTimeout(fn, timeoutMs, {
        setTimeoutFn: this.opts.setTimeoutFn,
        clearTimeoutFn: this.opts.clearTimeoutFn,
      }),
    );
  }

  /**
   * Current {@link BreakerState} of every known breaker, keyed by id. This is
   * the source of truth: it reports "half-open" distinctly from "open".
   * Reading state may lazily promote an elapsed open breaker to half-open.
   */
  states(): Record<string, BreakerState> {
    const out: Record<string, BreakerState> = {};
    for (const [id, breaker] of this.breakers) {
      out[id] = breaker.state();
    }
    return out;
  }

  /**
   * How many breakers are currently strictly OPEN.
   *
   * Contract: `openCount` counts only breakers whose `state()` is exactly
   * `"open"`. Half-open breakers are NOT counted here (a half-open breaker is
   * probing recovery and lets a trial hop through, so it is not "open" for the
   * purpose of this count). Use {@link states} for the full per-id truth.
   */
  openCount(): number {
    let n = 0;
    for (const breaker of this.breakers.values()) {
      if (breaker.state() === "open") n += 1;
    }
    return n;
  }

  /**
   * Ids whose breaker is currently strictly OPEN — consistent with
   * {@link openCount} (half-open ids are excluded).
   */
  openIds(): string[] {
    const ids: string[] = [];
    for (const [id, breaker] of this.breakers) {
      if (breaker.state() === "open") ids.push(id);
    }
    return ids;
  }
}
