/**
 * VectorStore — in-memory vector store wrapping HNSWIndex.
 *
 * Supports LRU eviction (maxEntries) and optional TTL expiration.
 * Zero external dependencies.
 */

import { HNSWIndex } from "./hnsw";
import type { HNSWConfig, HNSWSearchResult } from "./hnsw";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VectorEntry {
  id: string;
  text: string;
  vector: number[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
}

export interface VectorStoreConfig {
  dimensions: number;
  /** LRU eviction when size exceeds this. Default: 10000 */
  maxEntries?: number;
  /** Auto-expire entries after this many ms. Default: no TTL */
  ttlMs?: number;
  hnsw?: Partial<HNSWConfig>;
}

// ---------------------------------------------------------------------------
// VectorStore
// ---------------------------------------------------------------------------

export class VectorStore {
  private readonly index: HNSWIndex;
  private readonly entries: Map<string, VectorEntry>;
  private readonly maxEntries: number;
  private readonly ttlMs: number | undefined;

  constructor(config: VectorStoreConfig) {
    this.maxEntries = config.maxEntries ?? 10_000;
    this.ttlMs = config.ttlMs;
    this.entries = new Map();
    this.index = new HNSWIndex({
      dimensions: config.dimensions,
      ...config.hnsw,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get size(): number {
    return this.entries.size;
  }

  upsert(entry: Omit<VectorEntry, "createdAt">): void {
    const now = Date.now();
    const full: VectorEntry = {
      ...entry,
      createdAt: now,
      expiresAt: this.ttlMs !== undefined ? now + this.ttlMs : entry.expiresAt,
    };

    // If updating an existing entry, delete it first to refresh insertion order
    if (this.entries.has(entry.id)) {
      this.entries.delete(entry.id);
    }

    this.entries.set(entry.id, full);
    this.index.add(entry.id, entry.vector, entry.metadata);

    // LRU eviction: remove oldest entry when over limit
    if (this.entries.size > this.maxEntries) {
      const oldestId = this.entries.keys().next().value;
      if (oldestId !== undefined) {
        this.entries.delete(oldestId);
        this.index.remove(oldestId);
      }
    }
  }

  search(
    query: number[],
    k = 10
  ): Array<VectorEntry & { score: number }> {
    const now = Date.now();
    const results: Array<VectorEntry & { score: number }> = [];

    const hits: HNSWSearchResult[] = this.index.search(query, k * 2); // over-fetch to account for expired

    for (const hit of hits) {
      const entry = this.entries.get(hit.id);
      if (!entry) continue;
      if (entry.expiresAt !== undefined && entry.expiresAt < now) continue;
      results.push({ ...entry, score: hit.score });
      if (results.length >= k) break;
    }

    return results;
  }

  get(id: string): VectorEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
      // Lazy eviction
      this.entries.delete(id);
      this.index.remove(id);
      return undefined;
    }
    return entry;
  }

  delete(id: string): boolean {
    const existed = this.entries.delete(id);
    this.index.remove(id);
    return existed;
  }

  evictExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt < now) {
        this.entries.delete(id);
        this.index.remove(id);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    const ids = Array.from(this.entries.keys());
    this.entries.clear();
    for (const id of ids) {
      this.index.remove(id);
    }
  }
}
