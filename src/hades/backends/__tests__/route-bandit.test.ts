import { describe, it, expect } from "vitest";
import { BackendManager } from "../manager";
import { FakeBackend } from "../fake-backend";
import type { BackendDescriptor } from "../descriptor";
import {
  CostAwareRouteBandit,
  ROUTE_BANDIT_STATE_VERSION,
  type RouteBanditState,
  type RouteDecision,
  type RouteOutcome,
} from "../route-bandit";

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

function outcome(o: Partial<RouteOutcome>): RouteOutcome {
  return { verified: true, elapsedMs: 100, usd: 0.01, ...o };
}

// ===========================================================================
// Edge matrix: candidate discovery
// ===========================================================================

describe("CostAwareRouteBandit — candidate discovery edge matrix", () => {
  it("returns undefined when no backends are registered", async () => {
    const mgr = new BackendManager();
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    await expect(bandit.choose()).resolves.toBeUndefined();
  });

  it("returns undefined when every candidate is unavailable", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "a", { available: false });
    registerFake(mgr, "b", { available: false });
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    await expect(bandit.choose()).resolves.toBeUndefined();
  });

  it("filters out an unavailable candidate but keeps an available one", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "down", { available: false });
    registerFake(mgr, "up", { available: true });
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const d = await bandit.choose();
    expect(d?.name).toBe("up");
    expect(d?.candidates.map((c) => c.name)).toEqual(["up"]);
  });

  it("filters by capabilities requirement", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "gpu-box", { capabilities: ["gpu"] });
    registerFake(mgr, "cpu-box", { capabilities: ["cpu"] });
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const d = await bandit.choose({ capabilities: ["gpu"] });
    expect(d?.candidates.map((c) => c.name)).toEqual(["gpu-box"]);
  });

  it("filters by maxRunningHourUsd requirement", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "cheap", { cost: { perRunningHourUsd: 0.5, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" } });
    registerFake(mgr, "pricey", { cost: { perRunningHourUsd: 5, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" } });
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const d = await bandit.choose({ maxRunningHourUsd: 1 });
    expect(d?.candidates.map((c) => c.name)).toEqual(["cheap"]);
  });

  it("filters by requireHibernate requirement", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "no-hibernate", { supportsHibernate: false });
    registerFake(mgr, "has-hibernate", { supportsHibernate: true });
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const d = await bandit.choose({ requireHibernate: true });
    expect(d?.candidates.map((c) => c.name)).toEqual(["has-hibernate"]);
  });

  it("filters by exclude requirement", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "blocked");
    registerFake(mgr, "allowed");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const d = await bandit.choose({ exclude: ["blocked"] });
    expect(d?.candidates.map((c) => c.name)).toEqual(["allowed"]);
  });
});

// ===========================================================================
// Forced exploration
// ===========================================================================

describe("CostAwareRouteBandit — forced exploration", () => {
  it("visits every arm exactly once, lexicographically, before any UCB decision", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "charlie");
    registerFake(mgr, "alpha");
    registerFake(mgr, "bravo");
    const bandit = new CostAwareRouteBandit({ manager: mgr });

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await bandit.choose();
      expect(d?.reason).toBe("forced-exploration");
      expect(d?.ucb).toBeNull();
      seen.push(d!.name);
      bandit.recordOutcome(d!.name, outcome({}));
    }
    expect(seen).toEqual(["alpha", "bravo", "charlie"]);

    const fourth = await bandit.choose();
    expect(fourth?.reason).toBe("ucb-best");
    expect(fourth?.ucb).not.toBeNull();
  });
});

// ===========================================================================
// NaN-safety / denominator guards
// ===========================================================================

describe("CostAwareRouteBandit — NaN-safety", () => {
  it("is finite when pulls=1, verified=0, usd=0, elapsedMs=0 (both terms zero)", () => {
    const mgr = new BackendManager();
    registerFake(mgr, "x");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    bandit.recordOutcome("x", { verified: false, elapsedMs: 0, usd: 0 });
    const arm = bandit.arm("x");
    expect(Number.isFinite(arm.meanReward)).toBe(true);
    expect(arm.ucb).not.toBeNull();
    expect(Number.isFinite(arm.ucb as number)).toBe(true);
    expect(arm.meanReward).toBe(0); // verifiedShare is 0 regardless of costEfficiency
  });

  it("is finite when elapsedMs=0 but usd>0 (baselineCost=0, spentPerVerified>0)", () => {
    const mgr = new BackendManager();
    registerFake(mgr, "x");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    bandit.recordOutcome("x", { verified: true, elapsedMs: 0, usd: 5 });
    const arm = bandit.arm("x");
    expect(Number.isFinite(arm.meanReward)).toBe(true);
    expect(Number.isFinite(arm.ucb as number)).toBe(true);
    expect(arm.meanReward).toBe(0); // baselineCost 0 / (0 + positive) => costEfficiency 0
  });

  it("is finite when usd=0 but elapsedMs>0 (baselineCost>0, spentPerVerified=0)", () => {
    const mgr = new BackendManager();
    registerFake(mgr, "x");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    bandit.recordOutcome("x", { verified: true, elapsedMs: 1000, usd: 0 });
    const arm = bandit.arm("x");
    expect(Number.isFinite(arm.meanReward)).toBe(true);
    expect(Number.isFinite(arm.ucb as number)).toBe(true);
    expect(arm.meanReward).toBe(1); // costEfficiency saturates to 1, verifiedShare 1
  });

  it("a never-pulled arm has meanReward 0 and ucb null", () => {
    const mgr = new BackendManager();
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    const arm = bandit.arm("never-seen");
    expect(arm).toEqual({ pulls: 0, verified: 0, totalElapsedMs: 0, totalUsd: 0, meanReward: 0, ucb: null });
  });
});

