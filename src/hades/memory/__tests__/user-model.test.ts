import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  DialecticUserModel,
  combineEvidence,
  normalizeAttribute,
  normalizeValue,
  reconcileBelief,
  type BeliefEvidence,
  type BeliefAssertion,
  type UserBelief,
  type EvidencePolarity,
  type UserModelSnapshot,
} from "../user-model";
import { tierConfidenceFloor, type TierId } from "../../styx/tiers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0_CAP = tierConfidenceFloor("T0-execution", 0.05); // 0.95
const T1_CAP = tierConfidenceFloor("T1-reference", 0.05); // 0.975
const T4_CAP = 0.6;

const BASE_NOW = 1_700_000_000_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HALF_LIFE_MS = 30 * ONE_DAY_MS;

let evId = 0;

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function mkEvidence(overrides: Partial<BeliefEvidence> = {}): BeliefEvidence {
  const excerpt = overrides.excerpt ?? `fact #${evId}`;
  return {
    id: overrides.id ?? `ev-${evId++}`,
    excerpt,
    excerptSha256: overrides.excerptSha256 ?? sha(excerpt),
    sessionId: overrides.sessionId,
    polarity: overrides.polarity ?? "supports",
    tier: overrides.tier ?? "T0-execution",
    weight: overrides.weight ?? 0.9,
    certificate: overrides.certificate,
    certificateValid: overrides.certificateValid,
    verdict: overrides.verdict,
    at: overrides.at ?? BASE_NOW,
  };
}

function mkAssertion(
  overrides: Partial<Omit<BeliefAssertion, "evidence">> & { evidence?: Partial<BeliefEvidence> } = {},
): BeliefAssertion {
  const { evidence: evOverrides, ...rest } = overrides;
  return {
    attribute: "favorite-language",
    value: "TypeScript",
    now: BASE_NOW,
    ...rest,
    evidence: mkEvidence(evOverrides),
  };
}

// ===========================================================================
// normalizeAttribute / normalizeValue
// ===========================================================================

describe("normalizeAttribute", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeAttribute("  Home   City ")).toBe("home city");
  });

  it("collapses unicode whitespace (nbsp, em-space) like ordinary spaces", () => {
    expect(normalizeAttribute("Home City")).toBe("home city");
    expect(normalizeAttribute("Home City")).toBe("home city");
  });

  it("throws TypeError on non-string input", () => {
    // @ts-expect-error deliberately wrong type
    expect(() => normalizeAttribute(42)).toThrow(TypeError);
  });

  it("throws TypeError on empty string", () => {
    expect(() => normalizeAttribute("")).toThrow(TypeError);
  });

  it("throws TypeError on whitespace-only string", () => {
    expect(() => normalizeAttribute("    \t\n ")).toThrow(TypeError);
  });
});

describe("normalizeValue", () => {
  it("lowercases, trims, and collapses whitespace but never throws on empty", () => {
    expect(normalizeValue("  Berlin, Germany ")).toBe("berlin, germany");
    expect(normalizeValue("")).toBe("");
    expect(normalizeValue("   ")).toBe("");
  });

  it("throws TypeError on non-string input", () => {
    // @ts-expect-error deliberately wrong type
    expect(() => normalizeValue(null)).toThrow(TypeError);
  });
});

// ===========================================================================
// combineEvidence
// ===========================================================================

describe("combineEvidence — noisy-OR math", () => {
  it("hand-computed: two supporting items combine as 1-(1-w1)(1-w2)", () => {
    const evidence = [
      mkEvidence({ weight: 0.5, tier: "T0-execution", at: BASE_NOW }),
      mkEvidence({ weight: 0.3, tier: "T0-execution", at: BASE_NOW }),
    ];
    const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    // 1 - (1-0.5)*(1-0.3) = 1 - 0.35 = 0.65
    expect(result).toBeCloseTo(0.65, 10);
  });

  it("hand-computed: three supporting items", () => {
    const evidence = [
      mkEvidence({ weight: 0.2, tier: "T0-execution", at: BASE_NOW }),
      mkEvidence({ weight: 0.4, tier: "T0-execution", at: BASE_NOW }),
      mkEvidence({ weight: 0.1, tier: "T0-execution", at: BASE_NOW }),
    ];
    const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    const expected = 1 - (1 - 0.2) * (1 - 0.4) * (1 - 0.1);
    expect(result).toBeCloseTo(expected, 10);
  });

  it("empty evidence combines to 0", () => {
    expect(combineEvidence([], BASE_NOW, DEFAULT_HALF_LIFE_MS)).toBe(0);
  });

  it("only-contradicting evidence combines to 0 (no support to erode)", () => {
    const evidence = [mkEvidence({ polarity: "contradicts", weight: 0.9, tier: "T0-execution" })];
    expect(combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS)).toBe(0);
  });

  it("only-retracting evidence combines to 0", () => {
    const evidence = [mkEvidence({ polarity: "retracts", weight: 0.9, tier: "T0-execution" })];
    expect(combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS)).toBe(0);
  });
});

