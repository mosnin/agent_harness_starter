import { describe, it, expect } from "vitest";
import {
  compareCandidates,
  matchesRequirements,
  scoreBackend,
  ZERO_TELEMETRY,
  type BackendCostModel,
  type BackendDescriptor,
  type BackendRequirements,
  type BackendTelemetrySnapshot,
} from "../descriptor";

function cost(overrides: Partial<BackendCostModel> = {}): BackendCostModel {
  return {
    perRunningHourUsd: 1,
    perHibernatedHourUsd: 0,
    perProvisionUsd: 0.01,
    source: "configured",
    ...overrides,
  };
}

function descriptor(overrides: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    name: "ssh-1",
    kind: "ssh",
    capabilities: ["shell", "docker"],
    cost: cost(),
    supportsHibernate: false,
    locality: "remote",
    ...overrides,
  };
}

function telemetry(overrides: Partial<BackendTelemetrySnapshot> = {}): BackendTelemetrySnapshot {
  return { ...ZERO_TELEMETRY, ...overrides };
}

describe("matchesRequirements", () => {
  it("passes an empty requirement set", () => {
    expect(matchesRequirements(descriptor(), {})).toBe(true);
  });

  it("requires every listed capability to be present", () => {
    const d = descriptor({ capabilities: ["shell", "docker", "gpu"] });
    expect(matchesRequirements(d, { capabilities: ["shell", "gpu"] })).toBe(true);
    expect(matchesRequirements(d, { capabilities: ["shell", "tpu"] })).toBe(false);
  });

  it("treats an empty capabilities array as no requirement", () => {
    expect(matchesRequirements(descriptor({ capabilities: [] }), { capabilities: [] })).toBe(true);
  });

  it("requireHibernate excludes non-hibernating descriptors", () => {
    const nonHibernating = descriptor({ supportsHibernate: false });
    const hibernating = descriptor({ name: "modal-1", supportsHibernate: true });
    expect(matchesRequirements(nonHibernating, { requireHibernate: true })).toBe(false);
    expect(matchesRequirements(hibernating, { requireHibernate: true })).toBe(true);
    // Not requiring hibernate never excludes on this basis either way.
    expect(matchesRequirements(nonHibernating, { requireHibernate: false })).toBe(true);
    expect(matchesRequirements(nonHibernating, {})).toBe(true);
  });

  it("maxRunningHourUsd is a hard filter: at-limit passes, over-limit fails", () => {
    const d = descriptor({ cost: cost({ perRunningHourUsd: 2.5 }) });
    expect(matchesRequirements(d, { maxRunningHourUsd: 2.5 })).toBe(true);
    expect(matchesRequirements(d, { maxRunningHourUsd: 2.4999 })).toBe(false);
    expect(matchesRequirements(d, { maxRunningHourUsd: 100 })).toBe(true);
  });

  it("exclude[] wins over everything else, even a perfectly matching descriptor", () => {
    const d = descriptor({
      name: "cheap-perfect",
      capabilities: ["shell", "docker", "gpu"],
      cost: cost({ perRunningHourUsd: 0.01 }),
      supportsHibernate: true,
      locality: "local",
    });
    const r: BackendRequirements = {
      capabilities: ["shell"],
      maxRunningHourUsd: 100,
      requireHibernate: true,
      preferLocality: "local",
      exclude: ["cheap-perfect"],
    };
    expect(matchesRequirements(d, r)).toBe(false);
  });

  it("exclude[] is a no-op for names not in the list", () => {
    const d = descriptor({ name: "keep-me" });
    expect(matchesRequirements(d, { exclude: ["someone-else"] })).toBe(true);
  });

  it("combines multiple hard filters with AND semantics", () => {
    const d = descriptor({
      capabilities: ["shell"],
      cost: cost({ perRunningHourUsd: 5 }),
      supportsHibernate: false,
    });
    const passingSubset: BackendRequirements = { capabilities: ["shell"], maxRunningHourUsd: 10 };
    const failingOnHibernate: BackendRequirements = { capabilities: ["shell"], requireHibernate: true };
    const failingOnCost: BackendRequirements = { capabilities: ["shell"], maxRunningHourUsd: 1 };
    expect(matchesRequirements(d, passingSubset)).toBe(true);
    expect(matchesRequirements(d, failingOnHibernate)).toBe(false);
    expect(matchesRequirements(d, failingOnCost)).toBe(false);
  });
});

