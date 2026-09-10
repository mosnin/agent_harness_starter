import { describe, it, expect, afterEach } from "vitest";
import {
  attachInlineAttribution,
  attachInlineLearning,
  INLINE_BACKEND_NAME,
  type InlineAttributionEvent,
  type SwarmWorkerEventSource,
} from "../inline-attribution";
import { WorkerAttributionRegistry, resolveBackendForTask, type AttributionState, type AttributionStore } from "../worker-attribution";
import { SwarmLearningLoop, type SwarmLearningEvent } from "../swarm-learning";
import type { OutcomeFeedEvent } from "../outcome-feed";
import { BackendManager } from "../manager";
import { FakeBackend } from "../fake-backend";
import type { BackendDescriptor } from "../descriptor";
import { createInlineSwarm } from "../../../swarm-runtime/factory";
import { DemoExecutor } from "../../../swarm-runtime/worker/executor";
import type { SwarmManager, WorkerRecord } from "../../../swarm-runtime/manager/manager";
import type { WorkerTask } from "../../../swarm-runtime/types";

// ===========================================================================
// Fixtures & test doubles
// ===========================================================================

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function workerRecord(workerId: string, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    workerId,
    handle: { workerId, nativeId: `native-${workerId}`, kind: "inline", startedAt: 0 },
    capabilities: ["general"],
    status: "idle",
    lastHeartbeat: 0,
    load: 0,
    ...overrides,
  };
}

/**
 * A minimal, purpose-built double satisfying {@link SwarmWorkerEventSource}
 * exactly — NOT built on Node's `EventEmitter` (whose generic `off<K>`
 * override doesn't structurally match the locked interface's plain
 * `(...a: never[]) => void` listener parameter; see
 * `inline-attribution.ts`'s `asWorkerEventSource` for the real-`SwarmManager`
 * side of that same quirk). This double lets unit tests fire worker
 * lifecycle events synchronously and precisely, with zero casting.
 */
class FakeSwarmEventSource implements SwarmWorkerEventSource {
  private spawned: Array<(rec: WorkerRecord) => void> = [];
  private killed: Array<(rec: WorkerRecord, reason: string) => void> = [];
  private dead: Array<(rec: WorkerRecord, reason: string) => void> = [];

  on(event: "worker:spawned" | "worker:killed" | "worker:dead", l: (...a: never[]) => void): unknown {
    if (event === "worker:spawned") this.spawned.push(l as (rec: WorkerRecord) => void);
    else if (event === "worker:killed") this.killed.push(l as (rec: WorkerRecord, reason: string) => void);
    else this.dead.push(l as (rec: WorkerRecord, reason: string) => void);
    return this;
  }

  off(event: string, l: (...a: never[]) => void): unknown {
    if (event === "worker:spawned") this.spawned = this.spawned.filter((f) => f !== l);
    else if (event === "worker:killed") this.killed = this.killed.filter((f) => f !== l);
    else if (event === "worker:dead") this.dead = this.dead.filter((f) => f !== l);
    return this;
  }

  emitSpawned(rec: WorkerRecord): void {
    for (const l of [...this.spawned]) l(rec);
  }
  emitKilled(rec: WorkerRecord, reason: string): void {
    for (const l of [...this.killed]) l(rec, reason);
  }
  emitDead(rec: WorkerRecord, reason: string): void {
    for (const l of [...this.dead]) l(rec, reason);
  }

  listenerCounts(): { spawned: number; killed: number; dead: number } {
    return { spawned: this.spawned.length, killed: this.killed.length, dead: this.dead.length };
  }
}

/** In-memory AttributionStore, real async round-trip. */
class MemoryAttributionStore implements AttributionStore {
  public saved: AttributionState[] = [];
  private data: unknown;

  async save(s: AttributionState): Promise<void> {
    this.saved.push(s);
    this.data = JSON.parse(JSON.stringify(s));
  }
  async load(): Promise<unknown> {
    return this.data;
  }
  setRaw(raw: unknown): void {
    this.data = raw;
  }
}

function descriptor(name: string): BackendDescriptor {
  return {
    name,
    kind: "fake",
    capabilities: ["general"],
    cost: { perRunningHourUsd: 1, perHibernatedHourUsd: 0.1, perProvisionUsd: 0.05, source: "configured" },
    supportsHibernate: true,
    locality: "local",
  };
}

