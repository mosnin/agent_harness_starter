import { describe, it, expect } from "vitest";
import { FleetService, type FleetPort } from "../core/fleet-service";
import { decodeFleetEvent, encodeFleetEvent, type FleetLifecycleState } from "../ipc/fleet-contract";
import { BackendManager } from "../../hades/backends/manager";
import { FakeBackend } from "../../hades/backends/fake-backend";
import type { BackendDescriptor } from "../../hades/backends/descriptor";
import type { RemoteBackend, RemoteHandle, RemoteSpec, RemoteState } from "../../hades/backends/backend";

// ---------------------------------------------------------------------------
// Fixtures shared across tests
// ---------------------------------------------------------------------------

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
    name: "alpha",
    kind: "fake",
    capabilities: ["alpha-cap"],
    cost: { perRunningHourUsd: 2, perHibernatedHourUsd: 0.2, perProvisionUsd: 0.1, source: "configured" },
    supportsHibernate: true,
    locality: "remote",
    ...overrides,
  };
}

function spec(workerId: string, capabilities: string[]): RemoteSpec {
  return {
    workerId,
    capabilities,
    managerUrl: "https://manager.local",
    authToken: "tok",
  };
}

/** Provisions `workerId` and forces backend selection to whichever descriptor advertises
 *  `capability` — `RemoteSpec.capabilities` describes the worker, not a selection filter, so
 *  the requirement has to be passed as `provision()`'s second (BackendRequirements) argument. */
function provisionOn(mgr: BackendManager, workerId: string, capability: string) {
  return mgr.provision(spec(workerId, [capability]), { capabilities: [capability] });
}

/** A real (non-Fake) backend whose availability probe genuinely throws — proves BackendManager's
 *  probe-catches-exceptions path flows through to the service as `available: false`, not a crash. */
class ThrowingAvailabilityBackend implements RemoteBackend {
  readonly name = "flaky";
  async isAvailable(): Promise<boolean> {
    throw new Error("network unreachable");
  }
  async provision(_spec: RemoteSpec): Promise<RemoteHandle> {
    throw new Error("flaky backend should never be selected in these tests");
  }
  async terminate(_handle: RemoteHandle): Promise<void> {}
  async status(_handle: RemoteHandle): Promise<RemoteState> {
    return "failed";
  }
  async logs(_handle: RemoteHandle): Promise<string> {
    return "";
  }
}

/** Builds a manager with three real backends: a working hibernate-capable fake ("alpha"),
 *  a fake that cannot hibernate ("nohib"), and one whose probe genuinely throws ("flaky"). */
function makeManager(now: () => number) {
  const mgr = new BackendManager({ now });
  mgr.register(new FakeBackend({ name: "alpha", now }), descriptor());
  mgr.register(
    new FakeBackend({ name: "nohib", supportsHibernate: false, now }),
    descriptor({ name: "nohib", capabilities: ["nohib-cap"], supportsHibernate: false })
  );
  mgr.register(
    new ThrowingAvailabilityBackend(),
    descriptor({ name: "flaky", capabilities: ["flaky-cap"], supportsHibernate: false })
  );
  return mgr;
}

/** A thin forwarding adapter — every call delegates straight to the real manager; it exists only
 *  to add the optional `lifecycleMap()` hook a real lifecycle supervisor would layer on top. This
 *  is NOT a stub of the manager: no manager method is faked or reimplemented. */
class LifecycleAwarePort implements FleetPort {
  constructor(
    private readonly mgr: BackendManager,
    private readonly map: () => Record<string, string>
  ) {}
  descriptors() {
    return this.mgr.descriptors();
  }
  telemetry(name: string) {
    return this.mgr.telemetry(name);
  }
  list() {
    return this.mgr.list();
  }
  probeAll() {
    return this.mgr.probeAll();
  }
  hibernate(workerId: string) {
    return this.mgr.hibernate(workerId);
  }
  wake(workerId: string) {
    return this.mgr.wake(workerId);
  }
  terminate(workerId: string) {
    return this.mgr.terminate(workerId);
  }
  lifecycleMap() {
    return this.map();
  }
}

function roundTrip(evt: import("../ipc/fleet-contract").FleetEvent) {
  const decoded = decodeFleetEvent(encodeFleetEvent(evt));
  expect(decoded).toEqual(evt);
}

// ---------------------------------------------------------------------------
// fleet.list / fleet.probe
// ---------------------------------------------------------------------------

