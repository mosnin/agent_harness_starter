import { describe, it, expect, vi } from "vitest";
import { BackendManager, type BackendManagerEvent } from "../manager";
import { FakeBackend } from "../fake-backend";
import type { BackendDescriptor } from "../descriptor";
import type { RemoteHandle, RemoteSpec, RemoteState, RemoteBackend } from "../backend";
import { CostAwareRouteBandit, type RouteBanditState } from "../route-bandit";
import {
  BanditRoutedProvisioner,
  type BanditProvisionerEvent,
  type BanditSnapshotStore,
} from "../bandit-provisioner";

// ===========================================================================
// Fixtures (matching the house convention set by route-bandit.test.ts /
// backend-manager.test.ts)
// ===========================================================================

/** Auto-incrementing clock: every call moves time forward, so elapsed-ms
 *  measurements taken across real await boundaries are provably non-zero
 *  without the test having to hand-tune advance() calls around internal
 *  BackendManager bookkeeping. */
function makeTickingClock(step = 10, start = 0) {
  let t = start;
  return () => {
    t += step;
    return t;
  };
}

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

function registerFake(
  mgr: BackendManager,
  name: string,
  opts: { available?: boolean } & Partial<BackendDescriptor> = {}
): void {
  const { available, ...descOverrides } = opts;
  mgr.register(new FakeBackend({ name, available: available ?? true }), descriptor(name, descOverrides));
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

/** A backend whose availability flips after its first `isAvailable()` call —
 *  used to exercise "probe flips between choose() and provision()". */
class FlippableBackend implements RemoteBackend {
  readonly name: string;
  calls = 0;
  constructor(name: string) {
    this.name = name;
  }
  async isAvailable(): Promise<boolean> {
    this.calls += 1;
    return this.calls === 1;
  }
  async provision(s: RemoteSpec): Promise<RemoteHandle> {
    return { workerId: s.workerId, backend: this.name, nativeId: `${this.name}-1`, state: "running", startedAt: 0 };
  }
  async terminate(): Promise<void> {
    /* no-op */
  }
  async status(): Promise<RemoteState> {
    return "running";
  }
  async logs(): Promise<string> {
    return "";
  }
}

/** In-memory `BanditSnapshotStore`, optionally set to reject on save. */
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

// ===========================================================================
// Constructor validation
// ===========================================================================

describe("BanditRoutedProvisioner — construction", () => {
  it("throws RangeError when opts.manager is not a BackendManager", () => {
    const mgr = new BackendManager();
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    expect(() => new BanditRoutedProvisioner({ manager: {} as BackendManager, bandit })).toThrow(RangeError);
  });

  it("throws RangeError when opts.bandit is not a CostAwareRouteBandit", () => {
    const mgr = new BackendManager();
    expect(() => new BanditRoutedProvisioner({ manager: mgr, bandit: {} as CostAwareRouteBandit })).toThrow(
      RangeError
    );
  });
});

// ===========================================================================
// Pinning rule
// ===========================================================================

describe("BanditRoutedProvisioner — pinning rule", () => {
  it("pins the manager's own provision to the bandit's exact pick and drives the real select/probe/telemetry path", async () => {
    const managerEvents = collector<BackendManagerEvent>();
    const mgr = new BackendManager({ onEvent: managerEvents.push });
    registerFake(mgr, "alpha");
    registerFake(mgr, "beta");
    registerFake(mgr, "gamma");
    const bandit = new CostAwareRouteBandit({ manager: mgr });

    const provisionerEvents = collector<BanditProvisionerEvent>();
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit, onEvent: provisionerEvents.push });

    const result = await provisioner.provision(spec("w1"));

    // The bandit's forced-exploration policy picks lexicographically first
    // among never-pulled survivors -> "alpha".
    expect(result.routing).toMatchObject({ source: "bandit" });
    if (result.routing.source !== "bandit") throw new Error("unreachable");
    expect(result.routing.decision.name).toBe("alpha");
    expect(result.backend).toBe("alpha");

    // The manager's OWN "selected" event fired with candidateCount 1 (every
    // other backend was excluded) and the bandit's exact name.
    const selected = managerEvents.events.filter((e) => e.type === "selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].backend).toBe("alpha");
    expect(selected[0].detail?.candidateCount).toBe(1);

    // The manager's real telemetry/provision path actually ran.
    expect(mgr.telemetry("alpha").provisions).toBe(1);
    expect(managerEvents.events.some((e) => e.type === "provisioned" && e.backend === "alpha")).toBe(true);

    // The provisioner reports its own "routed" event.
    const routed = provisionerEvents.events.filter((e) => e.type === "routed");
    expect(routed).toHaveLength(1);
    expect(routed[0].backend).toBe("alpha");
  });

  it("pins to the bandit's UCB-best pick (not the manager's own default scoring pick) once every arm has been pulled", async () => {
    const mgr = new BackendManager();
    // "pricey" scores worse on BackendManager's OWN static scoring (cost
    // term) but will be made to look better to the BANDIT via recorded
    // verified outcomes with near-zero measured cost.
    registerFake(mgr, "pricey", {
      cost: { perRunningHourUsd: 9, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" },
    });
    registerFake(mgr, "cheap", {
      cost: { perRunningHourUsd: 0.1, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" },
    });
    const bandit = new CostAwareRouteBandit({ manager: mgr, baselineUsdPerHour: 1 });
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit });

    // Force-explore both arms once each with clearly divergent outcomes.
    await bandit.recordOutcome("pricey", { verified: false, elapsedMs: 1000, usd: 5 });
    await Promise.resolve(bandit.recordOutcome("cheap", { verified: true, elapsedMs: 1000, usd: 0.001 }));

    const decisionOnly = await bandit.choose();
    expect(decisionOnly?.name).toBe("cheap");

    const result = await provisioner.provision(spec("w2"));
    expect(result.backend).toBe("cheap");
    if (result.routing.source !== "bandit") throw new Error("unreachable");
    expect(result.routing.decision.reason).toBe("ucb-best");
  });
});

