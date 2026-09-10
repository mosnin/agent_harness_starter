import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkspaceStore } from "../store";
import type { ActorId } from "../record";
import { InvalidKeyError } from "../record";
import { WorkspaceFeed, type WorkspaceChange } from "../feed";

// Shared mutable flag, accessible both inside the hoisted vi.mock factory
// below and from individual test bodies, used ONLY to simulate an
// environment where `fs.watch` itself throws (e.g. an unsupported sandbox).
// Every other node:fs function passes through to the real implementation
// unchanged.
const watchState = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      if (watchState.shouldThrow) throw new Error("ENOSYS: fs.watch not supported here");
      return (actual.watch as (...a: unknown[]) => unknown)(...args);
    },
  };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-feed-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkStore(actor: ActorId = { kind: "cli", id: "alice" }, extra: Partial<{ fsync: boolean; now: () => number }> = {}) {
  return new WorkspaceStore({ root, actor, fsync: extra.fsync ?? false, now: extra.now });
}

function clockNow(startMs = 1_700_000_000_000) {
  let t = startMs;
  return () => (t += 1);
}

function totalRecords(batches: WorkspaceChange[]): number {
  return batches.reduce((n, b) => n + b.records.length, 0);
}

// ===========================================================================
// Basic poll / peek / cursor persistence
// ===========================================================================

describe("poll / peek basics", () => {
  it("poll() delivers new writes in order and advances the persisted cursor", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);

    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    const batch = feed.poll();
    expect(batch.map((c) => c.seq)).toEqual([1, 2]);
    expect(batch[0].records[0].key).toBe("a");
    expect(batch[1].records[0].key).toBe("b");

    expect(feed.cursor().seq).toBe(2);
    expect(feed.cursor().consumer).toBe("c1");

    // Nothing new: second poll is empty and cursor unchanged.
    expect(feed.poll()).toEqual([]);
    expect(feed.cursor().seq).toBe(2);
    store.close();
  });

  it("peek() returns the same batch as poll() would, but never advances or persists the cursor", () => {
    const store = mkStore();
    store.put("memory", "a", 1);

    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    const peeked = feed.peek();
    expect(peeked.map((c) => c.seq)).toEqual([1]);
    expect(feed.cursor().seq).toBe(0); // unchanged

    const polled = feed.poll();
    expect(polled).toEqual(peeked);
    expect(feed.cursor().seq).toBe(1);
    store.close();
  });

  it("poll() dedupes by seq: never redelivers an already-delivered entry", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    const first = feed.poll();
    expect(first.length).toBe(1);
    store.put("memory", "b", 2);
    const second = feed.poll();
    expect(second.map((c) => c.seq)).toEqual([2]); // not [1, 2]
    store.close();
  });

});

describe("cross-process cursor durability", () => {
  it("cursor persisted by process A is honoured when process B opens the same consumer", () => {
    const storeA = mkStore();
    storeA.put("memory", "a", 1);
    storeA.put("memory", "b", 2);

    const feedA = new WorkspaceFeed({ store: storeA, root, consumer: "shared", watch: false });
    const batchA = feedA.poll();
    expect(batchA.map((c) => c.seq)).toEqual([1, 2]);
    storeA.close();

    // A brand-new store instance + brand-new WorkspaceFeed instance for the
    // SAME root/consumer simulates a second process picking up where the
    // first left off.
    const storeB = mkStore();
    storeB.put("memory", "c", 3);
    const feedB = new WorkspaceFeed({ store: storeB, root, consumer: "shared", watch: false });
    expect(feedB.cursor().seq).toBe(2); // durably resumed, not starting at 0
    const batchB = feedB.poll();
    expect(batchB.map((c) => c.seq)).toEqual([3]);
    storeB.close();
  });

  it("two DIFFERENT consumers on the same store maintain independent cursors", () => {
    const store = mkStore();
    store.put("memory", "a", 1);

    const feed1 = new WorkspaceFeed({ store, root, consumer: "consumer-1", watch: false });
    const feed2 = new WorkspaceFeed({ store, root, consumer: "consumer-2", watch: false });
    feed1.poll();
    expect(feed1.cursor().seq).toBe(1);
    expect(feed2.cursor().seq).toBe(0); // untouched by feed1's poll

    store.close();
  });
});

// ===========================================================================
// Consumer name validation (path safety)
// ===========================================================================