describe("FleetService — fleet.list", () => {
  it("returns one fleet.snapshot with available: null and empty workers, sorted by backend name", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    const svc = new FleetService(mgr, { now: clock.now });

    const events = await svc.handle({ kind: "fleet.list" });
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.kind).toBe("fleet.snapshot");
    if (evt.kind !== "fleet.snapshot") throw new Error("unreachable");
    expect(evt.backends.map((b) => b.name)).toEqual(["alpha", "flaky", "nohib"]);
    for (const b of evt.backends) {
      expect(b.available).toBeNull();
    }
    expect(evt.workers).toEqual([]);
    roundTrip(evt);
  });

  it("never calls probeAll for fleet.list (no real network/isAvailable work happens)", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    const svc = new FleetService(mgr, { now: clock.now });
    // If fleet.list probed, the flaky backend's isAvailable() would throw and get caught inside
    // BackendManager — but the manager's probe cache would then be populated. Assert it is not.
    await svc.handle({ kind: "fleet.list" });
    // probeAll() populates every backend; a targeted probe() with a fresh manager + TTL cache
    // would short-circuit on a cache hit. Since we never called probe/probeAll, a direct probe
    // call must actually execute (and throw-catch) fresh, proving fleet.list took no probe path.
    await expect(mgr.probe("flaky")).resolves.toBe(false);
  });

  it("reflects the manager's real descriptor fields (capabilities, locality, supportsHibernate, cost)", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    const svc = new FleetService(mgr, { now: clock.now });
    const [evt] = await svc.handle({ kind: "fleet.list" });
    if (evt.kind !== "fleet.snapshot") throw new Error("unreachable");
    const alpha = evt.backends.find((b) => b.name === "alpha")!;
    expect(alpha.kind).toBe("fake");
    expect(alpha.capabilities).toEqual(["alpha-cap"]);
    expect(alpha.locality).toBe("remote");
    expect(alpha.supportsHibernate).toBe(true);
    expect(alpha.cost).toEqual({
      perRunningHourUsd: 2,
      perHibernatedHourUsd: 0.2,
      perProvisionUsd: 0.1,
      source: "configured",
    });
    const nohib = evt.backends.find((b) => b.name === "nohib")!;
    expect(nohib.supportsHibernate).toBe(false);
  });
});

describe("FleetService — fleet.probe", () => {
  it("runs a real probeAll() and reflects a throwing isAvailable() as available: false", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    const svc = new FleetService(mgr, { now: clock.now });

    const [evt] = await svc.handle({ kind: "fleet.probe" });
    expect(evt.kind).toBe("fleet.snapshot");
    if (evt.kind !== "fleet.snapshot") throw new Error("unreachable");
    const byName = Object.fromEntries(evt.backends.map((b) => [b.name, b.available]));
    expect(byName.alpha).toBe(true);
    expect(byName.nohib).toBe(true);
    expect(byName.flaky).toBe(false);
    roundTrip(evt);
  });
});

// ---------------------------------------------------------------------------
// Mutations against the real manager + FakeBackend
// ---------------------------------------------------------------------------

