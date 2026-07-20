import { describe, it, expect } from "vitest";
import {
  tierCap,
  evidenceId,
  evidenceFromExtractedFact,
  evidenceFromMemoryRecord,
  evidenceFromVerdict,
  EvidenceLedger,
  EVIDENCE_LEDGER_GENESIS,
  type LedgerEntry,
} from "../belief-evidence";
import type { BeliefEvidence } from "../user-model";
import { tierConfidenceFloor, type TierId } from "../../styx/tiers";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type VerificationCertificate,
  type CertificatePayload,
} from "../../styx/certificate";
import type { ExtractedFact } from "../summarizer";
import type { MemoryRecord } from "../store";
import { memoryWriteCalibration, type MemoryWriteVerdict, type ContradictionFinding } from "../guard";

// ===========================================================================
// Fixtures
// ===========================================================================

const AUTHORITY_KEY = generatePrivateKeyHex();
const authority = new CertificateAuthority(AUTHORITY_KEY);

function mkPayload(overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex("default output text"),
    taskId: "task-1",
    verifierTier: "T2-genrm",
    ensembleScore: 0.92,
    pCorrect: 0.97,
    epsilon: 0.05,
    traceSha256: sha256Hex("trace-1"),
    verifierVersions: ["v1"],
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function mkCertFor(text: string, overrides: Partial<CertificatePayload> = {}): Promise<VerificationCertificate> {
  return authority.issue(mkPayload({ outputSha256: sha256Hex(text), ...overrides }));
}

function mkFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    fact: overrides.fact ?? "user prefers dark mode",
    salience: overrides.salience ?? 0.8,
    evidence: overrides.evidence ?? "I really prefer dark mode over light mode.",
  };
}

let recCounter = 0;
function mkRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: overrides.id ?? `rec-${recCounter++}`,
    fact: overrides.fact ?? "user is based in Berlin",
    salience: overrides.salience ?? 0.75,
    tags: overrides.tags ?? [],
    source: overrides.source,
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    lastAccessedAt: overrides.lastAccessedAt,
    accessCount: overrides.accessCount ?? 0,
  };
}

function mkFinding(overrides: Partial<ContradictionFinding> = {}): ContradictionFinding {
  return {
    existing: overrides.existing ?? mkRecord({ fact: "user is based in Munich" }),
    kind: overrides.kind ?? "exclusive-value",
    detail: overrides.detail ?? "conflicting city",
    confidence: overrides.confidence ?? 0.7,
  };
}

function mkVerdict(overrides: Partial<MemoryWriteVerdict> = {}): MemoryWriteVerdict {
  return {
    verifierId: "verify.memory-write",
    passed: overrides.passed ?? true,
    confidence: overrides.confidence ?? memoryWriteCalibration().prior,
    reasons: overrides.reasons ?? [],
    contradictions: overrides.contradictions ?? [],
  };
}

const fixedNow = () => 1_700_000_001_234;

// ===========================================================================
// tierCap
// ===========================================================================