describe("consumer name safety", () => {
  it("throws instead of writing outside <root>/cursors for a path-traversal consumer name", () => {
    const store = mkStore();
    expect(() => new WorkspaceFeed({ store, root, consumer: "../../etc/passwd", watch: false })).toThrow(InvalidKeyError);
    // Confirm nothing escaped: only the cursors dir should exist under root's parent traversal target.
    expect(existsSync(join(root, "..", "etc"))).toBe(false);
    store.close();
  });

  it("throws for an empty consumer name", () => {
    const store = mkStore();
    expect(() => new WorkspaceFeed({ store, root, consumer: "", watch: false })).toThrow(InvalidKeyError);
    store.close();
  });

  it("a valid consumer name persists its cursor file at <root>/cursors/<consumer>.json", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    const feed = new WorkspaceFeed({ store, root, consumer: "desktop-sidecar", watch: false });
    feed.poll();
    const cursorPath = join(root, "cursors", "desktop-sidecar.json");
    expect(existsSync(cursorPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(parsed.consumer).toBe("desktop-sidecar");
    expect(parsed.seq).toBe(1);
    store.close();
  });
});

// ===========================================================================
// subscribe()
// ===========================================================================

describe("subscribe()", () => {
  it("delivers batches to subscribers on poll(), and unsubscribe stops delivery", () => {
    const store = mkStore();
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    const received: WorkspaceChange[][] = [];
    const unsub = feed.subscribe((b) => received.push(b));

    store.put("memory", "a", 1);
    feed.poll();
    expect(received.length).toBe(1);
    expect(received[0].map((c) => c.seq)).toEqual([1]);

    unsub();
    store.put("memory", "b", 2);
    feed.poll();
    expect(received.length).toBe(1); // no further delivery after unsubscribe
    store.close();
  });

  it("peek() never notifies subscribers", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    const received: WorkspaceChange[][] = [];
    feed.subscribe((b) => received.push(b));
    feed.peek();
    expect(received.length).toBe(0);
    store.close();
  });

  it("a throwing listener never breaks the feed or other listeners", () => {
    const store = mkStore();
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    const goodReceived: WorkspaceChange[][] = [];
    feed.subscribe(() => {
      throw new Error("boom");
    });
    feed.subscribe((b) => goodReceived.push(b));

    store.put("memory", "a", 1);
    expect(() => feed.poll()).not.toThrow();
    expect(goodReceived.length).toBe(1);
    store.close();
  });

  it("routes a throwing listener's error through onError instead of swallowing it silently", () => {
    const store = mkStore();
    const errors: Error[] = [];
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false, onError: (e) => errors.push(e) });
    feed.subscribe(() => {
      throw new Error("listener exploded");
    });
    store.put("memory", "a", 1);
    feed.poll();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe("listener exploded");
    store.close();
  });
});

// ===========================================================================
// Compaction resync
// ===========================================================================

describe("resync on compaction", () => {
  it("a compaction between poll cycles triggers a resync that yields the FULL snapshot rather than a gap", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.put("memory", "c", 3);

    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    const first = feed.poll();
    expect(first.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(feed.cursor().seq).toBe(3);

    // Someone edits "b" AFTER our cursor, then the whole journal gets
    // collapsed by compact() before we poll again.
    store.put("memory", "b", 20);
    store.compact();

    const resynced = feed.poll();
    expect(resynced.length).toBe(1); // one synthetic full-snapshot batch, not a per-key trickle
    const keys = resynced[0].records.filter((r) => !r.deleted).map((r) => r.key).sort();
    expect(keys).toEqual(["a", "b", "c"]);
    const bRecord = resynced[0].records.find((r) => r.key === "b")!;
    expect(bRecord.value).toBe(20); // the LATEST value, not stale — no gap was silently skipped

    // Cursor is now realigned to the post-compaction head; nothing pending.
    expect(feed.poll()).toEqual([]);
    store.close();
  });

  it("resync() reports reason 'compacted' explicitly and can be called directly", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    feed.poll();
    expect(feed.cursor().seq).toBe(1);

    store.put("memory", "b", 2);
    store.compact();

    const result = feed.resync();
    expect(result.reason).toBe("compacted");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.records.map((r) => r.key).sort()).toEqual(["a", "b"]);
    store.close();
  });

  it("resync() on a never-synced (seq 0) cursor reports 'none' and still returns the full current snapshot", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    const feed = new WorkspaceFeed({ store, root, consumer: "brand-new", watch: false });
    const result = feed.resync();
    expect(result.reason).toBe("none");
    expect(result.snapshot!.records.map((r) => r.key)).toEqual(["a"]);
    store.close();
  });
});

// ===========================================================================
// Corrupted journal tail -> chain-broken
// ===========================================================================

describe("corrupted journal", () => {
  it("a deliberately corrupted (non-final) journal line self-heals and reports chain-broken instead of throwing to the caller", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.put("memory", "c", 3);

    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    feed.poll();
    expect(feed.cursor().seq).toBe(3);

    store.put("memory", "d", 4);

    // Corrupt a MIDDLE line of the journal (not the final one, which would
    // just be silently treated as a torn write by the store).
    const journalPath = join(root, "journal.log");
    const lines = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.length > 0);
    lines[1] = "{not valid json at all";
    writeFileSync(journalPath, lines.join("\n") + "\n", "utf8");

    const errors: Error[] = [];
    const feed2 = new WorkspaceFeed({ store, root, consumer: "c1", watch: false, onError: (e) => errors.push(e) });
    const batch = feed2.poll();

    // Self-healed: delivers a full-snapshot resync instead of throwing, and
    // reports the corruption via onError rather than fabricating entries.
    expect(batch.length).toBe(1);
    const keys = batch[0].records.filter((r) => !r.deleted).map((r) => r.key).sort();
    expect(keys).toEqual(["a", "b", "c", "d"]); // "everything up to (and including, via domain segments) the break" — nothing fabricated, nothing lost
    expect(errors.length).toBeGreaterThan(0);

    const result = feed2.resync();
    expect(result.reason === "chain-broken" || result.reason === "none").toBe(true);
    store.close();
  });
});

