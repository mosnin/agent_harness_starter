import { describe, it, expect, beforeEach } from "vitest";
import { createRouter } from "../routing/router";
import {
  exactCacheKey,
  semanticCacheKey,
  toolCacheKey,
  InMemoryCache,
  createCacheManager,
  TTL,
} from "../routing/cache";
import {
  estimateTokens,
  trimChunks,
  truncateHistory,
  buildContext,
  CONTEXT_BUDGETS,
} from "../routing/context-budget";

// ── Router ────────────────────────────────────────────────────────────────────

describe("createRouter", () => {
  const router = createRouter({
    smallModel: "haiku",
    mediumModel: "sonnet",
    largeModel: "opus",
    coverageThreshold: 0.6,
    selfScoreThreshold: 0.75,
    mediumLengthThreshold: 100,
    largeLengthThreshold: 300,
  });

  it("selects small tier for short messages with good coverage", () => {
    const plan = router.select({ message: "short msg", retrievalCoverage: 0.9 });
    expect(plan.tier).toBe("small");
    expect(plan.model).toBe("haiku");
  });

  it("selects medium tier for medium-length messages", () => {
    const plan = router.select({ message: "a".repeat(150) });
    expect(plan.tier).toBe("medium");
    expect(plan.model).toBe("sonnet");
  });

  it("selects large tier for very long messages", () => {
    const plan = router.select({ message: "a".repeat(400) });
    expect(plan.tier).toBe("large");
    expect(plan.model).toBe("opus");
  });

  it("escalates to large when coverage is below threshold", () => {
    const plan = router.select({ message: "short", retrievalCoverage: 0.4 });
    expect(plan.tier).toBe("large");
  });

  it("escalates to large when self-score is below threshold", () => {
    const plan = router.select({ message: "short", selfScore: 0.5 });
    expect(plan.tier).toBe("large");
  });

  it("escalates to large when forceLarge=true", () => {
    const plan = router.select({ message: "short", forceLarge: true });
    expect(plan.tier).toBe("large");
  });

  it("escalates to large when novelEntities=true", () => {
    const plan = router.select({ message: "short", novelEntities: true });
    expect(plan.tier).toBe("large");
  });

  it("returns correct retrieval k per tier", () => {
    expect(router.select({ message: "short" }).retrievalK).toBe(3);
    expect(router.select({ message: "a".repeat(150) }).retrievalK).toBe(4);
    expect(router.select({ message: "a".repeat(400) }).retrievalK).toBe(6);
  });

  it("escalate() returns next tier plan", () => {
    const small = router.select({ message: "short" });
    const medium = router.escalate(small);
    expect(medium?.tier).toBe("medium");
  });

  it("escalate() returns null at large tier", () => {
    const large = router.select({ message: "a".repeat(400) });
    expect(router.escalate(large)).toBeNull();
  });
});

// ── Cache ─────────────────────────────────────────────────────────────────────

describe("cache key builders", () => {
  it("exactCacheKey produces stable key for same inputs", () => {
    expect(exactCacheKey("hello", ["tool_a"])).toBe(exactCacheKey("hello", ["tool_a"]));
  });

  it("exactCacheKey differs for different prompts", () => {
    expect(exactCacheKey("hello")).not.toBe(exactCacheKey("world"));
  });

  it("exactCacheKey is order-insensitive for tools", () => {
    expect(exactCacheKey("p", ["b", "a"])).toBe(exactCacheKey("p", ["a", "b"]));
  });

  it("semanticCacheKey prefixed with sem:", () => {
    expect(semanticCacheKey("hello world")).toMatch(/^sem:/);
  });

  it("toolCacheKey prefixed with tool:", () => {
    expect(toolCacheKey("web_search", { q: "test" })).toMatch(/^tool:/);
  });
});

describe("InMemoryCache", () => {
  let cache: InMemoryCache;
  beforeEach(() => { cache = new InMemoryCache(); });

  it("get returns null for missing key", async () => {
    expect(await cache.get("nope")).toBeNull();
  });

  it("set and get round-trips a value", async () => {
    await cache.set("k", "value");
    expect(await cache.get("k")).toBe("value");
  });

  it("del removes a key", async () => {
    await cache.set("k", "v");
    await cache.del("k");
    expect(await cache.get("k")).toBeNull();
  });

  it("respects TTL expiry", async () => {
    await cache.set("k", "v", { ttlSeconds: 0 });
    // TTL of 0 means expired immediately
    await new Promise((r) => setTimeout(r, 5));
    expect(await cache.get("k")).toBeNull();
  });

  it("delByPrefix removes matching keys", async () => {
    await cache.set("io:abc", "1");
    await cache.set("io:def", "2");
    await cache.set("tool:xyz", "3");
    await cache.delByPrefix("io:");
    expect(await cache.get("io:abc")).toBeNull();
    expect(await cache.get("io:def")).toBeNull();
    expect(await cache.get("tool:xyz")).toBe("3");
  });
});