// ===========================================================================
// recordOutcome validation
// ===========================================================================

describe("CostAwareRouteBandit — recordOutcome validation", () => {
  const mgr = new BackendManager();
  registerFake(mgr, "x");

  it.each([
    ["NaN elapsedMs", { elapsedMs: NaN }],
    ["negative elapsedMs", { elapsedMs: -1 }],
    ["Infinity elapsedMs", { elapsedMs: Infinity }],
    ["-Infinity elapsedMs", { elapsedMs: -Infinity }],
    ["NaN usd", { usd: NaN }],
    ["negative usd", { usd: -0.01 }],
    ["Infinity usd", { usd: Infinity }],
    ["non-boolean verified", { verified: 1 as unknown as boolean }],
  ])("throws RangeError on %s", (_label, bad) => {
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    expect(() => bandit.recordOutcome("x", outcome(bad))).toThrow(RangeError);
  });

  it("accepts elapsedMs=0 and usd=0 as valid (boundary, not an error)", () => {
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    expect(() => bandit.recordOutcome("x", { verified: true, elapsedMs: 0, usd: 0 })).not.toThrow();
    expect(bandit.arm("x").pulls).toBe(1);
  });

  it("records an outcome for a name the manager has never registered", () => {
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    expect(() => bandit.recordOutcome("ghost-backend", outcome({}))).not.toThrow();
    const arm = bandit.arm("ghost-backend");
    expect(arm.pulls).toBe(1);
    expect(Number.isFinite(arm.meanReward)).toBe(true);
  });
});

// ===========================================================================
// Constructor validation
// ===========================================================================

describe("CostAwareRouteBandit — constructor validation", () => {
  const mgr = new BackendManager();

  it("throws RangeError when opts.manager is missing/wrong type", () => {
    expect(() => new CostAwareRouteBandit({} as unknown as { manager: BackendManager })).toThrow(RangeError);
    expect(() => new CostAwareRouteBandit({ manager: {} as unknown as BackendManager })).toThrow(RangeError);
  });

  it.each([
    ["explorationC negative", { explorationC: -1 }],
    ["explorationC NaN", { explorationC: NaN }],
    ["explorationC Infinity", { explorationC: Infinity }],
    ["baselineUsdPerHour zero", { baselineUsdPerHour: 0 }],
    ["baselineUsdPerHour negative", { baselineUsdPerHour: -1 }],
    ["baselineUsdPerHour NaN", { baselineUsdPerHour: NaN }],
    ["baselineUsdPerHour Infinity", { baselineUsdPerHour: Infinity }],
  ])("throws RangeError on %s", (_label, bad) => {
    expect(() => new CostAwareRouteBandit({ manager: mgr, ...bad })).toThrow(RangeError);
  });

  it("accepts explorationC=0 (boundary, valid — pure exploitation)", () => {
    expect(() => new CostAwareRouteBandit({ manager: mgr, explorationC: 0 })).not.toThrow();
  });

  it("uses documented defaults when options are omitted", async () => {
    const m = new BackendManager();
    registerFake(m, "x");
    const bandit = new CostAwareRouteBandit({ manager: m });
    bandit.recordOutcome("x", outcome({}));
    bandit.recordOutcome("x", outcome({}));
    const withDefault = bandit.arm("x").ucb;
    const bandit2 = new CostAwareRouteBandit({ manager: m, explorationC: 1.4, baselineUsdPerHour: 0.1 });
    bandit2.recordOutcome("x", outcome({}));
    bandit2.recordOutcome("x", outcome({}));
    expect(bandit2.arm("x").ucb).toBe(withDefault);
  });
});

// ===========================================================================
// State: snapshot / fromState
// ===========================================================================