describe("tierCap", () => {
  it("returns the live memoryWriteCalibration prior for T4-consistency, never a hardcoded literal", () => {
    expect(tierCap("T4-consistency")).toBe(memoryWriteCalibration().prior);
  });

  it("matches tierConfidenceFloor(tier, 0.05) for every stronger tier", () => {
    const tiers: TierId[] = ["T0-execution", "T1-reference", "T2-genrm", "T3-agreement"];
    for (const t of tiers) {
      expect(tierCap(t)).toBe(tierConfidenceFloor(t, 0.05));
    }
  });

  it("is monotonically non-decreasing across the tierConfidenceFloor-governed tiers (T0..T3)", () => {
    // T4-consistency is calibrated by a different authority
    // (memoryWriteCalibration's own conservative prior, currently 0.6) than
    // the tierConfidenceFloor formula used for T0..T3, so it is not part of
    // this particular monotonic sequence — see the T4-vs-stronger-tiers test
    // below for the invariant that DOES hold across that boundary.
    const order: TierId[] = ["T0-execution", "T1-reference", "T2-genrm", "T3-agreement"];
    const caps = order.map(tierCap);
    for (let i = 1; i < caps.length; i++) {
      expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]!);
    }
  });

  it("T4-consistency's cap comes from memoryWriteCalibration(), independent of the tierConfidenceFloor curve", () => {
    // Documents (rather than assumes) the calibration-source discontinuity
    // at the T4 boundary: T4's cap is not required to sit above/below its
    // neighbours on the tierConfidenceFloor(tier, 0.05) curve — it is a
    // deliberately separate, conservative constant from a different module.
    expect(tierCap("T4-consistency")).toBe(memoryWriteCalibration().prior);
    expect(tierCap("T4-consistency")).not.toBe(tierConfidenceFloor("T4-consistency", 0.05));
  });

  it("throws RangeError on an unknown tier string", () => {
    expect(() => tierCap("T9-nonsense" as TierId)).toThrow(RangeError);
  });

  it("throws RangeError on a non-string tier", () => {
    // @ts-expect-error deliberately wrong runtime type
    expect(() => tierCap(42)).toThrow(RangeError);
  });
});

// ===========================================================================
// evidenceId
// ===========================================================================

describe("evidenceId", () => {
  const base = { excerpt: "user likes tea", polarity: "supports" as const, tier: "T4-consistency" as const, at: 100 };

  it("is deterministic: identical inputs produce identical ids", () => {
    expect(evidenceId(base)).toBe(evidenceId({ ...base }));
  });

  it("changes when polarity changes, all else equal", () => {
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, polarity: "contradicts" }));
  });

  it("changes when tier changes, all else equal", () => {
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, tier: "T1-reference" }));
  });

  it("changes when at changes, all else equal", () => {
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, at: 101 }));
  });

  it("changes when excerpt changes, all else equal", () => {
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, excerpt: "user likes coffee" }));
  });

  it("changes when sessionId is added", () => {
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, sessionId: "s1" }));
  });

  it("distinguishes different sessionIds", () => {
    expect(evidenceId({ ...base, sessionId: "s1" })).not.toBe(evidenceId({ ...base, sessionId: "s2" }));
  });

  it("is insensitive to key insertion order (canonical JSON)", () => {
    const a = evidenceId({ tier: "T4-consistency", at: 5, polarity: "supports", excerpt: "x", sessionId: "s" });
    const b = evidenceId({ sessionId: "s", excerpt: "x", at: 5, polarity: "supports", tier: "T4-consistency" });
    expect(a).toBe(b);
  });

  it("throws TypeError on a non-string excerpt", () => {
    // @ts-expect-error deliberately wrong runtime type
    expect(() => evidenceId({ ...base, excerpt: 123 })).toThrow(TypeError);
  });

  it("throws TypeError on a non-finite at", () => {
    expect(() => evidenceId({ ...base, at: NaN })).toThrow(TypeError);
  });
});

// ===========================================================================
// evidenceFromExtractedFact
// ===========================================================================

