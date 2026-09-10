import { describe, expect, it, vi } from "vitest";

import { FleetSupervisor, type FleetSupervisorEvent } from "../fleet-supervisor";
import { BackendManager } from "../manager";
import { LifecycleMachine, TransitionError, WakeExhaustedError } from "../lifecycle";
import { HandleStore, type HandleStoreFs, HANDLE_STORE_VERSION } from "../handle-store";
import { FakeBackend } from "../fake-backend";
import type { BackendDescriptor } from "../descriptor";
import type { RemoteSpec } from "../backend";

// ===========================================================================
// Shared test helpers
// ===========================================================================

/** Deterministic injectable clock: advances only when the test tells it to. */
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

function descriptor(overrides: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    name: "fake",
    kind: "fake",
    capabilities: ["shell"],
    cost: { perRunningHourUsd: 1, perHibernatedHourUsd: 0.1, perProvisionUsd: 0.05, source: "configured" },
    supportsHibernate: true,
    locality: "remote",
    ...overrides,
  };
}

function spec(workerId: string, overrides: Partial<RemoteSpec> = {}): RemoteSpec {
  return {
    workerId,
    capabilities: ["shell"],
    managerUrl: "https://manager.local",
    authToken: "tok",
    ...overrides,
  };
}

/** Register `backend` on a fresh BackendManager sharing `now`. */
function buildManager(now: () => number, backend: FakeBackend, overrides: Partial<BackendDescriptor> = {}): BackendManager {
  const mgr = new BackendManager({ now });
  mgr.register(backend, descriptor({ name: backend.name, ...overrides }));
  return mgr;
}

/** In-memory HandleStoreFs, mirroring the pattern already used by
 *  handle-store.test.ts, with a toggle to make `rename` start throwing
 *  (simulating a crash between the tmp write and the atomic rename). */
function makeMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  let renameShouldFail = false;
  const fs: HandleStoreFs = {
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (a, b) => {
      if (renameShouldFail) throw new Error("simulated crash between tmp write and rename");
      const v = files.get(a);
      if (v === undefined) throw new Error("rename source missing");
      files.set(b, v);
      files.delete(a);
    },
    mkdir: async () => {},
    unlink: async (p) => {
      files.delete(p);
    },
  };
  return { fs, files, setRenameShouldFail: (v: boolean) => (renameShouldFail = v) };
}

const PATH = "/virtual/fleet.json";

// ===========================================================================
// Construction
// ===========================================================================

describe("FleetSupervisor — construction", () => {
  it("requires opts.manager", () => {
    // @ts-expect-error deliberately omitting the required field
    expect(() => new FleetSupervisor({})).toThrow(TypeError);
  });

  it("works with no store configured: persist()/restore() are no-ops", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const events: FleetSupervisorEvent[] = [];
    const supervisor = new FleetSupervisor({ manager, now: clock.now, onEvent: (e) => events.push(e) });

    await supervisor.provision(spec("w1"));
    await expect(supervisor.persist()).resolves.toBeUndefined();
    await expect(supervisor.restore()).resolves.toBeUndefined();

    // Only "provisioned" fired — no persisted/persist-failed/restored without a store.
    expect(events.map((e) => e.type)).toEqual(["provisioned"]);
  });
});

// ===========================================================================
// provision()
// ===========================================================================

