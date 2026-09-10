import { describe, it, expect } from "vitest";

import {
  WORKSPACE_DOMAINS,
  WORKSPACE_STATE_VERSION,
  isWorkspaceDomain,
  actorKey,
  parseActorKey,
  tickClock,
  mergeClocks,
  compareClocks,
  canonicalJson,
  CanonicalJsonError,
  recordHash,
  isWorkspaceRecord,
  validateKey,
  InvalidKeyError,
  mergeRecords,
  type WorkspaceRecord,
  type VersionVector,
  type ActorId,
} from "../record";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLI: ActorId = { kind: "cli", id: "alice" };
const DESKTOP: ActorId = { kind: "desktop", id: "bob" };

function mkLive(overrides: Partial<Omit<WorkspaceRecord, "hash">> = {}): WorkspaceRecord {
  const body: Omit<WorkspaceRecord, "hash"> = {
    domain: "memory",
    key: "fact-1",
    rev: 1,
    clock: { "cli:alice": 1 },
    updatedAt: 1000,
    actor: "cli:alice",
    deleted: false,
    value: { text: "hello" },
    ...overrides,
  };
  return { ...body, hash: recordHash(body) };
}

function mkTombstone(overrides: Partial<Omit<WorkspaceRecord, "hash" | "deleted" | "value">> = {}): WorkspaceRecord {
  const body: Omit<WorkspaceRecord, "hash"> = {
    domain: "memory",
    key: "fact-1",
    rev: 2,
    clock: { "cli:alice": 2 },
    updatedAt: 2000,
    actor: "cli:alice",
    deleted: true,
    value: null,
    ...overrides,
  };
  return { ...body, hash: "" };
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

describe("WORKSPACE_DOMAINS / isWorkspaceDomain", () => {
  it("has exactly the four locked domains", () => {
    expect(WORKSPACE_DOMAINS).toEqual(["sessions", "skills", "memory", "config"]);
  });

  it("accepts every domain and version constant", () => {
    for (const d of WORKSPACE_DOMAINS) expect(isWorkspaceDomain(d)).toBe(true);
    expect(WORKSPACE_STATE_VERSION).toBe(1);
  });

  it("rejects non-domain strings and non-strings", () => {
    expect(isWorkspaceDomain("sessionz")).toBe(false);
    expect(isWorkspaceDomain("")).toBe(false);
    expect(isWorkspaceDomain(42)).toBe(false);
    expect(isWorkspaceDomain(null)).toBe(false);
    expect(isWorkspaceDomain(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

describe("actorKey / parseActorKey", () => {
  it("round-trips a simple actor", () => {
    const k = actorKey(CLI);
    expect(k).toBe("cli:alice");
    expect(parseActorKey(k)).toEqual(CLI);
  });

  it("round-trips an id that itself contains colons (splits on the FIRST colon only)", () => {
    const id: ActorId = { kind: "sidecar", id: "uuid:1234:5678" };
    const k = actorKey(id);
    expect(k).toBe("sidecar:uuid:1234:5678");
    expect(parseActorKey(k)).toEqual(id);
  });

  it("rejects an unrecognized kind", () => {
    expect(parseActorKey("browser:eve")).toBeNull();
  });

  it("rejects a missing/empty id", () => {
    expect(parseActorKey("cli:")).toBeNull();
    expect(parseActorKey("cli")).toBeNull();
  });

  it("rejects garbage / non-string input without throwing", () => {
    expect(parseActorKey("")).toBeNull();
    expect(parseActorKey(":noKind")).toBeNull();
    // @ts-expect-error deliberate runtime misuse
    expect(parseActorKey(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Version vectors
// ---------------------------------------------------------------------------

describe("tickClock", () => {
  it("advances an absent key to 1 without mutating the input", () => {
    const c0: VersionVector = {};
    const c1 = tickClock(c0, "cli:alice");
    expect(c1).toEqual({ "cli:alice": 1 });
    expect(c0).toEqual({});
  });

  it("advances an existing key by exactly one, repeatedly", () => {
    let c: VersionVector = {};
    for (let i = 1; i <= 5; i++) {
      c = tickClock(c, "cli:alice");
      expect(c["cli:alice"]).toBe(i);
    }
  });

  it("does not disturb other actors' entries", () => {
    const c0: VersionVector = { "cli:alice": 3, "desktop:bob": 7 };
    const c1 = tickClock(c0, "cli:alice");
    expect(c1).toEqual({ "cli:alice": 4, "desktop:bob": 7 });
  });
});

describe("mergeClocks", () => {
  it("takes the entrywise max and never mutates inputs", () => {
    const a: VersionVector = { "cli:alice": 3, "desktop:bob": 1 };
    const b: VersionVector = { "cli:alice": 1, "desktop:bob": 5, "tui:carol": 2 };
    const merged = mergeClocks(a, b);
    expect(merged).toEqual({ "cli:alice": 3, "desktop:bob": 5, "tui:carol": 2 });
    expect(a).toEqual({ "cli:alice": 3, "desktop:bob": 1 });
    expect(b).toEqual({ "cli:alice": 1, "desktop:bob": 5, "tui:carol": 2 });
  });

  it("is idempotent and commutative", () => {
    const a: VersionVector = { "cli:alice": 3 };
    const b: VersionVector = { "desktop:bob": 5 };
    expect(mergeClocks(a, b)).toEqual(mergeClocks(b, a));
    expect(mergeClocks(a, a)).toEqual(a);
  });
});

describe("compareClocks", () => {
  it("returns equal for two empty clocks and for identical clocks", () => {
    expect(compareClocks({}, {})).toBe("equal");
    expect(compareClocks({ "cli:alice": 2 }, { "cli:alice": 2 })).toBe("equal");
  });

  it("returns after when a strictly dominates b, and before for the mirror", () => {
    const a: VersionVector = { "cli:alice": 3, "desktop:bob": 2 };
    const b: VersionVector = { "cli:alice": 1, "desktop:bob": 2 };
    expect(compareClocks(a, b)).toBe("after");
    expect(compareClocks(b, a)).toBe("before");
  });

  it("returns concurrent when neither side dominates", () => {
    const a: VersionVector = { "cli:alice": 3, "desktop:bob": 0 };
    const b: VersionVector = { "cli:alice": 1, "desktop:bob": 2 };
    expect(compareClocks(a, b)).toBe("concurrent");
    expect(compareClocks(b, a)).toBe("concurrent");
  });

  it("treats a missing key as 0", () => {
    expect(compareClocks({ "cli:alice": 1 }, {})).toBe("after");
    expect(compareClocks({}, { "cli:alice": 1 })).toBe("before");
  });
});

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

describe("canonicalJson", () => {
  it("sorts object keys at every nesting level regardless of insertion order", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array element order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("round-trips primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-5)).toBe("-5");
  });

  it("two structurally identical values always produce byte-identical output", () => {
    const v1 = { z: [1, { m: "x", a: "y" }], a: 1 };
    const v2 = { a: 1, z: [1, { a: "y", m: "x" }] };
    expect(canonicalJson(v1)).toBe(canonicalJson(v2));
  });

  it("throws CanonicalJsonError on NaN", () => {
    expect(() => canonicalJson(NaN)).toThrow(CanonicalJsonError);
  });

  it("throws CanonicalJsonError on Infinity and -Infinity", () => {
    expect(() => canonicalJson(Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(-Infinity)).toThrow(CanonicalJsonError);
  });

  it("throws CanonicalJsonError on -0 (ambiguous with 0)", () => {
    expect(() => canonicalJson(-0)).toThrow(CanonicalJsonError);
  });

  it("throws CanonicalJsonError on undefined, at top level and nested", () => {
    // @ts-expect-error deliberate runtime misuse
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    // @ts-expect-error deliberate runtime misuse
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
  });

  it("throws CanonicalJsonError on bigint", () => {
    // @ts-expect-error deliberate runtime misuse
    expect(() => canonicalJson(1n)).toThrow(CanonicalJsonError);
  });

  it("throws CanonicalJsonError on a self-referential array", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    // @ts-expect-error deliberate runtime misuse
    expect(() => canonicalJson(arr)).toThrow(CanonicalJsonError);
  });

  it("throws CanonicalJsonError on a self-referential object", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    // @ts-expect-error deliberate runtime misuse
    expect(() => canonicalJson(obj)).toThrow(CanonicalJsonError);
  });

  it("does NOT throw for the same object reused (not circular) at two sibling positions", () => {
    const shared = { x: 1 };
    expect(() => canonicalJson({ a: shared, b: shared })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recordHash
// ---------------------------------------------------------------------------

describe("recordHash", () => {
  it("hashes a tombstone as the empty string regardless of its other fields", () => {
    const t1 = mkTombstone();
    const t2 = mkTombstone({ rev: 99, updatedAt: 123456 });
    expect(recordHash({ ...t1 })).toBe("");
    expect(recordHash({ ...t2 })).toBe("");
  });

  it("produces a 64-char lowercase hex sha256 for a live record", () => {
    const r = mkLive();
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical inputs", () => {
    const body: Omit<WorkspaceRecord, "hash"> = {
      domain: "config",
      key: "theme",
      rev: 4,
      clock: { "cli:alice": 4, "desktop:bob": 2 },
      updatedAt: 5555,
      actor: "cli:alice",
      deleted: false,
      value: "dark",
    };
    expect(recordHash(body)).toBe(recordHash({ ...body }));
  });

  it("is insensitive to clock key insertion order (canonicalJson sorts)", () => {
    const base: Omit<WorkspaceRecord, "hash"> = {
      domain: "config",
      key: "theme",
      rev: 1,
      clock: { "cli:alice": 1, "desktop:bob": 1 },
      updatedAt: 1,
      actor: "cli:alice",
      deleted: false,
      value: 1,
    };
    const reordered: Omit<WorkspaceRecord, "hash"> = { ...base, clock: { "desktop:bob": 1, "cli:alice": 1 } };
    expect(recordHash(base)).toBe(recordHash(reordered));
  });

  it("changes when any single field changes", () => {
    const base = mkLive();
    const variants: WorkspaceRecord[] = [
      mkLive({ key: "fact-2" }),
      mkLive({ rev: 2 }),
      mkLive({ clock: { "cli:alice": 2 } }),
      mkLive({ updatedAt: 1001 }),
      mkLive({ actor: "desktop:bob" }),
      mkLive({ value: { text: "different" } }),
    ];
    for (const v of variants) {
      expect(v.hash).not.toBe(base.hash);
    }
  });
});

// ---------------------------------------------------------------------------
// validateKey
// ---------------------------------------------------------------------------

describe("validateKey", () => {
  it("accepts a normal ascii key", () => {
    expect(() => validateKey("agent.notes")).not.toThrow();
  });

  it("accepts unicode and emoji keys within the byte budget", () => {
    expect(() => validateKey("café-🚀-note")).not.toThrow();
  });

  it("throws InvalidKeyError on an empty key", () => {
    expect(() => validateKey("")).toThrow(InvalidKeyError);
  });

  it("throws InvalidKeyError on a key over 256 UTF-8 bytes", () => {
    const longKey = "x".repeat(257);
    expect(() => validateKey(longKey)).toThrow(InvalidKeyError);
    // exactly 256 ascii bytes is fine
    expect(() => validateKey("x".repeat(256))).not.toThrow();
  });

  it("throws InvalidKeyError when the UTF-8 byte length (not char length) exceeds the budget", () => {
    // Each of these emoji is 4 bytes in utf-8; 65 of them = 260 bytes > 256
    const key = "\u{1F680}".repeat(65);
    expect(key.length).toBeLessThan(257); // char length alone would pass a naive check
    expect(() => validateKey(key)).toThrow(InvalidKeyError);
  });

  it("throws InvalidKeyError on path separators", () => {
    expect(() => validateKey("a/b")).toThrow(InvalidKeyError);
    expect(() => validateKey("a\\b")).toThrow(InvalidKeyError);
  });

  it("throws InvalidKeyError on a NUL byte", () => {
    expect(() => validateKey("a b")).toThrow(InvalidKeyError);
  });

  it('throws InvalidKeyError on "." and ".."', () => {
    expect(() => validateKey(".")).toThrow(InvalidKeyError);
    expect(() => validateKey("..")).toThrow(InvalidKeyError);
  });

  it("does not reject a key that merely CONTAINS .. as a substring", () => {
    expect(() => validateKey("a..b")).not.toThrow();
    expect(() => validateKey("../etc/passwd")).toThrow(InvalidKeyError); // caught by "/" rule instead
  });

  it("throws InvalidKeyError on control characters", () => {
    expect(() => validateKey("a\tb")).toThrow(InvalidKeyError);
    expect(() => validateKey("a\nb")).toThrow(InvalidKeyError);
    expect(() => validateKey(`a${String.fromCharCode(0x7f)}b`)).toThrow(InvalidKeyError);
  });
});

// ---------------------------------------------------------------------------
// isWorkspaceRecord
// ---------------------------------------------------------------------------

describe("isWorkspaceRecord", () => {
  it("accepts a well-formed live record and a well-formed tombstone", () => {
    expect(isWorkspaceRecord(mkLive())).toBe(true);
    expect(isWorkspaceRecord(mkTombstone())).toBe(true);
  });

  it("rejects non-objects, null, and arrays", () => {
    expect(isWorkspaceRecord(null)).toBe(false);
    expect(isWorkspaceRecord(42)).toBe(false);
    expect(isWorkspaceRecord("record")).toBe(false);
    expect(isWorkspaceRecord([mkLive()])).toBe(false);
  });

  it("rejects an invalid domain", () => {
    const r = { ...mkLive(), domain: "not-a-domain" };
    expect(isWorkspaceRecord(r)).toBe(false);
  });

  it("rejects an invalid key (fails validateKey)", () => {
    const r = { ...mkLive(), key: "../escape" };
    expect(isWorkspaceRecord(r)).toBe(false);
  });

  it("rejects rev <= 0 or non-integer rev", () => {
    expect(isWorkspaceRecord({ ...mkLive(), rev: 0 })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), rev: -1 })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), rev: 1.5 })).toBe(false);
  });

  it("rejects a malformed clock (bad key, negative/non-integer value)", () => {
    expect(isWorkspaceRecord({ ...mkLive(), clock: { "not-an-actor-key": 1 } })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), clock: { "cli:alice": -1 } })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), clock: { "cli:alice": 1.5 } })).toBe(false);
  });

  it("rejects a negative, non-finite, or non-integer updatedAt", () => {
    expect(isWorkspaceRecord({ ...mkLive(), updatedAt: -1 })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), updatedAt: NaN })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), updatedAt: 1.5 })).toBe(false);
  });

  it("rejects an actor that doesn't round-trip through parseActorKey", () => {
    expect(isWorkspaceRecord({ ...mkLive(), actor: "not-an-actor" })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), actor: "browser:eve" })).toBe(false);
  });

  it("rejects a non-boolean deleted", () => {
    expect(isWorkspaceRecord({ ...mkLive(), deleted: "false" })).toBe(false);
  });

  it("rejects a tombstone with a non-empty hash, and a live record with a malformed hash", () => {
    expect(isWorkspaceRecord({ ...mkTombstone(), hash: "abc" })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), hash: "not-hex" })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), hash: "aa" })).toBe(false); // too short
  });

  it("rejects a tombstone whose value is not null", () => {
    expect(isWorkspaceRecord({ ...mkTombstone(), value: {} })).toBe(false);
  });

  it("rejects a live record whose value contains NaN/-0/undefined (not a strict JsonValue)", () => {
    expect(isWorkspaceRecord({ ...mkLive(), value: { n: NaN } })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), value: { n: -0 } })).toBe(false);
    expect(isWorkspaceRecord({ ...mkLive(), value: { n: Infinity } })).toBe(false);
  });

  it("accepts a live record whose value is a JSON null (distinct from a tombstone)", () => {
    const body: Omit<WorkspaceRecord, "hash"> = {
      domain: "memory",
      key: "k",
      rev: 1,
      clock: { "cli:alice": 1 },
      updatedAt: 1,
      actor: "cli:alice",
      deleted: false,
      value: null,
    };
    const r: WorkspaceRecord = { ...body, hash: recordHash(body) };
    expect(isWorkspaceRecord(r)).toBe(true);
  });

  it("does NOT verify the hash actually matches the value (shape-only guard)", () => {
    const r = { ...mkLive(), value: { text: "tampered but same shape" } };
    // hash still looks like a valid sha256 hex string, so shape validation passes
    expect(isWorkspaceRecord(r)).toBe(true);
    // but it no longer matches recordHash of the tampered body
    const { hash, ...rest } = r;
    expect(recordHash(rest)).not.toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// mergeRecords
// ---------------------------------------------------------------------------

describe("mergeRecords", () => {
  it("throws RangeError when local/remote reference different domain or key", () => {
    const a = mkLive({ domain: "memory", key: "k1" });
    const b = mkLive({ domain: "memory", key: "k2" });
    expect(() => mergeRecords(a, b)).toThrow(RangeError);
    const c = mkLive({ domain: "config", key: "k1" });
    expect(() => mergeRecords(a, c)).toThrow(RangeError);
  });

  it("local-newer: local's clock causally dominates remote's — local returned completely unchanged", () => {
    const remote = mkLive({ clock: { "cli:alice": 1 }, rev: 1, updatedAt: 100 });
    const local = mkLive({ clock: { "cli:alice": 2 }, rev: 2, updatedAt: 200 });
    const { winner, reason } = mergeRecords(local, remote);
    expect(reason).toBe("local-newer");
    expect(winner).toBe(local); // exact same reference — no rewrite
  });

  it("remote-newer: remote's clock causally dominates local's — remote returned completely unchanged", () => {
    const local = mkLive({ clock: { "cli:alice": 1 }, rev: 1, updatedAt: 100 });
    const remote = mkLive({ clock: { "cli:alice": 2 }, rev: 2, updatedAt: 200 });
    const { winner, reason } = mergeRecords(local, remote);
    expect(reason).toBe("remote-newer");
    expect(winner).toBe(remote);
  });

  it("identical: equal clocks and byte-identical content return local unchanged", () => {
    const clock: VersionVector = { "cli:alice": 3 };
    const local = mkLive({ clock, rev: 3, updatedAt: 300 });
    const remote = mkLive({ clock, rev: 3, updatedAt: 300 });
    const { winner, reason } = mergeRecords(local, remote);
    expect(reason).toBe("identical");
    expect(winner).toBe(local);
  });

  it("concurrent-tiebreak: a tombstone always beats a concurrent live record, regardless of updatedAt", () => {
    const clockA: VersionVector = { "cli:alice": 2, "desktop:bob": 1 };
    const clockB: VersionVector = { "cli:alice": 1, "desktop:bob": 2 };
    const live = mkLive({ clock: clockA, rev: 2, updatedAt: 999999 }); // much newer updatedAt
    const tombstone = mkTombstone({ clock: clockB, rev: 2, updatedAt: 1 }); // much older updatedAt
    expect(compareClocks(clockA, clockB)).toBe("concurrent");

    const { winner, reason } = mergeRecords(live, tombstone);
    expect(reason).toBe("concurrent-tiebreak");
    expect(winner.deleted).toBe(true);
    expect(winner.hash).toBe("");
    expect(winner.clock).toEqual(mergeClocks(clockA, clockB));
    expect(winner.rev).toBe(Math.max(live.rev, tombstone.rev) + 1);

    // symmetric: order of arguments must not matter for who wins
    const swapped = mergeRecords(tombstone, live);
    expect(swapped.winner.deleted).toBe(true);
    expect(swapped.reason).toBe("concurrent-tiebreak");
  });

  it("concurrent-tiebreak: among two live records, higher updatedAt wins", () => {
    const clockA: VersionVector = { "cli:alice": 2, "desktop:bob": 1 };
    const clockB: VersionVector = { "cli:alice": 1, "desktop:bob": 2 };
    const older = mkLive({ clock: clockA, rev: 5, updatedAt: 100, value: "older" });
    const newer = mkLive({ clock: clockB, rev: 3, updatedAt: 200, value: "newer" });

    const { winner, reason } = mergeRecords(older, newer);
    expect(reason).toBe("concurrent-tiebreak");
    expect(winner.value).toBe("newer");
    expect(winner.rev).toBe(Math.max(older.rev, newer.rev) + 1);
    expect(winner.clock).toEqual(mergeClocks(clockA, clockB));
    // the rewritten winner's own hash must authenticate its own (new) fields
    const { hash, ...rest } = winner;
    expect(recordHash(rest)).toBe(hash);
  });

  it("concurrent-tiebreak: equal updatedAt falls through to lexicographically greater hash", () => {
    const clockA: VersionVector = { "cli:alice": 2, "desktop:bob": 1 };
    const clockB: VersionVector = { "cli:alice": 1, "desktop:bob": 2 };
    const a = mkLive({ clock: clockA, rev: 1, updatedAt: 500, value: "aaa" });
    const b = mkLive({ clock: clockB, rev: 1, updatedAt: 500, value: "zzz-different-enough-to-change-hash" });
    expect(a.hash).not.toBe(b.hash);

    const { winner } = mergeRecords(a, b);
    const expectedContent = a.hash > b.hash ? a : b;
    expect(winner.value).toBe(expectedContent.value);
  });

  it("concurrent-tiebreak: equal updatedAt and equal hash falls through to lexicographically greater actor", () => {
    // recordHash's own body includes `actor`, so two honestly-hashed records
    // from different actors can never collide on hash in practice — this
    // exercises the final tie-break rung directly by forcing equal `hash`
    // strings on two records with different actors (as a hash collision or
    // an adversarial peer might present), so the total order still resolves
    // deterministically instead of falling through unhandled.
    const clockA: VersionVector = { "cli:alice": 2, "desktop:bob": 1 };
    const clockB: VersionVector = { "cli:alice": 1, "desktop:bob": 2 };
    const forcedHash = "f".repeat(64);
    const a: WorkspaceRecord = {
      domain: "memory",
      key: "fact-1",
      rev: 1,
      clock: clockA,
      updatedAt: 500,
      actor: "cli:alice",
      deleted: false,
      value: "same",
      hash: forcedHash,
    };
    const b: WorkspaceRecord = { ...a, clock: clockB, actor: "desktop:bob" };
    expect(a.hash).toBe(b.hash);
    expect(compareClocks(a.clock, b.clock)).toBe("concurrent");

    const { winner, reason } = mergeRecords(a, b);
    expect(reason).toBe("concurrent-tiebreak");
    const expectedActor = a.actor > b.actor ? a.actor : b.actor;
    expect(winner.actor).toBe(expectedActor);
  });

  it("defensive: equal clocks with divergent content are resolved via the same tie-break, not treated as identical", () => {
    const clock: VersionVector = { "cli:alice": 5 };
    const a = mkLive({ clock, rev: 5, updatedAt: 10, value: "a" });
    const b = mkLive({ clock, rev: 5, updatedAt: 20, value: "b" });
    const { winner, reason } = mergeRecords(a, b);
    expect(reason).toBe("concurrent-tiebreak");
    expect(winner.value).toBe("b"); // higher updatedAt
    expect(winner.rev).toBe(6);
  });
});
