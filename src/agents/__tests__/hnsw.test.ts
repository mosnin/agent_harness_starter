/**
 * Tests for HNSWIndex and VectorStore.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { HNSWIndex } from "../memory/hnsw";
import { VectorStore } from "../memory/vector-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randVec(dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    v[i] = Math.random() * 2 - 1;
  }
  return v;
}

/** Cosine similarity between two plain number arrays. */
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Euclidean distance between two plain number arrays. */
function euclidDist(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// ---------------------------------------------------------------------------
// HNSWIndex tests
// ---------------------------------------------------------------------------

describe("HNSWIndex", () => {
  const DIMS = 16;

  // ── Test 1: add + search basic ──────────────────────────────────────────
  it("add + search basic: exact match returns top result", () => {
    const idx = new HNSWIndex({ dimensions: DIMS, metric: "cosine" });
    const target = new Float32Array(DIMS).fill(0);
    target[0] = 1; // unit vector in dim 0

    idx.add("target", target, { label: "target" });
    for (let i = 1; i <= 4; i++) {
      idx.add(`other-${i}`, randVec(DIMS));
    }

    const results = idx.search(target, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("target");
    expect(results[0].score).toBeCloseTo(1.0, 4);
  });

  // ── Test 2: cosine metric ───────────────────────────────────────────────
  it("cosine metric: similar vectors score higher than random ones", () => {
    const idx = new HNSWIndex({ dimensions: DIMS, metric: "cosine" });

    // Create a "similar" vector (small perturbation)
    const base = new Float32Array(DIMS).fill(0.5);
    const similar = new Float32Array(base);
    similar[0] += 0.01;

    // Create an orthogonal vector
    const orthogonal = new Float32Array(DIMS).fill(0);
    orthogonal[0] = 0;
    orthogonal[1] = 1;

    idx.add("similar", similar);
    idx.add("orthogonal", orthogonal);

    const results = idx.search(base, 2);
    expect(results.length).toBe(2);

    const similarResult = results.find((r) => r.id === "similar");
    const orthogonalResult = results.find((r) => r.id === "orthogonal");
    expect(similarResult).toBeDefined();
    expect(orthogonalResult).toBeDefined();
    expect(similarResult!.score).toBeGreaterThan(orthogonalResult!.score);
  });

  // ── Test 3: euclidean metric ────────────────────────────────────────────
  it("euclidean metric: nearest by Euclidean distance returns correct result", () => {
    const idx = new HNSWIndex({ dimensions: DIMS, metric: "euclidean" });

    const query = new Float32Array(DIMS).fill(0);
    const near = new Float32Array(DIMS).fill(0);
    near[0] = 0.1; // very close

    const far = new Float32Array(DIMS).fill(10); // far away

    idx.add("near", near);
    idx.add("far", far);

    const results = idx.search(query, 2);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe("near");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  // ── Test 4: dot metric ──────────────────────────────────────────────────
  it("dot metric: highest dot-product vector ranks first", () => {
    const idx = new HNSWIndex({ dimensions: DIMS, metric: "dot" });

    const query = new Float32Array(DIMS).fill(1);

    // highDot: all 2s → dot product = DIMS * 2 = 32
    const highDot = new Float32Array(DIMS).fill(2);
    // lowDot: all 0.1s → dot product = DIMS * 0.1 = 1.6
    const lowDot = new Float32Array(DIMS).fill(0.1);

    idx.add("highDot", highDot);
    idx.add("lowDot", lowDot);

    const results = idx.search(query, 2);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe("highDot");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  // ── Test 5: k results ───────────────────────────────────────────────────
  it("search(query, 3) returns exactly 3 results", () => {
    const idx = new HNSWIndex({ dimensions: DIMS });
    for (let i = 0; i < 10; i++) {
      idx.add(`v${i}`, randVec(DIMS));
    }
    const results = idx.search(randVec(DIMS), 3);
    expect(results.length).toBe(3);
  });

  // ── Test 6: search empty index ──────────────────────────────────────────
  it("search on empty index returns [] without throwing", () => {
    const idx = new HNSWIndex({ dimensions: DIMS });
    expect(() => idx.search(randVec(DIMS), 5)).not.toThrow();
    const results = idx.search(randVec(DIMS), 5);
    expect(results).toEqual([]);
  });

  // ── Test 7: remove ──────────────────────────────────────────────────────
  it("remove: removed vector no longer appears in search results", () => {
    const idx = new HNSWIndex({ dimensions: DIMS, metric: "cosine" });

    // All identical vectors; middle one removed
    const v = new Float32Array(DIMS).fill(1);
    idx.add("a", v.slice());
    idx.add("b", v.slice()); // will be removed
    idx.add("c", v.slice());

    const removed = idx.remove("b");
    expect(removed).toBe(true);

    const results = idx.search(v, 10);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("b");
    expect(ids).toContain("a");
    expect(ids).toContain("c");
  });

  // ── Test 8: size property ───────────────────────────────────────────────
  it("size property reflects correct count after add/remove", () => {
    const idx = new HNSWIndex({ dimensions: DIMS });
    expect(idx.size).toBe(0);

    idx.add("x", randVec(DIMS));
    idx.add("y", randVec(DIMS));
    expect(idx.size).toBe(2);

    idx.remove("x");
    expect(idx.size).toBe(1);

    idx.remove("y");
    expect(idx.size).toBe(0);
  });

  // ── Test 9: duplicate id (upsert semantics) ─────────────────────────────
  it("duplicate id uses upsert semantics: size stays the same", () => {
    const idx = new HNSWIndex({ dimensions: DIMS });
    idx.add("dup", randVec(DIMS));
    idx.add("dup", randVec(DIMS)); // second insertion with same id
    expect(idx.size).toBe(1);
  });

  it("upserted vector replaces old vector", () => {
    const idx = new HNSWIndex({ dimensions: DIMS, metric: "cosine" });

    const v1 = new Float32Array(DIMS).fill(0);
    v1[0] = 1; // points in +x direction

    const v2 = new Float32Array(DIMS).fill(0);
    v2[1] = 1; // points in +y direction

    idx.add("node", v1);
    idx.add("node", v2); // upsert

    // Query along +y direction: updated node should score high
    const results = idx.search(v2, 1);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("node");
    expect(results[0].score).toBeCloseTo(1.0, 3);
  });

  // ── Test 10: serialize + deserialize ────────────────────────────────────
  it("serialize + deserialize preserves search results", () => {
    const idx = new HNSWIndex({ dimensions: DIMS, metric: "cosine" });

    const queryVec = new Float32Array(DIMS).fill(0);
    queryVec[0] = 1;

    idx.add("target", queryVec.slice(), { label: "original target" });
    for (let i = 0; i < 9; i++) {
      idx.add(`rand-${i}`, randVec(DIMS));
    }

    const serialized = idx.serialize();
    const restored = HNSWIndex.deserialize(serialized);

    expect(restored.size).toBe(10);

    const results = restored.search(queryVec, 1);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("target");
  });

  it("deserialize preserves metadata", () => {
    const idx = new HNSWIndex({ dimensions: DIMS });
    idx.add("meta-node", randVec(DIMS), { foo: "bar", count: 42 });

    const restored = HNSWIndex.deserialize(idx.serialize());
    const node = restored.get("meta-node");
    expect(node?.metadata).toEqual({ foo: "bar", count: 42 });
  });

  // ── Test 11: large insert ────────────────────────────────────────────────
  it("large insert: 100 random 32-dim vectors, top-1 result within top-3 of brute-force", () => {
    const LARGE_DIMS = 32;
    const idx = new HNSWIndex({ dimensions: LARGE_DIMS, metric: "cosine" });

    const vectors: Array<{ id: string; vec: Float32Array }> = [];
    for (let i = 0; i < 100; i++) {
      const vec = randVec(LARGE_DIMS);
      vectors.push({ id: `v${i}`, vec });
      idx.add(`v${i}`, vec);
    }

    const query = randVec(LARGE_DIMS);

    // Brute-force top-3 by cosine similarity
    const bruteForceSorted = vectors
      .map(({ id, vec }) => ({
        id,
        sim: cosineSim(Array.from(query), Array.from(vec)),
      }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3)
      .map((x) => x.id);

    const hnswTop1 = idx.search(query, 1)[0]?.id;
    expect(hnswTop1).toBeDefined();
    expect(bruteForceSorted).toContain(hnswTop1);
  });

  // ── Test 12: score range ─────────────────────────────────────────────────
  it("cosine scores are in [-1, 1] range; more similar vectors score higher", () => {
    const idx = new HNSWIndex({ dimensions: DIMS, metric: "cosine" });
    for (let i = 0; i < 10; i++) {
      idx.add(`v${i}`, randVec(DIMS));
    }

    const query = randVec(DIMS);
    const results = idx.search(query, 10);

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    }

    // Results should be in descending order of score
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  });

  it("euclidean score is positive (1/(1+dist)) and results are in descending order", () => {
    const idx = new HNSWIndex({ dimensions: DIMS, metric: "euclidean" });
    for (let i = 0; i < 8; i++) {
      idx.add(`v${i}`, randVec(DIMS));
    }

    const results = idx.search(randVec(DIMS), 5);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }

    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  });
});

// ---------------------------------------------------------------------------
// VectorStore tests
// ---------------------------------------------------------------------------

describe("VectorStore", () => {
  const DIMS = 8;

  function makeEntry(
    id: string,
    vec?: number[]
  ): Omit<import("../memory/vector-store").VectorEntry, "createdAt"> {
    return {
      id,
      text: `Text for ${id}`,
      vector: vec ?? Array.from(randVec(DIMS)),
    };
  }

  // ── Test 13: upsert + search basic round-trip ───────────────────────────
  it("upsert + search: basic round-trip returns the inserted entry", () => {
    const store = new VectorStore({ dimensions: DIMS });

    const targetVec = new Array(DIMS).fill(0);
    targetVec[0] = 1;

    store.upsert({ id: "doc1", text: "hello world", vector: targetVec });

    const results = store.search(targetVec, 1);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("doc1");
    expect(results[0].text).toBe("hello world");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("upsert + search: returns entry metadata", () => {
    const store = new VectorStore({ dimensions: DIMS });
    store.upsert({
      id: "meta1",
      text: "metadata test",
      vector: Array.from(randVec(DIMS)),
      metadata: { source: "test", page: 1 },
    });

    const results = store.search(Array.from(randVec(DIMS)), 1);
    // Since only one entry, it must be meta1
    expect(results[0].id).toBe("meta1");
    expect(results[0].metadata).toEqual({ source: "test", page: 1 });
  });

  // ── Test 14: LRU eviction ───────────────────────────────────────────────
  it("LRU eviction: maxEntries=3, inserting 4 evicts the oldest", () => {
    const store = new VectorStore({ dimensions: DIMS, maxEntries: 3 });

    store.upsert(makeEntry("old"));   // inserted first — will be evicted
    store.upsert(makeEntry("b"));
    store.upsert(makeEntry("c"));
    store.upsert(makeEntry("new"));   // inserting 4th triggers eviction of "old"

    expect(store.size).toBe(3);
    expect(store.get("old")).toBeUndefined();
    expect(store.get("b")).toBeDefined();
    expect(store.get("c")).toBeDefined();
    expect(store.get("new")).toBeDefined();
  });

  it("LRU eviction: re-upserting an existing entry refreshes its position", () => {
    const store = new VectorStore({ dimensions: DIMS, maxEntries: 3 });

    store.upsert(makeEntry("first"));
    store.upsert(makeEntry("second"));
    store.upsert(makeEntry("third"));

    // Re-upsert "first" — it should now be most recently used
    store.upsert(makeEntry("first"));
    // Adding a 4th entry should evict "second" (now oldest), not "first"
    store.upsert(makeEntry("fourth"));

    expect(store.size).toBe(3);
    expect(store.get("first")).toBeDefined();
    expect(store.get("second")).toBeUndefined();
  });

  // ── Test 15: TTL eviction ───────────────────────────────────────────────
  it("TTL eviction: expired entry removed by evictExpired()", async () => {
    const store = new VectorStore({ dimensions: DIMS, ttlMs: 1 });

    store.upsert(makeEntry("expiring"));
    expect(store.size).toBe(1);

    await new Promise((r) => setTimeout(r, 5));

    const evicted = store.evictExpired();
    expect(evicted).toBe(1);
    expect(store.size).toBe(0);
  });

  it("TTL eviction: non-expired entries survive evictExpired()", async () => {
    // Long TTL — entries won't expire
    const store = new VectorStore({ dimensions: DIMS, ttlMs: 60_000 });

    store.upsert(makeEntry("keeper"));
    expect(store.size).toBe(1);

    await new Promise((r) => setTimeout(r, 5));

    const evicted = store.evictExpired();
    expect(evicted).toBe(0);
    expect(store.size).toBe(1);
  });

  it("TTL eviction: get() lazily evicts expired entry", async () => {
    const store = new VectorStore({ dimensions: DIMS, ttlMs: 1 });

    store.upsert(makeEntry("lazy-expire"));

    await new Promise((r) => setTimeout(r, 5));

    const entry = store.get("lazy-expire");
    expect(entry).toBeUndefined();
    expect(store.size).toBe(0);
  });

  // ── Test 16: delete ─────────────────────────────────────────────────────
  it("delete: removed entry no longer returned from get() or search()", () => {
    const store = new VectorStore({ dimensions: DIMS });

    const v = new Array(DIMS).fill(0);
    v[0] = 1;
    store.upsert({ id: "deleteme", text: "to be deleted", vector: v });

    const deleted = store.delete("deleteme");
    expect(deleted).toBe(true);

    expect(store.get("deleteme")).toBeUndefined();

    const results = store.search(v, 10);
    expect(results.map((r) => r.id)).not.toContain("deleteme");
  });

  it("delete returns false for non-existent id", () => {
    const store = new VectorStore({ dimensions: DIMS });
    expect(store.delete("nonexistent")).toBe(false);
  });

  // ── Test 17: size ────────────────────────────────────────────────────────
  it("size: correct after upsert, delete and clear", () => {
    const store = new VectorStore({ dimensions: DIMS });
    expect(store.size).toBe(0);

    store.upsert(makeEntry("a"));
    store.upsert(makeEntry("b"));
    store.upsert(makeEntry("c"));
    expect(store.size).toBe(3);

    store.delete("b");
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
  });

  it("search on empty VectorStore returns []", () => {
    const store = new VectorStore({ dimensions: DIMS });
    const results = store.search(Array.from(randVec(DIMS)), 5);
    expect(results).toEqual([]);
  });
});