// ===========================================================================
// Fallback matrix
// ===========================================================================

describe("BanditRoutedProvisioner — fallback matrix", () => {
  it("empty registry: falls back to manager.provision and surfaces the manager's own honest error unchanged", async () => {
    const mgr = new BackendManager();
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const events = collector<BanditProvisionerEvent>();
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit, onEvent: events.push });

    await expect(provisioner.provision(spec("w1"))).rejects.toThrow(
      "BackendManager.provision: no backend available matching requirements"
    );

    const fallback = events.events.filter((e) => e.type === "fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0].detail?.reason).toBe("no-candidate");
  });

  it("all-probes-false: falls back and the manager's provision throws its own honest error", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "down-a", { available: false });
    registerFake(mgr, "down-b", { available: false });
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit });

    await expect(provisioner.provision(spec("w1"))).rejects.toThrow(/no backend available/);
  });

  it("bandit throwing: falls back to manager.provision, reports bandit-error, never propagates the bandit's own exception", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "solo");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    // Monkeypatch this instance's choose() to simulate a bandit bug. Stays
    // `instanceof CostAwareRouteBandit` — every other real method (choose's
    // sibling recordOutcome/snapshot/arms) is untouched.
    bandit.choose = vi.fn().mockRejectedValue(new Error("bandit exploded"));

    const events = collector<BanditProvisionerEvent>();
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit, onEvent: events.push });

    const result = await provisioner.provision(spec("w1"));
    expect(result.backend).toBe("solo");
    expect(result.routing).toEqual({ source: "manager-fallback", reason: "bandit-error" });

    const fallback = events.events.filter((e) => e.type === "fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0].detail?.reason).toBe("bandit-error");
    expect(fallback[0].detail?.error).toBe("bandit exploded");
  });

  it("chosen backend's probe flips false between choose() and the pinned provision: manager's honest no-backend error propagates unchanged, and the bandit records a measured failed pull for the pinned name", async () => {
    const clock = makeTickingClock(10);
    const mgr = new BackendManager({ now: clock, probeTtlMs: 0 });
    const flippable = new FlippableBackend("flip");
    mgr.register(flippable, descriptor("flip"));
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit, now: clock });

    await expect(provisioner.provision(spec("w1"))).rejects.toThrow(
      "BackendManager.provision: no backend available matching requirements"
    );

    // choose() itself consumed one isAvailable() call (still available);
    // the pinned manager.provision()'s own fresh select()->probeAll() call
    // consumed the flip.
    expect(flippable.calls).toBeGreaterThanOrEqual(2);

    const arm = bandit.arm("flip");
    expect(arm.pulls).toBe(1);
    expect(arm.verified).toBe(0);
    // Measured via the injected (ticking) clock, never hardcoded.
    expect(arm.totalElapsedMs).toBeGreaterThan(0);
    expect(arm.totalUsd).toBe(0);
  });
});

