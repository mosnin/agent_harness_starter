/**
 * The determinism seam for everything in `src/hades/schedule/**`.
 *
 * Every module in this package (the job store, the cron scheduler, misfire
 * / catch-up logic) MUST take time from an injected `Clock` rather than
 * calling `Date.now()` directly. That is the whole point of this file: a
 * production process wires `systemClock` in once, at the top, and every
 * test — including ones that need to simulate minutes or days passing to
 * exercise misfire policies deterministically — wires in a `ManualClock`
 * instead. No module downstream of this file is allowed to have its own
 * opinion about what time it is.
 *
 * `ManualClock.set` only moves forward on purpose: a store keyed on
 * monotonically increasing `updatedAt`/`firedAt` timestamps (see
 * `store.ts`) would have its whole ordering and "already ran" bookkeeping
 * silently corrupted by a clock that quietly rewound mid-test. Forcing
 * backwards jumps to throw means a test that tries to simulate time travel
 * fails loudly at the clock, not mysteriously three assertions later.
 */

/** Anything that can report "now", as epoch milliseconds. */
export interface Clock {
  now(): number;
}

/** The real clock: `Date.now()`. Wire this into production code paths. */
export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },
};

/**
 * A fully controllable clock for tests and simulations. Starts at
 * `startEpochMs` and only ever moves forward, either by an explicit
 * duration (`advance`) or to an explicit absolute instant (`set`).
 */
export class ManualClock implements Clock {
  private currentEpochMs: number;

  constructor(startEpochMs: number) {
    if (!Number.isFinite(startEpochMs)) {
      throw new TypeError(`ManualClock: startEpochMs must be a finite number, got ${String(startEpochMs)}`);
    }
    this.currentEpochMs = startEpochMs;
  }

  now(): number {
    return this.currentEpochMs;
  }

  /**
   * Advance the clock by `ms` milliseconds and return the new `now()`.
   * `ms` must be a finite, non-negative number — advancing by a negative
   * duration would be indistinguishable from time travel, which is exactly
   * what this class exists to make impossible; use a smaller `advance` or
   * simply don't advance instead.
   */
  advance(ms: number): number {
    if (!Number.isFinite(ms)) {
      throw new TypeError(`ManualClock.advance: ms must be a finite number, got ${String(ms)}`);
    }
    if (ms < 0) {
      throw new RangeError(`ManualClock.advance: ms must be >= 0, got ${ms} (use set() if you truly need a jump)`);
    }
    this.currentEpochMs += ms;
    return this.currentEpochMs;
  }

  /**
   * Jump the clock to an absolute instant. May only move forward (or stay
   * put) — a caller that passes an `epochMs` earlier than the current
   * `now()` gets a thrown `RangeError` rather than a silently rewound
   * clock, so tests can never accidentally simulate time travel.
   */
  set(epochMs: number): void {
    if (!Number.isFinite(epochMs)) {
      throw new TypeError(`ManualClock.set: epochMs must be a finite number, got ${String(epochMs)}`);
    }
    if (epochMs < this.currentEpochMs) {
      throw new RangeError(
        `ManualClock.set: cannot move backwards (current=${this.currentEpochMs}, requested=${epochMs})`,
      );
    }
    this.currentEpochMs = epochMs;
  }
}
