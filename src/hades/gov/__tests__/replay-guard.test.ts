/**
 * replay-guard.test.ts
 *
 * REAL-VS-MOCK POLICY: no mocks. `MemoryReplayGuard` is exercised directly;
 * `DurableReplayGuard` is exercised against REAL temp directories created
 * with `mkdtempSync` (never an in-memory fs double) so the atomic
 * write-tmp-then-rename path, JSON round-trip, and "closed and reopened
 * from disk" survival story are all proven against the real filesystem.
 * Every clock is an explicit `at`/`now` value passed by the test, never
 * `Date.now()`.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryReplayGuard, DurableReplayGuard } from "../replay-guard";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "gov-replay-guard-"));
}

describe("MemoryReplayGuard", () => {
  it("consume() returns true on first use, false on replay", () => {
    const g = new MemoryReplayGuard();
    expect(g.consume("n1", 100)).toBe(true);
    expect(g.consume("n1", 200)).toBe(false);
    expect(g.consume("n1", 9999)).toBe(false);
  });

  it("seen() is read-only and reflects consumption without mutating state", () => {
    const g = new MemoryReplayGuard();
    expect(g.seen("n1")).toBe(false);
    expect(g.seen("n1")).toBe(false); // calling seen() twice must not itself consume
    expect(g.consume("n1", 0)).toBe(true);
    expect(g.seen("n1")).toBe(true);
    expect(g.seen("n1")).toBe(true);
  });

  it("different nonces are independent", () => {
    const g = new MemoryReplayGuard();
    expect(g.consume("a", 0)).toBe(true);
    expect(g.consume("b", 0)).toBe(true);
    expect(g.consume("a", 0)).toBe(false);
    expect(g.consume("c", 0)).toBe(true);
  });

  it("UseCounter.increment accumulates per tokenId and count() is read-only", () => {
    const g = new MemoryReplayGuard();
    expect(g.count("tok-1")).toBe(0);
    expect(g.increment("tok-1", 0)).toBe(1);
    expect(g.increment("tok-1", 1)).toBe(2);
    expect(g.increment("tok-1", 2)).toBe(3);
    expect(g.count("tok-1")).toBe(3);
    expect(g.count("tok-1")).toBe(3); // read-only, no side effect
    expect(g.count("tok-2")).toBe(0); // independent counter per tokenId
  });

  it("pruneOlderThan removes only entries at/over the TTL boundary, from both nonces and uses", () => {
    const g = new MemoryReplayGuard();
    g.consume("old", 0);
    g.consume("mid", 500);
    g.consume("new", 999);
    g.increment("tok-old", 0);
    g.increment("tok-new", 999);

    // age(old) = 1000 - 0 = 1000 >= ttl(1000) -> pruned
    // age(mid) = 1000 - 500 = 500 < 1000 -> kept
    // age(new) = 1000 - 999 = 1 < 1000 -> kept
    const removed = g.pruneOlderThan(1000, 1000);
    expect(removed).toBe(2); // "old" nonce + "tok-old" use entry
    expect(g.seen("old")).toBe(false);
    expect(g.seen("mid")).toBe(true);
    expect(g.seen("new")).toBe(true);
    expect(g.count("tok-old")).toBe(0);
    expect(g.count("tok-new")).toBe(1);
  });

  it("pruneOlderThan never resurrects a still-valid consumed nonce", () => {
    const g = new MemoryReplayGuard();
    g.consume("n", 0);
    g.pruneOlderThan(500, 1000); // not expired yet
    expect(g.consume("n", 500)).toBe(false); // still denied as replay
    g.pruneOlderThan(1000, 1000); // now expired (age exactly == ttl)
    expect(g.consume("n", 1000)).toBe(true); // only NOW is it fresh again
  });

  it("evictOldestBeyond bounds size, evicting the oldest entries first", () => {
    const g = new MemoryReplayGuard();
    g.consume("n1", 0);
    g.consume("n2", 1);
    g.consume("n3", 2);
    g.consume("n4", 3);
    const removed = g.evictOldestBeyond(3);
    expect(removed).toBe(1);
    expect(g.seen("n1")).toBe(false); // oldest evicted
    expect(g.seen("n2")).toBe(true);
    expect(g.seen("n3")).toBe(true);
    expect(g.seen("n4")).toBe(true);
  });
});

describe("DurableReplayGuard", () => {
  it("persists consumed nonces to a real file and survives close()+reopen (simulated process restart)", () => {
    const dir = tempDir();
    const file = join(dir, "gov", "nonces.json");
    try {
      const guard1 = DurableReplayGuard.open({ file, ttlMs: 10_000_000 });
      expect(guard1.consume("captured-token-nonce", 0)).toBe(true);
      guard1.close();

      // Fresh instance, same file — as if the process restarted.
      const guard2 = DurableReplayGuard.open({ file, ttlMs: 10_000_000 });
      expect(guard2.seen("captured-token-nonce")).toBe(true);
      expect(guard2.consume("captured-token-nonce", 1)).toBe(false); // STILL denies replay
      guard2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists use counts across close()+reopen too", () => {
    const dir = tempDir();
    const file = join(dir, "nonces.json");
    try {
      const guard1 = DurableReplayGuard.open({ file });
      guard1.increment("tok-A", 0);
      guard1.increment("tok-A", 1);
      guard1.close();

      const guard2 = DurableReplayGuard.open({ file });
      expect(guard2.count("tok-A")).toBe(2);
      expect(guard2.increment("tok-A", 2)).toBe(3);
      guard2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes atomically: no stray .tmp file survives, and the file always parses as valid JSON", () => {
    const dir = tempDir();
    const file = join(dir, "nonces.json");
    try {
      const guard = DurableReplayGuard.open({ file });
      guard.consume("n1", 0);
      guard.consume("n2", 1);
      expect(existsSync(`${file}.tmp`)).toBe(false);
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      expect(parsed.schema).toBe("hades.gov.replay.v1");
      expect(parsed.nonces.map((e: { nonce: string }) => e.nonce).sort()).toEqual(["n1", "n2"]);
      guard.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing file opens as a fresh, empty store rather than throwing", () => {
    const dir = tempDir();
    const file = join(dir, "does", "not", "exist", "nonces.json");
    try {
      const guard = DurableReplayGuard.open({ file });
      expect(guard.seen("anything")).toBe(false);
      expect(guard.consume("anything", 0)).toBe(true);
      guard.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a corrupted file opens as a fresh, empty store rather than throwing", () => {
    const dir = tempDir();
    const file = join(dir, "nonces.json");
    writeFileSync(file, "{ not: valid json ]]]");
    try {
      const guard = DurableReplayGuard.open({ file });
      expect(guard.seen("x")).toBe(false);
      expect(guard.consume("x", 0)).toBe(true);
      guard.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a well-formed-JSON-but-wrong-shape file also opens as a fresh, empty store", () => {
    const dir = tempDir();
    const file = join(dir, "nonces.json");
    writeFileSync(file, JSON.stringify({ hello: "world" }));
    try {
      const guard = DurableReplayGuard.open({ file });
      expect(guard.seen("x")).toBe(false);
      guard.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prune(at) removes only entries past TTL and never resurrects a consumed nonce still within TTL", () => {
    const dir = tempDir();
    const file = join(dir, "nonces.json");
    try {
      const guard = DurableReplayGuard.open({ file, ttlMs: 1000 });
      guard.consume("n", 0);

      expect(guard.prune(500)).toBe(0); // not expired yet
      expect(guard.consume("n", 500)).toBe(false); // still a replay

      expect(guard.prune(1000)).toBe(1); // exactly at TTL boundary -> pruned
      expect(guard.seen("n")).toBe(false);
      expect(guard.consume("n", 1000)).toBe(true); // only now treated as fresh
      guard.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds size with oldest-first eviction and persists the eviction", () => {
    const dir = tempDir();
    const file = join(dir, "nonces.json");
    try {
      const guard1 = DurableReplayGuard.open({ file, maxEntries: 3, ttlMs: 10_000_000 });
      guard1.consume("n1", 0);
      guard1.consume("n2", 1);
      guard1.consume("n3", 2);
      guard1.consume("n4", 3); // should evict n1 (oldest)
      expect(guard1.seen("n1")).toBe(false);
      expect(guard1.seen("n4")).toBe(true);
      guard1.close();

      // Confirm the eviction was actually persisted, not just in-memory.
      const guard2 = DurableReplayGuard.open({ file, maxEntries: 3, ttlMs: 10_000_000 });
      expect(guard2.seen("n1")).toBe(false);
      expect(guard2.seen("n2")).toBe(true);
      expect(guard2.seen("n3")).toBe(true);
      expect(guard2.seen("n4")).toBe(true);
      guard2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flush() forces a synchronous write of current state to disk", () => {
    const dir = tempDir();
    const file = join(dir, "nonces.json");
    try {
      const guard = DurableReplayGuard.open({ file });
      guard.consume("n1", 0);
      guard.flush();
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      expect(parsed.nonces.some((e: { nonce: string }) => e.nonce === "n1")).toBe(true);
      guard.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when used after close()", () => {
    const dir = tempDir();
    const file = join(dir, "nonces.json");
    try {
      const guard = DurableReplayGuard.open({ file });
      guard.close();
      expect(() => guard.consume("n", 0)).toThrow();
      expect(() => guard.seen("n")).toThrow();
      expect(() => guard.increment("t", 0)).toThrow();
      expect(() => guard.count("t")).toThrow();
      expect(() => guard.prune(0)).toThrow();
      expect(() => guard.flush()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-positive ttlMs or maxEntries at open()", () => {
    const dir = tempDir();
    const file = join(dir, "nonces.json");
    try {
      expect(() => DurableReplayGuard.open({ file, ttlMs: 0 })).toThrow();
      expect(() => DurableReplayGuard.open({ file, maxEntries: -1 })).toThrow();
      expect(() => DurableReplayGuard.open({ file: "" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
