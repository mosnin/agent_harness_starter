import { describe, it, expect, beforeEach } from "vitest";
import { BackendManager, type BackendManagerEvent } from "../manager";
import { FakeBackend } from "../fake-backend";
import type { BackendDescriptor } from "../descriptor";
import type { RemoteSpec } from "../backend";

/** Deterministic injectable clock: advances only when the test tells it to. */
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
    set: (ms: number) => {
      t = ms;
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

describe("BackendManager — registration", () => {
  it("registers a backend + descriptor and exposes it", () => {
    const clock = makeClock();
    const mgr = new BackendManager({ now: clock.now });
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    mgr.register(fb, descriptor());
    expect(mgr.descriptors().map((d) => d.name)).toEqual(["fake"]);
    expect(mgr.descriptor("fake")?.kind).toBe("fake");
    expect(mgr.registry.get("fake")).toBe(fb);
  });

  it("throws on backend/descriptor name mismatch", () => {
    const mgr = new BackendManager();
    const fb = new FakeBackend({ name: "fake" });
    expect(() => mgr.register(fb, descriptor({ name: "other" }))).toThrow(/name/i);
  });

  it("throws on duplicate registration", () => {
    const mgr = new BackendManager();
    mgr.register(new FakeBackend({ name: "fake" }), descriptor());
    expect(() => mgr.register(new FakeBackend({ name: "fake" }), descriptor())).toThrow(/already registered/i);
  });

  it("emits exactly one 'registered' event", () => {
    const events: BackendManagerEvent[] = [];
    const mgr = new BackendManager({ onEvent: (e) => events.push(e) });
    mgr.register(new FakeBackend({ name: "fake" }), descriptor());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "registered", backend: "fake" });
  });
});

describe("BackendManager — probing (TTL cache)", () => {
  it("caches an available result within the TTL, re-checks after expiry", async () => {
    const clock = makeClock();
    let calls = 0;
    const mgr = new BackendManager({ now: clock.now, probeTtlMs: 1000 });
    const fb = new FakeBackend({ name: "fake" });
    const originalIsAvailable = fb.isAvailable.bind(fb);
    fb.isAvailable = async () => {
      calls += 1;
      return originalIsAvailable();
    };
    mgr.register(fb, descriptor());

    expect(await mgr.probe("fake")).toBe(true);
    expect(calls).toBe(1);
    clock.advance(500);
    expect(await mgr.probe("fake")).toBe(true);
    expect(calls).toBe(1); // still cached
    clock.advance(600); // total 1100 > ttl 1000
    expect(await mgr.probe("fake")).toBe(true);
    expect(calls).toBe(2);
  });

  it("isolates the TTL cache per backend name", async () => {
    const clock = makeClock();
    const mgr = new BackendManager({ now: clock.now, probeTtlMs: 1000 });
    mgr.register(new FakeBackend({ name: "a", available: true }), descriptor({ name: "a" }));
    mgr.register(new FakeBackend({ name: "b", available: false }), descriptor({ name: "b" }));
    expect(await mgr.probe("a")).toBe(true);
    expect(await mgr.probe("b")).toBe(false);
    clock.advance(500);
    // Still within TTL for both, independently cached.
    expect(await mgr.probe("a")).toBe(true);
    expect(await mgr.probe("b")).toBe(false);
  });

  it("records a throwing isAvailable() as unavailable rather than propagating", async () => {
    const events: BackendManagerEvent[] = [];
    const mgr = new BackendManager({ onEvent: (e) => events.push(e) });
    const fb = new FakeBackend({ name: "flaky" });
    fb.isAvailable = async () => {
      throw new Error("connection refused");
    };
    mgr.register(fb, descriptor({ name: "flaky" }));
    await expect(mgr.probe("flaky")).resolves.toBe(false);
    const probeEvent = events.find((e) => e.type === "probe");
    expect(probeEvent?.detail?.available).toBe(false);
    expect(String(probeEvent?.detail?.error)).toMatch(/connection refused/);
  });

  it("probeAll covers every registered backend", async () => {
    const mgr = new BackendManager();
    mgr.register(new FakeBackend({ name: "a", available: true }), descriptor({ name: "a" }));
    mgr.register(new FakeBackend({ name: "b", available: false }), descriptor({ name: "b" }));
    expect(await mgr.probeAll()).toEqual({ a: true, b: false });
  });

  it("probe() throws for an unregistered backend name", async () => {
    const mgr = new BackendManager();
    await expect(mgr.probe("nope")).rejects.toThrow(/unknown backend/i);
  });
});