describe("CostAwareRouteBandit — state persistence", () => {
  function setupManager(): BackendManager {
    const mgr = new BackendManager();
    registerFake(mgr, "a");
    registerFake(mgr, "b");
    return mgr;
  }

  it("round-trips snapshot -> fromState, preserving every arm and future decisions", async () => {
    const mgr = setupManager();
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    bandit.recordOutcome("a", { verified: true, elapsedMs: 120, usd: 0.02 });
    bandit.recordOutcome("b", { verified: false, elapsedMs: 300, usd: 0.5 });
    bandit.recordOutcome("a", { verified: true, elapsedMs: 90, usd: 0.01 });

    const snap = bandit.snapshot();
    expect(snap.version).toBe(ROUTE_BANDIT_STATE_VERSION);
    expect(Object.keys(snap.arms)).toEqual(["a", "b"]); // canonical (sorted) key order

    const restored = CostAwareRouteBandit.fromState({ manager: mgr }, snap);
    expect(restored.arms()).toEqual(bandit.arms());

    const d1 = await bandit.choose();
    const d2 = await restored.choose();
    expect(d2).toEqual(d1);
  });

  it("snapshot is deep-copied — mutating the bandit afterward doesn't affect the earlier snapshot", () => {
    const mgr = setupManager();
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    bandit.recordOutcome("a", outcome({}));
    const snap1 = bandit.snapshot();
    bandit.recordOutcome("a", outcome({}));
    expect(snap1.arms.a.pulls).toBe(1);
    expect(bandit.snapshot().arms.a.pulls).toBe(2);
  });

  it("fromState rejects wrong version, yielding a fresh empty bandit", () => {
    const mgr = setupManager();
    const badState: RouteBanditState = { version: 999, arms: { a: { pulls: 5, verified: 5, totalElapsedMs: 100, totalUsd: 1 } } };
    const bandit = CostAwareRouteBandit.fromState({ manager: mgr }, badState);
    expect(bandit.arms()).toEqual({});
  });

  it("drops individually-malformed arm entries while keeping the good ones", () => {
    const mgr = setupManager();
    const state = {
      version: ROUTE_BANDIT_STATE_VERSION,
      arms: {
        a: { pulls: 3, verified: 2, totalElapsedMs: 300, totalUsd: 0.3 }, // good
        b: { pulls: -1, verified: 0, totalElapsedMs: 0, totalUsd: 0 }, // bad: negative pulls
        c: { pulls: 2, verified: 5, totalElapsedMs: 10, totalUsd: 0 }, // bad: verified > pulls
        d: { pulls: 1, verified: 1, totalElapsedMs: NaN, totalUsd: 0 }, // bad: NaN
        e: "not an object", // bad: not an object
        f: { pulls: 1, verified: 1, totalElapsedMs: 5, totalUsd: -1 }, // bad: negative usd
      },
    };
    const bandit = CostAwareRouteBandit.fromState({ manager: mgr }, state);
    expect(Object.keys(bandit.arms())).toEqual(["a"]);
    expect(bandit.arm("a").pulls).toBe(3);
  });

  it.each([
    ["null", null],
    ["a number", 42],
    ["an array", [1, 2, 3]],
    ["a string", "garbage"],
    ["an object with no arms field", { version: ROUTE_BANDIT_STATE_VERSION }],
    ["an object with arms as an array", { version: ROUTE_BANDIT_STATE_VERSION, arms: [] }],
  ])("tolerates garbage input (%s) without throwing, yielding an empty bandit", (_label, garbage) => {
    const mgr = setupManager();
    let bandit: CostAwareRouteBandit | undefined;
    expect(() => {
      bandit = CostAwareRouteBandit.fromState({ manager: mgr }, garbage);
    }).not.toThrow();
    expect(bandit!.arms()).toEqual({});
  });
});

// ===========================================================================
// Determinism
// ===========================================================================

describe("CostAwareRouteBandit — determinism", () => {
  it("identical histories yield identical decision sequences", async () => {
    async function run(): Promise<RouteDecision[]> {
      const mgr = new BackendManager();
      registerFake(mgr, "a");
      registerFake(mgr, "b");
      registerFake(mgr, "c");
      const bandit = new CostAwareRouteBandit({ manager: mgr });
      const script: RouteOutcome[] = [
        { verified: true, elapsedMs: 100, usd: 0.01 },
        { verified: false, elapsedMs: 500, usd: 0.2 },
        { verified: true, elapsedMs: 50, usd: 0.02 },
        { verified: true, elapsedMs: 80, usd: 0.03 },
        { verified: false, elapsedMs: 400, usd: 0.15 },
      ];
      const decisions: RouteDecision[] = [];
      for (let i = 0; i < 15; i++) {
        const d = await bandit.choose();
        if (!d) continue;
        decisions.push(d);
        bandit.recordOutcome(d.name, script[i % script.length]);
      }
      return decisions;
    }

    const run1 = await run();
    const run2 = await run();
    expect(run2).toEqual(run1);
    expect(run1.length).toBe(15);
  });
});

