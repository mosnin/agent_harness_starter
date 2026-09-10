import { describe, it, expect, vi } from "vitest";
import { FleetProvisionService, type FleetProvisionPort } from "../core/fleet-provision-service";
import {
  parseFleetProvisionEvent,
  serializeFleetProvisionEvent,
  type FleetProvisionCommand,
} from "../ipc/fleet-provision-contract";
import type { FleetWorkerView } from "../ipc/fleet-contract";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

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

function cmd(overrides: Partial<FleetProvisionCommand> = {}): FleetProvisionCommand {
  return {
    kind: "fleet.provision",
    requestId: "r1",
    spec: { workerId: "w1", capabilities: ["gpu"] },
    ...overrides,
  };
}

function roundTrip(evt: import("../ipc/fleet-provision-contract").FleetProvisionEvent) {
  expect(parseFleetProvisionEvent(serializeFleetProvisionEvent(evt))).toEqual(evt);
}

/** A real, in-memory FleetProvisionPort — no constant-returning stub: it actually tracks
 *  which workerIds have been provisioned and refuses to double-provision one, exactly like
 *  a real registry would, so `isTracked` reflects genuine state rather than a canned value. */
class InMemoryPort implements FleetProvisionPort {
  private readonly tracked = new Set<string>();
  public provisionCalls: Array<{ workerId: string; requirements?: FleetProvisionCommand["requirements"] }> = [];
  public restored:
    | { workers: FleetWorkerView[]; adoptedIds: string[]; dropped: Array<{ workerId: string; reason: string }> }
    | undefined = undefined;
  public failNextProvision: string | null = null;
  public provisionDelayMs = 0;

  constructor(private readonly now: () => number) {}

