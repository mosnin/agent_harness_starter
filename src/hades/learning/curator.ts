import type { MemoryStore, MemoryRecord } from "../memory/store";
import { tokenize } from "../memory/store";
import type { SessionRecord } from "../memory/session-store";

export interface CandidateFact {
  fact: string;
  salience: number;
  tags: string[];
}

/** Injectable LLM extractor (returns candidate facts to remember). */
export type FactExtractor = (transcript: string) => Promise<CandidateFact[]>;

/**
 * Salient-statement patterns for the offline extractor. Each captures a durable
 * fact worth remembering across sessions and assigns a base salience.
 */
const PATTERNS: Array<{ re: RegExp; salience: number; tag: string }> = [
  { re: /\bmy name is ([^.!?\n]{2,60})/i, salience: 0.95, tag: "profile" },
  { re: /\bi(?:'m| am) (?:called |named )?([A-Z][^.!?\n]{1,40})/, salience: 0.7, tag: "profile" },
  { re: /\bi (?:prefer|like|love|favou?r) ([^.!?\n]{2,80})/i, salience: 0.8, tag: "preference" },
  { re: /\bi (?:use|work with|work on|run) ([^.!?\n]{2,80})/i, salience: 0.7, tag: "context" },
  { re: /\bi (?:live|am based) in ([^.!?\n]{2,60})/i, salience: 0.8, tag: "profile" },
  { re: /\bwe (?:chose|decided|agreed|will use|are using) ([^.!?\n]{2,100})/i, salience: 0.75, tag: "decision" },
  { re: /\bremember (?:that )?([^.!?\n]{4,120})/i, salience: 0.85, tag: "explicit" },
  { re: /\balways ([^.!?\n]{4,100})/i, salience: 0.6, tag: "preference" },
];

/**
 * Curates durable memories from experience — the "agent-curated memory" half of
 * the learning loop. It reads a finished session, extracts salient facts
 * (offline pattern extractor by default, or an injected LLM extractor), and
 * persists the new ones, deduping against what's already remembered so the store
 * doesn't bloat with restatements.
 */
export class MemoryCurator {
  constructor(
    private readonly store: MemoryStore,
    private readonly opts: { extractor?: FactExtractor; dedupeThreshold?: number } = {}
  ) {}

  /** Extract + persist memories from a session. Returns the newly-added records. */
  async curateSession(session: SessionRecord): Promise<MemoryRecord[]> {
    // Only user/assistant turns carry durable facts.
    const candidates = this.opts.extractor
      ? await this.opts.extractor(session.messages.map((m) => `${m.role}: ${m.content}`).join("\n"))
      : this.extractOffline(session);

    const added: MemoryRecord[] = [];
    for (const c of candidates) {
      const fact = c.fact.trim();
      if (fact.length < 3) continue;
      if (this.isDuplicate(fact)) continue;
      added.push(
        this.store.add({
          fact,
          salience: c.salience,
          tags: [...new Set([...c.tags, "curated"])],
          source: `session:${session.id}`,
        })
      );
    }
    return added;
  }

  /** Deterministic, dependency-free extraction via salient-statement patterns. */
  extractOffline(session: SessionRecord): CandidateFact[] {
    const out: CandidateFact[] = [];
    const seen = new Set<string>();
    for (const m of session.messages) {
      if (m.role === "system") continue;
      for (const p of PATTERNS) {
        const match = m.content.match(p.re);
        if (match) {
          const captured = match[1].trim().replace(/["']$/, "");
          const fact = normalizeFact(match[0]);
          const key = captured.toLowerCase();
          if (fact && !seen.has(key)) {
            seen.add(key);
            out.push({ fact, salience: p.salience, tags: [p.tag] });
          }
        }
      }
    }
    return out;
  }

  private isDuplicate(fact: string): boolean {
    const threshold = this.opts.dedupeThreshold ?? 0.8;
    const tokens = new Set(tokenize(fact));
    if (tokens.size === 0) return true;
    for (const existing of this.store.all()) {
      const et = new Set(tokenize(existing.fact));
      const overlap = [...tokens].filter((t) => et.has(t)).length / tokens.size;
      if (overlap >= threshold) return true;
    }
    return false;
  }
}

function normalizeFact(s: string): string {
  // Turn a first-person capture into a stored third-person-ish fact.
  return s
    .replace(/^\s*i(?:'m| am)\b/i, "The user is")
    .replace(/^\s*i\b/i, "The user")
    .replace(/^\s*my\b/i, "The user's")
    .replace(/^\s*we\b/i, "The team")
    .replace(/\s+/g, " ")
    .trim();
}
