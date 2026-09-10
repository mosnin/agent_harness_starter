import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WorkspaceStore, WorkspaceLockError, WorkspaceCorruptError, type JournalEntry } from "../store";
import {
  InvalidKeyError,
  CanonicalJsonError,
  canonicalJson,
  recordHash,
  type ActorId,
  type WorkspaceRecord,
} from "../record";
import { sha256Hex } from "../../styx/certificate";

const STORE_TS_PATH = fileURLToPath(new URL("../store.ts", import.meta.url));
const TSX_CLI = require.resolve("tsx/cli");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-state-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkStore(overrides: Partial<{ actor: ActorId; now: () => number; fsync: boolean; journalMaxEntries: number; lockTimeoutMs: number; staleLockMs: number; root: string }> = {}) {
  return new WorkspaceStore({
    root: overrides.root ?? root,
    actor: overrides.actor ?? { kind: "cli", id: "alice" },
    now: overrides.now,
    fsync: overrides.fsync,
    journalMaxEntries: overrides.journalMaxEntries,
    lockTimeoutMs: overrides.lockTimeoutMs,
    staleLockMs: overrides.staleLockMs,
  });
}

function clockNow(startMs = 1_700_000_000_000) {
  let t = startMs;
  return () => (t += 1);
}

// ===========================================================================
// Basic put / get / list / delete
// ===========================================================================

describe("put / get / list / delete round trip", () => {
  it("put returns a record whose own hash authenticates itself, and get returns the same record", () => {
    const store = mkStore({ now: clockNow() });
    const r = store.put("memory", "note-1", { text: "hello" });
    expect(r.domain).toBe("memory");
    expect(r.key).toBe("note-1");
    expect(r.rev).toBe(1);
    expect(r.deleted).toBe(false);
    expect(r.actor).toBe("cli:alice");
    expect(r.clock).toEqual({ "cli:alice": 1 });
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);

    const fetched = store.get("memory", "note-1");
    expect(fetched).toEqual(r);
    store.close();
  });

  it("get returns undefined for a key that was never written", () => {
    const store = mkStore();
    expect(store.get("memory", "nope")).toBeUndefined();
    store.close();
  });

  it("a second put to the same key bumps rev and ticks the actor's clock entry", () => {
    const store = mkStore({ now: clockNow() });
    const r1 = store.put("config", "theme", "dark");
    const r2 = store.put("config", "theme", "light");
    expect(r2.rev).toBe(2);
    expect(r2.clock).toEqual({ "cli:alice": 2 });
    expect(r2.value).toBe("light");
    expect(r2.hash).not.toBe(r1.hash);
    store.close();
  });

  it("list returns records sorted by key, excludes tombstones by default", () => {
    const store = mkStore();
    store.put("sessions", "b", 1);
    store.put("sessions", "a", 2);
    store.put("sessions", "c", 3);
    store.delete("sessions", "b");

    const live = store.list("sessions");
    expect(live.map((r) => r.key)).toEqual(["a", "c"]);

    const withDeleted = store.list("sessions", { includeDeleted: true });
    expect(withDeleted.map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(withDeleted.find((r) => r.key === "b")!.deleted).toBe(true);
    store.close();
  });

  it("list supports a key prefix filter", () => {
    const store = mkStore();
    store.put("skills", "git.commit", 1);
    store.put("skills", "git.push", 2);
    store.put("skills", "docker.build", 3);
    expect(store.list("skills", { prefix: "git." }).map((r) => r.key)).toEqual(["git.commit", "git.push"]);
    store.close();
  });

  it("delete on a live key returns a tombstone with empty hash and rev bumped", () => {
    const store = mkStore();
    const created = store.put("memory", "fact", "x");
    const tomb = store.delete("memory", "fact");
    expect(tomb).not.toBeNull();
    expect(tomb!.deleted).toBe(true);
    expect(tomb!.hash).toBe("");
    expect(tomb!.value).toBeNull();
    expect(tomb!.rev).toBe(created.rev + 1);
    store.close();
  });

  it("delete on a nonexistent key is a no-op returning null", () => {
    const store = mkStore();
    expect(store.delete("memory", "never-existed")).toBeNull();
    store.close();
  });

  it("delete twice in a row is idempotent (second call is a no-op, rev does not bump again)", () => {
    const store = mkStore();
    store.put("memory", "fact", "x");
    const first = store.delete("memory", "fact")!;
    const second = store.delete("memory", "fact");
    expect(second).toBeNull();
    expect(store.get("memory", "fact")!.rev).toBe(first.rev);
    store.close();
  });

  it("rejects an invalid domain at runtime even past the type system", () => {
    const store = mkStore();
    expect(() => store.put("bogus" as never, "k", 1)).toThrow(RangeError);
    expect(() => store.get("bogus" as never, "k")).toThrow(RangeError);
    expect(() => store.list("bogus" as never)).toThrow(RangeError);
    expect(() => store.delete("bogus" as never, "k")).toThrow(RangeError);
    store.close();
  });

  it("rejects an invalid key via InvalidKeyError and does not write anything", () => {
    const store = mkStore();
    expect(() => store.put("memory", "../escape", 1)).toThrow(InvalidKeyError);
    expect(store.list("memory", { includeDeleted: true })).toHaveLength(0);
    store.close();
  });

  it("rejects a value that is not a strict JsonValue (NaN) via CanonicalJsonError, nothing written", () => {
    const store = mkStore();
    expect(() => store.put("memory", "k", NaN as never)).toThrow(CanonicalJsonError);
    expect(store.get("memory", "k")).toBeUndefined();
    store.close();
  });

  it("throws once closed", () => {
    const store = mkStore();
    store.close();
    expect(() => store.put("memory", "k", 1)).toThrow(/closed/);
    expect(() => store.get("memory", "k")).toThrow(/closed/);
  });
});

