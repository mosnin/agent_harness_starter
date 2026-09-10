/**
 * LLM response cache — skip model calls for identical inputs.
 *
 * A TTL-keyed LRU cache that sits in front of agent.run() or agent.stream().
 * When the same message is sent twice within the TTL window, the cached
 * response is returned without calling the model.
 *
 * Useful for: dev/test (avoid burning tokens), deterministic demos,
 * high-traffic apps with repeated queries (FAQ bots, etc.).
 *
 * @example
 *   import { createResponseCache } from "hades-agent/cache";
 *
 *   const cache = createResponseCache({ maxSize: 500, ttlMs: 60_000 });
 *
 *   // Wrap any harness:
 *   const agent = createAgent({ name: "FAQ", instructions: "..." });
 *   const cachedAgent = cache.wrap(agent);
 *
 *   // Or use as a plugin:
 *   const agent = createCustomHarness({
 *     plugins: [cache.plugin()],
 *   });
 */

import type { AgentHarness } from "../core";
import type { AgentEvent, RunInput, HarnessPlugin, PluginRunContext } from "../types";

export interface ResponseCacheOptions {
  /** Maximum number of entries. When full, oldest entries are evicted. Default: 1000. */
  maxSize?: number;
  /** Time-to-live in milliseconds. Default: 3600000 (1 hour). */
  ttlMs?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  maxSize: number;
  hitRate: number;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
  accessedAt: number;
}

// ── djb2 hash ────────────────────────────────────────────────────────────────

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep as uint32
  }
  return hash.toString(36);
}

function cacheKey(input: RunInput): string {
  return djb2(JSON.stringify(input.messages));
}

// ── Fake harness returned on cache hit ───────────────────────────────────────

function makeCachedHarness(finalOutput: string): AgentHarness {
  return {
    async *stream(_input: RunInput): AsyncGenerator<AgentEvent> {
      yield { type: "message_delta", delta: finalOutput };
      yield { type: "done", finalOutput };
    },
    async run(_input: RunInput) {
      return {
        finalOutput,
        messages: [{ role: "assistant", content: finalOutput }],
        toolCalls: [],
      };
    },
  };
}

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ResponseCache {
  /**
   * Wrap an AgentHarness with caching.
   * The cache key is derived from the messages content.
   */
  wrap(harness: AgentHarness): AgentHarness;
  /**
   * HarnessPlugin version — intercepts onBeforeRun to check cache,
   * and onComplete to populate cache.
   */
  plugin(): HarnessPlugin;
  /** Get current cache statistics */
  stats(): CacheStats;
  /** Clear all cached entries */
  clear(): void;
  /** Manually invalidate a specific cache key */
  invalidate(key: string): void;
}

// ── Implementation ────────────────────────────────────────────────────────────

export function createResponseCache(options: ResponseCacheOptions = {}): ResponseCache {
  const maxSize = options.maxSize ?? 1000;
  const ttlMs = options.ttlMs ?? 3_600_000;

  // Map insertion order = LRU: delete + re-insert on access
  const store = new Map<string, CacheEntry>();
  let hits = 0;
  let misses = 0;

  function evictExpired(): void {
    const now = Date.now();
    for (const [k, entry] of store) {
      if (entry.expiresAt < now) {
        store.delete(k);
      }
    }
  }

  function get(key: string): string | undefined {
    const entry = store.get(key);
    if (!entry) {
      misses++;
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
      store.delete(key);
      misses++;
      return undefined;
    }
    // LRU: move to end
    store.delete(key);
    entry.accessedAt = Date.now();
    store.set(key, entry);
    hits++;
    return entry.value;
  }

  function set(key: string, value: string): void {
    evictExpired();
    if (store.has(key)) {
      store.delete(key);
    } else if (store.size >= maxSize) {
      // Evict the least-recently-used (first inserted/accessed) entry
      const oldest = store.keys().next().value;
      if (oldest !== undefined) {
        store.delete(oldest);
      }
    }
    store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      accessedAt: Date.now(),
    });
  }

  // ── wrap() ──────────────────────────────────────────────────────────────────

  function wrap(harness: AgentHarness): AgentHarness {
    return {
      async *stream(input: RunInput): AsyncGenerator<AgentEvent> {
        const key = cacheKey(input);
        const cached = get(key);
        if (cached !== undefined) {
          yield* makeCachedHarness(cached).stream(input);
          return;
        }

        let finalOutput = "";
        for await (const event of harness.stream(input)) {
          yield event;
          if (event.type === "done") {
            finalOutput = event.finalOutput;
          }
        }
        if (finalOutput) {
          set(key, finalOutput);
        }
      },

      async run(input: RunInput) {
        const key = cacheKey(input);
        const cached = get(key);
        if (cached !== undefined) {
          return makeCachedHarness(cached).run(input);
        }
        const result = await harness.run(input);
        if (result.finalOutput) {
          set(key, result.finalOutput);
        }
        return result;
      },
    };
  }

  // ── plugin() ─────────────────────────────────────────────────────────────────

  // Plugin approach: we stash the pending key in a per-run WeakMap surrogate
  // (a plain Map keyed by runId) so onComplete can populate the cache.
  const pendingKeys = new Map<string, string>();

  function plugin(): HarnessPlugin {
    return {
      name: "response-cache",

      onBeforeRun(
        userMessage: string,
        ctx: PluginRunContext,
        input: RunInput
      ): string {
        const key = cacheKey(input);
        const cached = get(key);
        if (cached !== undefined) {
          // Signal a hit by storing a sentinel; actual short-circuit would
          // require framework support — store the cached value for onAfterRun.
          pendingKeys.set(ctx.runId + ":hit", cached);
        } else {
          pendingKeys.set(ctx.runId + ":key", key);
        }
        return userMessage;
      },

      onAfterRun(finalOutput: string, ctx: PluginRunContext): string {
        const hitValue = pendingKeys.get(ctx.runId + ":hit");
        if (hitValue !== undefined) {
          pendingKeys.delete(ctx.runId + ":hit");
          return hitValue;
        }
        return finalOutput;
      },

      onComplete(
        ctx: PluginRunContext,
        result: { finalOutput: string; durationMs: number; error?: Error }
      ): void {
        const key = pendingKeys.get(ctx.runId + ":key");
        if (key && result.finalOutput && !result.error) {
          set(key, result.finalOutput);
        }
        pendingKeys.delete(ctx.runId + ":key");
        pendingKeys.delete(ctx.runId + ":hit");
      },
    };
  }

  // ── public surface ──────────────────────────────────────────────────────────

  return {
    wrap,
    plugin,
    stats(): CacheStats {
      const total = hits + misses;
      return {
        hits,
        misses,
        size: store.size,
        maxSize,
        hitRate: total === 0 ? 0 : hits / total,
      };
    },
    clear(): void {
      store.clear();
    },
    invalidate(key: string): void {
      store.delete(key);
    },
  };
}
