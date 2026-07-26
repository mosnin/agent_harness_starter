# Memory Playbook — Integration Guide

A practical toolkit for giving agents persistent, scoped, policy-driven memory across interactions.

---

## What is Agent Memory?

Agent memory lets an agent retain context across turns, sessions, and agent boundaries. It bundles:
- **What gets stored** — content + metadata written to a durable or transient store
- **How long it lives** — TTL-based expiry, maxEntries eviction
- **How it's retrieved** — semantic search, exact match, recency, or hybrid
- **How new facts interact with old** — append, override, or merge
- **Who can see it** — agent-local, per-user, per-thread, or global
- **Privacy controls** — PII scrubbing, field dropping, payment data blocking
- **Compression** — summarizing old entries to keep the context window lean

---

## 1. Memory Policies

A `MemoryPolicy` is the single source of truth for all memory behavior.

```typescript
import { createMemoryPolicy } from "@/agents/memory/policy";

const policy = createMemoryPolicy({
  ttl: "7d",               // entries expire after 7 days
  maxEntries: 500,         // oldest are evicted first
  persistence: "persistent",
  retrieval: "semantic",   // "semantic" | "exact" | "recency" | "hybrid"
  topK: 5,                 // entries returned per query
  update: "append",        // "append" | "override" | "merge"
  scope: "user",           // "agent" | "user" | "thread" | "global"
  recencyWeight: 0.3,      // for hybrid retrieval (0.0–1.0)
  minScore: 0.2,           // filter out low-relevance results
  privacy: {
    scrubPii: true,
    blockPaymentData: true,
    dropMetadataFields: ["email", "phone"],
    customScrubber: (content) => content.replace(/secret-\w+/g, "[REDACTED]"),
  },
  compression: {
    enabled: true,
    triggerAtEntries: 200,  // compress when > 200 entries
    targetEntries: 80,      // keep the 80 most recent after compression
  },
});
```

### Built-in policies

```typescript
import {
  SESSION_POLICY,          // 24h, transient, recency, thread scope
  USER_LONG_TERM_POLICY,   // 30d, persistent, semantic, user scope, PII scrubbed
  GLOBAL_KNOWLEDGE_POLICY, // forever, persistent, hybrid, global scope
} from "@/agents/memory";
```

### TTL strings

| String     | Duration            |
|------------|---------------------|
| `"30s"`    | 30 seconds          |
| `"5m"`     | 5 minutes           |
| `"2h"`     | 2 hours             |
| `"7d"`     | 7 days              |
| `"forever"`| Never expires       |

---

## 2. Storage Backends (Adapters)

Configure via `MEMORY_PROVIDER` environment variable:

| Provider       | Env value    | Notes                                      |
|----------------|--------------|--------------------------------------------|
| In-process Map | `memory`     | Default. No persistence. Great for testing |
| Postgres/pgvector | `pgvector` | Production-grade. Supabase compatible     |
| Pinecone       | `pinecone`   | Managed vector DB                          |

```bash
MEMORY_PROVIDER=pgvector
DATABASE_URL=postgres://...
```

All adapters implement the same `MemoryAdapter` interface:

```typescript
interface MemoryAdapter {
  store(key, content, metadata?): Promise<MemoryEntry>;
  retrieve(key, query, topK?): Promise<MemoryEntry[]>;
  deleteAll(key): Promise<void>;
  list(key, limit?): Promise<MemoryEntry[]>;
}
```

Swap adapters without changing any application code.

---

## 3. MemoryManager — The High-Level API

`MemoryManager` wraps an adapter with policy enforcement:

```typescript
import { createMemoryManager, scopeKey } from "@/agents/memory/manager";
import { memory, USER_LONG_TERM_POLICY } from "@/agents/memory";

const manager = createMemoryManager({
  adapter: memory,
  policy: USER_LONG_TERM_POLICY,
});

// Store — PII is scrubbed, TTL is stamped into metadata
await manager.store("user:u_123", "User prefers bullet-point responses.");

// Retrieve — uses the policy's retrieval strategy and topK
const entries = await manager.retrieve("user:u_123", "What are the user's formatting preferences?");

// List all entries (recent first)
const all = await manager.list("user:u_123");

// Evict entries past their TTL
const count = await manager.evictExpired("user:u_123");

// Compress if over threshold
await manager.compress("user:u_123");

// GDPR / user deletion
await manager.deleteAll("user:u_123");
```