let swarm: SwarmManager | undefined;
afterEach(async () => {
  await swarm?.shutdown();
  swarm = undefined;
});

// ===========================================================================
// attachInlineAttribution — basic lifecycle mirroring
// ===========================================================================

describe("attachInlineAttribution — basic lifecycle mirroring", () => {
  it("worker:spawned records the workerId under the default INLINE_BACKEND_NAME", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    src.emitSpawned(workerRecord("w1"));

    expect(registry.lookup("w1")).toBe(INLINE_BACKEND_NAME);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "recorded", workerId: "w1" });
  });

  it("worker:spawned records nativeId from the real handle", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    attachInlineAttribution({ swarm: src, registry });

    src.emitSpawned(workerRecord("w1", { handle: { workerId: "w1", nativeId: "container-abc", kind: "inline", startedAt: 0 } }));

    expect(registry.snapshot().entries["w1"]).toMatchObject({ backend: INLINE_BACKEND_NAME, nativeId: "container-abc" });
  });

  it("honors a custom backendName", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    attachInlineAttribution({ swarm: src, registry, backendName: "inline-custom" });

    src.emitSpawned(workerRecord("w1"));
    expect(registry.lookup("w1")).toBe("inline-custom");
  });

  it("worker:killed releases the attribution", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    src.emitSpawned(workerRecord("w1"));
    src.emitKilled(workerRecord("w1"), "misbehaving");

    expect(registry.lookup("w1")).toBeUndefined();
    const released = events.find((e) => e.type === "released");
    expect(released).toMatchObject({ workerId: "w1", detail: { reason: "misbehaving", event: "worker:killed", releasedExisting: true } });
  });

  it("worker:dead releases the attribution", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    src.emitSpawned(workerRecord("w1"));
    src.emitDead(workerRecord("w1"), "no heartbeat");

    expect(registry.lookup("w1")).toBeUndefined();
    const released = events.find((e) => e.type === "released");
    expect(released).toMatchObject({ workerId: "w1", detail: { reason: "no heartbeat", event: "worker:dead", releasedExisting: true } });
  });

  it("worker:dead AFTER worker:killed for the same id (double release) never throws and reports releasedExisting:false the second time", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    src.emitSpawned(workerRecord("w1"));
    expect(() => src.emitKilled(workerRecord("w1"), "killed-first")).not.toThrow();
    expect(() => src.emitDead(workerRecord("w1"), "dead-second")).not.toThrow();

    const releaseEvents = events.filter((e) => e.type === "released");
    expect(releaseEvents).toHaveLength(2);
    expect(releaseEvents[0].detail?.releasedExisting).toBe(true);
    expect(releaseEvents[1].detail?.releasedExisting).toBe(false);
  });

  it("re-spawn of the same workerId on the SAME backend is a no-op refresh (no collision, no throw)", () => {
    const clock = makeClock(0);
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry({ now: clock.now });
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, now: clock.now, onEvent: (e) => events.push(e) });

    src.emitSpawned(workerRecord("w1"));
    clock.advance(50);
    expect(() => src.emitSpawned(workerRecord("w1", { handle: { workerId: "w1", nativeId: "n2", kind: "inline", startedAt: 50 } }))).not.toThrow();

    expect(registry.lookup("w1")).toBe(INLINE_BACKEND_NAME);
    expect(registry.snapshot().entries["w1"]).toMatchObject({ at: 50, nativeId: "n2" });
    expect(events.filter((e) => e.type === "recorded")).toHaveLength(2);
    expect(events.filter((e) => e.type === "collision")).toHaveLength(0);
  });
});

// ===========================================================================
// Cross-backend collision
// ===========================================================================

