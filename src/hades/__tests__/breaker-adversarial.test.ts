import { describe, it, expect } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  TimeoutError,
  withTimeout,
} from "../hierarchy/circuit-breaker";
import type { BreakerState } from "../hierarchy/circuit-breaker";

/**
 * ADVERSARIAL contract tests for the circuit breaker + timeout + registry.
 *
 * Everything time-related is INJECTED and FAKE — no real timers, no Date.now,
 * no setTimeout. A fake clock (`t`, `now()`) drives the lazy OPEN→HALF-OPEN
 * transition, and a manual timer queue drives `withTimeout`. The headline
 * property under attack: a persistently failing subtree must NOT be retried
 * forever — once the breaker opens, the underlying fn is short-circuited.
 *
 * The registry (`breaker-registry.ts`) is a sibling module built in parallel.
 * It is imported DYNAMICALLY inside the registry-only tests so that, if it is
 * not yet present, only those tests fail — the breaker/timeout signal stays
 * clean.
 */

// ---------------------------------------------------------------------------
// Fake clock + fake timer queue.
// ---------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  cb: () => void;
  due: number;
  cleared: boolean;
}

function makeFakeEnv() {
  let t = 0;
  let nextId = 1;
  let setCalls = 0;
  let clearCalls = 0;
  const timers: FakeTimer[] = [];

  const now = () => t;

  const setTimeoutFn = (cb: () => void, ms: number): number => {
    setCalls += 1;
    const timer: FakeTimer = { id: nextId++, cb, due: t + ms, cleared: false };
    timers.push(timer);
    return timer.id;
  };

  const clearTimeoutFn = (id: number): void => {
    clearCalls += 1;
    const timer = timers.find((x) => x.id === id);
    if (timer) timer.cleared = true;
  };

  /** Advance the clock, firing every non-cleared timer whose due time has arrived. */
  const advance = (ms: number): void => {
    t += ms;
    // Fire in due order; a fired callback may schedule/clear more timers.
    for (;;) {
      const ready = timers
        .filter((x) => !x.cleared && x.due <= t)
        .sort((a, b) => a.due - b.due);
      if (ready.length === 0) break;
      const timer = ready[0];
      timer.cleared = true;
      timer.cb();
    }
  };

  return {
    now,
    setTimeoutFn,
    clearTimeoutFn,
    advance,
    at: () => t,
    setAt: (v: number) => {
      t = v;
    },
    pendingCount: () => timers.filter((x) => !x.cleared).length,
    setCalls: () => setCalls,
    clearCalls: () => clearCalls,
  };
}

// A promise that never settles — the canonical "hang".
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {});
}

// ===========================================================================
// 1. OPENS AT EXACTLY THRESHOLD
// ===========================================================================

describe("1. opens at exactly the threshold, not sooner/later", () => {
  it("failureThreshold=3: closed after 2 failures, open on the 3rd", () => {
    const env = makeFakeEnv();
    const b = new CircuitBreaker({ failureThreshold: 3, now: env.now });

    expect(b.state()).toBe("closed");

    b.onFailure();
    expect(b.state()).toBe("closed");
    expect(b.canPass()).toBe(true);
    expect(b.failures()).toBe(1);

    b.onFailure();
    // After 2 of 3 — still closed and passing. Not sooner.
    expect(b.state()).toBe("closed");
    expect(b.canPass()).toBe(true);
    expect(b.failures()).toBe(2);

    b.onFailure();
    // The 3rd consecutive failure flips it.
    expect(b.state()).toBe("open");
    expect(b.canPass()).toBe(false);
  });
});

// ===========================================================================
// 2. SHORT-CIRCUIT DOES NOT CALL fn (core guarantee)
// ===========================================================================