describe("BackendManager — select()", () => {
  it("returns undefined for an empty registry instead of throwing", async () => {
    const mgr = new BackendManager();
    await expect(mgr.select()).resolves.toBeUndefined();
  });

  it("returns undefined when every backend is unavailable", async () => {
    const mgr = new BackendManager();
    mgr.register(new FakeBackend({ name: "a", available: false }), descriptor({ name: "a" }));
    mgr.register(new FakeBackend({ name: "b", available: false }), descriptor({ name: "b" }));
    await expect(mgr.select()).resolves.toBeUndefined();
  });

  it("never selects an unavailable backend even if it scores best on paper", async () => {
    const mgr = new BackendManager();
    // Unavailable backend is strictly cheaper (would score higher) than the available one.
    mgr.register(
      new FakeBackend({ name: "cheap-but-down", available: false }),
      descriptor({ name: "cheap-but-down", cost: { perRunningHourUsd: 0.01, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" } })
    );
    mgr.register(new FakeBackend({ name: "up", available: true }), descriptor({ name: "up", cost: { perRunningHourUsd: 5, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" } }));
    const sel = await mgr.select();
    expect(sel?.name).toBe("up");
  });

  it("picks the highest-scoring available match", async () => {
    const mgr = new BackendManager();
    mgr.register(
      new FakeBackend({ name: "expensive" }),
      descriptor({ name: "expensive", cost: { perRunningHourUsd: 9, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" } })
    );
    mgr.register(
      new FakeBackend({ name: "cheap" }),
      descriptor({ name: "cheap", cost: { perRunningHourUsd: 0.1, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" } })
    );
    const sel = await mgr.select();
    expect(sel?.name).toBe("cheap");
  });

  it("requireHibernate excludes non-hibernating backends from selection", async () => {
    const mgr = new BackendManager();
    mgr.register(new FakeBackend({ name: "ssh-like", supportsHibernate: false }), descriptor({ name: "ssh-like", supportsHibernate: false }));
    const sel = await mgr.select({ requireHibernate: true });
    expect(sel).toBeUndefined();
  });

  it("maxRunningHourUsd is a hard filter during selection, not a soft weight", async () => {
    const mgr = new BackendManager();
    mgr.register(
      new FakeBackend({ name: "pricey" }),
      descriptor({ name: "pricey", cost: { perRunningHourUsd: 50, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" } })
    );
    const sel = await mgr.select({ maxRunningHourUsd: 1 });
    expect(sel).toBeUndefined();
  });

  it("exclude[] removes a backend from selection even when it's the only candidate", async () => {
    const mgr = new BackendManager();
    mgr.register(new FakeBackend({ name: "only" }), descriptor({ name: "only" }));
    expect((await mgr.select())?.name).toBe("only");
    expect(await mgr.select({ exclude: ["only"] })).toBeUndefined();
  });

  it("emits exactly one 'selected' event per call, with backend undefined when nothing qualifies", async () => {
    const events: BackendManagerEvent[] = [];
    const mgr = new BackendManager({ onEvent: (e) => events.push(e) });
    await mgr.select();
    const selectedEvents = events.filter((e) => e.type === "selected");
    expect(selectedEvents).toHaveLength(1);
    expect(selectedEvents[0].backend).toBeUndefined();
  });
});

describe("BackendManager — provision telemetry", () => {
  it("measures real provision latency via the injected clock", async () => {
    const clock = makeClock();
    const mgr = new BackendManager({ now: clock.now });
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const originalProvision = fb.provision.bind(fb);
    fb.provision = async (s) => {
      clock.advance(250); // simulate real provisioning taking time
      return originalProvision(s);
    };
    mgr.register(fb, descriptor());
    await mgr.provision(spec("w1"));
    expect(mgr.telemetry("fake").provisionLatencyEmaMs).toBe(250);
  });

  it("computes the latency EMA by hand across >=3 samples", async () => {
    const clock = makeClock();
    const alpha = 0.3;
    const mgr = new BackendManager({ now: clock.now, latencyEmaAlpha: alpha });
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const originalProvision = fb.provision.bind(fb);
    const delays = [100, 300, 50, 900];
    let i = 0;
    fb.provision = async (s) => {
      clock.advance(delays[i]);
      i += 1;
      return originalProvision(s);
    };
    mgr.register(fb, descriptor());

    let expectedEma: number | null = null;
    for (let n = 0; n < delays.length; n++) {
      await mgr.provision(spec(`w${n}`));
      expectedEma = expectedEma == null ? delays[n] : alpha * delays[n] + (1 - alpha) * expectedEma;
      expect(mgr.telemetry("fake").provisionLatencyEmaMs).toBeCloseTo(expectedEma!, 9);
    }
  });

  it("increments provisions on success and applies the configured per-provision charge", async () => {
    const mgr = new BackendManager();
    mgr.register(new FakeBackend({ name: "fake" }), descriptor({ cost: { perRunningHourUsd: 0, perHibernatedHourUsd: 0, perProvisionUsd: 0.25, source: "configured" } }));
    await mgr.provision(spec("w1"));
    await mgr.provision(spec("w2"));
    const t = mgr.telemetry("fake");
    expect(t.provisions).toBe(2);
    expect(t.failures).toBe(0);
    expect(t.accruedUsd).toBeCloseTo(0.5, 9);
  });

  it("provision failure increments failures and rethrows the original error unchanged", async () => {
    const mgr = new BackendManager();
    const fb = new FakeBackend({ name: "fake" });
    const boom = new Error("boom-specific-failure");
    fb.provision = async () => {
      throw boom;
    };
    mgr.register(fb, descriptor());
    await expect(mgr.provision(spec("w1"))).rejects.toBe(boom);
    const t = mgr.telemetry("fake");
    expect(t.failures).toBe(1);
    expect(t.provisions).toBe(1);
  });

  it("throws (without a specific backend) when no backend matches requirements", async () => {
    const mgr = new BackendManager();
    mgr.register(new FakeBackend({ name: "fake" }), descriptor());
    await expect(mgr.provision(spec("w1"), { capabilities: ["nonexistent"] })).rejects.toThrow(/no backend available/i);
  });

  it("telemetry() for an unknown backend returns a zeroed snapshot, not a crash", () => {
    const mgr = new BackendManager();
    expect(mgr.telemetry("never-heard-of-it")).toEqual({
      provisions: 0,
      failures: 0,
      provisionLatencyEmaMs: null,
      runningMs: 0,
      hibernatedMs: 0,
      accruedUsd: 0,
    });
  });
});

describe("BackendManager — duration/cost accounting across a full lifecycle", () => {
  it("accrues running/hibernated ms and USD exactly under an injected clock through provision->hibernate->wake->terminate, including a double-hibernate no-op", async () => {
    const clock = makeClock();
    const mgr = new BackendManager({ now: clock.now });
    const runRate = 2; // USD/hr
    const hibRate = 0.2; // USD/hr
    mgr.register(
      new FakeBackend({ name: "fake", now: clock.now }),
      descriptor({ cost: { perRunningHourUsd: runRate, perHibernatedHourUsd: hibRate, perProvisionUsd: 0, source: "configured" } })
    );

    await mgr.provision(spec("w1"));
    // Running for 1 hour (3_600_000ms).
    clock.advance(3_600_000);
    await mgr.hibernate("w1");
    let t = mgr.telemetry("fake");
    expect(t.runningMs).toBe(3_600_000);
    expect(t.accruedUsd).toBeCloseTo(runRate * 1, 9);

    // Double-hibernate: must not add any more running or hibernated duration.
    clock.advance(1_000_000);
    await mgr.hibernate("w1");
    t = mgr.telemetry("fake");
    expect(t.runningMs).toBe(3_600_000); // unchanged
    expect(t.hibernatedMs).toBe(0); // the no-op call did not start counting early

    // Hibernated for 30 minutes (1_800_000ms) from the *first* hibernate call.
    // We already advanced 1_000_000ms above; advance the remaining to reach 1_800_000 total.
    clock.advance(800_000);
    await mgr.wake("w1");
    t = mgr.telemetry("fake");
    expect(t.hibernatedMs).toBe(1_800_000);
    expect(t.accruedUsd).toBeCloseTo(runRate * 1 + hibRate * 0.5, 9);

    // Running again for 10 minutes (600_000ms), then terminate.
    clock.advance(600_000);
    await mgr.terminate("w1");
    t = mgr.telemetry("fake");
    expect(t.runningMs).toBe(3_600_000 + 600_000);
    expect(t.hibernatedMs).toBe(1_800_000);
    expect(t.accruedUsd).toBeCloseTo(runRate * (1 + 600_000 / 3_600_000) + hibRate * 0.5, 9);
  });

  it("a double-wake call (already running) does not double-count or re-wake", async () => {
    const clock = makeClock();
    const mgr = new BackendManager({ now: clock.now });
    mgr.register(new FakeBackend({ name: "fake", now: clock.now }), descriptor());
    await mgr.provision(spec("w1"));
    clock.advance(1000);
    // Wake while already running: should be a no-op, no hibernated duration created.
    const handle = await mgr.wake("w1");
    expect(handle?.state).toBe("running");
    const t = mgr.telemetry("fake");
    expect(t.hibernatedMs).toBe(0);
  });

  it("hibernate/wake/terminate on an unknown worker return undefined/void without throwing", async () => {
    const mgr = new BackendManager();
    mgr.register(new FakeBackend({ name: "fake" }), descriptor());
    await expect(mgr.hibernate("ghost")).resolves.toBeUndefined();
    await expect(mgr.wake("ghost")).resolves.toBeUndefined();
    await expect(mgr.terminate("ghost")).resolves.toBeUndefined();
  });

  it("status() with no underlying state change does not fabricate running duration", async () => {
    const clock = makeClock();
    const mgr = new BackendManager({ now: clock.now });
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    mgr.register(fb, descriptor());
    await mgr.provision(spec("w1"));
    clock.advance(500_000);
    expect(await mgr.status("w1")).toBe("running");
    const t = mgr.telemetry("fake");
    expect(t.runningMs).toBe(0);
  });

  it("status() reconciles duration accounting when the backend self-transitions outside the manager's own calls", async () => {
    const clock = makeClock();
    const mgr = new BackendManager({ now: clock.now });
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    mgr.register(fb, descriptor());
    await mgr.provision(spec("w1"));
    clock.advance(700_000);
    // Simulate the remote instance dying on its own (bypassing manager.terminate).
    const handle = mgr.registry.handle("w1")!;
    await fb.terminate(handle);
    expect(await mgr.status("w1")).toBe("stopped");
    const t = mgr.telemetry("fake");
    expect(t.runningMs).toBe(700_000);
    // Further time passing after the untracked stop must not keep accruing.
    clock.advance(1_000_000);
    expect(await mgr.status("w1")).toBe("stopped");
    expect(mgr.telemetry("fake").runningMs).toBe(700_000);
  });
});

describe("BackendManager — event stream (exact ordered sequence)", () => {
  it("emits the exact ordered sequence for a full lifecycle", async () => {
    const clock = makeClock();
    const events: BackendManagerEvent[] = [];
    const mgr = new BackendManager({ now: clock.now, onEvent: (e) => events.push(e) });
    mgr.register(new FakeBackend({ name: "fake", now: clock.now }), descriptor());

    await mgr.probe("fake");
    await mgr.provision(spec("w1")); // internally: select -> provisioned
    clock.advance(1000);
    await mgr.hibernate("w1");
    clock.advance(1000);
    await mgr.wake("w1");
    await mgr.terminate("w1");

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "registered",
      "probe",
      "selected", // from provision()'s internal select()
      "provisioned",
      "hibernated",
      "woken",
      "terminated",
    ]);
  });

  it("emits swept + reconciled telemetry for an idle sweep, exactly one swept event", async () => {
    const clock = makeClock();
    const events: BackendManagerEvent[] = [];
    const mgr = new BackendManager({ now: clock.now, onEvent: (e) => events.push(e) });
    mgr.register(new FakeBackend({ name: "fake", now: clock.now }), descriptor());
    // Give the scaler a short idle threshold by constructing our own manager
    // isn't configurable directly, so we drive time far enough past the
    // ScaleToZeroManager default (5 minutes) instead.
    await mgr.provision(spec("w1"));
    clock.advance(6 * 60 * 1000); // 6 minutes idle > default 5-minute idle threshold
    const swept = await mgr.sweepIdle();
    expect(swept).toEqual(["w1"]);
    const sweptEvents = events.filter((e) => e.type === "swept");
    expect(sweptEvents).toHaveLength(1);
    expect(sweptEvents[0].detail?.workerIds).toEqual(["w1"]);
    const t = mgr.telemetry("fake");
    expect(t.runningMs).toBe(6 * 60 * 1000);
  });

  it("provision-failed carries the failing backend name and error detail", async () => {
    const events: BackendManagerEvent[] = [];
    const mgr = new BackendManager({ onEvent: (e) => events.push(e) });
    const fb = new FakeBackend({ name: "fake" });
    fb.provision = async () => {
      throw new Error("nope");
    };
    mgr.register(fb, descriptor());
    await expect(mgr.provision(spec("w1"))).rejects.toThrow("nope");
    const failEvent = events.find((e) => e.type === "provision-failed");
    expect(failEvent?.backend).toBe("fake");
    expect(String(failEvent?.detail?.error)).toMatch(/nope/);
  });
});

describe("BackendManager — list()", () => {
  it("lists tracked handles with descriptor and idle duration", async () => {
    const clock = makeClock();
    const mgr = new BackendManager({ now: clock.now });
    mgr.register(new FakeBackend({ name: "fake", now: clock.now }), descriptor());
    await mgr.provision(spec("w1"));
    clock.advance(2000);
    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].handle.workerId).toBe("w1");
    expect(list[0].descriptor.name).toBe("fake");
    expect(list[0].idleMs).toBe(2000);
  });

  it("reflects termination by no longer listing the worker", async () => {
    const mgr = new BackendManager();
    mgr.register(new FakeBackend({ name: "fake" }), descriptor());
    await mgr.provision(spec("w1"));
    await mgr.terminate("w1");
    expect(mgr.list()).toHaveLength(0);
  });
});

describe("BackendManager — uses the real registry/scaler/FakeBackend (no hand-rolled stubs)", () => {
  let mgr: BackendManager;
  beforeEach(() => {
    mgr = new BackendManager();
  });

  it("registry is a real RemoteBackendRegistry instance reachable for external composition", async () => {
    mgr.register(new FakeBackend({ name: "fake" }), descriptor());
    expect(mgr.registry.names()).toEqual(["fake"]);
    await mgr.provision(spec("w1"));
    expect(mgr.registry.handle("w1")?.backend).toBe("fake");
  });

  it("scaler is a real ScaleToZeroManager instance sharing accounting with the manager", async () => {
    mgr.register(new FakeBackend({ name: "fake" }), descriptor());
    await mgr.provision(spec("w1"));
    expect(mgr.scaler.idleFor("w1")).toBe(0);
  });

  it("a non-hibernating FakeBackend surfaces the registry's real error through hibernate()", async () => {
    mgr.register(new FakeBackend({ name: "plain", supportsHibernate: false }), descriptor({ name: "plain", supportsHibernate: false }));
    await mgr.provision(spec("w1"));
    await expect(mgr.hibernate("w1")).rejects.toThrow(/does not support hibernate/i);
  });
});
