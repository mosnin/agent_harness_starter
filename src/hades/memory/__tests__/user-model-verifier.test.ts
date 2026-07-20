import { describe, it, expect } from "vitest";
import {
  auditUserModel,
  userModelCalibration,
  type UserModelAuditReport,
  type BeliefAuditFinding,
} from "../user-model-verifier";
import { DialecticUserModel, combineEvidence, type UserBelief, type BeliefEvidence } from "../user-model";
import { EvidenceLedger, type LedgerEntry } from "../belief-evidence";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type VerificationCertificate,
  type CertificatePayload,
} from "../../styx/certificate";

// ===========================================================================
// Fixtures
// ===========================================================================

const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);
const AUTHORITY_KEY = generatePrivateKeyHex();
const authority = new CertificateAuthority(AUTHORITY_KEY);

let evCounter = 0;
function mkEvidence(overrides: Partial<BeliefEvidence> = {}): BeliefEvidence {
  const excerpt = overrides.excerpt ?? "the user said something verifiable";
  const evidence: BeliefEvidence = {
    id: overrides.id ?? `ev-${evCounter++}`,
    excerpt,
    excerptSha256: overrides.excerptSha256 ?? sha256Hex(excerpt),
    polarity: overrides.polarity ?? "supports",
    tier: overrides.tier ?? "T4-consistency",
    weight: overrides.weight ?? 0.5,
    at: overrides.at ?? BASE_TIME,
  };
  if (overrides.sessionId !== undefined) evidence.sessionId = overrides.sessionId;
  if (overrides.certificate !== undefined) evidence.certificate = overrides.certificate;
  if (overrides.certificateValid !== undefined) evidence.certificateValid = overrides.certificateValid;
  if (overrides.verdict !== undefined) evidence.verdict = overrides.verdict;
  return evidence;
}

function mkBelief(overrides: Partial<UserBelief> = {}): UserBelief {
  const updatedAt = overrides.updatedAt ?? BASE_TIME;
  const evidence = overrides.evidence ?? [mkEvidence()];
  return {
    attribute: overrides.attribute ?? "identity.location",
    value: overrides.value ?? "Berlin",
    confidence: overrides.confidence ?? combineEvidence(evidence, updatedAt, 30 * 24 * 60 * 60 * 1000),
    status: overrides.status ?? "asserted",
    salience: overrides.salience ?? 1,
    evidence,
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
    revisions: overrides.revisions ?? 0,
    supersededValues: overrides.supersededValues ?? [],
  };
}

/** Duck-typed stand-in for a `DialecticUserModel` — exercises the fact that
 *  `auditUserModel` only ever calls `.all()` on its `model` argument, so a
 *  pathological snapshot that bypasses `assert()`/`fromJSON()` entirely can
 *  still be audited. Cast through the locked public type per the design
 *  brief ("build the audit input from a raw snapshot object cast through
 *  the public types instead"). */
function stubModel(beliefs: UserBelief[]): DialecticUserModel {
  return { all: () => beliefs } as unknown as DialecticUserModel;
}

async function mkCertFor(excerpt: string, overrides: Partial<CertificatePayload> = {}): Promise<VerificationCertificate> {
  const payload: CertificatePayload = {
    outputSha256: sha256Hex(excerpt),
    taskId: "audit-test",
    verifierTier: "T1-reference",
    ensembleScore: 0.95,
    pCorrect: 0.97,
    epsilon: 0.03,
    traceSha256: sha256Hex("trace"),
    verifierVersions: ["v1"],
    issuedAt: BASE_TIME,
    ...overrides,
  };
  return authority.issue(payload);
}

function findingsOfKind(report: UserModelAuditReport, kind: BeliefAuditFinding["kind"]): BeliefAuditFinding[] {
  return report.findings.filter((f) => f.kind === kind);
}

// ===========================================================================
// Clean-pass baseline
// ===========================================================================

