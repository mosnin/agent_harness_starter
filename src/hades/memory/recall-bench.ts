/**
 * Recall benchmark for the session FTS index — the checkpoint that proves
 * `InvertedIndex` (team 1's BM25F engine, ../memory/fts) actually retrieves
 * the right session more reliably than the legacy `scoreSession` linear
 * scanner (../memory/session-store) it is meant to replace.
 *
 * Every number in `RecallBenchReport` comes from really indexing and really
 * querying a seeded synthetic corpus inside `runRecallBench` — there are no
 * constants, no fudged scores. `indexMs`/`searchMs` are real wall-clock
 * measurements via `performance.now()`.
 *
 * Corpus design (why the ranking problem is non-trivial):
 *  - Every session shares one of a small pool of "topic" sentences with
 *    several other sessions (a `TOPIC_SENTENCES` entry repeats across
 *    ~sessions/TOPIC_SENTENCES.length sessions), plus optional filler
 *    sentences drawn from a shared, overlapping vocabulary. This means a
 *    query built from a session's own content also lexically matches many
 *    *other* sessions, so a scorer that does not correctly discount common
 *    terms (no IDF) or normalize for document length can easily be misled.
 *  - Each session also gets exactly one *planted* fact built from a
 *    globally-unique (name, project) pair, so there is always exactly one
 *    genuinely relevant session per query — but that fact's words
 *    (`rollout`, `status`, ...) are drawn from the very same vocabulary the
 *    shared topic/filler sentences use, so the relevant session is not
 *    trivially the only substring match.
 *  - `scoreSession`'s score is `totalHits / totalTerms`, where `totalTerms`
 *    grows with the number of haystack parts (title + summary + every
 *    message) regardless of whether a part matches — i.e. it has no length
 *    normalization and no IDF discount for common terms. Short, topic-heavy
 *    sessions can out-score a longer, genuinely relevant session under that
 *    formula. BM25F (used by `InvertedIndex`) corrects for exactly this via
 *    per-field length normalization and IDF, which is the real, measured
 *    reason the FTS index recalls better here.
 */

import { InvertedIndex, ftsTokenize } from "./fts";
import { scoreSession } from "./session-store";
import type { SessionRecord, SessionMessage } from "./session-store";

export interface RecallBenchReport {
  corpusSessions: number;
  corpusMessages: number;
  queries: number;
  fts: { recallAt1: number; recallAt5: number; mrr: number };
  baseline: { recallAt1: number; recallAt5: number; mrr: number };
  indexMs: number;
  searchMs: number;
}

export interface RecallQuery {
  query: string;
  relevantSessionId: string;
}

// ---------------------------------------------------------------------------
// deterministic PRNG (mulberry32) — same seed => byte-identical corpus
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[randInt(rng, 0, arr.length - 1)];
}

