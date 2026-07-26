/**
 * Tests for SemanticMemoryAdapter
 *
 * Uses MockEmbeddingService (deterministic, hash-based vectors) — no API key needed.
 *
 * Key insight about the mock: identical text → identical hash → cosine similarity 1.0.
 * Different text → different hash → vectors are pseudo-random and dissimilar.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SemanticMemoryAdapter, createSemanticMemory } from "../memory/semantic";
import type { SemanticMemoryConfig } from "../memory/semantic";
import type { MemoryAdapter } from "../memory/types";
import { createEmbeddingService } from "../embeddings/service";
import { VectorStore } from "../memory/vector-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fresh adapter backed by the mock embedding service. */
function makeMockAdapter(config?: Partial<SemanticMemoryConfig>): SemanticMemoryAdapter {
  return createSemanticMemory({
    dimensions: 384,
    ...config,
  });
}

// ---------------------------------------------------------------------------
// 1. Store + retrieve: exact-text query returns the stored memory
// ---------------------------------------------------------------------------

describe("store + retrieve", () => {
  it("retrieves a memory whose content matches the query exactly", async () => {
    const adapter = makeMockAdapter();
    await adapter.store("user:alice", "The quick brown fox");
    await adapter.store("user:alice", "Some unrelated noise entry one");
    await adapter.store("user:alice", "Some unrelated noise entry two");

    const results = await adapter.retrieve("user:alice", "The quick brown fox");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe("The quick brown fox");
  });

  it("result entries have the correct key", async () => {
    const adapter = makeMockAdapter();
    await adapter.store("user:bob", "Hello world memory");

    const results = await adapter.retrieve("user:bob", "Hello world memory");
    expect(results.every((r) => r.key === "user:bob")).toBe(true);
  });

  it("result entries include a numeric score between 0 and ~1 (cosine similarity)", async () => {
    const adapter = makeMockAdapter();
    await adapter.store("user:bob", "Score check memory");

    const results = await adapter.retrieve("user:bob", "Score check memory");
    expect(results.length).toBeGreaterThan(0);
    const score = results[0].score ?? 0;
    expect(score).toBeGreaterThanOrEqual(0);
    // Allow tiny floating-point overshoot from cosine calculation (e.g. 1.0000000000000002)
    expect(score).toBeLessThanOrEqual(1.01);
  });
});

// ---------------------------------------------------------------------------
// 2. userId (key) filtering: memories from different keys don't leak
// ---------------------------------------------------------------------------

describe("key filtering", () => {
  it("only returns memories for the requested key", async () => {
    const adapter = makeMockAdapter();
    await adapter.store("user:alice", "Alice's secret memory");
    await adapter.store("user:bob", "Bob's own memory");

    const aliceResults = await adapter.retrieve("user:alice", "Alice's secret memory");
    expect(aliceResults.every((r) => r.key === "user:alice")).toBe(true);
  });

  it("does not return another user's memories when querying", async () => {
    const adapter = makeMockAdapter();
    await adapter.store("user:alice", "Alice unique phrase xyzzy");
    await adapter.store("user:bob", "Bob unique phrase xyzzy");

    const aliceResults = await adapter.retrieve("user:alice", "Alice unique phrase xyzzy");
    const ids = aliceResults.map((r) => r.key);
    expect(ids).not.toContain("user:bob");
  });
});

// ---------------------------------------------------------------------------
// 3. topK: exact number of results returned
// ---------------------------------------------------------------------------