describe("combineEvidence — decay", () => {
  it("evidence exactly one half-life old contributes at half weight", () => {
    const evidence = [mkEvidence({ weight: 1, tier: "T0-execution", at: BASE_NOW - DEFAULT_HALF_LIFE_MS })];
    const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    expect(result).toBeCloseTo(0.5, 6);
  });

  it("evidence two half-lives old contributes at quarter weight", () => {
    const evidence = [mkEvidence({ weight: 1, tier: "T0-execution", at: BASE_NOW - 2 * DEFAULT_HALF_LIFE_MS })];
    const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    expect(result).toBeCloseTo(0.25, 6);
  });

  it("future-dated evidence never contributes more than full weight (no amplification)", () => {
    const evidence = [mkEvidence({ weight: 0.4, tier: "T0-execution", at: BASE_NOW + 10 * DEFAULT_HALF_LIFE_MS })];
    const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    expect(result).toBeCloseTo(0.4, 6);
    expect(result).toBeLessThanOrEqual(0.4 + 1e-9);
  });
});

describe("combineEvidence — contradiction/retraction penalty", () => {
  it("contradicting evidence multiplicatively erodes the supported confidence", () => {
    const evidence = [
      mkEvidence({ polarity: "supports", weight: 0.9, tier: "T0-execution", at: BASE_NOW }),
      mkEvidence({ polarity: "contradicts", weight: 0.5, tier: "T0-execution", at: BASE_NOW }),
    ];
    const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    // noisyOr(0.9) * (1-0.5) = 0.9 * 0.5 = 0.45
    expect(result).toBeCloseTo(0.45, 10);
  });

  it("retracting evidence applies the same penalty shape as contradicting", () => {
    const supportsOnly = combineEvidence(
      [mkEvidence({ polarity: "supports", weight: 0.9, tier: "T0-execution", at: BASE_NOW })],
      BASE_NOW,
      DEFAULT_HALF_LIFE_MS,
    );
    const withRetraction = combineEvidence(
      [
        mkEvidence({ polarity: "supports", weight: 0.9, tier: "T0-execution", at: BASE_NOW }),
        mkEvidence({ polarity: "retracts", weight: 0.5, tier: "T0-execution", at: BASE_NOW }),
      ],
      BASE_NOW,
      DEFAULT_HALF_LIFE_MS,
    );
    expect(withRetraction).toBeCloseTo(supportsOnly * 0.5, 10);
    expect(withRetraction).toBeLessThan(supportsOnly);
  });
});