describe("2. an open breaker short-circuits WITHOUT invoking fn", () => {
  it("exec on an open breaker rejects CircuitOpenError and never runs fn", async () => {
    const env = makeFakeEnv();
    const b = new CircuitBreaker({ failureThreshold: 2, now: env.now });

    // Trip it open.
    b.onFailure();
    b.onFailure();
    expect(b.state()).toBe("open");

    let calls = 0;
    const fn = async () => {
      calls += 1;
      return 42;
    };

    await expect(b.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    // THE property: fn was not invoked.
    expect(calls).toBe(0);

    // Repeated attempts still never touch fn.
    await expect(b.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(b.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(0);
  });
});

// ===========================================================================
// 3. BOUNDED RETRIES ON A DEAD SUBTREE (registry) — THE HEADLINE
// ===========================================================================

describe("3. registry.guard bounds retries on a persistently dead subtree", () => {
  it("50 guard calls with failureThreshold=5 invoke fn AT MOST 5 times; all 50 reject", async () => {
    const { BreakerRegistry } = await import("../hierarchy/breaker-registry");
    const env = makeFakeEnv();
    const reg = new BreakerRegistry({ failureThreshold: 5, now: env.now });

    let calls = 0;
    const alwaysRejects = async () => {
      calls += 1;
      throw new Error("dead subtree");
    };

    let rejections = 0;
    for (let i = 0; i < 50; i++) {
      try {
        await reg.guard("dead", alwaysRejects);
        // A success here would itself be a contract violation.
        throw new Error("guard unexpectedly resolved");
      } catch (err) {
        rejections += 1;
        // Later rejections must be CircuitOpenError (short-circuit), not the
        // underlying error — proving fn was not called.
      }
    }

    expect(rejections).toBe(50);
    // Once the breaker opens (after 5 consecutive failures) the remaining 45
    // calls MUST short-circuit. If fn ran > 5 times, retries are unbounded.
    expect(calls).toBeLessThanOrEqual(5);
    // And it really did open.
    expect(reg.states()["dead"]).toBe("open");
    expect(reg.openCount()).toBe(1);
    expect(reg.openIds()).toContain("dead");
  });
});

// ===========================================================================
// 4. COOLDOWN + HALF-OPEN RECOVERY
// ===========================================================================

describe("4. cooldown then half-open recovery", () => {
  it("stays open before cooldown; becomes half-open at/after cooldown; a trial success closes it", async () => {
    const env = makeFakeEnv();
    const b = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
      successesToClose: 1,
      now: env.now,
    });

    b.onFailure();
    b.onFailure();
    expect(b.state()).toBe("open");

    // Advance < cooldown → still open, cannot pass.
    env.setAt(999);
    expect(b.state()).toBe("open");
    expect(b.canPass()).toBe(false);

    // Advance to == cooldown → lazily half-open, can pass a trial.
    env.setAt(1000);
    expect(b.state()).toBe("half-open");
    expect(b.canPass()).toBe(true);

    // A trial SUCCESS via exec closes it and fn actually runs.
    let calls = 0;
    const ok = async () => {
      calls += 1;
      return "ok";
    };
    await expect(b.exec(ok)).resolves.toBe("ok");
    expect(calls).toBe(1);
    expect(b.state()).toBe("closed");

    // Closed again → fn runs on subsequent exec.
    await expect(b.exec(ok)).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("a half-open trial FAILURE re-opens immediately and resets the cooldown window", async () => {
    const env = makeFakeEnv();
    const b = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
      now: env.now,
    });

    b.onFailure();
    b.onFailure();
    expect(b.state()).toBe("open");

    env.setAt(1000);
    expect(b.state()).toBe("half-open");

    // A single trial failure re-opens immediately — NOT after threshold again.
    let calls = 0;
    const bad = async () => {
      calls += 1;
      throw new Error("still dead");
    };
    await expect(b.exec(bad)).rejects.toThrow("still dead");
    expect(calls).toBe(1);
    expect(b.state()).toBe("open");

    // Cooldown window was reset to now(=1000). At 1999 still open; at 2000 half-open.
    env.setAt(1999);
    expect(b.state()).toBe("open");
    env.setAt(2000);
    expect(b.state()).toBe("half-open");
  });
});

// ===========================================================================
// 5. onSuccess RESETS THE CONSECUTIVE RUN
// ===========================================================================

describe("5. a success resets the consecutive-failure run", () => {
  it("failureThreshold=3: fail,fail,succeed,fail,fail stays closed; the next failure opens", () => {
    const env = makeFakeEnv();
    const b = new CircuitBreaker({ failureThreshold: 3, now: env.now });

    b.onFailure();
    b.onFailure();
    expect(b.failures()).toBe(2);
    expect(b.state()).toBe("closed");

    // Success clears the run.
    b.onSuccess();
    expect(b.failures()).toBe(0);
    expect(b.state()).toBe("closed");

    b.onFailure();
    b.onFailure();
    // Two more — still under threshold because the run was reset.
    expect(b.failures()).toBe(2);
    expect(b.state()).toBe("closed");
    expect(b.canPass()).toBe(true);

    // The 3rd CONSECUTIVE failure opens it.
    b.onFailure();
    expect(b.state()).toBe("open");
  });
});

// ===========================================================================
// 6. withTimeout TEETH
// ===========================================================================

describe("6. withTimeout with injected fake timers", () => {
  it("a never-settling fn is pending until the timer fires, then rejects TimeoutError", async () => {
    const env = makeFakeEnv();
    const p = withTimeout(neverSettles, 100, {
      setTimeoutFn: env.setTimeoutFn,
      clearTimeoutFn: env.clearTimeoutFn,
    });

    // Before firing the timer it must be pending.
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(env.pendingCount()).toBe(1);

    // Fire the 100ms timer.
    env.advance(100);
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
  });

  it("a fast-resolving fn resolves with its value; later firing timers is a no-op (late settlement ignored)", async () => {
    const env = makeFakeEnv();
    const fast = async () => "fast-value";
    const p = withTimeout(fast, 100, {
      setTimeoutFn: env.setTimeoutFn,
      clearTimeoutFn: env.clearTimeoutFn,
    });

    await expect(p).resolves.toBe("fast-value");
    // Timer should have been cleared on resolution.
    expect(env.clearCalls()).toBe(1);
    expect(env.pendingCount()).toBe(0);

    // Firing anything now must not flip the already-resolved promise.
    env.advance(1000);
    await expect(p).resolves.toBe("fast-value");
  });

  it("ms <= 0 runs fn directly and schedules NO timer", async () => {
    const env = makeFakeEnv();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return 7;
    };

    await expect(
      withTimeout(fn, 0, {
        setTimeoutFn: env.setTimeoutFn,
        clearTimeoutFn: env.clearTimeoutFn,
      }),
    ).resolves.toBe(7);
    expect(calls).toBe(1);
    // The fake setTimeoutFn must NOT have been called.
    expect(env.setCalls()).toBe(0);

    // Negative also.
    await expect(
      withTimeout(fn, -5, {
        setTimeoutFn: env.setTimeoutFn,
        clearTimeoutFn: env.clearTimeoutFn,
      }),
    ).resolves.toBe(7);
    expect(env.setCalls()).toBe(0);
  });
});

