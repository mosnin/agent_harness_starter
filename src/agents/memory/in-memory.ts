/**
 * In-memory MemoryAdapter — stores entries in a Map.
 * Useful for development and testing. Not persistent across restarts.
 * Retrieval is keyword-based (no embeddings).
 */

import { randomUUID } from "crypto";
import type { MemoryAdapter, MemoryEntry } from "./types";

export class InMemoryAdapter implements MemoryAdapter {
  private _entries = new Map<string, MemoryEntry[]>();

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
    const existing = this._entries.get(key) ?? [];
    existing.push(entry);
    this._entries.set(key, existing);
    return entry;
  }

  async retrieve(key: string, query: string, topK = 5): Promise<MemoryEntry[]> {
    const entries = this._entries.get(key) ?? [];
    if (!query) return entries.slice(-topK).reverse();
    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);

    return entries
      .map((e) => {
        const text = e.content.toLowerCase();
        const matches = queryWords.filter((w) => text.includes(w)).length;
        return { ...e, score: queryWords.length > 0 ? matches / queryWords.length : 0 };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, topK);
  }

  async deleteAll(key: string): Promise<void> {
    this._entries.delete(key);
  }

  async list(key: string, limit = 50): Promise<MemoryEntry[]> {
    const entries = this._entries.get(key) ?? [];
    return entries.slice(-limit).reverse();
  }
}
