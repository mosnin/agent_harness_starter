import { describe, it, expect } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  TimeoutError,
  withTimeout,
  type BreakerState,
} from "../hierarchy/circuit-breaker";

/** Tiny controllable clock. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe("CircuitBreaker state machine", () => {
  it("opens after exactly failureThreshold consecutive failures, not before", () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 3, now: clock.now });
    expect(cb.state()).toBe("closed");
    cb.onFailure();
    cb.onFailure();
    expect(cb.state()).toBe("closed");
    expect(cb.failures()).toBe(2);
    cb.onFailure(); // 3rd -> trips
    expect(cb.state()).toBe("open");
    expect(cb.canPass()).toBe(false);
  });

  it("onSuccess resets the consecutive-failure run in closed", () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 3, now: clock.now });
    cb.onFailure();
    cb.onFailure();
    expect(cb.failures()).toBe(2);
    cb.onSuccess();
    expect(cb.failures()).toBe(0);
    // Threshold worth of failures again is still needed to trip.
    cb.onFailure();
    cb.onFailure();
    expect(cb.state()).toBe("closed");
    cb.onFailure();
    expect(cb.state()).toBe("open");
  });

  it("exec throws CircuitOpenError WITHOUT invoking fn when open", async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 1, now: clock.now });
    cb.onFailure(); // open
    expect(cb.state()).toBe("open");

    let calls = 0;
    const fn = async () => {
      calls += 1;
      return "ok";
    };
    await expect(cb.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(0);
  });

  it("lazily transitions open -> half-open after cooldownMs elapses", () => {
    const clock = fakeClock(1000);
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: clock.now });
    cb.onFailure(); // opens at t=1000
    expect(cb.state()).toBe("open");

    clock.advance(499);
    expect(cb.state()).toBe("open");
    expect(cb.canPass()).toBe(false);

    clock.advance(1); // now exactly cooldownMs elapsed
    expect(cb.state()).toBe("half-open");
    expect(cb.canPass()).toBe(true);
  });

  it("half-open: a trial success closes the breaker", () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 100,
      successesToClose: 1,
      now: clock.now,
    });
    cb.onFailure();
    clock.advance(100);
    expect(cb.state()).toBe("half-open");
    cb.onSuccess();
    expect(cb.state()).toBe("closed");
    expect(cb.failures()).toBe(0);
  });

  it("half-open: a single trial failure re-opens immediately with a fresh openedAt", () => {
    const clock = fakeClock(0);
    const cb = new CircuitBreaker({
      failureThreshold: 5,
      cooldownMs: 100,
      now: clock.now,
    });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    cb.onFailure(); // opens at t=0
    clock.advance(100);
    expect(cb.state()).toBe("half-open");

    cb.onFailure(); // re-opens immediately at t=100, not waiting for threshold
    expect(cb.state()).toBe("open");
    expect(cb.canPass()).toBe(false);

    clock.advance(99);
    expect(cb.state()).toBe("open"); // cooldown measured from the new openedAt
    clock.advance(1);
    expect(cb.state()).toBe("half-open");
  });

  it("successesToClose>1: needs that many half-open successes to close", () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      successesToClose: 2,
      now: clock.now,
    });
    cb.onFailure();
    clock.advance(10);
    expect(cb.state()).toBe("half-open");
    cb.onSuccess();
    expect(cb.state()).toBe("half-open"); // one more needed
    expect(cb.canPass()).toBe(true);
    cb.onSuccess();
    expect(cb.state()).toBe("closed");
  });

  it("fires onStateChange transitions in order across a full cycle", () => {
    const clock = fakeClock(0);
    const seen: Array<[BreakerState, BreakerState]> = [];
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 100,
      successesToClose: 1,
      now: clock.now,
      onStateChange: (from, to) => seen.push([from, to]),
    });
    cb.onFailure(); // closed -> open
    clock.advance(100);
    cb.state(); // lazily open -> half-open
    cb.onSuccess(); // half-open -> closed
    expect(seen).toEqual([
      ["closed", "open"],
      ["open", "half-open"],
      ["half-open", "closed"],
    ]);
  });

  it("exec records success/failure and rethrows the original error", async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 2, now: clock.now });
    await expect(cb.exec(async () => 42)).resolves.toBe(42);
    expect(cb.failures()).toBe(0);

    const boom = new Error("boom");
    await expect(cb.exec(async () => {
      throw boom;
    })).rejects.toBe(boom);
    expect(cb.failures()).toBe(1);
  });
});

describe("withTimeout", () => {
  /** Minimal fake timer registry driven manually. */
  function fakeTimers() {
    let id = 0;
    const scheduled = new Map<number, { cb: () => void; ms: number }>();
    return {
      setTimeoutFn: ((cb: () => void, ms: number) => {
        const t = ++id;
        scheduled.set(t, { cb, ms });
        return t as unknown as ReturnType<typeof setTimeout>;
      }) as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimeoutFn: ((t: ReturnType<typeof setTimeout>) => {
        scheduled.delete(t as unknown as number);
      }) as (t: ReturnType<typeof setTimeout>) => void,
      fire: () => {
        for (const { cb } of scheduled.values()) cb();
      },
      pending: () => scheduled.size,
    };
  }

  it("rejects with TimeoutError when fn hangs, and ignores its late settlement", async () => {
    const timers = fakeTimers();
    let resolveHang: (v: string) => void = () => {};
    const hang = () => new Promise<string>((res) => {
      resolveHang = res;
    });

    const p = withTimeout(hang, 50, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    timers.fire(); // trip the timeout
    await expect(p).rejects.toBeInstanceOf(TimeoutError);

    // Late settlement is ignored (no unhandled rejection, no double settle).
    resolveHang("too late");
    await Promise.resolve();
  });

  it("resolves with fn's value and clears the timer when fn is fast", async () => {
    const timers = fakeTimers();
    const fast = async () => "quick";
    const p = withTimeout(fast, 50, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await expect(p).resolves.toBe("quick");
    expect(timers.pending()).toBe(0); // timer was cleared
  });

  it("propagates fn's rejection (not a TimeoutError) and clears the timer", async () => {
    const timers = fakeTimers();
    const boom = new Error("nope");
    const p = withTimeout(async () => {
      throw boom;
    }, 50, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await expect(p).rejects.toBe(boom);
    expect(timers.pending()).toBe(0);
  });

  it("ms<=0 bypasses the timeout and returns fn() directly", async () => {
    const timers = fakeTimers();
    const p = withTimeout(async () => "direct", 0, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await expect(p).resolves.toBe("direct");
    expect(timers.pending()).toBe(0); // no timer ever scheduled
  });
});
