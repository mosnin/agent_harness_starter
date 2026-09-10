import { describe, expect, it, vi } from "vitest";

import {
  HandleAdoptionService,
  restoreWithAdoption,
  type AdoptionEvent,
  type RegistryAdoptionPort,
} from "../adoption";
import { RemoteBackendRegistry, type RemoteHandle, type RemoteState } from "../backend";
import { FakeBackend } from "../fake-backend";
import { LifecycleMachine, type LifecycleState } from "../lifecycle";
import { HandleStore, type HandleStoreFs, HANDLE_STORE_VERSION } from "../handle-store";

// ===========================================================================
// Shared test helpers
// ===========================================================================

function handle(overrides: Partial<RemoteHandle> = {}): RemoteHandle {
  return {
    workerId: "w1",
    backend: "alpha",
    nativeId: "n1",
    state: "running",
    startedAt: 1000,
    ...overrides,
  };
}

/**
 * The TEST POLICY's "thin documented test shim": `get`/`handle`/`list`
 * delegate straight through to a REAL `RemoteBackendRegistry`; only `adopt`
 * needs a body at all, since the real `RemoteBackendRegistry.adopt` lands at
 * central integration (this module never edits `backend.ts`). Implements the
 * exact locked insert semantics documented on `RegistryAdoptionPort.adopt`:
 * insert-by-workerId, duplicate workerId throws.
 */
function makeAdoptionPort(registry: RemoteBackendRegistry): RegistryAdoptionPort {
  const shadow = new Map<string, RemoteHandle>();
  return {
    adopt(h: RemoteHandle): void {
      if (shadow.has(h.workerId) || registry.handle(h.workerId)) {
        throw new Error(`duplicate workerId: ${h.workerId}`);
      }
      shadow.set(h.workerId, h);
    },
    handle(workerId: string): RemoteHandle | undefined {
      return registry.handle(workerId) ?? shadow.get(workerId);
    },
    get(name: string) {
      return registry.get(name);
    },
    list(): RemoteHandle[] {
      return [...registry.list(), ...shadow.values()];
    },
  };
}

/** Prime a REAL FakeBackend's internal state for `nativeId` to `"running"`
 *  by actually provisioning through it directly (bypassing the registry
 *  entirely — mirrors fleet-supervisor.test.ts's "backend object models the
 *  still-alive remote infra surviving the restart" pattern). Returns the
 *  nativeId so callers can build their own candidate handle referencing it. */
async function primeRunning(backend: FakeBackend, seedWorkerId: string): Promise<string> {
  const h = await backend.provision({ workerId: seedWorkerId, capabilities: [], managerUrl: "x", authToken: "t" });
  return h.nativeId;
}

function makeMemoryFs(initial: Record<string, string> = {}): { fs: HandleStoreFs; files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
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
  return { fs, files };
}

const PATH = "/virtual/fleet.json";

// ===========================================================================
// Construction
// ===========================================================================

describe("HandleAdoptionService — construction", () => {
  it("requires opts.registry", () => {
    // @ts-expect-error deliberately omitting the required field
    expect(() => new HandleAdoptionService({})).toThrow(TypeError);
  });
});

// ===========================================================================
// adoptHandles — per-candidate classification, real registry + FakeBackend
// ===========================================================================