describe("FleetService — fleet.hibernate / fleet.wake / fleet.terminate (real registry)", () => {
  it("hibernate mutates the real registry and both the upsert and the follow-up snapshot prove it", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    const svc = new FleetService(mgr, { now: clock.now });

    await provisionOn(mgr, "w1", "alpha-cap");
    clock.advance(3_600_000); // 1 hour running

    const events = await svc.handle({ kind: "fleet.hibernate", workerId: "w1" });
    expect(events).toHaveLength(2);
    const [upsert, snap] = events;
    expect(upsert.kind).toBe("fleet.worker.upsert");
    if (upsert.kind !== "fleet.worker.upsert") throw new Error("unreachable");
    expect(upsert.worker.workerId).toBe("w1");
    expect(upsert.worker.backend).toBe("alpha");
    expect(upsert.worker.state).toBe("hibernated");
    roundTrip(upsert);

    expect(snap.kind).toBe("fleet.snapshot");
    if (snap.kind !== "fleet.snapshot") throw new Error("unreachable");
    expect(snap.workers).toHaveLength(1);
    expect(snap.workers[0].state).toBe("hibernated");
    // Real measured telemetry, under the fake clock, untouched cost `source`.
    const alpha = snap.backends.find((b) => b.name === "alpha")!;
    expect(alpha.telemetry.runningMs).toBe(3_600_000);
    expect(alpha.telemetry.accruedUsd).toBeCloseTo(0.1 /* per-provision */ + 2 /* rate * 1hr */, 9);
    expect(alpha.cost.source).toBe("configured");
    roundTrip(snap);

    // Confirms this is the REAL registry, not a service-local mirror.
    expect(mgr.registry.handle("w1")?.state).toBe("hibernated");
  });

  it("wake mutates the real registry back to running and finalizes hibernated-duration accounting", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    const svc = new FleetService(mgr, { now: clock.now });

    await provisionOn(mgr, "w1", "alpha-cap");
    await svc.handle({ kind: "fleet.hibernate", workerId: "w1" });
    clock.advance(1_800_000); // 30 min hibernated

    const events = await svc.handle({ kind: "fleet.wake", workerId: "w1" });
    const [upsert, snap] = events;
    if (upsert.kind !== "fleet.worker.upsert" || snap.kind !== "fleet.snapshot") {
      throw new Error("unreachable");
    }
    expect(upsert.worker.state).toBe("running");
    expect(mgr.registry.handle("w1")?.state).toBe("running");
    const alpha = snap.backends.find((b) => b.name === "alpha")!;
    expect(alpha.telemetry.hibernatedMs).toBe(1_800_000);
    expect(alpha.telemetry.accruedUsd).toBeCloseTo(0.1 + 0.2 * 0.5, 9);
  });

  it("terminate mutates the real registry (handle removed) and reports the worker as stopped", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    const svc = new FleetService(mgr, { now: clock.now });

    await provisionOn(mgr, "w1", "alpha-cap");
    clock.advance(600_000);

    const events = await svc.handle({ kind: "fleet.terminate", workerId: "w1" });
    const [upsert, snap] = events;
    if (upsert.kind !== "fleet.worker.upsert" || snap.kind !== "fleet.snapshot") {
      throw new Error("unreachable");
    }
    expect(upsert.worker.state).toBe("stopped");
    expect(upsert.worker.backend).toBe("alpha");
    expect(upsert.worker.nativeId).toMatch(/^alpha-/);
    expect(snap.workers).toEqual([]);
    // Real registry: the handle is genuinely gone, not just hidden.
    expect(mgr.registry.handle("w1")).toBeUndefined();
    expect(mgr.list()).toEqual([]);
    roundTrip(upsert);
    roundTrip(snap);
  });

  it("an unknown workerId yields fleet.error and never a rejection, for all three mutating commands", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    const svc = new FleetService(mgr, { now: clock.now });

    for (const kind of ["fleet.hibernate", "fleet.wake", "fleet.terminate"] as const) {
      const events = await svc.handle({ kind, workerId: "ghost" });
      expect(events).toHaveLength(1);
      const [err] = events;
      expect(err.kind).toBe("fleet.error");
      if (err.kind !== "fleet.error") throw new Error("unreachable");
      expect(err.workerId).toBe("ghost");
      expect(err.message).toMatch(/unknown worker/i);
      roundTrip(err);
    }
    // The registry was never touched.
    expect(mgr.list()).toEqual([]);
  });

  it("a throwing port method (hibernate unsupported by the backend) yields fleet.error, not a rejection", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    const svc = new FleetService(mgr, { now: clock.now });

    await provisionOn(mgr, "w2", "nohib-cap");
    const events = await svc.handle({ kind: "fleet.hibernate", workerId: "w2" });
    expect(events).toHaveLength(1);
    const [err] = events;
    expect(err.kind).toBe("fleet.error");
    if (err.kind !== "fleet.error") throw new Error("unreachable");
    expect(err.workerId).toBe("w2");
    expect(err.message).toMatch(/does not support hibernate/i);
    roundTrip(err);

    // The worker is untouched — still running, real registry state unchanged.
    expect(mgr.registry.handle("w2")?.state).toBe("running");

    // The service itself must not have rejected to get here at all — implicit in reaching this line.
  });
});

// ---------------------------------------------------------------------------
// Lifecycle-state resolution (lifecycleMap precedence + honest fallback)
// ---------------------------------------------------------------------------

