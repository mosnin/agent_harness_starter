import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { BackendManager } from "../manager";
import { FakeBackend } from "../fake-backend";
import type { BackendDescriptor } from "../descriptor";
import { CostAwareRouteBandit } from "../route-bandit";
import { SwarmOutcomeFeed, type OutcomeFeedEvent, type SwarmManagerLike } from "../outcome-feed";
import type { BanditSnapshotStore } from "../bandit-provisioner";
import type { RouteBanditState } from "../route-bandit";
import type { WorkerTask, VerificationReport } from "../../../swarm-runtime/types";
import type { SwarmManager } from "../../../swarm-runtime/manager/manager";

// ===========================================================================
// Fixtures
// ===========================================================================

function descriptor(name: string, overrides: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    name,
    kind: "fake",
    capabilities: ["shell"],
    cost: { perRunningHourUsd: 1, perHibernatedHourUsd: 0.1, perProvisionUsd: 0.05, source: "configured" },
    supportsHibernate: true,
    locality: "remote",
    ...overrides,
  };
}

function registerFake(mgr: BackendManager, name: string): void {
  mgr.register(new FakeBackend({ name }), descriptor(name));
}

let taskCounter = 0;
function task(overrides: Partial<WorkerTask> = {}): WorkerTask {
  taskCounter += 1;
  return {
    id: overrides.id ?? `task-${taskCounter}`,
    goalId: "goal-1",
    description: "do the thing",
    requiredCapabilities: [],
    input: {},
    dependsOn: [],
    priority: 0,
    status: "dispatched",
    attempts: 0,
    maxAttempts: 3,
    createdAt: 0,
    ...overrides,
  };
}

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    taskId: "task-x",
    workerId: "worker-1",
    verdict: "accept",
    score: 0.9,
    checks: [],
    feedback: "",
    at: 0,
    ...overrides,
  };
}

/** Minimal EventEmitter stand-in matching SwarmManagerLike, plus a spy on
 *  whether `.off` was actually invoked (to assert detach uses it when
 *  present). */
function fakeSwarmManager(): SwarmManagerLike & EventEmitter & { offCalls: number } {
  const emitter = new EventEmitter() as EventEmitter & { offCalls: number };
  emitter.offCalls = 0;
  const originalOff = emitter.off.bind(emitter);
  emitter.off = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.offCalls += 1;
    return originalOff(event, listener);
  }) as typeof emitter.off;
  return emitter;
}

function memoryStore(opts: { failSave?: boolean } = {}): BanditSnapshotStore & { saved: RouteBanditState[] } {
  const saved: RouteBanditState[] = [];
  return {
    saved,
    async load() {
      return saved.length > 0 ? saved[saved.length - 1] : undefined;
    },
    async save(state: RouteBanditState) {
      if (opts.failSave) throw new Error("disk full");
      saved.push(state);
    },
  };
}

function collector<T>(): { events: T[]; push: (e: T) => void } {
  const events: T[] = [];
  return { events, push: (e: T) => events.push(e) };
}