describe("HandleAdoptionService.adoptHandles — basic classification", () => {
  it("adopts a healthy handle into an empty registry", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const candidate = handle({ workerId: "w1", nativeId, state: "running" });
    const report = await service.adoptHandles([candidate], {});

    expect(report.adopted).toEqual([candidate]);
    expect(report.corrected).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.dropped).toEqual([]);
    expect(port.handle("w1")).toEqual(candidate);
  });

  it("corrects drift: stored 'hibernated' but the live backend actually reports 'running'", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const candidate = handle({ workerId: "w1", nativeId, state: "hibernated" });
    const report = await service.adoptHandles([candidate], {});

    expect(report.adopted).toEqual([{ ...candidate, state: "running" }]);
    expect(report.corrected).toEqual([{ workerId: "w1", stored: "hibernated", probed: "running" }]);
  });

  it("never adopts a probe result of 'stopped'", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    const provisioned = { workerId: "seed", backend: "alpha", nativeId, state: "running" as const, startedAt: 1 };
    await backend.terminate(provisioned); // -> "stopped"
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const candidate = handle({ workerId: "w1", nativeId, state: "running" });
    const report = await service.adoptHandles([candidate], {});

    expect(report.adopted).toEqual([]);
    expect(report.dropped).toEqual([{ workerId: "w1", reason: expect.stringMatching(/never adopted/) }]);
  });

  it("never adopts a probe result of 'failed' (default status for a never-provisioned nativeId)", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const candidate = handle({ workerId: "w1", nativeId: "never-provisioned", state: "running" });
    const report = await service.adoptHandles([candidate], {});

    expect(report.adopted).toEqual([]);
    expect(report.dropped).toEqual([{ workerId: "w1", reason: expect.stringMatching(/never adopted/) }]);
  });

  it("drops a handle referencing an unknown backend, isolated from the rest of the batch", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const good = handle({ workerId: "w-good", nativeId, state: "running" });
    const ghost = handle({ workerId: "w-ghost", backend: "no-such-backend", nativeId: "x", state: "running" });
    const report = await service.adoptHandles([ghost, good], {});

    expect(report.dropped).toEqual([{ workerId: "w-ghost", reason: "unknown backend: no-such-backend" }]);
    expect(report.adopted.map((h) => h.workerId)).toEqual(["w-good"]);
  });

  it("drops a handle whose status probe throws, isolated from the rest of the batch", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    vi.spyOn(backend, "status").mockImplementation(async (h) => {
      if (h.workerId === "w-boom") throw new Error("unreachable");
      return "running";
    });
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const boom = handle({ workerId: "w-boom", nativeId: "n-boom" });
    const good = handle({ workerId: "w-good", nativeId: "n-good" });
    const report = await service.adoptHandles([boom, good], {});

    expect(report.dropped).toEqual([{ workerId: "w-boom", reason: expect.stringMatching(/unreachable/) }]);
    expect(report.adopted.map((h) => h.workerId)).toEqual(["w-good"]);
  });

  it("drops a structurally malformed entry, isolated from the rest of the batch", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const good = handle({ workerId: "w-good", nativeId, state: "running" });
    const malformed = "not-a-handle" as unknown as RemoteHandle;
    const missingFields = { workerId: "w-missing" } as unknown as RemoteHandle;
    const report = await service.adoptHandles([malformed, missingFields, good], {});

    expect(report.dropped).toEqual([
      { workerId: "<unknown>", reason: "malformed handle entry" },
      { workerId: "w-missing", reason: "malformed handle entry" },
    ]);
    expect(report.adopted.map((h) => h.workerId)).toEqual(["w-good"]);
  });

  it("a workerId already live in the registry is a conflict — never overwritten", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const provisionResult = await registry.provision(
      { workerId: "w1", capabilities: [], managerUrl: "x", authToken: "t" },
      "alpha",
    );
    // A distinct, independently-live nativeId so the candidate's own probe
    // resolves to "running" (adoptable) — isolating the conflict decision
    // from the separate terminal-probe drop path.
    const otherNativeId = await primeRunning(backend, "other-seed");
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const candidate = handle({ workerId: "w1", backend: "alpha", nativeId: otherNativeId, state: "running" });
    const report = await service.adoptHandles([candidate], {});

    expect(report.adopted).toEqual([]);
    expect(report.conflicts).toEqual([
      { workerId: "w1", reason: expect.stringContaining("already live in the registry (backend=alpha)") },
    ]);
    // Untouched: still the original live handle, not the candidate.
    expect(port.handle("w1")).toEqual(provisionResult.handle);
  });

  it("duplicate workerIds inside the same batch: first adopts, second is a conflict", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId1 = await primeRunning(backend, "seed1");
    const nativeId2 = await primeRunning(backend, "seed2");
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const first = handle({ workerId: "dup", nativeId: nativeId1, state: "running" });
    const second = handle({ workerId: "dup", nativeId: nativeId2, state: "running" });
    const report = await service.adoptHandles([first, second], {});

    expect(report.adopted).toEqual([first]);
    expect(report.conflicts).toEqual([{ workerId: "dup", reason: expect.stringMatching(/already live/) }]);
  });

  it("registry.adopt() itself throwing (e.g. a lost race) drops that handle instead of propagating", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    // A port that lies about liveness (so the service's own conflict check
    // never catches it) but whose adopt() rejects duplicates anyway — the
    // defensive backstop path documented on RegistryAdoptionPort.adopt.
    const port: RegistryAdoptionPort = {
      adopt: () => {
        throw new Error("simulated race: workerId already inserted by another adopter");
      },
      handle: () => undefined,
      get: (name) => registry.get(name),
      list: () => registry.list(),
    };
    const service = new HandleAdoptionService({ registry: port });

    const candidate = handle({ workerId: "w1", nativeId, state: "running" });
    const report = await service.adoptHandles([candidate], {});

    expect(report.adopted).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.dropped).toEqual([
      { workerId: "w1", reason: expect.stringMatching(/registry\.adopt rejected.*simulated race/) },
    ]);
  });

  it("a hibernate-incapable backend still adopts fine at its probed state, without inventing hibernate/wake", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "ssh-like", supportsHibernate: false });
    registry.register(backend);
    expect(backend.hibernate).toBeUndefined();
    expect(backend.wake).toBeUndefined();
    const nativeId = await primeRunning(backend, "seed");
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const candidate = handle({ workerId: "w1", backend: "ssh-like", nativeId, state: "running" });
    const report = await service.adoptHandles([candidate], {});

    expect(report.adopted).toEqual([candidate]);
    // Adoption never touches the backend's capabilities — still absent.
    expect(registry.get("ssh-like")!.hibernate).toBeUndefined();
    expect(registry.get("ssh-like")!.wake).toBeUndefined();
  });

  it("an empty batch adopts to an all-empty report", async () => {
    const registry = new RemoteBackendRegistry();
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });
    const report = await service.adoptHandles([], {});
    expect(report).toEqual({ adopted: [], corrected: [], conflicts: [], dropped: [] });
  });
});