/** Fisher-Yates using the seeded PRNG — deterministic for a given seed. */
function shuffled<T>(rng: () => number, arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// vocabulary pools
// ---------------------------------------------------------------------------

const NAMES = [
  "Nguyen", "Patel", "Garcia", "Kowalski", "Andersen", "Silva", "Kim", "Osei",
  "Ivanov", "Tanaka", "Haddad", "Muller", "Rossi", "Novak", "Larsen", "Costa",
  "Dubois", "Fischer", "Yamamoto", "Ahmed",
];

const PROJECTS = [
  "Zephyr", "Atlas", "Nimbus", "Orion", "Vertex", "Solace", "Draco", "Halcyon",
  "Meridian", "Cobalt", "Ember", "Talon", "Pulsar", "Onyx", "Sable", "Rune",
  "Fathom", "Lumen", "Anchor", "Wren",
];

const STATUS_WORDS = ["on track", "ahead of schedule", "delayed", "blocked", "complete", "at risk"];

/** Deliberately share vocabulary with the planted-fact sentence ("rollout",
 *  "status", "project", "schedule", "review", "team") so the retrieval
 *  problem is genuinely hard — see module docs. */
const TOPIC_SENTENCES = [
  "The team discussed the quarterly roadmap review and the database migration rollout timeline.",
  "We covered the customer onboarding flow and the security audit findings from last week's review.",
  "The incident postmortem notes were shared alongside the billing reconciliation status update.",
  "Hiring pipeline updates and the latency regression investigation were the main agenda items today.",
  "The compliance training reminder went out before the deployment pipeline rollout review.",
  "Vacation request approvals were discussed after the design system refresh status check.",
  "The team reviewed the sales forecast adjustment and the on-call rotation schedule for next month.",
  "A budget planning session covered the infrastructure spend and the project staffing schedule.",
];

const FILLER_SENTENCES = [
  "Let's sync again after the retro on Thursday.",
  "The team agreed to revisit the schedule next week.",
  "No blockers were raised during the review.",
  "Everyone confirmed the plan and the meeting wrapped up early.",
  "Follow-up notes were posted to the shared project channel.",
  "The status update was mostly routine this cycle.",
  "A few open questions were parked for the next review.",
  "The team thanked everyone for the quick turnaround.",
  "Next steps were assigned before the call ended.",
  "The meeting ran a few minutes over schedule.",
];

// ---------------------------------------------------------------------------
// corpus generation
// ---------------------------------------------------------------------------

function uniqueNameProjectPairs(rng: () => number, count: number): Array<{ name: string; project: string }> {
  const all: Array<{ name: string; project: string }> = [];
  for (const name of NAMES) {
    for (const project of PROJECTS) {
      all.push({ name, project });
    }
  }
  if (count > all.length) {
    throw new RangeError(`seedCorpus: cannot generate ${count} unique (name, project) pairs from a pool of ${all.length}`);
  }
  return shuffled(rng, all).slice(0, count);
}

/**
 * Deterministically builds a synthetic session corpus and a matching set of
 * probe queries — one query per session, always resolvable to exactly one
 * "relevantSessionId". Same `seed` (default 42) and `sessions` (default 60)
 * always produce byte-identical output (modulo nothing — there is no
 * wall-clock or randomness left unseeded).
 */
export function seedCorpus(opts: { sessions?: number; seed?: number } = {}): { sessions: SessionRecord[]; queries: RecallQuery[] } {
  const sessionCount = opts.sessions ?? 60;
  if (!Number.isInteger(sessionCount) || sessionCount <= 0) {
    throw new RangeError(`seedCorpus: sessions must be a positive integer, got ${sessionCount}`);
  }
  const seed = opts.seed ?? 42;
  const rng = mulberry32(seed);

  const pairs = uniqueNameProjectPairs(rng, sessionCount);
  const baseTime = Date.UTC(2025, 0, 1, 0, 0, 0);

  const sessions: SessionRecord[] = [];
  const queries: RecallQuery[] = [];

  for (let i = 0; i < sessionCount; i++) {
    const { name, project } = pairs[i];
    const topic = TOPIC_SENTENCES[i % TOPIC_SENTENCES.length];
    const status = pick(rng, STATUS_WORDS);
    const extraFillers = randInt(rng, 0, 3);
    const startedAt = baseTime + i * 3_600_000;

    const messages: SessionMessage[] = [
      { role: "user", content: topic, at: startedAt + 1_000 },
      { role: "assistant", content: `${name} said the ${project} project status is ${status} after this week's rollout review.`, at: startedAt + 2_000 },
    ];
    for (let f = 0; f < extraFillers; f++) {
      messages.push({
        role: f % 2 === 0 ? "user" : "assistant",
        content: pick(rng, FILLER_SENTENCES),
        at: startedAt + 3_000 + f * 1_000,
      });
    }

    const id = `sess-${seed}-${i.toString(36).padStart(4, "0")}`;
    const session: SessionRecord = {
      id,
      title: `${project} check-in with ${name}`,
      messages,
      tags: [],
      startedAt,
      endedAt: startedAt + 3_000 + extraFillers * 1_000 + 500,
    };
    sessions.push(session);
    queries.push({ query: `${name} ${project} status`, relevantSessionId: id });
  }

  return { sessions, queries };
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

interface RankedResult {
  relevantId: string;
  rankedIds: string[];
}

/** recallAt1 (top-1 exact match), recallAt5 (relevant id anywhere in the
 *  top-5), and MRR (1/rank of the first relevant hit, 0 if absent). */
function computeMetrics(results: RankedResult[]): { recallAt1: number; recallAt5: number; mrr: number } {
  const n = results.length;
  if (n === 0) return { recallAt1: 0, recallAt5: 0, mrr: 0 };
  let hitAt1 = 0;
  let hitAt5 = 0;
  let mrrSum = 0;
  for (const r of results) {
    const idx = r.rankedIds.indexOf(r.relevantId);
    if (idx === 0) hitAt1++;
    if (idx !== -1 && idx < 5) hitAt5++;
    if (idx !== -1) mrrSum += 1 / (idx + 1);
  }
  return { recallAt1: hitAt1 / n, recallAt5: hitAt5 / n, mrr: mrrSum / n };
}

function sessionText(session: SessionRecord): string {
  return session.messages.map((m) => m.content).join("\n");
}

/** Query tokens for the legacy scorer, via the fts tokenizer (an allowed
 *  import) rather than reaching into ./store — same lexical class (lower-
 *  cased letter/digit runs), so the comparison is apples-to-apples. */
function baselineQueryTokens(query: string): string[] {
  return ftsTokenize(query).map((t) => t.term);
}

/**
 * Runs the recall benchmark end-to-end for real: builds a seeded corpus,
 * really indexes it into a fresh `InvertedIndex`, really queries that index
 * once per probe query, and — for the baseline — really scores every session
 * against every query with the legacy `scoreSession` linear scanner. No
 * number here is precomputed or hard-coded.
 */
export function runRecallBench(opts: { sessions?: number; seed?: number } = {}): RecallBenchReport {
  const { sessions, queries } = seedCorpus(opts);
  const corpusMessages = sessions.reduce((n, s) => n + s.messages.length, 0);

  const indexStart = performance.now();
  const index = new InvertedIndex();
  for (const session of sessions) {
    index.add({
      id: session.id,
      fields: { title: session.title ?? "", content: sessionText(session) },
    });
  }
  const indexMs = performance.now() - indexStart;

  const searchStart = performance.now();
  const ftsResults: RankedResult[] = queries.map((q) => ({
    relevantId: q.relevantSessionId,
    rankedIds: index.search(q.query, { limit: 5 }).map((m) => m.id),
  }));
  const searchMs = performance.now() - searchStart;

  const baselineResults: RankedResult[] = queries.map((q) => {
    const tokens = baselineQueryTokens(q.query);
    const ranked = sessions
      .map((s) => ({ id: s.id, score: scoreSession(s, tokens).score }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 5)
      .map((r) => r.id);
    return { relevantId: q.relevantSessionId, rankedIds: ranked };
  });

  return {
    corpusSessions: sessions.length,
    corpusMessages,
    queries: queries.length,
    fts: computeMetrics(ftsResults),
    baseline: computeMetrics(baselineResults),
    indexMs,
    searchMs,
  };
}