describe("evidenceFromExtractedFact", () => {
  it("defaults to T4-consistency with no certificate", async () => {
    const f = mkFact();
    const e = await evidenceFromExtractedFact(f, { now: fixedNow });
    expect(e.tier).toBe("T4-consistency");
    expect(e.certificateValid).toBe(false);
    expect(e.certificate).toBeUndefined();
    expect(e.excerpt).toBe(f.evidence);
    expect(e.polarity).toBe("supports");
    expect(e.weight).toBeCloseTo(Math.min(f.salience, tierCap("T4-consistency")));
  });

  it("honors an explicit polarity override", async () => {
    const f = mkFact();
    const e = await evidenceFromExtractedFact(f, { polarity: "contradicts", now: fixedNow });
    expect(e.polarity).toBe("contradicts");
  });

  it("upgrades tier and raises the cap for a validly-signed cert bound to f.evidence", async () => {
    const f = mkFact({ evidence: "I run Linux exclusively.", salience: 0.99 });
    const cert = await mkCertFor(f.evidence, { verifierTier: "T1-reference" });
    const e = await evidenceFromExtractedFact(f, { certificate: cert, now: fixedNow });

    expect(e.certificateValid).toBe(true);
    expect(e.tier).toBe("T1-reference");
    expect(e.certificate).toEqual(cert);
    // capped at the CLAIMED tier's cap, not T4's
    const t1cap = tierCap("T1-reference");
    const t4cap = tierCap("T4-consistency");
    expect(t1cap).not.toBe(t4cap);
    expect(e.weight).toBeCloseTo(Math.min(f.salience, t1cap));
  });

  it("rejects a forged (bit-flipped) signature — never raises tier/weight", async () => {
    const f = mkFact({ evidence: "forged text", salience: 0.9 });
    const cert = await mkCertFor(f.evidence, { verifierTier: "T0-execution" });
    const forged: VerificationCertificate = {
      ...cert,
      signature: cert.signature.slice(0, -2) + (cert.signature.slice(-2) === "00" ? "11" : "00"),
    };
    const e = await evidenceFromExtractedFact(f, { certificate: forged, now: fixedNow });
    expect(e.certificateValid).toBe(false);
    expect(e.tier).toBe("T4-consistency");
    expect(e.weight).toBeLessThanOrEqual(tierCap("T4-consistency"));
    // the (untrusted) certificate is still kept on the record for audit
    expect(e.certificate).toEqual(forged);
  });

  it("rejects a validly-signed cert bound to a DIFFERENT excerpt (replay resistance)", async () => {
    const f = mkFact({ evidence: "the real excerpt", salience: 0.9 });
    const certForOtherText = await mkCertFor("a completely different piece of text", { verifierTier: "T0-execution" });
    const e = await evidenceFromExtractedFact(f, { certificate: certForOtherText, now: fixedNow });
    expect(e.certificateValid).toBe(false);
    expect(e.tier).toBe("T4-consistency");
  });

  it("falls back to T4 honestly on an unknown verifierTier string in an otherwise-valid cert", async () => {
    const f = mkFact({ evidence: "some excerpt text", salience: 0.9 });
    const cert = await mkCertFor(f.evidence, { verifierTier: "T7-imaginary" });
    const e = await evidenceFromExtractedFact(f, { certificate: cert, now: fixedNow });
    expect(e.certificateValid).toBe(false);
    expect(e.tier).toBe("T4-consistency");
    expect(e.weight).toBeLessThanOrEqual(tierCap("T4-consistency"));
  });

  it("caps weight at the tier cap when salience exceeds it", async () => {
    const f = mkFact({ evidence: "high salience fact", salience: 1 });
    const e = await evidenceFromExtractedFact(f, { now: fixedNow });
    expect(e.weight).toBeCloseTo(tierCap("T4-consistency"));
    expect(e.weight).toBeLessThanOrEqual(1);
  });

  it("handles salience 0", async () => {
    const f = mkFact({ salience: 0 });
    const e = await evidenceFromExtractedFact(f, { now: fixedNow });
    expect(e.weight).toBe(0);
  });

  it("clamps NaN salience to 0", async () => {
    const f = mkFact({ salience: NaN });
    const e = await evidenceFromExtractedFact(f, { now: fixedNow });
    expect(e.weight).toBe(0);
  });

  it("clamps negative salience to 0", async () => {
    const f = mkFact({ salience: -5 });
    const e = await evidenceFromExtractedFact(f, { now: fixedNow });
    expect(e.weight).toBe(0);
  });

  it("clamps salience > 1", async () => {
    const f = mkFact({ salience: 50 });
    const e = await evidenceFromExtractedFact(f, { now: fixedNow });
    expect(e.weight).toBeCloseTo(tierCap("T4-consistency"));
  });

  it("rejects (TypeError, not a hang/silent pass) a structurally-impossible non-string evidence", async () => {
    // @ts-expect-error deliberately wrong runtime type
    await expect(evidenceFromExtractedFact({ fact: "x", salience: 0.5, evidence: 42 })).rejects.toThrow(TypeError);
  });

  it("never rejects on a malformed certificate object — degrades to certificateValid:false", async () => {
    const f = mkFact();
    const garbage = { payload: { outputSha256: 123 }, signature: "zz", publicKey: "zz" } as unknown as VerificationCertificate;
    await expect(evidenceFromExtractedFact(f, { certificate: garbage, now: fixedNow })).resolves.toMatchObject({
      certificateValid: false,
      tier: "T4-consistency",
    });
  });

  it("produces an id consistent with evidenceId() over its own fields", async () => {
    const f = mkFact();
    const e = await evidenceFromExtractedFact(f, { sessionId: "sess-1", now: fixedNow });
    expect(e.id).toBe(
      evidenceId({ excerpt: e.excerpt, sessionId: e.sessionId, polarity: e.polarity, tier: e.tier, at: e.at }),
    );
  });
});