// ===========================================================================
// Outcome integrity
// ===========================================================================

describe("BanditRoutedProvisioner — outcome integrity", () => {
  it("a pinned provision that throws for a non-probe reason records verified:false exactly once, then rethrows unchanged", async () => {
    const mgr = new BackendManager();
    class ThrowingBackend implements RemoteBackend {
      readonly name = "boom";
      async isAvailable() {
        return true;
      }
      async provision(): Promise<RemoteHandle> {
        throw new Error("provision exploded downstream");
      }
      async terminate() {}
      async status(): Promise<RemoteState> {
        return "failed";
      }
      async logs() {
        return "";
      }
    }
    mgr.register(new ThrowingBackend(), descriptor("boom"));
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit });

    await expect(provisioner.provision(spec("w1"))).rejects.toThrow("provision exploded downstream");
    await expect(provisioner.provision(spec("w2"))).rejects.toThrow("provision exploded downstream");

    // Two failing pinned attempts -> exactly two recorded pulls, not more
    // (no accidental double-recording per attempt).
    const arm = bandit.arm("boom");
    expect(arm.pulls).toBe(2);
    expect(arm.verified).toBe(0);
  });

  it("recordOutcome delegates to the real bandit and propagates RangeError for a malformed outcome unchanged", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "a");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const store = memoryStore();
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit, store });

    await expect(provisioner.recordOutcome("a", { verified: true, elapsedMs: -5, usd: 0 })).rejects.toThrow(
      RangeError
    );
    // Validation failed before persistence — nothing was saved, and no arm
    // was mutated.
    expect(store.saved).toHaveLength(0);
    expect(bandit.arm("a").pulls).toBe(0);
  });

  it("sequential pinned provisions across the forced-exploration schedule attribute pulls to the correct arm each, with no cross-contamination between arms", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "one");
    registerFake(mgr, "two");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit });

    // Forced exploration visits every never-pulled arm before any UCB
    // comparison, lexicographically-smallest-name first -> "one" then "two".
    // Choosing is a pure read of accumulated arm state, so "two" only
    // becomes the next forced-exploration pick once "one"'s outcome has
    // actually been recorded (choose() never "reserves" a candidate).
    const r1 = await provisioner.provision(spec("w1"));
    expect(r1.backend).toBe("one");
    await provisioner.recordOutcome("one", { verified: true, elapsedMs: 50, usd: 0.01 });

    const r2 = await provisioner.provision(spec("w2"));
    expect(r2.backend).toBe("two");

    // Recording out of the order the arms were pulled in must still land on
    // the correct arm — recordOutcome is keyed by the caller-passed backend
    // name, not by call/pull order.
    await provisioner.recordOutcome("two", { verified: false, elapsedMs: 75, usd: 0.02 });

    expect(bandit.arm("one")).toMatchObject({ pulls: 1, verified: 1, totalElapsedMs: 50, totalUsd: 0.01 });
    expect(bandit.arm("two")).toMatchObject({ pulls: 1, verified: 0, totalElapsedMs: 75, totalUsd: 0.02 });
  });
});

// ===========================================================================
// Persistence
// ===========================================================================

