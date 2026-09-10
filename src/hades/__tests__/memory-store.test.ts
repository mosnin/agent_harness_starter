import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { InMemoryMemoryStore, FileMemoryStore, scoreMemory, tokenize } from "../memory/store";
import type { MemoryRecord } from "../memory/store";

function rec(partial: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "x", fact: "", salience: 0.5, tags: [], createdAt: 0, accessCount: 0, ...partial,
  };
}

describe("scoreMemory", () => {
  it("rewards lexical overlap, salience, and recency", () => {
    const now = 1_000_000_000;
    const relevant = rec({ fact: "the user prefers dark mode", salience: 0.9, createdAt: now });
    const irrelevant = rec({ fact: "the weather is nice", salience: 0.9, createdAt: now });
    const q = tokenize("dark mode preference");
    expect(scoreMemory(relevant, q, now)).toBeGreaterThan(scoreMemory(irrelevant, q, now));
  });

  it("decays with age", () => {
    const now = 1_000_000_000;
    const fresh = rec({ fact: "likes tea", createdAt: now });
    const old = rec({ fact: "likes tea", createdAt: now - 60 * 24 * 3600 * 1000 });
    const q = tokenize("tea");
    expect(scoreMemory(fresh, q, now)).toBeGreaterThan(scoreMemory(old, q, now));
  });
});

describe("InMemoryMemoryStore", () => {
  it("adds and retrieves the most relevant memories first", () => {
    const store = new InMemoryMemoryStore();
    store.add({ fact: "user is based in Berlin", tags: ["profile"], salience: 0.8 });
    store.add({ fact: "user prefers TypeScript over Python", tags: ["profile"], salience: 0.9 });
    store.add({ fact: "the sky is blue", salience: 0.3 });

    const results = store.search("what language does the user like");
    expect(results[0].fact).toContain("TypeScript");
    expect(results.every((r) => r.score > 0)).toBe(true);
  });

  it("filters by tag and records access on retrieval", () => {
    const store = new InMemoryMemoryStore();
    const m = store.add({ fact: "deploys on Fridays", tags: ["ops"], salience: 0.6 });
    store.add({ fact: "unrelated", tags: ["misc"] });
    const results = store.search("deploy", { tag: "ops" });
    expect(results).toHaveLength(1);
    expect(store.get(m.id)?.accessCount).toBe(1);
  });

  it("forgets memories", () => {
    const store = new InMemoryMemoryStore();
    const m = store.add({ fact: "temporary" });
    expect(store.forget(m.id)).toBe(true);
    expect(store.size()).toBe(0);
  });
});

describe("FileMemoryStore", () => {
  it("persists across instances (atomic file)", () => {
    const path = join(tmpdir(), `hades-mem-${process.pid}-${Math.floor(performance.now())}.json`);
    try {
      const a = new FileMemoryStore(path);
      a.add({ fact: "user's name is Sam", salience: 0.95, tags: ["profile"] });
      const b = new FileMemoryStore(path); // reload from disk
      expect(b.size()).toBe(1);
      expect(b.search("name")[0].fact).toContain("Sam");
    } finally {
      rmSync(path, { force: true });
    }
  });
});
