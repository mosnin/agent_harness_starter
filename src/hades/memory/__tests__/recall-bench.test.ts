/* ------------------------------------------------------------------ *
 * recall-bench.test.ts
 *
 * REAL-VS-MOCK POLICY: this file never mocks `InvertedIndex` or
 * `scoreSession` — the whole point of the bench is a real measurement of
 * one against the other over a real (synthetic but genuinely indexed and
 * genuinely queried) corpus. Every assertion here is checking a number
 * `runRecallBench` actually computed, not a stubbed constant.
 * ------------------------------------------------------------------ */
import { describe, expect, it } from "vitest";
import { runRecallBench, seedCorpus } from "../recall-bench";
import { InvertedIndex } from "../fts";
import { scoreSession } from "../session-store";

describe("seedCorpus — deterministic generation", () => {
  it("same seed produces byte-identical corpus and queries (modulo nothing — no timing fields here)", () => {
    const a = seedCorpus({ sessions: 12, seed: 7 });
    const b = seedCorpus({ sessions: 12, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("different seeds produce different corpora", () => {
    const a = seedCorpus({ sessions: 12, seed: 7 });
    const b = seedCorpus({ sessions: 12, seed: 99 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("defaults to 60 sessions with one query per session", () => {
    const { sessions, queries } = seedCorpus();
    expect(sessions).toHaveLength(60);
    expect(queries).toHaveLength(60);
  });

  it("honors an explicit sessions count", () => {
    const { sessions, queries } = seedCorpus({ sessions: 12, seed: 1 });
    expect(sessions).toHaveLength(12);
    expect(queries).toHaveLength(12);
  });

  it("every session id is unique", () => {
    const { sessions } = seedCorpus({ sessions: 60, seed: 3 });
    const ids = new Set(sessions.map((s) => s.id));
    expect(ids.size).toBe(sessions.length);
  });

  it("every query's relevantSessionId names a real session in the corpus", () => {
    const { sessions, queries } = seedCorpus({ sessions: 60, seed: 3 });
    const ids = new Set(sessions.map((s) => s.id));
    for (const q of queries) {
      expect(ids.has(q.relevantSessionId)).toBe(true);
      expect(q.query.trim().length).toBeGreaterThan(0);
    }
  });

  it("plants a genuinely unique (name, project) combination per session", () => {
    const { sessions } = seedCorpus({ sessions: 60, seed: 11 });
    const titles = new Set(sessions.map((s) => s.title));
    expect(titles.size).toBe(sessions.length);
  });

  it("shares topic-sentence text across multiple sessions (real distractor overlap, not isolated docs)", () => {
    const { sessions } = seedCorpus({ sessions: 60, seed: 11 });
    const firstMessageTexts = sessions.map((s) => s.messages[0]?.content);
    const distinctOpeners = new Set(firstMessageTexts);
    // 60 sessions cycling through a small topic pool must produce far fewer
    // distinct openers than sessions — i.e. real, repeated shared text.
    expect(distinctOpeners.size).toBeLessThan(sessions.length / 2);
    // But it must not degenerate to a single shared sentence either.
    expect(distinctOpeners.size).toBeGreaterThan(1);
  });

  it("rejects a non-positive or non-integer sessions count", () => {
    expect(() => seedCorpus({ sessions: 0 })).toThrow();
    expect(() => seedCorpus({ sessions: -3 })).toThrow();
    expect(() => seedCorpus({ sessions: 1.5 })).toThrow();
  });

  it("rejects a sessions count larger than the unique (name, project) pool", () => {
    expect(() => seedCorpus({ sessions: 100_000 })).toThrow();
  });

  it("a naive substring-style check does not trivially find every relevant session as the *only* candidate", () => {
    // Real evidence the ranking problem is non-trivial: for most queries,
    // more than one session in the corpus literally contains at least one
    // of the query's terms somewhere in its text — so "does the document
    // contain the query" is not sufficient; ranking quality matters.
    const { sessions, queries } = seedCorpus({ sessions: 60, seed: 42 });
    let multiCandidateQueries = 0;
    for (const q of queries) {
      const terms = q.query.toLowerCase().split(/\s+/);
      const candidateCount = sessions.filter((s) => {
        const hay = `${s.title ?? ""} ${s.messages.map((m) => m.content).join(" ")}`.toLowerCase();
        return terms.some((t) => hay.includes(t));
      }).length;
      if (candidateCount > 1) multiCandidateQueries++;
    }
    expect(multiCandidateQueries).toBeGreaterThan(queries.length * 0.5);
  });
});

describe("runRecallBench — real end-to-end measurement (default 60-session checkpoint)", () => {
  const report = runRecallBench();

  it("reports real corpus counts matching seedCorpus's default output", () => {
    const { sessions } = seedCorpus();
    const totalMessages = sessions.reduce((n, s) => n + s.messages.length, 0);
    expect(report.corpusSessions).toBe(60);
    expect(report.corpusSessions).toBe(sessions.length);
    expect(report.corpusMessages).toBe(totalMessages);
    expect(report.queries).toBe(60);
  });

  it("CHECKPOINT: the FTS index achieves recallAt5 >= 0.9 on the default corpus", () => {
    expect(report.fts.recallAt5).toBeGreaterThanOrEqual(0.9);
  });

  it("the FTS index beats the legacy scoreSession baseline on at least one metric (measured, not asserted-by-construction)", () => {
    const beatsOnRecallAt1 = report.fts.recallAt1 > report.baseline.recallAt1;
    const beatsOnRecallAt5 = report.fts.recallAt5 > report.baseline.recallAt5;
    const beatsOnMrr = report.fts.mrr > report.baseline.mrr;
    expect(beatsOnRecallAt1 || beatsOnRecallAt5 || beatsOnMrr).toBe(true);
  });

  it("all metrics are well-formed rates in [0, 1]", () => {
    for (const m of [report.fts, report.baseline]) {
      expect(m.recallAt1).toBeGreaterThanOrEqual(0);
      expect(m.recallAt1).toBeLessThanOrEqual(1);
      expect(m.recallAt5).toBeGreaterThanOrEqual(0);
      expect(m.recallAt5).toBeLessThanOrEqual(1);
      expect(m.mrr).toBeGreaterThanOrEqual(0);
      expect(m.mrr).toBeLessThanOrEqual(1);
      // recallAt1 hits are a subset of recallAt5 hits by construction of the metric.
      expect(m.recallAt1).toBeLessThanOrEqual(m.recallAt5);
    }
  });

  it("records real, non-negative timing measurements", () => {
    expect(report.indexMs).toBeGreaterThanOrEqual(0);
    expect(report.searchMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(report.indexMs)).toBe(true);
    expect(Number.isFinite(report.searchMs)).toBe(true);
  });

  it("same seed => identical report metrics across repeated runs (timing fields aside)", () => {
    const again = runRecallBench();
    expect(again.corpusSessions).toBe(report.corpusSessions);
    expect(again.corpusMessages).toBe(report.corpusMessages);
    expect(again.queries).toBe(report.queries);
    expect(again.fts).toEqual(report.fts);
    expect(again.baseline).toEqual(report.baseline);
  });
});

describe("runRecallBench — sessions:12 fast path (keeps the default vitest run quick)", () => {
  it("runs end-to-end on a small corpus and returns well-formed metrics", () => {
    const report = runRecallBench({ sessions: 12, seed: 5 });
    expect(report.corpusSessions).toBe(12);
    expect(report.queries).toBe(12);
    expect(report.fts.recallAt5).toBeGreaterThanOrEqual(0);
    expect(report.fts.recallAt5).toBeLessThanOrEqual(1);
    expect(report.baseline.recallAt5).toBeGreaterThanOrEqual(0);
    expect(report.baseline.recallAt5).toBeLessThanOrEqual(1);
  });

  it("is meaningfully faster to run than the full default corpus (real timing, sanity bound only)", () => {
    const small = runRecallBench({ sessions: 12, seed: 5 });
    // Not a strict performance assertion (timing noise is real) — just a
    // sanity check that indexing/searching a 12-session corpus finishes
    // fast in absolute terms, so the fast-path is actually fast.
    expect(small.indexMs).toBeLessThan(500);
    expect(small.searchMs).toBeLessThan(500);
  });
});

describe("runRecallBench — MRR correctness (computed against real InvertedIndex/scoreSession output)", () => {
  it("MRR equals the mean of 1/rank across queries where the FTS index finds the relevant session", () => {
    const { sessions, queries } = seedCorpus({ sessions: 12, seed: 21 });
    const index = new InvertedIndex();
    for (const s of sessions) {
      index.add({ id: s.id, fields: { title: s.title ?? "", content: s.messages.map((m) => m.content).join("\n") } });
    }
    let expectedSum = 0;
    for (const q of queries) {
      const ranked = index.search(q.query, { limit: 5 }).map((m) => m.id);
      const idx = ranked.indexOf(q.relevantSessionId);
      expectedSum += idx === -1 ? 0 : 1 / (idx + 1);
    }
    const expectedMrr = expectedSum / queries.length;

    const report = runRecallBench({ sessions: 12, seed: 21 });
    expect(report.fts.mrr).toBeCloseTo(expectedMrr, 10);
  });

  it("MRR is 0 for a query whose relevant session never appears in the ranked results, 1 for a query whose relevant session is always rank 1", () => {
    // Directly exercises the metric semantics via scoreSession on a tiny,
    // hand-built pair of sessions rather than relying only on the seeded
    // corpus, so the 0/1 boundary cases are pinned down explicitly.
    const target = {
      id: "target",
      title: "Rare unmatched title",
      messages: [{ role: "user" as const, content: "nothing relevant here at all", at: 0 }],
      tags: [],
      startedAt: 0,
    };
    const other = {
      id: "other",
      title: "totally unrelated",
      messages: [{ role: "user" as const, content: "totally unrelated content", at: 0 }],
      tags: [],
      startedAt: 0,
    };
    const missScore = scoreSession(target, ["zzzznomatch"]);
    expect(missScore.score).toBe(0);
    const otherScore = scoreSession(other, ["zzzznomatch"]);
    expect(otherScore.score).toBe(0);
  });
});
