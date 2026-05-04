/**
 * Memory retrieval strategies.
 *
 * Four strategies align with MemoryPolicy.retrieval:
 *   - "semantic"  — vector similarity (requires adapter with real embeddings)
 *   - "exact"     — substring / keyword match
 *   - "recency"   — most recent entries first, ignores query
 *   - "hybrid"    — semantic score + recency score, weighted by recencyWeight
 *
 * Usage:
 *   import { createRetriever } from "@/agents/memory/retrieval";
 *
 *   const retriever = createRetriever(adapter, policy);
 *   const entries   = await retriever.retrieve(key, query);
 */

import type { MemoryAdapter, MemoryEntry } from "./types";
import type { MemoryPolicy } from "./policy";

// ── Retriever interface ───────────────────────────────────────────────────────

export interface Retriever {
  retrieve(key: string, query: string): Promise<MemoryEntry[]>;
}

// ── Semantic retriever ────────────────────────────────────────────────────────

/**
 * Delegates to adapter.retrieve() which performs vector similarity search.
 * Filters results below policy.minScore.
 */
function semanticRetriever(adapter: MemoryAdapter, policy: MemoryPolicy): Retriever {
  return {
    async retrieve(key, query) {
      const results = await adapter.retrieve(key, query, policy.config.topK);
      const minScore = policy.config.minScore;
      return minScore > 0
        ? results.filter((e) => (e.score ?? 1) >= minScore)
        : results;
    },
  };
}

// ── Exact retriever ───────────────────────────────────────────────────────────

/**
 * Returns entries whose content contains the query as a substring (case-insensitive).
 * Falls back to recency order when the query is empty.
 */
function exactRetriever(adapter: MemoryAdapter, policy: MemoryPolicy): Retriever {
  return {
    async retrieve(key, query) {
      const all = await adapter.list(key, policy.config.maxEntries);
      if (!query.trim()) return all.slice(0, policy.config.topK);
      const lower = query.toLowerCase();
      return all
        .filter((e) => e.content.toLowerCase().includes(lower))
        .slice(0, policy.config.topK)
        .map((e) => ({ ...e, score: 1.0 }));
    },
  };
}

// ── Recency retriever ─────────────────────────────────────────────────────────

/**
 * Returns the N most recent entries. Query is ignored.
 */
function recencyRetriever(adapter: MemoryAdapter, policy: MemoryPolicy): Retriever {
  return {
    async retrieve(key, _query) {
      const entries = await adapter.list(key, policy.config.topK);
      return entries.map((e, i) => ({
        ...e,
        score: 1 - i / Math.max(entries.length, 1),
      }));
    },
  };
}

// ── Hybrid retriever ──────────────────────────────────────────────────────────

/**
 * Combines semantic relevance with recency.
 * Final score = (1 - recencyWeight) * semanticScore + recencyWeight * recencyScore
 *
 * recencyScore is computed as: 1 / (1 + hoursSinceCreation)
 * This decays to ~0 after a week but never fully disappears.
 */
function hybridRetriever(adapter: MemoryAdapter, policy: MemoryPolicy): Retriever {
  const semantic = semanticRetriever(adapter, policy);
  return {
    async retrieve(key, query) {
      const semResults = await semantic.retrieve(key, query);
      const recencyWeight = policy.config.recencyWeight;
      const semanticWeight = 1 - recencyWeight;
      const now = Date.now();

      const reranked = semResults
        .map((e) => {
          const hoursSince = (now - new Date(e.createdAt).getTime()) / 3_600_000;
          const recencyScore = 1 / (1 + hoursSince);
          const semScore = e.score ?? 0;
          return { ...e, score: semanticWeight * semScore + recencyWeight * recencyScore };
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      const minScore = policy.config.minScore;
      return minScore > 0
        ? reranked.filter((e) => (e.score ?? 0) >= minScore)
        : reranked;
    },
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a retriever that matches the strategy in the given policy.
 */
export function createRetriever(adapter: MemoryAdapter, policy: MemoryPolicy): Retriever {
  switch (policy.config.retrieval) {
    case "semantic":  return semanticRetriever(adapter, policy);
    case "exact":     return exactRetriever(adapter, policy);
    case "recency":   return recencyRetriever(adapter, policy);
    case "hybrid":    return hybridRetriever(adapter, policy);
    default:          return semanticRetriever(adapter, policy);
  }
}

// ── Reranker (optional post-processing) ──────────────────────────────────────

/**
 * Re-rank a set of results using a custom scoring function.
 * Useful for injecting domain-specific signals (e.g. source authority).
 */
export function rerank(
  entries: MemoryEntry[],
  scoreFn: (entry: MemoryEntry) => number
): MemoryEntry[] {
  return entries
    .map((e) => ({ ...e, score: scoreFn(e) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