describe("scoreBackend — total order, finiteness, no NaN", () => {
  it("never returns NaN or non-finite for a variety of descriptors/requirements/telemetry", () => {
    const descriptors = [
      descriptor({ name: "a", cost: cost({ perRunningHourUsd: 0 }) }),
      descriptor({ name: "b", cost: cost({ perRunningHourUsd: 999 }) }),
      descriptor({ name: "c", capabilities: [] }),
      descriptor({ name: "d", supportsHibernate: true, locality: "local" }),
    ];
    const requirements: BackendRequirements[] = [
      {},
      { capabilities: ["shell"] },
      { capabilities: ["nonexistent"] },
      { preferLocality: "local" },
      { preferLocality: "remote" },
    ];
    const telemetries: (BackendTelemetrySnapshot | undefined)[] = [
      undefined,
      telemetry(),
      telemetry({ provisions: 10, failures: 3, provisionLatencyEmaMs: 500 }),
      telemetry({ provisions: 1, failures: 1, provisionLatencyEmaMs: 999_999 }),
      telemetry({ provisions: 0, failures: 0, provisionLatencyEmaMs: 0 }),
    ];
    for (const d of descriptors) {
      for (const r of requirements) {
        for (const t of telemetries) {
          const score = scoreBackend(d, r, t);
          expect(Number.isFinite(score)).toBe(true);
          expect(Number.isNaN(score)).toBe(false);
        }
      }
    }
  });

  it("stays within the documented [0, 100] bound", () => {
    const d = descriptor({ cost: cost({ perRunningHourUsd: 0 }) });
    const best = scoreBackend(d, { capabilities: ["shell"] }, telemetry({ provisions: 100, failures: 0, provisionLatencyEmaMs: 0 }));
    expect(best).toBeLessThanOrEqual(100);
    expect(best).toBeGreaterThanOrEqual(0);

    const worst = scoreBackend(
      descriptor({ cost: cost({ perRunningHourUsd: 999 }) }),
      { capabilities: ["shell"] },
      telemetry({ provisions: 10, failures: 10, provisionLatencyEmaMs: 999_999 })
    );
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(worst).toBeLessThanOrEqual(100);
  });

  it("rewards cheaper backends over otherwise-identical expensive ones", () => {
    const cheap = descriptor({ name: "cheap", cost: cost({ perRunningHourUsd: 0.1 }) });
    const expensive = descriptor({ name: "expensive", cost: cost({ perRunningHourUsd: 5 }) });
    const r: BackendRequirements = {};
    const t = telemetry();
    expect(scoreBackend(cheap, r, t)).toBeGreaterThan(scoreBackend(expensive, r, t));
  });

  it("rewards a lower measured failure rate", () => {
    const d = descriptor();
    const reliable = telemetry({ provisions: 100, failures: 0 });
    const flaky = telemetry({ provisions: 100, failures: 50 });
    expect(scoreBackend(d, {}, reliable)).toBeGreaterThan(scoreBackend(d, {}, flaky));
  });

  it("rewards lower provision latency EMA", () => {
    const d = descriptor();
    const fast = telemetry({ provisionLatencyEmaMs: 100 });
    const slow = telemetry({ provisionLatencyEmaMs: 50_000 });
    expect(scoreBackend(d, {}, fast)).toBeGreaterThan(scoreBackend(d, {}, slow));
  });

  it("treats undefined telemetry the same as a zeroed snapshot (neutral prior)", () => {
    const d = descriptor();
    const r: BackendRequirements = { capabilities: ["shell"] };
    expect(scoreBackend(d, r, undefined)).toBe(scoreBackend(d, r, telemetry()));
  });

  it("rewards locality matching preferLocality, all else equal", () => {
    const local = descriptor({ name: "loc", locality: "local" });
    const remote = descriptor({ name: "rem", locality: "remote" });
    const t = telemetry();
    expect(scoreBackend(local, { preferLocality: "local" }, t)).toBeGreaterThan(
      scoreBackend(remote, { preferLocality: "local" }, t)
    );
    // No preference: locality contributes equally regardless.
    expect(scoreBackend(local, {}, t)).toBe(
      scoreBackend({ ...remote, name: local.name }, {}, t)
    );
  });

  it("rewards satisfying more of the requested capabilities", () => {
    const d = descriptor({ capabilities: ["shell"] });
    const r: BackendRequirements = {};
    const partial = scoreBackend(d, { capabilities: ["shell", "gpu"] }, telemetry());
    const full = scoreBackend(d, { capabilities: ["shell"] }, telemetry());
    expect(full).toBeGreaterThan(partial);
    void r;
  });
});

describe("compareCandidates — total order with lexicographic tie-break", () => {
  it("orders strictly by score descending when scores differ", () => {
    const list = [
      { name: "z", score: 1 },
      { name: "a", score: 5 },
      { name: "m", score: 3 },
    ];
    list.sort(compareCandidates);
    expect(list.map((c) => c.name)).toEqual(["a", "m", "z"]);
  });

  it("breaks exact ties by name ascending", () => {
    const list = [
      { name: "zeta", score: 7 },
      { name: "alpha", score: 7 },
      { name: "mid", score: 7 },
    ];
    list.sort(compareCandidates);
    expect(list.map((c) => c.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("is a consistent total order (antisymmetric, transitive) across a mixed batch", () => {
    const list = [
      { name: "b", score: 2 },
      { name: "a", score: 2 },
      { name: "c", score: 10 },
      { name: "d", score: -5 },
      { name: "e", score: 2 },
    ];
    list.sort(compareCandidates);
    // Non-increasing score, and within any equal-score run, ascending name.
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].score).toBeGreaterThanOrEqual(list[i].score);
      if (list[i - 1].score === list[i].score) {
        expect(list[i - 1].name < list[i].name).toBe(true);
      }
    }
    expect(list.map((c) => c.name)).toEqual(["c", "a", "b", "e", "d"]);
  });

  it("stable no matter the input order (idempotent re-sort)", () => {
    const list = [
      { name: "x", score: 1 },
      { name: "y", score: 1 },
      { name: "w", score: 1 },
    ];
    const once = [...list].sort(compareCandidates).map((c) => c.name);
    const reversed = [...list].reverse().sort(compareCandidates).map((c) => c.name);
    expect(once).toEqual(reversed);
    expect(once).toEqual(["w", "x", "y"]);
  });
});