describe("FleetSupervisor.provision", () => {
  it("tracks provisioning -> running through the table, then persists; events ordered provisioned before persisted", async () => {
    const clock = makeClock(100);
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    const events: FleetSupervisorEvent[] = [];
    const supervisor = new FleetSupervisor({ manager, store, now: clock.now, onEvent: (e) => events.push(e) });

    const result = await supervisor.provision(spec("w1"));

    expect(result.handle.workerId).toBe("w1");
    expect(supervisor.lifecycle("w1")).toBe("running");
    const hist = supervisor.history("w1");
    expect(hist.map((e) => `${e.from}->${e.to}`)).toEqual(["provisioning->running"]);

    expect(events.map((e) => e.type)).toEqual(["provisioned", "persisted"]);
    expect(events[0]).toMatchObject({ type: "provisioned", workerId: "w1", backend: "fake" });

    const loaded = await store.load();
    expect(loaded?.lifecycle).toEqual({ w1: "running" });
    expect(loaded?.handles.map((h) => h.workerId)).toEqual(["w1"]);
  });

  it("a failing manager.provision propagates unchanged; nothing tracked or persisted", async () => {
    const clock = makeClock();
    // No backend registered at all -> BackendManager.select() finds nothing.
    const manager = new BackendManager({ now: clock.now });
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    const events: FleetSupervisorEvent[] = [];
    const supervisor = new FleetSupervisor({ manager, store, now: clock.now, onEvent: (e) => events.push(e) });

    await expect(supervisor.provision(spec("ghost"))).rejects.toThrow(/no backend available/i);
    expect(supervisor.lifecycle("ghost")).toBeUndefined();
    expect(events).toEqual([]);
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("re-provisioning a worker id that previously ended failed works via track()'s overwrite semantics", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    await supervisor.provision(spec("w1"));
    fb.hibernate = async () => {
      throw new Error("hibernate exploded");
    };
    await expect(supervisor.hibernate("w1")).rejects.toThrow(/hibernate exploded/);
    expect(supervisor.lifecycle("w1")).toBe("failed");

    // Re-provision the SAME workerId — a deliberate re-provision decision.
    const result = await supervisor.provision(spec("w1"));
    expect(result.handle.workerId).toBe("w1");
    expect(supervisor.lifecycle("w1")).toBe("running");
  });
});

// ===========================================================================
// hibernate()
// ===========================================================================

describe("FleetSupervisor.hibernate", () => {
  it("running -> hibernating -> hibernated through the real machine, then persists", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    const events: FleetSupervisorEvent[] = [];
    const supervisor = new FleetSupervisor({ manager, store, now: clock.now, onEvent: (e) => events.push(e) });

    await supervisor.provision(spec("w1"));
    events.length = 0;
    const handle = await supervisor.hibernate("w1");

    expect(handle?.state).toBe("hibernated");
    expect(supervisor.lifecycle("w1")).toBe("hibernated");
    expect(supervisor.history("w1").map((e) => `${e.from}->${e.to}`)).toEqual([
      "provisioning->running",
      "running->hibernating",
      "hibernating->hibernated",
    ]);
    expect(events.map((e) => e.type)).toEqual(["hibernated", "persisted"]);

    const loaded = await store.load();
    expect(loaded?.lifecycle.w1).toBe("hibernated");
  });

  it("double-hibernate is an idempotent no-op: manager.hibernate is NOT re-invoked", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    await supervisor.provision(spec("w1"));
    const managerHibernateSpy = vi.spyOn(manager, "hibernate");

    await supervisor.hibernate("w1");
    expect(managerHibernateSpy).toHaveBeenCalledTimes(1);

    const before = supervisor.history("w1").length;
    const handle = await supervisor.hibernate("w1");
    expect(managerHibernateSpy).toHaveBeenCalledTimes(1); // NOT called again
    expect(handle?.state).toBe("hibernated");
    expect(supervisor.lifecycle("w1")).toBe("hibernated");
    // A recorded idempotent no-op event was still appended.
    expect(supervisor.history("w1").length).toBe(before + 1);
    const last = supervisor.history("w1", 1)[0];
    expect(last).toMatchObject({ from: "hibernated", to: "hibernated" });
  });

  it("a throwing hibernate op moves the worker to failed and rethrows the original error unchanged", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const boom = new Error("backend refused to hibernate");
    fb.hibernate = async () => {
      throw boom;
    };
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    await supervisor.provision(spec("w1"));
    await expect(supervisor.hibernate("w1")).rejects.toBe(boom);
    expect(supervisor.lifecycle("w1")).toBe("failed");
    const hist = supervisor.history("w1");
    expect(hist[hist.length - 1]).toMatchObject({ from: "hibernating", to: "failed" });
  });

  it("hibernate() on an unknown workerId rejects with TransitionError and never calls manager.hibernate", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const managerHibernateSpy = vi.spyOn(manager, "hibernate");
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    await expect(supervisor.hibernate("ghost")).rejects.toThrow(TransitionError);
    expect(managerHibernateSpy).not.toHaveBeenCalled();
    expect(supervisor.lifecycle("ghost")).toBeUndefined();
  });

  it("hibernate() still calls persist() (and reports it) even when the op throws", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    fb.hibernate = async () => {
      throw new Error("nope");
    };
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    const events: FleetSupervisorEvent[] = [];
    const supervisor = new FleetSupervisor({ manager, store, now: clock.now, onEvent: (e) => events.push(e) });

    await supervisor.provision(spec("w1"));
    events.length = 0;
    await expect(supervisor.hibernate("w1")).rejects.toThrow(/nope/);

    expect(events.map((e) => e.type)).toEqual(["persisted"]); // no "hibernated" success event
    const loaded = await store.load();
    expect(loaded?.lifecycle.w1).toBe("failed");
  });
});