// ===========================================================================
// Exhaustive probed x stored state matrix
// ===========================================================================

describe("HandleAdoptionService.adoptHandles — exhaustive probed x stored state matrix", () => {
  const STATES: RemoteState[] = ["provisioning", "running", "hibernated", "stopped", "failed"];
  const ADOPTABLE: ReadonlySet<RemoteState> = new Set(["provisioning", "running", "hibernated"]);

  const combos: Array<[RemoteState, RemoteState]> = STATES.flatMap((probed) =>
    STATES.map((stored): [RemoteState, RemoteState] => [probed, stored]),
  );

  it.each(combos)("probed=%s stored=%s", async (probed, stored) => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    vi.spyOn(backend, "status").mockResolvedValue(probed);
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const candidate = handle({ workerId: "w1", nativeId: "n1", state: stored });
    const report = await service.adoptHandles([candidate], {});

    // Partition invariant holds for every combination.
    expect(report.adopted.length + report.conflicts.length + report.dropped.length).toBe(1);

    if (ADOPTABLE.has(probed)) {
      expect(report.adopted).toEqual([{ ...candidate, state: probed }]);
      expect(report.dropped).toEqual([]);
      if (probed !== stored) {
        expect(report.corrected).toEqual([{ workerId: "w1", stored, probed }]);
      } else {
        expect(report.corrected).toEqual([]);
      }
    } else {
      expect(report.adopted).toEqual([]);
      expect(report.corrected).toEqual([]);
      expect(report.dropped).toEqual([
        { workerId: "w1", reason: expect.stringMatching(/never adopted/) },
      ]);
    }
  });
});