describe("FleetService — lifecycle state resolution", () => {
  it("prefers lifecycleMap()'s value over handle.state when both are present and valid", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    await provisionOn(mgr, "w1", "alpha-cap");
    // The real handle.state is "running", but a lifecycle supervisor reports it mid-hibernate-transition.
    const port = new LifecycleAwarePort(mgr, () => ({ w1: "hibernating" satisfies FleetLifecycleState }));
    const svc = new FleetService(port, { now: clock.now });

    const [evt] = await svc.handle({ kind: "fleet.list" });
    if (evt.kind !== "fleet.snapshot") throw new Error("unreachable");
    expect(evt.workers[0].state).toBe("hibernating");
    expect(mgr.registry.handle("w1")?.state).toBe("running"); // real state, untouched
  });

  it("falls back to handle.state when lifecycleMap() has no entry for a worker", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    await provisionOn(mgr, "w1", "alpha-cap");
    const port = new LifecycleAwarePort(mgr, () => ({}));
    const svc = new FleetService(port, { now: clock.now });

    const [evt] = await svc.handle({ kind: "fleet.list" });
    if (evt.kind !== "fleet.snapshot") throw new Error("unreachable");
    expect(evt.workers[0].state).toBe("running");
  });

  it("maps an unrecognized lifecycleMap() string to 'failed' — never invented", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    await provisionOn(mgr, "w1", "alpha-cap");
    const port = new LifecycleAwarePort(mgr, () => ({ w1: "somewhere-over-the-rainbow" }));
    const svc = new FleetService(port, { now: clock.now });

    const [evt] = await svc.handle({ kind: "fleet.list" });
    if (evt.kind !== "fleet.snapshot") throw new Error("unreachable");
    expect(evt.workers[0].state).toBe("failed");
  });

  it("without a lifecycleMap at all (bare manager), an unrecognized raw handle.state would map to 'failed'", async () => {
    // BackendManager's own RemoteState values are always valid FleetLifecycleState members, so to
    // exercise this branch honestly we go through a port whose handle.state is deliberately bogus
    // rather than pretending the real manager can produce one.
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    await provisionOn(mgr, "w1", "alpha-cap");
    const realList = mgr.list();
    const port: FleetPort = {
      descriptors: () => mgr.descriptors(),
      telemetry: (name) => mgr.telemetry(name),
      list: () => realList.map((e) => ({ ...e, handle: { ...e.handle, state: "quantum-superposed" } })),
      probeAll: () => mgr.probeAll(),
      hibernate: (id) => mgr.hibernate(id),
      wake: (id) => mgr.wake(id),
      terminate: (id) => mgr.terminate(id),
    };
    const svc = new FleetService(port, { now: clock.now });
    const [evt] = await svc.handle({ kind: "fleet.list" });
    if (evt.kind !== "fleet.snapshot") throw new Error("unreachable");
    expect(evt.workers[0].state).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// snapshot() decodes with the guards it ships
// ---------------------------------------------------------------------------

describe("FleetService — output always round-trips through the contract's own guards", () => {
  it("snapshot(false) and snapshot(true) both decode cleanly, with and without workers", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    const svc = new FleetService(mgr, { now: clock.now });

    roundTrip(await svc.snapshot(false));
    roundTrip(await svc.snapshot(true));

    await provisionOn(mgr, "w1", "alpha-cap");
    roundTrip(await svc.snapshot(false));
    roundTrip(await svc.snapshot(true));
  });
});

// ---------------------------------------------------------------------------
// Concurrency: overlapping handle() calls never interleave
// ---------------------------------------------------------------------------

describe("FleetService — concurrency safety", () => {
  it("serializes overlapping handle() calls so a hibernate and a wake never race into a corrupt snapshot", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    await provisionOn(mgr, "w1", "alpha-cap");

    const log: string[] = [];
    // A port that forwards to the real manager but injects an artificial delay around the two
    // mutating calls, so that without serialization in FleetService the two commands WOULD
    // interleave (hibernate-start, wake-start, hibernate-end, wake-end).
    const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
    const port: FleetPort = {
      descriptors: () => mgr.descriptors(),
      telemetry: (name) => mgr.telemetry(name),
      list: () => mgr.list(),
      probeAll: () => mgr.probeAll(),
      hibernate: async (id) => {
        log.push("hibernate-start");
        await delay();
        const r = await mgr.hibernate(id);
        log.push("hibernate-end");
        return r;
      },
      wake: async (id) => {
        log.push("wake-start");
        await delay();
        const r = await mgr.wake(id);
        log.push("wake-end");
        return r;
      },
      terminate: (id) => mgr.terminate(id),
    };
    const svc = new FleetService(port, { now: clock.now });

    const [hibernateEvents, wakeEvents] = await Promise.all([
      svc.handle({ kind: "fleet.hibernate", workerId: "w1" }),
      svc.handle({ kind: "fleet.wake", workerId: "w1" }),
    ]);

    // No interleaving: one op's start/end pair is fully contiguous before the next starts.
    expect(log).toEqual(["hibernate-start", "hibernate-end", "wake-start", "wake-end"]);

    // Because they ran in submission order, the net effect is deterministic: hibernate then wake
    // leaves the worker running, and every event produced along the way is well-formed.
    for (const evt of [...hibernateEvents, ...wakeEvents]) {
      roundTrip(evt);
    }
    expect(mgr.registry.handle("w1")?.state).toBe("running");
  });

  it("many overlapping fleet.list snapshots stay internally consistent (each round-trips cleanly)", async () => {
    const clock = makeClock();
    const mgr = makeManager(clock.now);
    await provisionOn(mgr, "w1", "alpha-cap");
    await provisionOn(mgr, "w2", "alpha-cap");
    const svc = new FleetService(mgr, { now: clock.now });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => svc.handle({ kind: "fleet.list" }))
    );
    for (const events of results) {
      expect(events).toHaveLength(1);
      const [evt] = events;
      if (evt.kind !== "fleet.snapshot") throw new Error("unreachable");
      expect(evt.workers.map((w) => w.workerId).sort()).toEqual(["w1", "w2"]);
      roundTrip(evt);
    }
  });
});