describe("combineEvidence — tier cap enforcement", () => {
  it("ten T4-consistency reinforcements asymptote toward but never exceed 0.6", () => {
    let prev = 0;
    for (let n = 1; n <= 10; n++) {
      const evidence = Array.from({ length: n }, () => mkEvidence({ weight: 0.9, tier: "T4-consistency", at: BASE_NOW }));
      const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
      expect(result).toBeLessThanOrEqual(T4_CAP + 1e-12);
      expect(result).toBeGreaterThanOrEqual(prev - 1e-12); // monotonically non-decreasing
      prev = result;
    }
    // With 10 items at weight 0.9 the raw noisy-OR is ~1 - 0.1^10, so the cap is what binds.
    expect(prev).toBeCloseTo(T4_CAP, 6);
  });

  it("a single certified T0/T1 item lifts the cap above the T4 ceiling", () => {
    const manyT4 = Array.from({ length: 10 }, () => mkEvidence({ weight: 0.9, tier: "T4-consistency", at: BASE_NOW }));
    const t4Only = combineEvidence(manyT4, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    expect(t4Only).toBeCloseTo(T4_CAP, 6);

    const withT0 = combineEvidence(
      [...manyT4, mkEvidence({ weight: 0.99, tier: "T0-execution", at: BASE_NOW })],
      BASE_NOW,
      DEFAULT_HALF_LIFE_MS,
    );
    expect(withT0).toBeGreaterThan(T4_CAP);
    expect(withT0).toBeLessThanOrEqual(T0_CAP + 1e-9);
  });

  it("cap is the max tierCap across SUPPORTING evidence only — a contradicting T0 item cannot lift it", () => {
    const evidence = [
      mkEvidence({ polarity: "supports", weight: 0.99, tier: "T4-consistency", at: BASE_NOW }),
      mkEvidence({ polarity: "contradicts", weight: 0.01, tier: "T0-execution", at: BASE_NOW }),
    ];
    const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    expect(result).toBeLessThanOrEqual(T4_CAP + 1e-9);
  });
});

describe("combineEvidence — never NaN out", () => {
  it("non-finite weight clamps to 0 contribution instead of propagating NaN", () => {
    const evidence = [mkEvidence({ weight: Number.NaN, tier: "T0-execution", at: BASE_NOW })];
    const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(0);
  });

  it("Infinity weight clamps to full contribution (1), not Infinity", () => {
    const evidence = [mkEvidence({ weight: Number.POSITIVE_INFINITY, tier: "T0-execution", at: BASE_NOW })];
    const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeCloseTo(T0_CAP, 6);
  });

  it("non-finite timestamp falls back to `now` (no decay) rather than producing NaN", () => {
    const evidence = [mkEvidence({ weight: 0.5, tier: "T0-execution", at: Number.NaN })];
    const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
    expect(result).toBeCloseTo(0.5, 6);
  });

  it("non-finite `now` and non-finite halfLifeMs never crash or NaN", () => {
    const evidence = [mkEvidence({ weight: 0.5, tier: "T0-execution", at: BASE_NOW })];
    expect(Number.isFinite(combineEvidence(evidence, Number.NaN, DEFAULT_HALF_LIFE_MS))).toBe(true);
    expect(Number.isFinite(combineEvidence(evidence, BASE_NOW, Number.NaN))).toBe(true);
    expect(Number.isFinite(combineEvidence(evidence, BASE_NOW, 0))).toBe(true);
    expect(Number.isFinite(combineEvidence(evidence, BASE_NOW, -100))).toBe(true);
  });
});

describe("combineEvidence — property loop: always in [0,1] and never above cap", () => {
  const tiers: TierId[] = ["T0-execution", "T1-reference", "T2-genrm", "T3-agreement", "T4-consistency"];
  const polarities: EvidencePolarity[] = ["supports", "contradicts", "retracts"];

  function tierCapFor(tier: TierId): number {
    return tier === "T4-consistency" ? 0.6 : tierConfidenceFloor(tier, 0.05);
  }

  it("holds across 300 random evidence sets", () => {
    let seed = 42;
    const rand = () => {
      // deterministic LCG so failures are reproducible
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let trial = 0; trial < 300; trial++) {
      const n = Math.floor(rand() * 8);
      const evidence: BeliefEvidence[] = [];
      let expectedCap = 0;
      let sawSupport = false;
      for (let i = 0; i < n; i++) {
        const polarity = polarities[Math.floor(rand() * polarities.length)];
        const tier = tiers[Math.floor(rand() * tiers.length)];
        const weight = rand();
        const at = BASE_NOW - Math.floor(rand() * 5 * DEFAULT_HALF_LIFE_MS);
        evidence.push(mkEvidence({ polarity, tier, weight, at }));
        if (polarity === "supports") {
          sawSupport = true;
          expectedCap = Math.max(expectedCap, tierCapFor(tier));
        }
      }
      const result = combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
      if (!sawSupport) {
        expect(result).toBe(0);
      } else {
        expect(result).toBeLessThanOrEqual(expectedCap + 1e-9);
      }
    }
  });
});

// ===========================================================================
// reconcileBelief
// ===========================================================================

function mkExistingBelief(overrides: Partial<UserBelief> = {}): UserBelief {
  const evidence = overrides.evidence ?? [mkEvidence({ weight: 0.6, tier: "T1-reference", at: BASE_NOW })];
  return {
    attribute: "favorite-language",
    value: "Python",
    confidence: combineEvidence(evidence, BASE_NOW, DEFAULT_HALF_LIFE_MS),
    status: "asserted",
    salience: 1,
    evidence,
    createdAt: BASE_NOW,
    updatedAt: BASE_NOW,
    revisions: 0,
    supersededValues: [],
    ...overrides,
  };
}

const RECONCILE_OPTS = { now: BASE_NOW, halfLifeMs: DEFAULT_HALF_LIFE_MS, contestMargin: 0.15 };

describe("reconcileBelief", () => {
  it("no existing belief → created", () => {
    const decision = reconcileBelief(undefined, mkAssertion({ value: "Rust" }), RECONCILE_OPTS);
    expect(decision).toBe("created");
  });

  it("same normalized value + supports → reinforced", () => {
    const existing = mkExistingBelief({ value: "Python" });
    const decision = reconcileBelief(existing, mkAssertion({ value: "  PYTHON  " }), RECONCILE_OPTS);
    expect(decision).toBe("reinforced");
  });

  it("same normalized value + retracts → retracted", () => {
    const existing = mkExistingBelief({ value: "Python" });
    const decision = reconcileBelief(
      existing,
      mkAssertion({ value: "Python", evidence: { polarity: "retracts" } }),
      RECONCILE_OPTS,
    );
    expect(decision).toBe("retracted");
  });

  it("same value + contradicts → contested (documented extension)", () => {
    const existing = mkExistingBelief({ value: "Python" });
    const decision = reconcileBelief(
      existing,
      mkAssertion({ value: "Python", evidence: { polarity: "contradicts" } }),
      RECONCILE_OPTS,
    );
    expect(decision).toBe("contested");
  });

  it("different value, hypothetical confidence exceeds existing decayed by > margin → revised", () => {
    // existing decayed confidence: single T1 item weight 0.6 (cap 0.975 non-binding) → 0.6
    const existing = mkExistingBelief({ value: "Python" });
    const decision = reconcileBelief(
      existing,
      mkAssertion({ value: "Rust", evidence: { weight: 0.95, tier: "T0-execution", at: BASE_NOW } }),
      RECONCILE_OPTS,
    );
    expect(decision).toBe("revised");
  });

  it("different value, within ± margin of existing decayed confidence → contested", () => {
    const existing = mkExistingBelief({ value: "Python" }); // decayed ≈ 0.6
    const decision = reconcileBelief(
      existing,
      mkAssertion({ value: "Rust", evidence: { weight: 0.65, tier: "T1-reference", at: BASE_NOW } }), // hypothetical ≈ 0.65, diff 0.05
      RECONCILE_OPTS,
    );
    expect(decision).toBe("contested");
  });

  it("different value, meaningfully weaker → ignored", () => {
    const existing = mkExistingBelief({ value: "Python" }); // decayed ≈ 0.6
    const decision = reconcileBelief(
      existing,
      mkAssertion({ value: "Rust", evidence: { weight: 0.1, tier: "T4-consistency", at: BASE_NOW } }), // hypothetical ≈ 0.1
      RECONCILE_OPTS,
    );
    expect(decision).toBe("ignored");
  });

  it("is pure: calling it twice with identical inputs never mutates `existing`", () => {
    const existing = mkExistingBelief({ value: "Python" });
    const snapshotBefore = JSON.stringify(existing);
    reconcileBelief(existing, mkAssertion({ value: "Rust", evidence: { weight: 0.95, tier: "T0-execution" } }), RECONCILE_OPTS);
    expect(JSON.stringify(existing)).toBe(snapshotBefore);
  });
});

// ===========================================================================
// DialecticUserModel — the structural confidence invariant
// ===========================================================================

describe("DialecticUserModel — confidence is always evidence-derived", () => {
  it("assert() recomputes confidence via combineEvidence after every mutation kind", () => {
    let clock = BASE_NOW;
    const model = new DialecticUserModel({ now: () => clock, halfLifeMs: DEFAULT_HALF_LIFE_MS });

    model.assert(mkAssertion({ attribute: "language", value: "Python", evidence: { weight: 0.6, tier: "T1-reference" } }));
    let belief = model.get("language")!;
    expect(belief.confidence).toBeCloseTo(combineEvidence(belief.evidence, belief.updatedAt, DEFAULT_HALF_LIFE_MS), 12);

    clock += ONE_DAY_MS;
    model.assert(mkAssertion({ attribute: "language", value: "Python", evidence: { weight: 0.4, tier: "T1-reference" } }));
    belief = model.get("language")!;
    expect(belief.confidence).toBeCloseTo(combineEvidence(belief.evidence, belief.updatedAt, DEFAULT_HALF_LIFE_MS), 12);

    clock += ONE_DAY_MS;
    model.assert(mkAssertion({ attribute: "language", value: "Rust", evidence: { weight: 0.95, tier: "T0-execution" } }));
    belief = model.get("language")!;
    expect(belief.confidence).toBeCloseTo(combineEvidence(belief.evidence, belief.updatedAt, DEFAULT_HALF_LIFE_MS), 12);
  });

  it("a random walk of assertions never leaves a belief whose stored confidence exceeds its evidence-derived value", () => {
    let clock = BASE_NOW;
    const model = new DialecticUserModel({ now: () => clock, halfLifeMs: DEFAULT_HALF_LIFE_MS });
    const attrs = ["a", "b", "c"];
    const values = ["one", "two", "three"];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let i = 0; i < 100; i++) {
      clock += Math.floor(rand() * ONE_DAY_MS);
      const attribute = attrs[Math.floor(rand() * attrs.length)];
      const value = values[Math.floor(rand() * values.length)];
      const tier = (["T0-execution", "T2-genrm", "T4-consistency"] as const)[Math.floor(rand() * 3)];
      const polarity: EvidencePolarity = rand() < 0.85 ? "supports" : rand() < 0.5 ? "contradicts" : "retracts";
      model.assert(mkAssertion({ attribute, value, evidence: { weight: rand(), tier, polarity } }));
    }

    for (const belief of model.all()) {
      const derived = combineEvidence(belief.evidence, belief.updatedAt, DEFAULT_HALF_LIFE_MS);
      expect(belief.confidence).toBeCloseTo(derived, 10);
      expect(belief.confidence).toBeLessThanOrEqual(1);
      expect(belief.confidence).toBeGreaterThanOrEqual(0);
    }
  });

  it("fromJSON never trusts a tampered stored confidence — it is re-derived down", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW, halfLifeMs: DEFAULT_HALF_LIFE_MS });
    model.assert(mkAssertion({ attribute: "trust-test", value: "low", evidence: { weight: 0.1, tier: "T4-consistency" } }));
    const snap = model.toJSON();

    // Directly construct a tampered snapshot with a wildly inflated confidence.
    const tampered: UserModelSnapshot = {
      version: 1,
      beliefs: snap.beliefs.map((b) => ({ ...b, confidence: 0.999, status: "asserted" as const })),
    };

    const reloaded = DialecticUserModel.fromJSON(tampered, { now: () => BASE_NOW, halfLifeMs: DEFAULT_HALF_LIFE_MS });
    const belief = reloaded.get("trust-test")!;
    expect(belief.confidence).not.toBeCloseTo(0.999, 2);
    expect(belief.confidence).toBeCloseTo(
      combineEvidence(belief.evidence, belief.updatedAt, DEFAULT_HALF_LIFE_MS),
      12,
    );
    expect(belief.confidence).toBeLessThan(0.5);
    // And because the honestly-derived confidence is below the default floor,
    // status must also be corrected away from the tampered "asserted".
    expect(belief.status).toBe("abstained");
  });
});