// ===========================================================================
// Edge cases: unicode keys, large values
// ===========================================================================

describe("edge cases: unicode keys and large values", () => {
  it("round-trips a unicode/emoji key", () => {
    const store = mkStore();
    const key = "café-🚀-笔记";
    const r = store.put("memory", key, "hi");
    expect(store.get("memory", key)).toEqual(r);
    expect(store.list("memory").map((x) => x.key)).toContain(key);
    store.close();
  });

  it("round-trips a 1 MiB string value with an intact, verifiable hash", () => {
    const store = mkStore();
    const big = "x".repeat(1024 * 1024);
    const r = store.put("memory", "big", big);
    expect(r.value).toBe(big);

    const reopened = mkStore({ actor: { kind: "test", id: "verifier" } });
    const fetched = reopened.get("memory", "big")!;
    expect((fetched.value as string).length).toBe(1024 * 1024);
    expect(fetched.hash).toBe(r.hash);
    reopened.close();
    store.close();
  });
});

// ===========================================================================
// putMany
// ===========================================================================

describe("putMany", () => {
  it("writes multiple domains under one lock and one journal entry", () => {
    const store = mkStore();
    const results = store.putMany([
      { domain: "memory", key: "a", value: 1 },
      { domain: "config", key: "b", value: 2 },
      { domain: "skills", key: "c", value: 3 },
    ]);
    expect(results).toHaveLength(3);
    expect(store.get("memory", "a")!.value).toBe(1);
    expect(store.get("config", "b")!.value).toBe(2);
    expect(store.get("skills", "c")!.value).toBe(3);

    const entries = store.journalSince(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].records).toHaveLength(3);
    store.close();
  });

  it("multiple entries for the SAME key in one batch accumulate rev/clock correctly, in order", () => {
    const store = mkStore();
    const results = store.putMany([
      { domain: "memory", key: "k", value: "v1" },
      { domain: "memory", key: "k", value: "v2" },
      { domain: "memory", key: "k", value: "v3" },
    ]);
    expect(results.map((r) => r.rev)).toEqual([1, 2, 3]);
    expect(results.map((r) => r.value)).toEqual(["v1", "v2", "v3"]);
    expect(store.get("memory", "k")!.value).toBe("v3");
    expect(store.get("memory", "k")!.rev).toBe(3);
    store.close();
  });

  it("is all-or-nothing: one invalid entry means NOTHING is written and the lock is released afterward", () => {
    const store = mkStore();
    expect(() =>
      store.putMany([
        { domain: "memory", key: "good", value: 1 },
        { domain: "memory", key: "../bad", value: 2 },
      ]),
    ).toThrow(InvalidKeyError);

    expect(store.get("memory", "good")).toBeUndefined();
    expect(store.journalSince(0)).toHaveLength(0);

    // Lock was released — a subsequent operation must not hang/throw a lock error.
    const r = store.put("memory", "good", 1);
    expect(r.value).toBe(1);
    store.close();
  });

  it("an empty array is a no-op that returns an empty array", () => {
    const store = mkStore();
    expect(store.putMany([])).toEqual([]);
    expect(store.journalSince(0)).toHaveLength(0);
    store.close();
  });

  it("rejects an invalid domain among the entries, nothing written", () => {
    const store = mkStore();
    expect(() => store.putMany([{ domain: "memory", key: "ok", value: 1 }, { domain: "nope" as never, key: "x", value: 1 }])).toThrow(
      RangeError,
    );
    expect(store.get("memory", "ok")).toBeUndefined();
    store.close();
  });
});

