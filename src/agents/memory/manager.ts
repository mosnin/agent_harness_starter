/**
 * MemoryManager — high-level API that ties together:
 *   - MemoryPolicy (TTL, scope, privacy, compression config)
 *   - Retriever (semantic / exact / recency / hybrid)
 *   - Compressor (optional entry count reduction)
 *   - MemoryAdapter (storage backend)
 *
 * Usage:
 *   import { createMemoryManager } from "@/agents/memory/manager";
 *   import { USER_LONG_TERM_POLICY } from "@/agents/memory/policy";
 *   import { memory } from "@/agents/memory";
 *
 *   const manager = createMemoryManager({ adapter: memory, policy: USER_LONG_TERM_POLICY });
 *
 *   // Store (policy enforces privacy scrubbing + TTL metadata)
 *   await manager.store("user:123", "User prefers concise answers.");
 *
 *   // Retrieve (policy-matched strategy, topK, minScore)
 *   const entries = await manager.retrieve("user:123", "What are the user's preferences?");
 *
 *   // Conditionally compress (if count > policy.compression.triggerAtEntries)
 *   await manager.compress("user:123");
 *
 *   // Evict expired entries
 *   await manager.evictExpired("user:123");
 */

import type { MemoryAdapter, MemoryEntry } from "./types";
import type { MemoryPolicy } from "./policy";
import { createRetriever, type Retriever } from "./retrieval";
import { createCompressor, type MemoryCompressor } from "./compression";

// ── MemoryManager interface ───────────────────────────────────────────────────

export interface MemoryManager {
  /**
   * Store content under the given scope key.
   * Policy scrubbing and TTL metadata are applied automatically.
   * In "override" mode, existing entries with matching metadata.overrideKey
   * are deleted before storing the new entry.
   */
  store(
    key: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<MemoryEntry>;

  /**
   * Retrieve relevant entries using the policy's retrieval strategy.
   */
  retrieve(key: string, query: string): Promise<MemoryEntry[]>;

  /**
   * Delete all memory for a given key (GDPR / user deletion).
   */
  deleteAll(key: string): Promise<void>;

  /**
   * List all entries for a key, most recent first.
   */
  list(key: string, limit?: number): Promise<MemoryEntry[]>;

  /**
   * Remove entries that have exceeded their TTL.
   * Requires entries to have been stored with expiresAt metadata.
   */
  evictExpired(key: string): Promise<number>;

  /**
   * If compression is enabled and entry count exceeds the threshold,
   * compress older entries. Returns the new entry list.
   */
  compress(key: string): Promise<MemoryEntry[]>;

  /** The underlying adapter — use for direct access when needed. */
  readonly adapter: MemoryAdapter;
  /** The policy driving this manager. */
  readonly policy: MemoryPolicy;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface MemoryManagerConfig {
  adapter: MemoryAdapter;
  policy: MemoryPolicy;
}

export function createMemoryManager(config: MemoryManagerConfig): MemoryManager {
  const { adapter, policy } = config;
  const retriever: Retriever = createRetriever(adapter, policy);
  const compressor: MemoryCompressor = createCompressor(policy);

  async function store(
    key: string,
    rawContent: string,
    rawMetadata: Record<string, unknown> = {}
  ): Promise<MemoryEntry> {
    const { content, metadata } = policy.scrub(rawContent, rawMetadata);

    // Compute expiry from TTL
    const expiresAt =
      policy.ttlMs === Infinity
        ? undefined
        : new Date(Date.now() + policy.ttlMs).toISOString();

    const finalMeta: Record<string, unknown> = { ...metadata };
    if (expiresAt) finalMeta.expiresAt = expiresAt;

    // "override" mode: delete existing entry matching overrideKey before writing
    if (policy.config.update === "override" && rawMetadata.overrideKey) {
      const existing = await adapter.list(key, policy.config.maxEntries);
      for (const e of existing) {
        if (e.metadata?.overrideKey === rawMetadata.overrideKey) {
          // Adapters don't expose per-entry delete; we rebuild the store
          // by keeping all non-matching entries and re-inserting them.
          // This is an intentional trade-off: production adapters should
          // add a deleteById() method and override this behaviour.
          const toKeep = existing.filter(
            (x) => x.metadata?.overrideKey !== rawMetadata.overrideKey
          );
          await adapter.deleteAll(key);
          for (const kept of toKeep) {
            await adapter.store(key, kept.content, kept.metadata);
          }
          break;
        }
      }
    }

    const entry = await adapter.store(key, content, finalMeta);

    // Enforce maxEntries: evict oldest if over limit
    const all = await adapter.list(key, policy.config.maxEntries + 1);
    if (all.length > policy.config.maxEntries) {
      // Re-store only the most recent maxEntries (adapter.list returns newest-first)
      const toKeep = all.slice(0, policy.config.maxEntries);
      await adapter.deleteAll(key);
      for (const kept of [...toKeep].reverse()) {
        await adapter.store(key, kept.content, kept.metadata);
      }
    }

    return entry;
  }

  async function retrieve(key: string, query: string): Promise<MemoryEntry[]> {
    return retriever.retrieve(key, query);
  }

  async function deleteAll(key: string): Promise<void> {
    return adapter.deleteAll(key);
  }

  async function list(key: string, limit?: number): Promise<MemoryEntry[]> {
    return adapter.list(key, limit ?? policy.config.topK);
  }

  async function evictExpired(key: string): Promise<number> {
    if (policy.ttlMs === Infinity) return 0;
    const all = await adapter.list(key, policy.config.maxEntries);
    const now = Date.now();
    const toKeep = all.filter((e) => {
      const exp = e.metadata?.expiresAt as string | undefined;
      if (!exp) return true;
      return new Date(exp).getTime() > now;
    });
    const evicted = all.length - toKeep.length;
    if (evicted > 0) {
      await adapter.deleteAll(key);
      for (const kept of [...toKeep].reverse()) {
        await adapter.store(key, kept.content, kept.metadata);
      }
    }
    return evicted;
  }

  async function compress(key: string): Promise<MemoryEntry[]> {
    const entries = await adapter.list(key, policy.config.maxEntries);
    return compressor.maybeCompress(key, entries, adapter);
  }

  return { store, retrieve, deleteAll, list, evictExpired, compress, adapter, policy };
}

// ── Scoped manager helpers ────────────────────────────────────────────────────

/**
 * Derive a policy-appropriate scope key from agent/user/thread context.
 *
 * Examples:
 *   scopeKey("agent", { agentId: "planner" })   → "agent:planner"
 *   scopeKey("user",  { userId: "u_123" })       → "user:u_123"
 *   scopeKey("thread",{ threadId: "t_abc" })     → "thread:t_abc"
 *   scopeKey("global",{})                        → "global"
 */
export function scopeKey(
  scope: "agent" | "user" | "thread" | "global",
  ids: { agentId?: string; userId?: string; threadId?: string }
): string {
  switch (scope) {
    case "agent":  return `agent:${ids.agentId ?? "default"}`;
    case "user":   return `user:${ids.userId ?? "anonymous"}`;
    case "thread": return `thread:${ids.threadId ?? "default"}`;
    case "global": return "global";
  }
}