// ===========================================================================
// No fabricated-price fields
// ===========================================================================

describe("CostAwareRouteBandit — RouteDecision never exposes anything price-shaped", () => {
  it("has no key that could be mistaken for a dollar figure", async () => {
    const mgr = new BackendManager();
    registerFake(mgr, "a");
    registerFake(mgr, "b");
    const bandit = new CostAwareRouteBandit({ manager: mgr });
    bandit.recordOutcome("a", outcome({}));
    bandit.recordOutcome("b", outcome({}));
    const d = await bandit.choose();
    expect(d).toBeDefined();

    const suspicious = /usd|price|\$|dollar|cost/i;
    function walkKeys(v: unknown, path: string[] = []): void {
      if (Array.isArray(v)) {
        v.forEach((item, i) => walkKeys(item, [...path, String(i)]));
        return;
      }
      if (v !== null && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          expect(suspicious.test(k)).toBe(false);
          walkKeys(val, [...path, k]);
        }
      }
    }
    walkKeys(d);
    // The known, locked field set — asserted explicitly as a belt-and-braces check.
    expect(Object.keys(d!).sort()).toEqual(["candidates", "name", "reason", "ucb"]);
    for (const c of d!.candidates) {
      expect(Object.keys(c).sort()).toEqual(["name", "pulls", "ucb"]);
    }
  });
});

// ===========================================================================
// Mathematical honesty: convergence to the empirically better arm
// ===========================================================================

describe("CostAwareRouteBandit — convergence to the higher verified-work-per-dollar arm", () => {
  /** Runs N rounds of choose()/recordOutcome() where `goodName` always reports a
   *  cheap, verified outcome and `badName` always reports an expensive, unverified
   *  one. Returns the per-arm pull counts after N rounds. */
  async function runConvergence(goodName: string, badName: string, rounds: number): Promise<Record<string, number>> {
    const clock = makeClock();
    const mgr = new BackendManager({ now: clock.now });
    registerFake(mgr, goodName);
    registerFake(mgr, badName);
    const bandit = new CostAwareRouteBandit({ manager: mgr });

    // Outcome magnitudes are chosen relative to the default `baselineUsdPerHour`
    // (0.10) so the cost-efficiency term is meaningfully informative rather than
    // degenerate: the "good" arm's implied hourly rate (0.05 usd/hr) sits below
    // baseline (costEfficiency ~0.67), while the "bad" arm is never verified at
    // all, so its reward is 0 regardless of cost — a large, unambiguous gap.
    const ONE_HOUR_MS = 3_600_000;
    for (let i = 0; i < rounds; i++) {
      const d = await bandit.choose();
      if (!d) throw new Error("expected a decision every round");
      clock.advance(10);
      if (d.name === goodName) {
        bandit.recordOutcome(goodName, { verified: true, elapsedMs: ONE_HOUR_MS, usd: 0.05 });
      } else {
        bandit.recordOutcome(badName, { verified: false, elapsedMs: ONE_HOUR_MS, usd: 2.0 });
      }
    }
    const arms = bandit.arms();
    return { [goodName]: arms[goodName].pulls, [badName]: arms[badName].pulls };
  }

  it("converges pulls toward the cheap, verified arm within 200 rounds", async () => {
    const N = 200;
    const counts = await runConvergence("good-arm", "bad-arm", N);
    expect(counts["good-arm"] + counts["bad-arm"]).toBe(N);
    // The dominant arm should take the overwhelming majority of pulls.
    expect(counts["good-arm"]).toBeGreaterThan(N * 0.8);
    // The inferior arm still gets pulled beyond its single forced-exploration
    // visit (UCB1 guarantees non-zero, but bounded, continued exploration)...
    expect(counts["bad-arm"]).toBeGreaterThan(1);
    // ...and that continued exploration stays within a generous multiple of
    // the classic UCB1 O(ln n) bound rather than growing linearly with n.
    expect(counts["bad-arm"]).toBeLessThan(20 * Math.log(N));
  });

  it("flipping which stream is good flips which arm dominates — no bias toward either name", async () => {
    const N = 150;
    // "zzz-arm" is lexicographically LAST; giving it the good stream proves
    // convergence tracks the measured reward, not name/tie-break order.
    const counts = await runConvergence("zzz-arm", "aaa-arm", N);
    expect(counts["zzz-arm"]).toBeGreaterThan(counts["aaa-arm"]);
    expect(counts["zzz-arm"]).toBeGreaterThan(N * 0.8);
  });
});
