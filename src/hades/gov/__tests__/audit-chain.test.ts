import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../../styx/certificate";
import { GovIdentity, govDigest } from "../identity";
import { consistencyProof, merkleRoot, verifyConsistency } from "../audit-proof";
import { AuditLog } from "../../security/audit";
import {
  GOV_AUDIT_GENESIS,
  GOV_AUDIT_SCHEMA,
  GovAuditChain,
  fromLegacyAuditEvent,
  type AppendInput,
  type GovAuditEntry,
} from "../audit-chain";

// ---------------------------------------------------------------------------
// Deterministic RNG for reproducible key generation.
// ---------------------------------------------------------------------------

function seededRng(seed: number): (n: number) => Uint8Array {
  let s = seed >>> 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      out[i] = s & 0xff;
    }
    return out;
  };
}

function fixedClock(t: number): () => number {
  let now = t;
  return () => now++;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gov-audit-chain-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Raw disk helpers — used by the tamper tests to attack the chain's OWN
// on-disk bytes exactly the way an attacker with filesystem write access
// (but no signing key) would.
// ---------------------------------------------------------------------------

function segFile(chainDir: string, index = 0): string {
  return join(chainDir, "audit", `seg-${String(index).padStart(6, "0")}.jsonl`);
}

function readRawLines(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function writeRawLines(path: string, lines: readonly string[]): void {
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

function readRawEntries(path: string): GovAuditEntry[] {
  return readRawLines(path).map((l) => JSON.parse(l) as GovAuditEntry);
}

/**
 * Reimplementation of `audit-chain.ts`'s private canonical serialization —
 * duplicated deliberately (not imported) because a byte-level forger, by
 * definition, does not get to call into the module under test; they must
 * reconstruct the hash the same way the real module does from first
 * principles (the LOCKED fixed field order documented in the task contract).
 */
function canonicalMetaStringForTest(meta: GovAuditEntry["meta"]): string {
  if (meta === undefined) return "null";
  const keys = Object.keys(meta).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify((meta as Record<string, unknown>)[k])).join(",") + "}";
}
function canonicalEntryStringForTest(e: Omit<GovAuditEntry, "entrySha256">): string {
  return (
    "{" +
    `"seq":${JSON.stringify(e.seq)},` +
    `"at":${JSON.stringify(e.at)},` +
    `"actor":${JSON.stringify(e.actor)},` +
    `"action":${JSON.stringify(e.action)},` +
    `"resource":${JSON.stringify(e.resource)},` +
    `"outcome":${JSON.stringify(e.outcome)},` +
    `"code":${e.code !== undefined ? JSON.stringify(e.code) : "null"},` +
    `"payloadSha256":${JSON.stringify(e.payloadSha256)},` +
    `"meta":${canonicalMetaStringForTest(e.meta)},` +
    `"prevSha256":${JSON.stringify(e.prevSha256)}` +
    "}"
  );
}
function recomputeHash(e: Omit<GovAuditEntry, "entrySha256">): string {
  return sha256Hex(canonicalEntryStringForTest(e));
}

function seedAppend(overrides: Partial<AppendInput> = {}, i = 0): AppendInput {
  return {
    at: 1000 + i,
    actor: `agent:${i}`,
    action: "authorize",
    resource: `resource-${i}`,
    outcome: "allow",
    ...overrides,
  };
}

function seedChain(chain: GovAuditChain, n: number): GovAuditEntry[] {
  const out: GovAuditEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push(chain.append(seedAppend({}, i)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema / genesis
// ---------------------------------------------------------------------------

describe("GOV_AUDIT_SCHEMA / GOV_AUDIT_GENESIS", () => {
  it("genesis is sha256Hex(schema), and matches audit-proof's independently-computed empty-tree root", () => {
    expect(GOV_AUDIT_SCHEMA).toBe("hades.gov.audit.v1");
    expect(GOV_AUDIT_GENESIS).toBe(sha256Hex("hades.gov.audit.v1"));
    expect(GOV_AUDIT_GENESIS).toBe(merkleRoot([]));
  });
});

// ---------------------------------------------------------------------------
// Basic behavior
// ---------------------------------------------------------------------------

describe("GovAuditChain: basic append/verify/head/size", () => {
  it("starts empty: verify ok, size 0, no head", () => {
    const chain = GovAuditChain.open({ dir });
    expect(chain.size()).toBe(0);
    expect(chain.head()).toBeUndefined();
    const v = chain.verify();
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(0);
    expect(v.head).toBeUndefined();
    expect(v.failures).toEqual([]);
  });

  it("first entry chains to GOV_AUDIT_GENESIS", () => {
    const chain = GovAuditChain.open({ dir, now: fixedClock(1) });
    const e0 = chain.append(seedAppend());
    expect(e0.seq).toBe(0);
    expect(e0.prevSha256).toBe(GOV_AUDIT_GENESIS);
    expect(e0.entrySha256).toBe(recomputeHash(e0));
  });

  it("dense, strictly monotonic seq and correct hash chaining across many appends", () => {
    const chain = GovAuditChain.open({ dir });
    const entries = seedChain(chain, 25);
    for (let i = 0; i < 25; i++) {
      expect(entries[i].seq).toBe(i);
      expect(entries[i].prevSha256).toBe(i === 0 ? GOV_AUDIT_GENESIS : entries[i - 1].entrySha256);
      expect(entries[i].entrySha256).toBe(recomputeHash(entries[i]));
    }
    expect(chain.size()).toBe(25);
    expect(chain.head()).toEqual({ seq: 24, sha256: entries[24].entrySha256 });
    const v = chain.verify();
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(25);
    expect(v.head).toEqual({ seq: 24, sha256: entries[24].entrySha256 });
  });

  it("payload is hashed via payloadSha256 and never stored on disk, but the hash correctly binds it", () => {
    const chain = GovAuditChain.open({ dir });
    const secret = "super-secret-do-not-leak-1234567890";
    const entry = chain.append(seedAppend({ payload: { secret, amount: 42 } }));
    expect(entry.payloadSha256).toBe(govDigest({ secret, amount: 42 }));

    const raw = readFileSync(segFile(dir), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("amount");
    expect(raw).toContain(entry.payloadSha256);
  });

  it("payload omitted vs explicit null hash the same way, and different payloads hash differently", () => {
    const chain = GovAuditChain.open({ dir });
    const a = chain.append(seedAppend({}, 0));
    const b = chain.append(seedAppend({ payload: null }, 1));
    const c = chain.append(seedAppend({ payload: { x: 1 } }, 2));
    expect(a.payloadSha256).toBe(b.payloadSha256);
    expect(a.payloadSha256).not.toBe(c.payloadSha256);
  });

  it("meta keys are canonicalized regardless of insertion order (same content -> same hash)", () => {
    const chainA = GovAuditChain.open({ dir: join(dir, "a") });
    const chainB = GovAuditChain.open({ dir: join(dir, "b") });
    const eA = chainA.append(seedAppend({ meta: { z: 1, a: "x", m: true } }));
    const eB = chainB.append(seedAppend({ meta: { a: "x", m: true, z: 1 } }));
    expect(eA.entrySha256).toBe(eB.entrySha256);
  });

  it("rejects malformed AppendInput without corrupting chain state", () => {
    const chain = GovAuditChain.open({ dir });
    chain.append(seedAppend({}, 0));
    expect(() => chain.append(seedAppend({ outcome: "bogus" as never }, 1))).toThrow(TypeError);
    expect(() => chain.append({ ...seedAppend({}, 1), at: NaN })).toThrow(TypeError);
    // Chain state is unaffected by the rejected attempts.
    expect(chain.size()).toBe(1);
    expect(chain.verify().ok).toBe(true);
  });

  it("close() blocks further writes", () => {
    const chain = GovAuditChain.open({ dir });
    chain.append(seedAppend());
    chain.close();
    expect(() => chain.append(seedAppend({}, 1))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Comprehensiveness bar (1): byte-level tamper attacks, exact failure code
// and exact brokenAt seq, recomputed from bytes on disk.
// ---------------------------------------------------------------------------

describe("GovAuditChain: byte-level tamper attacks (recomputed from disk)", () => {
  it("flips one byte inside a middle entry's resource -> hash-mismatch at that seq", () => {
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 10);
    const lines = readRawLines(segFile(dir));
    const middle = JSON.parse(lines[4]) as GovAuditEntry;
    middle.resource = middle.resource + "X"; // single-field byte-level tamper, hash NOT recomputed
    lines[4] = JSON.stringify(middle);
    writeRawLines(segFile(dir), lines);

    const v = chain.verify();
    expect(v.ok).toBe(false);
    expect(v.entries).toBe(4);
    expect(v.brokenAt).toBe(4);
    expect(v.failures[0]).toMatchObject({ code: "hash-mismatch", seq: 4 });
  });

  it("changes a middle entry's `at` -> hash-mismatch at that seq", () => {
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 10);
    const lines = readRawLines(segFile(dir));
    const middle = JSON.parse(lines[6]) as GovAuditEntry;
    middle.at = middle.at + 1;
    lines[6] = JSON.stringify(middle);
    writeRawLines(segFile(dir), lines);

    const v = chain.verify();
    expect(v.ok).toBe(false);
    expect(v.entries).toBe(6);
    expect(v.brokenAt).toBe(6);
    expect(v.failures[0]).toMatchObject({ code: "hash-mismatch", seq: 6 });
  });

  it("deletes one line -> seq-gap at the missing seq", () => {
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 10);
    const lines = readRawLines(segFile(dir));
    lines.splice(4, 1); // delete seq 4's line entirely
    writeRawLines(segFile(dir), lines);

    const v = chain.verify();
    expect(v.ok).toBe(false);
    expect(v.entries).toBe(4);
    expect(v.brokenAt).toBe(4);
    expect(v.failures[0]).toMatchObject({ code: "seq-gap", seq: 4 });
  });

  it("duplicates a line -> seq-duplicate at the point it repeats", () => {
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 10);
    const lines = readRawLines(segFile(dir));
    lines.splice(5, 0, lines[4]); // duplicate seq 4's line right after itself
    writeRawLines(segFile(dir), lines);

    const v = chain.verify();
    expect(v.ok).toBe(false);
    expect(v.entries).toBe(5);
    expect(v.brokenAt).toBe(5);
    expect(v.failures[0]).toMatchObject({ code: "seq-duplicate", seq: 5 });
  });

  it("reorders two adjacent lines -> seq-gap at the point the order breaks", () => {
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 10);
    const lines = readRawLines(segFile(dir));
    [lines[4], lines[5]] = [lines[5], lines[4]];
    writeRawLines(segFile(dir), lines);

    const v = chain.verify();
    expect(v.ok).toBe(false);
    expect(v.entries).toBe(4);
    expect(v.brokenAt).toBe(4);
    expect(v.failures[0]).toMatchObject({ code: "seq-gap", seq: 4 });
  });

  it("a non-final malformed JSON line -> malformed-json (not truncated-record)", () => {
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 10);
    const lines = readRawLines(segFile(dir));
    lines[3] = "{not valid json,,,";
    writeRawLines(segFile(dir), lines);

    const v = chain.verify();
    expect(v.ok).toBe(false);
    expect(v.entries).toBe(3);
    expect(v.brokenAt).toBe(3);
    expect(v.failures[0]).toMatchObject({ code: "malformed-json", seq: 3 });
  });

  it("truncates the file mid-line (crash mid-write) -> truncated-record, never dropped or healed", () => {
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 5);
    // Simulate a crash: raw bytes written but the write never completed
    // (no trailing newline, invalid JSON fragment).
    appendFileSync(segFile(dir), '{"seq":5,"at":9999,"acto', "utf8");

    const v = chain.verify();
    expect(v.ok).toBe(false);
    expect(v.entries).toBe(5);
    expect(v.brokenAt).toBe(5);
    expect(v.failures[0]).toMatchObject({ code: "truncated-record", seq: 5 });

    // Reopening does not silently drop or "heal" the torn record — it's
    // still there, and still reported.
    const reopened = GovAuditChain.open({ dir });
    const v2 = reopened.verify();
    expect(v2.ok).toBe(false);
    expect(v2.failures[0]).toMatchObject({ code: "truncated-record", seq: 5 });
  });

  it("truncates the file at a clean line boundary (drops the tail) — verify() alone cannot see it; a checkpoint can", () => {
    const identity = GovIdentity.generate(seededRng(11));
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 5);
    const cp = chain.checkpoint(identity, 5000);
    expect(cp.treeSize).toBe(5);

    // Drop the last two (otherwise perfectly valid) entries.
    const lines = readRawLines(segFile(dir));
    writeRawLines(segFile(dir), lines.slice(0, 3));

    const reopened = GovAuditChain.open({ dir });
    const v = reopened.verify();
    // This is the whole point: a pure hash chain cannot distinguish "the
    // tail was legitimately never written" from "the tail was maliciously
    // dropped" — it is a perfectly valid, shorter, self-consistent chain.
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(3);

    // The checkpoint (issued BEFORE the truncation, over the true 5-entry
    // chain) catches exactly this.
    const vc = reopened.verifyAgainstCheckpoint(cp, [identity.publicKeyHex()]);
    expect(vc.ok).toBe(false);
    expect(vc.failures.some((f) => f.code === "checkpoint-regression")).toBe(true);
  });

  it("appends a well-formed forged entry with a recomputed-but-wrong prevSha256 -> link-broken", () => {
    const chain = GovAuditChain.open({ dir });
    const real = seedChain(chain, 5);
    const trueHead = real[4].entrySha256;

    const forgedFields: Omit<GovAuditEntry, "entrySha256"> = {
      seq: 5,
      at: 9999,
      actor: "attacker",
      action: "authorize",
      resource: "resource-forged",
      outcome: "allow",
      payloadSha256: sha256Hex("forged-payload"),
      prevSha256: sha256Hex("this-is-not-the-real-head"), // deliberately wrong
    };
    expect(forgedFields.prevSha256).not.toBe(trueHead);
    const forged: GovAuditEntry = { ...forgedFields, entrySha256: recomputeHash(forgedFields) };
    // The forged entry IS internally well-formed: its own entrySha256
    // correctly hashes its own (forged) fields.
    expect(recomputeHash(forged)).toBe(forged.entrySha256);

    appendFileSync(segFile(dir), JSON.stringify(forged) + "\n", "utf8");

    const v = chain.verify();
    expect(v.ok).toBe(false);
    expect(v.entries).toBe(5);
    expect(v.brokenAt).toBe(5);
    expect(v.failures[0]).toMatchObject({ code: "link-broken", seq: 5 });
  });

  it("rewrites the ENTIRE chain into a different but internally-hash-consistent history — verify() alone is fooled, checkpoint + verifyConsistency are not", () => {
    const identity = GovIdentity.generate(seededRng(22));
    const trusted = [identity.publicKeyHex()];

    const chain = GovAuditChain.open({ dir });
    const original = seedChain(chain, 6);
    const originalLeaves = original.map((e) => e.entrySha256);
    const cp = chain.checkpoint(identity, 6000);

    // Attacker rewrites history from scratch: same size, same seq
    // numbering, correct genesis + hash chain throughout, but completely
    // different content (e.g. hiding what really happened).
    let prevHash = GOV_AUDIT_GENESIS;
    const rewritten: GovAuditEntry[] = [];
    for (let i = 0; i < 6; i++) {
      const fields: Omit<GovAuditEntry, "entrySha256"> = {
        seq: i,
        at: 5000 + i,
        actor: "attacker",
        action: "cover-up",
        resource: `fabricated-${i}`,
        outcome: "allow",
        payloadSha256: sha256Hex(`fabricated-payload-${i}`),
        prevSha256: prevHash,
      };
      const entry: GovAuditEntry = { ...fields, entrySha256: recomputeHash(fields) };
      rewritten.push(entry);
      prevHash = entry.entrySha256;
    }
    writeRawLines(
      segFile(dir),
      rewritten.map((e) => JSON.stringify(e)),
    );

    const reopened = GovAuditChain.open({ dir });
    const rawVerify = reopened.verify();
    // The rewritten chain is, by construction, perfectly self-consistent —
    // this is precisely the limitation that necessitates checkpoints.
    expect(rawVerify.ok).toBe(true);
    expect(rawVerify.entries).toBe(6);

    const vc = reopened.verifyAgainstCheckpoint(cp, trusted);
    expect(vc.ok).toBe(false);
    expect(vc.failures.some((f) => f.code === "checkpoint-root-mismatch")).toBe(true);

    // And independently, at the Merkle-proof layer (bypassing GovAuditChain
    // entirely): a consistency proof from the rewritten tree against the
    // ORIGINAL checkpointed root must fail.
    const rewrittenLeaves = rewritten.map((e) => e.entrySha256);
    const newRoot = merkleRoot(rewrittenLeaves);
    const forgedProof = consistencyProof(rewrittenLeaves, cp.treeSize);
    expect(verifyConsistency(cp.root, newRoot, forgedProof)).toBe(false);
    expect(cp.root).toBe(merkleRoot(originalLeaves));
  });
});

// ---------------------------------------------------------------------------
// genesis-mismatch / schema-mismatch style structural failures
// ---------------------------------------------------------------------------

describe("GovAuditChain: structural failures", () => {
  it("entry 0 with the wrong prevSha256 -> genesis-mismatch", () => {
    const chain = GovAuditChain.open({ dir });
    chain.append(seedAppend());
    const fields: Omit<GovAuditEntry, "entrySha256"> = {
      seq: 0,
      at: 1,
      actor: "a",
      action: "b",
      resource: "c",
      outcome: "info",
      payloadSha256: sha256Hex("p"),
      prevSha256: sha256Hex("not-genesis"),
    };
    const bad: GovAuditEntry = { ...fields, entrySha256: recomputeHash(fields) };
    writeRawLines(segFile(dir), [JSON.stringify(bad)]);

    const v = chain.verify();
    expect(v.ok).toBe(false);
    expect(v.entries).toBe(0);
    expect(v.brokenAt).toBe(0);
    expect(v.failures[0]).toMatchObject({ code: "genesis-mismatch", seq: 0 });
  });

  it("a missing middle segment yields missing-segment at the correct boundary seq", () => {
    // Force tiny segments so we get several files, then delete the middle one.
    const chain = GovAuditChain.open({ dir, segmentBytes: 300 });
    seedChain(chain, 40);
    const v0 = chain.verify();
    expect(v0.ok).toBe(true);

    // Discover how many segments exist and delete a middle one's worth of
    // entries by removing that physical file.
    const seg1 = segFile(dir, 1);
    const beforeEntries = readRawEntries(seg1);
    expect(beforeEntries.length).toBeGreaterThan(0);
    rmSync(seg1);

    const reopened = GovAuditChain.open({ dir, segmentBytes: 300 });
    const v = reopened.verify();
    expect(v.ok).toBe(false);
    expect(v.failures[0].code).toBe("missing-segment");
    expect(v.failures[0].seq).toBe(beforeEntries[0].seq);
  });
});

// ---------------------------------------------------------------------------
// Refuse-to-append / no silent reset
// ---------------------------------------------------------------------------

describe("GovAuditChain: refuses to append on a tampered chain, does not silently reset", () => {
  it("append() throws, naming the first broken seq and failure code, after verifyOnOpen detects tampering", () => {
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 5);
    const lines = readRawLines(segFile(dir));
    const mid = JSON.parse(lines[2]) as GovAuditEntry;
    mid.resource = "tampered";
    lines[2] = JSON.stringify(mid);
    writeRawLines(segFile(dir), lines);

    const reopened = GovAuditChain.open({ dir });
    expect(reopened.verify().ok).toBe(false);
    expect(() => reopened.append(seedAppend({}, 99))).toThrow(/hash-mismatch/);
    expect(() => reopened.append(seedAppend({}, 99))).toThrow(/seq 2/);

    // Opening it again (simulating a process restart) does not "heal" or
    // reset it into a clean-looking new chain.
    const reopenedAgain = GovAuditChain.open({ dir });
    expect(reopenedAgain.verify().ok).toBe(false);
    expect(() => reopenedAgain.append(seedAppend({}, 99))).toThrow();
  });

  it("verifyOnOpen: false skips the refuse-to-append gate (explicit, documented opt-out)", () => {
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 3);
    const lines = readRawLines(segFile(dir));
    const mid = JSON.parse(lines[1]) as GovAuditEntry;
    mid.resource = "tampered";
    lines[1] = JSON.stringify(mid);
    writeRawLines(segFile(dir), lines);

    const reopened = GovAuditChain.open({ dir, verifyOnOpen: false });
    // Cache is derived from the best-effort prefix scan (entries before the
    // tamper point), and appends are permitted since the caller opted out.
    expect(reopened.size()).toBe(1);
    expect(() => reopened.append(seedAppend({}, 99))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Segment rolling
// ---------------------------------------------------------------------------

describe("GovAuditChain: segment rolling", () => {
  it("rolls to new segment files under a small segmentBytes, preserving dense seq and full verify()", () => {
    const chain = GovAuditChain.open({ dir, segmentBytes: 256 });
    const entries = seedChain(chain, 60);
    for (let i = 0; i < 60; i++) expect(entries[i].seq).toBe(i);

    expect(statSync(segFile(dir, 1)).size).toBeGreaterThan(0); // proves rolling actually happened

    const v = chain.verify();
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(60);
    expect(v.head).toEqual({ seq: 59, sha256: entries[59].entrySha256 });

    // Reopening from a cold state re-derives the same state from bytes
    // spanning multiple segments.
    const reopened = GovAuditChain.open({ dir, segmentBytes: 256 });
    expect(reopened.size()).toBe(60);
    expect(reopened.head()).toEqual({ seq: 59, sha256: entries[59].entrySha256 });
  });

  it("a tamper inside an EARLIER segment is still caught after rolling into later segments", () => {
    const chain = GovAuditChain.open({ dir, segmentBytes: 256 });
    seedChain(chain, 60);
    const lines0 = readRawLines(segFile(dir, 0));
    expect(lines0.length).toBeGreaterThan(0);
    const mid = JSON.parse(lines0[0]) as GovAuditEntry;
    mid.resource = "tampered-in-early-segment";
    lines0[0] = JSON.stringify(mid);
    writeRawLines(segFile(dir, 0), lines0);

    const reopened = GovAuditChain.open({ dir, segmentBytes: 256, verifyOnOpen: false });
    const v = reopened.verify();
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toMatchObject({ code: "hash-mismatch", seq: mid.seq });
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

describe("GovAuditChain: checkpoints", () => {
  it("checkpoint() persists to checkpoints.jsonl and verifies against the chain", () => {
    const identity = GovIdentity.generate(seededRng(30));
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 4);
    const cp = chain.checkpoint(identity, 12345);
    expect(cp.treeSize).toBe(4);
    expect(cp.headSha256).toBe(chain.head()!.sha256);
    expect(cp.root).toBe(merkleRoot(chain.leafHashes()));

    const raw = readFileSync(join(dir, "audit", "checkpoints.jsonl"), "utf8");
    expect(raw.trim().length).toBeGreaterThan(0);
    expect(JSON.parse(raw.trim().split("\n")[0])).toMatchObject({ schema: "hades.gov.checkpoint.v1", treeSize: 4 });

    const v = chain.verifyAgainstCheckpoint(cp, [identity.publicKeyHex()]);
    expect(v.ok).toBe(true);
  });

  it("verifyAgainstCheckpoint rejects a checkpoint signed by an untrusted key", () => {
    const identity = GovIdentity.generate(seededRng(31));
    const stranger = GovIdentity.generate(seededRng(32));
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 3);
    const cp = chain.checkpoint(identity, 1);
    const v = chain.verifyAgainstCheckpoint(cp, [stranger.publicKeyHex()]);
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.code === "checkpoint-signature-invalid")).toBe(true);
  });

  it("verifyAgainstCheckpoint succeeds across legitimate append-only growth", () => {
    const identity = GovIdentity.generate(seededRng(33));
    const chain = GovAuditChain.open({ dir });
    seedChain(chain, 3);
    const cp = chain.checkpoint(identity, 1);
    seedChain(chain, 4); // legitimate further appends after the checkpoint
    const v = chain.verifyAgainstCheckpoint(cp, [identity.publicKeyHex()]);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Query paths
// ---------------------------------------------------------------------------

describe("GovAuditChain: entries() query filters", () => {
  it("supports fromSeq, limit, actor, action, outcome filtering on a seeded log", () => {
    const chain = GovAuditChain.open({ dir });
    chain.append(seedAppend({ actor: "alice", action: "authorize", outcome: "allow" }, 0));
    chain.append(seedAppend({ actor: "bob", action: "authorize", outcome: "deny" }, 1));
    chain.append(seedAppend({ actor: "alice", action: "spawn", outcome: "info" }, 2));
    chain.append(seedAppend({ actor: "alice", action: "authorize", outcome: "allow" }, 3));
    chain.append(seedAppend({ actor: "carol", action: "reject", outcome: "deny" }, 4));

    expect(chain.entries({ fromSeq: 3 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(chain.entries({ limit: 2 }).map((e) => e.seq)).toEqual([0, 1]);
    expect(chain.entries({ actor: "alice" }).map((e) => e.seq)).toEqual([0, 2, 3]);
    expect(chain.entries({ action: "authorize" }).map((e) => e.seq)).toEqual([0, 1, 3]);
    expect(chain.entries({ outcome: "deny" }).map((e) => e.seq)).toEqual([1, 4]);
    expect(chain.entries({ actor: "alice", outcome: "allow" }).map((e) => e.seq)).toEqual([0, 3]);
    expect(chain.entries().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("entries() returns defensive copies (mutating the result does not corrupt the chain)", () => {
    const chain = GovAuditChain.open({ dir });
    chain.append(seedAppend({ meta: { k: "v" } }));
    const got = chain.entries()[0];
    got.resource = "mutated";
    if (got.meta) got.meta.k = "mutated";
    expect(chain.entries()[0].resource).not.toBe("mutated");
    expect(chain.entries()[0].meta?.k).toBe("v");
    expect(chain.verify().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fromLegacyAuditEvent adapter
// ---------------------------------------------------------------------------

describe("fromLegacyAuditEvent", () => {
  it("pipes a legacy AuditLog's events into the durable chain with sensible outcomes", () => {
    const log = new AuditLog(fixedClock(1));
    log.a2a("agentA", "agentB", "ping", { team: "alpha", topic: "hello" });
    log.spawn("alpha", "agentC", "docker");
    log.terminate("alpha", "agentC");
    log.authorize("agentA", "exec:shell", true);
    log.authorize("agentB", "exec:shell", false);
    log.reject("agentX", "unknown-capability");

    const chain = GovAuditChain.open({ dir });
    for (const e of log.all()) {
      chain.append(fromLegacyAuditEvent(e));
    }
    const entries = chain.entries();
    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({ action: "a2a", actor: "agentA", outcome: "info" });
    expect(entries[3]).toMatchObject({ action: "authorize", actor: "agentA", outcome: "allow" });
    expect(entries[4]).toMatchObject({ action: "authorize", actor: "agentB", outcome: "deny" });
    expect(entries[5]).toMatchObject({ action: "reject", actor: "agentX", outcome: "deny" });
    expect(chain.verify().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Throughput sanity (measured, not asserted as a marketing figure)
// ---------------------------------------------------------------------------

describe("GovAuditChain: throughput sanity", () => {
  it(
    "10k appends verify in-process without quadratic blowup",
    () => {
      const chain = GovAuditChain.open({ dir });
      const n = 10_000;

      const appendStart = Date.now();
      for (let i = 0; i < n; i++) {
        chain.append(seedAppend({}, i));
      }
      const appendMs = Date.now() - appendStart;

      const verifyStart = Date.now();
      const v = chain.verify();
      const verifyMs = Date.now() - verifyStart;

      expect(v.ok).toBe(true);
      expect(v.entries).toBe(n);

      // Measured, reported locally — not a hardcoded marketing number.
      // eslint-disable-next-line no-console
      console.log(`[audit-chain throughput] ${n} appends in ${appendMs}ms (${(n / (appendMs / 1000)).toFixed(0)}/s), verify() in ${verifyMs}ms`);

      // A generous, non-quadratic sanity bound: verify() over 10k entries
      // must not exhibit quadratic behavior. This is a loose ceiling, not a
      // performance claim.
      expect(verifyMs).toBeLessThan(10_000);
    },
    120_000,
  );
});
