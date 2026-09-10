import { describe, it, expect } from "vitest";
import { AttributedContainerProvider, type AttributedProviderEvent, type FleetTrackingPort } from "../fleet-provider";
import { WorkerAttributionRegistry } from "../worker-attribution";
import type { RemoteHandle } from "../backend";
import type { ContainerHandle, ContainerProvider, SpawnSpec } from "../../../swarm-runtime/types";

// ===========================================================================
// Fixtures
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

function spec(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
  return {
    workerId: "w1",
    capabilities: ["shell"],
    managerUrl: "http://localhost:9000",
    authToken: "tok",
    ...overrides,
  };
}

/** Scripted ContainerProvider — every call is recorded so tests can assert
 *  real call order/args, and every phase can be scripted to throw or hang. */
class ScriptedProvider implements ContainerProvider {
  readonly kind = "process" as const;
  public calls: string[] = [];
  public spawnImpl: (spec: SpawnSpec) => Promise<ContainerHandle>;
  public stopImpl: (handle: ContainerHandle, graceMs?: number) => Promise<void>;
  public aliveImpl: (handle: ContainerHandle) => Promise<boolean> = async () => true;
  public logsImpl: (handle: ContainerHandle, tailLines?: number) => Promise<string> = async () => "";
  public availableImpl: () => Promise<boolean> = async () => true;

  private nowFn: () => number;

  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn;
    this.spawnImpl = async (s) => ({ workerId: s.workerId, nativeId: `native-${s.workerId}`, kind: this.kind, startedAt: this.nowFn() });
    this.stopImpl = async () => {};
  }

  async isAvailable(): Promise<boolean> {
    this.calls.push("isAvailable");
    return this.availableImpl();
  }
  async spawn(s: SpawnSpec): Promise<ContainerHandle> {
    this.calls.push(`spawn:${s.workerId}`);
    return this.spawnImpl(s);
  }
  async stop(h: ContainerHandle, graceMs?: number): Promise<void> {
    this.calls.push(`stop:${h.workerId}`);
    return this.stopImpl(h, graceMs);
  }
  async isAlive(h: ContainerHandle): Promise<boolean> {
    this.calls.push(`isAlive:${h.workerId}`);
    return this.aliveImpl(h);
  }
  async logs(h: ContainerHandle, tailLines?: number): Promise<string> {
    this.calls.push(`logs:${h.workerId}`);
    return this.logsImpl(h, tailLines);
  }
}

/** Fake tracking port mirroring RemoteBackendRegistry.adopt's real
 *  throw-on-duplicate contract exactly. */
class FakeTracking implements FleetTrackingPort {
  public handles = new Map<string, RemoteHandle>();
  public adoptCalls: RemoteHandle[] = [];
  public releaseCalls: string[] = [];
  public adoptShouldThrow = false;
  public adoptThrowMessage = "adopt: workerId already live in the registry";

  adopt(handle: RemoteHandle): void {
    this.adoptCalls.push(handle);
    if (this.adoptShouldThrow || this.handles.has(handle.workerId)) {
      throw new Error(`${this.adoptThrowMessage}: ${handle.workerId}`);
    }
    this.handles.set(handle.workerId, handle);
  }
  release(workerId: string): boolean {
    this.releaseCalls.push(workerId);
    return this.handles.delete(workerId);
  }
}

function events(): { onEvent: (e: AttributedProviderEvent) => void; log: AttributedProviderEvent[] } {
  const log: AttributedProviderEvent[] = [];
  return { onEvent: (e) => log.push(e), log };
}

// ===========================================================================
// Delegation
// ===========================================================================

