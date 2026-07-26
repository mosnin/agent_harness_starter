# Routing Playbook — Integration Guide

A practical toolkit for intelligent model selection, multi-layer response caching, and context budget management.

---

## What is the Routing Layer?

The routing layer makes three decisions before every agent run:

1. **Which model tier?** — Small/medium/large based on task complexity signals
2. **Can we skip the LLM entirely?** — Exact match, semantic, or tool-result cache
3. **What context fits?** — Trim retrieved chunks and history to the model's effective budget

Used together, these can reduce cost by 60–80% on typical workloads without degrading output quality.

---

## 1. Model Router

The router picks a model tier from signals about the incoming request.

```typescript
import { createRouter } from "@/agents/routing";

const router = createRouter({
  smallModel:  "claude-haiku-4-5-20251001",   // fast + cheap: classification, routing, summaries
  mediumModel: "claude-sonnet-4-6",            // balanced: most agent tasks
  largeModel:  "claude-opus-4-7",              // best quality: complex reasoning, novel tasks
});

// In your agent run:
const signals = {
  retrievalCoverage: 0.85,    // 0.0–1.0: how well retrieval answered the query
  selfScore: 0.9,             // 0.0–1.0: model's own confidence estimate
  message: userMessage,       // length check: long messages → larger model
  novelEntities: 2,           // count of unrecognized entities → upgrade tier
  forceLarge: false,          // bypass routing (for critical paths)
};

const { model } = router.select(signals);
// → "claude-haiku-4-5-20251001" if coverage + confidence are high and message is short

const agentResult = await runAgent({ model, message: userMessage });
```

### Tier selection logic

| Signal | Effect |
|--------|--------|
| `retrievalCoverage >= 0.8` AND `selfScore >= 0.8` | Small model |
| `message.length > 2000` | Upgrade to medium |
| `novelEntities >= 3` | Upgrade to medium or large |
| `forceLarge: true` | Always large |
| Default (no strong signals) | Medium |

### Env var overrides

```bash
ROUTER_SMALL_MODEL=claude-haiku-4-5-20251001
ROUTER_MEDIUM_MODEL=claude-sonnet-4-6
ROUTER_LARGE_MODEL=claude-opus-4-7
```

### Escalation

If the medium model produces low-confidence output, escalate:

```typescript
const plan = await router.escalate({
  currentModel: "claude-sonnet-4-6",
  reason: "selfScore below threshold",
  selfScore: 0.4,
});
// → { escalate: true, model: "claude-opus-4-7", reason: "..." }

if (plan.escalate) {
  return await runAgent({ model: plan.model, message });
}
```

---

## 2. Three-Layer Cache

The cache checks three layers before calling the LLM — saving tokens and latency when possible.

```typescript
import { createCacheManager, exactCacheKey, semanticCacheKey, toolCacheKey, TTL } from "@/agents/routing";

const cache = createCacheManager(/* optional Redis adapter */);

// Layer 1 — Exact match: same prompt + tools → same response
const eKey = exactCacheKey(prompt, toolNames);
const hit = await cache.get(eKey);
if (hit) return hit;  // ~0ms, zero tokens

// Layer 2 — Semantic match: similar prompts share a response (simhash-based)
const sKey = semanticCacheKey(prompt);
const semHit = await cache.get(sKey);
if (semHit) return semHit;

// Layer 3 — Tool result cache: same tool + args → same data
const tKey = toolCacheKey("web_search", { query: "LLM benchmarks 2025" }, "v1");
const toolHit = await cache.get(tKey);
if (toolHit) return toolHit;

// Cache miss — run LLM
const result = await runAgent({ model, message });

// Store (TTL per layer)
await cache.set(eKey, result, TTL.exact);      // 24h
await cache.set(sKey, result, TTL.semantic);   // 6h
```

### Built-in TTLs

| Layer | Key prefix | Default TTL | Best for |
|-------|-----------|-------------|----------|
| Exact | `io:{hash}` | 24h | Repeated identical prompts |
| Semantic | `sem:{simhash}` | 6h | Paraphrased but equivalent questions |
| Tool result | `tool:{hash}` | 1h | External API / search results |
| Immutable | _(custom)_ | No expiry | Static facts, compiled knowledge |

### In-memory cache (default)

```typescript
import { defaultCache } from "@/agents/routing";

await defaultCache.set("key", "value", 3600);
const val = await defaultCache.get("key");
await defaultCache.del("key");
```

### Redis cache (production)

```typescript
import { RedisCache, createCacheManager } from "@/agents/routing";
import { Redis } from "@upstash/redis";

const redis = new Redis({ url: process.env.UPSTASH_REDIS_URL!, token: process.env.UPSTASH_REDIS_TOKEN! });
const cache = createCacheManager(new RedisCache(redis));
```

