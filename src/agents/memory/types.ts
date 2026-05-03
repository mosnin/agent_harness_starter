/**
 * MemoryAdapter — abstract interface for agent memory / RAG.
 *
 * Implement this interface for your storage backend, then configure it via
 * MEMORY_PROVIDER env var. Built-in adapters: "memory" (in-process),
 * "pgvector" (Supabase/Postgres), "pinecone".
 *
 * The harness automatically calls retrieve() before each run (when memoryKey
 * is set in AgentConfig) and inject the results into the system prompt.
 * Call store() after runs to persist new memories.
 */

export interface MemoryEntry {
  id: string;
  key: string;          // userId, threadId, or any grouping key
  content: string;      // the text to store and retrieve
  metadata?: Record<string, unknown>;
  createdAt: Date;
  score?: number;       // populated by retrieve() — relevance score 0-1
}

export interface MemoryAdapter {
  /**
   * Store a memory entry associated with the given key.
   * If the provider supports embeddings, this will generate + upsert a vector.
   */
  store(key: string, content: string, metadata?: Record<string, unknown>): Promise<MemoryEntry>;

  /**
   * Retrieve the top-k most relevant memories for a key + query.
   * Non-vector adapters fall back to recency-based retrieval.
   */
  retrieve(key: string, query: string, topK?: number): Promise<MemoryEntry[]>;

  /**
   * Delete all memories for a given key (e.g. on user deletion).
   */
  deleteAll(key: string): Promise<void>;

  /**
   * List all memory entries for a key, ordered by recency.
   */
  list(key: string, limit?: number): Promise<MemoryEntry[]>;
}
