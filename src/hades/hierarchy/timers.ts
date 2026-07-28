/**
 * The injectable timer seam's handle type.
 *
 * Every resilience primitive here (`circuit-breaker`, `resilient`, `chaos`,
 * `breaker-registry`) takes `setTimeoutFn`/`clearTimeoutFn` so a test can drive
 * time deterministically instead of sleeping. Those seams used to be typed
 * `ReturnType<typeof setTimeout>`, which under `@types/node` is
 * `NodeJS.Timeout` — an opaque class with `ref`/`unref`/`hasRef`/`refresh` and
 * a `Symbol.toPrimitive`.
 *
 * That defeated the seam. A fake timer wants to hand back a plain incrementing
 * id and be given it back on clear; requiring `NodeJS.Timeout` forced tests to
 * fabricate an object they never use, or to cast — and a cast in a test is a
 * silent invitation for the fake and the real implementation to drift apart.
 *
 * {@link TimerHandle} names what the contract actually is: *whatever token the
 * injected pair agrees on*. The real global `setTimeout` satisfies it (it
 * returns `NodeJS.Timeout`, a member of the union), a fake returning a number
 * satisfies it, and Node's own `clearTimeout` already accepts both — so
 * production behaviour is unchanged while the seam becomes usable as designed.
 *
 * @module hades/hierarchy/timers
 */

/**
 * A token returned by a scheduling function and accepted by its matching
 * cancel function. Deliberately a union rather than `unknown`: the two halves
 * of an injected pair must agree, and both real Node timers and simple
 * numeric ids are legitimate.
 */
export type TimerHandle = ReturnType<typeof setTimeout> | number;

/** Schedule `cb` after `ms`, returning a cancellable {@link TimerHandle}. */
export type SetTimeoutFn = (cb: () => void, ms: number) => TimerHandle;

/** Cancel a pending timer previously returned by a {@link SetTimeoutFn}. */
export type ClearTimeoutFn = (handle: TimerHandle) => void;
