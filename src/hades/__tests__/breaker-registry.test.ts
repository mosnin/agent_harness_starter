import { describe, it, expect } from "vitest";
import { BreakerRegistry } from "../hierarchy/breaker-registry";
import {
  CircuitBreaker,
  CircuitOpenError,
  TimeoutError,
} from "../hierarchy/circuit-breaker";

/**
 * A fake timer bank driven by the same fake clock the breakers use. Timers
 * registered via setTimeoutFn fire when `advance(ms)` crosses their deadline,
 * so a per-hop timeout is fully deterministic — no wall-clock sleeping.
 */
function makeFakeTimers(now: () => number) {
  interface Timer {
    id: number;
    fireAt: number;
    cb: () => void;
    cleared: boolean;
  }
  const timers: Timer[] = [];
  let seq = 1;
  const setTimeoutFn = (cb: () => void, ms: number) => {
    const t: Timer = { id: seq++, fireAt: now() + ms, cb, cleared: false };
    timers.push(t);
    return t.id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutFn = (handle: ReturnType<typeof setTimeout>) => {
    const id = handle as unknown as number;
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  };
  /** Fire every non-cleared timer whose deadline is <= the current clock. */
  const flush = () => {
    for (const t of timers) {
      if (!t.cleared && now() >= t.fireAt) {
        t.cleared = true;
        t.cb();
      }
    }
  };
  return { setTimeoutFn, clearTimeoutFn, flush };
}

const fail = () => Promise.reject(new Error("boom"));
const ok = () => Promise.resolve("ok");

describe("BreakerRegistry", () => {
  it("get(id) lazily creates and caches one breaker per id (same id → same instance)", () => {
    const reg = new BreakerRegistry();
    const a1 = reg.get("A");
    const a2 = reg.get("A");
    const b = reg.get("B");
    expect(a1).toBeInstanceOf(CircuitBreaker);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("isolates failures per id: failing A opens A but leaves B closed", async () => {
    let clock = 0;
    const reg = new BreakerRegistry({ failureThreshold: 3, now: () => clock });

    for (let i = 0; i < 3; i++) {
      await expect(reg.guard("A", fail)).rejects.toThrow("boom");
    }
    // B has never failed.
    await expect(reg.guard("B", ok)).resolves.toBe("ok");

    expect(reg.states()).toEqual({ A: "open", B: "closed" });
    expect(reg.openIds()).toEqual(["A"]);
    expect(reg.openCount()).toBe(1);
  });

  it("guard short-circuits after threshold: fn stops being invoked once open", async () => {
    let clock = 0;
    const reg = new BreakerRegistry({ failureThreshold: 3, now: () => clock });
    let calls = 0;
    const trackedFail = () => {
      calls += 1;
      return Promise.reject(new Error("boom"));
    };

    // First 3 hops actually invoke fn and fail, tripping the breaker open.
    for (let i = 0; i < 3; i++) {
      await expect(reg.guard("A", trackedFail)).rejects.toThrow("boom");
    }
    expect(calls).toBe(3);
    expect(reg.states().A).toBe("open");

    // Further hops must SHORT-CIRCUIT: CircuitOpenError, fn NOT invoked.
    for (let i = 0; i < 5; i++) {
      await expect(reg.guard("A", trackedFail)).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
    }
    // The key property: invocation count did not climb past the threshold.
    expect(calls).toBe(3);
  });

  it("a hung fn + timeoutMs → TimeoutError counts as a failure and opens the breaker", async () => {
    let clock = 0;
    const timers = makeFakeTimers(() => clock);
    const reg = new BreakerRegistry({
      failureThreshold: 2,
      now: () => clock,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    // fn that never settles → must time out.
    const hung = () => new Promise<string>(() => {});

    for (let i = 0; i < 2; i++) {
      const p = reg.guard("A", hung, { timeoutMs: 100 });
      clock += 100;
      timers.flush();
      await expect(p).rejects.toBeInstanceOf(TimeoutError);
    }

    expect(reg.states().A).toBe("open");
    expect(reg.openCount()).toBe(1);
  });

  it("success under a generous timeout records a success and keeps the breaker closed", async () => {
    let clock = 0;
    const timers = makeFakeTimers(() => clock);
    const reg = new BreakerRegistry({
      failureThreshold: 2,
      now: () => clock,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    await expect(reg.guard("A", ok, { timeoutMs: 100 })).resolves.toBe("ok");
    expect(reg.states().A).toBe("closed");
    expect(reg.openCount()).toBe(0);
  });

  it("cooldown → half-open → recovery via guard", async () => {
    let clock = 0;
    const reg = new BreakerRegistry({
      failureThreshold: 2,
      cooldownMs: 1000,
      successesToClose: 1,
      now: () => clock,
    });

    // Trip open.
    await expect(reg.guard("A", fail)).rejects.toThrow("boom");
    await expect(reg.guard("A", fail)).rejects.toThrow("boom");
    expect(reg.states().A).toBe("open");

    // Still within cooldown: short-circuits.
    clock += 500;
    await expect(reg.guard("A", ok)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(reg.states().A).toBe("open");

    // Cooldown elapsed: state lazily promotes to half-open.
    clock += 600; // total 1100 >= 1000
    expect(reg.states().A).toBe("half-open");

    // A successful trial hop through guard closes it.
    await expect(reg.guard("A", ok)).resolves.toBe("ok");
    expect(reg.states().A).toBe("closed");
  });

  it("a failing half-open trial re-opens the breaker", async () => {
    let clock = 0;
    const reg = new BreakerRegistry({
      failureThreshold: 1,
      cooldownMs: 1000,
      now: () => clock,
    });

    await expect(reg.guard("A", fail)).rejects.toThrow("boom");
    expect(reg.states().A).toBe("open");

    clock += 1000;
    expect(reg.states().A).toBe("half-open");

    // Failed trial → back to open.
    await expect(reg.guard("A", fail)).rejects.toThrow("boom");
    expect(reg.states().A).toBe("open");
  });

  it("states()/openCount()/openIds() are mutually consistent (open only, not half-open)", async () => {
    let clock = 0;
    const reg = new BreakerRegistry({
      failureThreshold: 1,
      cooldownMs: 1000,
      now: () => clock,
    });

    // Open A and B; keep C healthy.
    await expect(reg.guard("A", fail)).rejects.toThrow("boom");
    await expect(reg.guard("B", fail)).rejects.toThrow("boom");
    await expect(reg.guard("C", ok)).resolves.toBe("ok");

    expect(reg.states()).toEqual({ A: "open", B: "open", C: "closed" });
    expect(reg.openCount()).toBe(2);
    expect(reg.openIds().sort()).toEqual(["A", "B"]);

    // Advance so A/B become half-open: they must drop out of openCount/openIds.
    clock += 1000;
    expect(reg.states()).toEqual({ A: "half-open", B: "half-open", C: "closed" });
    expect(reg.openCount()).toBe(0);
    expect(reg.openIds()).toEqual([]);
  });

  it("onStateChange fires tagged with the subtree id", async () => {
    let clock = 0;
    const events: Array<[string, string, string]> = [];
    const reg = new BreakerRegistry({
      failureThreshold: 1,
      now: () => clock,
      onStateChange: (id, from, to) => events.push([id, from, to]),
    });

    await expect(reg.guard("A", fail)).rejects.toThrow("boom");
    expect(events).toContainEqual(["A", "closed", "open"]);
  });
});