// ===========================================================================
// DialecticUserModel — decay & abstention
// ===========================================================================

describe("DialecticUserModel — decay & abstention", () => {
  it("a belief above the assert floor drops into abstained purely by advancing the injected clock", () => {
    let clock = BASE_NOW;
    const model = new DialecticUserModel({ now: () => clock, halfLifeMs: ONE_DAY_MS, assertFloor: 0.55 });
    model.assert(mkAssertion({ attribute: "mood", value: "happy", evidence: { weight: 0.9, tier: "T0-execution" } }));

    expect(model.asserted().map((b) => b.attribute)).toContain("mood");
    expect(model.abstained().map((b) => b.attribute)).not.toContain("mood");
    expect(model.describe()).toMatch(/- mood: happy/);

    // Advance far past several half-lives without touching the belief again.
    clock += 10 * ONE_DAY_MS;

    expect(model.asserted().map((b) => b.attribute)).not.toContain("mood");
    expect(model.abstained().map((b) => b.attribute)).toContain("mood");
    const description = model.describe();
    expect(description).not.toMatch(/happy/);
    expect(description).toMatch(/Abstaining on:\n- mood/);

    // The stored (as-of-last-mutation) status/confidence fields are untouched —
    // only the live, read-time decayed view moved.
    const stored = model.get("mood")!;
    expect(stored.status).toBe("asserted");
  });

  it("decayedConfidence() never mutates the belief it inspects", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW, halfLifeMs: ONE_DAY_MS });
    model.assert(mkAssertion({ attribute: "mood", value: "happy", evidence: { weight: 0.9, tier: "T0-execution" } }));
    const before = model.get("mood")!;
    model.decayedConfidence(before, BASE_NOW + 100 * ONE_DAY_MS);
    const after = model.get("mood")!;
    expect(after).toEqual(before);
  });
});

