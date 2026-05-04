/**
 * Memory factory — returns the configured MemoryAdapter singleton.
 *
 * Configure via MEMORY_PROVIDER env var:
 *   MEMORY_PROVIDER=memory    — in-process Map (default, non-persistent)
 *   MEMORY_PROVIDER=pgvector  — Postgres + pgvector (Supabase compatible)
 *   MEMORY_PROVIDER=pinecone  — Pinecone vector database
 *
 * The adapter is cached in globalThis so it survives Next.js hot-reloads.
 */

import type { MemoryAdapter } from "./types";

export type MemoryProvider = "memory" | "pgvector" | "pinecone";

const PROVIDER = (process.env.MEMORY_PROVIDER ?? "memory") as MemoryProvider;

declare global {
  // eslint-disable-next-line no-var
  var __agentMemory: MemoryAdapter | undefined;
}

function createAdapter(): MemoryAdapter {
  switch (PROVIDER) {
    case "pgvector": {
      const { PgVectorAdapter } = require("./pgvector") as typeof import("./pgvector");
      return new PgVectorAdapter();
    }
    case "pinecone": {
      const { PineconeAdapter } = require("./pinecone") as typeof import("./pinecone");
      return new PineconeAdapter();
    }
    default: {
      const { InMemoryAdapter } = require("./in-memory") as typeof import("./in-memory");
      return new InMemoryAdapter();
    }
  }
}

export const memory: MemoryAdapter = globalThis.__agentMemory ?? (globalThis.__agentMemory = createAdapter());

export type { MemoryAdapter, MemoryEntry } from "./types";
export { anchors, AnchorStore, parseTtlMs } from "./anchors";
export type { AnchorEntry, AnchorOptions } from "./anchors";

/**
 * Format retrieved memories into a system-prompt-ready string.
 * The harness calls this when AgentConfig.memoryKey is set.
 */
export function formatMemoriesForPrompt(
  memories: import("./types").MemoryEntry[],
  maxLength = 2000
): string {
  if (memories.length === 0) return "";
  const lines = memories.map(
    (m, i) =>
      `[Memory ${i + 1}] ${m.content}`
  );
  const joined = lines.join("\n");
  return joined.length > maxLength
    ? joined.slice(0, maxLength) + "\n...(truncated)"
    : joined;
}
