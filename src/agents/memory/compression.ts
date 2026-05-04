/**
 * Memory compression — reduces the number of stored entries when the count
 * exceeds a threshold by summarizing older entries into a single compressed entry.
 *
 * The default compressor concatenates entries oldest-first, separated by newlines.
 * You can swap in an LLM-based compressor via MemoryCompressionConfig.compressor.
 *
 * Usage:
 *   import { createCompressor } from "@/agents/memory/compression";
 *
 *   const compressor = createCompressor(policy);
 *   const entries    = await compressor.maybeCompress(key, entries, adapter);
 */

import type { MemoryAdapter, MemoryEntry } from "./types";
import type { MemoryPolicy } from "./policy";

// ── Compressor interface ──────────────────────────────────────────────────────

export interface MemoryCompressor {
  /**
   * If the entry count exceeds the policy threshold, compress older entries
   * into a single summary and persist it. Returns the updated entry list
   * (recent entries + the new summary if compression occurred).
   */
  maybeCompress(key: string, entries: MemoryEntry[], adapter: MemoryAdapter): Promise<MemoryEntry[]>;
}

// ── Default concatenation compressor ─────────────────────────────────────────

/**
 * Concatenates old entries into one summary string.
 * Pass policy.config.compression.compressor to use an LLM-based summary instead.
 */
async function defaultCompressorFn(entries: string[]): Promise<string> {
  return `[Compressed memory — ${entries.length} entries]\n` + entries.join("\n");
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createCompressor(policy: MemoryPolicy): MemoryCompressor {
  const cfg = policy.config.compression;

  return {
    async maybeCompress(key, entries, adapter) {
      if (!cfg.enabled) return entries;

      const triggerAt = cfg.triggerAtEntries ?? 100;
      if (entries.length < triggerAt) return entries;

      const targetCount = cfg.targetEntries ?? 50;
      const countToCompress = entries.length - targetCount;
      if (countToCompress <= 0) return entries;

      // Sort oldest first; compress the oldest countToCompress entries
      const sorted = [...entries].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      const toCompress = sorted.slice(0, countToCompress);
      const toKeep = sorted.slice(countToCompress);

      const compressorFn = cfg.compressor ?? defaultCompressorFn;
      const summary = await compressorFn(toCompress.map((e) => e.content));

      // Delete all old entries for this key then re-store kept + summary
      await adapter.deleteAll(key);

      const summaryEntry = await adapter.store(key, summary, {
        compressed: true,
        sourceCount: toCompress.length,
        compressedAt: new Date().toISOString(),
      });

      // Re-store the entries we're keeping (oldest → newest)
      const restored: MemoryEntry[] = [];
      for (const e of toKeep) {
        const re = await adapter.store(key, e.content, e.metadata);
        restored.push(re);
      }

      return [summaryEntry, ...restored];
    },
  };
}

// ── LLM compressor helper ─────────────────────────────────────────────────────

/**
 * Build an LLM-based compressor function.
 *
 * Pass a `summarize` callback that calls your LLM of choice.
 * The function receives the concatenated entries and returns a summary string.
 *
 * Example:
 *   const compressor = makeLlmCompressor(async (text) => {
 *     const result = await anthropic.messages.create({
 *       model: "claude-haiku-4-5-20251001",
 *       messages: [{ role: "user", content: `Summarize these memories:\n${text}` }],
 *     });
 *     return result.content[0].type === "text" ? result.content[0].text : text;
 *   });
 *
 *   const policy = createMemoryPolicy({ compression: { enabled: true, compressor } });
 */
export function makeLlmCompressor(
  summarize: (text: string) => Promise<string>
): (entries: string[]) => Promise<string> {
  return async (entries: string[]) => {
    const combined = entries.join("\n\n---\n\n");
    return summarize(combined);
  };
}