// ===========================================================================
// wake()
// ===========================================================================

describe("FleetSupervisor.wake", () => {
  it("wakes a hibernated worker on the first attempt with no retries", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    await supervisor.provision(spec("w1"));
    await supervisor.hibernate("w1");
    const handle = await supervisor.wake("w1");

    expect(handle?.state).toBe("running");
    expect(supervisor.lifecycle("w1")).toBe("running");
  });

  it("retries a flaky wake with exponential backoff (500, 1000...) via the injected sleep before succeeding", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    const machine = new LifecycleMachine({ now: clock.now, sleep, wakeBackoffMs: 500, wakeMaxAttempts: 5 });
    const supervisor = new FleetSupervisor({ manager, machine, now: clock.now });

    await supervisor.provision(spec("w1"));
    await supervisor.hibernate("w1");

    let attempts = 0;
    const originalWake = fb.wake!.bind(fb);
    fb.wake = async (handle) => {
      attempts += 1;
      if (attempts < 3) throw new Error(`wake attempt ${attempts} failed`);
      return originalWake(handle);
    };

    const handle = await supervisor.wake("w1");
    expect(handle?.state).toBe("running");
    expect(attempts).toBe(3);
    expect(sleepCalls).toEqual([500, 1000]);
    expect(supervisor.lifecycle("w1")).toBe("running");

    const wakeEvents = supervisor.history("w1").filter((e) => e.attempt !== undefined);
    expect(wakeEvents.map((e) => e.attempt)).toEqual([1, 2, 3]);
  });

  it("wake exhaustion ends state failed and rethrows WakeExhaustedError carrying every attempt's error", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const machine = new LifecycleMachine({ now: clock.now, sleep: async () => {}, wakeBackoffMs: 10, wakeMaxAttempts: 3 });
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisor = new FleetSupervisor({ manager, machine, store, now: clock.now });

    await supervisor.provision(spec("w1"));
    await supervisor.hibernate("w1");
    fb.wake = async () => {
      throw new Error("backend permanently unreachable");
    };

    let caught: unknown;
    try {
      await supervisor.wake("w1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WakeExhaustedError);
    const wakeErr = caught as WakeExhaustedError;
    expect(wakeErr.workerId).toBe("w1");
    expect(wakeErr.attempts).toBe(3);
    expect(wakeErr.errors).toHaveLength(3);
    expect(supervisor.lifecycle("w1")).toBe("failed");

    const loaded = await store.load();
    expect(loaded?.lifecycle.w1).toBe("failed");
  });

  it("a second concurrent wake() on the same worker rejects with TransitionError while the first is mid-flight", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const machine = new LifecycleMachine({ now: clock.now, sleep: async () => {} });
    const supervisor = new FleetSupervisor({ manager, machine, now: clock.now });

    await supervisor.provision(spec("w1"));
    await supervisor.hibernate("w1");

    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let wakeCalls = 0;
    fb.wake = async (handle) => {
      wakeCalls += 1;
      await gate;
      return { ...handle, state: "running" as const, endpoint: "https://woken.fake.local" };
    };

    const firstPromise = supervisor.wake("w1");
    // The first call has already synchronously transitioned to "waking" and
    // is now suspended inside the backend's wake call, awaiting the gate.
    expect(supervisor.lifecycle("w1")).toBe("waking");
    expect(wakeCalls).toBe(1);

    await expect(supervisor.wake("w1")).rejects.toThrow(TransitionError);
    expect(wakeCalls).toBe(1); // the second call's op was never invoked

    resolveGate();
    const handle = await firstPromise;
    expect(handle?.state).toBe("running");
    expect(supervisor.lifecycle("w1")).toBe("running");
  });

  it("wake on an already-running worker is idempotent: manager.wake is NOT invoked", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    await supervisor.provision(spec("w1")); // already running
    const managerWakeSpy = vi.spyOn(manager, "wake");

    const handle = await supervisor.wake("w1");
    expect(managerWakeSpy).not.toHaveBeenCalled();
    expect(handle?.state).toBe("running");
  });

  it("wake() on an unknown workerId rejects with TransitionError and never calls manager.wake", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const managerWakeSpy = vi.spyOn(manager, "wake");
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    await expect(supervisor.wake("ghost")).rejects.toThrow(TransitionError);
    expect(managerWakeSpy).not.toHaveBeenCalled();
    expect(supervisor.lifecycle("ghost")).toBeUndefined();
  });
});