// ===========================================================================
// DialecticUserModel — dialectic paths via assert()
// ===========================================================================

describe("DialecticUserModel — dialectic paths", () => {
  it("created: first assertion for an attribute", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    const decision = model.assert(mkAssertion({ attribute: "os", value: "Linux", evidence: { weight: 0.8, tier: "T1-reference" } }));
    expect(decision).toBe("created");
    const belief = model.get("os")!;
    expect(belief.value).toBe("Linux");
    expect(belief.revisions).toBe(0);
    expect(belief.evidence).toHaveLength(1);
  });

  it("reinforce: re-asserting the SAME evidence id does not inflate confidence (dedup, adversarial-resistant)", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    const evidence = mkEvidence({ weight: 0.7, tier: "T1-reference", id: "dup-1" });
    model.assert({ attribute: "os", value: "Linux", evidence });
    const first = model.get("os")!;

    for (let i = 0; i < 5; i++) {
      const decision = model.assert({ attribute: "os", value: "Linux", evidence: { ...evidence } });
      expect(decision).toBe("reinforced");
    }
    const after = model.get("os")!;
    expect(after.evidence).toHaveLength(1);
    expect(after.confidence).toBeCloseTo(first.confidence, 12);
  });

  it("reinforce: genuinely new evidence for the same value does grow the ledger and can change confidence", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    model.assert(mkAssertion({ attribute: "os", value: "Linux", evidence: { weight: 0.5, tier: "T1-reference", id: "e1" } }));
    const before = model.get("os")!;
    const decision = model.assert(mkAssertion({ attribute: "os", value: "Linux", evidence: { weight: 0.5, tier: "T1-reference", id: "e2" } }));
    expect(decision).toBe("reinforced");
    const after = model.get("os")!;
    expect(after.evidence).toHaveLength(2);
    expect(after.confidence).toBeGreaterThan(before.confidence);
  });

  it("revise: pushes the old value to supersededValues, resets the ledger, and bumps revisions", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW, contestMargin: 0.15 });
    model.assert(mkAssertion({ attribute: "os", value: "Linux", evidence: { weight: 0.5, tier: "T1-reference" } }));
    const decision = model.assert(
      mkAssertion({ attribute: "os", value: "Windows", evidence: { weight: 0.95, tier: "T0-execution" } }),
    );
    expect(decision).toBe("revised");
    const belief = model.get("os")!;
    expect(belief.value).toBe("Windows");
    expect(belief.supersededValues).toEqual(["Linux"]);
    expect(belief.revisions).toBe(1);
    expect(belief.evidence).toHaveLength(1);
  });

  it("revise twice accumulates supersededValues and revisions", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    // Weights are chosen with headroom under each tier's cap so each successive
    // revision can clear the prior value's confidence by more than the margin.
    model.assert(mkAssertion({ attribute: "os", value: "Linux", evidence: { weight: 0.3, tier: "T1-reference" } }));
    model.assert(mkAssertion({ attribute: "os", value: "Windows", evidence: { weight: 0.6, tier: "T1-reference" } }));
    model.assert(mkAssertion({ attribute: "os", value: "macOS", evidence: { weight: 0.9, tier: "T0-execution" } }));
    const belief = model.get("os")!;
    expect(belief.value).toBe("macOS");
    expect(belief.supersededValues).toEqual(["Linux", "Windows"]);
    expect(belief.revisions).toBe(2);
  });

  it("contested: a tie between two candidate values abstains and describe() does not pick a side", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW, contestMargin: 0.15 });
    model.assert(mkAssertion({ attribute: "hometown", value: "Berlin", evidence: { weight: 0.6, tier: "T1-reference" } }));
    const decision = model.assert(
      mkAssertion({ attribute: "hometown", value: "Munich", evidence: { weight: 0.65, tier: "T1-reference" } }),
    );
    expect(decision).toBe("contested");
    const belief = model.get("hometown")!;
    expect(belief.status).toBe("contested");
    expect(model.asserted().map((b) => b.attribute)).not.toContain("hometown");
    expect(model.abstained().map((b) => b.attribute)).toContain("hometown");

    const description = model.describe();
    expect(description).not.toMatch(/Berlin/);
    expect(description).not.toMatch(/Munich/);
    expect(description).toMatch(/Abstaining on:\n- hometown/);
  });

  it("retract: explicit retraction of the current value marks it retracted, not asserted or abstained", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    model.assert(mkAssertion({ attribute: "employer", value: "Acme Corp", evidence: { weight: 0.8, tier: "T1-reference" } }));
    const decision = model.assert(
      mkAssertion({ attribute: "employer", value: "Acme Corp", evidence: { polarity: "retracts", weight: 0.9, tier: "T1-reference" } }),
    );
    expect(decision).toBe("retracted");
    const belief = model.get("employer")!;
    expect(belief.status).toBe("retracted");
    expect(model.asserted().map((b) => b.attribute)).not.toContain("employer");
    expect(model.abstained().map((b) => b.attribute)).not.toContain("employer");
    expect(model.describe()).not.toMatch(/employer/);
  });

  it("ignored: weaker contradicting evidence for an alternative value is still appended to the ledger and erodes confidence", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW, contestMargin: 0.15 });
    model.assert(mkAssertion({ attribute: "hometown", value: "Berlin", evidence: { weight: 0.9, tier: "T0-execution" } }));
    const before = model.get("hometown")!;

    const decision = model.assert(
      mkAssertion({
        attribute: "hometown",
        value: "Munich",
        evidence: { polarity: "contradicts", weight: 0.2, tier: "T4-consistency" },
      }),
    );
    expect(decision).toBe("ignored");

    const after = model.get("hometown")!;
    expect(after.value).toBe("Berlin"); // decision did not change the held value
    expect(after.evidence).toHaveLength(before.evidence.length + 1); // but it IS ledgered
    expect(after.confidence).toBeLessThan(before.confidence); // and it erodes confidence
  });
});