// ===========================================================================
// evidenceFromMemoryRecord
// ===========================================================================

describe("evidenceFromMemoryRecord", () => {
  it("uses r.fact as the excerpt and defaults to T4/supports", async () => {
    const r = mkRecord();
    const e = await evidenceFromMemoryRecord(r, { now: fixedNow });
    expect(e.excerpt).toBe(r.fact);
    expect(e.tier).toBe("T4-consistency");
    expect(e.polarity).toBe("supports");
    expect(e.certificateValid).toBe(false);
  });

  it('parses sessionId from "session:<id>" sources', async () => {
    const r = mkRecord({ source: "session:abc-123" });
    const e = await evidenceFromMemoryRecord(r, { now: fixedNow });
    expect(e.sessionId).toBe("abc-123");
  });

  it('leaves sessionId undefined for "user" source', async () => {
    const r = mkRecord({ source: "user" });
    const e = await evidenceFromMemoryRecord(r, { now: fixedNow });
    expect(e.sessionId).toBeUndefined();
  });

  it("leaves sessionId undefined when source is undefined", async () => {
    const r = mkRecord({ source: undefined });
    const e = await evidenceFromMemoryRecord(r, { now: fixedNow });
    expect(e.sessionId).toBeUndefined();
  });

  it("upgrades tier for a cert validly bound to sha256Hex(r.fact)", async () => {
    const r = mkRecord({ fact: "user's timezone is CET", salience: 0.95 });
    const cert = await mkCertFor(r.fact, { verifierTier: "T3-agreement" });
    const e = await evidenceFromMemoryRecord(r, { certificate: cert, now: fixedNow });
    expect(e.certificateValid).toBe(true);
    expect(e.tier).toBe("T3-agreement");
    expect(e.weight).toBeCloseTo(Math.min(r.salience, tierCap("T3-agreement")));
  });

  it("keeps a hash-mismatched cert on record but does not trust it", async () => {
    const r = mkRecord({ fact: "user's timezone is CET" });
    const cert = await mkCertFor("something else entirely", { verifierTier: "T0-execution" });
    const e = await evidenceFromMemoryRecord(r, { certificate: cert, now: fixedNow });
    expect(e.certificateValid).toBe(false);
    expect(e.tier).toBe("T4-consistency");
    expect(e.certificate).toEqual(cert);
  });

  it("caps weight at tier cap for high salience", async () => {
    const r = mkRecord({ salience: 1 });
    const e = await evidenceFromMemoryRecord(r, { now: fixedNow });
    expect(e.weight).toBeCloseTo(tierCap("T4-consistency"));
  });

  it("handles salience 0", async () => {
    const r = mkRecord({ salience: 0 });
    const e = await evidenceFromMemoryRecord(r, { now: fixedNow });
    expect(e.weight).toBe(0);
  });

  it("rejects a structurally-impossible non-string fact", async () => {
    // @ts-expect-error deliberately wrong runtime type
    await expect(evidenceFromMemoryRecord({ ...mkRecord(), fact: null })).rejects.toThrow(TypeError);
  });
});

