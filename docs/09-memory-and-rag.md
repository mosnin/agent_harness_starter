# Agent Memory & RAG

## Overview

The `MemoryAdapter` interface lets you store and retrieve agent memories, enabling context persistence across sessions.

Configure via `MEMORY_PROVIDER` env var:

| Value | Backend | Notes |
|-------|---------|-------|
| `memory` (default) | In-process Map | Non-persistent, dev/test only |
| `pgvector` | Postgres + pgvector | Supabase compatible, semantic search |
| `pinecone` | Pinecone | Managed vector DB |

---

## Setup

### Activate memory for an agent

```typescript
const agentConfig: AgentConfig = {
  name: "MyAgent",
  memoryKey: "userId",  // harness auto-retrieves memories keyed by ctx.userId
  // ...
};
```

The harness will:
1. Retrieve the top-5 most relevant memories for `ctx.userId` + the current message
2. Inject them into the system prompt as `## Relevant memories`
3. After the run, store the Q&A pair for future retrieval

### Pgvector setup (Supabase)

Run this SQL once in your Supabase project:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE agent_memories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL,
  content     TEXT NOT NULL,
  metadata    JSONB,
  embedding   VECTOR(1536),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON agent_memories USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX ON agent_memories (key);

-- Retrieval function
CREATE OR REPLACE FUNCTION match_agent_memories(
  query_embedding VECTOR(1536),
  match_key TEXT,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID, key TEXT, content TEXT,
  metadata JSONB, created_at TIMESTAMPTZ, similarity FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT id, key, content, metadata, created_at,
    1 - (embedding <=> query_embedding) AS similarity
  FROM agent_memories
  WHERE key = match_key
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

Then set:
```
MEMORY_PROVIDER=pgvector
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=...  # used for embeddings
```

### Pinecone setup

1. Create an index in the Pinecone dashboard: dimension=1536, metric=cosine
2. Set env vars:
```
MEMORY_PROVIDER=pinecone
PINECONE_API_KEY=...
PINECONE_INDEX=agent-memory
OPENAI_API_KEY=...
```

---

## Manual usage

```typescript
import { memory } from "@/agents/memory";

// Store a memory
await memory.store("user-123", "User prefers TypeScript over Python", { source: "conversation" });

// Retrieve relevant memories
const memories = await memory.retrieve("user-123", "what language should I use?", 5);

// List recent memories
const recent = await memory.list("user-123", 20);

// Delete all memories for a user (e.g. GDPR deletion)
await memory.deleteAll("user-123");
```

---

## Custom adapter

Implement `MemoryAdapter` to use any backend:

```typescript
import type { MemoryAdapter, MemoryEntry } from "@/agents/memory/types";

export class RedisMemoryAdapter implements MemoryAdapter {
  async store(key, content, metadata) { /* ... */ }
  async retrieve(key, query, topK = 5) { /* ... */ }
  async deleteAll(key) { /* ... */ }
  async list(key, limit = 50) { /* ... */ }
}

// Register at startup in src/instrumentation.ts:
import { setMemoryAdapter } from "@/agents/memory";
setMemoryAdapter(new MyCustomAdapter());
```