// ===========================================================================
// 10k records
// ===========================================================================

describe("bulk scale: 10k records in one domain", () => {
  it("stores 10k records via a single putMany batch and lists them sorted with the right count", () => {
    const store = mkStore();
    const entries = Array.from({ length: 10_000 }, (_, i) => ({
      domain: "memory" as const,
      key: `k-${String(i).padStart(6, "0")}`,
      value: i,
    }));
    store.putMany(entries);

    const listed = store.list("memory");
    expect(listed).toHaveLength(10_000);
    // stays sorted
    for (let i = 1; i < listed.length; i++) {
      expect(listed[i - 1].key < listed[i].key).toBe(true);
    }
    expect(listed[0].key).toBe("k-000000");
    expect(listed[listed.length - 1].key).toBe("k-009999");
    store.close();
  }, 30_000);
});

// ===========================================================================
// applyRemote / merge
// ===========================================================================

describe("applyRemote", () => {
  function foreignActorStore(id: string) {
    const foreignRoot = mkdtempSync(join(tmpdir(), "hades-state-foreign-"));
    return mkStore({ root: foreignRoot, actor: { kind: "desktop", id } });
  }

  it("applies a brand-new record from a peer that has no local counterpart", () => {
    const local = mkStore({ actor: { kind: "cli", id: "local" } });
    const peer = foreignActorStore("peer");
    const remoteRecord = peer.put("memory", "shared", "from-peer");

    const result = local.applyRemote([remoteRecord]);
    expect(result.applied).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(local.get("memory", "shared")!.value).toBe("from-peer");
    local.close();
    peer.close();
  });

  it("is a no-op when the local record causally dominates the remote one", () => {
    const local = mkStore({ actor: { kind: "cli", id: "local" } });
    const initial = local.put("memory", "k", "v1");
    // Simulate a stale remote view: same record, but from before the local update.
    const stale: WorkspaceRecord = { ...initial, clock: {}, rev: 0 } as unknown as WorkspaceRecord;
    // Build a structurally valid stale record via a second store instance instead of hand-forging.
    const peer = foreignActorStore("peer");
    peer.applyRemote([initial]); // peer now has the same state as "before" local's future edits
    const peerRecord = peer.get("memory", "k")!;
    local.put("memory", "k", "v2"); // local moves ahead

    const result = local.applyRemote([peerRecord]);
    expect(result.applied).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(local.get("memory", "k")!.value).toBe("v2"); // unchanged
    void stale;
    local.close();
    peer.close();
  });

  it("fast-forwards when the remote record causally dominates local", () => {
    const local = mkStore({ actor: { kind: "cli", id: "local" } });
    const shared = local.put("memory", "k", "v1");

    const peer = foreignActorStore("peer");
    peer.applyRemote([shared]);
    const advanced = peer.put("memory", "k", "v2-from-peer"); // peer's clock now dominates local's

    const result = local.applyRemote([advanced]);
    expect(result.applied).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(local.get("memory", "k")!.value).toBe("v2-from-peer");
    local.close();
    peer.close();
  });

  it("reports a genuine concurrent conflict and a tombstone always wins over a concurrent live write", () => {
    const local = mkStore({ actor: { kind: "cli", id: "local" } });
    const shared = local.put("memory", "k", "v0");

    const peer = foreignActorStore("peer");
    peer.applyRemote([shared]);

    // Diverge concurrently: local updates, peer deletes, neither observing the other.
    local.put("memory", "k", "v1-local");
    const peerTomb = peer.delete("memory", "k")!;

    const result = local.applyRemote([peerTomb]);
    expect(result.applied).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].winner.deleted).toBe(true);
    expect(local.get("memory", "k")!.deleted).toBe(true);
    local.close();
    peer.close();
  });

  it("rejects a structurally invalid record (bad domain) without applying it", () => {
    const local = mkStore();
    const bogus = { domain: "not-a-domain", key: "k", rev: 1, clock: {}, updatedAt: 1, actor: "cli:x", deleted: false, hash: "a".repeat(64), value: 1 };
    const result = local.applyRemote([bogus as unknown as WorkspaceRecord]);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/not a structurally valid/);
    local.close();
  });

  it("rejects a record whose key contains a path-escape sequence", () => {
    const local = mkStore();
    const bogus = { domain: "memory", key: "../etc/passwd", rev: 1, clock: {}, updatedAt: 1, actor: "cli:x", deleted: false, hash: "a".repeat(64), value: 1 };
    const result = local.applyRemote([bogus as unknown as WorkspaceRecord]);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    local.close();
  });

  it("rejects a record whose hash does not match its value — never applies it", () => {
    const local = mkStore();
    const peer = foreignActorStore("peer");
    const real = peer.put("memory", "tampered", { text: "original" });
    const tampered: WorkspaceRecord = { ...real, value: { text: "TAMPERED" } };

    const result = local.applyRemote([tampered]);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/hash mismatch/);
    expect(local.get("memory", "tampered")).toBeUndefined();
    local.close();
    peer.close();
  });

  it("rejects a tombstone with a non-empty hash (fails shape validation: tombstones must hash to \"\")", () => {
    const local = mkStore();
    const bogus = { domain: "memory", key: "k", rev: 1, clock: {}, updatedAt: 1, actor: "cli:x", deleted: true, hash: "a".repeat(64), value: null };
    const result = local.applyRemote([bogus as unknown as WorkspaceRecord]);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected[0].reason).toMatch(/not a structurally valid/);
    local.close();
  });

  it("clock going backwards: a stale remote record can never decrease the store's rev, which keeps increasing strictly", () => {
    const local = mkStore({ actor: { kind: "cli", id: "local" } });
    local.put("memory", "k", "v1");
    local.put("memory", "k", "v2");
    const afterTwo = local.get("memory", "k")!;
    expect(afterTwo.rev).toBe(2);

    // A record claiming to be "from the past" relative to the current state
    // (rev 1, empty-ish clock) must not roll the store backwards.
    const stale: WorkspaceRecord = {
      domain: "memory",
      key: "k",
      rev: 1,
      clock: { "cli:local": 1 },
      updatedAt: 1,
      actor: "cli:local",
      deleted: false,
      value: "v-stale",
      hash: "",
    };
    const staleWithHash = { ...stale, hash: recordHash(stale) };
    const result = local.applyRemote([staleWithHash]);
    expect(result.applied).toHaveLength(0); // local dominates — no-op
    const after = local.get("memory", "k")!;
    expect(after.rev).toBe(2); // unchanged, never decreased
    expect(after.value).toBe("v2");

    // rev continues to increase monotonically afterward
    const r3 = local.put("memory", "k", "v3");
    expect(r3.rev).toBe(3);
    local.close();
  });
});