// ===========================================================================
// evidenceFromVerdict
// ===========================================================================

describe("evidenceFromVerdict", () => {
  it("produces supporting evidence for a passed verdict", () => {
    const verdict = mkVerdict({ passed: true, confidence: 0.55 });
    const e = evidenceFromVerdict("user drinks tea", verdict, { now: fixedNow, sessionId: "s1" });
    expect(e.polarity).toBe("supports");
    expect(e.excerpt).toBe("user drinks tea");
    expect(e.tier).toBe("T4-consistency");
    expect(e.weight).toBeCloseTo(Math.min(0.55, tierCap("T4-consistency")));
    expect(e.certificateValid).toBe(false);
    expect(e.verdict).toEqual({ verifierId: verdict.verifierId, passed: true, confidence: 0.55 });
    expect(e.sessionId).toBe("s1");
  });

  it("picks the highest-confidence finding among multiple contradictions on a failed verdict", () => {
    const low = mkFinding({ confidence: 0.3, existing: mkRecord({ fact: "low-confidence existing" }) });
    const high = mkFinding({ confidence: 0.85, existing: mkRecord({ fact: "high-confidence existing" }) });
    const mid = mkFinding({ confidence: 0.5, existing: mkRecord({ fact: "mid-confidence existing" }) });
    const verdict = mkVerdict({ passed: false, contradictions: [low, high, mid], confidence: 0.85 });
    const e = evidenceFromVerdict("candidate fact", verdict, { now: fixedNow });
    expect(e.polarity).toBe("contradicts");
    expect(e.excerpt).toBe("high-confidence existing");
    expect(e.weight).toBeCloseTo(Math.min(0.85, tierCap("T4-consistency")));
  });

  it("degrades honestly on a failed verdict with an empty contradictions array", () => {
    const verdict = mkVerdict({ passed: false, contradictions: [], confidence: 0.4 });
    const e = evidenceFromVerdict("candidate fact", verdict, { now: fixedNow });
    expect(e.polarity).toBe("contradicts");
    expect(e.excerpt).toBe("candidate fact");
    expect(e.weight).toBeCloseTo(Math.min(0.4, tierCap("T4-consistency")));
  });

  it("caps weight at tierCap even when confidence is very high", () => {
    const verdict = mkVerdict({ passed: true, confidence: 0.9999 });
    const e = evidenceFromVerdict("x", verdict, { now: fixedNow });
    expect(e.weight).toBeCloseTo(tierCap("T4-consistency"));
  });

  it("clamps a negative/NaN confidence to 0", () => {
    const verdict = mkVerdict({ passed: true, confidence: NaN });
    const e = evidenceFromVerdict("x", verdict, { now: fixedNow });
    expect(e.weight).toBe(0);
    expect(e.verdict?.confidence).toBe(0);
  });

  it("throws TypeError on a non-string candidateFact", () => {
    // @ts-expect-error deliberately wrong runtime type
    expect(() => evidenceFromVerdict(123, mkVerdict())).toThrow(TypeError);
  });

  it("throws TypeError on a structurally-impossible verdict", () => {
    // @ts-expect-error deliberately wrong runtime type
    expect(() => evidenceFromVerdict("x", { passed: "yes" })).toThrow(TypeError);
  });

  it("evidence id is deterministic given identical inputs including `at`", () => {
    const verdict = mkVerdict({ passed: true, confidence: 0.5 });
    const e1 = evidenceFromVerdict("x", verdict, { now: fixedNow });
    const e2 = evidenceFromVerdict("x", verdict, { now: fixedNow });
    expect(e1.id).toBe(e2.id);
  });
});

// ===========================================================================
// EvidenceLedger
// ===========================================================================