// ===========================================================================
// Event stream
// ===========================================================================

describe("HandleAdoptionService.adoptHandles — event stream", () => {
  it("emits exactly one event per candidate, in processing order, with correct types", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const goodNative = await primeRunning(backend, "seed-good");
    const stoppedNative = await primeRunning(backend, "seed-stop");
    await backend.terminate({ workerId: "seed-stop", backend: "alpha", nativeId: stoppedNative, state: "running", startedAt: 1 });
    const liveResult = await registry.provision({ workerId: "w-live", capabilities: [], managerUrl: "x", authToken: "t" }, "alpha");

    const port = makeAdoptionPort(registry);
    const events: AdoptionEvent[] = [];
    let t = 100;
    const service = new HandleAdoptionService({ registry: port, now: () => t++, onEvent: (e) => events.push(e) });

    const handles = [
      handle({ workerId: "w-adopted", nativeId: goodNative, state: "running" }), // adopted
      handle({ workerId: "w-live", backend: "alpha", nativeId: liveResult.handle.nativeId, state: "running" }), // conflict
      handle({ workerId: "w-terminal", nativeId: stoppedNative, state: "running" }), // adopt-skipped (stopped)
      handle({ workerId: "w-ghost", backend: "no-such", nativeId: "x", state: "running" }), // adopt-failed
    ];

    const report = await service.adoptHandles(handles, {});

    expect(events).toHaveLength(handles.length);
    expect(events.map((e) => e.type)).toEqual(["adopted", "adopt-skipped", "adopt-skipped", "adopt-failed"]);
    expect(events.map((e) => e.workerId)).toEqual(["w-adopted", "w-live", "w-terminal", "w-ghost"]);
    expect(events.every((e) => typeof e.at === "number")).toBe(true);
    expect(events[0].at).toBeLessThan(events[3].at); // monotonic per the injected clock

    expect(report.adopted.map((h) => h.workerId)).toEqual(["w-adopted"]);
    expect(report.conflicts.map((c) => c.workerId)).toEqual(["w-live"]);
    expect(report.dropped.map((d) => d.workerId).sort()).toEqual(["w-ghost", "w-terminal"]);
  });

  it("'adopted' event detail carries probed/stored/persistedLifecycle", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    const port = makeAdoptionPort(registry);
    const events: AdoptionEvent[] = [];
    const service = new HandleAdoptionService({ registry: port, now: () => 42, onEvent: (e) => events.push(e) });

    const candidate = handle({ workerId: "w1", nativeId, state: "hibernated" });
    await service.adoptHandles([candidate], { w1: "hibernated" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "adopted",
      at: 42,
      workerId: "w1",
      backend: "alpha",
      detail: { probed: "running", stored: "hibernated", persistedLifecycle: "hibernated" },
    });
  });

  it("guards the persistedLifecycle lookup against a crafted workerId of '__proto__' reading through the prototype chain", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    const port = makeAdoptionPort(registry);
    const events: AdoptionEvent[] = [];
    const service = new HandleAdoptionService({ registry: port, onEvent: (e) => events.push(e) });

    const candidate = handle({ workerId: "__proto__", nativeId, state: "running" });
    // A genuinely empty plain object: naive `lifecycle["__proto__"]` would
    // return Object.prototype itself (truthy, typeof "object") rather than
    // undefined, since there is no guard-free way to distinguish "absent"
    // from "reading the prototype getter" on a plain object literal.
    const report = await service.adoptHandles([candidate], {});

    expect(report.adopted).toEqual([candidate]);
    expect(events[0].detail?.persistedLifecycle).toBeUndefined();
    // Sanity: nothing here ever actually mutated Object.prototype.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

// ===========================================================================
// Report totals partition the input
// ===========================================================================

describe("HandleAdoptionService.adoptHandles — report totals always partition the input", () => {
  it("adopted + conflicts + dropped == handles.length, and corrected is a subset of adopted", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const okNative = await primeRunning(backend, "seed-ok");
    const driftNative = await primeRunning(backend, "seed-drift");
    const liveResult = await registry.provision({ workerId: "w-live", capabilities: [], managerUrl: "x", authToken: "t" }, "alpha");

    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    const handles = [
      handle({ workerId: "w-ok", nativeId: okNative, state: "running" }),
      handle({ workerId: "w-drift", nativeId: driftNative, state: "hibernated" }), // corrected
      handle({ workerId: "w-live", backend: "alpha", nativeId: liveResult.handle.nativeId, state: "running" }), // conflict
      handle({ workerId: "w-ghost", backend: "no-such", nativeId: "x", state: "running" }), // dropped
      handle({ workerId: "w-terminal", nativeId: "never-provisioned", state: "running" }), // dropped (probed failed)
    ];

    const report = await service.adoptHandles(handles, {});

    expect(report.adopted.length + report.conflicts.length + report.dropped.length).toBe(handles.length);
    for (const c of report.corrected) {
      expect(report.adopted.some((h) => h.workerId === c.workerId)).toBe(true);
    }
    expect(report.corrected.map((c) => c.workerId)).toEqual(["w-drift"]);
  });
});

