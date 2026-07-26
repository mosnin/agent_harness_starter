/**
 * Custom memory adapter stubs — reference implementations for bringing
 * your own storage backend.
 *
 * Copy and adapt these files to create a custom MemoryAdapter:
 *
 *   1. Implement the MemoryAdapter interface from "../types"
 *   2. Add any provider-specific initialization (connection pooling, auth, etc.)
 *   3. Export your class and register it in the factory switch in "../index.ts"
 *   4. Set MEMORY_PROVIDER=<your-key> in your environment
 *
 * Built-in adapters live in the parent directory:
 *   - InMemoryAdapter  (in-memory.ts)    — default, non-persistent
 *   - PgVectorAdapter  (pgvector.ts)     — Postgres + pgvector (Supabase compatible)
 *   - PineconeAdapter  (pinecone.ts)     — Pinecone managed vector DB
 *
 * Example skeleton:
 *
 *   import type { MemoryAdapter, MemoryEntry } from "../types";
 *
 *   export class MyCustomAdapter implements MemoryAdapter {
 *     async store(key, content, metadata?) { ... }
 *     async retrieve(key, query, topK = 5) { ... }
 *     async deleteAll(key) { ... }
 *     async list(key, limit = 50) { ... }
 *   }
 *
 * For semantic (vector) retrieval, generate embeddings in store() and
 * perform cosine similarity search in retrieve(). Non-vector adapters
 * should fall back to recency or keyword-based retrieval.
 */

export {};