The `RedisCache` adapter accepts any client that implements:
```typescript
interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}
```

### Invalidation

```typescript
// Invalidate both exact and semantic keys for a prompt
await cache.invalidate(exactCacheKey(prompt, tools), semanticCacheKey(prompt));
```

---

## 3. Context Budget Management

Prevents exceeding model context limits by trimming retrieved chunks and history.

```typescript
import { buildContext, CONTEXT_BUDGETS, estimateTokens, trimChunks, truncateHistory } from "@/agents/routing";

// Built-in tiers
CONTEXT_BUDGETS.small  // { maxTokens: 1024,  maxChunks: 3,  historyTurns: 4  }
CONTEXT_BUDGETS.medium // { maxTokens: 4096,  maxChunks: 8,  historyTurns: 12 }
CONTEXT_BUDGETS.large  // { maxTokens: 16384, maxChunks: 20, historyTurns: 40 }

// Build context within budget
const context = buildContext({
  budget: CONTEXT_BUDGETS.medium,
  systemPrompt: "You are a helpful assistant.",
  chunks: retrievedMemoryChunks,   // trimmed to maxChunks if over budget
  history: conversationHistory,    // truncated to historyTurns if over budget
  message: userMessage,
});

// context.system   — final system prompt
// context.messages — history + current message, within token budget
// context.trimmed  — true if any content was cut

await runAgent({
  model,
  system: context.system,
  inputItems: context.messages,
});
```

### Token estimation

```typescript
import { estimateTokens } from "@/agents/routing";

const tokens = estimateTokens("Hello, world!");
// → 4 (Math.ceil(text.length / 4) — fast approximation, not exact)
```

For exact token counts, use `tiktoken` or the model's tokenizer directly. `estimateTokens` is intentionally fast and approximate — use it for budget guardrails, not billing.

### Manual trimming

```typescript
import { trimChunks, truncateHistory } from "@/agents/routing";

// Keep only the most relevant chunks within budget
const trimmed = trimChunks(retrievedChunks, CONTEXT_BUDGETS.small);

// Keep only the most recent N turns
const shortened = truncateHistory(messages, CONTEXT_BUDGETS.medium);
```

---

## 4. Putting It Together

A full routing + caching + context pipeline before every agent run:

```typescript
import { createRouter, createCacheManager, exactCacheKey, semanticCacheKey, buildContext, CONTEXT_BUDGETS } from "@/agents/routing";
import { memory } from "@/agents/memory";

const router = createRouter({});  // uses ROUTER_*_MODEL env vars
const cache  = createCacheManager();

async function runWithRouting(userId: string, message: string) {
  // 1. Check cache
  const cacheKey = exactCacheKey(message, []);
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  // 2. Retrieve memory
  const memories = await memory.retrieve(`user:${userId}`, message, 5);

  // 3. Select model
  const { model } = router.select({
    message,
    retrievalCoverage: memories.length > 0 ? 0.8 : 0.2,
    selfScore: 0.7,
    novelEntities: 0,
  });

  // 4. Build context within budget
  const budget = model.includes("haiku") ? CONTEXT_BUDGETS.small : CONTEXT_BUDGETS.medium;
  const ctx = buildContext({
    budget,
    systemPrompt: "You are a helpful assistant.",
    chunks: memories.map((m) => ({ content: m.content, tokens: Math.ceil(m.content.length / 4) })),
    history: [],
    message,
  });

  // 5. Run agent
  const result = await runAgent({ model, system: ctx.system, inputItems: ctx.messages });

  // 6. Store in cache
  await cache.set(cacheKey, result.finalOutput, 86400);

  return result.finalOutput;
}
```

---

## Quick Reference

| Need | Solution |
|------|---------|
| Pick a model tier | `router.select(signals).model` |
| Exact response cache | `cache.get(exactCacheKey(prompt, tools))` |
| Semantic response cache | `cache.get(semanticCacheKey(prompt))` |
| Tool result cache | `cache.get(toolCacheKey(name, args, version))` |
| Production cache | `createCacheManager(new RedisCache(redisClient))` |
| Trim retrieved chunks | `trimChunks(chunks, CONTEXT_BUDGETS.medium)` |
| Truncate history | `truncateHistory(messages, CONTEXT_BUDGETS.small)` |
| Full pipeline | `buildContext({ budget, systemPrompt, chunks, history, message })` |
| Env overrides | `ROUTER_SMALL_MODEL`, `ROUTER_MEDIUM_MODEL`, `ROUTER_LARGE_MODEL` |
