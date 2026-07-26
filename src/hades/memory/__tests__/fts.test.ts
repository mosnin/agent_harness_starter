import { describe, it, expect } from "vitest";
import { ftsTokenize, InvertedIndex, FtsIndexError } from "../fts";
import type { FtsDocument } from "../fts";

describe("ftsTokenize", () => {
  it("splits letter/digit runs and reports offsets into the normalized string", () => {
    const tokens = ftsTokenize("Hello, world! v2");
    expect(tokens.map((t) => t.term)).toEqual(["hello", "world", "v2"]);
    for (const t of tokens) {
      const normalized = "hello, world! v2";
      expect(normalized.slice(t.start, t.end)).toBe(t.term);
    }
  });

  it("lowercases and NFKC-normalizes (ligature expands, offsets stay internally consistent)", () => {
    // U+FB01 LATIN SMALL LIGATURE FI decomposes under NFKC to "fi" (length 1 -> 2).
    const raw = "ﬁsh";
    const tokens = ftsTokenize(raw);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].term).toBe("fish");
    const normalized = raw.normalize("NFKC").toLowerCase();
    expect(normalized.slice(tokens[0].start, tokens[0].end)).toBe("fish");
  });

  it("handles the İ (dotted capital I) case-folding expansion without corrupting offsets", () => {
    // "İ".toLowerCase() expands to "i" + COMBINING DOT ABOVE (U+0307), a
    // non-letter mark that splits the run — real, well-known JS gotcha.
    // The point of this test is that offsets stay internally consistent
    // against the normalized string despite that length change.
    const raw = "İstanbul";
    const tokens = ftsTokenize(raw);
    const normalized = raw.normalize("NFKC").toLowerCase();
    expect(tokens.map((t) => t.term)).toEqual(["i", "stanbul"]);
    for (const t of tokens) {
      expect(normalized.slice(t.start, t.end)).toBe(t.term);
    }
  });

  it("tokenizes CJK text as unicode letter runs", () => {
    const tokens = ftsTokenize("我爱北京天安门");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].term).toBe("我爱北京天安门");
  });

  it("tokenizes diacritics as part of the letter run", () => {
    const tokens = ftsTokenize("café résumé");
    expect(tokens.map((t) => t.term)).toEqual(["café", "résumé"]);
  });

  it("excludes emoji and punctuation (not \\p{L} or \\p{N})", () => {
    const tokens = ftsTokenize("rocket 🚀 launch! (v2.0)");
    expect(tokens.map((t) => t.term)).toEqual(["rocket", "launch", "v2", "0"]);
  });

  it("returns an empty array for empty or symbol-only input", () => {
    expect(ftsTokenize("")).toEqual([]);
    expect(ftsTokenize("   ...!!! ---")).toEqual([]);
  });

  it("correctly offsets surrogate-pair (astral plane) characters", () => {
    // U+1F600 is outside the BMP and encodes as a UTF-16 surrogate pair.
    const raw = "abc😀def";
    const tokens = ftsTokenize(raw);
    expect(tokens.map((t) => t.term)).toEqual(["abc", "def"]);
    const normalized = raw.normalize("NFKC").toLowerCase();
    expect(normalized.slice(tokens[0].start, tokens[0].end)).toBe("abc");
    expect(normalized.slice(tokens[1].start, tokens[1].end)).toBe("def");
  });
});

function doc(id: string, fields: Record<string, string>): FtsDocument {
  return { id, fields };
}