describe("topK", () => {
  it("returns at most topK results", async () => {
    const adapter = makeMockAdapter({ topK: 3 });
    for (let i = 0; i < 10; i++) {
      await adapter.store("user:alice", `Memory number ${i} with unique content ${Math.random()}`);
    }
    const results = await adapter.retrieve("user:alice", "Memory number 0 with unique content");
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("respects topK passed at retrieve time over the default", async () => {
    const adapter = makeMockAdapter(); // default topK=5
    for (let i = 0; i < 10; i++) {
      await adapter.store("user:alice", `Entry ${i} alpha content testing`);
    }
    const results = await adapter.retrieve("user:alice", "Entry 0 alpha content testing", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 4. deleteById: deleted memory no longer appears in results
// ---------------------------------------------------------------------------

describe("deleteById", () => {
  it("removes the entry from retrieve results", async () => {
    const adapter = makeMockAdapter();
    const entry = await adapter.store("user:alice", "Delete me memory content");

    adapter.deleteById(entry.id);

    const results = await adapter.retrieve("user:alice", "Delete me memory content");
    expect(results.find((r) => r.id === entry.id)).toBeUndefined();
  });

  it("returns true when the entry existed", async () => {
    const adapter = makeMockAdapter();
    const entry = await adapter.store("user:alice", "Entry to delete");
    expect(adapter.deleteById(entry.id)).toBe(true);
  });

  it("returns false when the entry did not exist", async () => {
    const adapter = makeMockAdapter();
    expect(adapter.deleteById("non-existent-id")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. deleteAll: clear one key, other key's memories survive
// ---------------------------------------------------------------------------

describe("deleteAll (clear by key)", () => {
  it("removes all entries for a given key", async () => {
    const adapter = makeMockAdapter();
    await adapter.store("user:alice", "Alice memory A");
    await adapter.store("user:alice", "Alice memory B");
    await adapter.store("user:bob", "Bob memory stays");

    await adapter.deleteAll("user:alice");

    const aliceResults = await adapter.retrieve("user:alice", "Alice memory A");
    expect(aliceResults.length).toBe(0);
  });

  it("preserves other keys' memories after deleteAll", async () => {
    const adapter = makeMockAdapter();
    await adapter.store("user:alice", "Alice memory X");
    await adapter.store("user:bob", "Bob memory stays here");

    await adapter.deleteAll("user:alice");

    const bobResults = await adapter.retrieve("user:bob", "Bob memory stays here");
    expect(bobResults.length).toBeGreaterThan(0);
    expect(bobResults[0].content).toBe("Bob memory stays here");
  });
});

// ---------------------------------------------------------------------------
// 6. clearAll: no results after clearing everything
// ---------------------------------------------------------------------------

describe("clearAll", () => {
  it("leaves the store empty for all keys", async () => {
    const adapter = makeMockAdapter();
    await adapter.store("user:alice", "Alice clearAll test");
    await adapter.store("user:bob", "Bob clearAll test");

    adapter.clearAll();

    const aliceResults = await adapter.retrieve("user:alice", "Alice clearAll test");
    const bobResults = await adapter.retrieve("user:bob", "Bob clearAll test");
    expect(aliceResults.length).toBe(0);
    expect(bobResults.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. minScore filtering: high minScore with dissimilar query → empty results
// ---------------------------------------------------------------------------

describe("minScore filtering", () => {
  it("returns empty when minScore is very high and query does not match stored text", async () => {
    // minScore=0.99 means only near-identical vectors pass
    // The mock generates different pseudo-random vectors for different text, so
    // a different query string will be well below 0.99 similarity.
    const adapter = makeMockAdapter({ minScore: 0.99 });
    await adapter.store("user:alice", "purple elephant dances at midnight festival");

    // Completely different text → very different hash → cosine similarity << 0.99
    const results = await adapter.retrieve("user:alice", "quantum computing blockchain NFT");
    expect(results.length).toBe(0);
  });

  it("returns results when query text matches stored text exactly (similarity=1.0)", async () => {
    const adapter = makeMockAdapter({ minScore: 0.99 });
    await adapter.store("user:alice", "exact match text phrase");

    const results = await adapter.retrieve("user:alice", "exact match text phrase");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThanOrEqual(0.99);
  });
});

// ---------------------------------------------------------------------------
// 8. Upsert semantics: storing the same content twice doesn't duplicate
// ---------------------------------------------------------------------------

describe("store (upsert semantics via id)", () => {
  it("each store call generates a unique entry (different id, same content possible)", async () => {
    const adapter = makeMockAdapter();
    const e1 = await adapter.store("user:alice", "Duplicate content");
    const e2 = await adapter.store("user:alice", "Duplicate content");

    // Both entries exist; they have different ids
    expect(e1.id).not.toBe(e2.id);
  });

  it("list reflects both entries after two stores with the same content", async () => {
    const adapter = makeMockAdapter();
    await adapter.store("user:alice", "Same text stored twice");
    await adapter.store("user:alice", "Same text stored twice");

    const listed = await adapter.list("user:alice");
    expect(listed.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 9. Empty store: retrieve returns []
// ---------------------------------------------------------------------------

describe("empty store", () => {
  it("returns [] when no memories have been stored", async () => {
    const adapter = makeMockAdapter();
    const results = await adapter.retrieve("user:alice", "anything");
    expect(results).toEqual([]);
  });

  it("returns [] for an unknown key even when other keys have entries", async () => {
    const adapter = makeMockAdapter();
    await adapter.store("user:bob", "Bob's only memory");

    const results = await adapter.retrieve("user:alice", "Bob's only memory");
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. createSemanticMemory factory: works with no config
// ---------------------------------------------------------------------------

describe("createSemanticMemory factory", () => {
  it("creates an adapter without any config (uses mock embeddings)", async () => {
    const adapter = createSemanticMemory();
    expect(adapter).toBeInstanceOf(SemanticMemoryAdapter);
  });

  it("factory-created adapter can store and retrieve", async () => {
    const adapter = createSemanticMemory();
    await adapter.store("user:test", "factory test memory content");
    const results = await adapter.retrieve("user:test", "factory test memory content");
    expect(results.length).toBeGreaterThan(0);
  });

  it("factory respects topK config", async () => {
    const adapter = createSemanticMemory({ topK: 2 });
    for (let i = 0; i < 8; i++) {
      await adapter.store("user:test", `Factory topK entry ${i} unique content here`);
    }
    const results = await adapter.retrieve("user:test", "Factory topK entry 0 unique content here");
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 11. MemoryAdapter compatibility: TypeScript structural type check
// ---------------------------------------------------------------------------

describe("MemoryAdapter interface compatibility", () => {
  it("SemanticMemoryAdapter satisfies the MemoryAdapter interface (structural)", () => {
    // TypeScript assignment — this will be a compile error if the interface
    // is not satisfied, caught by `tsc --noEmit`.
    const adapter: MemoryAdapter = createSemanticMemory();
    expect(typeof adapter.store).toBe("function");
    expect(typeof adapter.retrieve).toBe("function");
    expect(typeof adapter.deleteAll).toBe("function");
    expect(typeof adapter.list).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 12. list: recency ordering and limit
// ---------------------------------------------------------------------------

describe("list", () => {
  it("returns entries in newest-first order", async () => {
    const adapter = makeMockAdapter();
    const e1 = await adapter.store("user:alice", "First entry older");
    // small delay so createdAt differs
    await new Promise((r) => setTimeout(r, 5));
    const e2 = await adapter.store("user:alice", "Second entry newer");

    const listed = await adapter.list("user:alice");
    expect(listed[0].id).toBe(e2.id);
    expect(listed[1].id).toBe(e1.id);
  });

  it("respects the limit parameter", async () => {
    const adapter = makeMockAdapter();
    for (let i = 0; i < 10; i++) {
      await adapter.store("user:alice", `List entry ${i}`);
    }
    const listed = await adapter.list("user:alice", 3);
    expect(listed.length).toBe(3);
  });

  it("returns [] for a key with no entries", async () => {
    const adapter = makeMockAdapter();
    const listed = await adapter.list("user:nobody");
    expect(listed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 13. Custom EmbeddingService passed via config
// ---------------------------------------------------------------------------

describe("custom embedding service", () => {
  it("uses the provided embedding service instead of mock", async () => {
    const customEmbeddings = createEmbeddingService({ provider: "mock", mock: { seed: 42, dimensions: 128 } });
    const adapter = createSemanticMemory({ embeddings: customEmbeddings, dimensions: 128 });
    await adapter.store("user:x", "custom embedding service test");
    const results = await adapter.retrieve("user:x", "custom embedding service test");
    expect(results.length).toBeGreaterThan(0);
  });
});