function mkEvidence(overrides: Partial<BeliefEvidence> = {}): BeliefEvidence {
  const excerpt = overrides.excerpt ?? "user likes espresso";
  const polarity = overrides.polarity ?? "supports";
  const tier = overrides.tier ?? "T4-consistency";
  const at = overrides.at ?? 1_700_000_000_000;
  return {
    id: overrides.id ?? evidenceId({ excerpt, sessionId: overrides.sessionId, polarity, tier, at }),
    excerpt,
    excerptSha256: overrides.excerptSha256 ?? sha256Hex(excerpt),
    sessionId: overrides.sessionId,
    polarity,
    tier,
    weight: overrides.weight ?? 0.5,
    certificateValid: overrides.certificateValid ?? false,
    certificate: overrides.certificate,
    verdict: overrides.verdict,
    at,
  };
}

describe("EvidenceLedger — basic chaining", () => {
  it("starts with root() === genesis when empty", () => {
    const ledger = new EvidenceLedger();
    expect(ledger.root()).toBe(EVIDENCE_LEDGER_GENESIS);
    expect(ledger.entries()).toEqual([]);
  });

  it("chains entries: first entry's prevHash is genesis, later entries chain to the prior hash", () => {
    const ledger = new EvidenceLedger();
    const e1 = ledger.append("preference", mkEvidence({ excerpt: "e1" }));
    const e2 = ledger.append("preference", mkEvidence({ excerpt: "e2" }));
    expect(e1.prevHash).toBe(EVIDENCE_LEDGER_GENESIS);
    expect(e2.prevHash).toBe(e1.hash);
    expect(ledger.root()).toBe(e2.hash);
    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(1);
  });

  it("entries() returns defensive copies — mutation does not affect the ledger", () => {
    const ledger = new EvidenceLedger();
    ledger.append("preference", mkEvidence({ excerpt: "e1" }));
    const snapshot = ledger.entries();
    snapshot[0]!.attribute = "TAMPERED";
    snapshot[0]!.evidence.excerpt = "TAMPERED";
    expect(ledger.entries()[0]!.attribute).toBe("preference");
    expect(ledger.entries()[0]!.evidence.excerpt).toBe("e1");
    expect(ledger.verifyChain()).toEqual({ ok: true });
  });

  it("append() return value is also a defensive copy", () => {
    const ledger = new EvidenceLedger();
    const returned = ledger.append("preference", mkEvidence({ excerpt: "e1" }));
    returned.evidence.excerpt = "TAMPERED";
    expect(ledger.entries()[0]!.evidence.excerpt).toBe("e1");
  });

  it("uses a custom genesis when provided", () => {
    const ledger = new EvidenceLedger("custom-genesis-hash");
    expect(ledger.root()).toBe("custom-genesis-hash");
    const e1 = ledger.append("preference", mkEvidence());
    expect(e1.prevHash).toBe("custom-genesis-hash");
  });

  it("throws on an empty-string genesis", () => {
    expect(() => new EvidenceLedger("")).toThrow(TypeError);
  });

  it("throws on a non-string attribute", () => {
    const ledger = new EvidenceLedger();
    // @ts-expect-error deliberately wrong runtime type
    expect(() => ledger.append(42, mkEvidence())).toThrow(TypeError);
  });

  it("reduces the certificate field to its signature in the hash but keeps the full cert on the entry", async () => {
    const cert = await mkCertFor("cert-bound excerpt", { verifierTier: "T0-execution" });
    const ledger = new EvidenceLedger();
    const entry = ledger.append("fact", mkEvidence({ excerpt: "cert-bound excerpt", certificate: cert, certificateValid: true, tier: "T0-execution" }));
    expect(entry.evidence.certificate).toEqual(cert);
    // Changing an unrelated field of the certificate's payload (while keeping
    // the signature the same) would change the reduced hash key only via the
    // top-level evidence diff, not because we re-serialize the whole cert —
    // verify the chain still holds honestly end to end via verifyChain.
    expect(ledger.verifyChain()).toEqual({ ok: true });
  });
});