describe("AttributedContainerProvider — pure delegation", () => {
  it("kind mirrors inner.kind", () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    const provider = new AttributedContainerProvider({ inner, backendName: "local", registry: reg });
    expect(provider.kind).toBe(inner.kind);
  });

  it("isAvailable delegates to inner unchanged", async () => {
    const inner = new ScriptedProvider();
    inner.availableImpl = async () => false;
    const reg = new WorkerAttributionRegistry();
    const provider = new AttributedContainerProvider({ inner, backendName: "local", registry: reg });
    await expect(provider.isAvailable()).resolves.toBe(false);
    expect(inner.calls).toEqual(["isAvailable"]);
  });

  it("isAlive delegates to inner unchanged", async () => {
    const inner = new ScriptedProvider();
    inner.aliveImpl = async () => false;
    const reg = new WorkerAttributionRegistry();
    const provider = new AttributedContainerProvider({ inner, backendName: "local", registry: reg });
    const handle: ContainerHandle = { workerId: "w1", nativeId: "n1", kind: "process", startedAt: 0 };
    await expect(provider.isAlive(handle)).resolves.toBe(false);
    expect(inner.calls).toEqual(["isAlive:w1"]);
  });

  it("logs delegates to inner unchanged, including tailLines", async () => {
    const inner = new ScriptedProvider();
    inner.logsImpl = async (_h, tailLines) => `tail=${tailLines}`;
    const reg = new WorkerAttributionRegistry();
    const provider = new AttributedContainerProvider({ inner, backendName: "local", registry: reg });
    const handle: ContainerHandle = { workerId: "w1", nativeId: "n1", kind: "process", startedAt: 0 };
    await expect(provider.logs(handle, 42)).resolves.toBe("tail=42");
    expect(inner.calls).toEqual(["logs:w1"]);
  });
});

// ===========================================================================
// spawn() — the happy path
// ===========================================================================

describe("AttributedContainerProvider — spawn() success path", () => {
  it("calls inner.spawn first, then records attribution with the real nativeId", async () => {
    const clock = makeClock(1000);
    const inner = new ScriptedProvider(clock.now);
    const reg = new WorkerAttributionRegistry({ now: clock.now });
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, now: clock.now });

    const handle = await provider.spawn(spec({ workerId: "w1" }));

    expect(inner.calls).toEqual(["spawn:w1"]);
    expect(handle.nativeId).toBe("native-w1");
    expect(reg.lookup("w1")).toBe("docker");
    expect(reg.snapshot().entries["w1"]).toEqual({ backend: "docker", at: 1000, nativeId: "native-w1" });
  });

  it("adopts a RemoteHandle built from real handle fields when tracking is provided", async () => {
    const clock = makeClock(2000);
    const inner = new ScriptedProvider(clock.now);
    const reg = new WorkerAttributionRegistry({ now: clock.now });
    const tracking = new FakeTracking();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking, now: clock.now });

    await provider.spawn(spec({ workerId: "w1" }));

    expect(tracking.adoptCalls).toHaveLength(1);
    expect(tracking.adoptCalls[0]).toEqual({
      workerId: "w1",
      backend: "docker",
      state: "running",
      nativeId: "native-w1",
      startedAt: 2000,
    });
  });

  it("works with no tracking port configured (tracking is optional)", async () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg });
    const handle = await provider.spawn(spec({ workerId: "w1" }));
    expect(handle.workerId).toBe("w1");
    expect(reg.lookup("w1")).toBe("docker");
  });

  it("emits a spawned event carrying the injected clock's real timestamp", async () => {
    const clock = makeClock(555);
    const inner = new ScriptedProvider(clock.now);
    const reg = new WorkerAttributionRegistry({ now: clock.now });
    const { onEvent, log } = events();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, now: clock.now, onEvent });

    await provider.spawn(spec({ workerId: "w1" }));

    expect(log).toEqual([
      { type: "spawned", at: 555, workerId: "w1", backend: "docker", detail: { nativeId: "native-w1" } },
    ]);
  });
});

// ===========================================================================
// spawn() — inner.spawn rejects: zero side effects
// ===========================================================================

describe("AttributedContainerProvider — spawn() when inner.spawn rejects", () => {
  it("propagates the original error unchanged and records nothing", async () => {
    const inner = new ScriptedProvider();
    inner.spawnImpl = async () => {
      throw new Error("ENOENT: worker entrypoint missing");
    };
    const reg = new WorkerAttributionRegistry();
    const tracking = new FakeTracking();
    const { onEvent, log } = events();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking, onEvent });

    await expect(provider.spawn(spec({ workerId: "w1" }))).rejects.toThrow("ENOENT: worker entrypoint missing");

    expect(reg.ids()).toEqual([]);
    expect(tracking.adoptCalls).toHaveLength(0);
    expect(log).toEqual([]);
  });
});

// ===========================================================================
// spawn() — tracking.adopt throws: rollback ordering and residue-free state
// ===========================================================================