// ===========================================================================
// DialecticUserModel — attribute/value normalization edge cases
// ===========================================================================

describe("DialecticUserModel — normalization edge cases", () => {
  it("attributes that differ only by case/whitespace/unicode-whitespace merge into one belief", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    model.assert(mkAssertion({ attribute: "Home  City", value: "Berlin", evidence: { weight: 0.5, tier: "T1-reference" } }));
    const decision = model.assert(
      mkAssertion({ attribute: "home city", value: "Berlin", evidence: { weight: 0.5, tier: "T1-reference" } }),
    );
    expect(decision).toBe("reinforced");
    expect(model.get("  HOME   CITY ")).toBeDefined();
    expect(model.all()).toHaveLength(1);
  });

  it("assert() throws TypeError for an empty or whitespace-only attribute", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    expect(() => model.assert(mkAssertion({ attribute: "   " }))).toThrow(TypeError);
    expect(() => model.assert(mkAssertion({ attribute: "" }))).toThrow(TypeError);
  });

  it("belief.value preserves the original casing of the winning assertion", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    model.assert(mkAssertion({ attribute: "language", value: "TypeScript", evidence: { weight: 0.6, tier: "T1-reference" } }));
    expect(model.get("language")!.value).toBe("TypeScript");
  });
});

// ===========================================================================
// DialecticUserModel — fromJSON validation
// ===========================================================================

