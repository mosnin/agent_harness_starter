/**
 * Tests for `provenance.ts` — the hash-chained backend lifecycle ledger.
 *
 * Cross-checks against the REAL STYX `sha256Hex` (`../../styx`) throughout,
 * to prove the ledger truly uses the shared certificate engine's hash and
 * never a local reimplementation.
 */

import { describe, it, expect } from "vitest";
import { sha256Hex } from "../../styx";
import {
  BACKEND_TRACE_ROOT_PREIMAGE,
  BackendProvenanceLedger,
  canonicalRecordBytes,
  ledgerEventSink,
  type BackendEventType,
  type BackendLifecycleRecord,
} from "../provenance";
import type { BackendManagerEvent } from "../manager";

// ---------------------------------------------------------------------------
// Genesis / constants
// ---------------------------------------------------------------------------

describe("BACKEND_TRACE_ROOT_PREIMAGE / rootHash", () => {
  it("is the documented literal", () => {
    expect(BACKEND_TRACE_ROOT_PREIMAGE).toBe("hades.backends.trace.v1");
  });

  it("ledger.rootHash equals the real STYX sha256Hex of the preimage", () => {
    const ledger = new BackendProvenanceLedger();
    expect(ledger.rootHash).toBe(sha256Hex(BACKEND_TRACE_ROOT_PREIMAGE));
    expect(ledger.rootHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is the same across independent ledger instances (a fixed constant, not per-instance randomness)", () => {
    const a = new BackendProvenanceLedger();
    const b = new BackendProvenanceLedger();
    expect(a.rootHash).toBe(b.rootHash);
  });

  it("an empty ledger's head() equals rootHash", () => {
    const ledger = new BackendProvenanceLedger();
    expect(ledger.head()).toBe(ledger.rootHash);
  });

  it("an empty ledger's verifyChain() is ok with no records", () => {
    const ledger = new BackendProvenanceLedger();
    expect(ledger.verifyChain()).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// canonicalRecordBytes — canonicalization
// ---------------------------------------------------------------------------

describe("canonicalRecordBytes", () => {
  const base = {
    seq: 0,
    at: 1000,
    type: "provision" as BackendEventType,
    backend: "docker",
    workerId: "w1",
    prevHash: "a".repeat(64),
  };

  it("two detail objects with different key insertion order canonicalize identically", () => {
    const r1 = { ...base, detail: { a: 1, b: "two", c: true } };
    const r2 = { ...base, detail: { c: true, a: 1, b: "two" } };
    expect(canonicalRecordBytes(r1)).toBe(canonicalRecordBytes(r2));
  });

  it("omits nativeId and detail entirely when undefined (not null-serialized)", () => {
    const bytes = canonicalRecordBytes(base);
    expect(bytes).not.toContain("nativeId");
    expect(bytes).not.toContain("detail");
  });

  it("includes nativeId when present", () => {
    const bytes = canonicalRecordBytes({ ...base, nativeId: "native-123" });
    expect(bytes).toContain('"nativeId":"native-123"');
  });

  it("locked field order is [seq, at, type, backend, workerId, nativeId?, detail?, prevHash]", () => {
    const bytes = canonicalRecordBytes({ ...base, nativeId: "n1", detail: { x: 1 } });
    const seqIdx = bytes.indexOf('"seq"');
    const atIdx = bytes.indexOf('"at"');
    const typeIdx = bytes.indexOf('"type"');
    const backendIdx = bytes.indexOf('"backend"');
    const workerIdIdx = bytes.indexOf('"workerId"');
    const nativeIdIdx = bytes.indexOf('"nativeId"');
    const detailIdx = bytes.indexOf('"detail"');
    const prevHashIdx = bytes.indexOf('"prevHash"');
    expect(seqIdx).toBeLessThan(atIdx);
    expect(atIdx).toBeLessThan(typeIdx);
    expect(typeIdx).toBeLessThan(backendIdx);
    expect(backendIdx).toBeLessThan(workerIdIdx);
    expect(workerIdIdx).toBeLessThan(nativeIdIdx);
    expect(nativeIdIdx).toBeLessThan(detailIdx);
    expect(detailIdx).toBeLessThan(prevHashIdx);
  });

  it("throws on a detail value that is a nested object", () => {
    expect(() => canonicalRecordBytes({ ...base, detail: { nested: { a: 1 } as never } })).toThrow(TypeError);
  });

  it("throws on a detail value that is an array", () => {
    expect(() => canonicalRecordBytes({ ...base, detail: { arr: [1, 2] as never } })).toThrow(TypeError);
  });

  it("throws on a detail value that is NaN", () => {
    expect(() => canonicalRecordBytes({ ...base, detail: { n: NaN } })).toThrow(TypeError);
  });

  it("throws on an unrecognised type", () => {
    expect(() => canonicalRecordBytes({ ...base, type: "bogus" as BackendEventType })).toThrow(TypeError);
  });

  it("throws on a negative or non-integer seq", () => {
    expect(() => canonicalRecordBytes({ ...base, seq: -1 })).toThrow(TypeError);
    expect(() => canonicalRecordBytes({ ...base, seq: 1.5 })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// append() — basic behavior, determinism, real-sha256Hex conformance
// ---------------------------------------------------------------------------

describe("BackendProvenanceLedger.append", () => {
  it("increments seq densely from 0 and chains prevHash", () => {
    const ledger = new BackendProvenanceLedger({ now: () => 1 });
    const r0 = ledger.append({ type: "provision", backend: "docker", workerId: "w1" });
    const r1 = ledger.append({ type: "hibernate", backend: "docker", workerId: "w1" });
    const r2 = ledger.append({ type: "wake", backend: "docker", workerId: "w1" });
    expect([r0.seq, r1.seq, r2.seq]).toEqual([0, 1, 2]);
    expect(r0.prevHash).toBe(ledger.rootHash);
    expect(r1.prevHash).toBe(r0.hash);
    expect(r2.prevHash).toBe(r1.hash);
  });

  it("produces a hash that matches an independent recompute via the real STYX sha256Hex", () => {
    const ledger = new BackendProvenanceLedger({ now: () => 42 });
    const record = ledger.append({ type: "provision", backend: "modal", workerId: "w9", nativeId: "n9", detail: { k: 1 } });
    const expected = sha256Hex(
      canonicalRecordBytes({
        seq: record.seq,
        at: record.at,
        type: record.type,
        backend: record.backend,
        workerId: record.workerId,
        nativeId: record.nativeId,
        detail: record.detail,
        prevHash: record.prevHash,
      }),
    );
    expect(record.hash).toBe(expected);
  });

  it("uses the injected clock for `at`", () => {
    let t = 500;
    const ledger = new BackendProvenanceLedger({ now: () => t });
    const r0 = ledger.append({ type: "provision", backend: "docker", workerId: "w1" });
    expect(r0.at).toBe(500);
    t = 600;
    const r1 = ledger.append({ type: "hibernate", backend: "docker", workerId: "w1" });
    expect(r1.at).toBe(600);
  });

  it("rejects a detail with a nested object BEFORE mutating ledger state", () => {
    const ledger = new BackendProvenanceLedger({ now: () => 1 });
    expect(() =>
      ledger.append({ type: "provision", backend: "docker", workerId: "w1", detail: { nested: { a: 1 } as never } }),
    ).toThrow(TypeError);
    expect(ledger.records().length).toBe(0);
    expect(ledger.head()).toBe(ledger.rootHash);
  });

  it("rejects an unrecognised event type", () => {
    const ledger = new BackendProvenanceLedger();
    expect(() => ledger.append({ type: "bogus" as BackendEventType, backend: "docker", workerId: "w1" })).toThrow();
  });

  it("records() returns defensive copies — mutating the result never corrupts the ledger", () => {
    const ledger = new BackendProvenanceLedger({ now: () => 1 });
    ledger.append({ type: "provision", backend: "docker", workerId: "w1", detail: { a: 1 } });
    const snapshot = ledger.records();
    (snapshot[0] as { detail: Record<string, unknown> }).detail.a = 999;
    (snapshot[0] as { hash: string }).hash = "tampered";
    const fresh = ledger.records();
    expect(fresh[0]!.detail).toEqual({ a: 1 });
    expect(fresh[0]!.hash).not.toBe("tampered");
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("determinism: two ledgers fed the identical event sequence under identical clocks produce identical head hashes", () => {
    const events: Array<{ type: BackendEventType; backend: string; workerId: string; nativeId?: string; detail?: Record<string, string | number | boolean> }> = [
      { type: "provision", backend: "docker", workerId: "w1", nativeId: "n1", detail: { latencyMs: 12 } },
      { type: "hibernate", backend: "docker", workerId: "w1" },
      { type: "wake", backend: "docker", workerId: "w1" },
      { type: "probe", backend: "modal", detail: { available: true }, workerId: "" },
      { type: "terminate", backend: "docker", workerId: "w1" },
    ];
    let clockA = 0;
    let clockB = 0;
    const ledgerA = new BackendProvenanceLedger({ now: () => (clockA += 1) });
    const ledgerB = new BackendProvenanceLedger({ now: () => (clockB += 1) });
    for (const e of events) ledgerA.append(e);
    for (const e of events) ledgerB.append(e);
    expect(ledgerA.head()).toBe(ledgerB.head());
    expect(ledgerA.records()).toEqual(ledgerB.records());
  });

  it("toCertificateFields reports traceRoot/head/length consistently", () => {
    const ledger = new BackendProvenanceLedger({ now: () => 1 });
    ledger.append({ type: "provision", backend: "docker", workerId: "w1" });
    ledger.append({ type: "terminate", backend: "docker", workerId: "w1" });
    const fields = ledger.toCertificateFields();
    expect(fields.traceRoot).toBe(ledger.rootHash);
    expect(fields.head).toBe(ledger.head());
    expect(fields.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Adversarial tamper-evidence — a 50+ record chain, six attack shapes
// ---------------------------------------------------------------------------

function buildLongChain(n: number): BackendProvenanceLedger {
  const types: BackendEventType[] = [
    "provision",
    "hibernate",
    "wake",
    "probe",
    "sweep",
    "provision-failed",
    "wake-failed",
    "terminate",
  ];
  let clock = 0;
  const ledger = new BackendProvenanceLedger({ now: () => (clock += 7) });
  for (let i = 0; i < n; i++) {
    const type = types[i % types.length]!;
    ledger.append({
      type,
      backend: i % 2 === 0 ? "docker" : "modal",
      workerId: `w${i % 5}`,
      detail: { i, tag: `evt-${i}`, ok: i % 3 === 0 },
    });
  }
  return ledger;
}

describe("adversarial tamper-evidence over a 50+ record chain", () => {
  it("a fully valid 50+ record chain verifies ok", () => {
    const ledger = buildLongChain(55);
    expect(ledger.records().length).toBe(55);
    expect(ledger.verifyChain()).toEqual({ ok: true });
    expect(() => BackendProvenanceLedger.fromRecords(ledger.records() as BackendLifecycleRecord[])).not.toThrow();
  });

  it("(a) mutating a middle record's detail is caught (hash-mismatch) by verifyChain and fromRecords", () => {
    const ledger = buildLongChain(55);
    const raw = (ledger as unknown as { _records: BackendLifecycleRecord[] })._records;
    raw[25]!.detail = { ...raw[25]!.detail, tag: "TAMPERED" };
    const result = ledger.verifyChain();
    expect(result).toEqual({ ok: false, brokenAt: 25, reason: "hash-mismatch" });
    expect(() => BackendProvenanceLedger.fromRecords(ledger.records() as BackendLifecycleRecord[])).toThrow(
      /brokenAt 25.*hash-mismatch/,
    );
  });

  it("(b) mutating a prevHash is caught (prevhash-mismatch) by verifyChain and fromRecords", () => {
    const ledger = buildLongChain(55);
    const raw = (ledger as unknown as { _records: BackendLifecycleRecord[] })._records;
    raw[30]!.prevHash = "b".repeat(64);
    const result = ledger.verifyChain();
    expect(result).toEqual({ ok: false, brokenAt: 30, reason: "prevhash-mismatch" });
    expect(() => BackendProvenanceLedger.fromRecords(ledger.records() as BackendLifecycleRecord[])).toThrow(
      /brokenAt 30.*prevhash-mismatch/,
    );
  });

  it("(c) mutating a seq is caught (seq-mismatch) by verifyChain and fromRecords", () => {
    const ledger = buildLongChain(55);
    const raw = (ledger as unknown as { _records: BackendLifecycleRecord[] })._records;
    raw[10]!.seq = 999;
    const result = ledger.verifyChain();
    expect(result).toEqual({ ok: false, brokenAt: 10, reason: "seq-mismatch" });
    expect(() => BackendProvenanceLedger.fromRecords(ledger.records() as BackendLifecycleRecord[])).toThrow(
      /brokenAt 10.*seq-mismatch/,
    );
  });

  it("(d) reordering two records is caught by verifyChain and fromRecords", () => {
    const ledger = buildLongChain(55);
    const raw = (ledger as unknown as { _records: BackendLifecycleRecord[] })._records;
    const tmp = raw[10]!;
    raw[10] = raw[11]!;
    raw[11] = tmp;
    const result = ledger.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(10);
    expect(["seq-mismatch", "prevhash-mismatch"]).toContain(result.reason);
    expect(() => BackendProvenanceLedger.fromRecords(ledger.records() as BackendLifecycleRecord[])).toThrow(
      /brokenAt 10/,
    );
  });

  it("(e) truncating a record out of the middle leaves the tail dangling from a prevHash that no longer exists", () => {
    // "Truncating the tail" of a chain by cutting a segment out of the
    // middle and splicing the remainder back on: every record after the
    // cut still declares the seq/prevHash it originally had, which no
    // longer lines up with its new position or its new predecessor's
    // hash — the classic hash-chain-detects-deletion case (a plain
    // dropped-last-N-records truncation, by contrast, yields a genuinely
    // valid shorter PREFIX chain in isolation; detecting *that* requires
    // an external reference, which is exactly what the fleet verifier's
    // certificate.length/head cross-check exists for — see verifier.ts).
    const ledger = buildLongChain(55);
    const raw = (ledger as unknown as { _records: BackendLifecycleRecord[] })._records;
    raw.splice(24, 1); // remove index 24; everything after it is now the dangling "tail"
    const result = ledger.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(24);
    expect(["seq-mismatch", "prevhash-mismatch"]).toContain(result.reason);
    expect(() => BackendProvenanceLedger.fromRecords(ledger.records() as BackendLifecycleRecord[])).toThrow(
      /brokenAt 24/,
    );
  });

  it("(f) splicing in a forged record with a correctly-recomputed own-hash but a stale prevHash is caught", () => {
    const ledger = buildLongChain(55);
    const raw = (ledger as unknown as { _records: BackendLifecycleRecord[] })._records;
    // Forge a record whose OWN hash correctly recomputes for its declared
    // fields (including a stale prevHash borrowed from an earlier point in
    // the chain) — internally self-consistent, but wrong for its position.
    const stalePrevHash = raw[5]!.hash;
    const forgedPre = {
      seq: raw[20]!.seq,
      at: raw[20]!.at,
      type: "provision" as BackendEventType,
      backend: "docker",
      workerId: "forged-worker",
      prevHash: stalePrevHash,
    };
    const forgedHash = sha256Hex(canonicalRecordBytes(forgedPre));
    raw[20] = { ...forgedPre, hash: forgedHash };
    const result = ledger.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(20);
    expect(result.reason).toBe("prevhash-mismatch");
    expect(() => BackendProvenanceLedger.fromRecords(ledger.records() as BackendLifecycleRecord[])).toThrow(
      /brokenAt 20.*prevhash-mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// fromRecords
// ---------------------------------------------------------------------------

describe("BackendProvenanceLedger.fromRecords", () => {
  it("accepts a genuinely valid record array and reproduces the same head", () => {
    const original = buildLongChain(12);
    const rebuilt = BackendProvenanceLedger.fromRecords(original.records() as BackendLifecycleRecord[]);
    expect(rebuilt.head()).toBe(original.head());
    expect(rebuilt.records()).toEqual(original.records());
  });

  it("accepts an empty array", () => {
    const ledger = BackendProvenanceLedger.fromRecords([]);
    expect(ledger.records()).toEqual([]);
    expect(ledger.head()).toBe(ledger.rootHash);
  });

  it("throws a TypeError when given a non-array", () => {
    expect(() => BackendProvenanceLedger.fromRecords("not an array" as never)).toThrow(TypeError);
  });

  it("rejects a record array with a broken genesis (first record's prevHash wrong)", () => {
    const original = buildLongChain(5);
    const records = original.records() as BackendLifecycleRecord[];
    records[0] = { ...records[0]!, prevHash: "z".repeat(64) };
    expect(() => BackendProvenanceLedger.fromRecords(records)).toThrow(/genesis-mismatch/);
  });
});

// ---------------------------------------------------------------------------
// ledgerEventSink — the BackendManagerEvent adapter
// ---------------------------------------------------------------------------

describe("ledgerEventSink", () => {
  function evt(partial: Partial<BackendManagerEvent> & { type: BackendManagerEvent["type"] }): BackendManagerEvent {
    return { at: 0, ...partial } as BackendManagerEvent;
  }

  it("maps a scripted BackendManagerEvent sequence to the exact expected record types in order", () => {
    const ledger = new BackendProvenanceLedger({ now: () => 1 });
    const sink = ledgerEventSink(ledger);

    const script: BackendManagerEvent[] = [
      evt({ type: "registered", backend: "docker", detail: { kind: "container" } }),
      evt({ type: "probe", backend: "docker", detail: { available: true, cached: false } }),
      evt({ type: "selected", backend: "docker", detail: { candidateCount: 1 } }),
      evt({ type: "provisioned", backend: "docker", workerId: "w1", detail: { nativeId: "n1", latencyMs: 50 } }),
      evt({ type: "hibernated", backend: "docker", workerId: "w1", detail: { nativeId: "n1" } }),
      evt({ type: "woken", backend: "docker", workerId: "w1", detail: { noop: false } }),
      evt({ type: "swept", detail: { workerIds: ["w1"], count: 1 } }),
      evt({ type: "terminated", backend: "docker", workerId: "w1" }),
      evt({ type: "provision-failed", workerId: "w2", detail: { reason: "no backend available matching requirements" } }),
    ];
    for (const e of script) sink(e);

    const records = ledger.records();
    expect(records.map((r) => r.type)).toEqual([
      "probe", // registered -> probe-class fallback
      "probe", // probe -> probe
      "probe", // selected -> probe-class fallback
      "provision", // provisioned -> provision
      "hibernate", // hibernated -> hibernate
      "wake", // woken -> wake
      "sweep", // swept -> sweep
      "terminate", // terminated -> terminate
      "provision-failed", // provision-failed -> provision-failed
    ]);
    expect(records[0]!.detail?.originalEventType).toBe("registered");
    expect(records[2]!.detail?.originalEventType).toBe("selected");
    expect(records[3]!.nativeId).toBe("n1"); // lifted out of detail into the typed field
    expect(records[3]!.detail?.nativeId).toBeUndefined();
    expect(records[3]!.detail?.latencyMs).toBe(50);
  });

  it("maps unknown/future event types to a probe-class record, never dropping them", () => {
    const ledger = new BackendProvenanceLedger({ now: () => 1 });
    const sink = ledgerEventSink(ledger);
    sink(evt({ type: "some-future-event-type" as BackendManagerEvent["type"], backend: "docker", detail: { x: 1 } }));
    const records = ledger.records();
    expect(records.length).toBe(1);
    expect(records[0]!.type).toBe("probe");
    expect(records[0]!.detail?.originalEventType).toBe("some-future-event-type");
    expect(records[0]!.detail?.x).toBe(1);
  });

  it("defaults workerId/backend to empty string when the manager event omits them", () => {
    const ledger = new BackendProvenanceLedger({ now: () => 1 });
    const sink = ledgerEventSink(ledger);
    sink(evt({ type: "swept", detail: { count: 0, workerIds: [] } }));
    const records = ledger.records();
    expect(records[0]!.backend).toBe("");
    expect(records[0]!.workerId).toBe("");
  });

  it("sanitizes non-scalar detail values (arrays/objects) to scalar-only, never throwing", () => {
    const ledger = new BackendProvenanceLedger({ now: () => 1 });
    const sink = ledgerEventSink(ledger);
    expect(() =>
      sink(
        evt({
          type: "selected",
          backend: "docker",
          detail: { requirements: { capabilities: ["gpu"] }, candidateCount: 3 },
        }),
      ),
    ).not.toThrow();
    const records = ledger.records();
    expect(typeof records[0]!.detail?.requirements).toBe("string");
    expect(records[0]!.detail?.candidateCount).toBe(3);
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("produces a chain that verifies ok end-to-end", () => {
    const ledger = new BackendProvenanceLedger({ now: () => 1 });
    const sink = ledgerEventSink(ledger);
    sink(evt({ type: "provisioned", backend: "docker", workerId: "w1", detail: { nativeId: "n1" } }));
    sink(evt({ type: "terminated", backend: "docker", workerId: "w1" }));
    expect(ledger.verifyChain()).toEqual({ ok: true });
  });
});
