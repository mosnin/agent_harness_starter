/**
 * Process-local Jev ask cache + in-flight coalescing.
 *
 * TypeSafe evaluates every question in one request in parallel. The remaining
 * waste is asking the same state twice (desktop prefetch → send, retries,
 * identical tool args). Cache only successful answers. Failures stay live so
 * fail-closed security never serves a stale pass.
 */

import type { JevAsker, JevAskResult, SystemOneRequest, SystemOneResult } from "./types";

const DEFAULT_TTL_MS = Number(process.env.JEV_CACHE_TTL_MS ?? 20_000);
const DEFAULT_MAX = Number(process.env.JEV_CACHE_MAX ?? 64);

interface CacheEntry {
  result: SystemOneResult;
  expires: number;
}

class JevAskCache {
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<JevAskResult>>();

  constructor(ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
    this.max = Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  size(): number {
    return this.entries.size;
  }

  async ask(inner: JevAsker, request: SystemOneRequest, signal?: AbortSignal): Promise<JevAskResult> {
    const key = hashAsk(request);
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return { ok: true, result: hit.result, cached: true, latencyMs: 0 };
    }
    if (hit) this.entries.delete(key);

    const pending = this.inflight.get(key);
    if (pending) {
      const shared = await pending;
      return shared.ok ? { ...shared, cached: true } : shared;
    }

    const started = Date.now();
    const work = inner.ask(request, signal).then((asked) => {
      if (asked.ok) {
        this.set(key, asked.result);
        return { ...asked, cached: false, latencyMs: Date.now() - started };
      }
      return asked;
    });
    this.inflight.set(key, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(key);
    }
  }

  private set(key: string, result: SystemOneResult): void {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { result, expires: Date.now() + this.ttlMs });
  }
}

const globalCache = new JevAskCache();

export function resetJevAskCache(): void {
  globalCache.clear();
}

export function jevAskCacheSize(): number {
  return globalCache.size();
}

export function wrapAskerWithCache(asker: JevAsker): JevAsker {
  return {
    ask(request, signal) {
      return globalCache.ask(asker, request, signal);
    },
  };
}

export function hashAsk(request: SystemOneRequest): string {
  return `${request.model ?? "jev-latest"}:${stableStringify({
    state: request.state,
    questions: request.questions,
  })}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`)
    .join(",")}}`;
}