// ===========================================================================
// snapshot / journalSince / verifyChain / compact
// ===========================================================================

describe("snapshot", () => {
  it("reflects every domain's current records and a journalSeq/head matching the journal tail", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("config", "b", 2);
    const snap = store.snapshot();
    expect(snap.version).toBe(1);
    expect(snap.records).toHaveLength(2);
    expect(snap.journalSeq).toBe(2);

    const entries = store.journalSince(0);
    expect(snap.head).toBe(entries[entries.length - 1].hash);
    store.close();
  });

  it("returns an empty, well-formed snapshot for a fresh store", () => {
    const store = mkStore();
    const snap = store.snapshot();
    expect(snap.records).toEqual([]);
    expect(snap.journalSeq).toBe(0);
    store.close();
  });
});

describe("journalSince", () => {
  it("returns only entries strictly after the given seq, each seq contiguous", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.put("memory", "c", 3);

    const all = store.journalSince(0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);

    const fromTwo = store.journalSince(2);
    expect(fromTwo.map((e) => e.seq)).toEqual([3]);

    expect(store.journalSince(99)).toEqual([]);
    store.close();
  });

  it("after compact(), a cursor pointing into the compacted prefix observes a seq GAP carrying the full checkpoint state", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.put("memory", "c", 3);
    const cursorBefore = 1; // caught up to seq 1 only

    const { before, after } = store.compact();
    expect(before).toBe(3);
    expect(after).toBe(1);

    const resumed = store.journalSince(cursorBefore);
    expect(resumed).toHaveLength(1);
    const checkpoint = resumed[0];
    // The gap: checkpoint.seq !== cursorBefore + 1 signals "this is a full
    // checkpoint, not a delta" per the module contract.
    expect(checkpoint.seq).not.toBe(cursorBefore + 1);
    expect(checkpoint.seq).toBe(3); // retains the last real seq it replaces
    // The checkpoint carries the FULL live state, not just a delta.
    const keys = checkpoint.records.map((r) => r.key).sort();
    expect(keys).toEqual(["a", "b", "c"]);
    store.close();
  });
});