// ===========================================================================
// terminate()
// ===========================================================================

describe("FleetSupervisor.terminate", () => {
  it("transitions to stopped, tears down on the backend, and stops tracking the worker", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    const events: FleetSupervisorEvent[] = [];
    const supervisor = new FleetSupervisor({ manager, store, now: clock.now, onEvent: (e) => events.push(e) });

    await supervisor.provision(spec("w1"));
    events.length = 0;
    await supervisor.terminate("w1");

    expect(supervisor.lifecycle("w1")).toBeUndefined();
    expect(manager.registry.handle("w1")).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["terminated", "persisted"]);

    const loaded = await store.load();
    expect(loaded?.handles).toEqual([]);
    expect(loaded?.lifecycle).toEqual({});
  });

  it("if manager.terminate throws, the worker is left stuck at stopped (not rolled back) and stays tracked", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    await supervisor.provision(spec("w1"));
    fb.terminate = async () => {
      throw new Error("teardown failed");
    };

    await expect(supervisor.terminate("w1")).rejects.toThrow(/teardown failed/);
    expect(supervisor.lifecycle("w1")).toBe("stopped");

    // stopped is fully terminal: a retry throws TransitionError, not a silent no-op.
    await expect(supervisor.terminate("w1")).rejects.toThrow(TransitionError);
  });

  it("terminate() on an unknown workerId rejects with TransitionError and never calls manager.terminate", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const managerTerminateSpy = vi.spyOn(manager, "terminate");
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    await expect(supervisor.terminate("ghost")).rejects.toThrow(TransitionError);
    expect(managerTerminateSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// lifecycle() / lifecycleMap() / history()
// ===========================================================================

describe("FleetSupervisor — introspection", () => {
  it("lifecycleMap() aggregates every tracked worker and drops terminated ones", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    await supervisor.provision(spec("w1"));
    await supervisor.provision(spec("w2"));
    await supervisor.hibernate("w2");

    expect(supervisor.lifecycleMap()).toEqual({ w1: "running", w2: "hibernated" });

    await supervisor.terminate("w1");
    expect(supervisor.lifecycleMap()).toEqual({ w2: "hibernated" });
  });

  it("lifecycle()/history() on an unknown workerId are well-defined: undefined / empty array, never throw", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const supervisor = new FleetSupervisor({ manager, now: clock.now });

    expect(supervisor.lifecycle("ghost")).toBeUndefined();
    expect(supervisor.history("ghost")).toEqual([]);
  });

  it("history(workerId, limit) returns only the most recent `limit` events", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const machine = new LifecycleMachine({ now: clock.now, sleep: async () => {}, wakeBackoffMs: 1, wakeMaxAttempts: 4 });
    const supervisor = new FleetSupervisor({ manager, machine, now: clock.now });

    await supervisor.provision(spec("w1"));
    await supervisor.hibernate("w1");
    let attempts = 0;
    const originalWake = fb.wake!.bind(fb);
    fb.wake = async (handle) => {
      attempts += 1;
      if (attempts < 3) throw new Error("flaky");
      return originalWake(handle);
    };
    await supervisor.wake("w1");

    const full = supervisor.history("w1");
    expect(full.length).toBeGreaterThan(2);
    const last2 = supervisor.history("w1", 2);
    expect(last2).toEqual(full.slice(full.length - 2));
  });
});

// ===========================================================================
// persist()
// ===========================================================================