describe("AttributedContainerProvider — spawn() rollback on tracking.adopt failure", () => {
  it("stops the just-spawned inner handle, releases attribution, and rethrows the ORIGINAL adopt error", async () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    const tracking = new FakeTracking();
    tracking.adoptShouldThrow = true;
    const { onEvent, log } = events();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking, onEvent });

    await expect(provider.spawn(spec({ workerId: "w1" }))).rejects.toThrow(/adopt: workerId already live/);

    // No attribution residue.
    expect(reg.ids()).toEqual([]);
    expect(reg.lookup("w1")).toBeUndefined();

    // The just-spawned real unit was stopped — verify AWAIT ORDER: spawn, then stop, before rethrow.
    expect(inner.calls).toEqual(["spawn:w1", "stop:w1"]);

    // Event surfaces the rollback honestly.
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe("rolled-back");
    expect(log[0].workerId).toBe("w1");
    expect(log[0].detail?.adoptError).toMatch(/adopt: workerId already live/);
    expect(log[0].detail?.stopError).toBeUndefined();
  });

  it("when inner.stop ALSO throws during rollback, BOTH errors are surfaced in the rolled-back event, and the original adopt error is still what's thrown", async () => {
    const inner = new ScriptedProvider();
    inner.stopImpl = async () => {
      throw new Error("SIGKILL failed: process already reaped");
    };
    const reg = new WorkerAttributionRegistry();
    const tracking = new FakeTracking();
    tracking.adoptShouldThrow = true;
    const { onEvent, log } = events();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking, onEvent });

    await expect(provider.spawn(spec({ workerId: "w1" }))).rejects.toThrow(/adopt: workerId already live/);

    expect(reg.ids()).toEqual([]); // attribution still released even though stop failed
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe("rolled-back");
    expect(log[0].detail?.adoptError).toMatch(/adopt: workerId already live/);
    expect(log[0].detail?.stopError).toBe("SIGKILL failed: process already reaped");
  });

  it("await-ordering: inner.stop is fully awaited (a slow stop) before the rollback resolves/rethrows", async () => {
    const inner = new ScriptedProvider();
    let stopResolved = false;
    inner.stopImpl = async () => {
      await new Promise((r) => setTimeout(r, 5));
      stopResolved = true;
    };
    const reg = new WorkerAttributionRegistry();
    const tracking = new FakeTracking();
    tracking.adoptShouldThrow = true;
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking });

    await expect(provider.spawn(spec({ workerId: "w1" }))).rejects.toThrow();
    expect(stopResolved).toBe(true);
  });

  it("a duplicate id via tracking.adopt (handles.has) reflects the exact real RemoteBackendRegistry.adopt collision shape", async () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    const tracking = new FakeTracking();
    tracking.handles.set("w1", { workerId: "w1", backend: "other", nativeId: "x", state: "running", startedAt: 0 });
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking });

    await expect(provider.spawn(spec({ workerId: "w1" }))).rejects.toThrow(/already live/);
    expect(reg.ids()).toEqual([]);
  });
});

// ===========================================================================
// stop()
// ===========================================================================

describe("AttributedContainerProvider — stop()", () => {
  it("delegates to inner.stop, then releases attribution and tracking", async () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    const tracking = new FakeTracking();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking });

    await provider.spawn(spec({ workerId: "w1" }));
    const handle: ContainerHandle = { workerId: "w1", nativeId: "native-w1", kind: "process", startedAt: 0 };
    await provider.stop(handle, 3000);

    expect(inner.calls).toContain("stop:w1");
    expect(reg.lookup("w1")).toBeUndefined();
    expect(tracking.releaseCalls).toEqual(["w1"]);
  });

  it("passes graceMs through to inner.stop unchanged", async () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    let receivedGrace: number | undefined;
    inner.stopImpl = async (_h, graceMs) => {
      receivedGrace = graceMs;
    };
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg });
    const handle: ContainerHandle = { workerId: "w1", nativeId: "n1", kind: "process", startedAt: 0 };
    await provider.stop(handle, 12345);
    expect(receivedGrace).toBe(12345);
  });

  it("is idempotent for an unknown handle: inner.stop still runs, release failures never throw", async () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    const tracking = new FakeTracking();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking });

    const handle: ContainerHandle = { workerId: "never-spawned", nativeId: "n1", kind: "process", startedAt: 0 };
    await expect(provider.stop(handle)).resolves.toBeUndefined();
    expect(inner.calls).toEqual(["stop:never-spawned"]);
  });

  it("folds a throwing tracking.release into the stopped event's detail, never throwing", async () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker");
    const tracking: FleetTrackingPort = {
      adopt: () => {},
      release: () => {
        throw new Error("tracking backend unreachable");
      },
    };
    const { onEvent, log } = events();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking, onEvent });

    const handle: ContainerHandle = { workerId: "w1", nativeId: "n1", kind: "process", startedAt: 0 };
    await expect(provider.stop(handle)).resolves.toBeUndefined();

    expect(log).toHaveLength(1);
    expect(log[0].type).toBe("stopped");
    expect(log[0].detail?.trackingError).toBe("tracking backend unreachable");
    expect(log[0].detail?.attributionReleased).toBe(true);
  });

  it("reports attributionReleased:false when the worker was never attributed", async () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    const { onEvent, log } = events();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, onEvent });

    const handle: ContainerHandle = { workerId: "ghost", nativeId: "n1", kind: "process", startedAt: 0 };
    await provider.stop(handle);
    expect(log[0].detail?.attributionReleased).toBe(false);
  });

  it("propagates a thrown inner.stop error unchanged (no attribution/tracking cleanup attempted)", async () => {
    const inner = new ScriptedProvider();
    inner.stopImpl = async () => {
      throw new Error("kill -9 permission denied");
    };
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker");
    const tracking = new FakeTracking();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking });

    const handle: ContainerHandle = { workerId: "w1", nativeId: "n1", kind: "process", startedAt: 0 };
    await expect(provider.stop(handle)).rejects.toThrow("kill -9 permission denied");

    // stop() never reaches the release step when inner.stop rejects.
    expect(reg.lookup("w1")).toBe("docker");
    expect(tracking.releaseCalls).toEqual([]);
  });
});