### Scope keys

`scopeKey()` produces the correct key format for each scope:

```typescript
import { scopeKey } from "@/agents/memory/manager";

scopeKey("agent",  { agentId: "planner" })   // → "agent:planner"
scopeKey("user",   { userId: "u_123" })       // → "user:u_123"
scopeKey("thread", { threadId: "t_abc" })     // → "thread:t_abc"
scopeKey("global", {})                        // → "global"
```

---

## 4. Retrieval Strategies

### Semantic (default)

Best for fuzzy, meaning-based recall. Requires your adapter to embed content (pgvector or Pinecone).

```typescript
const policy = createMemoryPolicy({ retrieval: "semantic", minScore: 0.3 });
```

The adapter computes cosine similarity between the query embedding and stored embeddings.

### Exact

Best for structured facts, IDs, or short phrases. Does substring matching.

```typescript
const policy = createMemoryPolicy({ retrieval: "exact" });
await manager.retrieve(key, "API key");  // finds entries containing "API key"
```

### Recency

Best for conversation history where the last N messages are always relevant.

```typescript
const policy = createMemoryPolicy({ retrieval: "recency", topK: 10 });
// Returns the 10 most recent entries; ignores the query
```

### Hybrid

Weighted combination of semantic relevance and recency.

```typescript
const policy = createMemoryPolicy({
  retrieval: "hybrid",
  recencyWeight: 0.4,  // 40% recency, 60% semantic
  minScore: 0.2,
});
```

Recency score decays as: `1 / (1 + hoursSinceCreation)` — fades over days but never to zero.

### Custom reranking

Apply domain-specific signals after retrieval:

```typescript
import { rerank } from "@/agents/memory/retrieval";

const entries = await manager.retrieve(key, query);
const reranked = rerank(entries, (e) => {
  // Boost entries from trusted sources
  return (e.score ?? 0) * (e.metadata?.trusted ? 1.5 : 1.0);
});
```

---

## 5. Memory Update Modes

### Append (default)

Every write creates a new entry. History accumulates over time.

```typescript
const policy = createMemoryPolicy({ update: "append" });
```

### Override

Replace an existing entry with the same `overrideKey` metadata field.

```typescript
const policy = createMemoryPolicy({ update: "override" });

await manager.store(key, "Preference: dark mode", { overrideKey: "ui.theme" });
// later...
await manager.store(key, "Preference: light mode", { overrideKey: "ui.theme" });
// Only "light mode" remains — the old entry was replaced
```

### Merge

Append mode with a `merge` semantic hint in metadata. The actual merge logic is up to your compressor or retrieval post-processing step.

```typescript
const policy = createMemoryPolicy({ update: "merge" });
```

---

## 6. Privacy Controls

### Built-in PII scrubbing

Automatically strips email, phone, SSN, credit card numbers, and passport-like patterns:

```typescript
const policy = createMemoryPolicy({
  privacy: { scrubPii: true },
});

policy.scrub("Call me at 555-867-5309 or user@example.com");
// → { content: "Call me at [PHONE] or [EMAIL]", metadata: {} }
```

### Block payment data

Throw before storing if credit card patterns are detected:

```typescript
const policy = createMemoryPolicy({
  privacy: { blockPaymentData: true },
});

// Throws: "Memory storage blocked: content contains payment data."
await manager.store(key, "Card: 4111 1111 1111 1111");
```

### Custom scrubber

Apply your own regex or NLP-based scrubber after built-in PII removal:

```typescript
const policy = createMemoryPolicy({
  privacy: {
    scrubPii: true,
    customScrubber: (content) => content.replace(/employee #\d+/gi, "[EMPLOYEE_ID]"),
  },
});
```

### Drop metadata fields

Prevent sensitive metadata keys from being persisted:

```typescript
const policy = createMemoryPolicy({
  privacy: {
    dropMetadataFields: ["internalUserId", "ipAddress", "sessionToken"],
  },
});
```

---

## 7. Memory Compression

When entries grow large, compress older ones into a summary to keep retrieval fast and context windows lean.

### Default compressor (concatenation)

```typescript
const policy = createMemoryPolicy({
  compression: {
    enabled: true,
    triggerAtEntries: 100,  // compress when count exceeds 100
    targetEntries: 40,      // keep 40 most recent; summarize the rest
  },
});
```

### LLM-based compressor