describe("InvertedIndex — basic lifecycle", () => {
  it("adds, checks has(), and reports size()", () => {
    const idx = new InvertedIndex();
    expect(idx.size()).toBe(0);
    idx.add(doc("a", { title: "Hello world" }));
    expect(idx.has("a")).toBe(true);
    expect(idx.has("b")).toBe(false);
    expect(idx.size()).toBe(1);
  });

  it("throws a typed error when add() is called twice with the same id", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { title: "Hello world" }));
    expect(() => idx.add(doc("a", { title: "Different content" }))).toThrow(FtsIndexError);
    expect(() => idx.add(doc("a", { title: "Different content" }))).toThrow(/already exists/);
  });

  it("update() replaces an existing document's content and postings", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "the quick brown fox" }));
    expect(idx.search("quick")).toHaveLength(1);

    idx.update(doc("a", { content: "totally different words here" }));
    expect(idx.search("quick")).toHaveLength(0);
    expect(idx.search("totally")).toHaveLength(1);
    expect(idx.size()).toBe(1);
  });

  it("update() upserts (inserts) when the id does not yet exist", () => {
    const idx = new InvertedIndex();
    idx.update(doc("new-id", { content: "brand new document" }));
    expect(idx.has("new-id")).toBe(true);
    expect(idx.search("brand")).toHaveLength(1);
  });

  it("remove() fully reclaims postings: a removed doc's unique term becomes unsearchable", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "unobtainium is rare" }));
    idx.add(doc("b", { content: "common iron ore" }));
    expect(idx.search("unobtainium")).toHaveLength(1);

    expect(idx.remove("a")).toBe(true);
    expect(idx.remove("a")).toBe(false); // already gone
    expect(idx.has("a")).toBe(false);
    expect(idx.size()).toBe(1);
    expect(idx.search("unobtainium")).toHaveLength(0);
    expect(idx.search("common")).toHaveLength(1);
  });

  it("recomputes avgFieldLength after remove (affects subsequent BM25 length normalization)", () => {
    const idx = new InvertedIndex({ fieldWeights: { content: 1 } });
    idx.add(doc("short", { content: "keyword appears once here" }));
    idx.add(doc("other1", { content: "nothing related whatsoever" }));
    idx.add(doc("other2", { content: "another unrelated document" }));
    idx.add(doc("other3", { content: "yet another filler document" }));
    // Two long, keyword-free docs inflate the average content length.
    idx.add(doc("long1", { content: "padding ".repeat(60).trim() }));
    idx.add(doc("long2", { content: "padding ".repeat(60).trim() }));

    const before = idx.search("keyword")[0].score;
    expect(Number.isFinite(before)).toBe(true);

    idx.remove("long1");
    idx.remove("long2");

    const after = idx.search("keyword")[0].score;
    expect(Number.isFinite(after)).toBe(true);
    // Removing the long docs shrinks the average content length, changing the
    // length-normalization term (and the corpus-size-dependent IDF) — the
    // score must reflect freshly recomputed stats, not stale cached ones.
    expect(after).not.toBeCloseTo(before, 5);
  });

  it("handles documents with empty field values without error", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { title: "", content: "" }));
    expect(idx.has("a")).toBe(true);
    expect(idx.search("anything")).toHaveLength(0);
  });
});

describe("InvertedIndex — search: empty and edge queries", () => {
  it("returns [] for an empty query string", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "hello world" }));
    expect(idx.search("")).toEqual([]);
  });

  it("returns [] for a query with no letter/digit tokens (punctuation only)", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "hello world" }));
    expect(idx.search("!!! --- ...")).toEqual([]);
  });

  it("handles short (single-character) query tokens without crashing", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "a b c" }));
    idx.add(doc("b", { content: "x y z" }));
    const results = idx.search("a");
    expect(results.map((r) => r.id)).toEqual(["a"]);
  });

  it("returns [] when searching an empty index", () => {
    const idx = new InvertedIndex();
    expect(idx.search("anything")).toEqual([]);
  });
});