describe("DialecticUserModel.fromJSON — garbage input", () => {
  it("throws on null", () => {
    expect(() => DialecticUserModel.fromJSON(null)).toThrow(TypeError);
  });

  it("throws on a plain object missing version", () => {
    expect(() => DialecticUserModel.fromJSON({})).toThrow(TypeError);
  });

  it("throws on the wrong version", () => {
    expect(() => DialecticUserModel.fromJSON({ version: 2, beliefs: [] })).toThrow(TypeError);
  });

  it("throws when beliefs is not an array", () => {
    expect(() => DialecticUserModel.fromJSON({ version: 1, beliefs: "nope" })).toThrow(TypeError);
  });

  it("throws with an actionable message when a belief is missing its attribute", () => {
    expect(() =>
      DialecticUserModel.fromJSON({
        version: 1,
        beliefs: [{ value: "x", status: "asserted", evidence: [] }],
      }),
    ).toThrow(/attribute/);
  });

  it("throws with an actionable message when evidence is missing required fields", () => {
    expect(() =>
      DialecticUserModel.fromJSON({
        version: 1,
        beliefs: [
          {
            attribute: "x",
            value: "y",
            status: "asserted",
            evidence: [{ excerpt: "no id or polarity here" }],
          },
        ],
      }),
    ).toThrow(/BeliefEvidence/);
  });

  it("throws when belief.status is not one of the known literals", () => {
    expect(() =>
      DialecticUserModel.fromJSON({
        version: 1,
        beliefs: [{ attribute: "x", value: "y", status: "made-up", evidence: [] }],
      }),
    ).toThrow(TypeError);
  });
});

describe("DialecticUserModel.fromJSON — round trip", () => {
  it("preserves observable behavior through toJSON → fromJSON", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW, halfLifeMs: DEFAULT_HALF_LIFE_MS });
    model.assert(mkAssertion({ attribute: "language", value: "TypeScript", evidence: { weight: 0.8, tier: "T0-execution" } }));
    model.assert(mkAssertion({ attribute: "hometown", value: "Berlin", evidence: { weight: 0.2, tier: "T4-consistency" } }));

    const snap = model.toJSON();
    expect(snap.version).toBe(1);
    const reloaded = DialecticUserModel.fromJSON(snap, { now: () => BASE_NOW, halfLifeMs: DEFAULT_HALF_LIFE_MS });

    expect(reloaded.describe()).toBe(model.describe());
    expect(reloaded.get("language")!.confidence).toBeCloseTo(model.get("language")!.confidence, 12);
  });
});

