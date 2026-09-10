import { describe, expect, it, vi } from "vitest";

import {
  ALL_LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  LifecycleMachine,
  TransitionError,
  WakeExhaustedError,
  canTransition,
  type LifecycleEvent,
  type LifecycleState,
} from "../lifecycle";

// ===========================================================================
// Exhaustive transition-table matrix
// ===========================================================================

describe("LIFECYCLE_TRANSITIONS / canTransition — exhaustive matrix", () => {
  it("covers every documented state", () => {
    expect(new Set(ALL_LIFECYCLE_STATES)).toEqual(
      new Set<LifecycleState>(["provisioning", "running", "hibernating", "hibernated", "waking", "failed", "stopped"]),
    );
  });

  const expected: Record<LifecycleState, LifecycleState[]> = {
    provisioning: ["running", "failed"],
    running: ["hibernating", "stopped", "failed"],
    hibernating: ["hibernated", "failed"],
    hibernated: ["waking", "stopped", "failed"],
    waking: ["running", "failed"],
    failed: ["provisioning"],
    stopped: [],
  };

  it("LIFECYCLE_TRANSITIONS matches the documented table exactly, per state", () => {
    for (const state of ALL_LIFECYCLE_STATES) {
      expect(new Set(LIFECYCLE_TRANSITIONS[state])).toEqual(new Set(expected[state]));
    }
  });

  it("canTransition matches the documented table cell-by-cell for the full state x state matrix", () => {
    let checked = 0;
    for (const from of ALL_LIFECYCLE_STATES) {
      for (const to of ALL_LIFECYCLE_STATES) {
        const want = expected[from].includes(to);
        expect(canTransition(from, to)).toBe(want);
        checked += 1;
      }
    }
    // 7 x 7 = 49 cells, every one asserted — no sampling.
    expect(checked).toBe(ALL_LIFECYCLE_STATES.length * ALL_LIFECYCLE_STATES.length);
  });

  it("no state (except failed->provisioning) declares a self-loop in the raw table", () => {
    for (const state of ALL_LIFECYCLE_STATES) {
      expect(LIFECYCLE_TRANSITIONS[state]).not.toContain(state);
    }
  });

  it("stopped is fully terminal: zero outgoing edges", () => {
    expect(LIFECYCLE_TRANSITIONS.stopped).toEqual([]);
  });

  it("failed's only edge is the explicit re-provision escape hatch", () => {
    expect(LIFECYCLE_TRANSITIONS.failed).toEqual(["provisioning"]);
  });

  it("tables are frozen (defensive against accidental mutation)", () => {
    expect(Object.isFrozen(LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(LIFECYCLE_TRANSITIONS.running)).toBe(true);
  });
});

// ===========================================================================
// track / transition / history / untrack
// ===========================================================================

describe("LifecycleMachine — basic tracking and legal/illegal transitions", () => {
  it("track() seeds state with no history event", () => {
    const m = new LifecycleMachine({ now: () => 1000 });
    m.track("w1", "provisioning");
    expect(m.state("w1")).toBe("provisioning");
    expect(m.history("w1")).toEqual([]);
  });

  it("state() is undefined for an unknown worker", () => {
    const m = new LifecycleMachine();
    expect(m.state("ghost")).toBeUndefined();
  });

  it("legal transition updates state and records an event with from/to/at", () => {
    let t = 500;
    const m = new LifecycleMachine({ now: () => t });
    m.track("w1", "provisioning");
    t = 600;
    m.transition("w1", "running", "provisioned ok");
    expect(m.state("w1")).toBe("running");
    const hist = m.history("w1");
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ workerId: "w1", from: "provisioning", to: "running", at: 600, reason: "provisioned ok" });
  });

  it("illegal transition throws TransitionError and does not mutate state or history", () => {
    const m = new LifecycleMachine();
    m.track("w1", "provisioning");
    expect(() => m.transition("w1", "hibernated")).toThrow(TransitionError);
    expect(m.state("w1")).toBe("provisioning");
    expect(m.history("w1")).toEqual([]);
  });

  it("TransitionError exposes workerId/from/to", () => {
    const m = new LifecycleMachine();
    m.track("w1", "stopped");
    try {
      m.transition("w1", "running");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
      const te = err as TransitionError;
      expect(te.workerId).toBe("w1");
      expect(te.from).toBe("stopped");
      expect(te.to).toBe("running");
    }
  });

  it("transition() on an untracked worker throws", () => {
    const m = new LifecycleMachine();
    expect(() => m.transition("nope", "running")).toThrow(TransitionError);
  });

  it("failed -> provisioning is the explicit re-provision escape hatch and works", () => {
    const m = new LifecycleMachine();
    m.track("w1", "failed");
    m.transition("w1", "provisioning", "explicit re-provision");
    expect(m.state("w1")).toBe("provisioning");
  });

  it("failed has no other legal edge", () => {
    const m = new LifecycleMachine();
    for (const to of ALL_LIFECYCLE_STATES) {
      if (to === "provisioning") continue;
      m.track("w1", "failed");
      expect(() => m.transition("w1", to)).toThrow(TransitionError);
    }
  });

  it("stopped is terminal: no transition succeeds from it", () => {
    const m = new LifecycleMachine();
    for (const to of ALL_LIFECYCLE_STATES) {
      m.track("w1", "stopped");
      expect(() => m.transition("w1", to)).toThrow(TransitionError);
    }
  });

  it("untrack() clears state and history; worker becomes unknown again", () => {
    const m = new LifecycleMachine();
    m.track("w1", "running");
    m.transition("w1", "hibernating");
    m.untrack("w1");
    expect(m.state("w1")).toBeUndefined();
    expect(m.history("w1")).toEqual([]);
    expect(() => m.transition("w1", "running")).toThrow(TransitionError);
  });

  it("history() respects limit, returning the most recent N events", () => {
    const m = new LifecycleMachine();
    m.track("w1", "provisioning");
    m.transition("w1", "running");
    m.transition("w1", "hibernating");
    m.transition("w1", "hibernated");
    const full = m.history("w1");
    expect(full).toHaveLength(3);
    const last2 = m.history("w1", 2);
    expect(last2).toHaveLength(2);
    expect(last2).toEqual(full.slice(1));
    expect(m.history("w1", 0)).toEqual([]);
    expect(m.history("w1", 100)).toEqual(full);
  });

  it("onEvent fires for every recorded transition", () => {
    const events: LifecycleEvent[] = [];
    const m = new LifecycleMachine({ onEvent: (e) => events.push(e) });
    m.track("w1", "provisioning");
    m.transition("w1", "running");
    m.transition("w1", "hibernating");
    expect(events.map((e) => `${e.from}->${e.to}`)).toEqual(["provisioning->running", "running->hibernating"]);
  });

  it("re-tracking an already-tracked worker resets state and history", () => {
    const m = new LifecycleMachine();
    m.track("w1", "provisioning");
    m.transition("w1", "running");
    m.track("w1", "hibernated");
    expect(m.state("w1")).toBe("hibernated");
    expect(m.history("w1")).toEqual([]);
  });
});