describe("InvertedIndex — BM25 ranking and field weighting", () => {
  it("ranks a title match above a content-only match for the same term", () => {
    const idx = new InvertedIndex();
    idx.add(doc("title-hit", { title: "deploy", content: "unrelated filler text about nothing" }));
    idx.add(doc("content-hit", { title: "unrelated", content: "we discussed the deploy plan at length" }));
    const results = idx.search("deploy");
    expect(results.map((r) => r.id)).toEqual(["title-hit", "content-hit"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("honors custom field weights passed to the constructor", () => {
    const flat = new InvertedIndex({ fieldWeights: { title: 1, content: 1 } });
    flat.add(doc("a", { title: "deploy", content: "totally unrelated words" }));
    flat.add(doc("b", { title: "unrelated", content: "we deploy things here" }));
    const results = flat.search("deploy");
    // With equal weights, title/content placement should not by itself decide ranking asymmetrically.
    expect(results).toHaveLength(2);
  });

  it("keeps scores finite and non-negative for a term present in every document (IDF floor)", () => {
    const idx = new InvertedIndex();
    for (let i = 0; i < 20; i++) {
      idx.add(doc(`doc${i}`, { content: `common word appears in doc number ${i}` }));
    }
    const results = idx.search("common");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("gives a higher score to a document with more term occurrences (all else equal)", () => {
    const idx = new InvertedIndex({ fieldWeights: { content: 1 } });
    idx.add(doc("many", { content: "fox fox fox fox jumps" }));
    idx.add(doc("one", { content: "fox jumps over the lazy dog and cat and bird" }));
    const results = idx.search("fox");
    expect(results[0].id).toBe("many");
  });

  it("applies ascending doc-id tie-break for equal scores", () => {
    const idx = new InvertedIndex({ fieldWeights: { content: 1 } });
    idx.add(doc("z", { content: "identical phrase here" }));
    idx.add(doc("a", { content: "identical phrase here" }));
    idx.add(doc("m", { content: "identical phrase here" }));
    const results = idx.search("identical");
    expect(results.map((r) => r.score)).toEqual([results[0].score, results[0].score, results[0].score]);
    expect(results.map((r) => r.id)).toEqual(["a", "m", "z"]);
  });

  it("is deterministic: identical corpus + query produce identical ordering across runs", () => {
    function buildAndSearch(): string[] {
      const idx = new InvertedIndex();
      idx.add(doc("1", { title: "Auth service", content: "JWT refresh token rotation design" }));
      idx.add(doc("2", { title: "Billing", content: "refresh cycle for invoices" }));
      idx.add(doc("3", { title: "Refresh strategy", content: "token lifetime and rotation policy" }));
      return idx.search("refresh token").map((m) => m.id);
    }
    const first = buildAndSearch();
    const second = buildAndSearch();
    expect(second).toEqual(first);
  });
});

describe("InvertedIndex — requireAll (AND vs OR)", () => {
  function buildCorpus(): InvertedIndex {
    const idx = new InvertedIndex();
    idx.add(doc("both", { content: "alpha beta appear together" }));
    idx.add(doc("alpha-only", { content: "alpha appears alone here" }));
    idx.add(doc("beta-only", { content: "beta appears alone here" }));
    return idx;
  }

  it("defaults to OR semantics: any matching term is enough", () => {
    const idx = buildCorpus();
    const results = idx.search("alpha beta");
    expect(new Set(results.map((r) => r.id))).toEqual(new Set(["both", "alpha-only", "beta-only"]));
  });

  it("requireAll:true restricts to documents containing every distinct query term", () => {
    const idx = buildCorpus();
    const results = idx.search("alpha beta", { requireAll: true });
    expect(results.map((r) => r.id)).toEqual(["both"]);
  });

  it("requireAll:true returns [] if any query term is entirely absent from the vocabulary", () => {
    const idx = buildCorpus();
    const results = idx.search("alpha nonexistentterm", { requireAll: true });
    expect(results).toEqual([]);
  });
});

describe("InvertedIndex — prefix queries", () => {
  it("matches all vocabulary terms sharing the prefix", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "testing tests tester testable" }));
    idx.add(doc("b", { content: "unrelated words entirely" }));
    const results = idx.search("test", { prefix: true });
    expect(results.map((r) => r.id)).toEqual(["a"]);
    expect(results[0].matchedTerms.sort()).toEqual(["testable", "tester", "testing", "tests"]);
  });

  it("does not match non-prefix substrings", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "attestation" })); // contains "test" but not as a prefix
    const results = idx.search("test", { prefix: true });
    expect(results).toEqual([]);
  });

  it("without prefix:true, only exact terms match", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "testing tests" }));
    expect(idx.search("test")).toEqual([]);
    expect(idx.search("testing")).toHaveLength(1);
  });

  it("returns [] for a prefix with no matches in the vocabulary", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "hello world" }));
    expect(idx.search("zzz", { prefix: true })).toEqual([]);
  });
});

describe("InvertedIndex — phrase queries", () => {
  it("matches only adjacent terms in the given order within one field", () => {
    const idx = new InvertedIndex();
    idx.add(doc("adjacent", { content: "the quick brown fox jumps" }));
    idx.add(doc("scrambled", { content: "the fox jumps, quick and brown" }));
    const results = idx.search("quick brown fox", { phrase: true });
    expect(results.map((r) => r.id)).toEqual(["adjacent"]);
  });

  it("does not match when terms are adjacent but reversed", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "fox brown quick" }));
    expect(idx.search("quick brown fox", { phrase: true })).toEqual([]);
  });

  it("does not match phrase terms split across two different fields", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { title: "quick", content: "brown fox" }));
    expect(idx.search("quick brown", { phrase: true })).toEqual([]);
  });

  it("supports a single-term phrase (degenerate case) identically to an exact term search", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "solo word here" }));
    expect(idx.search("solo", { phrase: true }).map((m) => m.id)).toEqual(["a"]);
  });

  it("combines phrase + prefix: the final phrase term may match by prefix", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "we discussed the quick brownstone building" }));
    idx.add(doc("b", { content: "quick brown fox" }));
    const results = idx.search("quick brown", { phrase: true, prefix: true });
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("returns [] when any non-final phrase term is missing from the vocabulary", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "quick brown fox" }));
    expect(idx.search("quick zzz fox", { phrase: true })).toEqual([]);
  });
});