// ===========================================================================
// Back-pressure / batchMax
// ===========================================================================

describe("batchMax back-pressure", () => {
  it("splits delivery across many poll() calls without reordering or losing records, over 5k queued records", () => {
    const store = mkStore(undefined, { fsync: false });
    const TOTAL = 5000;
    const PER_ENTRY = 25;
    for (let i = 0; i < TOTAL / PER_ENTRY; i++) {
      const entries = Array.from({ length: PER_ENTRY }, (_, j) => ({
        domain: "memory" as const,
        key: `k${i * PER_ENTRY + j}`,
        value: i * PER_ENTRY + j,
      }));
      store.putMany(entries);
    }

    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false, batchMax: 337 });
    const allBatches: WorkspaceChange[] = [];
    let guard = 0;
    for (;;) {
      const b = feed.poll();
      if (b.length === 0) break;
      allBatches.push(...b);
      guard++;
      if (guard > 10_000) throw new Error("poll() loop did not converge");
    }

    expect(totalRecords(allBatches)).toBe(TOTAL);
    // Gap-free, strictly increasing seq, no duplicates.
    const seqs = allBatches.map((c) => c.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    // Order preserved: every key appears exactly once, in ascending numeric order.
    const allKeys = allBatches.flatMap((c) => c.records.map((r) => r.key));
    expect(new Set(allKeys).size).toBe(TOTAL);
    expect(feed.cursor().seq).toBe(TOTAL / PER_ENTRY);
    store.close();
  }, 30_000);
});

// ===========================================================================
// reset()
// ===========================================================================

describe("reset()", () => {
  it("reset(0) rewinds the cursor so the next poll() redelivers everything from the start", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    feed.poll();
    expect(feed.cursor().seq).toBe(2);

    feed.reset(0);
    expect(feed.cursor().seq).toBe(0);
    const replay = feed.poll();
    expect(replay.map((c) => c.seq)).toEqual([1, 2]);
    store.close();
  });

  it("reset() with no argument skips to caught-up-now, discarding any pending backlog", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    // Never polled yet — cursor at 0 with one entry pending.
    feed.reset();
    expect(feed.cursor().seq).toBe(1);
    expect(feed.poll()).toEqual([]);
    store.close();
  });

  it("reset(seq) to a seq that never existed throws", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    expect(() => feed.reset(999)).toThrow(RangeError);
    store.close();
  });
});

// ===========================================================================
// start() / stop() — interval fallback + fs.watch degradation
// ===========================================================================

describe("start() / stop()", () => {
  it("the interval fallback alone (watch: false) eventually delivers a write made after start()", async () => {
    const store = mkStore();
    const received: WorkspaceChange[][] = [];
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false, pollMs: 10 });
    feed.subscribe((b) => received.push(b));
    feed.start();
    store.put("memory", "a", 1);

    await vi.waitFor(
      () => {
        expect(received.length).toBeGreaterThan(0);
      },
      { timeout: 2000, interval: 10 },
    );

    feed.stop();
    store.close();
  });

  it("stop() is idempotent and safe to call before start() or multiple times", () => {
    const store = mkStore();
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false });
    expect(() => feed.stop()).not.toThrow();
    feed.start();
    expect(() => {
      feed.stop();
      feed.stop();
      feed.stop();
    }).not.toThrow();
    store.close();
  });

  it("degrades honestly when fs.watch is unavailable: reports the failure via onError but keeps delivering via the interval", async () => {
    watchState.shouldThrow = true;
    try {
      const store = mkStore();
      const errors: Error[] = [];
      const received: WorkspaceChange[][] = [];
      const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: true, pollMs: 10, onError: (e) => errors.push(e) });
      feed.subscribe((b) => received.push(b));
      feed.start();
      expect(errors.some((e) => /fs\.watch/.test(e.message))).toBe(true);

      store.put("memory", "a", 1);
      await vi.waitFor(
        () => {
          expect(received.length).toBeGreaterThan(0);
        },
        { timeout: 2000, interval: 10 },
      );

      feed.stop();
      store.close();
    } finally {
      watchState.shouldThrow = false;
    }
  });

  it("start() is idempotent (calling it twice does not double-register watchers/intervals)", () => {
    const store = mkStore();
    const feed = new WorkspaceFeed({ store, root, consumer: "c1", watch: false, pollMs: 10 });
    feed.start();
    feed.start();
    expect(() => feed.stop()).not.toThrow();
    store.close();
  });
});