// ===========================================================================
// 7. TIMEOUT COUNTS AS A FAILURE (registry)
// ===========================================================================

describe("7. registry: a timeout counts as a breaker failure and eventually opens", () => {
  it("repeated hanging guards with {timeoutMs} open the breaker; then it short-circuits without calling fn", async () => {
    const { BreakerRegistry } = await import("../hierarchy/breaker-registry");
    const env = makeFakeEnv();
    const reg = new BreakerRegistry({
      failureThreshold: 3,
      cooldownMs: 100000, // large so it stays open for the short-circuit check
      now: env.now,
      setTimeoutFn: env.setTimeoutFn,
      clearTimeoutFn: env.clearTimeoutFn,
    });

    let calls = 0;
    const hangs = () => {
      calls += 1;
      return neverSettles();
    };

    // Drive `failureThreshold` timeouts. Each round: start the guard, fire the
    // 50ms timeout, await the resulting TimeoutError rejection.
    for (let round = 0; round < 3; round++) {
      const g = reg.guard("hang", hangs, { timeoutMs: 50 });
      env.advance(50);
      await expect(g).rejects.toBeInstanceOf(TimeoutError);
    }
    expect(calls).toBe(3);
    expect(reg.states()["hang"]).toBe("open");

    // Now open: a further guard must short-circuit with CircuitOpenError and
    // NOT invoke fn (calls stays at 3), and schedule no new timer.
    const setBefore = env.setCalls();
    await expect(
      reg.guard("hang", hangs, { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(3);
    expect(env.setCalls()).toBe(setBefore);
  });
});

// ===========================================================================
// 8. PER-ID ISOLATION
// ===========================================================================

describe("8. per-id isolation in the registry", () => {
  it("hammering 'bad' open leaves 'good' closed; states/openIds/openCount reflect only 'bad'", async () => {
    const { BreakerRegistry } = await import("../hierarchy/breaker-registry");
    const env = makeFakeEnv();
    const reg = new BreakerRegistry({ failureThreshold: 3, now: env.now });

    const bad = async () => {
      throw new Error("bad");
    };
    const good = async () => "good";

    // Open 'bad'.
    for (let i = 0; i < 5; i++) {
      await expect(reg.guard("bad", bad)).rejects.toThrow();
    }
    // 'good' succeeds and stays closed.
    await expect(reg.guard("good", good)).resolves.toBe("good");
    await expect(reg.guard("good", good)).resolves.toBe("good");

    const states = reg.states();
    expect(states["bad"]).toBe("open");
    expect(states["good"]).toBe("closed");

    expect(reg.openCount()).toBe(1);
    expect(reg.openIds()).toContain("bad");
    expect(reg.openIds()).not.toContain("good");

    // 'good' still runs its fn (not affected by 'bad' being open).
    let goodCalls = 0;
    await reg.guard("good", async () => {
      goodCalls += 1;
      return "ok";
    });
    expect(goodCalls).toBe(1);

    // Per-id breaker objects are distinct and stable per id.
    const b1 = reg.get("bad");
    const b2 = reg.get("bad");
    expect(b1).toBe(b2);
    expect(reg.get("good")).not.toBe(b1);
  });
});

// A tiny type-level assertion that BreakerState is what we think (compile-time).
const _st: BreakerState = "half-open";
void _st;
