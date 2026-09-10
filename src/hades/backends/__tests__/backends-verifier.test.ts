/**
 * Tests for `verify.backends` (verifier.ts). Every fixture below is either a
 * hand-built `BackendFleetReport` or one grown from a genuine
 * `BackendProvenanceLedger`, matching the LOCKED report contract, so the
 * verifier can be exercised (and every checklist code individually caught)
 * purely from the contract.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  backendsFleetVerifier,
  backendsFleetCalibration,
  type BackendFleetReport,
} from "../verifier";
import { BackendProvenanceLedger, canonicalRecordBytes, BACKEND_TRACE_ROOT_PREIMAGE } from "../provenance";
import type { BackendLifecycleRecord } from "../provenance";
import type { ToolResult } from "../../agent/tools";
import { RemoteBackendRegistry } from "../backend";
import { FakeBackend } from "../fake-backend";

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function ok(report: BackendFleetReport): ToolResult {
  return { ok: true, output: JSON.stringify(report) };
}

const verifier = backendsFleetVerifier();
const N = 11; // the fixed eleven-check checklist
const PRIOR = backendsFleetCalibration().prior;

function expectedConfidence(passedCount: number): number {
  return (passedCount / N) * PRIOR;
}

/** Deep clone via JSON round-trip — reports in these tests are always
 *  JSON-safe, so this is a faithful, simple defensive copy for mutation. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// A genuine, fully valid fleet report, built from a real ledger
// ---------------------------------------------------------------------------

function buildGenuineReport(): BackendFleetReport {
  let clock = 1000;
  const ledger = new BackendProvenanceLedger({ now: () => (clock += 10) });

  ledger.append({ type: "provision", backend: "docker", workerId: "w1", nativeId: "d1", detail: { latencyMs: 12 } });
  ledger.append({ type: "hibernate", backend: "docker", workerId: "w1", nativeId: "d1" });
  ledger.append({ type: "wake", backend: "docker", workerId: "w1", nativeId: "d1" });
  ledger.append({ type: "provision", backend: "modal", workerId: "w2", nativeId: "m1" });
  ledger.append({ type: "terminate", backend: "modal", workerId: "w2" });
  ledger.append({ type: "provision-failed", backend: "docker", workerId: "w3", detail: { reason: "quota" } });
  ledger.append({ type: "probe", backend: "docker", workerId: "", detail: { available: true } });
  ledger.append({ type: "sweep", backend: "", workerId: "", detail: { count: 0 } });

  return {
    backends: [
      { name: "docker", kind: "container", available: true },
      { name: "modal", kind: "serverless", available: true },
    ],
    handles: [
      { workerId: "w1", backend: "docker", state: "running" },
      { workerId: "w2", backend: "modal", state: "stopped" },
    ],
    certificate: ledger.toCertificateFields(),
    records: ledger.records() as BackendLifecycleRecord[],
  };
}

// ---------------------------------------------------------------------------
// Identity / calibration
// ---------------------------------------------------------------------------

describe("backendsFleetVerifier identity", () => {
  it("has the locked verifierId", () => {
    expect(verifier.verifierId).toBe("verify.backends");
  });
});

describe("backendsFleetCalibration", () => {
  it("is tier T4-consistency with a prior in [0.6, 0.75]", () => {
    const c = backendsFleetCalibration();
    expect(c.tier).toBe("T4-consistency");
    expect(c.prior).toBeGreaterThanOrEqual(0.6);
    expect(c.prior).toBeLessThanOrEqual(0.75);
  });
});

// ---------------------------------------------------------------------------
// Certain-failure paths
// ---------------------------------------------------------------------------

describe("certain failure detection", () => {
  it("pins confidence at 0.99 and passed:false when result.ok is false", () => {
    const v = verifier.verify("{}", { ok: false, output: "whatever" });
    expect(v.passed).toBe(false);
    expect(v.confidence).toBeCloseTo(0.99, 12);
  });

  it("pins confidence at 0.99 when output is not valid JSON (e.g. a literal NaN token)", () => {
    const v = verifier.verify("{}", { ok: true, output: '{"records":[{"at":NaN}]}' });
    expect(v.passed).toBe(false);
    expect(v.confidence).toBeCloseTo(0.99, 12);
  });

  it("pins confidence at 0.99 when output is a JSON array, not an object", () => {
    const v = verifier.verify("{}", { ok: true, output: "[1,2,3]" });
    expect(v.passed).toBe(false);
    expect(v.confidence).toBeCloseTo(0.99, 12);
  });

  it("pins confidence at 0.99 when output is a bare JSON scalar", () => {
    const v = verifier.verify("{}", { ok: true, output: "42" });
    expect(v.passed).toBe(false);
    expect(v.confidence).toBeCloseTo(0.99, 12);
  });
});

// ---------------------------------------------------------------------------
// Full-pass baseline — hits the calibrated prior exactly
// ---------------------------------------------------------------------------

describe("full pass baseline", () => {
  it("a genuine fleet report passes every check at confidence == prior", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.passed).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.confidence).toBeCloseTo(PRIOR, 12);
  });

  it("a genuine empty-fleet report (no records) still passes", () => {
    const ledger = new BackendProvenanceLedger();
    const report: BackendFleetReport = {
      backends: [],
      handles: [],
      certificate: ledger.toCertificateFields(),
      records: [],
    };
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(true);
    expect(v.confidence).toBeCloseTo(PRIOR, 12);
  });
});

// ---------------------------------------------------------------------------
// shape-valid
// ---------------------------------------------------------------------------

describe("shape-valid check", () => {
  it("fails when a backend's `available` field is not boolean", () => {
    const report = clone(buildGenuineReport());
    (report.backends[0] as unknown as { available: string }).available = "yes";
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("shape-valid");
  });

  it("fails when `certificate` is missing entirely", () => {
    const report = clone(buildGenuineReport());
    delete (report as unknown as Record<string, unknown>).certificate;
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("shape-valid");
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("shape-valid");
  });
});

// ---------------------------------------------------------------------------
// traceroot-matches-preimage
// ---------------------------------------------------------------------------

describe("traceroot-matches-preimage check", () => {
  it("fails when certificate.traceRoot does not match sha256Hex(BACKEND_TRACE_ROOT_PREIMAGE)", () => {
    const report = clone(buildGenuineReport());
    report.certificate.traceRoot = sha256Hex("something-else-entirely");
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("traceroot-matches-preimage");
    // Nothing else should be disturbed by this corruption in isolation.
    expect(v.reasons).not.toContain("chain-recompute");
    expect(v.reasons).not.toContain("ledger-verifychain");
  });

  it("the real BACKEND_TRACE_ROOT_PREIMAGE constant is exactly the documented literal", () => {
    expect(BACKEND_TRACE_ROOT_PREIMAGE).toBe("hades.backends.trace.v1");
    expect(sha256Hex(BACKEND_TRACE_ROOT_PREIMAGE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("traceroot-matches-preimage");
  });
});

// ---------------------------------------------------------------------------
// chain-recompute / ledger-verifychain — the redundant hash-chain checks
// ---------------------------------------------------------------------------

describe("chain-recompute check (own inline recompute)", () => {
  it("fails (cascading into ledger-verifychain and certificate-head-consistent) when a middle record's field is tampered without rehashing", () => {
    const report = clone(buildGenuineReport());
    report.records[1]!.backend = "docker-tampered";
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("chain-recompute");
    expect(v.reasons).toContain("ledger-verifychain");
    expect(v.reasons).toContain("certificate-head-consistent");
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("chain-recompute");
  });
});

describe("ledger-verifychain check (defense-in-depth vs. a seq-relabelling forgery)", () => {
  it("catches a relabelled-but-self-consistently-rehashed seq swap on the last two records that the inline recompute alone would NOT catch", () => {
    // Take the two LAST records and swap their declared `seq` values,
    // re-deriving each one's hash correctly for its NEW seq (so each
    // record is, in isolation, a perfectly self-consistent hash of its own
    // declared fields — a forger who only checks "does my own hash match
    // my own fields" would be fooled). The inline chain-recompute in this
    // verifier walks hash/prevHash linkage using each record's OWN
    // declared seq (not `seq === index`), so it is satisfied. Only the
    // real ledger's stricter `BackendProvenanceLedger.fromRecords` (which
    // requires `seq === index`, exactly like `seq-strictly-increasing`)
    // catches the relabelling — proving the "own code path" recompute
    // alone is not sufficient and the ledger cross-check earns its keep.
    const report = clone(buildGenuineReport());
    const records = report.records;
    const last = records.length - 1;
    const secondLast = last - 1;

    const a = records[secondLast]!;
    const b = records[last]!;

    const swappedA: Omit<BackendLifecycleRecord, "hash"> = {
      seq: b.seq,
      at: a.at,
      type: a.type,
      backend: a.backend,
      workerId: a.workerId,
      ...(a.nativeId !== undefined ? { nativeId: a.nativeId } : {}),
      ...(a.detail !== undefined ? { detail: a.detail } : {}),
      prevHash: a.prevHash,
    };
    const swappedAHash = sha256Hex(canonicalRecordBytes(swappedA));

    const swappedB: Omit<BackendLifecycleRecord, "hash"> = {
      seq: a.seq,
      at: b.at,
      type: b.type,
      backend: b.backend,
      workerId: b.workerId,
      ...(b.nativeId !== undefined ? { nativeId: b.nativeId } : {}),
      ...(b.detail !== undefined ? { detail: b.detail } : {}),
      prevHash: swappedAHash,
    };
    const swappedBHash = sha256Hex(canonicalRecordBytes(swappedB));

    records[secondLast] = { ...swappedA, hash: swappedAHash };
    records[last] = { ...swappedB, hash: swappedBHash };
    report.certificate.head = swappedBHash;

    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("ledger-verifychain");
    expect(v.reasons).toContain("seq-strictly-increasing");
    expect(v.reasons).not.toContain("chain-recompute");
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("ledger-verifychain");
  });
});

// ---------------------------------------------------------------------------
// certificate-length-consistent
// ---------------------------------------------------------------------------

describe("certificate-length-consistent check", () => {
  it("fails when certificate.length does not match records.length", () => {
    const report = clone(buildGenuineReport());
    report.certificate.length = report.records.length + 1;
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("certificate-length-consistent");
    expect(v.reasons).not.toContain("chain-recompute");
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("certificate-length-consistent");
  });
});

// ---------------------------------------------------------------------------
// certificate-head-consistent
// ---------------------------------------------------------------------------

describe("certificate-head-consistent check", () => {
  it("fails when certificate.head is a plausible-looking but wrong hash, with records/length untouched", () => {
    const report = clone(buildGenuineReport());
    report.certificate.head = sha256Hex("a-different-head-entirely");
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("certificate-head-consistent");
    // Isolated: the chain itself is untouched and still recomputes fine.
    expect(v.reasons).not.toContain("chain-recompute");
    expect(v.reasons).not.toContain("ledger-verifychain");
  });

  it("fails on an empty-record report whose head is not the genesis", () => {
    const report: BackendFleetReport = {
      backends: [],
      handles: [],
      certificate: { traceRoot: sha256Hex(BACKEND_TRACE_ROOT_PREIMAGE), head: sha256Hex("wrong"), length: 0 },
      records: [],
    };
    const v = verifier.verify("{}", ok(report));
    expect(v.reasons).toContain("certificate-head-consistent");
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("certificate-head-consistent");
  });
});

// ---------------------------------------------------------------------------
// seq-strictly-increasing
// ---------------------------------------------------------------------------

describe("seq-strictly-increasing check", () => {
  it("fails on a gigantic out-of-place seq value", () => {
    const report = clone(buildGenuineReport());
    (report.records[2] as unknown as { seq: number }).seq = Number.MAX_SAFE_INTEGER;
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("seq-strictly-increasing");
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("seq-strictly-increasing");
  });
});

// ---------------------------------------------------------------------------
// handles-backend-exists
// ---------------------------------------------------------------------------

describe("handles-backend-exists check", () => {
  it("fails when a handle references a backend name absent from backends[]", () => {
    const report = clone(buildGenuineReport());
    report.handles[0]!.backend = "nonexistent-backend";
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("handles-backend-exists");
    expect(v.reasons).not.toContain("shape-valid");
    expect(v.reasons).not.toContain("chain-recompute");
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("handles-backend-exists");
  });
});

// ---------------------------------------------------------------------------
// handles-state-consistent
// ---------------------------------------------------------------------------

describe("handles-state-consistent check", () => {
  it("fails when a handle's state contradicts its own most-recent lifecycle record", () => {
    const report = clone(buildGenuineReport());
    // w1's most recent record is "wake" (-> expected state "running").
    report.handles[0]!.state = "hibernated";
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("handles-state-consistent");
    expect(v.reasons).not.toContain("chain-recompute");
  });

  it("fails when a handle has no backing lifecycle record at all", () => {
    const report = clone(buildGenuineReport());
    report.handles.push({ workerId: "ghost-worker", backend: "docker", state: "running" });
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("handles-state-consistent");
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("handles-state-consistent");
  });
});

// ---------------------------------------------------------------------------
// timestamps-non-decreasing
// ---------------------------------------------------------------------------

describe("timestamps-non-decreasing check", () => {
  it("fails when the last record's `at` decreases, in isolation (correctly rehashed, certificate.head updated)", () => {
    const report = clone(buildGenuineReport());
    const records = report.records;
    const last = records[records.length - 1]!;
    const earlierAt = records[records.length - 2]!.at - 5;

    const pre: Omit<BackendLifecycleRecord, "hash"> = {
      seq: last.seq,
      at: earlierAt,
      type: last.type,
      backend: last.backend,
      workerId: last.workerId,
      ...(last.nativeId !== undefined ? { nativeId: last.nativeId } : {}),
      ...(last.detail !== undefined ? { detail: last.detail } : {}),
      prevHash: last.prevHash,
    };
    const newHash = sha256Hex(canonicalRecordBytes(pre));
    records[records.length - 1] = { ...pre, hash: newHash };
    report.certificate.head = newHash;

    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("timestamps-non-decreasing");
    // Isolated: chain hashing/linkage, length, seq, and handle checks are untouched.
    expect(v.reasons).not.toContain("chain-recompute");
    expect(v.reasons).not.toContain("ledger-verifychain");
    expect(v.reasons).not.toContain("certificate-head-consistent");
    expect(v.reasons).not.toContain("certificate-length-consistent");
    expect(v.reasons).not.toContain("seq-strictly-increasing");
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("timestamps-non-decreasing");
  });
});

// ---------------------------------------------------------------------------
// detail-scalar-only
// ---------------------------------------------------------------------------

describe("detail-scalar-only check", () => {
  it("fails when a record's detail contains a nested object (necessarily also breaking the hash checks, since no valid hash exists for a non-scalar detail)", () => {
    const report = clone(buildGenuineReport());
    (report.records[0] as unknown as { detail: Record<string, unknown> }).detail = { nested: { a: 1 } };
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("detail-scalar-only");
  });

  it("fails when a record's detail contains an array value", () => {
    const report = clone(buildGenuineReport());
    (report.records[0] as unknown as { detail: Record<string, unknown> }).detail = { tags: ["a", "b"] };
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("detail-scalar-only");
  });

  it("passes on a genuine report", () => {
    const v = verifier.verify("{}", ok(buildGenuineReport()));
    expect(v.reasons).not.toContain("detail-scalar-only");
  });
});

// ---------------------------------------------------------------------------
// Mock-vs-real-style labeling: the `kind` marker is honestly reported and
// is not itself special-cased by the checklist (no check discriminates on
// it) — a report built with a "fake" backend kind is judged purely on its
// cryptographic/structural merits, exactly like one built with a "real"
// kind.
// ---------------------------------------------------------------------------

describe("kind labeling neutrality (mock-vs-real style)", () => {
  it("a genuine report built against a fake-kind backend passes identically to one built against a container-kind backend", () => {
    const fakeKindReport = clone(buildGenuineReport());
    fakeKindReport.backends[0]!.kind = "fake";
    const containerKindReport = clone(buildGenuineReport());
    containerKindReport.backends[0]!.kind = "container";

    const vFake = verifier.verify("{}", ok(fakeKindReport));
    const vContainer = verifier.verify("{}", ok(containerKindReport));
    expect(vFake.passed).toBe(true);
    expect(vContainer.passed).toBe(true);
    expect(vFake.confidence).toBeCloseTo(vContainer.confidence, 12);
  });

  it("still fails shape-valid if kind is dishonestly reported as an empty string", () => {
    const report = clone(buildGenuineReport());
    report.backends[0]!.kind = "";
    const v = verifier.verify("{}", ok(report));
    expect(v.reasons).toContain("shape-valid");
  });
});

// ---------------------------------------------------------------------------
// Hostile / malformed reports — must fail closed, never throw
// ---------------------------------------------------------------------------

describe("hostile / malformed reports fail closed, never throw", () => {
  it("records as a string instead of an array", () => {
    const report = clone(buildGenuineReport()) as unknown as Record<string, unknown>;
    report.records = "not-an-array";
    expect(() => verifier.verify("{}", ok(report as unknown as BackendFleetReport))).not.toThrow();
    const v = verifier.verify("{}", ok(report as unknown as BackendFleetReport));
    expect(v.passed).toBe(false);
    expect(v.confidence).toBeLessThan(PRIOR);
    expect(v.confidence).toBeGreaterThanOrEqual(0);
  });

  it("a record with a null `at` (stand-in for a non-finite/invalid timestamp)", () => {
    const report = clone(buildGenuineReport());
    (report.records[0] as unknown as { at: unknown }).at = null;
    expect(() => verifier.verify("{}", ok(report))).not.toThrow();
    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(false);
  });

  it("completely empty object as the report", () => {
    expect(() => verifier.verify("{}", { ok: true, output: "{}" })).not.toThrow();
    const v = verifier.verify("{}", { ok: true, output: "{}" });
    expect(v.passed).toBe(false);
    expect(v.confidence).toBeGreaterThanOrEqual(0);
    expect(v.confidence).toBeLessThanOrEqual(1);
  });

  it("a kitchen-sink hostile report: missing certificate, records as an object (not array), huge seq buried in a nested surprise, handles referencing nothing", () => {
    const hostile = {
      backends: "not-an-array",
      handles: [{ workerId: "w1", backend: 123, state: null }],
      records: { seq: Number.MAX_SAFE_INTEGER * 2, weird: true },
    };
    expect(() => verifier.verify("{}", { ok: true, output: JSON.stringify(hostile) })).not.toThrow();
    const v = verifier.verify("{}", { ok: true, output: JSON.stringify(hostile) });
    expect(v.passed).toBe(false);
    expect(Number.isFinite(v.confidence)).toBe(true);
    expect(v.confidence).toBeGreaterThanOrEqual(0);
    expect(v.confidence).toBeLessThanOrEqual(1);
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it("a report that is a JSON array of nonsense at the records level, deeply hostile prototype-ish keys", () => {
    const hostile = {
      backends: [{ name: "__proto__", kind: "x", available: true }],
      handles: [],
      certificate: { traceRoot: 1, head: 2, length: "three" },
      records: [1, 2, "three", null, { seq: "zero" }],
    };
    expect(() => verifier.verify("{}", { ok: true, output: JSON.stringify(hostile) })).not.toThrow();
    const v = verifier.verify("{}", { ok: true, output: JSON.stringify(hostile) });
    expect(v.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Interop: a genuine ledger built from a REAL RemoteBackendRegistry +
// FakeBackend lifecycle walk, fed into the verifier, passes.
// ---------------------------------------------------------------------------

describe("interop: real RemoteBackendRegistry + FakeBackend lifecycle walk", () => {
  it("a fleet report built from a genuine provision -> hibernate -> wake -> terminate walk passes the verifier", async () => {
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "fake", available: true, supportsHibernate: true, now: () => 5_000 });
    registry.register(backend);

    let clock = 1;
    const ledger = new BackendProvenanceLedger({ now: () => (clock += 1) });

    const provisioned = await registry.provision(
      { workerId: "worker-1", capabilities: ["python"], managerUrl: "https://manager.local", authToken: "tok" },
      "fake",
    );
    ledger.append({
      type: "provision",
      backend: provisioned.backend,
      workerId: provisioned.handle.workerId,
      nativeId: provisioned.handle.nativeId,
    });

    const hibernated = await registry.hibernate("worker-1");
    ledger.append({
      type: "hibernate",
      backend: hibernated!.backend,
      workerId: hibernated!.workerId,
      nativeId: hibernated!.nativeId,
    });

    const woken = await registry.wake("worker-1");
    ledger.append({ type: "wake", backend: woken!.backend, workerId: woken!.workerId, nativeId: woken!.nativeId });

    await registry.terminate("worker-1");
    ledger.append({ type: "terminate", backend: "fake", workerId: "worker-1" });

    expect(ledger.verifyChain()).toEqual({ ok: true });

    const report: BackendFleetReport = {
      backends: [{ name: "fake", kind: "fake", available: await backend.isAvailable() }],
      handles: [{ workerId: "worker-1", backend: "fake", state: "stopped" }],
      certificate: ledger.toCertificateFields(),
      records: ledger.records() as BackendLifecycleRecord[],
    };

    const v = verifier.verify("{}", ok(report));
    expect(v.passed).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.confidence).toBeCloseTo(PRIOR, 12);
  });
});

// ---------------------------------------------------------------------------
// Confidence math sanity
// ---------------------------------------------------------------------------

describe("confidence math", () => {
  it("with exactly one failing check, confidence equals (10/11) * prior", () => {
    const report = clone(buildGenuineReport());
    report.certificate.length = report.records.length + 1; // isolated: certificate-length-consistent only
    const v = verifier.verify("{}", ok(report));
    expect(v.reasons).toEqual(["certificate-length-consistent"]);
    expect(v.confidence).toBeCloseTo(expectedConfidence(N - 1), 12);
  });
});