// ===========================================================================
// adoptFromStore — real HandleStore integration
// ===========================================================================

describe("HandleAdoptionService.adoptFromStore — real HandleStore", () => {
  it("returns undefined when nothing was ever persisted", async () => {
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: () => 1 });
    const registry = new RemoteBackendRegistry();
    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });

    await expect(service.adoptFromStore(store)).resolves.toBeUndefined();
  });

  it("loads a saved fleet and adopts every trustworthy handle", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId1 = await primeRunning(backend, "seed1");
    const nativeId2 = await primeRunning(backend, "seed2");

    const { fs } = makeMemoryFs();
    const savingStore = new HandleStore({ path: PATH, fs, now: () => 5 });
    await savingStore.save(
      [
        handle({ workerId: "w1", nativeId: nativeId1, state: "running" }),
        handle({ workerId: "w2", nativeId: nativeId2, state: "hibernated" }), // will correct to running
      ],
      { w1: "running", w2: "hibernated" },
    );

    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });
    const loadingStore = new HandleStore({ path: PATH, fs, now: () => 6 });
    const report = await service.adoptFromStore(loadingStore);

    expect(report).toBeDefined();
    expect(report!.adopted.map((h) => h.workerId).sort()).toEqual(["w1", "w2"]);
    expect(report!.corrected).toEqual([{ workerId: "w2", stored: "hibernated", probed: "running" }]);
    expect(port.handle("w1")).toBeDefined();
    expect(port.handle("w2")).toBeDefined();
  });

  it("crash realism: a handle for a backend no longer registered in this process is dropped, not fatal", async () => {
    const registry = new RemoteBackendRegistry(); // "gone" backend never registered here
    const { fs } = makeMemoryFs();
    const savingStore = new HandleStore({ path: PATH, fs, now: () => 1 });
    await savingStore.save(
      [handle({ workerId: "w-gone", backend: "gone", nativeId: "n-gone", state: "running" })],
      { "w-gone": "running" },
    );

    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });
    const loadingStore = new HandleStore({ path: PATH, fs, now: () => 2 });
    const report = await service.adoptFromStore(loadingStore);

    expect(report!.adopted).toEqual([]);
    expect(report!.dropped).toEqual([{ workerId: "w-gone", reason: "unknown backend: gone" }]);
  });

  it("crash realism: duplicate workerIds inside the persisted file itself — first adopts, second conflicts", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId1 = await primeRunning(backend, "seed1");
    const nativeId2 = await primeRunning(backend, "seed2");

    // Hand-craft the raw JSON directly (bypassing save(), which can never
    // itself produce duplicates since it snapshots a Map) — this is exactly
    // the artifact a hand-edited or corrupted fleet.json could contain.
    const raw = JSON.stringify({
      version: HANDLE_STORE_VERSION,
      savedAt: 1,
      handles: [
        handle({ workerId: "dup", nativeId: nativeId1, state: "running" }),
        handle({ workerId: "dup", nativeId: nativeId2, state: "running" }),
      ],
      lifecycle: {},
    });
    const { fs } = makeMemoryFs({ [PATH]: raw });

    const port = makeAdoptionPort(registry);
    const service = new HandleAdoptionService({ registry: port });
    const store = new HandleStore({ path: PATH, fs, now: () => 2 });
    const report = await service.adoptFromStore(store);

    expect(report!.adopted.map((h) => h.nativeId)).toEqual([nativeId1]);
    expect(report!.conflicts).toEqual([{ workerId: "dup", reason: expect.stringMatching(/already live/) }]);
  });

  it("adversarial: a prototype-pollution-style '__proto__' key in the raw lifecycle map is scrubbed by HandleStore before it ever reaches adoption", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");

    const raw = JSON.stringify({
      version: HANDLE_STORE_VERSION,
      savedAt: 1,
      handles: [handle({ workerId: "w1", nativeId, state: "running" })],
      lifecycle: { w1: "running", __proto__: "hibernating" },
    });
    const { fs } = makeMemoryFs({ [PATH]: raw });

    const port = makeAdoptionPort(registry);
    const events: AdoptionEvent[] = [];
    const service = new HandleAdoptionService({ registry: port, onEvent: (e) => events.push(e) });
    const store = new HandleStore({ path: PATH, fs, now: () => 2 });

    // HandleStore.load() itself must never surface a polluting key as an
    // own enumerable property, and must never actually mutate the loaded
    // object's real prototype either.
    const fleet = await store.load();
    expect(Object.prototype.hasOwnProperty.call(fleet!.lifecycle, "__proto__")).toBe(false);
    expect(fleet!.lifecycle).toEqual({ w1: "running" });
    expect(Object.getPrototypeOf(fleet!.lifecycle)).toBe(Object.prototype);

    const report = await service.adoptFromStore(store);
    expect(report!.adopted.map((h) => h.workerId)).toEqual(["w1"]);
    expect(events[0].detail?.persistedLifecycle).toBe("running");
    expect(Object.getPrototypeOf({})).toBe(Object.prototype); // never polluted
  });
});