describe("verifyChain", () => {
  it("reports ok:true for a healthy chain across put/delete/putMany/compact", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.delete("memory", "a");
    store.putMany([{ domain: "config", key: "b", value: 2 }]);
    store.compact();
    store.put("memory", "c", 3);
    expect(store.verifyChain()).toEqual({ ok: true });
    store.close();
  });

  it("catches a hand-edited journal line and reports the exact broken seq", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.put("memory", "c", 3);
    store.close();

    const journalPath = join(root, "journal.log");
    const lines = readFileSync(journalPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const tampered: JournalEntry = JSON.parse(lines[1]);
    tampered.records[0] = { ...tampered.records[0], value: "TAMPERED" };
    lines[1] = JSON.stringify(tampered);
    writeFileSync(journalPath, lines.join("\n") + "\n", "utf8");

    const reopened = mkStore({ actor: { kind: "test", id: "verifier" } });
    const result = reopened.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2); // the tampered entry itself no longer matches its own hash
    reopened.close();
  });

  it("catches a broken prevHash link even if the tampered entry recomputes its own hash consistently", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.close();

    const journalPath = join(root, "journal.log");
    const lines = readFileSync(journalPath, "utf8").trimEnd().split("\n");
    const entry2: JournalEntry = JSON.parse(lines[1]);
    entry2.prevHash = "f".repeat(64); // forged link, unrelated to entry1's real hash
    lines[1] = JSON.stringify(entry2);
    writeFileSync(journalPath, lines.join("\n") + "\n", "utf8");

    const reopened = mkStore({ actor: { kind: "test", id: "verifier" } });
    const result = reopened.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
    reopened.close();
  });

  it("catches a journal line claiming an out-of-order/future seq", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.close();

    const journalPath = join(root, "journal.log");
    const lines = readFileSync(journalPath, "utf8").trimEnd().split("\n");
    const entry2: JournalEntry = JSON.parse(lines[1]);
    entry2.seq = 100; // future seq, prevHash/hash left internally self-consistent for entry2's own forged seq
    // Recompute entry2's own hash so the PER-LINE hash check passes, isolating the seq-contiguity check.
    const body = { seq: entry2.seq, at: entry2.at, actor: entry2.actor, prevHash: entry2.prevHash, records: entry2.records };
    // JSON round-trip first so the object is a plain, guaranteed-JsonValue-shaped structure.
    entry2.hash = sha256Hex(entry2.prevHash + canonicalJson(JSON.parse(JSON.stringify(body))));
    lines[1] = JSON.stringify(entry2);
    writeFileSync(journalPath, lines.join("\n") + "\n", "utf8");

    const reopened = mkStore({ actor: { kind: "test", id: "verifier" } });
    const result = reopened.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not contiguous/);
    reopened.close();
  });
});

describe("compact", () => {
  it("collapses the journal to a single checkpoint entry while preserving every live+deleted record", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.delete("memory", "a");
    const before = store.journalSince(0).length;
    expect(before).toBe(3);

    const result = store.compact();
    expect(result).toEqual({ before: 3, after: 1 });

    const entries = store.journalSince(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].records.map((r) => r.key).sort()).toEqual(["a", "b"]);

    // Data itself is unaffected by compaction.
    expect(store.get("memory", "a")!.deleted).toBe(true);
    expect(store.get("memory", "b")!.value).toBe(2);
    store.close();
  });

  it("compacting an empty journal is a no-op", () => {
    const store = mkStore();
    expect(store.compact()).toEqual({ before: 0, after: 0 });
    store.close();
  });

  it("verifyChain is still ok:true immediately after compaction, and after further writes", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.compact();
    expect(store.verifyChain().ok).toBe(true);
    store.put("memory", "c", 3);
    expect(store.verifyChain().ok).toBe(true);
    store.close();
  });
});

