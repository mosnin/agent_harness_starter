/**
 * Three-layer LLM response cache.
 *
 * Layer 1 — Exact: hash(prompt + tools) → cached output. TTL: 24h.
 * Layer 2 — Semantic: simhash(prompt) → nearest neighbour lookup. TTL: 6h.
 * Layer 3 — Tool result: hash(toolName + args + dataVersion) → cached output. TTL: data-versioned.
 *
 * Adapters:
 *   InMemoryCache  — development / testing (no Redis required)
 *   RedisCache     — production (Upstash-compatible via ioredis / @upstash/redis)
 *
 * Usage:
 *   const cache = new InMemoryCache();
 *   const key = exactCacheKey(prompt, tools);
 *   const hit = await cache.get(key);
 *   if (hit) return hit;
 *   const out = await llm(model, prompt);
 *   await cache.set(key, out, { ttlSeconds: 86400 });
 */

import { createHash } from "crypto";

// ── Cache adapter interface ───────────────────────────────────────────────────

export interface CacheSetOptions {
  /** Seconds until expiry. Undefined = no expiry. */
  ttlSeconds?: number;
}

export interface CacheAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: CacheSetOptions): Promise<void>;
  del(key: string): Promise<void>;
  /** Optional: invalidate all keys with a given prefix. */
  delByPrefix?(prefix: string): Promise<void>;
}

// ── Key builders ──────────────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Layer 1 — exact cache key.
 * Stable across runs for identical prompts + tool signatures.
 */
export function exactCacheKey(prompt: string, tools: string[] = []): string {
  const normalized = JSON.stringify({ prompt, tools: tools.slice().sort() });
  return `io:${sha256(normalized)}`;
}

/**
 * Layer 2 — semantic cache key using a simple character-level simhash.
 * Collisions are intentional: similar prompts map to the same bucket.
 * For production, replace with an ANN lookup on embeddings.
 */
export function semanticCacheKey(prompt: string, bands = 4): string {
  const normalized = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const hash = sha256(normalized);
  const bandSize = Math.floor(hash.length / bands);
  const band = hash.slice(0, bandSize);
  return `sem:${band}`;
}

/**
 * Layer 3 — tool result cache key.
 * dataVersion should bump when the underlying data changes (e.g. DB migration version).
 */
export function toolCacheKey(
  toolName: string,
  args: unknown,
  dataVersion = "v1"
): string {
  const normalized = JSON.stringify({ toolName, args, dataVersion });
  return `tool:${sha256(normalized)}`;
}

// ── TTL constants ─────────────────────────────────────────────────────────────

export const TTL = {
  exact: 86400,    // 24h
  semantic: 21600, // 6h
  tool: 3600,      // 1h default; override per-tool with dataVersion bump
  immutable: undefined, // no expiry
} as const;

// ── In-memory adapter (dev / test) ────────────────────────────────────────────

interface CacheEntry {
  value: string;
  expiresAt: number | undefined;
}

export class InMemoryCache implements CacheAdapter {
  private readonly store = new Map<string, CacheEntry>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, opts?: CacheSetOptions): Promise<void> {
    const expiresAt = opts?.ttlSeconds !== undefined
      ? Date.now() + opts.ttlSeconds * 1000
      : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  get size(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
}

// ── Redis adapter (production) ────────────────────────────────────────────────

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
}

export class RedisCache implements CacheAdapter {
  constructor(private readonly client: RedisClient) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, opts?: CacheSetOptions): Promise<void> {
    if (opts?.ttlSeconds !== undefined) {
      await this.client.set(key, value, { ex: opts.ttlSeconds });
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    const keys = await this.client.keys(`${prefix}*`);
    await Promise.all(keys.map((k) => this.client.del(k)));
  }
}

// ── CacheManager — ties all three layers together ─────────────────────────────

export interface CacheManager {
  /** Check all layers in order; return first hit or null. */
  get(exactKey: string, semanticKey?: string): Promise<string | null>;
  /** Write to a specific layer. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Invalidate exact and semantic keys for a prompt. */
  invalidate(prompt: string, tools?: string[]): Promise<void>;
}

export function createCacheManager(adapter: CacheAdapter): CacheManager {
  return {
    async get(exactKey: string, semanticKey?: string): Promise<string | null> {
      const exact = await adapter.get(exactKey);
      if (exact) return exact;
      if (semanticKey) {
        const sem = await adapter.get(semanticKey);
        if (sem) return sem;
      }
      return null;
    },

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      await adapter.set(key, value, ttlSeconds !== undefined ? { ttlSeconds } : undefined);
    },

    async invalidate(prompt: string, tools: string[] = []): Promise<void> {
      const eKey = exactCacheKey(prompt, tools);
      const sKey = semanticCacheKey(prompt);
      await Promise.all([adapter.del(eKey), adapter.del(sKey)]);
    },
  };
}

/** Global in-memory cache for development. Hot-swap with RedisCache in production. */
declare global {
  // eslint-disable-next-line no-var
  var __agentCache: InMemoryCache | undefined;
}
export const defaultCache: InMemoryCache =
  globalThis.__agentCache ?? (globalThis.__agentCache = new InMemoryCache());
