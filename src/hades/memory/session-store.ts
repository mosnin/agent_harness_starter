import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tokenize } from "./store";

export interface SessionMessage {
  role: "user" | "assistant" | "system";
  content: string;
  at: number;
}

/** A past conversation Hades can search and recall — the FTS5-session-search analogue. */
export interface SessionRecord {
  id: string;
  title?: string;
  messages: SessionMessage[];
  /** LLM-generated summary for cheap cross-session recall. */
  summary?: string;
  tags: string[];
  startedAt: number;
  endedAt?: number;
}

export interface SessionSearchResult {
  session: SessionRecord;
  score: number;
  /** The best-matching message snippet, for display. */
  snippet: string;
}

/** Injectable summarizer (wraps any LLM). */
export type Summarizer = (text: string) => Promise<string>;

export interface SessionStore {
  create(input?: { title?: string; tags?: string[] }): SessionRecord;
  append(id: string, msg: Omit<SessionMessage, "at"> & { at?: number }): void;
  end(id: string): void;
  get(id: string): SessionRecord | undefined;
  all(): SessionRecord[];
  search(query: string, opts?: { limit?: number; tag?: string }): SessionSearchResult[];
  summarize(id: string, summarize: Summarizer): Promise<string | undefined>;
  size(): number;
}

/**
 * Full-text-ish search over a session's messages + summary + title, ranked by
 * term-frequency overlap. Pure and exported for testing. This is what lets Hades
 * answer "didn't we discuss X last week?" without keeping everything in context.
 */
export function scoreSession(session: SessionRecord, queryTokens: string[]): { score: number; snippet: string } {
  const distinct = queryTokens.filter((t) => t.length >= 2);
  if (distinct.length === 0) return { score: 0, snippet: "" };
  const haystackParts = [
    session.title ?? "",
    session.summary ?? "",
    ...session.messages.map((m) => m.content),
  ];
  let bestSnippet = session.summary ?? session.title ?? "";
  let bestSnippetHits = -1;
  let totalHits = 0;
  let totalTerms = 0;
  for (const part of haystackParts) {
    const lower = part.toLowerCase();
    const hits = distinct.filter((t) => lower.includes(t)).length;
    totalHits += hits;
    totalTerms += distinct.length;
    if (hits > bestSnippetHits && part.trim()) {
      bestSnippetHits = hits;
      bestSnippet = part;
    }
  }
  const score = totalTerms ? totalHits / totalTerms : 0;
  return { score, snippet: bestSnippet.slice(0, 200) };
}

export class InMemorySessionStore implements SessionStore {
  protected sessions = new Map<string, SessionRecord>();

  create(input: { title?: string; tags?: string[] } = {}): SessionRecord {
    const s: SessionRecord = {
      id: randomUUID(),
      title: input.title,
      messages: [],
      tags: input.tags ?? [],
      startedAt: this.now(),
    };
    this.sessions.set(s.id, s);
    this.persist();
    return s;
  }

  append(id: string, msg: Omit<SessionMessage, "at"> & { at?: number }): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.messages.push({ role: msg.role, content: msg.content, at: msg.at ?? this.now() });
    this.persist();
  }

  end(id: string): void {
    const s = this.sessions.get(id);
    if (s && !s.endedAt) {
      s.endedAt = this.now();
      this.persist();
    }
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }
  all(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  search(query: string, opts: { limit?: number; tag?: string } = {}): SessionSearchResult[] {
    const tokens = tokenize(query);
    let pool = this.all();
    if (opts.tag) pool = pool.filter((s) => s.tags.includes(opts.tag!));
    return pool
      .map((session) => {
        const { score, snippet } = scoreSession(session, tokens);
        return { session, score, snippet };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 10);
  }

  async summarize(id: string, summarize: Summarizer): Promise<string | undefined> {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const transcript = s.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    s.summary = await summarize(transcript);
    this.persist();
    return s.summary;
  }

  size(): number {
    return this.sessions.size;
  }

  protected now(): number {
    return Date.now();
  }
  protected persist(): void {}
}

export class FileSessionStore extends InMemorySessionStore {
  constructor(private readonly path: string) {
    super();
    try {
      const arr = JSON.parse(readFileSync(path, "utf8")) as SessionRecord[];
      for (const s of arr) this.sessions.set(s.id, s);
    } catch {
      /* fresh */
    }
  }
  protected override persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* exists */
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all()));
    renameSync(tmp, this.path);
  }
}