describe("attachInlineAttribution — cross-backend collision", () => {
  it("a collision (RangeError from registry.record) is caught, emitted exactly once, and leaves the original attribution intact", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    const eventsA: InlineAttributionEvent[] = [];
    const eventsB: InlineAttributionEvent[] = [];

    // Two independent attachments sharing ONE registry, attributing to
    // different backend names — simulates two swarms/providers racing to
    // claim the same worker id, which the registry must never silently
    // resolve (see worker-attribution.ts's file header).
    attachInlineAttribution({ swarm: src, registry, backendName: "inline-a", onEvent: (e) => eventsA.push(e) });
    attachInlineAttribution({ swarm: src, registry, backendName: "inline-b", onEvent: (e) => eventsB.push(e) });

    expect(() => src.emitSpawned(workerRecord("w1"))).not.toThrow();

    // First listener wins (attached first); second's record() throws and is caught.
    expect(registry.lookup("w1")).toBe("inline-a");
    expect(eventsA.filter((e) => e.type === "recorded")).toHaveLength(1);
    expect(eventsA.filter((e) => e.type === "collision")).toHaveLength(0);
    expect(eventsB.filter((e) => e.type === "recorded")).toHaveLength(0);
    const collisions = eventsB.filter((e) => e.type === "collision");
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ workerId: "w1" });
    expect(String(collisions[0].detail?.error)).toMatch(/already attributed to backend "inline-a"/);

    // The registry itself still reflects the pre-collision, first-writer state.
    expect(registry.lookup("w1")).toBe("inline-a");
  });
});

// ===========================================================================
// Exception safety under a poisoned registry
// ===========================================================================

describe("attachInlineAttribution — exception safety under a poisoned registry", () => {
  it("registry.record throwing a non-RangeError is caught, emitted as collision, and never propagates into the emitter", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    registry.record = () => {
      throw new Error("disk exploded");
    };
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    expect(() => src.emitSpawned(workerRecord("w1"))).not.toThrow();
    expect(events).toEqual([{ type: "collision", at: expect.any(Number), workerId: "w1", detail: { error: "disk exploded", backend: INLINE_BACKEND_NAME } }]);
  });

  it("registry.release throwing is swallowed silently and never propagates into the emitter", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    registry.record("w1", INLINE_BACKEND_NAME);
    registry.release = () => {
      throw new Error("release exploded");
    };
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    expect(() => src.emitKilled(workerRecord("w1"), "reason")).not.toThrow();
    // No event type in the locked contract fits a poisoned release; the
    // listener absorbs it silently rather than mislabeling it as a
    // "collision" (which is reserved for record()'s cross-backend case).
    expect(events).toHaveLength(0);
  });

  it("registry.persist rejecting is caught and reported as persist-failed, never thrown", async () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    registry.persist = async () => {
      throw new Error("store unreachable");
    };
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    expect(() => src.emitSpawned(workerRecord("w1"))).not.toThrow();
    await tick();
    const persistFailed = events.find((e) => e.type === "persist-failed");
    expect(persistFailed).toMatchObject({ workerId: "w1", detail: { error: "store unreachable" } });
  });

  it("registry.persist throwing SYNCHRONOUSLY (not returning a promise) is caught and reported as persist-failed", async () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    (registry as unknown as { persist: () => Promise<{ saved: boolean; error?: string }> }).persist = (() => {
      throw new Error("sync boom");
    }) as unknown as () => Promise<{ saved: boolean; error?: string }>;
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    expect(() => src.emitSpawned(workerRecord("w1"))).not.toThrow();
    await tick();
    const persistFailed = events.find((e) => e.type === "persist-failed");
    expect(persistFailed).toMatchObject({ workerId: "w1", detail: { error: "sync boom" } });
  });

  it("registry.persist resolving {saved:false} (its own documented honest-failure contract) is reported as persist-failed", async () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry(); // no store configured -> persist() resolves {saved:false, error:"no store configured"}
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    src.emitSpawned(workerRecord("w1"));
    await tick();
    const persistFailed = events.find((e) => e.type === "persist-failed");
    expect(persistFailed).toMatchObject({ workerId: "w1", detail: { error: "no store configured" } });
  });

  it("persistAfterMutation:false never calls registry.persist at all", async () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    let persistCalls = 0;
    const realPersist = registry.persist.bind(registry);
    registry.persist = async () => {
      persistCalls += 1;
      return realPersist();
    };
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, persistAfterMutation: false, onEvent: (e) => events.push(e) });

    src.emitSpawned(workerRecord("w1"));
    await tick();
    expect(persistCalls).toBe(0);
    expect(events.filter((e) => e.type === "persist-failed")).toHaveLength(0);
  });

  it("a successful persist (real store) never emits persist-failed", async () => {
    const src = new FakeSwarmEventSource();
    const store = new MemoryAttributionStore();
    const registry = new WorkerAttributionRegistry({ store });
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    src.emitSpawned(workerRecord("w1"));
    await tick();
    expect(events.filter((e) => e.type === "persist-failed")).toHaveLength(0);
    expect(store.saved.length).toBeGreaterThan(0);
    expect(store.saved[store.saved.length - 1].entries["w1"]).toBeDefined();
  });
});

