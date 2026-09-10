/**
 * Single-use nonce replay defense and per-token use counting for the Hades
 * governance capability stack (`./capability.ts`).
 *
 * `MemoryReplayGuard` is the process-local implementation used in tests and
 * short-lived processes. `DurableReplayGuard` persists to a single JSON file
 * with atomic tmp-then-rename writes (mirroring the exact durability
 * discipline `../gateway/trust-store.ts` and `./keystore.ts` use elsewhere
 * in this codebase), TTL-based eviction, and a bounded size with
 * oldest-first eviction — so a captured, replayed token is rejected even
 * after the enforcing process restarts and reloads this file from disk.
 *
 * No network I/O. No ambient `Date.now()` in any pure path — every
 * timestamp is caller-provided (`consume(nonce, at)`, `increment(id, at)`)
 * or the injectable `now` option `DurableReplayGuard.open` accepts for its
 * own bookkeeping (e.g. picking a default `at` is never done here; callers
 * always pass one explicitly).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Locked interfaces
// ---------------------------------------------------------------------------

export interface ReplayGuard {
  /** Atomically mark `nonce` as used at time `at`. Returns `true` if this was the first use, `false` if it was already consumed (and still unexpired). */
  consume(nonce: string, at: number): boolean;
  /** Read-only: has `nonce` already been consumed (and not yet TTL-expired)? Never mutates. */
  seen(nonce: string): boolean;
}

export interface UseCounter {
  /** Record one more use of `tokenId` at time `at`; returns the new total count. */
  increment(tokenId: string, at: number): number;
  /** Read-only: current use count for `tokenId` (0 if never used). */
  count(tokenId: string): number;
}

// ---------------------------------------------------------------------------
// MemoryReplayGuard — process-local, no persistence
// ---------------------------------------------------------------------------

interface NonceEntry {
  at: number;
}

interface UseEntry {
  count: number;
  lastAt: number;
}

export class MemoryReplayGuard implements ReplayGuard, UseCounter {
  protected nonces = new Map<string, NonceEntry>();
  protected uses = new Map<string, UseEntry>();

  consume(nonce: string, at: number): boolean {
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, { at });
    return true;
  }

  seen(nonce: string): boolean {
    return this.nonces.has(nonce);
  }

  increment(tokenId: string, at: number): number {
    const existing = this.uses.get(tokenId);
    const count = (existing?.count ?? 0) + 1;
    this.uses.set(tokenId, { count, lastAt: at });
    return count;
  }

  count(tokenId: string): number {
    return this.uses.get(tokenId)?.count ?? 0;
  }

  /** Remove entries older than `ttlMs` relative to `at` from both maps; returns the number removed. Exposed for `DurableReplayGuard` to share and for tests to exercise directly. */
  pruneOlderThan(at: number, ttlMs: number): number {
    let removed = 0;
    for (const [nonce, entry] of this.nonces) {
      if (at - entry.at >= ttlMs) {
        this.nonces.delete(nonce);
        removed++;
      }
    }
    for (const [tokenId, entry] of this.uses) {
      if (at - entry.lastAt >= ttlMs) {
        this.uses.delete(tokenId);
        removed++;
      }
    }
    return removed;
  }

  /** Evict the oldest entries (by recorded timestamp) across both maps until each is at or under `maxEntries`. Returns the number removed. */
  evictOldestBeyond(maxEntries: number): number {
    let removed = 0;
    while (this.nonces.size > maxEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [nonce, entry] of this.nonces) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = nonce;
        }
      }
      if (oldestKey === undefined) break;
      this.nonces.delete(oldestKey);
      removed++;
    }
    while (this.uses.size > maxEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [tokenId, entry] of this.uses) {
        if (entry.lastAt < oldestAt) {
          oldestAt = entry.lastAt;
          oldestKey = tokenId;
        }
      }
      if (oldestKey === undefined) break;
      this.uses.delete(oldestKey);
      removed++;
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// DurableReplayGuard — file-backed, atomic writes, TTL + size bounded
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_ENTRIES = 100_000;
const SCHEMA = "hades.gov.replay.v1" as const;

interface PersistedShape {
  schema: typeof SCHEMA;
  nonces: Array<{ nonce: string; at: number }>;
  uses: Array<{ tokenId: string; count: number; lastAt: number }>;
}