  async provision(
    spec: { workerId: string; capabilities: string[]; image?: string },
    requirements?: FleetProvisionCommand["requirements"]
  ) {
    this.provisionCalls.push({ workerId: spec.workerId, requirements });
    if (this.provisionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.provisionDelayMs));
    }
    if (this.failNextProvision !== null) {
      const message = this.failNextProvision;
      this.failNextProvision = null;
      throw new Error(message);
    }
    this.tracked.add(spec.workerId);
    return {
      backend: requirements?.exclude?.includes("docker") ? "local" : "docker",
      handle: {
        workerId: spec.workerId,
        backend: requirements?.exclude?.includes("docker") ? "local" : "docker",
        nativeId: `native-${spec.workerId}`,
        state: "running",
        startedAt: this.now(),
      },
      routing: { source: "bandit", reason: "lowest observed cost" },
    };
  }

  async restoredView() {
    return this.restored;
  }

  isTracked(workerId: string): boolean {
    return this.tracked.has(workerId);
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("FleetProvisionService — successful provision", () => {
  it("provisions via the real port and returns exactly one fleet.provisioned event", async () => {
    const clock = makeClock(1_000);
    const port = new InMemoryPort(clock.now);
    const svc = new FleetProvisionService(port, { now: clock.now });

    const events = await svc.handle(cmd());
    expect(events).toHaveLength(1);
    const [evt] = events;
    expect(evt.kind).toBe("fleet.provisioned");
    if (evt.kind !== "fleet.provisioned") throw new Error("unreachable");
    expect(evt.requestId).toBe("r1");
    expect(evt.worker.workerId).toBe("w1");
    expect(evt.worker.backend).toBe("docker");
    expect(evt.worker.nativeId).toBe("native-w1");
    expect(evt.worker.state).toBe("running");
    expect(evt.worker.idleMs).toBe(0);
    expect(evt.backend).toBe("docker");
    expect(evt.at).toBe(1_000);
    expect(evt.routing?.source).toBe("bandit");
    roundTrip(evt);

    // The port was genuinely invoked (not bypassed).
    expect(port.provisionCalls).toEqual([{ workerId: "w1", requirements: undefined }]);
    expect(port.isTracked("w1")).toBe(true);
  });

  it("passes requirements straight through to the port untouched", async () => {
    const clock = makeClock();
    const port = new InMemoryPort(clock.now);
    const svc = new FleetProvisionService(port, { now: clock.now });

    const requirements: FleetProvisionCommand["requirements"] = {
      requireHibernate: true,
      maxRunningHourUsd: 0.75,
      exclude: ["docker"],
    };
    const events = await svc.handle(cmd({ requirements }));
    const [evt] = events;
    if (evt.kind !== "fleet.provisioned") throw new Error("unreachable");
    // The fake port routes to "local" specifically when docker is excluded — proves
    // requirements actually reached the port rather than being dropped.
    expect(evt.backend).toBe("local");
    expect(port.provisionCalls[0].requirements).toEqual(requirements);
  });

  it("maps an unrecognized handle.state from the port to 'failed', never inventing one", async () => {
    const clock = makeClock();
    const port: FleetProvisionPort = {
      async provision() {
        return {
          backend: "weird",
          handle: { workerId: "w1", backend: "weird", nativeId: "n1", state: "quantum-superposed", startedAt: 0 },
        };
      },
      async restoredView() {
        return undefined;
      },
      isTracked() {
        return false;
      },
    };
    const svc = new FleetProvisionService(port, { now: clock.now });
    const [evt] = await svc.handle(cmd());
    if (evt.kind !== "fleet.provisioned") throw new Error("unreachable");
    expect(evt.worker.state).toBe("failed");
    roundTrip(evt);
  });

  it("omits routing entirely on the event when the port omits it", async () => {
    const clock = makeClock();
    const port: FleetProvisionPort = {
      async provision() {
        return {
          backend: "local",
          handle: { workerId: "w1", backend: "local", nativeId: "n1", state: "running", startedAt: 0 },
        };
      },
      async restoredView() {
        return undefined;
      },
      isTracked() {
        return false;
      },
    };
    const svc = new FleetProvisionService(port, { now: clock.now });
    const [evt] = await svc.handle(cmd());
    if (evt.kind !== "fleet.provisioned") throw new Error("unreachable");
    expect("routing" in evt).toBe(false);
    roundTrip(evt);
  });

  it("at timestamps come from the injected clock, not the wall clock", async () => {
    const clock = makeClock(42_000);
    const port = new InMemoryPort(clock.now);
    const svc = new FleetProvisionService(port, { now: clock.now });

    const [evt1] = await svc.handle(cmd({ requestId: "a", spec: { workerId: "wa", capabilities: [] } }));
    expect(evt1.at).toBe(42_000);

    clock.advance(9_000);
    const [evt2] = await svc.handle(cmd({ requestId: "b", spec: { workerId: "wb", capabilities: [] } }));
    expect(evt2.at).toBe(51_000);
  });
});

// ---------------------------------------------------------------------------
// Already-tracked rejection BEFORE the port is called
// ---------------------------------------------------------------------------

describe("FleetProvisionService — already-tracked workerId", () => {
  it("rejects as fleet.provision.error and never calls port.provision at all (asserted via spy)", async () => {
    const clock = makeClock();
    const port: FleetProvisionPort = {
      provision: vi.fn(async () => {
        throw new Error("provision should never be called for an already-tracked worker");
      }),
      restoredView: vi.fn(async () => undefined),
      isTracked: vi.fn(() => true),
    };
    const svc = new FleetProvisionService(port, { now: clock.now });

    const events = await svc.handle(cmd());
    expect(events).toHaveLength(1);
    const [evt] = events;
    expect(evt.kind).toBe("fleet.provision.error");
    if (evt.kind !== "fleet.provision.error") throw new Error("unreachable");
    expect(evt.requestId).toBe("r1");
    expect(evt.message).toMatch(/already tracked/i);
    expect(evt.message).toContain("w1");
    roundTrip(evt);

    expect(port.isTracked).toHaveBeenCalledWith("w1");
    expect(port.isTracked).toHaveBeenCalledTimes(1);
    expect(port.provision).not.toHaveBeenCalled();
  });

  it("isTracked is called before provision even when provision would otherwise succeed instantly", async () => {
    const clock = makeClock();
    const callOrder: string[] = [];
    const port: FleetProvisionPort = {
      provision: vi.fn(async () => {
        callOrder.push("provision");
        return {
          backend: "local",
          handle: { workerId: "w1", backend: "local", nativeId: "n1", state: "running", startedAt: 0 },
        };
      }),
      restoredView: vi.fn(async () => undefined),
      isTracked: vi.fn(() => {
        callOrder.push("isTracked");
        return false;
      }),
    };
    const svc = new FleetProvisionService(port, { now: clock.now });
    await svc.handle(cmd());
    expect(callOrder).toEqual(["isTracked", "provision"]);
  });
});

// ---------------------------------------------------------------------------
// Port rejection mapping
// ---------------------------------------------------------------------------

describe("FleetProvisionService — port rejection mapping", () => {
  it("propagates the exact port error message and the request's own requestId", async () => {
    const clock = makeClock();
    const port = new InMemoryPort(clock.now);
    port.failNextProvision = "backend unreachable: connection refused";
    const svc = new FleetProvisionService(port, { now: clock.now });

    const events = await svc.handle(cmd({ requestId: "req-fail" }));
    expect(events).toHaveLength(1);
    const [evt] = events;
    expect(evt.kind).toBe("fleet.provision.error");
    if (evt.kind !== "fleet.provision.error") throw new Error("unreachable");
    expect(evt.requestId).toBe("req-fail");
    expect(evt.message).toBe("backend unreachable: connection refused");
    roundTrip(evt);

    // The worker must NOT be tracked after a failed provision.
    expect(port.isTracked("w1")).toBe(false);
  });

  it("a non-Error throw (string) still yields a well-formed fleet.provision.error", async () => {
    const clock = makeClock();
    const port: FleetProvisionPort = {
      async provision() {
        // eslint-disable-next-line no-throw-literal
        throw "raw string failure";
      },
      async restoredView() {
        return undefined;
      },
      isTracked() {
        return false;
      },
    };
    const svc = new FleetProvisionService(port, { now: clock.now });
    const [evt] = await svc.handle(cmd());
    if (evt.kind !== "fleet.provision.error") throw new Error("unreachable");
    expect(evt.message).toBe("raw string failure");
  });

  it("a throwing isTracked() also maps to fleet.provision.error rather than rejecting handle()", async () => {
    const clock = makeClock();
    const port: FleetProvisionPort = {
      provision: vi.fn(async () => {
        throw new Error("should never reach provision");
      }),
      restoredView: vi.fn(async () => undefined),
      isTracked: vi.fn(() => {
        throw new Error("registry unavailable");
      }),
    };
    const svc = new FleetProvisionService(port, { now: clock.now });
    await expect(svc.handle(cmd())).resolves.toEqual([
      { kind: "fleet.provision.error", requestId: "r1", message: "registry unavailable", at: 0 },
    ]);
    expect(port.provision).not.toHaveBeenCalled();
  });

  it("handle() never rejects even under a hostile always-throwing port", async () => {
    const clock = makeClock();
    const port: FleetProvisionPort = {
      async provision() {
        throw new Error("boom");
      },
      async restoredView() {
        throw new Error("also boom");
      },
      isTracked() {
        return false;
      },
    };
    const svc = new FleetProvisionService(port, { now: clock.now });
    await expect(svc.handle(cmd())).resolves.toEqual([
      expect.objectContaining({ kind: "fleet.provision.error" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Duplicate requestId serialization
// ---------------------------------------------------------------------------

describe("FleetProvisionService — duplicate requestId serialization", () => {
  it("a second concurrent handle() call with the same requestId waits for the first, then errors as a duplicate — provision is invoked exactly once", async () => {
    const clock = makeClock();
    const port = new InMemoryPort(clock.now);
    port.provisionDelayMs = 20;
    const svc = new FleetProvisionService(port, { now: clock.now });

    const first = svc.handle(cmd({ requestId: "dup", spec: { workerId: "w-dup", capabilities: [] } }));
    // Give the first call a tick to actually enter the port before firing the second.
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = svc.handle(cmd({ requestId: "dup", spec: { workerId: "w-dup-second", capabilities: [] } }));

    const [firstEvents, secondEvents] = await Promise.all([first, second]);

    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0].kind).toBe("fleet.provisioned");

    expect(secondEvents).toHaveLength(1);
    expect(secondEvents[0].kind).toBe("fleet.provision.error");
    if (secondEvents[0].kind !== "fleet.provision.error") throw new Error("unreachable");
    expect(secondEvents[0].requestId).toBe("dup");
    expect(secondEvents[0].message).toMatch(/duplicate/i);

    // The port's provision() was invoked exactly once for the shared requestId — the
    // second call never reached it, it only ever awaited the first's outcome.
    expect(port.provisionCalls).toHaveLength(1);
    expect(port.provisionCalls[0].workerId).toBe("w-dup");
  });

  it("a duplicate requestId is reported even when the first request itself failed", async () => {
    const clock = makeClock();
    const port = new InMemoryPort(clock.now);
    port.provisionDelayMs = 20;
    port.failNextProvision = "first one fails";
    const svc = new FleetProvisionService(port, { now: clock.now });

    const first = svc.handle(cmd({ requestId: "dup2" }));
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = svc.handle(cmd({ requestId: "dup2" }));

    const [firstEvents, secondEvents] = await Promise.all([first, second]);
    expect(firstEvents[0].kind).toBe("fleet.provision.error");
    expect(secondEvents[0].kind).toBe("fleet.provision.error");
    if (secondEvents[0].kind !== "fleet.provision.error") throw new Error("unreachable");
    expect(secondEvents[0].message).toMatch(/duplicate/i);
    // The first request's own failure message must not have been reused for the duplicate.
    expect(secondEvents[0].message).not.toBe("first one fails");
  });

  it("a fresh handle() call reusing a requestId AFTER the first has fully settled is treated as a brand-new request, not a duplicate", async () => {
    const clock = makeClock();
    const port = new InMemoryPort(clock.now);
    const svc = new FleetProvisionService(port, { now: clock.now });

    const firstEvents = await svc.handle(cmd({ requestId: "reused", spec: { workerId: "w-a", capabilities: [] } }));
    expect(firstEvents[0].kind).toBe("fleet.provisioned");

    // w-a is now tracked, so re-provisioning it under the same requestId would legitimately
    // fail as "already tracked" — use a different workerId to isolate the requestId-reuse
    // behavior from the already-tracked behavior.
    const secondEvents = await svc.handle(cmd({ requestId: "reused", spec: { workerId: "w-b", capabilities: [] } }));
    expect(secondEvents[0].kind).toBe("fleet.provisioned");
    if (secondEvents[0].kind !== "fleet.provisioned") throw new Error("unreachable");
    expect(secondEvents[0].worker.workerId).toBe("w-b");

    expect(port.provisionCalls.map((c) => c.workerId)).toEqual(["w-a", "w-b"]);
  });

  it("concurrent handle() calls with DIFFERENT requestIds run independently (no cross-request blocking)", async () => {
    const clock = makeClock();
    const port = new InMemoryPort(clock.now);
    port.provisionDelayMs = 10;
    const svc = new FleetProvisionService(port, { now: clock.now });

    const results = await Promise.all([
      svc.handle(cmd({ requestId: "x1", spec: { workerId: "wx1", capabilities: [] } })),
      svc.handle(cmd({ requestId: "x2", spec: { workerId: "wx2", capabilities: [] } })),
      svc.handle(cmd({ requestId: "x3", spec: { workerId: "wx3", capabilities: [] } })),
    ]);

    for (const events of results) {
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("fleet.provisioned");
    }
    expect(port.provisionCalls).toHaveLength(3);
    expect(new Set(port.provisionCalls.map((c) => c.workerId))).toEqual(new Set(["wx1", "wx2", "wx3"]));
  });
});

// ---------------------------------------------------------------------------
// restoredSnapshot: undefined vs empty vs populated
// ---------------------------------------------------------------------------

describe("FleetProvisionService — restoredSnapshot", () => {
  it("returns undefined (not an event) when the port reports no restore ran", async () => {
    const clock = makeClock();
    const port = new InMemoryPort(clock.now);
    port.restored = undefined;
    const svc = new FleetProvisionService(port, { now: clock.now });

    const result = await svc.restoredSnapshot();
    expect(result).toBeUndefined();
  });

  it("returns a fleet.restored event with empty arrays when the port ran a restore that adopted nothing", async () => {
    const clock = makeClock(500);
    const port = new InMemoryPort(clock.now);
    port.restored = { workers: [], adoptedIds: [], dropped: [] };
    const svc = new FleetProvisionService(port, { now: clock.now });

    const result = await svc.restoredSnapshot();
    expect(result).toBeDefined();
    expect(result).toEqual({ kind: "fleet.restored", workers: [], adoptedIds: [], dropped: [], at: 500 });
    roundTrip(result!);
  });

  it("returns a fully populated fleet.restored event reflecting real port data, at the injected clock time", async () => {
    const clock = makeClock(12_345);
    const port = new InMemoryPort(clock.now);
    const worker: FleetWorkerView = {
      workerId: "w-old",
      backend: "docker",
      nativeId: "docker-old",
      state: "hibernated",
      startedAt: 1,
      idleMs: 999,
    };
    port.restored = {
      workers: [worker],
      adoptedIds: ["w-old"],
      dropped: [{ workerId: "w-gone", reason: "handle store entry corrupt" }],
    };
    const svc = new FleetProvisionService(port, { now: clock.now });

    const result = await svc.restoredSnapshot();
    expect(result).toEqual({
      kind: "fleet.restored",
      workers: [worker],
      adoptedIds: ["w-old"],
      dropped: [{ workerId: "w-gone", reason: "handle store entry corrupt" }],
      at: 12_345,
    });
    roundTrip(result!);
  });

  it("returns a fresh array copy, not a live reference into the port's own state", async () => {
    const clock = makeClock();
    const port = new InMemoryPort(clock.now);
    const workers: FleetWorkerView[] = [];
    port.restored = { workers, adoptedIds: [], dropped: [] };
    const svc = new FleetProvisionService(port, { now: clock.now });

    const result = await svc.restoredSnapshot();
    expect(result!.kind).toBe("fleet.restored");
    if (result!.kind !== "fleet.restored") throw new Error("unreachable");
    workers.push({
      workerId: "late-add",
      backend: "docker",
      nativeId: "n",
      state: "running",
      startedAt: 0,
      idleMs: 0,
    });
    expect(result!.workers).toEqual([]);
  });
});