describe("BanditRoutedProvisioner — persistence", () => {
  it("recordOutcome best-effort persists via store.save and emits state-saved with the arm count", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "a");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const store = memoryStore();
    const events = collector<BanditProvisionerEvent>();
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit, store, onEvent: events.push });

    await provisioner.recordOutcome("a", { verified: true, elapsedMs: 10, usd: 0.01 });

    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].arms["a"].pulls).toBe(1);
    const savedEvents = events.events.filter((e) => e.type === "state-saved");
    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0].detail?.armCount).toBe(1);
  });

  it("store.save rejection is reported via state-save-failed and NEVER breaks recordOutcome or provisioning", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "a");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const store = memoryStore({ failSave: true });
    const events = collector<BanditProvisionerEvent>();
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit, store, onEvent: events.push });

    // Does not throw despite the store rejecting.
    await expect(provisioner.recordOutcome("a", { verified: true, elapsedMs: 10, usd: 0.01 })).resolves.toBeUndefined();
    expect(bandit.arm("a").pulls).toBe(1); // the real outcome still landed

    const failed = events.events.filter((e) => e.type === "state-save-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].detail?.error).toBe("disk full");

    // Provisioning itself is unaffected by a broken store.
    const result = await provisioner.provision(spec("w1"));
    expect(result.backend).toBe("a");
  });

  it("flush() persists the current snapshot even with no new outcome since the last save", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "a");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const store = memoryStore();
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit, store });

    await provisioner.flush();
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].arms).toEqual({});
  });

  it("flush() is a no-op without a configured store", async () => {
    const mgr = new BackendManager();
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit });
    await expect(provisioner.flush()).resolves.toBeUndefined();
  });

  it("snapshot round-trips through CostAwareRouteBandit.fromState after a simulated restart", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "a");
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const store = memoryStore();
    const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit, store });

    await provisioner.recordOutcome("a", { verified: true, elapsedMs: 120, usd: 0.03 });
    await provisioner.recordOutcome("a", { verified: false, elapsedMs: 80, usd: 0.01 });
    await provisioner.recordOutcome("b", { verified: true, elapsedMs: 200, usd: 0.05 });

    const persisted = store.saved[store.saved.length - 1];

    // Simulated restart: fresh manager + fresh bandit reconstructed purely
    // from the persisted snapshot.
    const freshMgr = new BackendManager();
    registerFake(freshMgr, "a");
    registerFake(freshMgr, "b");
    const restored = CostAwareRouteBandit.fromState({ manager: freshMgr }, persisted);

    for (const name of ["a", "b"]) {
      const before = bandit.arm(name);
      const after = restored.arm(name);
      expect(after.pulls).toBe(before.pulls);
      expect(after.verified).toBe(before.verified);
      expect(after.totalElapsedMs).toBe(before.totalElapsedMs);
      expect(after.totalUsd).toBe(before.totalUsd);
    }
  });
});

// ===========================================================================
// Determinism proof
// ===========================================================================

describe("BanditRoutedProvisioner — determinism", () => {
  it("an identical sequence of provision()/recordOutcome() calls yields identical bandit snapshots across two independent instances", async () => {
    function build() {
      const mgr = new BackendManager();
      registerFake(mgr, "x");
      registerFake(mgr, "y");
      const bandit = new CostAwareRouteBandit({ manager: mgr });
      const provisioner = new BanditRoutedProvisioner({ manager: mgr, bandit });
      return { mgr, bandit, provisioner };
    }

    const run1 = build();
    const run2 = build();

    async function drive(p: BanditRoutedProvisioner) {
      const r1 = await p.provision(spec("w1"));
      await p.recordOutcome(r1.backend, { verified: true, elapsedMs: 100, usd: 0.02 });
      const r2 = await p.provision(spec("w2"));
      await p.recordOutcome(r2.backend, { verified: false, elapsedMs: 50, usd: 0.01 });
      const r3 = await p.provision(spec("w3"));
      await p.recordOutcome(r3.backend, { verified: true, elapsedMs: 75, usd: 0.005 });
    }

    await drive(run1.provisioner);
    await drive(run2.provisioner);

    expect(run1.bandit.snapshot()).toEqual(run2.bandit.snapshot());
  });
});