/** Flush pending microtasks so the feed's (deliberately async, for
 *  persistence) terminal-event handling has settled before assertions. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ===========================================================================
// Construction
// ===========================================================================

describe("SwarmOutcomeFeed — construction", () => {
  it("throws RangeError when opts.bandit is not a CostAwareRouteBandit", () => {
    const mgr = new BackendManager();
    expect(
      () =>
        new SwarmOutcomeFeed({
          manager: mgr,
          bandit: {} as CostAwareRouteBandit,
          resolveBackend: () => "a",
        })
    ).toThrow(RangeError);
  });

  it("throws RangeError when opts.resolveBackend is not a function", () => {
    const mgr = new BackendManager();
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    expect(
      () =>
        new SwarmOutcomeFeed({
          manager: mgr,
          bandit,
          resolveBackend: undefined as unknown as (t: WorkerTask) => string | undefined,
        })
    ).toThrow(RangeError);
  });
});

// ===========================================================================
// Structural compatibility with the REAL SwarmManager
// ===========================================================================

describe("SwarmOutcomeFeed — structural compatibility", () => {
  it("a real SwarmManager satisfies SwarmManagerLike (compile-time check)", () => {
    // Never constructed (SwarmManager needs a full ManagerConfig with a
    // provider/bus/etc. — irrelevant to this check). This function's only
    // purpose is to make the assignment below fail `tsc` if SwarmManager
    // ever stops structurally satisfying SwarmManagerLike.
    function assertCompatible(sm: SwarmManager): SwarmManagerLike {
      return sm;
    }
    expect(typeof assertCompatible).toBe("function");
  });
});

// ===========================================================================
// Event shape / basic recording
// ===========================================================================

describe("SwarmOutcomeFeed — recording a verified outcome", () => {
  it("records a verified:true outcome from task:dispatched -> task:verified with measured elapsedMs and usd", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "worker-backend");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    let t = 1000;
    const now = () => t;
    const events = collector<OutcomeFeedEvent>();
    const feed = new SwarmOutcomeFeed({
      bandit,
      manager: mgr,
      resolveBackend: () => "worker-backend",
      now,
      onEvent: events.push,
    });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    t += 250; // measured elapsed
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" }));
    await tick();

    const arm = bandit.arm("worker-backend");
    expect(arm.pulls).toBe(1);
    expect(arm.verified).toBe(1);
    expect(arm.totalElapsedMs).toBe(250);
    // No manager telemetry accrued between dispatch and terminal (no
    // provision call happened here) -> measured delta is 0, not fabricated.
    expect(arm.totalUsd).toBe(0);

    const recorded = events.events.filter((e) => e.type === "recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ taskId: "t1", backend: "worker-backend" });
    expect(recorded[0].detail).toMatchObject({ verified: true, elapsedMs: 250, usd: 0 });
  });

  it("records verified:false for task:verified whose report.verdict is not accept", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "b" });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "revise" }));
    await tick();

    expect(bandit.arm("b")).toMatchObject({ pulls: 1, verified: 0 });
  });

  it("records verified:false for task:rejected", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "b" });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    sm.emit("task:rejected", tk, report({ taskId: "t1", verdict: "reject" }));
    await tick();

    expect(bandit.arm("b")).toMatchObject({ pulls: 1, verified: 0 });
  });

  it("records verified:false for task:failed, whose emit signature has no report argument", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "b" });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    // Real manager.ts emits `("task:failed", task, feedback: string)` — a
    // string second arg, not a VerificationReport. Must not throw / must not
    // be treated as an accept.
    sm.emit("task:failed", tk, "exhausted attempts");
    await tick();

    expect(bandit.arm("b")).toMatchObject({ pulls: 1, verified: 0 });
  });
});

// ===========================================================================
// Missing-dispatch honesty
// ===========================================================================

describe("SwarmOutcomeFeed — no guessed measurements", () => {
  it("a terminal event with no recorded dispatch records elapsedMs 0 and usd 0, with an explanatory note", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const events = collector<OutcomeFeedEvent>();
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "b", onEvent: events.push });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    // No "task:dispatched" fired first — the feed attached mid-flight.
    const tk = task({ id: "orphan" });
    sm.emit("task:verified", tk, report({ taskId: "orphan", verdict: "accept" }));
    await tick();

    expect(bandit.arm("b")).toMatchObject({ pulls: 1, verified: 1, totalElapsedMs: 0, totalUsd: 0 });
    const recorded = events.events.find((e) => e.type === "recorded");
    expect(recorded?.detail?.elapsedMsNote).toMatch(/no "task:dispatched" event recorded/);
  });

  it("resolveBackend returning undefined emits skipped and records nothing", async () => {
    const mgr = new BackendManager();
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const events = collector<OutcomeFeedEvent>();
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => undefined, onEvent: events.push });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" }));
    await tick();

    expect(bandit.arms()).toEqual({});
    const skipped = events.events.filter((e) => e.type === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].taskId).toBe("t1");
  });

  it("resolveBackend returning an empty string is treated exactly like undefined", async () => {
    const mgr = new BackendManager();
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const events = collector<OutcomeFeedEvent>();
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "", onEvent: events.push });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    sm.emit("task:verified", task({ id: "t1" }), report({ taskId: "t1", verdict: "accept" }));
    await tick();

    expect(events.events.filter((e) => e.type === "skipped")).toHaveLength(1);
  });
});

// ===========================================================================
// Exactly-once-per-task + duplicate detection
// ===========================================================================

describe("SwarmOutcomeFeed — exactly one outcome per task id", () => {
  it("the first terminal event wins; a later terminal event for the same task id emits duplicate and records nothing further", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const events = collector<OutcomeFeedEvent>();
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "b", onEvent: events.push });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    sm.emit("task:rejected", tk, report({ taskId: "t1", verdict: "reject" })); // 1st attempt fails, retried by the real manager
    await tick();
    sm.emit("task:dispatched", tk); // real manager re-dispatches the same task id
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" })); // eventually succeeds
    await tick();

    // Exactly one recorded pull — from the FIRST terminal event.
    expect(bandit.arm("b").pulls).toBe(1);
    expect(bandit.arm("b").verified).toBe(0); // the rejection, not the later success

    const duplicate = events.events.filter((e) => e.type === "duplicate");
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].taskId).toBe("t1");
  });
});

// ===========================================================================
// usd delta attribution
// ===========================================================================

describe("SwarmOutcomeFeed — usd delta attribution", () => {
  it("usd is the measured accruedUsd delta for the resolved backend between dispatch and terminal", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "billed");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "billed" });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    // Simulate real accrued cost between dispatch and terminal (e.g. a
    // provision's per-provision charge landing via the manager's own
    // telemetry bookkeeping).
    await mgr.provision(
      { workerId: "w1", capabilities: [], managerUrl: "https://x", authToken: "t" },
      { exclude: [] }
    );
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" }));
    await tick();

    // perProvisionUsd is 0.05 per the fixture descriptor — a configured
    // rate, not fabricated by this test.
    expect(bandit.arm("billed").totalUsd).toBeCloseTo(0.05, 10);
  });

  it("concurrent interleaved tasks on different backends attribute usd deltas per-backend correctly", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b1");
    registerFake(mgr, "b2");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const backendByTask = new Map<string, string>([
      ["ta", "b1"],
      ["tb", "b2"],
    ]);
    const feed = new SwarmOutcomeFeed({
      bandit,
      manager: mgr,
      resolveBackend: (t) => backendByTask.get(t.id),
    });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const ta = task({ id: "ta" });
    const tb = task({ id: "tb" });

    // Interleave: dispatch both, provision cost lands on b1 only in between,
    // then both terminate.
    sm.emit("task:dispatched", ta);
    sm.emit("task:dispatched", tb);
    await mgr.provision({ workerId: "w-b1", capabilities: [], managerUrl: "https://x", authToken: "t" }, { exclude: ["b2"] });
    sm.emit("task:verified", ta, report({ taskId: "ta", verdict: "accept" }));
    sm.emit("task:verified", tb, report({ taskId: "tb", verdict: "accept" }));
    await tick();

    // b1 accrued the 0.05 perProvisionUsd charge between ta's dispatch and
    // terminal; b2 accrued nothing — the delta is attributed per-backend,
    // never smeared across both.
    expect(bandit.arm("b1").totalUsd).toBeCloseTo(0.05, 10);
    expect(bandit.arm("b2").totalUsd).toBeCloseTo(0, 10);
  });

  it("usd delta is floored at 0 even if accruedUsd were to read lower at the terminal event than at dispatch", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "b" });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    // Force a "decreasing accruedUsd" reading between dispatch and terminal
    // via a controlled monkeypatch of the real manager's telemetry() method
    // (the manager itself never produces a decreasing value — this proves
    // the feed's own defensive floor holds even so).
    const realTelemetry = mgr.telemetry.bind(mgr);
    let call = 0;
    mgr.telemetry = ((name: string) => {
      call += 1;
      const base = realTelemetry(name);
      return { ...base, accruedUsd: call === 1 ? 5 : 2 };
    }) as typeof mgr.telemetry;

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk); // reads accruedUsd = 5 (call #1)
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" })); // reads accruedUsd = 2 (call #2)
    await tick();

    expect(bandit.arm("b").totalUsd).toBe(0); // never a fabricated negative number
  });

  it("usd defaults to 0 with a note when the dispatch-time and terminal-time backend attribution differ", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b1");
    registerFake(mgr, "b2");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    let resolved = "b1";
    const events = collector<OutcomeFeedEvent>();
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => resolved, onEvent: events.push });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk); // resolves to b1 at dispatch time
    resolved = "b2"; // reassigned before the terminal event
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" }));
    await tick();

    const arm = bandit.arm("b2");
    expect(arm).toMatchObject({ pulls: 1, totalUsd: 0 });
    expect(bandit.arm("b1").pulls).toBe(0);
    const recorded = events.events.find((e) => e.type === "recorded");
    expect(recorded?.detail?.usdNote).toMatch(/differs from terminal-time backend/);
  });
});

// ===========================================================================
// Persistence
// ===========================================================================

describe("SwarmOutcomeFeed — persistence", () => {
  it("persists the bandit's snapshot best-effort after a recorded outcome and folds success into the recorded event's detail", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const store = memoryStore();
    const events = collector<OutcomeFeedEvent>();
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "b", store, onEvent: events.push });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" }));
    await tick();

    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].arms["b"].pulls).toBe(1);
    const recorded = events.events.find((e) => e.type === "recorded");
    expect(recorded?.detail?.saved).toBe(true);
  });

  it("a store.save rejection never breaks recording — folded into detail.saveError instead", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const store = memoryStore({ failSave: true });
    const events = collector<OutcomeFeedEvent>();
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "b", store, onEvent: events.push });
    const sm = fakeSwarmManager();
    feed.attach(sm);

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" }));
    await tick();

    expect(bandit.arm("b").pulls).toBe(1); // the real outcome still landed
    const recorded = events.events.find((e) => e.type === "recorded");
    expect(recorded?.detail?.saveError).toBe("disk full");
  });
});

// ===========================================================================
// attach()/detach()
// ===========================================================================

describe("SwarmOutcomeFeed — attach/detach", () => {
  it("detach() (via off) stops further recording, and is idempotent", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "b" });
    const sm = fakeSwarmManager();
    const detach = feed.attach(sm);

    detach();
    expect(sm.offCalls).toBe(4); // one per listened event name

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" }));
    await tick();
    expect(bandit.arm("b").pulls).toBe(0); // nothing recorded post-detach

    // Idempotent: a second call does not throw or double-remove.
    expect(() => detach()).not.toThrow();
    expect(sm.offCalls).toBe(4);
  });

  it("detach() without an .off method falls back to an internal guard flag", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const feed = new SwarmOutcomeFeed({ bandit, manager: mgr, resolveBackend: () => "b" });

    // A minimal on-only stand-in with no `.off` at all.
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const guardOnly: SwarmManagerLike = {
      on(event, listener) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return guardOnly;
      },
    };
    const emitOn = (event: string, ...args: unknown[]) => {
      for (const l of listeners.get(event) ?? []) l(...args);
    };

    const detach = feed.attach(guardOnly);
    detach();

    const tk = task({ id: "t1" });
    emitOn("task:dispatched", tk);
    emitOn("task:verified", tk, report({ taskId: "t1", verdict: "accept" }));
    await tick();

    expect(bandit.arm("b").pulls).toBe(0);
    expect(() => detach()).not.toThrow();
  });

  it("two independently attach()ed feeds on the same manager each detach cleanly without disturbing the other", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit1 = new CostAwareRouteBandit({ manager: mgr });
    const bandit2 = new CostAwareRouteBandit({ manager: mgr });
    const feed1 = new SwarmOutcomeFeed({ bandit: bandit1, manager: mgr, resolveBackend: () => "b" });
    const feed2 = new SwarmOutcomeFeed({ bandit: bandit2, manager: mgr, resolveBackend: () => "b" });
    const sm = fakeSwarmManager();
    const detach1 = feed1.attach(sm);
    feed2.attach(sm);

    detach1();

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" }));
    await tick();

    expect(bandit1.arm("b").pulls).toBe(0); // detached before the events fired
    expect(bandit2.arm("b").pulls).toBe(1); // still attached
  });
});

// ===========================================================================
// Determinism
// ===========================================================================

describe("SwarmOutcomeFeed — determinism", () => {
  it("an identical event history yields an identical bandit snapshot across two independent feeds", async () => {
    function build() {
      const mgr = new BackendManager();
      registerFake(mgr, "x");
      registerFake(mgr, "y");
      const bandit = new CostAwareRouteBandit({ manager: mgr });
      // Injected deterministic clock: each build() gets its own counter
      // starting from the same origin, so both runs observe IDENTICAL
      // dispatch->terminal deltas. Without this the test would depend on
      // real Date.now() deltas between two emit() calls — i.e. on whether a
      // wall-clock millisecond happens to tick mid-test, which is exactly
      // the nondeterminism this suite exists to rule out.
      let tickMs = 0;
      const feed = new SwarmOutcomeFeed({
        bandit,
        manager: mgr,
        now: () => tickMs++,
        resolveBackend: (t) => (t.id === "t1" ? "x" : "y"),
      });
      const sm = fakeSwarmManager();
      feed.attach(sm);
      return { mgr, bandit, sm };
    }

    const run1 = build();
    const run2 = build();

    async function drive(sm: SwarmManagerLike & EventEmitter) {
      const t1 = task({ id: "t1" });
      const t2 = task({ id: "t2" });
      sm.emit("task:dispatched", t1);
      sm.emit("task:dispatched", t2);
      sm.emit("task:verified", t1, report({ taskId: "t1", verdict: "accept" }));
      sm.emit("task:rejected", t2, report({ taskId: "t2", verdict: "reject" }));
      await tick();
    }

    await drive(run1.sm);
    await drive(run2.sm);

    expect(run1.bandit.snapshot()).toEqual(run2.bandit.snapshot());
  });
});