// ===========================================================================
// Idempotency: hibernate-when-hibernated / wake-when-running
// ===========================================================================

describe("LifecycleMachine — documented idempotent self-transitions", () => {
  it("hibernated -> hibernated via transition() is a no-op-with-event, not an error", () => {
    const m = new LifecycleMachine({ now: () => 42 });
    m.track("w1", "hibernated");
    expect(() => m.transition("w1", "hibernated")).not.toThrow();
    expect(m.state("w1")).toBe("hibernated");
    const hist = m.history("w1");
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ from: "hibernated", to: "hibernated", at: 42 });
  });

  it("running -> running via transition() is a no-op-with-event, not an error", () => {
    const m = new LifecycleMachine();
    m.track("w1", "running");
    expect(() => m.transition("w1", "running")).not.toThrow();
    expect(m.state("w1")).toBe("running");
    expect(m.history("w1")).toHaveLength(1);
  });

  it("other same-state 'transitions' are NOT idempotent and still throw", () => {
    const m = new LifecycleMachine();
    for (const s of ["provisioning", "hibernating", "waking", "failed", "stopped"] as LifecycleState[]) {
      m.track("w1", s);
      expect(() => m.transition("w1", s)).toThrow(TransitionError);
    }
  });

  it("runHibernate on an already-hibernated worker is a no-op: op() is not invoked", async () => {
    const m = new LifecycleMachine();
    m.track("w1", "hibernated");
    const op = vi.fn(async () => {});
    await m.runHibernate("w1", op);
    expect(op).not.toHaveBeenCalled();
    expect(m.state("w1")).toBe("hibernated");
  });

  it("runWake on an already-running worker is a no-op: op() is not invoked", async () => {
    const m = new LifecycleMachine();
    m.track("w1", "running");
    const op = vi.fn(async () => {});
    await m.runWake("w1", op);
    expect(op).not.toHaveBeenCalled();
    expect(m.state("w1")).toBe("running");
  });
});