// ===========================================================================
// Reopening / actor causality
// ===========================================================================

describe("reopening from a different actor", () => {
  it("sees every prior record with intact causality, and its own writes extend the same clock lineage", () => {
    const writer = mkStore({ actor: { kind: "cli", id: "writer" } });
    writer.put("memory", "shared", "v1");
    writer.put("memory", "shared", "v2");
    writer.close();

    const reader = mkStore({ actor: { kind: "desktop", id: "reader" } });
    const seen = reader.get("memory", "shared")!;
    expect(seen.value).toBe("v2");
    expect(seen.clock).toEqual({ "cli:writer": 2 });

    const updated = reader.put("memory", "shared", "v3-from-reader");
    expect(updated.rev).toBe(3);
    expect(updated.clock).toEqual({ "cli:writer": 2, "desktop:reader": 1 });
    reader.close();
  });
});

// ===========================================================================
// Corruption
// ===========================================================================

describe("corruption: domain segment", () => {
  it("truncated/garbage segment is quarantined, rebuilt from the journal, and reported via WorkspaceCorruptError", () => {
    const store = mkStore();
    store.put("memory", "a", "alpha");
    store.put("memory", "b", "beta");
    store.close();

    const segmentPath = join(root, "domains", "memory.json");
    writeFileSync(segmentPath, "{not even close to json", "utf8");

    const reopened = mkStore({ actor: { kind: "test", id: "verifier" } });
    let caught: unknown;
    try {
      reopened.get("memory", "a");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceCorruptError);
    const quarantinePath = (caught as WorkspaceCorruptError).quarantinePath;
    expect(existsSync(quarantinePath)).toBe(true);
    expect(readFileSync(quarantinePath, "utf8")).toContain("not even close to json");

    // Self-healed: the NEXT call succeeds and recovers the true data from the journal.
    expect(reopened.get("memory", "a")!.value).toBe("alpha");
    expect(reopened.get("memory", "b")!.value).toBe("beta");
    reopened.close();
  });

  it("a segment whose stored hash does not match its recomputed hash is treated as corrupt", () => {
    const store = mkStore();
    store.put("memory", "a", "alpha");
    store.close();

    const segmentPath = join(root, "domains", "memory.json");
    const parsed = JSON.parse(readFileSync(segmentPath, "utf8"));
    parsed.records[0].value = "TAMPERED";
    writeFileSync(segmentPath, JSON.stringify(parsed), "utf8");

    const reopened = mkStore({ actor: { kind: "test", id: "verifier" } });
    expect(() => reopened.get("memory", "a")).toThrow(WorkspaceCorruptError);
    expect(reopened.get("memory", "a")!.value).toBe("alpha"); // recovered from journal, not the tampered value
    reopened.close();
  });

  it("a stray .tmp sibling from a writer killed between tmp-write and rename never becomes visible (no partial state)", () => {
    const store = mkStore();
    store.put("memory", "a", "real-value");
    store.close();

    // Simulate exactly the crash window: a tmp file was written but the
    // rename that would have made it visible never happened.
    const segmentPath = join(root, "domains", "memory.json");
    const strayTmp = `${segmentPath}.tmp-99999-deadbeef`;
    writeFileSync(strayTmp, "garbage-partial-write-not-json", "utf8");

    const reopened = mkStore({ actor: { kind: "test", id: "verifier" } });
    // The real segment is untouched; the stray tmp file is simply never read.
    expect(reopened.get("memory", "a")!.value).toBe("real-value");
    expect(existsSync(strayTmp)).toBe(true); // still there, but inert
    reopened.close();
  });
});

