/**
 * FTS-backed session search — the central-integration glue that puts the
 * BM25F `InvertedIndex` (./fts) in front of a `SessionStore` so the CLI (and
 * any other surface) can search past conversations with real ranking instead
 * of the legacy `scoreSession` term-overlap scanner.
 *
 * Each session is indexed as one document with three weighted fields:
 * `title` (highest), `summary` (when present), and `content` (every message
 * joined). Field weights come from the index's defaults (title 2.5 /
 * summary 1.8 / content 1.0), the exact configuration the recall benchmark
 * (./recall-bench) measures against the legacy scanner.
 *
 * `searchSessionsFts` rebuilds the index from the store on every call. That
 * is a deliberate simplicity/consistency trade: the store is the single
 * source of truth (no cache-invalidation bugs when sessions are appended
 * between calls), and the measured cost is small at CLI scale — the FTS
 * engine's own benchmark indexes 10,000 documents in well under a second,
 * orders of magnitude above a personal session history. If a long-running
 * surface ever needs an incremental index, `buildSessionIndex` is the
 * building block to wrap with update()-on-append bookkeeping.
 */

import { InvertedIndex } from "./fts";
import type { SessionRecord, SessionStore } from "./session-store";

/** One session search hit — structurally matches the CLI's `MemorySessionHit`. */
export interface SessionFtsHit {
  id: string;
  score: number;
  /** Best-field snippet from the FTS engine (normalized/lowercased text — see ./fts docs). */
  snippet: string;
  title?: string;
  startedAt: number;
}

/** Index every session as one FTS document (fields: title / summary / content). */
export function buildSessionIndex(sessions: SessionRecord[]): InvertedIndex {
  const index = new InvertedIndex();
  for (const session of sessions) {
    index.add({
      id: session.id,
      fields: {
        title: session.title ?? "",
        summary: session.summary ?? "",
        content: session.messages.map((m) => m.content).join("\n"),
      },
    });
  }
  return index;
}

/**
 * Search the store's sessions with BM25F ranking. Returns best-first hits;
 * an empty/whitespace query, or an empty store, honestly returns `[]`.
 */
export function searchSessionsFts(
  store: SessionStore,
  query: string,
  opts: { limit?: number } = {},
): SessionFtsHit[] {
  const sessions = store.all();
  if (sessions.length === 0) return [];

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const index = buildSessionIndex(sessions);

  const hits: SessionFtsHit[] = [];
  for (const match of index.search(query, { limit: opts.limit ?? 10 })) {
    const session = byId.get(match.id);
    if (!session) continue; // defensive: the index is built from `sessions`, so this cannot drop real hits
    hits.push({
      id: session.id,
      score: match.score,
      snippet: match.snippet.text,
      title: session.title,
      startedAt: session.startedAt,
    });
  }
  return hits;
}