// ===========================================================================
// restoreWithAdoption
// ===========================================================================

describe("restoreWithAdoption", () => {
  it("returns undefined when nothing was ever persisted", async () => {
    const { fs } = makeMemoryFs();
    const store = new HandleStore({ path: PATH, fs, now: () => 1 });
    const registry = new RemoteBackendRegistry();
    const port = makeAdoptionPort(registry);

    await expect(restoreWithAdoption({ store, registry: port })).resolves.toBeUndefined();
  });

  it("throws synchronously for a missing store/registry (programmer error, not a runtime data problem)", async () => {
    const registry = new RemoteBackendRegistry();
    const port = makeAdoptionPort(registry);
    // @ts-expect-error deliberately omitting the required store
    await expect(restoreWithAdoption({ registry: port })).rejects.toThrow(TypeError);
  });

  it("adopts and returns both a reconcile-shaped probe report and an adoption report, computed from the SAME probes", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");

    const { fs } = makeMemoryFs();
    const savingStore = new HandleStore({ path: PATH, fs, now: () => 1 });
    await savingStore.save([handle({ workerId: "w1", nativeId, state: "hibernated" })], { w1: "hibernated" });

    const port = makeAdoptionPort(registry);
    const store = new HandleStore({ path: PATH, fs, now: () => 2 });
    const result = await restoreWithAdoption({ store, registry: port });

    expect(result).toBeDefined();
    expect(result!.reconcile.restored).toEqual([{ ...handle({ workerId: "w1", nativeId }), state: "running" }]);
    expect(result!.reconcile.corrected).toEqual([{ workerId: "w1", stored: "hibernated", probed: "running" }]);
    expect(result!.reconcile.dropped).toEqual([]);
    expect(result!.adoption.adopted).toEqual([{ ...handle({ workerId: "w1", nativeId }), state: "running" }]);
    expect(result!.adoption.corrected).toEqual(result!.reconcile.corrected);
  });

  it("reconcile.restored includes a conflicted handle even though adoption.conflicts (not adopted) has it", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    const liveResult = await registry.provision({ workerId: "w1", capabilities: [], managerUrl: "x", authToken: "t" }, "alpha");

    const { fs } = makeMemoryFs();
    const savingStore = new HandleStore({ path: PATH, fs, now: () => 1 });
    await savingStore.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    const port = makeAdoptionPort(registry);
    const store = new HandleStore({ path: PATH, fs, now: () => 2 });
    const result = await restoreWithAdoption({ store, registry: port });

    expect(result!.reconcile.restored.map((h) => h.workerId)).toEqual(["w1"]);
    expect(result!.adoption.adopted).toEqual([]);
    expect(result!.adoption.conflicts).toEqual([
      { workerId: "w1", reason: expect.stringMatching(/already live/) },
    ]);
    // The live handle from before restore is what remains authoritative.
    expect(port.handle("w1")).toEqual(liveResult.handle);
  });

  it("reconcile.restored includes a terminal-probe handle even though adoption drops it", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    await backend.terminate({ workerId: "seed", backend: "alpha", nativeId, state: "running", startedAt: 1 });

    const { fs } = makeMemoryFs();
    const savingStore = new HandleStore({ path: PATH, fs, now: () => 1 });
    await savingStore.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    const port = makeAdoptionPort(registry);
    const store = new HandleStore({ path: PATH, fs, now: () => 2 });
    const result = await restoreWithAdoption({ store, registry: port });

    expect(result!.reconcile.restored.map((h) => h.state)).toEqual(["stopped"]);
    expect(result!.adoption.adopted).toEqual([]);
    expect(result!.adoption.dropped).toEqual([
      { workerId: "w1", reason: expect.stringMatching(/never adopted/) },
    ]);
  });

  it("no machine supplied: report is still complete, nothing throws for absence of tracking", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");

    const { fs } = makeMemoryFs();
    const savingStore = new HandleStore({ path: PATH, fs, now: () => 1 });
    await savingStore.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    const port = makeAdoptionPort(registry);
    const store = new HandleStore({ path: PATH, fs, now: () => 2 });
    const result = await restoreWithAdoption({ store, registry: port });
    expect(result!.adoption.adopted).toHaveLength(1);
  });
});