// ===========================================================================
// detach() — idempotent, unsubscribes all three listeners
// ===========================================================================

describe("attachInlineAttribution — detach()", () => {
  it("detach() unsubscribes worker:spawned/killed/dead; a post-detach event is not recorded", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    const events: InlineAttributionEvent[] = [];
    const handle = attachInlineAttribution({ swarm: src, registry, onEvent: (e) => events.push(e) });

    expect(src.listenerCounts()).toEqual({ spawned: 1, killed: 1, dead: 1 });
    handle.detach();
    expect(src.listenerCounts()).toEqual({ spawned: 0, killed: 0, dead: 0 });

    src.emitSpawned(workerRecord("w1"));
    src.emitKilled(workerRecord("w2"), "r");
    src.emitDead(workerRecord("w3"), "r");

    expect(registry.ids()).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it("detach() is idempotent — a second call is a harmless no-op", () => {
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry();
    const handle = attachInlineAttribution({ swarm: src, registry });
    handle.detach();
    expect(() => handle.detach()).not.toThrow();
    expect(src.listenerCounts()).toEqual({ spawned: 0, killed: 0, dead: 0 });
  });
});

// ===========================================================================
// attachInlineLearning — restore path (attributionStore hydrates before any event)
// ===========================================================================

describe("attachInlineLearning — restore path", () => {
  it("hydrates the registry from attributionStore before any listener fires, dropping malformed entries", async () => {
    swarm = await createInlineSwarm({ capabilities: ["general"], poolSize: 1, executor: new DemoExecutor() });
    const manager = new BackendManager();
    manager.register(new FakeBackend({ name: INLINE_BACKEND_NAME }), descriptor(INLINE_BACKEND_NAME));

    const attributionStore = new MemoryAttributionStore();
    attributionStore.setRaw({
      version: 1,
      entries: {
        "pre-existing": { backend: INLINE_BACKEND_NAME, at: 5 },
        malformed1: { backend: "", at: 5 },
        malformed2: { backend: INLINE_BACKEND_NAME },
        malformed3: "not-an-object",
      },
    });

    const handle = await attachInlineLearning({ manager, swarm, attributionStore });
    expect(handle.registry.lookup("pre-existing")).toBe(INLINE_BACKEND_NAME);
    expect(handle.registry.ids()).toEqual(["pre-existing"]);

    await handle.detach();
  });

  it("an explicitly-passed registry is used as-is and attributionStore is not consulted", async () => {
    swarm = await createInlineSwarm({ capabilities: ["general"], poolSize: 1, executor: new DemoExecutor() });
    const manager = new BackendManager();
    manager.register(new FakeBackend({ name: INLINE_BACKEND_NAME }), descriptor(INLINE_BACKEND_NAME));

    const registry = new WorkerAttributionRegistry();
    registry.record("already-here", INLINE_BACKEND_NAME);
    const attributionStore = new MemoryAttributionStore();
    attributionStore.setRaw({ version: 1, entries: { "from-store": { backend: INLINE_BACKEND_NAME, at: 1 } } });

    const handle = await attachInlineLearning({ manager, swarm, registry, attributionStore });
    expect(handle.registry).toBe(registry);
    expect(handle.registry.lookup("already-here")).toBe(INLINE_BACKEND_NAME);
    expect(handle.registry.lookup("from-store")).toBeUndefined();

    await handle.detach();
  });

  it("a fresh registry WITHOUT an attributionStore never emits misleading persist-failed events on real worker churn", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2, executor: new DemoExecutor() });
    const manager = new BackendManager();
    manager.register(new FakeBackend({ name: INLINE_BACKEND_NAME }), descriptor(INLINE_BACKEND_NAME));

    const attributionEvents: InlineAttributionEvent[] = [];
    const handle = await attachInlineLearning({
      manager,
      swarm,
      onAttributionEvent: (e) => attributionEvents.push(e),
    });

    const goal = await swarm.runGoal("Describe the module architecture", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
    await tick();
    await tick();

    // Real attribution really happened...
    expect(attributionEvents.filter((e) => e.type === "recorded").length).toBeGreaterThan(0);
    // ...but with persistence never configured, no per-mutation
    // "persist-failed" ("no store configured") noise was fabricated.
    expect(attributionEvents.filter((e) => e.type === "persist-failed")).toEqual([]);

    await handle.detach();
  });
});