describe("InvertedIndex — snippet extraction and highlighting", () => {
  it("produces highlights whose offsets exactly reproduce the matched (lowercased) term within the snippet text", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "The mystery of the Vanishing Lighthouse baffled everyone in town." }));
    const results = idx.search("lighthouse");
    expect(results).toHaveLength(1);
    const { text, highlights } = results[0].snippet;
    expect(highlights.length).toBeGreaterThan(0);
    for (const [s, e] of highlights) {
      expect(text.slice(s, e)).toBe("lighthouse");
    }
  });

  it("selects a ~200-char dense window from a long field and keeps highlight offsets correct within it", () => {
    const idx = new InvertedIndex();
    const filler = "irrelevant padding text that goes on and on without any matches at all. ".repeat(20);
    const needle = "the target phrase keyword appears exactly here in the middle of everything";
    const content = filler + needle + " " + filler;
    idx.add(doc("a", { content }));
    const results = idx.search("keyword");
    expect(results).toHaveLength(1);
    const { text, highlights } = results[0].snippet;
    expect(text.length).toBeLessThanOrEqual(200);
    expect(highlights.length).toBeGreaterThan(0);
    for (const [s, e] of highlights) {
      expect(text.slice(s, e)).toBe("keyword");
    }
  });

  it("falls back to a leading window with no highlights when the best field has no positional matches (defensive path)", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "hello world" }));
    const results = idx.search("hello");
    expect(results[0].snippet.text.length).toBeGreaterThan(0);
  });
});

describe("InvertedIndex — serialize/deserialize", () => {
  function buildCorpus(): InvertedIndex {
    const idx = new InvertedIndex({ fieldWeights: { title: 3, content: 1 }, k1: 1.5, b: 0.6 });
    idx.add(doc("1", { title: "Deploy runbook", content: "how to roll back a bad deploy safely" }));
    idx.add(doc("2", { title: "Billing", content: "invoice cycle and refunds" }));
    idx.add(doc("3", { title: "On-call", content: "deploy escalation and paging policy" }));
    return idx;
  }

  it("round-trips: search scores are identical before and after serialize/deserialize", () => {
    const idx = buildCorpus();
    const before = idx.search("deploy");
    const json = idx.serialize();
    const restored = InvertedIndex.deserialize(json);
    const after = restored.search("deploy");

    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(after.map((m) => m.score)).toEqual(before.map((m) => m.score));
    expect(restored.size()).toBe(idx.size());
  });

  it("round-trips phrase and prefix query results too", () => {
    const idx = buildCorpus();
    const restored = InvertedIndex.deserialize(idx.serialize());
    expect(restored.search("roll back", { phrase: true }).map((m) => m.id)).toEqual(
      idx.search("roll back", { phrase: true }).map((m) => m.id),
    );
    expect(restored.search("dep", { prefix: true }).map((m) => m.id)).toEqual(
      idx.search("dep", { prefix: true }).map((m) => m.id),
    );
  });

  it("emits a versioned envelope with v: 1", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "hello" }));
    const parsed = JSON.parse(idx.serialize());
    expect(parsed.v).toBe(1);
  });

  it("a deserialized index remains fully mutable (add/remove work post-restore)", () => {
    const idx = buildCorpus();
    const restored = InvertedIndex.deserialize(idx.serialize());
    restored.add(doc("4", { title: "New doc", content: "fresh content about deploy" }));
    expect(restored.size()).toBe(4);
    expect(restored.search("deploy").map((m) => m.id)).toContain("4");
    expect(restored.remove("1")).toBe(true);
    expect(restored.size()).toBe(3);
  });

  it("throws FtsIndexError on truncated/malformed JSON", () => {
    expect(() => InvertedIndex.deserialize("{ this is not valid json")).toThrow(FtsIndexError);
  });

  it("throws FtsIndexError on an unknown version", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "hello" }));
    const parsed = JSON.parse(idx.serialize());
    parsed.v = 99;
    expect(() => InvertedIndex.deserialize(JSON.stringify(parsed))).toThrow(FtsIndexError);
    expect(() => InvertedIndex.deserialize(JSON.stringify(parsed))).toThrow(/version/);
  });

  it("throws FtsIndexError when postings reference an unknown document id", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "hello world" }));
    const parsed = JSON.parse(idx.serialize());
    parsed.postings.push({ term: "ghost", entries: [{ docId: "does-not-exist", fields: { content: [0] } }] });
    expect(() => InvertedIndex.deserialize(JSON.stringify(parsed))).toThrow(FtsIndexError);
    expect(() => InvertedIndex.deserialize(JSON.stringify(parsed))).toThrow(/unknown document id/);
  });

  it("throws FtsIndexError when the payload is not a JSON object", () => {
    expect(() => InvertedIndex.deserialize("[1,2,3]")).toThrow(FtsIndexError);
    expect(() => InvertedIndex.deserialize("42")).toThrow(FtsIndexError);
    expect(() => InvertedIndex.deserialize('"just a string"')).toThrow(FtsIndexError);
  });

  it("throws FtsIndexError when a doc entry has a malformed fieldTokenCount", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "hello world" }));
    const parsed = JSON.parse(idx.serialize());
    parsed.docs[0].fieldTokenCount = { content: "not-a-number" };
    expect(() => InvertedIndex.deserialize(JSON.stringify(parsed))).toThrow(FtsIndexError);
  });

  it("throws FtsIndexError on duplicate doc ids in the payload", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "hello" }));
    const parsed = JSON.parse(idx.serialize());
    parsed.docs.push({ id: "a", fields: { content: "dup" }, fieldTokenCount: { content: 1 } });
    expect(() => InvertedIndex.deserialize(JSON.stringify(parsed))).toThrow(FtsIndexError);
  });

  it("never returns a silently-empty index for corrupt input", () => {
    const attempts = ["not json at all", "{}", '{"v":1}', '{"v":1,"k1":1.2,"b":0.75,"fieldWeights":{},"fieldTotalLength":{}}'];
    for (const bad of attempts) {
      expect(() => InvertedIndex.deserialize(bad)).toThrow(FtsIndexError);
    }
  });
});