describe("auditUserModel — clean model", () => {
  it("passes with zero findings on a fully honest belief + matching ledger", async () => {
    const e1 = mkEvidence({ id: "ev-a", weight: 0.5, excerpt: "line one" });
    const e2 = mkEvidence({ id: "ev-b", weight: 0.4, excerpt: "line two" });
    const belief = mkBelief({ attribute: "identity.location", evidence: [e1, e2] });

    const ledger = new EvidenceLedger();
    ledger.append(belief.attribute, e1);
    ledger.append(belief.attribute, e2);

    const model = stubModel([belief]);
    const report = await auditUserModel(model, { ledger });

    expect(report.verifierId).toBe("verify.user-model");
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.beliefsAudited).toBe(1);
    expect(report.evidenceAudited).toBe(2);
    expect(report.confidence).toBeCloseTo(userModelCalibration().prior, 10);
  });

  it("passes with zero findings on a real DialecticUserModel built via assert()", async () => {
    const model = new DialecticUserModel({ now: () => BASE_TIME });
    model.assert({
      attribute: "stack.primary",
      value: "TypeScript",
      evidence: mkEvidence({ id: "real-ev-1", weight: 0.55, excerpt: "I use TypeScript for everything." }),
      now: BASE_TIME,
    });
    // Reinforce so it clears the assert floor comfortably.
    model.assert({
      attribute: "stack.primary",
      value: "TypeScript",
      evidence: mkEvidence({ id: "real-ev-2", weight: 0.5, excerpt: "TypeScript is my primary language." }),
      now: BASE_TIME,
    });

    const report = await auditUserModel(model);
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.beliefsAudited).toBe(1);
  });

  it("remains consistent for a single-evidence belief projected far into the future", async () => {
    // Single-evidence beliefs: claimedConfidenceAt's simple exponential
    // projection of the stored scalar is mathematically identical to
    // recombining the (lone) evidence item's own decay, so this must never
    // false-positive regardless of how far `now` is pushed forward.
    const e = mkEvidence({ id: "solo", weight: 0.5, at: BASE_TIME });
    const belief = mkBelief({ evidence: [e], updatedAt: BASE_TIME, status: "abstained" });
    const model = stubModel([belief]);

    const farFuture = BASE_TIME + 400 * 24 * 60 * 60 * 1000; // > a year later
    const report = await auditUserModel(model, { now: farFuture });
    expect(findingsOfKind(report, "confidence-exceeds-evidence")).toEqual([]);
  });
});

// ===========================================================================
// confidence-exceeds-evidence
// ===========================================================================