describe("createCacheManager", () => {
  it("returns exact hit when present", async () => {
    const adapter = new InMemoryCache();
    const mgr = createCacheManager(adapter);
    await adapter.set("io:abc", "cached");
    expect(await mgr.get("io:abc")).toBe("cached");
  });

  it("falls through to semantic key when exact misses", async () => {
    const adapter = new InMemoryCache();
    const mgr = createCacheManager(adapter);
    await adapter.set("sem:xyz", "sem-cached");
    expect(await mgr.get("io:missing", "sem:xyz")).toBe("sem-cached");
  });

  it("invalidate removes both exact and semantic keys", async () => {
    const adapter = new InMemoryCache();
    const mgr = createCacheManager(adapter);
    const prompt = "test prompt";
    const eKey = exactCacheKey(prompt);
    const sKey = semanticCacheKey(prompt);
    await adapter.set(eKey, "1");
    await adapter.set(sKey, "2");
    await mgr.invalidate(prompt);
    expect(await adapter.get(eKey)).toBeNull();
    expect(await adapter.get(sKey)).toBeNull();
  });
});

describe("TTL constants", () => {
  it("exact TTL is 24h in seconds", () => {
    expect(TTL.exact).toBe(86400);
  });
  it("semantic TTL is 6h in seconds", () => {
    expect(TTL.semantic).toBe(21600);
  });
});

// ── Context budget ────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("estimates 1 token per 4 chars", () => {
    expect(estimateTokens("1234")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
  });
});

describe("trimChunks", () => {
  const budget = CONTEXT_BUDGETS.small;

  it("returns top-k chunks by score", () => {
    const chunks = [
      { id: "1", text: "a", score: 0.5 },
      { id: "2", text: "b", score: 0.9 },
      { id: "3", text: "c", score: 0.7 },
      { id: "4", text: "d", score: 0.3 },
    ];
    const result = trimChunks(chunks, budget);
    expect(result).toHaveLength(budget.maxChunks);
    expect(result[0].id).toBe("2"); // highest score first
  });

  it("truncates oversized chunks", () => {
    const longText = "x".repeat(10_000);
    const result = trimChunks([{ id: "1", text: longText, score: 1 }], budget);
    expect(result[0].text.endsWith("…")).toBe(true);
    expect(result[0].text.length).toBeLessThan(longText.length);
  });
});

describe("truncateHistory", () => {
  const budget = CONTEXT_BUDGETS.small; // maxHistoryTokens = 400

  it("preserves system messages", () => {
    const msgs = [
      { role: "system" as const, content: "System prompt" },
      { role: "user" as const, content: "Hello" },
    ];
    const result = truncateHistory(msgs, budget);
    expect(result.some((m) => m.role === "system")).toBe(true);
  });

  it("truncates old messages when over budget", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: "x".repeat(100),
    }));
    const result = truncateHistory(msgs, budget);
    // Should have fewer messages than input
    expect(result.length).toBeLessThan(msgs.length);
  });

  it("keeps newest messages when truncating", () => {
    const msgs = [
      { role: "user" as const, content: "OLD" },
      { role: "user" as const, content: "x".repeat(100) },
      { role: "user" as const, content: "NEW" },
    ];
    const result = truncateHistory(msgs, { ...budget, maxHistoryTokens: 10 });
    const contents = result.map((m) => m.content);
    expect(contents).toContain("NEW");
  });
});

describe("buildContext", () => {
  it("returns tier, estimatedTokens, and trimmed content", () => {
    const ctx = buildContext({
      tier: "small",
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello" }],
      chunks: [{ id: "1", text: "Some context", score: 0.9 }],
    });
    expect(ctx.tier).toBe("small");
    expect(ctx.estimatedTokens).toBeGreaterThan(0);
    expect(ctx.systemPrompt).toBeTruthy();
    expect(ctx.chunks).toHaveLength(1);
  });
});