// ===========================================================================
// DialecticUserModel — defensive copies
// ===========================================================================

describe("DialecticUserModel — defensive copies", () => {
  it("get() returns a copy: mutating it does not corrupt the model", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    model.assert(mkAssertion({ attribute: "language", value: "TypeScript", evidence: { weight: 0.6, tier: "T1-reference" } }));

    const belief = model.get("language")!;
    belief.value = "HACKED";
    belief.confidence = 999;
    belief.evidence.push(mkEvidence({ weight: 1, tier: "T0-execution" }));
    belief.supersededValues.push("intruder");

    const fresh = model.get("language")!;
    expect(fresh.value).toBe("TypeScript");
    expect(fresh.confidence).not.toBe(999);
    expect(fresh.evidence).toHaveLength(1);
    expect(fresh.supersededValues).toHaveLength(0);
  });

  it("all() returns copies: mutating one entry does not corrupt subsequent calls", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    model.assert(mkAssertion({ attribute: "language", value: "TypeScript", evidence: { weight: 0.6, tier: "T1-reference" } }));

    const [belief] = model.all();
    belief.evidence[0].weight = 0;
    belief.evidence[0].id = "tampered";

    const [fresh] = model.all();
    expect(fresh.evidence[0].id).not.toBe("tampered");
    expect(fresh.evidence[0].weight).not.toBe(0);
  });
});

// ===========================================================================
// DialecticUserModel — describe() determinism & ordering
// ===========================================================================

describe("DialecticUserModel — describe()", () => {
  it("is deterministic across repeated calls with no intervening mutation", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    model.assert(mkAssertion({ attribute: "language", value: "TypeScript", evidence: { weight: 0.6, tier: "T1-reference" } }));
    model.assert(mkAssertion({ attribute: "hometown", value: "Berlin", evidence: { weight: 0.95, tier: "T0-execution" } }));
    const first = model.describe();
    const second = model.describe();
    expect(first).toBe(second);
  });

  it("orders asserted beliefs by decayed confidence, descending", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    model.assert(mkAssertion({ attribute: "low", value: "L", evidence: { weight: 0.6, tier: "T1-reference" } }));
    model.assert(mkAssertion({ attribute: "high", value: "H", evidence: { weight: 0.98, tier: "T0-execution" } }));
    const description = model.describe();
    expect(description.indexOf("- high:")).toBeLessThan(description.indexOf("- low:"));
  });

  it("reports an empty model distinctly", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    expect(model.describe()).toBe("No verified model of the user yet.");
  });

  it("format matches the locked prose shape for an asserted belief", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    model.assert(mkAssertion({ attribute: "language", value: "TypeScript", evidence: { weight: 0.9, tier: "T0-execution" } }));
    const belief = model.get("language")!;
    const pct = Math.round(belief.confidence * 100);
    expect(model.describe()).toBe(`- language: TypeScript (${pct}% confident, 1 evidence)`);
  });
});

// ===========================================================================
// DialecticUserModel — assert() input robustness
// ===========================================================================

describe("DialecticUserModel — assert() input robustness", () => {
  it("non-finite weight/at on the incoming evidence never produce a NaN-poisoned belief", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    model.assert(
      mkAssertion({
        attribute: "language",
        value: "TypeScript",
        evidence: { weight: Number.NaN, at: Number.POSITIVE_INFINITY, tier: "T1-reference" },
      }),
    );
    const belief = model.get("language")!;
    expect(Number.isFinite(belief.confidence)).toBe(true);
    expect(belief.confidence).toBeGreaterThanOrEqual(0);
    expect(belief.confidence).toBeLessThanOrEqual(1);
  });

  it("throws TypeError when the assertion object itself is malformed", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    // @ts-expect-error deliberately malformed
    expect(() => model.assert(null)).toThrow(TypeError);
    // @ts-expect-error deliberately malformed value type
    expect(() => model.assert({ attribute: "x", value: 5, evidence: mkEvidence() })).toThrow(TypeError);
  });

  it("throws TypeError when evidence is missing structural fields", () => {
    const model = new DialecticUserModel({ now: () => BASE_NOW });
    expect(() =>
      model.assert({
        attribute: "x",
        value: "y",
        // @ts-expect-error deliberately missing id/polarity/tier
        evidence: { excerpt: "no id" },
      }),
    ).toThrow(TypeError);
  });
});