describe("FleetSupervisor.persist", () => {
  it("is a silent no-op when no store is configured", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const events: FleetSupervisorEvent[] = [];
    const supervisor = new FleetSupervisor({ manager, now: clock.now, onEvent: (e) => events.push(e) });
    await supervisor.persist();
    expect(events).toEqual([]);
  });

  it("a rename failure (mid-flight crash) never throws out of persist(); emits persist-failed; prior file intact", async () => {
    const clock = makeClock(1000);
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const { fs, files, setRenameShouldFail } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    const events: FleetSupervisorEvent[] = [];
    const supervisor = new FleetSupervisor({ manager, store, now: clock.now, onEvent: (e) => events.push(e) });

    await supervisor.provision(spec("w1")); // good baseline persisted
    const baseline = files.get(PATH);
    expect(baseline).toBeDefined();

    setRenameShouldFail(true);
    events.length = 0;
    await expect(supervisor.hibernate("w1")).resolves.not.toThrow();

    expect(events.map((e) => e.type)).toEqual(["hibernated", "persist-failed"]);
    const failEvent = events.find((e) => e.type === "persist-failed")!;
    expect(failEvent.detail?.error).toMatch(/simulated crash/);

    // The on-disk file is untouched — byte-identical to the pre-hibernate
    // baseline, since the flaky rename never landed.
    expect(files.get(PATH)).toBe(baseline);
    expect(JSON.parse(baseline!).lifecycle.w1).toBe("running"); // pre-hibernate state
  });

  it("persist() writes the lifecycle map faithfully even mid-flight in a transient state", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const machine = new LifecycleMachine({ now: clock.now, sleep: async () => {} });
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisor = new FleetSupervisor({ manager, machine, store, now: clock.now });

    await supervisor.provision(spec("w1"));
    await supervisor.hibernate("w1");

    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    fb.wake = async (handle) => {
      await gate;
      return { ...handle, state: "running" as const };
    };

    const wakePromise = supervisor.wake("w1");
    expect(supervisor.lifecycle("w1")).toBe("waking");

    // A concurrent persist() call while the wake is still in flight must
    // durably capture the transient "waking" state — HandleStore validates
    // every LifecycleState, transient ones included.
    await supervisor.persist();
    const loadedMidFlight = await store.load();
    expect(loadedMidFlight?.lifecycle.w1).toBe("waking");

    resolveGate();
    await wakePromise;
    const loadedFinal = await store.load();
    expect(loadedFinal?.lifecycle.w1).toBe("running");
  });
});

// ===========================================================================
// restore()
// ===========================================================================