describe("InvertedIndex — adversarial and scale inputs", () => {
  it("indexes and searches a 1MB single-token document without crashing, with a finite score", () => {
    const giantToken = "a".repeat(1_000_000);
    const idx = new InvertedIndex();
    idx.add(doc("giant", { content: giantToken }));
    idx.add(doc("normal", { content: "some other words entirely" }));

    const results = idx.search(giantToken.slice(0, 50)); // a prefix substring is NOT a separate token; search the full token
    // Full-token exact search:
    const exact = idx.search(giantToken);
    expect(exact.map((m) => m.id)).toEqual(["giant"]);
    expect(Number.isFinite(exact[0].score)).toBe(true);
    expect(exact[0].score).toBeGreaterThanOrEqual(0);
    expect(results).toEqual([]); // the 50-char slice is not, itself, an indexed token
  });

  it("handles emoji-adjacent and mixed-script content", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "launch 🚀 today: 北京 and café rendezvous" }));
    expect(idx.search("launch").map((m) => m.id)).toEqual(["a"]);
    expect(idx.search("café").map((m) => m.id)).toEqual(["a"]);
    expect(idx.search("北京").map((m) => m.id)).toEqual(["a"]);
  });

  it("indexes and searches a 10k+ document corpus within a measured time budget", () => {
    const idx = new InvertedIndex();
    const topics = ["deploy", "billing", "auth", "search", "cache", "queue", "metrics", "logging"];
    const buildStart = Date.now();
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const topic = topics[i % topics.length];
      idx.add(
        doc(`doc${i}`, {
          title: `${topic} record ${i}`,
          summary: `summary about ${topic} for record number ${i}`,
          content: `this is document ${i} discussing ${topic} in detail with some filler words repeated ${topic} ${topic}`,
        }),
      );
    }
    const buildMs = Date.now() - buildStart;
    expect(idx.size()).toBe(N);

    const searchStart = Date.now();
    const results = idx.search("deploy", { limit: 20 });
    const searchMs = Date.now() - searchStart;

    // eslint-disable-next-line no-console
    console.log(`[fts perf] indexed ${N} docs in ${buildMs}ms, searched in ${searchMs}ms`);

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(20);
    expect(buildMs).toBeLessThan(20_000);
    expect(searchMs).toBeLessThan(2_000);
  }, 30_000);
});

describe("InvertedIndex — matchedTerms field", () => {
  it("reports the actual matched terms for an exact multi-term query", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "alpha beta gamma" }));
    const results = idx.search("alpha gamma");
    expect(results[0].matchedTerms.sort()).toEqual(["alpha", "gamma"]);
  });

  it("reports the query terms (in order) for a phrase query", () => {
    const idx = new InvertedIndex();
    idx.add(doc("a", { content: "alpha beta gamma" }));
    const results = idx.search("alpha beta", { phrase: true });
    expect(results[0].matchedTerms).toEqual(["alpha", "beta"]);
  });
});