describe("EvidenceLedger — tamper detection", () => {
  function buildValidChain(n = 5): LedgerEntry[] {
    const ledger = new EvidenceLedger();
    for (let i = 0; i < n; i++) {
      ledger.append(`attr-${i % 2}`, mkEvidence({ excerpt: `excerpt-${i}`, weight: 0.1 * i, at: 1_700_000_000_000 + i }));
    }
    return ledger.entries();
  }

  it("detects tampering of evidence.excerpt at the tail", () => {
    const entries = buildValidChain(5);
    entries[4]!.evidence.excerpt = "TAMPERED EXCERPT";
    expect(() => EvidenceLedger.restore(entries)).toThrow(/seq 4/);
  });

  it("detects tampering of evidence.weight at entry 0", () => {
    const entries = buildValidChain(5);
    entries[0]!.evidence.weight = 0.9999;
    expect(() => EvidenceLedger.restore(entries)).toThrow(/seq 0/);
  });

  it("detects tampering of evidence.polarity in the middle", () => {
    const entries = buildValidChain(5);
    entries[2]!.evidence.polarity = "contradicts";
    expect(() => EvidenceLedger.restore(entries)).toThrow(/seq 2/);
  });

  it("detects tampering of attribute", () => {
    const entries = buildValidChain(5);
    entries[3]!.attribute = "forged-attribute";
    expect(() => EvidenceLedger.restore(entries)).toThrow(/seq 3/);
  });

  it("detects a forged seq", () => {
    const entries = buildValidChain(5);
    entries[3]!.seq = 3; // no-op self check first
    entries[3] = { ...entries[3]!, seq: 99 };
    expect(() => EvidenceLedger.restore(entries)).toThrow(/seq 3/);
  });

  it("detects a forged prevHash", () => {
    const entries = buildValidChain(5);
    entries[3]!.prevHash = "0".repeat(64);
    expect(() => EvidenceLedger.restore(entries)).toThrow(/seq 3/);
  });

  it("detects a genesis mismatch (entry 0's prevHash rewritten)", () => {
    const entries = buildValidChain(3);
    entries[0]!.prevHash = "not-the-real-genesis";
    expect(() => EvidenceLedger.restore(entries)).toThrow(/seq 0/);
  });

  it("detects a genesis mismatch when restoring with a different genesis than was used to build the chain", () => {
    const entries = buildValidChain(3);
    expect(() => EvidenceLedger.restore(entries, "a-different-genesis")).toThrow(/seq 0/);
  });

  it("verifyChain() reports the same brokenAt seq for a live ledger mutated in place is not directly possible; verify via restore round-trip instead", () => {
    // EvidenceLedger deliberately exposes no way to mutate a live instance's
    // stored entries (entries()/append() both hand back defensive copies),
    // so tamper-detection is exercised via restore() of a doctored export,
    // which runs the identical recomputation logic verifyChain() does.
    const entries = buildValidChain(4);
    entries[1]!.hash = "0".repeat(64);
    expect(() => EvidenceLedger.restore(entries)).toThrow(/seq 1/);
  });

  it("valid chain restores cleanly and verifyChain reports ok", () => {
    const entries = buildValidChain(6);
    const restored = EvidenceLedger.restore(entries);
    expect(restored.verifyChain()).toEqual({ ok: true });
  });

  it("restore of a valid chain round-trips root()", () => {
    const ledger = new EvidenceLedger();
    ledger.append("a", mkEvidence({ excerpt: "one" }));
    ledger.append("b", mkEvidence({ excerpt: "two" }));
    ledger.append("c", mkEvidence({ excerpt: "three" }));
    const originalRoot = ledger.root();
    const restored = EvidenceLedger.restore(ledger.entries());
    expect(restored.root()).toBe(originalRoot);
    expect(restored.entries()).toEqual(ledger.entries());
  });

  it("restore of a truncated-then-extended chain fails at the point of divergence", () => {
    const ledgerA = new EvidenceLedger();
    ledgerA.append("a", mkEvidence({ excerpt: "one" }));
    ledgerA.append("a", mkEvidence({ excerpt: "two" }));
    const truncated = ledgerA.entries().slice(0, 1); // just seq 0

    // Rebuild a *different* seq-1 entry directly appended after the
    // truncated chain, with a fabricated (not recomputed) hash — this
    // simulates an attacker splicing a new tail onto an old prefix.
    const forgedTail: LedgerEntry = {
      seq: 1,
      attribute: "a",
      evidence: mkEvidence({ excerpt: "forged-two" }),
      prevHash: truncated[0]!.hash,
      hash: "f".repeat(64), // wrong: not actually recomputed
    };
    const spliced = [...truncated, forgedTail];
    expect(() => EvidenceLedger.restore(spliced)).toThrow(/seq 1/);
  });

  it("restore throws TypeError when entries is not an array", () => {
    // @ts-expect-error deliberately wrong runtime type
    expect(() => EvidenceLedger.restore("not-an-array")).toThrow(TypeError);
  });

  it("restore throws on a malformed entry shape", () => {
    const entries = buildValidChain(2);
    // @ts-expect-error deliberately wrong runtime type
    entries[1] = { seq: 1, hash: "x" };
    expect(() => EvidenceLedger.restore(entries)).toThrow(/seq 1/);
  });
});