// ===========================================================================
// restoreWithAdoption — lifecycle-machine tracking + transient downgrade
// ===========================================================================

describe("restoreWithAdoption — machine tracking mirrors FleetSupervisor's transient-state downgrade", () => {
  async function setupAdoptedRunning(lifecycleEntry: Record<string, LifecycleState>) {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");

    const { fs } = makeMemoryFs();
    const savingStore = new HandleStore({ path: PATH, fs, now: () => 1 });
    await savingStore.save([handle({ workerId: "w1", nativeId, state: "running" })], lifecycleEntry);

    const port = makeAdoptionPort(registry);
    const store = new HandleStore({ path: PATH, fs, now: () => 2 });
    return { port, store };
  }

  const cases: Array<{ label: string; lifecycle: Record<string, LifecycleState>; expected: LifecycleState }> = [
    { label: "absent lifecycle entry -> tracked at probed state", lifecycle: {}, expected: "running" },
    { label: "lifecycle entry 'running' -> tracked at probed state", lifecycle: { w1: "running" }, expected: "running" },
    {
      label: "lifecycle entry 'hibernated' (stale) -> tracked at PROBED state, not the stale entry",
      lifecycle: { w1: "hibernated" },
      expected: "running",
    },
    { label: "lifecycle entry 'hibernating' -> downgraded to 'failed'", lifecycle: { w1: "hibernating" }, expected: "failed" },
    { label: "lifecycle entry 'waking' -> downgraded to 'failed'", lifecycle: { w1: "waking" }, expected: "failed" },
    { label: "lifecycle entry 'failed' (not itself transient) -> tracked at probed state", lifecycle: { w1: "failed" }, expected: "running" },
    {
      label: "lifecycle entry present only for an unrelated/unknown workerId -> irrelevant, tracked at probed state",
      lifecycle: { ghost: "hibernating" },
      expected: "running",
    },
  ];

  it.each(cases)("$label", async ({ lifecycle, expected }) => {
    const { port, store } = await setupAdoptedRunning(lifecycle);
    const machine = new LifecycleMachine({ now: () => 10 });
    const result = await restoreWithAdoption({ store, registry: port, machine });

    expect(result!.adoption.adopted).toHaveLength(1);
    expect(machine.state("w1")).toBe(expected);
  });

  it("a conflicted (not adopted) handle is never tracked in the machine at all", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    await registry.provision({ workerId: "w1", capabilities: [], managerUrl: "x", authToken: "t" }, "alpha");

    const { fs } = makeMemoryFs();
    const savingStore = new HandleStore({ path: PATH, fs, now: () => 1 });
    await savingStore.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    const port = makeAdoptionPort(registry);
    const store = new HandleStore({ path: PATH, fs, now: () => 2 });
    const machine = new LifecycleMachine({ now: () => 10 });
    const result = await restoreWithAdoption({ store, registry: port, machine });

    expect(result!.adoption.conflicts).toHaveLength(1);
    expect(machine.state("w1")).toBeUndefined();
  });

  it("a dropped (terminal-probe) handle is never tracked in the machine at all", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId = await primeRunning(backend, "seed");
    await backend.terminate({ workerId: "seed", backend: "alpha", nativeId, state: "running", startedAt: 1 });

    const { fs } = makeMemoryFs();
    const savingStore = new HandleStore({ path: PATH, fs, now: () => 1 });
    await savingStore.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "hibernating" });

    const port = makeAdoptionPort(registry);
    const store = new HandleStore({ path: PATH, fs, now: () => 2 });
    const machine = new LifecycleMachine({ now: () => 10 });
    const result = await restoreWithAdoption({ store, registry: port, machine });

    expect(result!.adoption.dropped).toHaveLength(1);
    expect(machine.state("w1")).toBeUndefined();
  });

  it("multiple adopted handles are each tracked independently at their own resolved state", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "alpha" });
    registry.register(backend);
    const nativeId1 = await primeRunning(backend, "seed1");
    const nativeId2 = await primeRunning(backend, "seed2");

    const { fs } = makeMemoryFs();
    const savingStore = new HandleStore({ path: PATH, fs, now: () => 1 });
    await savingStore.save(
      [
        handle({ workerId: "w1", nativeId: nativeId1, state: "running" }),
        handle({ workerId: "w2", nativeId: nativeId2, state: "running" }),
      ],
      { w1: "running", w2: "waking" },
    );

    const port = makeAdoptionPort(registry);
    const store = new HandleStore({ path: PATH, fs, now: () => 2 });
    const machine = new LifecycleMachine({ now: () => 10 });
    const result = await restoreWithAdoption({ store, registry: port, machine });

    expect(result!.adoption.adopted).toHaveLength(2);
    expect(machine.state("w1")).toBe("running");
    expect(machine.state("w2")).toBe("failed"); // downgraded: persisted "waking"
  });
});