// ===========================================================================
// REAL end-to-end: closing the learning-loop debt against a real createInlineSwarm
// ===========================================================================

describe("attachInlineLearning — real inline-swarm end-to-end", () => {
  it("CONTROL: without attribution, resolveBackendForTask never resolves anything -> recorded===0, skipped>0", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2, executor: new DemoExecutor() });
    const manager = new BackendManager();
    manager.register(new FakeBackend({ name: INLINE_BACKEND_NAME }), descriptor(INLINE_BACKEND_NAME));

    // The exact debt this module closes: an UNPOPULATED registry feeding
    // resolveBackendForTask, with NO attachInlineAttribution wired up.
    const registry = new WorkerAttributionRegistry();
    const events: SwarmLearningEvent[] = [];
    const loop = await SwarmLearningLoop.attach({
      manager,
      swarm,
      resolveBackend: resolveBackendForTask(registry),
      onEvent: (e) => events.push(e),
    });

    const goal = await swarm.runGoal("Describe the module architecture", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
    await tick();
    await tick();

    const status = loop.status();
    expect(status.counts.recorded).toBe(0);
    expect(status.counts.skipped).toBeGreaterThan(0);
    expect(Object.keys(status.arms)).toHaveLength(0);

    await loop.detach();
  });

  it("TREATMENT: attachInlineLearning attributes real spawned workers -> recorded>0, skipped===0 for attributed tasks", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2, executor: new DemoExecutor() });
    const manager = new BackendManager();
    manager.register(new FakeBackend({ name: INLINE_BACKEND_NAME }), descriptor(INLINE_BACKEND_NAME));

    const attributionEvents: InlineAttributionEvent[] = [];
    const learningEvents: SwarmLearningEvent[] = [];
    const handle = await attachInlineLearning({
      manager,
      swarm,
      onAttributionEvent: (e) => attributionEvents.push(e),
      onLearningEvent: (e) => learningEvents.push(e),
    });

    const goal = await swarm.runGoal("Describe the module architecture", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
    await tick();
    await tick();

    // Real attribution really happened via real worker:spawned events.
    const recordedAttribution = attributionEvents.filter((e) => e.type === "recorded");
    expect(recordedAttribution.length).toBeGreaterThan(0);
    expect(handle.registry.ids().length).toBeGreaterThan(0);
    for (const id of handle.registry.ids()) {
      expect(id).toMatch(/^w-[0-9a-f]+$/);
      expect(handle.registry.lookup(id)).toBe(INLINE_BACKEND_NAME);
    }

    const status = handle.loop.status();
    expect(status.counts.recorded).toBeGreaterThan(0);
    expect(status.counts.skipped).toBe(0);
    const arm = status.arms[INLINE_BACKEND_NAME];
    expect(arm).toBeDefined();
    expect(arm.pulls).toBe(status.counts.recorded);
    expect(arm.verified).toBe(arm.pulls);

    // Learning events really came from the real feed (verbatim-forwarded).
    const feedRecorded = learningEvents.filter(
      (e) => e.type === "feed" && (e.detail as unknown as OutcomeFeedEvent).type === "recorded"
    );
    expect(feedRecorded.length).toBe(status.counts.recorded);

    await handle.detach();
  });

  it("real swarm run COMPLETES even with a registry whose record() always throws (exception safety end-to-end)", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2, executor: new DemoExecutor() });
    const manager = new BackendManager();
    manager.register(new FakeBackend({ name: INLINE_BACKEND_NAME }), descriptor(INLINE_BACKEND_NAME));

    const registry = new WorkerAttributionRegistry();
    registry.record = () => {
      throw new Error("poisoned record");
    };
    const attributionEvents: InlineAttributionEvent[] = [];
    const handle = await attachInlineLearning({
      manager,
      swarm,
      registry,
      onAttributionEvent: (e) => attributionEvents.push(e),
    });

    const goal = await swarm.runGoal("Describe the module architecture", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
    await tick();

    // Every spawn hit the poisoned record() and was reported as a collision
    // — the run still finished, proving the listener never threw into the
    // manager's EventEmitter.
    expect(attributionEvents.filter((e) => e.type === "collision").length).toBeGreaterThan(0);
    expect(handle.registry.ids()).toEqual([]);
    // With nothing ever successfully attributed, the learning loop honestly
    // skips every outcome rather than fabricating one.
    expect(handle.loop.status().counts.recorded).toBe(0);

    await handle.detach();
  });

  it("idempotent composed detach(): attribution.detach() then loop.detach(), a second call is a no-op, and events stop flowing", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2, executor: new DemoExecutor() });
    const manager = new BackendManager();
    manager.register(new FakeBackend({ name: INLINE_BACKEND_NAME }), descriptor(INLINE_BACKEND_NAME));

    const handle = await attachInlineLearning({ manager, swarm });

    const order: string[] = [];
    const origAttributionDetach = handle.attribution.detach.bind(handle.attribution);
    handle.attribution.detach = () => {
      order.push("attribution");
      origAttributionDetach();
    };
    const origLoopDetach = handle.loop.detach.bind(handle.loop);
    handle.loop.detach = async () => {
      order.push("loop");
      await origLoopDetach();
    };

    const goal = await swarm.runGoal("Describe the module architecture", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
    await tick();
    await tick();

    const pullsBeforeDetach = handle.loop.bandit().arm(INLINE_BACKEND_NAME).pulls;
    expect(pullsBeforeDetach).toBeGreaterThan(0);

    await handle.detach();
    expect(order).toEqual(["attribution", "loop"]);
    expect(handle.loop.status().attached).toBe(false);
    const savesAfterFirstDetach = handle.registry.snapshot(); // sanity: registry state stable post-detach

    // Second composed detach: the composed function delegates to both
    // underlying idempotent detaches again (attribution first, loop second
    // — same ordering), but neither does anything further: no throw, no
    // additional unsubscribe/persist side effect.
    await expect(handle.detach()).resolves.toBeUndefined();
    expect(order).toEqual(["attribution", "loop", "attribution", "loop"]);
    expect(handle.registry.snapshot()).toEqual(savesAfterFirstDetach);

    // Detach really stopped listening: a synthetic post-detach worker:spawned
    // must not be attributed, and a synthetic post-detach task:verified must
    // not move the bandit. Emitted through the raw untyped EventEmitter
    // surface purely so the test can synthesize the events; the shapes
    // mirror exactly what manager.ts itself emits.
    const rawEmitter = swarm as unknown as { emit(event: string, ...args: unknown[]): boolean };
    rawEmitter.emit("worker:spawned", workerRecord("w-should-not-attribute"));
    expect(handle.registry.lookup("w-should-not-attribute")).toBeUndefined();

    rawEmitter.emit(
      "task:verified",
      { id: "post-detach-task", result: { workerId: "w-should-not-attribute" } },
      { taskId: "post-detach-task", workerId: "w-should-not-attribute", verdict: "accept", score: 1, checks: [], feedback: "", at: Date.now() }
    );
    await tick();
    expect(handle.loop.bandit().arm(INLINE_BACKEND_NAME).pulls).toBe(pullsBeforeDetach);
  });
});

// ===========================================================================
// Deterministic clock — zero Date.now() in assertions
// ===========================================================================

describe("attachInlineAttribution — injected clock", () => {
  it("every emitted event's `at` comes from the injected clock, never a real timestamp", () => {
    const clock = makeClock(123_456);
    const src = new FakeSwarmEventSource();
    const registry = new WorkerAttributionRegistry({ now: clock.now });
    const events: InlineAttributionEvent[] = [];
    attachInlineAttribution({ swarm: src, registry, now: clock.now, onEvent: (e) => events.push(e) });

    src.emitSpawned(workerRecord("w1"));
    clock.advance(10);
    src.emitKilled(workerRecord("w1"), "done");

    expect(events[0].at).toBe(123_456);
    expect(events[1].at).toBe(123_466);
  });
});