describe("corruption: journal", () => {
  it("a hand-edited (garbage) mid-file journal line is quarantined; the surviving valid prefix is kept and reported", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.put("memory", "c", 3);
    store.close();

    const journalPath = join(root, "journal.log");
    const lines = readFileSync(journalPath, "utf8").trimEnd().split("\n");
    lines[1] = "{this is not valid json at all";
    writeFileSync(journalPath, lines.join("\n") + "\n", "utf8");

    const reopened = mkStore({ actor: { kind: "test", id: "verifier" } });
    let caught: unknown;
    try {
      reopened.journalSince(0);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceCorruptError);
    const quarantinePath = (caught as WorkspaceCorruptError).quarantinePath;
    expect(existsSync(quarantinePath)).toBe(true);

    // Self-healed: only the valid PREFIX (the first entry) survives.
    const survivors = reopened.journalSince(0);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].records[0].key).toBe("a");
    reopened.close();
  });

  it("a torn FINAL journal line (writer killed mid-append) is silently dropped — no error, no partial state", () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.close();

    const journalPath = join(root, "journal.log");
    const full = readFileSync(journalPath, "utf8");
    // Simulate a write() that got cut off mid-object, no trailing newline.
    const torn = full + '{"seq":3,"at":123,"actor":"cli:alice","prevHash":"abc123';
    writeFileSync(journalPath, torn, "utf8");

    const reopened = mkStore({ actor: { kind: "test", id: "verifier" } });
    const entries = reopened.journalSince(0);
    expect(entries).toHaveLength(2); // torn trailing entry silently dropped
    expect(reopened.verifyChain()).toEqual({ ok: true });

    // The store remains fully writable afterward, and the next append lands cleanly.
    const r = reopened.put("memory", "c", 3);
    expect(r.rev).toBe(1);
    expect(reopened.journalSince(0)).toHaveLength(3);
    expect(reopened.verifyChain().ok).toBe(true);
    reopened.close();
  });
});

// ===========================================================================
// Adversarial locking
// ===========================================================================

describe("locking: timeout and stale-lock reclamation", () => {
  const lockDir = () => join(root, ".lock");

  it("throws WorkspaceLockError when a live, fresh lock is held past lockTimeoutMs", () => {
    const store = mkStore({ lockTimeoutMs: 120, staleLockMs: 60_000 });
    store.put("memory", "warm-up", 1); // ensure manifest/journal already exist, isolating the lock check

    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "holder.json"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");

    expect(() => store.put("memory", "k", 1)).toThrow(WorkspaceLockError);
  });

  it("reclaims a lock whose recorded pid is dead, even before staleLockMs elapses", () => {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid!;
    expect(typeof deadPid).toBe("number");

    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "holder.json"), JSON.stringify({ pid: deadPid, acquiredAt: Date.now() }), "utf8");

    const store = mkStore({ lockTimeoutMs: 2000, staleLockMs: 60_000 });
    const r = store.put("memory", "k", "reclaimed");
    expect(r.value).toBe("reclaimed");
    store.close();
  });

  it("does NOT reclaim a hostile .lock with garbage holder.json while it is still fresh (times out instead)", () => {
    const store = mkStore({ lockTimeoutMs: 120, staleLockMs: 60_000 });
    store.put("memory", "warm-up", 1); // ensure manifest/journal already exist, isolating the lock check

    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "holder.json"), "not-json-at-all{{{", "utf8");

    expect(() => store.put("memory", "k", 1)).toThrow(WorkspaceLockError);
  });

  it("reclaims a hostile .lock with garbage holder.json once its mtime exceeds staleLockMs", async () => {
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "holder.json"), "not-json-at-all{{{", "utf8");
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockDir(), old, old);

    const store = mkStore({ lockTimeoutMs: 2000, staleLockMs: 50 });
    const r = store.put("memory", "k", "reclaimed-by-age");
    expect(r.value).toBe("reclaimed-by-age");
    store.close();
  });

  it("a missing .lock/holder.json (bare hostile directory) falls back to mtime staleness without crashing", () => {
    mkdirSync(lockDir());
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockDir(), old, old);

    const store = mkStore({ lockTimeoutMs: 2000, staleLockMs: 50 });
    const r = store.put("memory", "k", "reclaimed-no-holder-file");
    expect(r.value).toBe("reclaimed-no-holder-file");
    store.close();
  });
});

// ===========================================================================
// Concurrency: two independent in-process WorkspaceStore instances, interleaved
// ===========================================================================