describe("FleetSupervisor.restore", () => {
  it("returns undefined when no store is configured", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const supervisor = new FleetSupervisor({ manager, now: clock.now });
    await expect(supervisor.restore()).resolves.toBeUndefined();
  });

  it("returns undefined when a store is configured but nothing was ever saved", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisor = new FleetSupervisor({ manager, store, now: clock.now });
    await expect(supervisor.restore()).resolves.toBeUndefined();
  });

  it("save -> load -> reconcile -> track round-trips the SAME lifecycleMap across a simulated process restart", async () => {
    const clock = makeClock();
    // The backend object models the still-alive remote infra surviving the
    // "restart" — only the in-process manager/registry/machine are fresh.
    const fb = new FakeBackend({ name: "alpha", now: clock.now });
    const { fs } = makeMemoryFs();

    const managerA = buildManager(clock.now, fb);
    const storeA = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisorA = new FleetSupervisor({ manager: managerA, store: storeA, now: clock.now });
    await supervisorA.provision(spec("w1"));
    await supervisorA.hibernate("w1");
    const mapBefore = supervisorA.lifecycleMap();

    // "Restart": brand new manager (fresh registry), brand new machine, same
    // backend object, same on-disk store.
    const managerB = buildManager(clock.now, fb);
    const storeB = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisorB = new FleetSupervisor({ manager: managerB, store: storeB, now: clock.now });

    const report = await supervisorB.restore();
    expect(report?.restored.map((h) => h.workerId)).toEqual(["w1"]);
    expect(report?.corrected).toEqual([]);
    expect(report?.dropped).toEqual([]);
    expect(supervisorB.lifecycleMap()).toEqual(mapBefore);
    expect(supervisorB.lifecycle("w1")).toBe("hibernated");
  });

  it("corrects probed drift: persisted 'running' but the live backend now reports 'hibernated'", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "alpha", now: clock.now });
    const { fs } = makeMemoryFs();

    const managerA = buildManager(clock.now, fb);
    const storeA = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisorA = new FleetSupervisor({ manager: managerA, store: storeA, now: clock.now });
    const result = await supervisorA.provision(spec("w1")); // persisted lifecycle: running

    // Externally hibernate the backend directly, bypassing the supervisor
    // entirely, so the LAST persisted file still says "running".
    await fb.hibernate!(result.handle);

    const managerB = buildManager(clock.now, fb);
    const storeB = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisorB = new FleetSupervisor({ manager: managerB, store: storeB, now: clock.now });

    const report = await supervisorB.restore();
    expect(report?.corrected).toEqual([{ workerId: "w1", stored: "running", probed: "hibernated" }]);
    // Probed truth wins — NOT the stale persisted "running".
    expect(supervisorB.lifecycle("w1")).toBe("hibernated");
  });

  it("drops handles referencing a backend unknown to the restoring process", async () => {
    const clock = makeClock();
    const fbTemp = new FakeBackend({ name: "temp", now: clock.now });
    const { fs } = makeMemoryFs();

    const managerA = buildManager(clock.now, fbTemp);
    const storeA = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisorA = new FleetSupervisor({ manager: managerA, store: storeA, now: clock.now });
    await supervisorA.provision(spec("w-temp"));

    // Restoring process never registers "temp" at all (e.g. that backend's
    // credentials/config were removed from this deployment).
    const managerB = new BackendManager({ now: clock.now });
    const storeB = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisorB = new FleetSupervisor({ manager: managerB, store: storeB, now: clock.now });

    const report = await supervisorB.restore();
    expect(report?.dropped).toEqual([{ workerId: "w-temp", reason: "unknown backend: temp" }]);
    expect(supervisorB.lifecycle("w-temp")).toBeUndefined();
    expect(supervisorB.lifecycleMap()).toEqual({});
  });

  it("downgrades a persisted transient 'hibernating'/'waking' lifecycle entry to 'failed' regardless of the probe", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "alpha", now: clock.now });
    const { fs } = makeMemoryFs();

    // Craft the persisted fleet directly via the raw HandleStore API — this
    // is exactly the artifact a process crash mid-hibernate/mid-wake would
    // leave behind, regardless of how it was produced.
    const registryStore = new HandleStore({ path: PATH, fs, now: clock.now });
    const provisioned = await fb.provision({ workerId: "w1", capabilities: [], managerUrl: "x", authToken: "t" });
    const provisioned2 = await fb.provision({ workerId: "w2", capabilities: [], managerUrl: "x", authToken: "t" });
    await registryStore.save(
      [
        { ...provisioned, state: "running" },
        { ...provisioned2, state: "hibernated" },
      ],
      { w1: "hibernating", w2: "waking" },
    );

    const managerB = buildManager(clock.now, fb);
    const storeB = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisorB = new FleetSupervisor({ manager: managerB, store: storeB, now: clock.now });

    const report = await supervisorB.restore();
    expect(report?.dropped).toEqual([]);
    expect(supervisorB.lifecycle("w1")).toBe("failed");
    expect(supervisorB.lifecycle("w2")).toBe("failed");
  });

  it("emits a 'restored' event with restored/corrected/dropped counts", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "alpha", now: clock.now });
    const { fs } = makeMemoryFs();

    const managerA = buildManager(clock.now, fb);
    const storeA = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisorA = new FleetSupervisor({ manager: managerA, store: storeA, now: clock.now });
    await supervisorA.provision(spec("w1"));

    const managerB = buildManager(clock.now, fb);
    const storeB = new HandleStore({ path: PATH, fs, now: clock.now });
    const events: FleetSupervisorEvent[] = [];
    const supervisorB = new FleetSupervisor({ manager: managerB, store: storeB, now: clock.now, onEvent: (e) => events.push(e) });

    await supervisorB.restore();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "restored", detail: { restored: 1, corrected: 0, dropped: 0 } });
  });
});

// ===========================================================================
// Sanity: HANDLE_STORE_VERSION is imported and used correctly (guards
// against a future HandleStore format bump silently breaking this suite).
// ===========================================================================

describe("FleetSupervisor — persisted envelope sanity", () => {
  it("persist() writes the current HANDLE_STORE_VERSION", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const manager = buildManager(clock.now, fb);
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    const supervisor = new FleetSupervisor({ manager, store, now: clock.now });

    await supervisor.provision(spec("w1"));
    const loaded = await store.load();
    expect(loaded?.version).toBe(HANDLE_STORE_VERSION);
  });
});
