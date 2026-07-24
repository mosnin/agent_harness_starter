import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { BackendManager } from "../manager";
import { FakeBackend } from "../fake-backend";
import type { BackendDescriptor } from "../descriptor";
import { CostAwareRouteBandit, ROUTE_BANDIT_STATE_VERSION, type RouteBanditState } from "../route-bandit";
import type { BanditSnapshotStore } from "../bandit-provisioner";
import type { SwarmManagerLike, OutcomeFeedEvent } from "../outcome-feed";
import type { WorkerTask, VerificationReport } from "../../../swarm-runtime/types";
import {
  SwarmLearningLoop,
  renderLearningReport,
  type SwarmLearningEvent,
  type SwarmLearningStatus,
} from "../swarm-learning";

// ===========================================================================
// Fixtures (matching the house convention set by outcome-feed.test.ts)
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

function fakeSwarmManager(): SwarmManagerLike & EventEmitter {
  return new EventEmitter() as SwarmManagerLike & EventEmitter;
}

function memoryStore(seed?: unknown, opts: { failLoad?: boolean; failSave?: boolean } = {}): BanditSnapshotStore & {
  saved: RouteBanditState[];
  loadCalls: number;
} {
  const saved: RouteBanditState[] = [];
  let loadCalls = 0;
  return {
    saved,
    get loadCalls() {
      return loadCalls;
    },
    async load() {
      loadCalls += 1;
      if (opts.failLoad) throw new Error("disk read error");
      return seed;
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

/** Flush pending microtasks so the feed's async terminal-event handling
 *  (and this loop's synchronous re-aggregation of it) has settled. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function recordVerified(
  sm: SwarmManagerLike & EventEmitter,
  taskId: string
): Promise<void> {
  const tk = task({ id: taskId });
  sm.emit("task:dispatched", tk);
  sm.emit("task:verified", tk, report({ taskId, verdict: "accept" }));
  await tick();
}

// ===========================================================================
// attach() — construction guards
// ===========================================================================

describe("SwarmLearningLoop.attach — construction guards", () => {
  it("throws RangeError when opts.manager is not a BackendManager", async () => {
    const sm = fakeSwarmManager();
    await expect(
      SwarmLearningLoop.attach({
        manager: {} as BackendManager,
        swarm: sm,
        resolveBackend: () => "b",
      })
    ).rejects.toThrow(RangeError);
  });

  it("throws RangeError when opts.swarm is not a SwarmManagerLike", async () => {
    const mgr = new BackendManager();
    await expect(
      SwarmLearningLoop.attach({
        manager: mgr,
        swarm: {} as SwarmManagerLike,
        resolveBackend: () => "b",
      })
    ).rejects.toThrow(RangeError);
  });

  it("throws RangeError when opts.resolveBackend is not a function", async () => {
    const mgr = new BackendManager();
    const sm = fakeSwarmManager();
    await expect(
      SwarmLearningLoop.attach({
        manager: mgr,
        swarm: sm,
        resolveBackend: undefined as unknown as (t: WorkerTask) => string | undefined,
      })
    ).rejects.toThrow(RangeError);
  });

  it("throws RangeError when opts.historyLimit is not a positive integer", async () => {
    const mgr = new BackendManager();
    const sm = fakeSwarmManager();
    await expect(
      SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", historyLimit: 0 })
    ).rejects.toThrow(RangeError);
    await expect(
      SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", historyLimit: 1.5 })
    ).rejects.toThrow(RangeError);
  });
});

// ===========================================================================
// Snapshot precedence matrix
// ===========================================================================

describe("SwarmLearningLoop.attach — snapshot precedence", () => {
  it("no bandit, no store -> fresh bandit, 'attached' event says banditSource: fresh", async () => {
    const mgr = new BackendManager();
    const sm = fakeSwarmManager();
    const events = collector<SwarmLearningEvent>();
    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", onEvent: events.push });

    expect(loop.status().arms).toEqual({});
    const attached = events.events.find((e) => e.type === "attached");
    expect(attached?.detail).toMatchObject({ banditSource: "fresh", armCount: 0 });
    expect(events.events.some((e) => e.type === "snapshot-loaded")).toBe(false);
    expect(events.events.some((e) => e.type === "snapshot-load-failed")).toBe(false);
  });

  it("explicit bandit passed + store present -> store is NEVER loaded from, and the 'attached' event says so", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const explicitBandit = new CostAwareRouteBandit({ manager: mgr });
    explicitBandit.recordOutcome("b", { verified: true, elapsedMs: 10, usd: 0 });
    const store = memoryStore({ version: ROUTE_BANDIT_STATE_VERSION, arms: {} }); // would hydrate an EMPTY bandit if loaded
    const sm = fakeSwarmManager();
    const events = collector<SwarmLearningEvent>();

    const loop = await SwarmLearningLoop.attach({
      manager: mgr,
      swarm: sm,
      resolveBackend: () => "b",
      bandit: explicitBandit,
      store,
      onEvent: events.push,
    });

    // store.load() was never called — the explicit bandit's prior history survived untouched.
    expect(store.loadCalls).toBe(0);
    expect(loop.bandit()).toBe(explicitBandit);
    expect(loop.bandit().arm("b").pulls).toBe(1);

    const attached = events.events.find((e) => e.type === "attached");
    expect(attached?.detail).toMatchObject({ banditSource: "explicit" });
    expect(events.events.some((e) => e.type === "snapshot-loaded")).toBe(false);
    expect(events.events.some((e) => e.type === "snapshot-load-failed")).toBe(false);
  });

  it("no bandit + store present + valid snapshot -> hydrates via fromState and emits snapshot-loaded", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const seed: RouteBanditState = {
      version: ROUTE_BANDIT_STATE_VERSION,
      arms: { b: { pulls: 4, verified: 3, totalElapsedMs: 400, totalUsd: 0.2 } },
    };
    const store = memoryStore(seed);
    const sm = fakeSwarmManager();
    const events = collector<SwarmLearningEvent>();

    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", store, onEvent: events.push });

    expect(store.loadCalls).toBe(1);
    expect(loop.bandit().arm("b")).toMatchObject({ pulls: 4, verified: 3, totalElapsedMs: 400, totalUsd: 0.2 });
    const loaded = events.events.find((e) => e.type === "snapshot-loaded");
    expect(loaded?.detail).toMatchObject({ armCount: 1 });
    const attached = events.events.find((e) => e.type === "attached");
    expect(attached?.detail).toMatchObject({ banditSource: "store", armCount: 1 });
  });

  it("no bandit + store present + a corrupt snapshot -> per-arm drops via fromState, valid arms retained", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "good");
    registerFake(mgr, "bad");
    const seed = {
      version: ROUTE_BANDIT_STATE_VERSION,
      arms: {
        good: { pulls: 2, verified: 1, totalElapsedMs: 100, totalUsd: 0.1 },
        // Malformed: verified > pulls is structurally impossible -> dropped by fromState.
        bad: { pulls: 1, verified: 5, totalElapsedMs: 50, totalUsd: 0.05 },
      },
    };
    const store = memoryStore(seed);
    const sm = fakeSwarmManager();
    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "good", store });

    const arms = loop.status().arms;
    expect(arms.good).toMatchObject({ pulls: 2, verified: 1 });
    expect(arms.bad).toBeUndefined();
  });

  it("no bandit + store present + a wholly unrecognized shape -> fresh (empty) bandit via fromState, still reported as snapshot-loaded", async () => {
    const mgr = new BackendManager();
    const store = memoryStore({ garbage: true });
    const sm = fakeSwarmManager();
    const events = collector<SwarmLearningEvent>();
    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", store, onEvent: events.push });

    expect(loop.status().arms).toEqual({});
    expect(events.events.find((e) => e.type === "snapshot-loaded")?.detail).toMatchObject({ armCount: 0 });
  });

  it("store.load() rejection -> fresh bandit, 'snapshot-load-failed' with the error message, attach() itself never throws", async () => {
    const mgr = new BackendManager();
    const store = memoryStore(undefined, { failLoad: true });
    const sm = fakeSwarmManager();
    const events = collector<SwarmLearningEvent>();

    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", store, onEvent: events.push });

    expect(loop.status().arms).toEqual({});
    const failed = events.events.find((e) => e.type === "snapshot-load-failed");
    expect(failed?.detail).toMatchObject({ error: "disk read error" });
    const attached = events.events.find((e) => e.type === "attached");
    expect(attached?.detail).toMatchObject({ banditSource: "fresh" });
  });
});

// ===========================================================================
// Live recording via a real SwarmOutcomeFeed against a fake SwarmManagerLike
// ===========================================================================

describe("SwarmLearningLoop — live outcome recording", () => {
  it("recorded/skipped/duplicate events update counts, arms, and the ring buffer", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const sm = fakeSwarmManager();
    const events = collector<SwarmLearningEvent>();
    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: (t) => (t.id === "unknown" ? undefined : "b"), onEvent: events.push });

    await recordVerified(sm, "t1");

    // A duplicate: replay the same task id's terminal event again.
    const tDup = task({ id: "t1" });
    sm.emit("task:verified", tDup, report({ taskId: "t1", verdict: "accept" }));
    await tick();

    // A skipped one: resolveBackend returns undefined for this task id.
    const tUnknown = task({ id: "unknown" });
    sm.emit("task:dispatched", tUnknown);
    sm.emit("task:verified", tUnknown, report({ taskId: "unknown", verdict: "accept" }));
    await tick();

    const status = loop.status();
    expect(status.attached).toBe(true);
    expect(status.counts).toEqual({ recorded: 1, skipped: 1, duplicate: 1 });
    expect(status.arms.b).toMatchObject({ pulls: 1, verified: 1 });
    expect(status.recent).toHaveLength(3);
    expect(status.recent.map((e) => e.type)).toEqual(["recorded", "duplicate", "skipped"]);

    // status().counts reconciles exactly with the feed events observed.
    const feedEvents = events.events.filter((e) => e.type === "feed");
    expect(feedEvents).toHaveLength(3);
    const reconciled = { recorded: 0, skipped: 0, duplicate: 0 };
    for (const e of feedEvents) {
      const inner = e.detail as unknown as OutcomeFeedEvent;
      reconciled[inner.type] += 1;
    }
    expect(reconciled).toEqual(status.counts);
  });

  it("'feed' events wrap the underlying OutcomeFeedEvent verbatim", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const sm = fakeSwarmManager();
    const events = collector<SwarmLearningEvent>();
    let t = 5000;
    await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", now: () => t, onEvent: events.push });

    const tk = task({ id: "t1" });
    sm.emit("task:dispatched", tk);
    t += 40;
    sm.emit("task:verified", tk, report({ taskId: "t1", verdict: "accept" }));
    await tick();

    const feedEvent = events.events.find((e) => e.type === "feed");
    expect(feedEvent).toBeDefined();
    const inner = feedEvent!.detail as unknown as OutcomeFeedEvent;
    expect(inner.type).toBe("recorded");
    expect(inner.taskId).toBe("t1");
    expect(inner.backend).toBe("b");
    expect(inner.detail).toMatchObject({ verified: true, elapsedMs: 40, usd: 0 });
    // The wrapping SwarmLearningEvent's `at` matches the inner OutcomeFeedEvent's own `at`.
    expect(feedEvent!.at).toBe(inner.at);
  });

  it("the same bandit passed to two loops on two different swarms accumulates outcomes from both", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const sm1 = fakeSwarmManager();
    const sm2 = fakeSwarmManager();
    await SwarmLearningLoop.attach({ manager: mgr, swarm: sm1, resolveBackend: () => "b", bandit });
    await SwarmLearningLoop.attach({ manager: mgr, swarm: sm2, resolveBackend: () => "b", bandit });

    await recordVerified(sm1, "t1");
    await recordVerified(sm2, "t2");

    expect(bandit.arm("b").pulls).toBe(2);
  });
});

// ===========================================================================
// Ring buffer clipping
// ===========================================================================

describe("SwarmLearningLoop — ring buffer clipping", () => {
  it("clips 'recent' at exactly historyLimit, newest last", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const sm = fakeSwarmManager();
    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", historyLimit: 3 });

    for (let i = 0; i < 5; i++) {
      await recordVerified(sm, `t${i}`);
    }

    const recent = loop.status().recent;
    expect(recent).toHaveLength(3);
    // Newest last: the last 3 of 5 recorded task ids, in order.
    expect(recent.map((e) => e.taskId)).toEqual(["t2", "t3", "t4"]);
  });
});

// ===========================================================================
// Double-attach guard
// ===========================================================================

describe("SwarmLearningLoop — attach is single-use per instance", () => {
  it("a second internal attach on the same loop instance is a hard RangeError", async () => {
    const mgr = new BackendManager();
    const sm = fakeSwarmManager();
    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b" });

    // The loop is already attached by the static factory above — re-invoking
    // the internal wiring on this SAME instance must refuse rather than
    // silently double-listen (which would double-count every outcome).
    const reattach = (loop as unknown as { subscribeToSwarm: (s: string) => void }).subscribeToSwarm.bind(loop);
    expect(() => reattach("fresh")).toThrow(RangeError);
  });
});

// ===========================================================================
// detach()
// ===========================================================================

describe("SwarmLearningLoop — detach()", () => {
  it("detaches the feed (no further recording), persists a final snapshot, and emits 'detached' exactly once", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const store = memoryStore();
    const sm = fakeSwarmManager();
    const events = collector<SwarmLearningEvent>();
    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", store, onEvent: events.push });

    await recordVerified(sm, "t1");
    const savedBefore = store.saved.length;

    await loop.detach();
    expect(loop.status().attached).toBe(false);
    expect(store.saved.length).toBe(savedBefore + 1);
    expect(store.saved[store.saved.length - 1].arms.b.pulls).toBe(1);
    expect(events.events.filter((e) => e.type === "detached")).toHaveLength(1);
    expect(events.events.find((e) => e.type === "detached")?.detail).toMatchObject({ saved: true });

    // Nothing further recorded post-detach.
    await recordVerified(sm, "t2");
    expect(loop.bandit().arm("b").pulls).toBe(1);

    // Idempotent: a second detach() is a complete no-op.
    await loop.detach();
    expect(store.saved.length).toBe(savedBefore + 1);
    expect(events.events.filter((e) => e.type === "detached")).toHaveLength(1);
  });

  it("detach() without a store emits 'detached' with saved:false and a reason, never throws", async () => {
    const mgr = new BackendManager();
    const sm = fakeSwarmManager();
    const events = collector<SwarmLearningEvent>();
    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", onEvent: events.push });

    await expect(loop.detach()).resolves.toBeUndefined();
    const detached = events.events.find((e) => e.type === "detached");
    expect(detached?.detail).toMatchObject({ saved: false, reason: "no store configured" });
  });

  it("a store.save() rejection on detach is non-fatal: folded into the 'detached' event, never thrown", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "b");
    const store = memoryStore(undefined, { failSave: true });
    const sm = fakeSwarmManager();
    const events = collector<SwarmLearningEvent>();
    const loop = await SwarmLearningLoop.attach({ manager: mgr, swarm: sm, resolveBackend: () => "b", store, onEvent: events.push });

    await recordVerified(sm, "t1"); // succeeds (the feed's own persistBestEffort also fails independently, harmlessly)

    await expect(loop.detach()).resolves.toBeUndefined();
    const detached = events.events.find((e) => e.type === "detached");
    expect(detached?.detail).toMatchObject({ saved: false, error: "disk full" });
  });
});

// ===========================================================================
// renderLearningReport — golden tests
// ===========================================================================

describe("renderLearningReport", () => {
  it("renders a never-pulled arm without fabricating a numeric reward", () => {
    const status: SwarmLearningStatus = {
      attached: true,
      counts: { recorded: 0, skipped: 0, duplicate: 0 },
      arms: {
        fresh: { pulls: 0, verified: 0, totalElapsedMs: 0, totalUsd: 0, meanReward: 0, ucb: null },
      },
      recent: [],
    };
    expect(renderLearningReport(status)).toEqual([
      "Swarm learning loop — recorded=0 skipped=0 duplicate=0",
      "",
      "Arms:",
      "  fresh: never pulled",
      "",
      "Recent events (up to 10, newest last):",
      "  (none)",
    ]);
  });

  it("renders a pulled arm's real numbers, sorts arms by name, and surfaces honesty notes verbatim", () => {
    const status: SwarmLearningStatus = {
      attached: true,
      counts: { recorded: 2, skipped: 1, duplicate: 0 },
      arms: {
        zeta: { pulls: 3, verified: 2, totalElapsedMs: 900, totalUsd: 0.15, meanReward: 0.6123, ucb: 1.2345 },
        alpha: { pulls: 0, verified: 0, totalElapsedMs: 0, totalUsd: 0, meanReward: 0, ucb: null },
      },
      recent: [
        {
          type: "recorded",
          at: 100,
          taskId: "t1",
          backend: "zeta",
          detail: { verified: true, elapsedMs: 40, usd: 0, usdNote: "no dispatch-time accruedUsd baseline for backend \"zeta\" on task \"t1\"; usd defaulted to 0 (never guessed)" },
        },
        {
          type: "skipped",
          at: 110,
          taskId: "t2",
          detail: { event: "task:verified", reason: "resolveBackend returned no backend" },
        },
      ],
    };
    expect(renderLearningReport(status)).toEqual([
      "Swarm learning loop — recorded=2 skipped=1 duplicate=0",
      "",
      "Arms:",
      "  alpha: never pulled",
      "  zeta: pulls=3 verified=2 meanReward=0.61 ucb=1.23",
      "",
      "Recent events (up to 10, newest last):",
      "  recorded task=t1 backend=zeta",
      "    usdNote: no dispatch-time accruedUsd baseline for backend \"zeta\" on task \"t1\"; usd defaulted to 0 (never guessed)",
      "  skipped task=t2 backend=-",
    ]);
  });

  it("caps rendered recent events at 10, keeping the most-recent (last) 10", () => {
    const recent: OutcomeFeedEvent[] = Array.from({ length: 15 }, (_, i) => ({
      type: "recorded" as const,
      at: i,
      taskId: `t${i}`,
      backend: "b",
      detail: {},
    }));
    const status: SwarmLearningStatus = {
      attached: true,
      counts: { recorded: 15, skipped: 0, duplicate: 0 },
      arms: {},
      recent,
    };
    const lines = renderLearningReport(status);
    const eventLines = lines.filter((l) => l.startsWith("  recorded task="));
    expect(eventLines).toHaveLength(10);
    expect(eventLines[0]).toBe("  recorded task=t5 backend=b");
    expect(eventLines[9]).toBe("  recorded task=t14 backend=b");
  });
});