describe("concurrency: two independent in-process instances interleaved", () => {
  it("writes to DIFFERENT keys from two stores are both durably observable afterward", () => {
    const a = mkStore({ actor: { kind: "cli", id: "a" } });
    const b = mkStore({ actor: { kind: "desktop", id: "b" } });

    for (let i = 0; i < 25; i++) {
      a.put("memory", `a-${i}`, i);
      b.put("memory", `b-${i}`, i);
    }
    a.close();
    b.close();

    const verifier = mkStore({ actor: { kind: "test", id: "v" } });
    expect(verifier.list("memory")).toHaveLength(50);
    expect(verifier.verifyChain().ok).toBe(true);
    verifier.close();
  });

  it("interleaved writes to the SAME key from two store instances converge to one consistent, hash-valid record", () => {
    const a = mkStore({ actor: { kind: "cli", id: "a" } });
    const b = mkStore({ actor: { kind: "desktop", id: "b" } });

    let aWrites = 0;
    let bWrites = 0;
    for (let i = 0; i < 15; i++) {
      a.put("memory", "race", { writer: "a", i });
      aWrites++;
      b.put("memory", "race", { writer: "b", i });
      bWrites++;
    }

    const finalFromA = a.get("memory", "race")!;
    const finalFromB = b.get("memory", "race")!;
    // Both stores read the SAME durable file — must observe an identical record.
    expect(finalFromA).toEqual(finalFromB);
    expect(finalFromA.rev).toBe(aWrites + bWrites);
    expect(finalFromA.clock).toEqual({ "cli:a": aWrites, "desktop:b": bWrites });

    const { hash, ...rest } = finalFromA;
    expect(recordHash(rest)).toBe(hash);

    a.close();
    b.close();
  });
});

// ===========================================================================
// Concurrency: real child processes writing to the same store root
// ===========================================================================

describe("concurrency: genuine cross-process writers", () => {
  it("two real child processes hammering the same key converge to a single, hash-valid, chain-valid record", async () => {
    const writesPerChild = 12;
    const scriptPath = join(root, "..", `worker-${Math.random().toString(36).slice(2)}.mts`);
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(
      scriptPath,
      `
      import { WorkspaceStore } from ${JSON.stringify(STORE_TS_PATH)};
      const [, , storeRoot, actorId, countStr] = process.argv;
      const store = new WorkspaceStore({ root: storeRoot, actor: { kind: "cli", id: actorId } });
      for (let i = 0; i < Number(countStr); i++) {
        store.put("memory", "race-key", { writer: actorId, i });
      }
      store.close();
      `,
      "utf8",
    );

    function runChild(actorId: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [TSX_CLI, scriptPath, root, actorId, String(writesPerChild)], {
          stdio: "inherit",
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`child ${actorId} exited with code ${code}`));
        });
      });
    }

    await Promise.all([runChild("procA"), runChild("procB")]);

    const verifier = mkStore({ actor: { kind: "test", id: "verifier" } });
    const final = verifier.get("memory", "race-key")!;
    expect(final.rev).toBe(writesPerChild * 2);
    expect(final.clock).toEqual({ "cli:procA": writesPerChild, "cli:procB": writesPerChild });
    const { hash, ...rest } = final;
    expect(recordHash(rest)).toBe(hash);
    expect(verifier.verifyChain().ok).toBe(true);
    verifier.close();
  }, 60_000);
});

// ===========================================================================
// journalMaxEntries (auto-compaction)
// ===========================================================================

describe("journalMaxEntries auto-compaction", () => {
  it("automatically compacts once the journal exceeds journalMaxEntries", () => {
    const store = mkStore({ journalMaxEntries: 3 });
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.put("memory", "c", 3);
    expect(store.journalSince(0)).toHaveLength(3); // not yet over the threshold

    store.put("memory", "d", 4); // 4th entry pushes it over -> auto-compacts
    const entries = store.journalSince(0);
    expect(entries).toHaveLength(1); // collapsed to a checkpoint
    expect(entries[0].records.map((r) => r.key).sort()).toEqual(["a", "b", "c", "d"]);
    store.close();
  });

  it("never auto-compacts when journalMaxEntries is left unset", () => {
    const store = mkStore();
    for (let i = 0; i < 10; i++) store.put("memory", `k${i}`, i);
    expect(store.journalSince(0)).toHaveLength(10);
    store.close();
  });
});
