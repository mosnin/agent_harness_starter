/**
 * Memory anchors — explicitly pinned key-value facts with TTL and eviction.
 *
 * Unlike semantic memory (vector search, fuzzy recall), anchors are hard facts
 * that must be recalled verbatim. They live in a fast in-process store and are
 * injected directly into the prompt by withStructuredReasoning (or manually).
 *
 * Usage:
 *   const store = new AnchorStore();
 *   store.set("tz", "UTC+9", { ttl: "1h", useFor: "scheduling" });
 *   store.format("userId123") // → formatted block for system prompt
 */

export interface AnchorOptions {
  /** Duration: "30s", "5m", "2h", "7d", "forever". Default: "1h". */
  ttl?: string;
  /** When this anchor should be recalled. */
  useFor?: string;
  /** Eviction strategy when TTL expires. Default: "expire". */
  evictionPolicy?: "lru" | "expire" | "manual";
}

export interface AnchorEntry {
  key: string;
  fact: string;
  useFor: string;
  evictionPolicy: "lru" | "expire" | "manual";
  /** Absolute expiry timestamp (ms). Infinity for "forever". */
  expiresAt: number;
  /** Last-accessed timestamp for LRU tracking. */
  lastAccessedAt: number;
}

// ── TTL parsing ───────────────────────────────────────────────────────────────

const TTL_RE = /^(\d+)(s|m|h|d)$|^forever$/i;

export function parseTtlMs(ttl: string): number {
  const lower = ttl.toLowerCase();
  if (lower === "forever") return Infinity;
  const m = TTL_RE.exec(lower);
  if (!m) throw new Error(`Invalid TTL format: "${ttl}". Use: 30s, 5m, 2h, 7d, or forever.`);
  const value = parseInt(m[1], 10);
  switch (m[2]) {
    case "s": return value * 1_000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return Infinity;
  }
}

// ── AnchorStore ───────────────────────────────────────────────────────────────

export class AnchorStore {
  private readonly stores = new Map<string, Map<string, AnchorEntry>>();

  private getStore(namespace: string): Map<string, AnchorEntry> {
    let ns = this.stores.get(namespace);
    if (!ns) {
      ns = new Map();
      this.stores.set(namespace, ns);
    }
    return ns;
  }

  /**
   * Pin a fact under a namespace (e.g. userId) and a key.
   * Overwrites any existing anchor with the same key.
   */
  set(namespace: string, key: string, fact: string, opts: AnchorOptions = {}): void {
    const ttlMs = parseTtlMs(opts.ttl ?? "1h");
    const entry: AnchorEntry = {
      key,
      fact,
      useFor: opts.useFor ?? "",
      evictionPolicy: opts.evictionPolicy ?? "expire",
      expiresAt: ttlMs === Infinity ? Infinity : Date.now() + ttlMs,
      lastAccessedAt: Date.now(),
    };
    this.getStore(namespace).set(key, entry);
  }

  /** Retrieve a single anchor, updating lastAccessedAt. Returns undefined if expired or missing. */
  get(namespace: string, key: string): AnchorEntry | undefined {
    const entry = this.getStore(namespace).get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      if (entry.evictionPolicy !== "manual") this.getStore(namespace).delete(key);
      return undefined;
    }
    entry.lastAccessedAt = Date.now();
    return entry;
  }

  /** Delete a specific anchor. */
  delete(namespace: string, key: string): void {
    this.getStore(namespace).delete(key);
  }

  /** Return all live anchors for a namespace, evicting expired ones. */
  getAll(namespace: string): AnchorEntry[] {
    const ns = this.getStore(namespace);
    const live: AnchorEntry[] = [];
    for (const [key, entry] of ns) {
      if (this.isExpired(entry)) {
        if (entry.evictionPolicy !== "manual") ns.delete(key);
      } else {
        entry.lastAccessedAt = Date.now();
        live.push(entry);
      }
    }
    return live;
  }

  /** Evict LRU entries if the namespace exceeds maxSize. */
  evictLru(namespace: string, maxSize: number): void {
    const ns = this.getStore(namespace);
    if (ns.size <= maxSize) return;
    const sorted = [...ns.values()]
      .filter((e) => e.evictionPolicy === "lru")
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    let toEvict = ns.size - maxSize;
    for (const entry of sorted) {
      if (toEvict <= 0) break;
      ns.delete(entry.key);
      toEvict--;
    }
  }

  /** Clear all anchors for a namespace. */
  clearNamespace(namespace: string): void {
    this.stores.delete(namespace);
  }

  /**
   * Format live anchors for injection into a system prompt.
   * Returns empty string if no anchors exist.
   */
  format(namespace: string): string {
    const entries = this.getAll(namespace);
    if (entries.length === 0) return "";
    const lines = entries.map((e, i) => {
      const expiry = e.expiresAt === Infinity
        ? "never"
        : `expires ${new Date(e.expiresAt).toISOString()}`;
      const useFor = e.useFor ? ` [use for: ${e.useFor}]` : "";
      return `  [anchor_${i + 1}] ${e.key}: "${e.fact}"${useFor} (${expiry})`;
    });
    return `Pinned facts (recall verbatim):\n${lines.join("\n")}`;
  }

  private isExpired(entry: AnchorEntry): boolean {
    return entry.expiresAt !== Infinity && Date.now() > entry.expiresAt;
  }
}

/** Global singleton AnchorStore — survives Next.js hot-reloads via globalThis. */
declare global {
  // eslint-disable-next-line no-var
  var __agentAnchors: AnchorStore | undefined;
}
export const anchors: AnchorStore =
  globalThis.__agentAnchors ?? (globalThis.__agentAnchors = new AnchorStore());
