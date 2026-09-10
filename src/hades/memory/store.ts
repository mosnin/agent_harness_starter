import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A durable fact Hades remembers about the user or the world. Salience biases
 * retrieval so the important things surface first; access stats let rarely-used
 * memories decay. This is the substrate of the closed learning loop — what makes
 * Hades personal across sessions rather than starting cold each time.
 */
export interface MemoryRecord {
  id: string;
  /** The remembered statement, in natural language. */
  fact: string;
  /** Importance 0..1 — higher surfaces earlier in retrieval. */
  salience: number;
  tags: string[];
  /** Where it came from (session id, "user", a goal id, …). */
  source?: string;
  createdAt: number;
  lastAccessedAt?: number;
  accessCount: number;
}

export interface MemorySearchResult extends MemoryRecord {
  score: number;
}

export interface MemoryStore {
  add(input: { fact: string; salience?: number; tags?: string[]; source?: string }): MemoryRecord;
  get(id: string): MemoryRecord | undefined;
  all(): MemoryRecord[];
  search(query: string, opts?: { limit?: number; tag?: string; now?: number }): MemorySearchResult[];
  forget(id: string): boolean;
  size(): number;
}

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // recency decays with a ~2-week half-life

/**
 * Pure relevance score for a memory against a query. Combines lexical overlap
 * with the query, the memory's salience, and a recency decay — so retrieval
 * favours facts that are relevant, important, and fresh. Exported for testing.
 */
export function scoreMemory(record: MemoryRecord, queryTokens: string[], now: number): number {
  const hay = `${record.fact} ${record.tags.join(" ")}`.toLowerCase();
  const distinct = queryTokens.filter((t) => t.length >= 2);
  const hits = distinct.length ? distinct.filter((t) => hay.includes(t)).length / distinct.length : 0;
  const ageMs = now - (record.lastAccessedAt ?? record.createdAt);
  const recency = Math.pow(0.5, ageMs / HALF_LIFE_MS); // 1 → fresh, →0 as it ages
  // Lexical overlap dominates; salience and recency modulate.
  return hits * 0.6 + record.salience * 0.3 + recency * 0.1;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** In-memory store — deterministic, dependency-free, ideal for tests. */
export class InMemoryMemoryStore implements MemoryStore {
  protected records = new Map<string, MemoryRecord>();

  add(input: { fact: string; salience?: number; tags?: string[]; source?: string }): MemoryRecord {
    const rec: MemoryRecord = {
      id: randomUUID(),
      fact: input.fact,
      salience: clamp01(input.salience ?? 0.5),
      tags: input.tags ?? [],
      source: input.source,
      createdAt: this.now(),
      accessCount: 0,
    };
    this.records.set(rec.id, rec);
    this.persist();
    return rec;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  all(): MemoryRecord[] {
    return [...this.records.values()];
  }

  search(query: string, opts: { limit?: number; tag?: string; now?: number } = {}): MemorySearchResult[] {
    const now = opts.now ?? this.now();
    const tokens = tokenize(query);
    let pool = this.all();
    if (opts.tag) pool = pool.filter((r) => r.tags.includes(opts.tag!));
    const scored = pool
      .map((r) => ({ ...r, score: scoreMemory(r, tokens, now) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 10);
    // Retrieval counts as access (feeds recency + decay).
    for (const r of scored) {
      const live = this.records.get(r.id);
      if (live) {
        live.lastAccessedAt = now;
        live.accessCount += 1;
      }
    }
    if (scored.length) this.persist();
    return scored;
  }

  forget(id: string): boolean {
    const ok = this.records.delete(id);
    if (ok) this.persist();
    return ok;
  }

  size(): number {
    return this.records.size;
  }

  /** Overridable clock (tests inject determinism via a subclass if needed). */
  protected now(): number {
    return Date.now();
  }
  /** No-op here; FileMemoryStore overrides to write through. */
  protected persist(): void {}
}

/** Persists memories to a JSON file with atomic writes (temp + rename). */
export class FileMemoryStore extends InMemoryMemoryStore {
  constructor(private readonly path: string) {
    super();
    try {
      const raw = readFileSync(path, "utf8");
      const arr = JSON.parse(raw) as MemoryRecord[];
      for (const r of arr) this.records.set(r.id, r);
    } catch {
      /* fresh store */
    }
  }

  protected override persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* dir exists */
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all()));
    renameSync(tmp, this.path);
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