function isPersistedShape(v: unknown): v is PersistedShape {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.schema !== SCHEMA) return false;
  if (!Array.isArray(o.nonces) || !Array.isArray(o.uses)) return false;
  const noncesOk = o.nonces.every(
    (e) => e !== null && typeof e === "object" && typeof (e as { nonce?: unknown }).nonce === "string" && typeof (e as { at?: unknown }).at === "number",
  );
  const usesOk = o.uses.every(
    (e) =>
      e !== null &&
      typeof e === "object" &&
      typeof (e as { tokenId?: unknown }).tokenId === "string" &&
      typeof (e as { count?: unknown }).count === "number" &&
      typeof (e as { lastAt?: unknown }).lastAt === "number",
  );
  return noncesOk && usesOk;
}

export interface DurableReplayGuardOptions {
  file: string;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * File-backed `ReplayGuard` + `UseCounter`. Loads synchronously at
 * `open()` — a missing or corrupted file yields a fresh, empty store, never
 * a throw, since a durable nonce store's whole job is to survive restarts
 * gracefully, not to become a new single point of failure. Every mutating
 * call (`consume`, `increment`, and eviction inside them) persists
 * synchronously via write-tmp-then-rename, so a crash mid-write always
 * leaves either the previous complete file or the new complete one.
 */
export class DurableReplayGuard extends MemoryReplayGuard {
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private closed = false;

  private constructor(file: string, ttlMs: number, maxEntries: number) {
    super();
    this.file = file;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  static open(opts: DurableReplayGuardOptions): DurableReplayGuard {
    if (!opts || typeof opts.file !== "string" || opts.file.length === 0) {
      throw new RangeError("DurableReplayGuard.open: opts.file must be a non-empty path");
    }
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    if (!(ttlMs > 0)) throw new RangeError(`DurableReplayGuard.open: ttlMs must be > 0, got ${ttlMs}`);
    const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!(maxEntries > 0)) throw new RangeError(`DurableReplayGuard.open: maxEntries must be > 0, got ${maxEntries}`);

    const guard = new DurableReplayGuard(opts.file, ttlMs, maxEntries);
    guard.load();
    return guard;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`DurableReplayGuard: used after close() ("${this.file}")`);
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return; // unreadable → fresh, empty store
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt JSON → fresh, empty store
    }
    if (!isPersistedShape(parsed)) return;
    for (const e of parsed.nonces) this.nonces.set(e.nonce, { at: e.at });
    for (const e of parsed.uses) this.uses.set(e.tokenId, { count: e.count, lastAt: e.lastAt });
  }

  private persist(): void {
    const payload: PersistedShape = {
      schema: SCHEMA,
      nonces: [...this.nonces].map(([nonce, entry]) => ({ nonce, at: entry.at })),
      uses: [...this.uses].map(([tokenId, entry]) => ({ tokenId, count: entry.count, lastAt: entry.lastAt })),
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      /* already exists */
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, this.file);
  }

  override consume(nonce: string, at: number): boolean {
    this.assertOpen();
    this.pruneOlderThan(at, this.ttlMs);
    const ok = super.consume(nonce, at);
    if (ok) {
      this.evictOldestBeyond(this.maxEntries);
      this.persist();
    }
    return ok;
  }

  override seen(nonce: string): boolean {
    this.assertOpen();
    const entry = this.nonces.get(nonce);
    if (!entry) return false;
    return true;
  }

  override increment(tokenId: string, at: number): number {
    this.assertOpen();
    this.pruneOlderThan(at, this.ttlMs);
    const count = super.increment(tokenId, at);
    this.evictOldestBeyond(this.maxEntries);
    this.persist();
    return count;
  }

  override count(tokenId: string): number {
    this.assertOpen();
    return super.count(tokenId);
  }

  /** Force a synchronous write of the current in-memory state to disk. */
  flush(): void {
    this.assertOpen();
    this.persist();
  }

  /** Evict every nonce/use entry older than the configured TTL relative to `at`. Persists if anything was removed. Returns the number removed. */
  prune(at: number): number {
    this.assertOpen();
    const removed = this.pruneOlderThan(at, this.ttlMs);
    if (removed > 0) this.persist();
    return removed;
  }

  /** Mark this guard closed; any further use throws rather than silently reopening the file. */
  close(): void {
    this.closed = true;
  }
}