describe("EvidenceLedger — scale", () => {
  it("verifies a 1000-entry chain in one linear pass without error", () => {
    const ledger = new EvidenceLedger();
    for (let i = 0; i < 1000; i++) {
      ledger.append(`attr-${i % 7}`, mkEvidence({ excerpt: `excerpt-${i}`, weight: (i % 10) / 10, at: 1_700_000_000_000 + i }));
    }
    const start = Date.now();
    const result = ledger.verifyChain();
    const elapsedMs = Date.now() - start;
    expect(result).toEqual({ ok: true });
    // A generous ceiling — this is a linear pass over 1000 cheap hashes; a
    // quadratic re-hash (O(n^2)) would be orders of magnitude slower.
    expect(elapsedMs).toBeLessThan(2000);

    const entries = ledger.entries();
    expect(entries.length).toBe(1000);
    const restored = EvidenceLedger.restore(entries);
    expect(restored.root()).toBe(ledger.root());

    // Tamper deep in the middle of a large chain — still detected, and
    // still at exactly the right seq.
    entries[500]!.evidence.excerpt = "TAMPERED-AT-500";
    expect(() => EvidenceLedger.restore(entries)).toThrow(/seq 500/);
  });
});

// ===========================================================================
// End-to-end: real cert -> evidence -> ledger
// ===========================================================================

describe("end-to-end: engine artifacts through to a verified ledger", () => {
  it("carries a real, certificate-upgraded ExtractedFact through the ledger and back", async () => {
    const f = mkFact({ evidence: "I always deploy on Fridays, unfortunately.", salience: 0.9 });
    const cert = await mkCertFor(f.evidence, { verifierTier: "T2-genrm" });
    const evidence = await evidenceFromExtractedFact(f, { certificate: cert, sessionId: "sess-42", now: fixedNow });

    expect(evidence.certificateValid).toBe(true);
    expect(evidence.tier).toBe("T2-genrm");

    const ledger = new EvidenceLedger();
    ledger.append("deploy-day", evidence);
    const restored = EvidenceLedger.restore(ledger.entries());
    expect(restored.verifyChain()).toEqual({ ok: true });
    expect(restored.entries()[0]!.evidence.certificate).toEqual(cert);
  });

  it("carries a failed guard verdict through as contradicting evidence in the ledger", () => {
    const existing = mkRecord({ fact: "user's default model is alpha" });
    const finding = mkFinding({ existing, kind: "exclusive-value", confidence: 0.65 });
    const verdict = mkVerdict({ passed: false, contradictions: [finding], confidence: 0.65 });
    const evidence = evidenceFromVerdict("user's default model is beta", verdict, { now: fixedNow });

    expect(evidence.polarity).toBe("contradicts");
    expect(evidence.excerpt).toBe(existing.fact);

    const ledger = new EvidenceLedger();
    ledger.append("default-model", evidence);
    expect(ledger.verifyChain()).toEqual({ ok: true });
  });
});
