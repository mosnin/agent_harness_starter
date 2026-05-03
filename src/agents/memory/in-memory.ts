/**
 * In-memory MemoryAdapter — stores entries in a Map.
 * Useful for development and testing. Not persistent across restarts.
 * Retrieval is keyword-based (no embeddings).
 */

import { randomUUID } from "crypto";
import type { MemoryAdapter, MemoryEntry } from "./types";

export class InMemoryAdapter implements MemoryAdapter {
  private store = new Map<string, MemoryEntry[]>();

  async store(
    key: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: randomUUID(),
      key,
      content,
      metadata,
      createdAt: new Date(),
    };
    const existing = this.store.get(key) ?? [];
    existing.push(entry);
    this.store.set(key, existing);
    return entry;
  }

  async retrieve(key: string, query: string, topK = 5): Promise<MemoryEntry[]> {
    const entries = this.store.get(key) ?? [];
    const queryWords = query.toLowerCase().split(/\s+/);

    return entries
      .map((e) => {
        const text = e.content.toLowerCase();
        const matches = queryWords.filter((w) => text.includes(w)).length;
        return { ...e, score: matches / queryWords.length };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, topK);
  }

  async deleteAll(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(key: string, limit = 50): Promise<MemoryEntry[]> {
    const entries = this.store.get(key) ?? [];
    return entries.slice(-limit).reverse();
  }
}