describe("auditUserModel — confidence-exceeds-evidence", () => {
  it("flags a hand-built belief whose claimed confidence exceeds what two T4 evidence items support", async () => {
    const e1 = mkEvidence({ id: "ce-1", weight: 0.5, tier: "T4-consistency" });
    const e2 = mkEvidence({ id: "ce-2", weight: 0.4, tier: "T4-consistency" });
    // Honest supportable value: noisy-OR(0.5,0.4)=0.7, capped at tierCap(T4)=0.6.
    const belief = mkBelief({ evidence: [e1, e2], confidence: 0.9, status: "asserted" });

    const model = stubModel([belief]);
    const report = await auditUserModel(model);

    expect(report.passed).toBe(false);
    const findings = findingsOfKind(report, "confidence-exceeds-evidence");
    expect(findings).toHaveLength(1);
    expect(findings[0].claimed).toBeCloseTo(0.9, 10);
    expect(findings[0].supportable).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(findings[0].attribute).toBe(belief.attribute);
  });

  it("does NOT flag a belief whose claimed confidence exactly matches its supportable ceiling", async () => {
    const e1 = mkEvidence({ id: "ok-1", weight: 0.5 });
    const e2 = mkEvidence({ id: "ok-2", weight: 0.4 });
    const supportable = combineEvidence([e1, e2], BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    const belief = mkBelief({ evidence: [e1, e2], confidence: supportable });

    const report = await auditUserModel(stubModel([belief]));
    expect(findingsOfKind(report, "confidence-exceeds-evidence")).toEqual([]);
  });

  it("demonstrates defense in depth: catches on a bypassed snapshot what a real assert() would have prevented", async () => {
    // First, show the real engine would never produce this: reinforcing with
    // this evidence combination through assert() yields an honest, capped
    // confidence, never the inflated 0.95 below.
    const model = new DialecticUserModel({ now: () => BASE_TIME });
    model.assert({
      attribute: "identity.location",
      value: "Berlin",
      evidence: mkEvidence({ id: "honest-1", weight: 0.5, excerpt: "I live in Berlin." }),
      now: BASE_TIME,
    });
    const honestBelief = model.get("identity.location")!;
    expect(honestBelief.confidence).toBeLessThan(0.95);

    // Now audit a hand-built snapshot with the SAME evidence but a forged,
    // inflated confidence that bypassed assert() entirely.
    const tampered: UserBelief = { ...honestBelief, confidence: 0.95 };
    const report = await auditUserModel(stubModel([tampered]));
    expect(report.passed).toBe(false);
    expect(findingsOfKind(report, "confidence-exceeds-evidence")).toHaveLength(1);
  });
});

// ===========================================================================
// asserted-below-floor
// ===========================================================================

describe("auditUserModel — asserted-below-floor", () => {
  it("flags an asserted belief whose confidence sits below the assert floor", async () => {
    const e = mkEvidence({ id: "low-1", weight: 0.3 });
    const supportable = combineEvidence([e], BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    expect(supportable).toBeLessThan(0.55);
    const belief = mkBelief({ evidence: [e], confidence: supportable, status: "asserted" });

    const report = await auditUserModel(stubModel([belief]));
    expect(report.passed).toBe(false);
    const findings = findingsOfKind(report, "asserted-below-floor");
    expect(findings).toHaveLength(1);
    expect(findings[0].supportable).toBeCloseTo(0.55, 10);
    // Must not ALSO fire confidence-exceeds-evidence — claimed === supportable exactly.
    expect(findingsOfKind(report, "confidence-exceeds-evidence")).toEqual([]);
  });

  it("respects a custom assertFloor option", async () => {
    const e = mkEvidence({ id: "custom-floor", weight: 0.3 });
    const supportable = combineEvidence([e], BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    const belief = mkBelief({ evidence: [e], confidence: supportable, status: "asserted" });

    const strict = await auditUserModel(stubModel([belief]), { assertFloor: 0.9 });
    expect(findingsOfKind(strict, "asserted-below-floor")).toHaveLength(1);

    const lenient = await auditUserModel(stubModel([belief]), { assertFloor: 0.01 });
    expect(findingsOfKind(lenient, "asserted-below-floor")).toEqual([]);
  });

  it("does not flag an abstained belief for being below the floor", async () => {
    const e = mkEvidence({ id: "abst-1", weight: 0.2 });
    const supportable = combineEvidence([e], BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    const belief = mkBelief({ evidence: [e], confidence: supportable, status: "abstained" });

    const report = await auditUserModel(stubModel([belief]));
    expect(findingsOfKind(report, "asserted-below-floor")).toEqual([]);
  });
});

// ===========================================================================
// asserted-while-contested
// ===========================================================================

describe("auditUserModel — asserted-while-contested", () => {
  it("flags a belief marked asserted whose evidence ledger contains a same-value contradicting entry", async () => {
    const support = mkEvidence({ id: "aw-1", weight: 0.6, polarity: "supports" });
    const contradiction = mkEvidence({ id: "aw-2", weight: 0.3, polarity: "contradicts" });
    const evidence = [support, contradiction];
    const confidence = combineEvidence(evidence, BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    const belief = mkBelief({ evidence, confidence, status: "asserted" });

    const report = await auditUserModel(stubModel([belief]));
    expect(report.passed).toBe(false);
    expect(findingsOfKind(report, "asserted-while-contested")).toHaveLength(1);
  });

  it("does not flag a belief that is honestly reported as contested", async () => {
    const support = mkEvidence({ id: "hc-1", weight: 0.6, polarity: "supports" });
    const contradiction = mkEvidence({ id: "hc-2", weight: 0.3, polarity: "contradicts" });
    const evidence = [support, contradiction];
    const confidence = combineEvidence(evidence, BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    const belief = mkBelief({ evidence, confidence, status: "contested" });

    const report = await auditUserModel(stubModel([belief]));
    expect(findingsOfKind(report, "asserted-while-contested")).toEqual([]);
  });
});

// ===========================================================================
// evidence-hash-mismatch
// ===========================================================================

describe("auditUserModel — evidence-hash-mismatch", () => {
  it("flags evidence whose excerptSha256 does not match sha256Hex(excerpt)", async () => {
    const tampered = mkEvidence({
      id: "hash-1",
      excerpt: "I live in Berlin.",
      excerptSha256: sha256Hex("I live in Munich."), // stale hash, tampered excerpt
      weight: 0.3,
    });
    const belief = mkBelief({ evidence: [tampered], status: "abstained" });

    const report = await auditUserModel(stubModel([belief]));
    expect(report.passed).toBe(false);
    const findings = findingsOfKind(report, "evidence-hash-mismatch");
    expect(findings).toHaveLength(1);
    expect(findings[0].attribute).toBe(belief.attribute);
  });

  it("does not flag evidence with a correct hash", async () => {
    const clean = mkEvidence({ id: "hash-ok", excerpt: "I live in Berlin.", weight: 0.3 });
    const belief = mkBelief({ evidence: [clean], status: "abstained" });
    const report = await auditUserModel(stubModel([belief]));
    expect(findingsOfKind(report, "evidence-hash-mismatch")).toEqual([]);
  });
});

// ===========================================================================
// invalid-certificate-trusted
// ===========================================================================

describe("auditUserModel — invalid-certificate-trusted", () => {
  it("flags evidence claiming a T1 tier with a forged certificate marked certificateValid: true", async () => {
    const excerpt = "The 2026 Q1 report confirms revenue of $4.2M.";
    const forged: VerificationCertificate = {
      payload: {
        outputSha256: sha256Hex(excerpt),
        taskId: "forged",
        verifierTier: "T1-reference",
        ensembleScore: 0.99,
        pCorrect: 0.99,
        epsilon: 0.01,
        traceSha256: sha256Hex("trace"),
        verifierVersions: ["v1"],
        issuedAt: BASE_TIME,
      },
      signature: "00".repeat(64), // garbage signature — real ed25519 verify must fail
      publicKey: authority.publicKeyHex(),
    };
    const sigOk = await import("../../styx/certificate").then((m) => m.verifyCertificate(forged));
    expect(sigOk).toBe(false); // sanity: this really is a failing signature, not luck

    const evidence = mkEvidence({
      id: "cert-1",
      excerpt,
      tier: "T1-reference",
      weight: 0.9,
      certificate: forged,
      certificateValid: true, // the lie under audit
    });
    const belief = mkBelief({ evidence: [evidence], status: "abstained" });

    const report = await auditUserModel(stubModel([belief]));
    expect(report.passed).toBe(false);
    expect(findingsOfKind(report, "invalid-certificate-trusted")).toHaveLength(1);
  });

  it("flags evidence claiming a tier stronger than T4 with no valid bound certificate at all", async () => {
    const evidence = mkEvidence({
      id: "cert-2",
      tier: "T2-genrm",
      weight: 0.7,
      certificateValid: false,
    });
    const belief = mkBelief({ evidence: [evidence], status: "abstained" });
    const report = await auditUserModel(stubModel([belief]));
    expect(findingsOfKind(report, "invalid-certificate-trusted")).toHaveLength(1);
  });

  it("does not flag a genuinely valid, bound certificate", async () => {
    const excerpt = "I live in Berlin.";
    const cert = await mkCertFor(excerpt, { verifierTier: "T1-reference" });
    const evidence = mkEvidence({
      id: "cert-ok",
      excerpt,
      tier: "T1-reference",
      weight: 0.9,
      certificate: cert,
      certificateValid: true,
    });
    const belief = mkBelief({ evidence: [evidence], status: "abstained" });
    const report = await auditUserModel(stubModel([belief]));
    expect(findingsOfKind(report, "invalid-certificate-trusted")).toEqual([]);
  });

  it("does not require a certificate for plain T4-consistency evidence", async () => {
    const evidence = mkEvidence({ id: "t4-plain", tier: "T4-consistency", weight: 0.4 });
    const belief = mkBelief({ evidence: [evidence], status: "abstained" });
    const report = await auditUserModel(stubModel([belief]));
    expect(findingsOfKind(report, "invalid-certificate-trusted")).toEqual([]);
  });
});

// ===========================================================================
// ledger-mismatch
// ===========================================================================

describe("auditUserModel — ledger-mismatch", () => {
  it("flags a belief evidence id that is absent from the provided ledger", async () => {
    const e1 = mkEvidence({ id: "led-1", weight: 0.5 });
    const e2 = mkEvidence({ id: "led-2", weight: 0.3 });
    const confidence = combineEvidence([e1, e2], BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    const belief = mkBelief({ evidence: [e1, e2], confidence, status: "abstained" });

    const ledger = new EvidenceLedger();
    ledger.append(belief.attribute, e1); // e2 never appended — missing from the ledger

    const report = await auditUserModel(stubModel([belief]), { ledger });
    expect(report.passed).toBe(false);
    const findings = findingsOfKind(report, "ledger-mismatch");
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("led-2");
  });

  it("flags a belief evidence weight that no longer matches the ledger's tamper-evident copy", async () => {
    // This is the case a naive "does confidence match evidence" check
    // cannot catch on its own: DialecticUserModel.fromJSON honestly
    // RE-DERIVES confidence from whatever weight the snapshot holds, so a
    // snapshot-only edit to an evidence weight never produces a
    // confidence-exceeds-evidence finding — the ledger cross-check is the
    // only thing that catches it.
    const original = mkEvidence({ id: "wt-1", weight: 0.3 });
    const ledger = new EvidenceLedger();
    ledger.append("stack.primary", original);

    const tampered = { ...original, weight: 0.95 }; // bumped upward post-ledgering
    const confidence = combineEvidence([tampered], BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    const belief = mkBelief({ attribute: "stack.primary", evidence: [tampered], confidence, status: "asserted" });

    const report = await auditUserModel(stubModel([belief]), { ledger });
    expect(report.passed).toBe(false);
    const findings = findingsOfKind(report, "ledger-mismatch");
    expect(findings).toHaveLength(1);
    expect(findings[0].claimed).toBeCloseTo(0.95, 10);
    expect(findings[0].supportable).toBeCloseTo(0.3, 10);
  });

  it("passes when every evidence id has a matching ledger entry", async () => {
    const e1 = mkEvidence({ id: "led-ok-1", weight: 0.5 });
    const confidence = combineEvidence([e1], BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    const belief = mkBelief({ evidence: [e1], confidence, status: "abstained" });

    const ledger = new EvidenceLedger();
    ledger.append(belief.attribute, e1);

    const report = await auditUserModel(stubModel([belief]), { ledger });
    expect(findingsOfKind(report, "ledger-mismatch")).toEqual([]);
  });

  it("flags a broken ledger hash chain", async () => {
    const e1 = mkEvidence({ id: "chain-1", weight: 0.5 });
    const confidence = combineEvidence([e1], BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    const belief = mkBelief({ evidence: [e1], confidence, status: "abstained" });

    const ledger = new EvidenceLedger();
    ledger.append(belief.attribute, e1);
    const [entry] = ledger.entries();
    const tamperedEntries: LedgerEntry[] = [{ ...entry, hash: "0".repeat(64) }];
    // Duck-typed ledger stand-in exposing only what auditUserModel actually
    // calls (verifyChain/entries) — EvidenceLedger.restore() itself refuses
    // to construct a broken chain (by design), so a hostile ledger can only
    // ever reach the auditor this way, which is exactly the surface the
    // auditor must defend against.
    const brokenLedger = {
      verifyChain: () => ({ ok: false, brokenAt: 0 }),
      entries: () => tamperedEntries,
    } as unknown as EvidenceLedger;

    const report = await auditUserModel(stubModel([belief]), { ledger: brokenLedger });
    expect(report.passed).toBe(false);
    expect(findingsOfKind(report, "ledger-mismatch").some((f) => f.attribute === "*")).toBe(true);
  });

  it("does not require a ledger at all", async () => {
    const e1 = mkEvidence({ id: "no-ledger", weight: 0.5 });
    const confidence = combineEvidence([e1], BASE_TIME, 30 * 24 * 60 * 60 * 1000);
    const belief = mkBelief({ evidence: [e1], confidence, status: "abstained" });
    const report = await auditUserModel(stubModel([belief]));
    expect(findingsOfKind(report, "ledger-mismatch")).toEqual([]);
  });
});

// ===========================================================================
// Structural / misuse guards
// ===========================================================================

describe("auditUserModel — misuse guards", () => {
  it("throws a TypeError when model is not a DialecticUserModel-shaped object", async () => {
    await expect(auditUserModel(undefined as unknown as DialecticUserModel)).rejects.toThrow(TypeError);
    await expect(auditUserModel({} as unknown as DialecticUserModel)).rejects.toThrow(TypeError);
  });

  it("audits multiple beliefs independently and aggregates counts correctly", async () => {
    const clean = mkBelief({ attribute: "a.clean", evidence: [mkEvidence({ id: "m-1", weight: 0.3 })], status: "abstained" });
    const dirty = mkBelief({
      attribute: "a.dirty",
      evidence: [mkEvidence({ id: "m-2", weight: 0.3 })],
      confidence: 0.99,
      status: "asserted",
    });
    const report = await auditUserModel(stubModel([clean, dirty]));
    expect(report.beliefsAudited).toBe(2);
    expect(report.evidenceAudited).toBe(2);
    expect(report.passed).toBe(false);
    expect(findingsOfKind(report, "confidence-exceeds-evidence").map((f) => f.attribute)).toEqual(["a.dirty"]);
  });
});

// ===========================================================================
// userModelCalibration
// ===========================================================================

describe("userModelCalibration", () => {
  it("reports T4-consistency at an honest, non-trivial prior", () => {
    const cal = userModelCalibration();
    expect(cal.tier).toBe("T4-consistency");
    expect(cal.prior).toBeGreaterThan(0);
    expect(cal.prior).toBeLessThan(1);
    expect(cal.prior).toBe(0.65);
  });
});
