/**
 * Memory policy — controls what gets stored, for how long, and how it's retrieved.
 *
 * A MemoryPolicy defines:
 *   - storage: transient vs persistent, TTL, max entries
 *   - retrieval: semantic vs exact vs recency strategy
 *   - update: append vs override behavior
 *   - scope: local (single agent) vs shared (multi-agent)
 *   - privacy: which fields to scrub before storing
 *
 * Usage:
 *   const policy = createMemoryPolicy({
 *     ttl: "7d",
 *     maxEntries: 500,
 *     persistence: "persistent",
 *     retrieval: "semantic",
 *     scope: "user",
 *     update: "append",
 *     privacy: { scrubPii: true },
 *   });
 */

import { parseTtlMs } from "./anchors";

// ── Memory policy types ───────────────────────────────────────────────────────

export type MemoryPersistence = "transient" | "persistent";

export type RetrievalStrategy =
  | "semantic"    // vector similarity search (best for fuzzy recall)
  | "exact"       // exact string match (best for structured facts)
  | "recency"     // most recent entries first (best for conversation history)
  | "hybrid";     // semantic + recency weighted combination

export type MemoryUpdateMode =
  | "append"      // always add new entries (history grows)
  | "override"    // replace existing entries with the same key
  | "merge";      // combine old + new entry content

export type MemoryScope =
  | "agent"   // private to this agent instance
  | "user"    // shared across all agents for a user
  | "thread"  // shared within a conversation thread
  | "global"; // shared across all users (knowledge base)

export interface MemoryPrivacyConfig {
  /** Scrub common PII patterns before storing. Default: false. */
  scrubPii?: boolean;
  /**
   * Custom scrubber function. Receives the raw content and returns sanitized content.
   * Called after built-in PII scrubbing.
   */
  customScrubber?: (content: string) => string;
  /**
   * Metadata fields to drop before storing (e.g. ["email", "phone"]).
   */
  dropMetadataFields?: string[];
  /** If true, never store content containing credit card patterns. */
  blockPaymentData?: boolean;
}

export interface MemoryCompressionConfig {
  /** Enable automatic compression. Default: false. */
  enabled?: boolean;
  /** Compress when the entry count exceeds this. Default: 100. */
  triggerAtEntries?: number;
  /** Target entry count after compression. Default: 50. */
  targetEntries?: number;
  /**
   * Compression function: receives a list of raw memory strings, returns
   * a single compressed summary string. Default: last N entries concatenation.
   */
  compressor?: (entries: string[]) => string | Promise<string>;
}

export interface MemoryPolicyConfig {
  /** How long entries live. Default: "7d". Use "forever" for permanent. */
  ttl?: string;
  /** Maximum entries per key. Oldest are evicted first. Default: 1000. */
  maxEntries?: number;
  /** Whether memory survives process restarts. Default: "persistent". */
  persistence?: MemoryPersistence;
  /** How to retrieve relevant memories. Default: "semantic". */
  retrieval?: RetrievalStrategy;
  /** How many entries to return per retrieval. Default: 5. */
  topK?: number;
  /** How new writes interact with existing entries. Default: "append". */
  update?: MemoryUpdateMode;
  /** Which namespace(s) this policy applies to. Default: "user". */
  scope?: MemoryScope;
  /** Recency weight in hybrid retrieval (0.0–1.0). Default: 0.3. */
  recencyWeight?: number;
  /** Semantic similarity minimum threshold (0.0–1.0). Default: 0.0. */
  minScore?: number;
  /** PII and privacy controls. */
  privacy?: MemoryPrivacyConfig;
  /** Compression settings. */
  compression?: MemoryCompressionConfig;
}

export interface MemoryPolicy {
  readonly config: Required<Omit<MemoryPolicyConfig, "privacy" | "compression">> & {
    privacy: MemoryPrivacyConfig;
    compression: MemoryCompressionConfig;
  };
  readonly ttlMs: number;
  /** Apply privacy scrubbing to content before storage. */
  scrub(content: string, metadata?: Record<string, unknown>): { content: string; metadata: Record<string, unknown> };
}

// ── Built-in PII patterns ─────────────────────────────────────────────────────

const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi, "[EMAIL]"],
  [/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[PHONE]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]"],
  [/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, "[CARD]"],
  [/\b[A-Z]{1,2}\d{6,9}\b/g, "[PASSPORT]"],   // basic passport pattern
];

const PAYMENT_PATTERNS = [/\b(?:\d{4}[-\s]?){3}\d{4}\b/g];

function scrubPii(content: string): string {
  let result = content;
  for (const [pattern, replacement] of PII_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function hasPaymentData(content: string): boolean {
  return PAYMENT_PATTERNS.some((p) => p.test(content));
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createMemoryPolicy(config: MemoryPolicyConfig = {}): MemoryPolicy {
  const resolved = {
    ttl: config.ttl ?? "7d",
    maxEntries: config.maxEntries ?? 1000,
    persistence: config.persistence ?? "persistent",
    retrieval: config.retrieval ?? "semantic",
    topK: config.topK ?? 5,
    update: config.update ?? "append",
    scope: config.scope ?? "user",
    recencyWeight: config.recencyWeight ?? 0.3,
    minScore: config.minScore ?? 0.0,
    privacy: config.privacy ?? {},
    compression: config.compression ?? {},
  };

  const ttlMs = parseTtlMs(resolved.ttl);

  return {
    config: resolved,
    ttlMs,

    scrub(rawContent: string, rawMetadata: Record<string, unknown> = {}): {
      content: string;
      metadata: Record<string, unknown>;
    } {
      const { privacy } = resolved;

      if (privacy.blockPaymentData && hasPaymentData(rawContent)) {
        throw new Error("Memory storage blocked: content contains payment data.");
      }

      let content = rawContent;
      if (privacy.scrubPii) content = scrubPii(content);
      if (privacy.customScrubber) content = privacy.customScrubber(content);

      const metadata = { ...rawMetadata };
      for (const field of (privacy.dropMetadataFields ?? [])) {
        delete metadata[field];
      }

      return { content, metadata };
    },
  };
}

// ── Default policies ─────────────────────────────────────────────────────────

/** Short-lived session memory (24h, transient, recency-based). */
export const SESSION_POLICY = createMemoryPolicy({
  ttl: "24h",
  persistence: "transient",
  retrieval: "recency",
  scope: "thread",
  update: "append",
  maxEntries: 100,
});

/** Long-term user memory (30d, persistent, semantic search, PII scrubbed). */
export const USER_LONG_TERM_POLICY = createMemoryPolicy({
  ttl: "30d",
  persistence: "persistent",
  retrieval: "semantic",
  scope: "user",
  update: "append",
  maxEntries: 500,
  privacy: { scrubPii: true, blockPaymentData: true },
});

/** Global knowledge base (forever, persistent, semantic, read-mostly). */
export const GLOBAL_KNOWLEDGE_POLICY = createMemoryPolicy({
  ttl: "forever",
  persistence: "persistent",
  retrieval: "hybrid",
  scope: "global",
  update: "override",
  maxEntries: 50_000,
  privacy: { scrubPii: true },
});