// ===========================================================================
// Concurrency: distinct ids don't interleave state corruptly
// ===========================================================================

describe("AttributedContainerProvider — concurrent spawns of distinct ids", () => {
  it("two concurrent spawns for different worker ids both attribute correctly with no cross-talk", async () => {
    const clock = makeClock(0);
    const inner = new ScriptedProvider(clock.now);
    // Stagger completion order: w1 resolves after w2 despite being called first,
    // to prove ordering isn't assumed anywhere in the decorator.
    const resolveOrder: Array<() => void> = [];
    inner.spawnImpl = (s) =>
      new Promise<ContainerHandle>((resolve) => {
        resolveOrder.push(() =>
          resolve({ workerId: s.workerId, nativeId: `native-${s.workerId}`, kind: "process", startedAt: clock.now() })
        );
      });
    const reg = new WorkerAttributionRegistry({ now: clock.now });
    const tracking = new FakeTracking();
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking, now: clock.now });

    const p1 = provider.spawn(spec({ workerId: "w1" }));
    const p2 = provider.spawn(spec({ workerId: "w2" }));

    // Resolve w2's inner.spawn first, then w1's.
    expect(resolveOrder).toHaveLength(2);
    resolveOrder[1]();
    resolveOrder[0]();

    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1.workerId).toBe("w1");
    expect(h2.workerId).toBe("w2");
    expect(reg.lookup("w1")).toBe("docker");
    expect(reg.lookup("w2")).toBe("docker");
    expect(reg.ids()).toEqual(["w1", "w2"]);
    expect(tracking.handles.size).toBe(2);
  });

  it("a rollback for one id never touches another id's attribution", async () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    const tracking = new FakeTracking();
    tracking.handles.set("w1", { workerId: "w1", backend: "docker", nativeId: "existing", state: "running", startedAt: 0 });
    const provider = new AttributedContainerProvider({ inner, backendName: "docker", registry: reg, tracking });

    await provider.spawn(spec({ workerId: "w2" })); // succeeds
    await expect(provider.spawn(spec({ workerId: "w1" }))).rejects.toThrow(); // fails + rolls back

    expect(reg.lookup("w2")).toBe("docker");
    expect(reg.lookup("w1")).toBeUndefined();
  });
});

// ===========================================================================
// Constructor validation
// ===========================================================================

describe("AttributedContainerProvider — constructor validation", () => {
  it("throws when inner is missing", () => {
    const reg = new WorkerAttributionRegistry();
    expect(() => new AttributedContainerProvider({ inner: undefined as unknown as ContainerProvider, backendName: "docker", registry: reg })).toThrow(RangeError);
  });

  it("throws when backendName is empty", () => {
    const inner = new ScriptedProvider();
    const reg = new WorkerAttributionRegistry();
    expect(() => new AttributedContainerProvider({ inner, backendName: "", registry: reg })).toThrow(RangeError);
  });

  it("throws when registry is missing", () => {
    const inner = new ScriptedProvider();
    expect(() => new AttributedContainerProvider({ inner, backendName: "docker", registry: undefined as unknown as WorkerAttributionRegistry })).toThrow(RangeError);
  });
});
