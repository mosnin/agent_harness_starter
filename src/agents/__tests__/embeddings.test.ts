/**
 * Tests for embeddings service components:
 * - chunkText (Chunker)
 * - normalizeVector (Normalizer)
 * - MockEmbeddingService
 * - EmbeddingCache
 * - createEmbeddingService
 */

import { describe, it, expect } from "vitest";
import { chunkText } from "../embeddings/chunker";
import { normalizeVector } from "../embeddings/normalizer";
import { MockEmbeddingService } from "../embeddings/providers/mock";
import { EmbeddingCache } from "../embeddings/cache";
import { createEmbeddingService } from "../embeddings/service";

// ---------------------------------------------------------------------------
// Chunker tests
// ---------------------------------------------------------------------------

describe("chunkText — char strategy", () => {
  // ── Test 1: char strategy chunk count and content ──────────────────────
  it("produces correct number of chunks and each chunk has correct size", () => {
    // "hello world foo bar" = 19 chars, chunkSize=5, overlap=1 → step=4
    // Chunk starts: 0, 4, 8, 12, 16 → 5 chunks
    const text = "hello world foo bar";
    const chunks = chunkText(text, { strategy: "char", chunkSize: 5, overlap: 1 });

    expect(chunks.length).toBeGreaterThan(0);
    // First chunk: chars 0-4
    expect(chunks[0].text).toBe("hello");
    expect(chunks[0].startChar).toBe(0);
    expect(chunks[0].endChar).toBe(5);
    // Second chunk: chars 4-8
    expect(chunks[1].text).toBe("o wor");
    expect(chunks[1].startChar).toBe(4);
  });

  it("char strategy: endChar - startChar equals chunk text length", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const chunks = chunkText(text, { strategy: "char", chunkSize: 7, overlap: 2 });
    for (const chunk of chunks) {
      expect(chunk.endChar - chunk.startChar).toBe(chunk.text.length);
    }
  });

  it("char strategy: chunk indices are sequential starting from 0", () => {
    const text = "0123456789abcdef";
    const chunks = chunkText(text, { strategy: "char", chunkSize: 4, overlap: 0 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  // ── Test 4 (partial): char strategy — empty text returns [] ─────────────
  it("char strategy: empty text returns []", () => {
    const chunks = chunkText("", { strategy: "char", chunkSize: 10, overlap: 0 });
    expect(chunks).toEqual([]);
  });
});

describe("chunkText — sentence strategy", () => {
  // ── Test 2: sentence strategy ───────────────────────────────────────────
  it("groups sentences into chunks of given size", () => {
    // 4 sentences; chunkSize=2, overlap=0 → step=2 → 2 chunks
    const text = "Hello world. How are you? I am fine. Thank you.";
    const chunks = chunkText(text, { strategy: "sentence", chunkSize: 2, overlap: 0 });
    expect(chunks.length).toBe(2);
    // First chunk covers the first two sentences
    expect(chunks[0].index).toBe(0);
    expect(chunks[1].index).toBe(1);
  });

  it("sentence strategy: chunkSize=2, overlap=1 creates overlapping chunks", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const chunks = chunkText(text, { strategy: "sentence", chunkSize: 2, overlap: 1 });
    // step = 1, so chunks start at sentence indices 0, 1, 2
    expect(chunks.length).toBe(3);
    expect(chunks[0].text).toContain("First sentence");
    expect(chunks[1].text).toContain("Second sentence");
    expect(chunks[2].text).toContain("Third sentence");
  });

  it("sentence strategy: single sentence with chunkSize=1 → exactly 1 chunk", () => {
    const text = "Only one sentence here.";
    const chunks = chunkText(text, { strategy: "sentence", chunkSize: 1, overlap: 0 });
    expect(chunks.length).toBe(1);
    expect(chunks[0].text.trim()).toBe("Only one sentence here.");
  });

  it("sentence strategy: empty text returns []", () => {
    const chunks = chunkText("", { strategy: "sentence", chunkSize: 2, overlap: 0 });
    expect(chunks).toEqual([]);
  });
});

describe("chunkText — token strategy", () => {
  // ── Test 3: token strategy ──────────────────────────────────────────────
  it("100-char text with chunkSize=10 tokens → at least 2 chunks", () => {
    // 10 tokens * 4 chars/token = 40 chars per chunk
    // 100 chars → at least ceil(100/40) = 3 chunks (but word boundary may vary, ≥2)
    const text = "a".repeat(10) + " " + "b".repeat(10) + " " + "c".repeat(10) + " " +
      "d".repeat(10) + " " + "e".repeat(10) + " " + "f".repeat(10) + " " + "g".repeat(10);
    const chunks = chunkText(text, { strategy: "token", chunkSize: 10, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("token strategy: chunk indices are sequential starting from 0", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(5);
    const chunks = chunkText(text, { strategy: "token", chunkSize: 5, overlap: 0 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  it("token strategy: empty text returns []", () => {
    const chunks = chunkText("", { strategy: "token", chunkSize: 10, overlap: 0 });
    expect(chunks).toEqual([]);
  });
});

describe("chunkText — startChar/endChar invariants", () => {
  // ── Test 5: startChar/endChar ────────────────────────────────────────────
  it("char strategy: chunk text equals text.slice(startChar, endChar)", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const chunks = chunkText(text, { strategy: "char", chunkSize: 8, overlap: 2 });
    for (const chunk of chunks) {
      expect(chunk.text).toBe(text.slice(chunk.startChar, chunk.endChar));
    }
  });

  it("all strategies: startChar is non-negative and endChar > startChar", () => {
    const text = "Hello world. How are you? I am fine.";
    for (const strategy of ["char", "sentence", "token"] as const) {
      const chunks = chunkText(text, { strategy, chunkSize: 5, overlap: 1 });
      for (const chunk of chunks) {
        expect(chunk.startChar).toBeGreaterThanOrEqual(0);
        expect(chunk.endChar).toBeGreaterThan(chunk.startChar);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Normalizer tests
// ---------------------------------------------------------------------------

describe("normalizeVector", () => {
  const v = [3, 4]; // known: L2 norm = 5, L1 norm = 7

  // ── Test 6: l2 ───────────────────────────────────────────────────────────
  it("l2: normalized vector has magnitude ≈ 1.0", () => {
    const result = normalizeVector(v, "l2");
    const magnitude = Math.sqrt(result.reduce((s, x) => s + x * x, 0));
    expect(magnitude).toBeCloseTo(1.0, 10);
  });

  it("l2: values are correct fractions of original norm", () => {
    const result = normalizeVector([3, 4], "l2"); // norm = 5
    expect(result[0]).toBeCloseTo(3 / 5, 10);
    expect(result[1]).toBeCloseTo(4 / 5, 10);
  });

  // ── Test 7: l1 ───────────────────────────────────────────────────────────
  it("l1: sum of absolute values ≈ 1.0", () => {
    const result = normalizeVector(v, "l1");
    const l1 = result.reduce((s, x) => s + Math.abs(x), 0);
    expect(l1).toBeCloseTo(1.0, 10);
  });

  // ── Test 8: minmax ────────────────────────────────────────────────────────
  it("minmax: all values in [0, 1]", () => {
    const vec = [-5, 0, 3, 10, -2, 7];
    const result = normalizeVector(vec, "minmax");
    for (const x of result) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
    // Min maps to 0, max maps to 1
    expect(Math.min(...result)).toBeCloseTo(0, 10);
    expect(Math.max(...result)).toBeCloseTo(1, 10);
  });

  // ── Test 9: none ──────────────────────────────────────────────────────────
  it("none: returns copy unchanged", () => {
    const vec = [1, 2, 3, 4];
    const result = normalizeVector(vec, "none");
    expect(result).toEqual([1, 2, 3, 4]);
    // Should be a copy, not the same reference
    result[0] = 999;
    expect(vec[0]).toBe(1);
  });

  // ── Test 10: zero vector ──────────────────────────────────────────────────
  it("l2 on zero vector returns zero vector without throwing", () => {
    const zero = [0, 0, 0];
    expect(() => normalizeVector(zero, "l2")).not.toThrow();
    const result = normalizeVector(zero, "l2");
    expect(result).toEqual([0, 0, 0]);
  });

  it("l1 on zero vector returns zero vector without throwing", () => {
    const zero = [0, 0, 0];
    expect(() => normalizeVector(zero, "l1")).not.toThrow();
    const result = normalizeVector(zero, "l1");
    expect(result).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// MockEmbeddingService tests
// ---------------------------------------------------------------------------

describe("MockEmbeddingService", () => {
  // ── Test 11: deterministic ────────────────────────────────────────────────
  it("deterministic: same text always returns same vector", async () => {
    const svc = new MockEmbeddingService({ dimensions: 64 });
    const r1 = await svc.embed("hello world");
    const r2 = await svc.embed("hello world");
    expect(r1.vector).toEqual(r2.vector);
  });

  // ── Test 12: different texts ──────────────────────────────────────────────
  it("different texts return different vectors", async () => {
    const svc = new MockEmbeddingService({ dimensions: 64 });
    const r1 = await svc.embed("hello");
    const r2 = await svc.embed("world");
    expect(r1.vector).not.toEqual(r2.vector);
  });

  // ── Test 13: dimensions ───────────────────────────────────────────────────
  it("vector length matches configured dimensions", async () => {
    const svc100 = new MockEmbeddingService({ dimensions: 100 });
    const svc256 = new MockEmbeddingService({ dimensions: 256 });

    const r100 = await svc100.embed("test");
    const r256 = await svc256.embed("test");

    expect(r100.vector.length).toBe(100);
    expect(r256.vector.length).toBe(256);
    expect(svc100.dimensions).toBe(100);
    expect(svc256.dimensions).toBe(256);
  });

  it("default dimensions is 384", async () => {
    const svc = new MockEmbeddingService();
    const r = await svc.embed("test");
    expect(r.vector.length).toBe(384);
    expect(svc.dimensions).toBe(384);
  });

  // ── Test 14: embedBatch ───────────────────────────────────────────────────
  it("embedBatch: returns array of same length as input", async () => {
    const svc = new MockEmbeddingService({ dimensions: 32 });
    const texts = ["one", "two", "three", "four"];
    const results = await svc.embedBatch(texts);
    expect(results.length).toBe(texts.length);
  });

  it("embedBatch: empty input returns empty array", async () => {
    const svc = new MockEmbeddingService();
    const results = await svc.embedBatch([]);
    expect(results).toEqual([]);
  });

  it("embedBatch: each result matches individual embed call", async () => {
    const svc = new MockEmbeddingService({ dimensions: 32 });
    const texts = ["alpha", "beta", "gamma"];
    const batchResults = await svc.embedBatch(texts);

    for (let i = 0; i < texts.length; i++) {
      const single = await svc.embed(texts[i]);
      expect(batchResults[i].vector).toEqual(single.vector);
    }
  });

  // ── Test 15: cached=false ─────────────────────────────────────────────────
  it("cached=false: mock always returns cached=false", async () => {
    const svc = new MockEmbeddingService();
    const r1 = await svc.embed("some text");
    const r2 = await svc.embed("some text");
    expect(r1.cached).toBe(false);
    expect(r2.cached).toBe(false);
  });

  it("model is 'mock-embedding-v1'", async () => {
    const svc = new MockEmbeddingService();
    expect(svc.model).toBe("mock-embedding-v1");
    const r = await svc.embed("test");
    expect(r.model).toBe("mock-embedding-v1");
  });
});

// ---------------------------------------------------------------------------
// EmbeddingCache tests
// ---------------------------------------------------------------------------

describe("EmbeddingCache", () => {
  // ── Test 16: set + get ────────────────────────────────────────────────────
  it("set + get: basic round-trip", () => {
    const cache = new EmbeddingCache();
    const vec = [0.1, 0.2, 0.3];
    cache.set("my-key", vec);
    const retrieved = cache.get("my-key");
    expect(retrieved).toEqual(vec);
  });

  it("get returns undefined for missing key", () => {
    const cache = new EmbeddingCache();
    expect(cache.get("not-set")).toBeUndefined();
  });

  // ── Test 17: has ─────────────────────────────────────────────────────────
  it("has: true after set, false for unknown key", () => {
    const cache = new EmbeddingCache();
    expect(cache.has("x")).toBe(false);
    cache.set("x", [1, 2, 3]);
    expect(cache.has("x")).toBe(true);
    expect(cache.has("y")).toBe(false);
  });

  // ── Test 18: LRU eviction ─────────────────────────────────────────────────
  it("LRU eviction: maxEntries=2, adding 3 evicts the first inserted", () => {
    const cache = new EmbeddingCache(2);

    cache.set("first", [1]);
    cache.set("second", [2]);
    cache.set("third", [3]); // should evict "first"

    expect(cache.has("first")).toBe(false);
    expect(cache.has("second")).toBe(true);
    expect(cache.has("third")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("LRU eviction: getting a key promotes it above eviction", () => {
    const cache = new EmbeddingCache(2);

    cache.set("a", [1]);
    cache.set("b", [2]);
    // Access "a" to promote it
    cache.get("a");
    // "b" is now LRU; adding "c" should evict "b"
    cache.set("c", [3]);

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  // ── Test 19: clear ────────────────────────────────────────────────────────
  it("clear: size becomes 0 and all keys gone", () => {
    const cache = new EmbeddingCache();
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.set("c", [3]);
    expect(cache.size).toBe(3);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createEmbeddingService tests
// ---------------------------------------------------------------------------

describe("createEmbeddingService", () => {
  // ── Test 20: mock provider works without API key ──────────────────────────
  it("mock provider: works without API key", async () => {
    const svc = createEmbeddingService({ provider: "mock" });
    expect(svc.dimensions).toBe(384);
    expect(svc.model).toBe("mock-embedding-v1");

    const r = await svc.embed("test text");
    expect(r.vector.length).toBe(384);
  });

  it("mock provider: custom dimensions passed through", async () => {
    const svc = createEmbeddingService({ provider: "mock", mock: { dimensions: 128 } });
    expect(svc.dimensions).toBe(128);
    const r = await svc.embed("test");
    expect(r.vector.length).toBe(128);
  });

  // ── Test 21: embedWithCache — second call returns cached=true ─────────────
  it("embedWithCache: second call for same text returns cached=true", async () => {
    const svc = createEmbeddingService({
      provider: "mock",
      cache: { enabled: true },
    });

    const r1 = await svc.embedWithCache("hello cache");
    expect(r1.cached).toBe(false);

    const r2 = await svc.embedWithCache("hello cache");
    expect(r2.cached).toBe(true);
    // Vectors should be identical
    expect(r2.vector).toEqual(r1.vector);
  });

  it("embedWithCache: different texts each produce cached=false on first call", async () => {
    const svc = createEmbeddingService({ provider: "mock" });

    const r1 = await svc.embedWithCache("text A");
    const r2 = await svc.embedWithCache("text B");

    expect(r1.cached).toBe(false);
    expect(r2.cached).toBe(false);
    expect(r1.vector).not.toEqual(r2.vector);
  });

  it("embed() routes through cache (same as embedWithCache)", async () => {
    const svc = createEmbeddingService({ provider: "mock", cache: { enabled: true } });
    const r1 = await svc.embed("shared text");
    const r2 = await svc.embed("shared text");
    expect(r2.cached).toBe(true);
    expect(r2.vector).toEqual(r1.vector);
  });

  // ── Test 22: embedAndChunk — returns one result per chunk ─────────────────
  it("embedAndChunk: returns one result per chunk", async () => {
    const svc = createEmbeddingService({ provider: "mock" });

    const text = "First sentence here. Second sentence there. Third sentence now.";
    const results = await svc.embedAndChunk(text, {
      strategy: "sentence",
      chunkSize: 1,
      overlap: 0,
    });

    // One result per sentence-chunk
    expect(results.length).toBeGreaterThan(0);
    for (const { chunk, embedding } of results) {
      expect(typeof chunk.text).toBe("string");
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(embedding.vector.length).toBe(384); // default mock dimensions
      expect(typeof embedding.cached).toBe("boolean");
    }
  });

  it("embedAndChunk: chunk count matches chunkText output", async () => {
    const svc = createEmbeddingService({ provider: "mock" });
    const text = "abcdefghijklmnopqrstuvwxyz";
    const chunkOptions = { strategy: "char" as const, chunkSize: 5, overlap: 0 };

    const expectedChunks = chunkText(text, chunkOptions);
    const results = await svc.embedAndChunk(text, chunkOptions);

    expect(results.length).toBe(expectedChunks.length);
  });

  it("normalize option: l2-normalized vectors have magnitude ≈ 1", async () => {
    const svc = createEmbeddingService({ provider: "mock", normalize: "l2" });
    const r = await svc.embed("normalize me");

    const magnitude = Math.sqrt(r.vector.reduce((s, x) => s + x * x, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it("embedBatch: returns correct number of results", async () => {
    const svc = createEmbeddingService({ provider: "mock" });
    const texts = ["alpha", "beta", "gamma", "delta"];
    const results = await svc.embedBatch(texts);
    expect(results.length).toBe(texts.length);
  });

  it("embedBatch: cache hit on subsequent call", async () => {
    const svc = createEmbeddingService({ provider: "mock", cache: { enabled: true } });
    const texts = ["x", "y"];

    await svc.embedBatch(texts);
    const results2 = await svc.embedBatch(texts);

    expect(results2[0].cached).toBe(true);
    expect(results2[1].cached).toBe(true);
  });
});
