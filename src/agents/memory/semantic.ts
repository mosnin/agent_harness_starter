/**
 * SemanticMemoryAdapter — wires together VectorStore (backed by HNSWIndex) and
 * EmbeddingService to provide vector-based memory retrieval.
 *
 * Each memory is embedded on write and stored in the vector store. Retrieval
 * embeds the query, runs approximate nearest-neighbour search, and filters by
 * key and minimum similarity score before returning MemoryEntry objects.
 */

import { randomUUID } from "crypto";
import { VectorStore } from "./vector-store";
import type { EmbeddingService } from "../embeddings/types";
import { createEmbeddingService } from "../embeddings/service";
import type { MemoryAdapter, MemoryEntry } from "./types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SemanticMemoryConfig {
  /** Embedding service to use. Defaults to mock (for testing without API key). */
  embeddings?: EmbeddingService;
  /** Dimensions of embeddings. Must match the embedding service. Default: 384 (mock) */
  dimensions?: number;
  /** Max memories to store before LRU eviction. Default: 10000 */
  maxEntries?: number;
  /** TTL for memories in ms. Default: undefined (no expiry) */
  ttlMs?: number;
  /** Number of results to return from similarity search. Default: 5 */
  topK?: number;
  /** Minimum similarity score (cosine, 0-1) to include in results. Default: 0.0 */
  minScore?: number;
}

// ---------------------------------------------------------------------------
// SemanticMemoryAdapter
// ---------------------------------------------------------------------------

export class SemanticMemoryAdapter implements MemoryAdapter {
  private readonly embeddings: EmbeddingService;
  private readonly vectorStore: VectorStore;
  /** O(1) id → MemoryEntry lookup */
  private readonly entryMap: Map<string, MemoryEntry> = new Map();
  private readonly topK: number;
  private readonly minScore: number;

  constructor(
    embeddings: EmbeddingService,
    vectorStore: VectorStore,
    opts: Pick<SemanticMemoryConfig, "topK" | "minScore"> = {}
  ) {
    this.embeddings = embeddings;
    this.vectorStore = vectorStore;
    this.topK = opts.topK ?? 5;
    this.minScore = opts.minScore ?? 0.0;
  }

  // -------------------------------------------------------------------------
  // MemoryAdapter implementation
  // -------------------------------------------------------------------------

  /**
   * Embed `content`, upsert into the vector store, and cache the MemoryEntry
   * in the local map. Returns the stored entry.
   */
  async store(
    key: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<MemoryEntry> {
    const result = await this.embeddings.embed(content);

    const entry: MemoryEntry = {
      id: randomUUID(),
      key,
      content,
      metadata,
      createdAt: new Date(),
    };

    this.vectorStore.upsert({
      id: entry.id,
      text: content,
      vector: result.vector,
      metadata: { key, ...metadata, __entryId: entry.id },
    });

    this.entryMap.set(entry.id, entry);

    return entry;
  }

  /**
   * Embed `query`, search the vector store, filter by key and minScore,
   * and return up to `topK` MemoryEntry objects (most similar first).
   */
  async retrieve(key: string, query: string, topK?: number): Promise<MemoryEntry[]> {
    const limit = topK ?? this.topK;
    const result = await this.embeddings.embed(query);

    // Over-fetch to allow for key filtering
    const hits = this.vectorStore.search(result.vector, limit * 10);

    const filtered: MemoryEntry[] = [];
    for (const hit of hits) {
      if (hit.score < this.minScore) continue;

      const entry = this.entryMap.get(hit.id);
      if (!entry) continue;
      if (entry.key !== key) continue;

      filtered.push({ ...entry, score: hit.score });
      if (filtered.length >= limit) break;
    }

    return filtered;
  }

  /**
   * Delete all memories that share the given key.
   */
  async deleteAll(key: string): Promise<void> {
    const toDelete: string[] = [];
    for (const [id, entry] of this.entryMap) {
      if (entry.key === key) toDelete.push(id);
    }
    for (const id of toDelete) {
      this.vectorStore.delete(id);
      this.entryMap.delete(id);
    }
  }

  /**
   * List all memory entries for a key, ordered by recency (newest first).
   */
  async list(key: string, limit = 50): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    for (const entry of this.entryMap.values()) {
      if (entry.key === key) entries.push(entry);
    }
    // Sort newest first
    entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return entries.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Extra helpers (not part of MemoryAdapter interface)
  // -------------------------------------------------------------------------

  /**
   * Delete a single memory by id.
   */
  deleteById(id: string): boolean {
    if (!this.entryMap.has(id)) return false;
    this.vectorStore.delete(id);
    this.entryMap.delete(id);
    return true;
  }

  /**
   * Clear all memories (all keys).
   */
  clearAll(): void {
    this.vectorStore.clear();
    this.entryMap.clear();
  }

  /** Expose the underlying vector store for advanced use. */
  get vectorIndex(): VectorStore {
    return this.vectorStore;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SemanticMemoryAdapter with sensible defaults.
 * Pass `config.embeddings` to bring your own embedding service;
 * otherwise a MockEmbeddingService is used (no API key required).
 */
export function createSemanticMemory(
  config?: SemanticMemoryConfig
): SemanticMemoryAdapter {
  const dimensions = config?.dimensions ?? 384;

  const embeddings =
    config?.embeddings ??
    createEmbeddingService({ provider: "mock", mock: { dimensions } });

  const vectorStore = new VectorStore({
    dimensions,
    maxEntries: config?.maxEntries ?? 10_000,
    ttlMs: config?.ttlMs,
  });

  return new SemanticMemoryAdapter(embeddings, vectorStore, {
    topK: config?.topK,
    minScore: config?.minScore,
  });
}