// ===========================================================================
// runHibernate
// ===========================================================================

describe("LifecycleMachine.runHibernate", () => {
  it("running -> hibernating -> hibernated on success, invoking op exactly once", async () => {
    const events: LifecycleEvent[] = [];
    const m = new LifecycleMachine({ onEvent: (e) => events.push(e) });
    m.track("w1", "running");
    const op = vi.fn(async () => {});
    await m.runHibernate("w1", op);
    expect(op).toHaveBeenCalledTimes(1);
    expect(m.state("w1")).toBe("hibernated");
    expect(events.map((e) => `${e.from}->${e.to}`)).toEqual(["running->hibernating", "hibernating->hibernated"]);
  });

  it("op throwing moves the worker to failed and rethrows the original error", async () => {
    const m = new LifecycleMachine();
    m.track("w1", "running");
    const boom = new Error("backend refused to suspend");
    await expect(m.runHibernate("w1", async () => { throw boom; })).rejects.toBe(boom);
    expect(m.state("w1")).toBe("failed");
    const hist = m.history("w1");
    expect(hist.map((e) => `${e.from}->${e.to}`)).toEqual(["running->hibernating", "hibernating->failed"]);
  });

  it("runHibernate from a non-running, non-hibernated state throws TransitionError without calling op", async () => {
    const m = new LifecycleMachine();
    m.track("w1", "provisioning");
    const op = vi.fn(async () => {});
    await expect(m.runHibernate("w1", op)).rejects.toThrow(TransitionError);
    expect(op).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// runWake — retry / backoff / exhaustion / concurrency guard
// ===========================================================================

describe("LifecycleMachine.runWake — retry, backoff, exhaustion", () => {
  it("succeeds on the first attempt with no sleep calls", async () => {
    const sleep = vi.fn(async () => {});
    const m = new LifecycleMachine({ sleep });
    m.track("w1", "hibernated");
    const op = vi.fn(async () => {});
    await m.runWake("w1", op);
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(m.state("w1")).toBe("running");
  });

  it("succeeds on attempt 2: exact backoff sequence, final state running, attempt-tagged events", async () => {
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    const events: LifecycleEvent[] = [];
    const m = new LifecycleMachine({ sleep, wakeBackoffMs: 500, onEvent: (e) => events.push(e) });
    m.track("w1", "hibernated");

    let calls = 0;
    const op = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("cold start timeout");
    });

    await m.runWake("w1", op);

    expect(op).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([500]);
    expect(m.state("w1")).toBe("running");

    const attemptEvents = events.filter((e) => e.attempt !== undefined);
    expect(attemptEvents.map((e) => e.attempt)).toEqual([1, 2]);
    // attempt 1 failed (waking->waking), attempt 2 succeeded (waking->running)
    expect(attemptEvents[0]).toMatchObject({ from: "waking", to: "waking", attempt: 1 });
    expect(attemptEvents[0].reason).toMatch(/cold start timeout/);
    expect(attemptEvents[1]).toMatchObject({ from: "waking", to: "running", attempt: 2 });
  });

  it("full exponential backoff sequence 500, 1000, 2000... across many attempts", async () => {
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    const m = new LifecycleMachine({ sleep, wakeBackoffMs: 500, wakeMaxAttempts: 5 });
    m.track("w1", "hibernated");

    let calls = 0;
    const op = vi.fn(async () => {
      calls += 1;
      if (calls < 5) throw new Error(`fail ${calls}`);
    });

    await m.runWake("w1", op);
    expect(op).toHaveBeenCalledTimes(5);
    expect(sleepCalls).toEqual([500, 1000, 2000, 4000]);
    expect(m.state("w1")).toBe("running");
  });

  it("exhaustion: state ends failed, thrown WakeExhaustedError carries every attempt's cause", async () => {
    const sleep = vi.fn(async () => {});
    const m = new LifecycleMachine({ sleep, wakeMaxAttempts: 3, wakeBackoffMs: 500 });
    m.track("w1", "hibernated");

    const errors = [new Error("e1"), new Error("e2"), new Error("e3")];
    let calls = 0;
    const op = vi.fn(async () => {
      const err = errors[calls];
      calls += 1;
      throw err;
    });

    let caught: unknown;
    try {
      await m.runWake("w1", op);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WakeExhaustedError);
    const wex = caught as WakeExhaustedError;
    expect(wex.workerId).toBe("w1");
    expect(wex.attempts).toBe(3);
    expect(wex.errors).toEqual(errors);
    expect(wex.message).toMatch(/e1/);
    expect(wex.message).toMatch(/e2/);
    expect(wex.message).toMatch(/e3/);

    expect(op).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // backoff only BETWEEN attempts, none after the last
    expect(m.state("w1")).toBe("failed");
  });

  it("default wakeMaxAttempts is 3 and default wakeBackoffMs is 500", async () => {
    const sleepCalls: number[] = [];
    const m = new LifecycleMachine({ sleep: async (ms) => { sleepCalls.push(ms); } });
    m.track("w1", "hibernated");
    const op = vi.fn(async () => { throw new Error("always fails"); });
    await expect(m.runWake("w1", op)).rejects.toBeInstanceOf(WakeExhaustedError);
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([500, 1000]);
  });

  it("runWake from a non-hibernated, non-running state throws TransitionError without calling op", async () => {
    const m = new LifecycleMachine();
    m.track("w1", "provisioning");
    const op = vi.fn(async () => {});
    await expect(m.runWake("w1", op)).rejects.toThrow(TransitionError);
    expect(op).not.toHaveBeenCalled();
  });

  it("concurrent runWake on the same worker while waking is rejected deterministically", async () => {
    const m = new LifecycleMachine({ sleep: async () => {} });
    m.track("w1", "hibernated");

    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const firstOp = vi.fn(async () => {
      await firstGate;
    });
    const secondOp = vi.fn(async () => {});

    const firstPromise = m.runWake("w1", firstOp);
    // By the time we get here, the first call has synchronously transitioned
    // the worker to "waking" and is now suspended awaiting `firstGate`.
    expect(m.state("w1")).toBe("waking");

    await expect(m.runWake("w1", secondOp)).rejects.toThrow(TransitionError);
    expect(secondOp).not.toHaveBeenCalled();

    resolveFirst();
    await firstPromise;
    expect(m.state("w1")).toBe("running");
    expect(firstOp).toHaveBeenCalledTimes(1);
  });

  it("after a completed runWake, a fresh runWake call is allowed again (guard releases)", async () => {
    const m = new LifecycleMachine({ sleep: async () => {} });
    m.track("w1", "hibernated");
    await m.runWake("w1", async () => {});
    expect(m.state("w1")).toBe("running");
    // running -> running is the idempotent no-op path, not a new wake cycle.
    const op = vi.fn(async () => {});
    await m.runWake("w1", op);
    expect(op).not.toHaveBeenCalled();
  });

  it("rejects wakeMaxAttempts < 1 and negative wakeBackoffMs at construction", () => {
    expect(() => new LifecycleMachine({ wakeMaxAttempts: 0 })).toThrow(RangeError);
    expect(() => new LifecycleMachine({ wakeBackoffMs: -1 })).toThrow(RangeError);
  });
});
