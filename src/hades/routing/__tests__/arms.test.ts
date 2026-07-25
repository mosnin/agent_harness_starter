/**
 * Tests for `src/hades/routing/arms.ts` -- the routable arm space and the
 * measured cost/latency predictor.
 *
 * These exercise the REAL `ModelRegistry` (seeded like
 * `../models/defaults`) and REAL `DEFAULT_PRICES`/`computeCost` -- no
 * hand-rolled fake catalog.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { ModelRegistry } from "../../models/registry";
import { DEFAULT_PRICES, computeCost } from "../../models/client";
import type { PriceEntry } from "../../models/client";
import {
  ArmCatalog,
  ArmCostModel,
  RoutingArmError,
  encodeArmId,
  parseArmId,
  type ArmRequirements,
  type CostEstimate,
  type RoutingArm,
  type TaskCostContext,
  type UsageSample,
} from "../arms";

// ---------------------------------------------------------------------------
// Fixtures -- a REAL registry seeded the same way `../models/defaults` does.
// ---------------------------------------------------------------------------

function realRegistry(): ModelRegistry {
  return new ModelRegistry()
    .register({
      id: "claude-opus-4-1",
      provider: "anthropic",
      displayName: "Claude Opus 4.1",
      aliases: ["opus"],
      contextWindow: 200000,
      tags: ["flagship"],
    })
    .register({
      id: "claude-sonnet-5",
      provider: "anthropic",
      displayName: "Claude Sonnet 5",
      aliases: ["sonnet"],
      contextWindow: 200000,
      tags: ["balanced"],
    })
    .register({
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      displayName: "Claude Haiku 4.5",
      aliases: ["haiku"],
      contextWindow: 200000,
      tags: ["fast"],
    })
    .register({
      id: "claude-fable-5",
      provider: "anthropic",
      displayName: "Claude Fable 5",
      aliases: ["fable"],
      tags: ["creative"], // deliberately no contextWindow, like the real defaults
    })
    .register({
      id: "gpt-4o",
      provider: "openai",
      displayName: "GPT-4o",
      contextWindow: 128000,
      tags: ["balanced"],
    })
    .register({
      id: "mystery-model-9000",
      provider: "acme",
      displayName: "Mystery Model 9000",
      contextWindow: 32000,
      tags: ["experimental"],
    }); // NOT in DEFAULT_PRICES -- the real "unpriced" case
}

const CTX: TaskCostContext = { promptTokens: 1000, expectedOutputTokens: 500 };

// ---------------------------------------------------------------------------
// encodeArmId / parseArmId
// ---------------------------------------------------------------------------

describe("encodeArmId / parseArmId", () => {
  it("round-trips without an execTarget", () => {
    const id = encodeArmId("anthropic", "claude-sonnet-5", null);
    expect(id).toBe("anthropic/claude-sonnet-5");
    expect(parseArmId(id)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      execTarget: null,
    });
  });

  it("round-trips with an execTarget", () => {
    const id = encodeArmId("anthropic", "claude-sonnet-5", "local-gpu0");
    expect(id).toBe("anthropic/claude-sonnet-5@local-gpu0");
    expect(parseArmId(id)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      execTarget: "local-gpu0",
    });
  });

  it("round-trips an execTarget containing a slash", () => {
    const id = encodeArmId("openai", "gpt-4o", "local/gpu0");
    expect(parseArmId(id)).toEqual({ provider: "openai", modelId: "gpt-4o", execTarget: "local/gpu0" });
  });

  it("property: round-trips for any provider/modelId/execTarget without '/' or '@'", () => {
    const safe = fc.stringMatching(/^[a-zA-Z0-9._-]+$/).filter((s) => s.length > 0);
    fc.assert(
      fc.property(safe, safe, fc.option(safe, { nil: null }), (provider, modelId, execTarget) => {
        const id = encodeArmId(provider, modelId, execTarget);
        const parsed = parseArmId(id);
        expect(parsed).toEqual({ provider, modelId, execTarget });
      }),
    );
  });

  it("throws RoutingArmError with code invalid-arm-id on malformed ids", () => {
    for (const bad of ["", "no-slash-here", "/leading-slash", "trailing-slash/"]) {
      expect(() => parseArmId(bad)).toThrow(RoutingArmError);
      try {
        parseArmId(bad);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(RoutingArmError);
        expect((e as RoutingArmError).code).toBe("invalid-arm-id");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ArmCatalog construction / determinism
// ---------------------------------------------------------------------------

describe("ArmCatalog construction and ordering", () => {
  it("builds one arm per model with execTarget null when execTargets is omitted", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const arms = catalog.arms();
    expect(arms).toHaveLength(registry.list().length);
    expect(arms.every((a) => a.execTarget === null)).toBe(true);
  });

  it("crosses models with execTargets, de-duplicated and sorted", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry, execTargets: ["cloud", "local", "cloud"] });
    const arms = catalog.arms();
    expect(arms).toHaveLength(registry.list().length * 2);
    // For a given model, cloud sorts before local.
    const sonnetArms = arms.filter((a) => a.modelId === "claude-sonnet-5");
    expect(sonnetArms.map((a) => a.execTarget)).toEqual(["cloud", "local"]);
  });

  it("treats an empty execTargets array the same as omitted", () => {
    const registry = realRegistry();
    const withEmpty = new ArmCatalog({ registry, execTargets: [] }).arms();
    const withOmitted = new ArmCatalog({ registry }).arms();
    expect(withEmpty).toHaveLength(withOmitted.length);
    expect(withEmpty.every((a) => a.execTarget === null)).toBe(true);
  });

  it("orders arms deterministically by provider, then modelId, then execTarget", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry, execTargets: ["z-target", "a-target"] });
    const arms = catalog.arms();
    for (let i = 1; i < arms.length; i++) {
      const prev = arms[i - 1];
      const cur = arms[i];
      const key = (a: RoutingArm) => [a.provider, a.modelId, a.execTarget ?? ""] as const;
      const [pp, pm, pe] = key(prev);
      const [cp, cm, ce] = key(cur);
      const cmp =
        pp === cp ? (pm === cm ? pe.localeCompare(ce) : pm.localeCompare(cm)) : pp.localeCompare(cp);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("two catalogs built from equivalently-seeded registries produce byte-identical arms() ordering", () => {
    // Register models in a DIFFERENT order in the second registry to prove
    // the catalog itself is what imposes determinism, not registration order.
    const r1 = realRegistry();
    const r2 = new ModelRegistry()
      .register({ id: "gpt-4o", provider: "openai", displayName: "GPT-4o", contextWindow: 128000, tags: ["balanced"] })
      .register({ id: "mystery-model-9000", provider: "acme", displayName: "Mystery Model 9000", contextWindow: 32000, tags: ["experimental"] })
      .register({ id: "claude-fable-5", provider: "anthropic", displayName: "Claude Fable 5", aliases: ["fable"], tags: ["creative"] })
      .register({ id: "claude-haiku-4-5-20251001", provider: "anthropic", displayName: "Claude Haiku 4.5", aliases: ["haiku"], contextWindow: 200000, tags: ["fast"] })
      .register({ id: "claude-sonnet-5", provider: "anthropic", displayName: "Claude Sonnet 5", aliases: ["sonnet"], contextWindow: 200000, tags: ["balanced"] })
      .register({ id: "claude-opus-4-1", provider: "anthropic", displayName: "Claude Opus 4.1", aliases: ["opus"], contextWindow: 200000, tags: ["flagship"] });

    const a1 = new ArmCatalog({ registry: r1, execTargets: ["cloud", "local"] }).arms();
    const a2 = new ArmCatalog({ registry: r2, execTargets: ["cloud", "local"] }).arms();
    expect(JSON.stringify(a1)).toBe(JSON.stringify(a2));
  });

  it("handles an empty registry: empty catalog, get/has/eligible all behave", () => {
    const catalog = new ArmCatalog({ registry: new ModelRegistry() });
    expect(catalog.arms()).toEqual([]);
    expect(catalog.has("anthropic/claude-sonnet-5")).toBe(false);
    expect(catalog.get("anthropic/claude-sonnet-5")).toBeUndefined();
    const cost = new ArmCostModel();
    const result = catalog.eligible({}, CTX, cost);
    expect(result.arms).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("handles duplicate model registrations across providers via the registry's own last-write-wins semantics without crashing or duplicating arm ids", () => {
    const registry = new ModelRegistry()
      .register({ id: "gpt-4o", provider: "openai", displayName: "GPT-4o (OpenAI)", contextWindow: 128000 })
      .register({ id: "gpt-4o", provider: "openrouter", displayName: "GPT-4o (via OpenRouter)", contextWindow: 128000 });
    // ModelRegistry itself keys by id, so this is genuinely one model now.
    expect(registry.list()).toHaveLength(1);
    const catalog = new ArmCatalog({ registry });
    const arms = catalog.arms();
    expect(arms).toHaveLength(1);
    expect(arms[0].provider).toBe("openrouter"); // last registration wins
    expect(arms[0].id).toBe("openrouter/gpt-4o");
    expect(catalog.has("openai/gpt-4o")).toBe(false);
    // No duplicate ids in the map -- has()/get() agree with arms().
    const ids = new Set(arms.map((a) => a.id));
    expect(ids.size).toBe(arms.length);
  });

  it("marks a model with a matching PriceEntry as priced, and one without as unpriced -- never a fabricated $0", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const sonnet = catalog.get("anthropic/claude-sonnet-5")!;
    expect(sonnet.unpriced).toBe(false);
    expect(sonnet.price).not.toBeNull();
    expect(sonnet.price?.model).toBe("claude-sonnet-5");

    const mystery = catalog.get("acme/mystery-model-9000")!;
    expect(mystery.unpriced).toBe(true);
    expect(mystery.price).toBeNull();
    // Sanity: the real computeCost() would silently return 0 for this model.
    expect(computeCost("mystery-model-9000", 1000, 1000, [...DEFAULT_PRICES])).toBe(0);
  });

  it("get/has are independent of the `available` predicate (arms() reflects the static catalog)", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry, available: () => false });
    expect(catalog.arms().length).toBeGreaterThan(0);
    expect(catalog.has("anthropic/claude-sonnet-5")).toBe(true);
    expect(catalog.get("anthropic/claude-sonnet-5")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ArmCatalog.eligible -- every RejectionCode individually exercised
// ---------------------------------------------------------------------------

describe("ArmCatalog.eligible rejection codes", () => {
  const registry = realRegistry();

  function catalog(available?: (arm: RoutingArm) => boolean) {
    return new ArmCatalog({ registry, available });
  }

  it("unavailable", () => {
    const cat = catalog(() => false);
    const cost = new ArmCostModel();
    const result = cat.eligible({}, CTX, cost);
    expect(result.arms).toEqual([]);
    expect(result.rejected.length).toBe(cat.arms().length);
    expect(result.rejected.every((r) => r.code === "unavailable")).toBe(true);
  });

  it("provider-excluded", () => {
    const cat = catalog();
    const cost = new ArmCostModel();
    const req: ArmRequirements = { providers: ["openai"], allowUnpriced: true };
    const result = cat.eligible(req, CTX, cost);
    expect(result.arms.every((a) => a.provider === "openai")).toBe(true);
    const rejection = result.rejected.find((r) => r.armId === "anthropic/claude-sonnet-5");
    expect(rejection?.code).toBe("provider-excluded");
  });

  it("tag-missing", () => {
    const cat = catalog();
    const cost = new ArmCostModel();
    const req: ArmRequirements = { requireTags: ["flagship"], allowUnpriced: true };
    const result = cat.eligible(req, CTX, cost);
    expect(result.arms).toEqual([cat.get("anthropic/claude-opus-4-1")]);
    const rejection = result.rejected.find((r) => r.armId === "anthropic/claude-sonnet-5");
    expect(rejection?.code).toBe("tag-missing");
    expect(rejection?.detail).toContain("flagship");
  });

  it("tag-excluded", () => {
    const cat = catalog();
    const cost = new ArmCostModel();
    const req: ArmRequirements = { excludeTags: ["creative"], allowUnpriced: true };
    const result = cat.eligible(req, CTX, cost);
    expect(result.arms.some((a) => a.id === "anthropic/claude-fable-5")).toBe(false);
    const rejection = result.rejected.find((r) => r.armId === "anthropic/claude-fable-5");
    expect(rejection?.code).toBe("tag-excluded");
  });

  it("arm-excluded", () => {
    const cat = catalog();
    const cost = new ArmCostModel();
    const req: ArmRequirements = { excludeArms: ["anthropic/claude-sonnet-5"], allowUnpriced: true };
    const result = cat.eligible(req, CTX, cost);
    expect(result.arms.some((a) => a.id === "anthropic/claude-sonnet-5")).toBe(false);
    const rejection = result.rejected.find((r) => r.armId === "anthropic/claude-sonnet-5");
    expect(rejection?.code).toBe("arm-excluded");
  });

  it("context-too-small (including a model with no declared contextWindow at all)", () => {
    const cat = catalog();
    const cost = new ArmCostModel();
    const req: ArmRequirements = { minContextWindow: 100000, allowUnpriced: true };
    const result = cat.eligible(req, CTX, cost);
    const fableRejection = result.rejected.find((r) => r.armId === "anthropic/claude-fable-5");
    expect(fableRejection?.code).toBe("context-too-small");
    expect(fableRejection?.detail).toContain("unknown");
    expect(result.arms.some((a) => a.id === "anthropic/claude-opus-4-1")).toBe(true);
  });

  it("unpriced", () => {
    const cat = catalog();
    const cost = new ArmCostModel();
    const result = cat.eligible({}, CTX, cost); // allowUnpriced defaults to falsy
    expect(result.arms.some((a) => a.id === "acme/mystery-model-9000")).toBe(false);
    const rejection = result.rejected.find((r) => r.armId === "acme/mystery-model-9000");
    expect(rejection?.code).toBe("unpriced");
    // allowUnpriced: true lets it through.
    const allowed = cat.eligible({ allowUnpriced: true }, CTX, cost);
    expect(allowed.arms.some((a) => a.id === "acme/mystery-model-9000")).toBe(true);
  });

  it("over-usd-cap", () => {
    const cat = catalog();
    const cost = new ArmCostModel();
    // Opus-tier list price on a large task is well above one hundredth of a cent.
    const req: ArmRequirements = { maxUsdPerTask: 0.0000001, providers: ["anthropic"] };
    const result = cat.eligible(req, { promptTokens: 100000, expectedOutputTokens: 50000 }, cost);
    const opusRejection = result.rejected.find((r) => r.armId === "anthropic/claude-opus-4-1");
    expect(opusRejection?.code).toBe("over-usd-cap");
  });

  it("over-latency-cap (requires real recorded samples to push past minSamples)", () => {
    const cat = catalog();
    const cost = new ArmCostModel({ minSamples: 3 });
    const armId = "anthropic/claude-sonnet-5";
    for (let i = 0; i < 5; i++) {
      cost.record({ armId, tokensIn: 1000, tokensOut: 500, usd: 0.01, latencyMs: 9000, at: i * 1000 });
    }
    const req: ArmRequirements = { maxLatencyMs: 100, excludeArms: cat.arms().filter((a) => a.id !== armId).map((a) => a.id) };
    const result = cat.eligible(req, CTX, cost);
    const rejection = result.rejected.find((r) => r.armId === armId);
    expect(rejection?.code).toBe("over-latency-cap");
  });

  it("all-arms-rejected reports a rejection for every single arm, none silently dropped", () => {
    const cat = catalog();
    const cost = new ArmCostModel();
    const req: ArmRequirements = { minContextWindow: 10_000_000 }; // impossible for every model
    const result = cat.eligible(req, CTX, cost);
    expect(result.arms).toEqual([]);
    expect(result.rejected).toHaveLength(cat.arms().length);
    const ids = new Set(result.rejected.map((r) => r.armId));
    expect(ids.size).toBe(cat.arms().length);
  });
});

// ---------------------------------------------------------------------------
// ArmCostModel -- the adversarial cost hole
// ---------------------------------------------------------------------------

describe("ArmCostModel: the adversarial unpriced-$0 hole", () => {
  const registry = realRegistry();
  const catalog = new ArmCatalog({ registry });

  it("an unpriced arm with zero samples never claims 'measured' or a fabricated nonzero cost", () => {
    const cost = new ArmCostModel();
    const arm = catalog.get("acme/mystery-model-9000")!;
    const estimate = cost.estimate(arm, CTX, 0);
    expect(estimate.source).toBe("unpriced");
    expect(estimate.usdMean).toBe(0);
    expect(estimate.usdP90).toBe(0);
    expect(estimate.usdStdDev).toBe(0);
    expect(estimate.samples).toBe(0);
  });

  it("an unpriced arm NEVER reports source 'measured', even with abundant real usage samples", () => {
    const cost = new ArmCostModel({ minSamples: 2 });
    const arm = catalog.get("acme/mystery-model-9000")!;
    for (let i = 0; i < 20; i++) {
      // Simulate what really happens: caller ran computeCost() against a
      // price table that doesn't know this model, got 0, and (wrongly, if
      // trusted blindly) recorded it as the real cost.
      cost.record({ armId: arm.id, tokensIn: 1000, tokensOut: 500, usd: 0, latencyMs: 500, at: i * 1000 });
    }
    const estimate = cost.estimate(arm, CTX, 20000);
    expect(estimate.samples).toBe(20); // the samples are honestly counted...
    expect(estimate.source).toBe("unpriced"); // ...but NEVER promoted to "measured"
  });

  it("explicit test: a naive bandit sorting by usdMean alone would rank the unpriced arm as cheapest -- proving source/unpriced MUST be checked, not usdMean alone", () => {
    const cost = new ArmCostModel({ minSamples: 50 }); // keep the priced arm in "priced-prior" too, for a fair-looking comparison
    const arms = [catalog.get("anthropic/claude-opus-4-1")!, catalog.get("acme/mystery-model-9000")!];
    const estimates = arms.map((a) => cost.estimate(a, CTX, 0));

    const cheapestByRawUsdMean = [...estimates].sort((a, b) => a.usdMean - b.usdMean)[0];
    // The unpriced arm's fabricated-looking $0 sorts first if you only look at usdMean...
    expect(cheapestByRawUsdMean.armId).toBe("acme/mystery-model-9000");
    expect(cheapestByRawUsdMean.source).toBe("unpriced");

    // ...which is exactly why a real consumer must route through eligible()
    // (default allowUnpriced: false) instead of raw usdMean comparison:
    const eligible = catalog.eligible({}, CTX, cost);
    expect(eligible.arms.some((a) => a.id === "acme/mystery-model-9000")).toBe(false);
    expect(eligible.arms.some((a) => a.id === "anthropic/claude-opus-4-1")).toBe(true);

    // And a consumer inspecting CostEstimate directly must gate on `source`,
    // not `usdMean`:
    const trustworthy = estimates.filter((e) => e.source !== "unpriced");
    expect(trustworthy.map((e) => e.armId)).toEqual(["anthropic/claude-opus-4-1"]);
  });

  it("a genuinely priced arm with real usage that happens to cost $0 per call (e.g. a free tier) IS allowed to say 'measured' -- the guard is about missing prices, not about cheapness", () => {
    const cost = new ArmCostModel({ minSamples: 2 });
    const arm = catalog.get("anthropic/claude-sonnet-5")!; // has a real PriceEntry
    for (let i = 0; i < 5; i++) {
      cost.record({ armId: arm.id, tokensIn: 100, tokensOut: 100, usd: 0, latencyMs: 200, at: i * 1000 });
    }
    const estimate = cost.estimate(arm, CTX, 4000); // now === lastAt -> zero staleness, no blending toward priced-prior
    expect(estimate.source).toBe("measured");
    expect(estimate.usdMean).toBe(0); // legitimately, honestly, $0 -- unlike the unpriced case
  });
});

// ---------------------------------------------------------------------------
// ArmCostModel -- statistics correctness
// ---------------------------------------------------------------------------

describe("ArmCostModel statistics", () => {
  it("priced-prior source uses the real computeCost() against the real DEFAULT_PRICES entry", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel(); // no samples recorded
    const arm = catalog.get("anthropic/claude-sonnet-5")!;
    const estimate = cost.estimate(arm, CTX, 0);
    expect(estimate.source).toBe("priced-prior");
    const expected = computeCost("claude-sonnet-5", CTX.promptTokens, CTX.expectedOutputTokens, [...DEFAULT_PRICES]);
    expect(estimate.usdMean).toBeCloseTo(expected, 10);
    expect(estimate.usdP90).toBeCloseTo(expected, 10);
    expect(estimate.usdStdDev).toBe(0);
  });

  it("source flips from priced-prior to measured exactly at minSamples", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel({ minSamples: 3 });
    const arm = catalog.get("anthropic/claude-sonnet-5")!;

    for (let i = 0; i < 2; i++) {
      cost.record({ armId: arm.id, tokensIn: 500, tokensOut: 300, usd: 0.01, latencyMs: 400, at: i * 1000 });
      expect(cost.estimate(arm, CTX, i * 1000).source).toBe("priced-prior");
    }
    cost.record({ armId: arm.id, tokensIn: 500, tokensOut: 300, usd: 0.01, latencyMs: 400, at: 2000 });
    expect(cost.samples(arm.id)).toBe(3);
    expect(cost.estimate(arm, CTX, 2000).source).toBe("measured");
  });

  it("samples() reports the real all-time count, 0 for an unknown arm id", () => {
    const cost = new ArmCostModel();
    expect(cost.samples("nope/nope")).toBe(0);
    cost.record({ armId: "anthropic/claude-sonnet-5", tokensIn: 10, tokensOut: 10, usd: 0.001, latencyMs: 100, at: 0 });
    expect(cost.samples("anthropic/claude-sonnet-5")).toBe(1);
  });

  it("Welford variance is 0 (not NaN) for a single sample", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel({ minSamples: 1 });
    const arm = catalog.get("anthropic/claude-sonnet-5")!;
    cost.record({ armId: arm.id, tokensIn: 1000, tokensOut: 500, usd: 0.02, latencyMs: 300, at: 0 });
    const estimate = cost.estimate(arm, CTX, 0);
    expect(estimate.source).toBe("measured");
    expect(estimate.usdStdDev).toBe(0);
    expect(Number.isFinite(estimate.usdStdDev)).toBe(true);
  });

  it("P90 uses linear interpolation between closest ranks over the bounded window", () => {
    const cost = new ArmCostModel({ minSamples: 1, window: 10 });
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const arm = catalog.get("anthropic/claude-sonnet-5")!;
    // 10 samples of 1000 combined tokens each, usd = 1..10 => rate = 0.001..0.010
    for (let i = 1; i <= 10; i++) {
      cost.record({ armId: arm.id, tokensIn: 500, tokensOut: 500, usd: i, latencyMs: i * 10, at: 0 }); // at=0 => no decay between samples
    }
    const ctx: TaskCostContext = { promptTokens: 500, expectedOutputTokens: 500 }; // totalTokens = 1000
    const estimate = cost.estimate(arm, ctx, 0);
    // sorted rates: 0.001..0.010 (n=10); idx = 0.9*9 = 8.1 -> interpolate between index 8 (0.009) and 9 (0.010)
    const expectedRateP90 = 0.009 + (0.01 - 0.009) * 0.1;
    // measured branch blends with priced-prior at blend=1 (dtSinceLast=0), so usdP90 == rateP90 * totalTokens
    expect(estimate.usdP90).toBeCloseTo(expectedRateP90 * 1000, 10);
  });

  it("bounds the sliding window to the configured size and evicts oldest first", () => {
    const cost = new ArmCostModel({ minSamples: 1, window: 3 });
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const arm = catalog.get("anthropic/claude-sonnet-5")!;
    for (let i = 1; i <= 5; i++) {
      cost.record({ armId: arm.id, tokensIn: 500, tokensOut: 500, usd: i, latencyMs: i, at: i * 1000 });
    }
    const snap = cost.snapshot();
    const entry = snap.arms.find((a) => a.armId === arm.id)!;
    expect(entry.usdRateWindow).toHaveLength(3);
    expect(entry.latencyWindow).toHaveLength(3);
    // oldest (rates from usd=1,2) evicted; remaining correspond to usd=3,4,5
    expect(entry.usdRateWindow.map((r) => r * 1000)).toEqual([3, 4, 5]);
    expect(entry.totalCount).toBe(5); // all-time count is NOT bounded by window
  });
});

// ---------------------------------------------------------------------------
// ArmCostModel -- no NaN/Infinity ever escapes
// ---------------------------------------------------------------------------

describe("ArmCostModel never leaks NaN/Infinity", () => {
  function assertFiniteEstimate(e: CostEstimate) {
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === "number") {
        expect(Number.isFinite(v), `${k} was not finite: ${v}`).toBe(true);
        expect(Number.isNaN(v), `${k} was NaN`).toBe(false);
      }
    }
  }

  it("zero-token context never produces NaN, for priced-prior, measured, and unpriced arms", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel({ minSamples: 2 });
    const zeroCtx: TaskCostContext = { promptTokens: 0, expectedOutputTokens: 0 };

    const sonnet = catalog.get("anthropic/claude-sonnet-5")!;
    assertFiniteEstimate(cost.estimate(sonnet, zeroCtx, 0)); // priced-prior, no samples

    cost.record({ armId: sonnet.id, tokensIn: 0, tokensOut: 0, usd: 0, latencyMs: 0, at: 0 });
    cost.record({ armId: sonnet.id, tokensIn: 0, tokensOut: 0, usd: 0, latencyMs: 0, at: 1000 });
    assertFiniteEstimate(cost.estimate(sonnet, zeroCtx, 2000)); // measured, all-zero samples

    const mystery = catalog.get("acme/mystery-model-9000")!;
    assertFiniteEstimate(cost.estimate(mystery, zeroCtx, 0)); // unpriced, zero samples
    cost.record({ armId: mystery.id, tokensIn: 0, tokensOut: 0, usd: 0, latencyMs: 0, at: 0 });
    assertFiniteEstimate(cost.estimate(mystery, zeroCtx, 0)); // unpriced, with samples
  });

  it("1-sample arms never produce NaN/Infinity", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel({ minSamples: 1 });
    const arm = catalog.get("anthropic/claude-haiku-4-5-20251001")!;
    cost.record({ armId: arm.id, tokensIn: 10, tokensOut: 10, usd: 0.0001, latencyMs: 50, at: 0 });
    assertFiniteEstimate(cost.estimate(arm, CTX, 0));
    assertFiniteEstimate(cost.estimate(arm, CTX, 999999999));
  });

  it("record() sanitizes NaN/Infinity/negative garbage input instead of letting it poison state", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel({ minSamples: 1 });
    const arm = catalog.get("anthropic/claude-sonnet-5")!;
    cost.record({
      armId: arm.id,
      tokensIn: Number.NaN,
      tokensOut: Number.POSITIVE_INFINITY,
      usd: -5,
      latencyMs: Number.NaN,
      at: Number.NaN,
    });
    assertFiniteEstimate(cost.estimate(arm, CTX, 0));
  });

  it("property: estimate() is always fully finite for arbitrary (small) token contexts and now values, priced or not", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel({ minSamples: 3 });
    for (let i = 0; i < 10; i++) {
      cost.record({
        armId: "anthropic/claude-sonnet-5",
        tokensIn: 100 + i,
        tokensOut: 50 + i,
        usd: 0.001 * i,
        latencyMs: 100 + i * 5,
        at: i * 500,
      });
    }
    const arm = catalog.get("anthropic/claude-sonnet-5")!;
    fc.assert(
      fc.property(
        fc.nat(1_000_000),
        fc.nat(1_000_000),
        fc.nat(10_000_000),
        (promptTokens, expectedOutputTokens, now) => {
          const e = cost.estimate(arm, { promptTokens, expectedOutputTokens }, now);
          assertFiniteEstimate(e);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// ArmCostModel -- monotonicity
// ---------------------------------------------------------------------------

describe("ArmCostModel monotonicity for a priced arm", () => {
  it("property: usdMean and usdP90 are monotone non-decreasing in promptTokens (priced-prior)", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel(); // no samples -> priced-prior throughout
    const arm = catalog.get("anthropic/claude-opus-4-1")!;
    fc.assert(
      fc.property(fc.nat(200_000), fc.nat(100_000), fc.nat(200_000), (base, delta, outTokens) => {
        const e1 = cost.estimate(arm, { promptTokens: base, expectedOutputTokens: outTokens }, 0);
        const e2 = cost.estimate(arm, { promptTokens: base + delta, expectedOutputTokens: outTokens }, 0);
        expect(e2.usdMean).toBeGreaterThanOrEqual(e1.usdMean);
        expect(e2.usdP90).toBeGreaterThanOrEqual(e1.usdP90);
      }),
    );
  });

  it("property: usdMean and usdP90 are monotone non-decreasing in expectedOutputTokens (priced-prior)", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel();
    const arm = catalog.get("anthropic/claude-opus-4-1")!;
    fc.assert(
      fc.property(fc.nat(200_000), fc.nat(100_000), fc.nat(200_000), (base, delta, inTokens) => {
        const e1 = cost.estimate(arm, { promptTokens: inTokens, expectedOutputTokens: base }, 0);
        const e2 = cost.estimate(arm, { promptTokens: inTokens, expectedOutputTokens: base + delta }, 0);
        expect(e2.usdMean).toBeGreaterThanOrEqual(e1.usdMean);
        expect(e2.usdP90).toBeGreaterThanOrEqual(e1.usdP90);
      }),
    );
  });

  it("property: usdMean and usdP90 are monotone non-decreasing in token counts once source is 'measured'", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel({ minSamples: 3 });
    const arm = catalog.get("anthropic/claude-sonnet-5")!;
    for (let i = 0; i < 5; i++) {
      cost.record({ armId: arm.id, tokensIn: 200, tokensOut: 100, usd: 0.005 + i * 0.0002, latencyMs: 300, at: i * 1000 });
    }
    expect(cost.estimate(arm, CTX, 4000).source).toBe("measured");

    fc.assert(
      fc.property(fc.nat(50_000), fc.nat(20_000), fc.nat(50_000), fc.nat(20_000), fc.nat(10_000_000), (p1, o1, dp, dop, now) => {
        const e1 = cost.estimate(arm, { promptTokens: p1, expectedOutputTokens: o1 }, now);
        const e2 = cost.estimate(arm, { promptTokens: p1 + dp, expectedOutputTokens: o1 + dop }, now);
        expect(e2.usdMean).toBeGreaterThanOrEqual(e1.usdMean - 1e-12);
        expect(e2.usdP90).toBeGreaterThanOrEqual(e1.usdP90 - 1e-12);
      }),
    );
  });

  it("staleness (now far past lastAt) blends usdMean from measured toward the priced-prior", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const halfLifeMs = 1000;
    const cost = new ArmCostModel({ minSamples: 1, halfLifeMs });
    const arm = catalog.get("anthropic/claude-sonnet-5")!;
    // Record a rate wildly different from list price so the blend is visible.
    cost.record({ armId: arm.id, tokensIn: 500, tokensOut: 500, usd: 100, latencyMs: 10, at: 0 });

    const fresh = cost.estimate(arm, CTX, 0); // dt = 0 -> fully "measured"
    const veryStale = cost.estimate(arm, CTX, halfLifeMs * 50); // dt huge -> fully "priced-prior"
    const pricedPrior = computeCost("claude-sonnet-5", CTX.promptTokens, CTX.expectedOutputTokens, [...DEFAULT_PRICES]);

    expect(fresh.usdMean).toBeGreaterThan(pricedPrior); // measured rate (100/1000=0.1/token) dwarfs list price
    expect(veryStale.usdMean).toBeCloseTo(pricedPrior, 6);
  });
});

// ---------------------------------------------------------------------------
// ArmCostModel -- snapshot / restore
// ---------------------------------------------------------------------------

describe("ArmCostModel snapshot/restore", () => {
  function seeded(): { cost: ArmCostModel; arm: RoutingArm; catalog: ArmCatalog } {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel({ minSamples: 2, halfLifeMs: 60_000, window: 5 });
    const arm = catalog.get("anthropic/claude-sonnet-5")!;
    for (let i = 0; i < 4; i++) {
      cost.record({ armId: arm.id, tokensIn: 300 + i * 10, tokensOut: 150, usd: 0.01 + i * 0.001, latencyMs: 250 + i * 5, at: i * 2000 });
    }
    return { cost, arm, catalog };
  }

  it("snapshot() is versioned and JSON-serializable", () => {
    const { cost } = seeded();
    const snap = cost.snapshot();
    expect(snap.version).toBe(1);
    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(Array.isArray(snap.arms)).toBe(true);
    expect(snap.arms.length).toBeGreaterThan(0);
  });

  it("round-trips exactly: restore(snapshot()).estimate(...) deep-equals the original", () => {
    const { cost, arm } = seeded();
    const opts = { minSamples: 2, halfLifeMs: 60_000, window: 5 };
    const restored = ArmCostModel.restore(cost.snapshot(), opts);
    for (const now of [0, 1000, 500_000]) {
      const original = cost.estimate(arm, CTX, now);
      const roundTripped = restored.estimate(arm, CTX, now);
      expect(roundTripped).toEqual(original);
    }
    expect(restored.samples(arm.id)).toBe(cost.samples(arm.id));
  });

  it("round-trip also holds through a JSON.stringify/parse boundary (real serialization)", () => {
    const { cost, arm } = seeded();
    const opts = { minSamples: 2, halfLifeMs: 60_000, window: 5 };
    const wire = JSON.parse(JSON.stringify(cost.snapshot()));
    const restored = ArmCostModel.restore(wire, opts);
    expect(restored.estimate(arm, CTX, 12345)).toEqual(cost.estimate(arm, CTX, 12345));
  });

  it("rejects a non-object snapshot with code not-an-object", () => {
    for (const bad of [null, undefined, 42, "snapshot", [1, 2, 3]]) {
      expect(() => ArmCostModel.restore(bad)).toThrow(RoutingArmError);
      try {
        ArmCostModel.restore(bad);
        expect.unreachable();
      } catch (e) {
        expect((e as RoutingArmError).code).toBe("not-an-object");
      }
    }
  });

  it("rejects the wrong version with code bad-version", () => {
    expect(() => ArmCostModel.restore({ version: 2, arms: [] })).toThrow(RoutingArmError);
    try {
      ArmCostModel.restore({ version: 2, arms: [] });
      expect.unreachable();
    } catch (e) {
      expect((e as RoutingArmError).code).toBe("bad-version");
    }
  });

  it("rejects a negative totalCount with code negative-count", () => {
    const snap = {
      version: 1,
      arms: [{ armId: "a/b", totalCount: -1, ewmaUsdRate: 0, ewmaLatency: 0, lastAt: 0, usdRateWindow: [], latencyWindow: [] }],
    };
    expect(() => ArmCostModel.restore(snap)).toThrow(RoutingArmError);
    try {
      ArmCostModel.restore(snap);
      expect.unreachable();
    } catch (e) {
      expect((e as RoutingArmError).code).toBe("negative-count");
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["-0", -0],
    ["negative", -1],
  ])("rejects ewmaUsdRate = %s with code invalid-number", (_label, value) => {
    const snap = {
      version: 1,
      arms: [{ armId: "a/b", totalCount: 1, ewmaUsdRate: value, ewmaLatency: 0, lastAt: 0, usdRateWindow: [], latencyWindow: [] }],
    };
    expect(() => ArmCostModel.restore(snap)).toThrow(RoutingArmError);
    try {
      ArmCostModel.restore(snap);
      expect.unreachable();
    } catch (e) {
      expect((e as RoutingArmError).code).toBe("invalid-number");
    }
  });

  it("rejects a prototype-pollution armId with code unsafe-key", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const snap = {
        version: 1,
        arms: [{ armId: key, totalCount: 1, ewmaUsdRate: 0, ewmaLatency: 0, lastAt: 0, usdRateWindow: [], latencyWindow: [] }],
      };
      expect(() => ArmCostModel.restore(snap)).toThrow(RoutingArmError);
      try {
        ArmCostModel.restore(snap);
        expect.unreachable();
      } catch (e) {
        expect((e as RoutingArmError).code).toBe("unsafe-key");
      }
    }
  });

  it("rejects a prototype-pollution key on the top-level snapshot object with code unsafe-key", () => {
    const snap = JSON.parse('{"version":1,"arms":[],"__proto__":{"polluted":true}}');
    expect(() => ArmCostModel.restore(snap)).toThrow(RoutingArmError);
    try {
      ArmCostModel.restore(snap);
      expect.unreachable();
    } catch (e) {
      expect((e as RoutingArmError).code).toBe("unsafe-key");
    }
    // And prove no actual pollution occurred either way.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects duplicate arm ids with code duplicate-arm", () => {
    const entry = { armId: "a/b", totalCount: 1, ewmaUsdRate: 0, ewmaLatency: 0, lastAt: 0, usdRateWindow: [], latencyWindow: [] };
    const snap = { version: 1, arms: [entry, { ...entry }] };
    expect(() => ArmCostModel.restore(snap)).toThrow(RoutingArmError);
    try {
      ArmCostModel.restore(snap);
      expect.unreachable();
    } catch (e) {
      expect((e as RoutingArmError).code).toBe("duplicate-arm");
    }
  });

  it("rejects a non-array arms field", () => {
    expect(() => ArmCostModel.restore({ version: 1, arms: "not-an-array" })).toThrow(RoutingArmError);
  });

  it("truncates an oversized window array from the snapshot to the restoring instance's configured window size", () => {
    const bigWindow = Array.from({ length: 20 }, (_, i) => i + 1);
    const snap = {
      version: 1,
      arms: [{ armId: "a/b", totalCount: 20, ewmaUsdRate: 0.5, ewmaLatency: 100, lastAt: 0, usdRateWindow: bigWindow, latencyWindow: bigWindow }],
    };
    const restored = ArmCostModel.restore(snap, { window: 3 });
    const entry = restored.snapshot().arms[0];
    expect(entry.usdRateWindow).toHaveLength(3);
    expect(entry.usdRateWindow).toEqual([18, 19, 20]); // keeps the most recent tail
  });
});

// ---------------------------------------------------------------------------
// Real-price sanity: DEFAULT_PRICES actually drives the numbers.
// ---------------------------------------------------------------------------

describe("real prices, not fabricated numbers", () => {
  it("uses the exact real DEFAULT_PRICES entry for each known model's priced-prior", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel();
    const knownIds: Array<[string, string]> = [
      ["anthropic/claude-opus-4-1", "claude-opus-4-1"],
      ["anthropic/claude-sonnet-5", "claude-sonnet-5"],
      ["anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"],
      ["openai/gpt-4o", "gpt-4o"],
    ];
    for (const [armId, modelId] of knownIds) {
      const arm = catalog.get(armId)!;
      const estimate = cost.estimate(arm, CTX, 0);
      const priceEntry = DEFAULT_PRICES.find((p) => p.model === modelId)!;
      const expected =
        (CTX.promptTokens / 1e6) * priceEntry.inPerMTok + (CTX.expectedOutputTokens / 1e6) * priceEntry.outPerMTok;
      expect(estimate.usdMean).toBeCloseTo(expected, 10);
    }
  });

  it("respects a custom prices array passed to ArmCatalog, distinct from DEFAULT_PRICES", () => {
    const registry = realRegistry();
    const customPrices: PriceEntry[] = [{ model: "claude-sonnet-5", inPerMTok: 1, outPerMTok: 2 }];
    const catalog = new ArmCatalog({ registry, prices: customPrices });
    const sonnet = catalog.get("anthropic/claude-sonnet-5")!;
    expect(sonnet.unpriced).toBe(false);
    expect(sonnet.price).toEqual(customPrices[0]);
    // Everything else, including opus (in DEFAULT_PRICES but not in customPrices), is now unpriced.
    const opus = catalog.get("anthropic/claude-opus-4-1")!;
    expect(opus.unpriced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UsageSample plumbing sanity (type-level import touch)
// ---------------------------------------------------------------------------

describe("UsageSample plumbing", () => {
  it("record() accepts a full UsageSample and it is reflected in samples()/estimate()", () => {
    const registry = realRegistry();
    const catalog = new ArmCatalog({ registry });
    const cost = new ArmCostModel({ minSamples: 1 });
    const arm = catalog.get("anthropic/claude-haiku-4-5-20251001")!;
    const sample: UsageSample = { armId: arm.id, tokensIn: 400, tokensOut: 200, usd: 0.0018, latencyMs: 180, at: 0 };
    cost.record(sample);
    expect(cost.samples(arm.id)).toBe(1);
    const estimate = cost.estimate(arm, CTX, 0);
    expect(estimate.source).toBe("measured");
    expect(estimate.armId).toBe(arm.id);
  });
});