```typescript
import { createLlmCompressor } from "@/agents/memory/compression";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const compressor = createLlmCompressor(async (text) => {
  const result = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    messages: [{
      role: "user",
      content: `Summarize these memory entries into one concise paragraph:\n\n${text}`,
    }],
  });
  return result.content[0].type === "text" ? result.content[0].text : text;
});

const policy = createMemoryPolicy({
  compression: {
    enabled: true,
    triggerAtEntries: 200,
    targetEntries: 80,
    compressor,
  },
});
```

### Trigger compression manually

```typescript
// After a long session:
await manager.compress("user:u_123");
```

---

## 8. Memory Scope

| Scope     | Key prefix    | Shared between                  | Use case                       |
|-----------|---------------|---------------------------------|--------------------------------|
| `agent`   | `agent:name`  | One specific agent instance     | Agent-specific learned behaviors |
| `user`    | `user:id`     | All agents for one user         | User preferences, history      |
| `thread`  | `thread:id`   | All agents in one conversation  | Conversation context           |
| `global`  | `global`      | All users and agents            | Shared knowledge base          |

Multi-scope retrieval (manual):

```typescript
// Retrieve from both user and global scope, combine results
const [userMems, globalMems] = await Promise.all([
  userManager.retrieve("user:u_123", query),
  globalManager.retrieve("global", query),
]);
const combined = [...userMems, ...globalMems]
  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  .slice(0, 10);
```

---

## 9. Connecting Memory to Agent Runs

### Via AgentConfig.memoryKey (built-in harness integration)

```typescript
import { runAgent } from "@/agents/harness";

const result = await runAgent({
  model: "claude-sonnet-4-6",
  system: "You are a helpful assistant.",
  memoryKey: "user:u_123",  // retrieves and injects memories automatically
});
```

### Via plugin (manual injection)

```typescript
import { createMemoryManager, scopeKey } from "@/agents/memory/manager";
import { USER_LONG_TERM_POLICY, memory } from "@/agents/memory";

const manager = createMemoryManager({ adapter: memory, policy: USER_LONG_TERM_POLICY });

const memoryPlugin = {
  name: "memory",

  async onResolveInstructions(ctx) {
    const key = scopeKey("user", { userId: ctx.context?.userId as string });
    const entries = await manager.retrieve(key, ctx.currentMessage ?? "");
    if (entries.length === 0) return ctx.instructions;

    const memBlock = entries.map((e, i) => `[Memory ${i + 1}] ${e.content}`).join("\n");
    return `${ctx.instructions}\n\n## Relevant Memories\n${memBlock}`;
  },

  async onAfterRun(ctx) {
    if (ctx.finalOutput) {
      const key = scopeKey("user", { userId: ctx.context?.userId as string });
      await manager.store(key, ctx.finalOutput);
    }
  },
};
```

---

## 10. TTL + Eviction

Entries older than `ttl` are soft-expired (metadata `expiresAt` is set at write time). Call `evictExpired()` to hard-delete them:

```typescript
// In a scheduled job or after each session:
const evicted = await manager.evictExpired("user:u_123");
console.log(`Evicted ${evicted} expired entries`);
```

For global batch eviction, iterate over all known keys:

```typescript
const knownKeys = await getUserIds(); // your application logic
await Promise.allSettled(knownKeys.map((id) => manager.evictExpired(`user:${id}`)));
```

---

## Quick Reference

| Need | Solution |
|------|---------|
| Store a memory | `manager.store(key, content, metadata?)` |
| Retrieve relevant memories | `manager.retrieve(key, query)` |
| Build a scope key | `scopeKey("user", { userId })` |
| Choose retrieval strategy | `createMemoryPolicy({ retrieval: "hybrid" })` |
| Scrub PII before storage | `createMemoryPolicy({ privacy: { scrubPii: true } })` |
| Compress old entries | `manager.compress(key)` — auto-triggered by policy |
| Evict expired entries | `manager.evictExpired(key)` |
| Inject memories into prompt | `formatMemoriesForPrompt(entries)` |
| Use built-in policy | `SESSION_POLICY` / `USER_LONG_TERM_POLICY` / `GLOBAL_KNOWLEDGE_POLICY` |
| LLM-based compression | `createLlmCompressor(async text => llmSummarize(text))` |
| Switch storage backend | `MEMORY_PROVIDER=pgvector` env var |
