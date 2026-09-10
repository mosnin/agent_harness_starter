import { describe, expect, it } from "vitest";

import {
  UnifiedTrustGate,
  formatTrustGateReport,
  type AbstentionCode,
  type TrustBudgetPort,
  type UnifiedGateConfig,
} from "../unified-gate";
import {
  VerifierRegistry,
  canonicalTrace,
  type TrustDomain,
  type TrustSubject,
  type UniversalVerifier,
} from "../registry";
import {
  CertificateAuthority,
  certifiesOutput,
  generatePrivateKeyHex,
  sha256Hex,
  verifyCertificate,
} from "../../styx/certificate";
import { conformalThreshold, type CalibrationPoint } from "../../styx/gate";
import { tierConfidenceFloor, type TierId } from "../../styx/tiers";

// ===========================================================================
// Fixtures
// ===========================================================================

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

function makeCA(seed = 7): CertificateAuthority {
  return new CertificateAuthority(generatePrivateKeyHex(fixedRng(seed)));
}

/** Deterministic hash -> [0, 1). No Math.random anywhere in this file. */
function hash01(i: number, salt: number): number {
  let x = (Math.imul(i, 0x9e3779b1) + Math.imul(salt, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x045d9f3b) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x045d9f3b) >>> 0;
  x ^= x >>> 16;
  return x / 2 ** 32;
}

function makeCalibration(n: number, saltA: number, saltB: number, slope: number, base: number): CalibrationPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const score = hash01(i, saltA);
    return { score, correct: hash01(i, saltB) < base + slope * score };
  });
}

/**
 * At epsilon = 0.1 this set fits to threshold ~= 0.2766, pCorrect ~= 0.9216
 * (verified against the real ConformalGate — see the module's monotonicity
 * test for the cross-check against `conformalThreshold`). That pCorrect
 * clears the T0-execution floor (0.9) but not T1-reference (0.95) or
 * anything weaker, which is exactly the separation the abstention-code
 * tests below rely on.
 */
const TOOL_CALIBRATION = makeCalibration(300, 21, 22, 0.85, 0.1);
const EPSILON = 0.1;
const NOW_MS = 1_800_000_000_000;

function subject(overrides: Partial<TrustSubject> & { subjectId: string }): TrustSubject {
  return {
    domain: "tool",
    taskId: `t-${overrides.subjectId}`,
    input: "do the thing",
    output: `output-for-${overrides.subjectId}`,
    evidence: {},
    trace: [{ seq: 1, kind: "call", detail: `step-${overrides.subjectId}` }],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<UnifiedGateConfig> = {}): UnifiedGateConfig {
  return {
    epsilon: EPSILON,
    issuer: makeCA(),
    registry: new VerifierRegistry(),
    now: () => NOW_MS,
    ...overrides,
  };
}

/** A verifier scoped to exactly one subjectId, so scenarios never cross-vote. */
function scopedVerifier(opts: {
  id: string;
  subjectId: string;
  domain?: TrustDomain;
  tier?: TierId;
  prior?: number;
  passed?: boolean;
  confidence?: number;
  abstain?: boolean;
}): UniversalVerifier {
  const domain = opts.domain ?? "tool";
  const tier = opts.tier ?? "T2-genrm";
  return {
    id: opts.id,
    version: "1.0.0",
    domain,
    tier,
    prior: opts.prior ?? 0.99,
    appliesTo: (s) => s.domain === domain && s.subjectId === opts.subjectId,
    verify: () =>
      opts.abstain
        ? {
            verifierId: opts.id,
            version: "1.0.0",
            tier,
            passed: false,
            confidence: 0,
            reasons: ["test-self-abstain"],
            abstained: true,
          }
        : {
            verifierId: opts.id,
            version: "1.0.0",
            tier,
            passed: opts.passed ?? true,
            confidence: opts.confidence ?? 0.9,
            reasons: [],
            abstained: false,
          },
  };
}

/** 2x T0-execution unanimous PASS -> fused score 1.0, tier T0-execution. Clears
 *  threshold and every tier floor under `TOOL_CALIBRATION` @ EPSILON. */
function acceptVerifiers(subjectId: string, domain: TrustDomain = "tool"): UniversalVerifier[] {
  return [
    scopedVerifier({ id: `${subjectId}-t0-pass-1`, subjectId, domain, tier: "T0-execution", passed: true }),
    scopedVerifier({ id: `${subjectId}-t0-pass-2`, subjectId, domain, tier: "T0-execution", passed: true }),
  ];
}

/** 1 pass + 2 fail, all T2-genrm -> majority-fail collapses fused score to 0.0
 *  (below any positive conformal threshold), single tier so no conflict. */
function belowThresholdVerifiers(subjectId: string, domain: TrustDomain = "tool"): UniversalVerifier[] {
  return [
    scopedVerifier({ id: `${subjectId}-t2-pass-1`, subjectId, domain, tier: "T2-genrm", passed: true }),
    scopedVerifier({ id: `${subjectId}-t2-fail-1`, subjectId, domain, tier: "T2-genrm", passed: false }),
    scopedVerifier({ id: `${subjectId}-t2-fail-2`, subjectId, domain, tier: "T2-genrm", passed: false }),
  ];
}

/** 2 pass + 1 fail, all T4-consistency -> majority-pass collapses fused score
 *  to 1.0 (clears the raw threshold) but T4's confidence floor is far above
 *  this calibration's pCorrect, so only the tier floor can reject it. */
function tierFloorVerifiers(subjectId: string, domain: TrustDomain = "tool"): UniversalVerifier[] {
  return [
    scopedVerifier({ id: `${subjectId}-t4-pass-1`, subjectId, domain, tier: "T4-consistency", passed: true }),
    scopedVerifier({ id: `${subjectId}-t4-pass-2`, subjectId, domain, tier: "T4-consistency", passed: true }),
    scopedVerifier({ id: `${subjectId}-t4-fail-1`, subjectId, domain, tier: "T4-consistency", passed: false }),
  ];
}

/** 1 T0-execution FAIL outvoted by 2 T4-consistency PASS -> fused score
 *  collapses to 1.0 (clears the raw threshold), but the strongest
 *  contributing tier (T0) dissented. The veto must fire regardless. */
function conflictVerifiers(subjectId: string, domain: TrustDomain = "tool"): UniversalVerifier[] {
  return [
    scopedVerifier({ id: `${subjectId}-t0-fail`, subjectId, domain, tier: "T0-execution", passed: false }),
    scopedVerifier({ id: `${subjectId}-t4-pass-1`, subjectId, domain, tier: "T4-consistency", passed: true }),
    scopedVerifier({ id: `${subjectId}-t4-pass-2`, subjectId, domain, tier: "T4-consistency", passed: true }),
  ];
}

function abstainingVerifier(subjectId: string, domain: TrustDomain = "tool"): UniversalVerifier {
  return scopedVerifier({ id: `${subjectId}-abstains`, subjectId, domain, tier: "T3-agreement", abstain: true });
}

/** Applies unconditionally to every subject of its domain (used for
 *  "no other verifier registered but this one didn't apply" / lone-voter
 *  scenarios where the caller wants the SAME verifier voting across many
 *  distinct subjects in a batch). */
function loneVerifier(id: string, domain: TrustDomain = "tool", tier: TierId = "T0-execution"): UniversalVerifier {
  return {
    id,
    version: "2.1.0",
    domain,
    tier,
    prior: 0.95,
    appliesTo: (s) => s.domain === domain,
    verify: () => ({
      verifierId: id,
      version: "2.1.0",
      tier,
      passed: true,
      confidence: 0.9,
      reasons: [],
      abstained: false,
    }),
  };
}

function budgetStub(opts: {
  quoteAllowed?: boolean;
  quoteReason?: string;
  spendAccepted?: boolean;
}): TrustBudgetPort & {
  quoteCalls: { domain: string; taskId: string; risk: number }[];
  spendCalls: { domain: string; taskId: string; risk: number; subjectSha256: string; issuedAt: number }[];
} {
  const quoteCalls: { domain: string; taskId: string; risk: number }[] = [];
  const spendCalls: { domain: string; taskId: string; risk: number; subjectSha256: string; issuedAt: number }[] = [];
  return {
    quoteCalls,
    spendCalls,
    quote(req) {
      quoteCalls.push(req);
      return {
        allowed: opts.quoteAllowed ?? true,
        remaining: 10,
        reason: opts.quoteAllowed === false ? (opts.quoteReason ?? "trust budget exhausted") : undefined,
      };
    },
    spend(req) {
      spendCalls.push(req);
      return {
        accepted: opts.spendAccepted ?? true,
        remaining: 5,
        entrySha256: sha256Hex(JSON.stringify(req)),
      };
    },
  };
}

// ===========================================================================
// Construction
// ===========================================================================

describe("UnifiedTrustGate construction", () => {
  it("rejects an invalid global epsilon (0, 1, NaN, negative, >1) with a RangeError", () => {
    for (const bad of [0, 1, NaN, -0.1, 1.5, -Infinity, Infinity]) {
      expect(() => new UnifiedTrustGate(baseConfig({ epsilon: bad }))).toThrow(RangeError);
    }
  });

  it("rejects an invalid per-domain epsilon override with a RangeError, even when the global epsilon is valid", () => {
    for (const bad of [0, 1, NaN, -1]) {
      expect(() =>
        new UnifiedTrustGate(baseConfig({ perDomain: { memory: { epsilon: bad } } })),
      ).toThrow(RangeError);
    }
  });

  it("accepts a valid configuration and starts every domain uncalibrated", () => {
    const gate = new UnifiedTrustGate(baseConfig());
    expect(gate.stats()).toEqual({});
    const report = gate.report();
    expect(report.totalAdmitted).toBe(0);
    expect(report.totalAbstained).toBe(0);
    for (const domain of ["tool", "procedure", "memory", "message"] as const) {
      expect(report.perDomain[domain].calibrated).toBe(false);
      expect(report.perDomain[domain].stats).toBeNull();
    }
  });
});

// ===========================================================================
// Calibration
// ===========================================================================

describe("calibration", () => {
  it("is independent per domain: calibrating tool does not alter memory's threshold", () => {
    const gate = new UnifiedTrustGate(baseConfig());
    const memoryCalibration = makeCalibration(300, 41, 42, 0.6, 0.2);

    gate.calibrate("memory", memoryCalibration);
    const memoryStatsBefore = gate.stats().memory;
    expect(memoryStatsBefore).toBeDefined();

    gate.calibrate("tool", TOOL_CALIBRATION);
    const memoryStatsAfter = gate.stats().memory;

    expect(memoryStatsAfter).toEqual(memoryStatsBefore);
    expect(gate.stats().tool).not.toEqual(memoryStatsAfter);
  });

  it("uses a per-domain epsilon override instead of the global default", () => {
    const gate = new UnifiedTrustGate(baseConfig({ epsilon: EPSILON, perDomain: { memory: { epsilon: 0.3 } } }));
    gate.calibrate("tool", TOOL_CALIBRATION);
    gate.calibrate("memory", TOOL_CALIBRATION);

    const toolStats = gate.stats().tool!;
    const memoryStats = gate.stats().memory!;
    expect(toolStats.epsilon).toBe(EPSILON);
    expect(memoryStats.epsilon).toBe(0.3);
    // Different epsilon on identical calibration data -> different threshold.
    expect(memoryStats.threshold).not.toBe(toolStats.threshold);
    expect(memoryStats.threshold).toBe(conformalThreshold(TOOL_CALIBRATION, 0.3));
  });

  it("calibrateAll only calibrates the domains present in its input", () => {
    const gate = new UnifiedTrustGate(baseConfig());
    const result = gate.calibrateAll({ tool: TOOL_CALIBRATION, memory: TOOL_CALIBRATION });
    expect(Object.keys(result).sort()).toEqual(["memory", "tool"]);
    const stats = gate.stats();
    expect(stats.tool).toBeDefined();
    expect(stats.memory).toBeDefined();
    expect(stats.procedure).toBeUndefined();
    expect(stats.message).toBeUndefined();
  });
});

// ===========================================================================
// Abstention codes — one dedicated test per code
// ===========================================================================

describe("abstention codes", () => {
  it('"uncalibrated": admit() before calibrate() abstains, never throws, never issues a certificate', async () => {
    const registry = new VerifierRegistry();
    registry.registerAll(acceptVerifiers("never-calibrated"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));

    const admission = await gate.admit(subject({ subjectId: "never-calibrated" }));

    expect(admission.accepted).toBe(false);
    expect(admission.certificate).toBeUndefined();
    expect(admission.abstention?.code).toBe("uncalibrated");
    expect(admission.spentRisk).toBe(0);
    const report = gate.report();
    expect(report.perDomain.tool.abstentionsByCode.uncalibrated).toBe(1);
  });

  it('"no-verifier": a domain with nothing registered abstains', async () => {
    const registry = new VerifierRegistry();
    // Register something for "tool" so the registry isn't globally empty,
    // but nothing at all for "procedure".
    registry.registerAll(acceptVerifiers("elsewhere", "tool"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    gate.calibrate("procedure", TOOL_CALIBRATION);

    const admission = await gate.admit(subject({ subjectId: "orphan", domain: "procedure" }));

    expect(admission.accepted).toBe(false);
    expect(admission.certificate).toBeUndefined();
    expect(admission.abstention?.code).toBe("no-verifier");
  });

  it('"all-abstained": every selected verifier declines to vote', async () => {
    const registry = new VerifierRegistry();
    registry.register(abstainingVerifier("abstain-case", "memory"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    gate.calibrate("memory", TOOL_CALIBRATION);

    const admission = await gate.admit(subject({ subjectId: "abstain-case", domain: "memory" }));

    expect(admission.accepted).toBe(false);
    expect(admission.certificate).toBeUndefined();
    expect(admission.abstention?.code).toBe("all-abstained");
  });

  it('"degraded-evidence": a lone contributing verifier cannot certify (single-subject admit())', async () => {
    const registry = new VerifierRegistry();
    registry.register(loneVerifier("solo-voter"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    gate.calibrate("tool", TOOL_CALIBRATION);

    const admission = await gate.admit(subject({ subjectId: "lone-vote" }));

    expect(admission.accepted).toBe(false);
    expect(admission.certificate).toBeUndefined();
    expect(admission.abstention?.code).toBe("degraded-evidence");
  });

  it('"below-threshold": a fused score under the calibrated threshold abstains', async () => {
    const registry = new VerifierRegistry();
    registry.registerAll(belowThresholdVerifiers("too-weak"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    const stats = gate.calibrate("tool", TOOL_CALIBRATION);
    expect(stats.threshold).toBeGreaterThan(0); // sanity: 0.0 really is below it

    const admission = await gate.admit(subject({ subjectId: "too-weak" }));

    expect(admission.score).toBe(0);
    expect(admission.accepted).toBe(false);
    expect(admission.certificate).toBeUndefined();
    expect(admission.abstention?.code).toBe("below-threshold");
    expect(admission.abstention?.escalateTo).toBeUndefined();
  });

  it('"tier-floor": clears the raw threshold but sits under the tier\'s confidence floor, with escalateTo populated', async () => {
    const registry = new VerifierRegistry();
    registry.registerAll(tierFloorVerifiers("weak-tier-high-score"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    const stats = gate.calibrate("tool", TOOL_CALIBRATION);

    const admission = await gate.admit(subject({ subjectId: "weak-tier-high-score" }));

    // Clears the raw conformal threshold ...
    expect(admission.score).toBe(1);
    expect(admission.score).toBeGreaterThanOrEqual(stats.threshold);
    // ... but the T4 floor at this epsilon is far above what this
    // calibration set's pCorrect actually achieves.
    const floor = tierConfidenceFloor("T4-consistency", EPSILON);
    expect(admission.pCorrect).toBeLessThan(floor);
    expect(admission.tier).toBe("T4-consistency");

    expect(admission.accepted).toBe(false);
    expect(admission.certificate).toBeUndefined();
    expect(admission.abstention?.code).toBe("tier-floor");
    expect(admission.abstention?.escalateTo).toBe("T3-agreement");
  });

  it('"verifier-conflict": a strong-tier fail is never out-voted by weak-tier passes into acceptance', async () => {
    const registry = new VerifierRegistry();
    registry.registerAll(conflictVerifiers("t0-vetoes"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    const stats = gate.calibrate("tool", TOOL_CALIBRATION);

    const admission = await gate.admit(subject({ subjectId: "t0-vetoes" }));

    // Prove the veto is doing real work: the fused score alone clears the
    // raw threshold (a naive score-only gate WOULD have accepted this).
    expect(admission.score).toBe(1);
    expect(admission.score).toBeGreaterThanOrEqual(stats.threshold);

    expect(admission.accepted).toBe(false);
    expect(admission.certificate).toBeUndefined();
    expect(admission.abstention?.code).toBe("verifier-conflict");
  });

  it('"budget-exhausted": quote() refusal aborts before any certificate is built', async () => {
    const registry = new VerifierRegistry();
    registry.registerAll(acceptVerifiers("budget-quote-refuses"));
    const budget = budgetStub({ quoteAllowed: false, quoteReason: "domain risk budget depleted" });
    const gate = new UnifiedTrustGate(baseConfig({ registry, budget }));
    gate.calibrate("tool", TOOL_CALIBRATION);

    const admission = await gate.admit(subject({ subjectId: "budget-quote-refuses" }));

    expect(admission.accepted).toBe(false);
    expect(admission.certificate).toBeUndefined();
    expect(admission.abstention?.code).toBe("budget-exhausted");
    expect(admission.abstention?.message).toContain("domain risk budget depleted");
    expect(admission.spentRisk).toBe(0);
    expect(budget.quoteCalls).toHaveLength(1);
    expect(budget.quoteCalls[0].domain).toBe("tool");
    expect(budget.spendCalls).toHaveLength(0); // never reached
  });

  it('"budget-exhausted": spend() refusal rolls an already-issued certificate back to abstained', async () => {
    const registry = new VerifierRegistry();
    registry.registerAll(acceptVerifiers("budget-spend-refuses"));
    const budget = budgetStub({ quoteAllowed: true, spendAccepted: false });
    const gate = new UnifiedTrustGate(baseConfig({ registry, budget }));
    gate.calibrate("tool", TOOL_CALIBRATION);

    const admission = await gate.admit(subject({ subjectId: "budget-spend-refuses" }));

    expect(admission.accepted).toBe(false);
    expect(admission.certificate).toBeUndefined(); // built internally, but discarded
    expect(admission.abstention?.code).toBe("budget-exhausted");
    expect(admission.spentRisk).toBe(0);
    expect(budget.quoteCalls).toHaveLength(1);
    expect(budget.spendCalls).toHaveLength(1); // spend WAS attempted
  });
});

// ===========================================================================
// The central invariant, proven over a whole mixed batch
// ===========================================================================

describe("central invariant: accepted === (certificate !== undefined)", () => {
  it("holds across a mixed admitAll() batch touching every stage of the pipeline, and every issued certificate is real", async () => {
    const registry = new VerifierRegistry();
    registry.registerAll([
      ...acceptVerifiers("batch-accept-1", "tool"),
      ...belowThresholdVerifiers("batch-below", "tool"),
      ...tierFloorVerifiers("batch-floor", "tool"),
      ...conflictVerifiers("batch-conflict", "tool"),
      ...acceptVerifiers("batch-accept-2", "memory"),
      abstainingVerifier("batch-all-abstained", "memory"),
      // "procedure" gets nothing registered at all.
    ]);

    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    gate.calibrate("tool", TOOL_CALIBRATION);
    gate.calibrate("memory", TOOL_CALIBRATION);
    gate.calibrate("procedure", TOOL_CALIBRATION);
    // "message" is deliberately left uncalibrated.

    const subjects: TrustSubject[] = [
      subject({ subjectId: "batch-accept-1", domain: "tool" }),
      subject({ subjectId: "batch-below", domain: "tool" }),
      subject({ subjectId: "batch-floor", domain: "tool" }),
      subject({ subjectId: "batch-conflict", domain: "tool" }),
      subject({ subjectId: "batch-accept-2", domain: "memory" }),
      subject({ subjectId: "batch-all-abstained", domain: "memory" }),
      subject({ subjectId: "batch-no-verifier", domain: "procedure" }),
      subject({ subjectId: "batch-uncalibrated", domain: "message" }),
    ];
    const expectedCodes: (AbstentionCode | null)[] = [
      null,
      "below-threshold",
      "tier-floor",
      "verifier-conflict",
      null,
      "all-abstained",
      "no-verifier",
      "uncalibrated",
    ];

    const admissions = await gate.admitAll(subjects);
    expect(admissions).toHaveLength(subjects.length);

    for (const [i, admission] of admissions.entries()) {
      // THE invariant, checked on every single element of the batch.
      expect(admission.accepted).toBe(admission.certificate !== undefined);

      if (expectedCodes[i] === null) {
        expect(admission.accepted, `subject ${i} should have been accepted`).toBe(true);
        expect(admission.abstention).toBeUndefined();
        expect(admission.spentRisk).toBeGreaterThan(0);
      } else {
        expect(admission.accepted, `subject ${i} should have abstained`).toBe(false);
        expect(admission.abstention?.code).toBe(expectedCodes[i]);
        expect(admission.spentRisk).toBe(0);
      }
    }

    const acceptedIdx = [0, 4];
    const acceptedCerts = acceptedIdx.map((i) => admissions[i].certificate!);

    for (const cert of acceptedCerts) {
      expect(cert).toBeDefined();
      await expect(verifyCertificate(cert)).resolves.toBe(true);
    }

    // Each accepted cert certifies exactly its own subject's output, and
    // fails for every OTHER subject's output in the batch (accepted or not).
    for (const i of acceptedIdx) {
      const cert = admissions[i].certificate!;
      const ownOutput = subjects[i].output;
      await expect(certifiesOutput(cert, ownOutput)).resolves.toBe(true);
      await expect(certifiesOutput(cert, `${ownOutput}-tampered`)).resolves.toBe(false);
      for (let j = 0; j < subjects.length; j++) {
        if (j === i) continue;
        await expect(certifiesOutput(cert, subjects[j].output)).resolves.toBe(false);
      }
      expect(cert.payload.outputSha256).toBe(sha256Hex(ownOutput));
      expect(cert.payload.traceSha256).toBe(sha256Hex(canonicalTrace(subjects[i].trace)));
      expect(cert.payload.verifierVersions).toEqual(admissions[i].verifierVersions);
      expect(cert.payload.epsilon).toBe(EPSILON);
      expect(cert.payload.issuedAt).toBe(NOW_MS);
    }

    const report = gate.report();
    expect(report.totalAdmitted).toBe(2);
    expect(report.totalAbstained).toBe(6);
    expect(report.coverage).toBeCloseTo(2 / 8, 12);
  });
});

// ===========================================================================
// Monotonicity on real data
// ===========================================================================

describe("monotonicity", () => {
  it("a looser epsilon never lowers coverage and never raises the threshold, across an epsilon grid", () => {
    const calib = makeCalibration(500, 71, 72, 0.85, 0.1);
    const epsilons = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5];
    let prevThreshold = Infinity;
    let prevCoverage = -1;

    for (const eps of epsilons) {
      const gate = new UnifiedTrustGate(baseConfig({ epsilon: eps }));
      const stats = gate.calibrate("tool", calib);

      // Cross-check the wrapper against the independently-imported pure engine.
      expect(stats.threshold).toBe(conformalThreshold(calib, eps));

      expect(stats.threshold).toBeLessThanOrEqual(prevThreshold);
      expect(stats.coverageAtThreshold).toBeGreaterThanOrEqual(prevCoverage);
      prevThreshold = stats.threshold;
      prevCoverage = stats.coverageAtThreshold;
    }

    // The sweep actually moved (not a degenerate constant grid).
    expect(prevCoverage).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Tamper resistance
// ===========================================================================

describe("tamper resistance", () => {
  it("caller mutation of the subject after admission cannot desynchronize the certificate", async () => {
    const registry = new VerifierRegistry();
    registry.registerAll(acceptVerifiers("tamper-target"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    gate.calibrate("tool", TOOL_CALIBRATION);

    const mutableSubject = subject({ subjectId: "tamper-target" });
    const originalOutput = mutableSubject.output;
    const admission = await gate.admit(mutableSubject);
    expect(admission.certificate).toBeDefined();
    const cert = admission.certificate!;

    // Mutate the ORIGINAL subject object (and its trace) after the fact.
    (mutableSubject as { output: string }).output = "MUTATED-AFTER-THE-FACT";
    (mutableSubject.trace as unknown as { seq: number; kind: string; detail: string }[]).push({
      seq: 999,
      kind: "tamper",
      detail: "injected after admission",
    });

    // The signature itself is untouched by caller-side mutation (the gate
    // deep-copied what it signed).
    await expect(verifyCertificate(cert)).resolves.toBe(true);
    // It still certifies the ORIGINAL output ...
    await expect(certifiesOutput(cert, originalOutput)).resolves.toBe(true);
    // ... and now correctly REFUSES to certify the mutated text.
    await expect(certifiesOutput(cert, mutableSubject.output)).resolves.toBe(false);
  });

  it("mutating a certificate payload field invalidates verifyCertificate", async () => {
    const registry = new VerifierRegistry();
    registry.registerAll(acceptVerifiers("payload-tamper"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    gate.calibrate("tool", TOOL_CALIBRATION);

    const admission = await gate.admit(subject({ subjectId: "payload-tamper" }));
    const cert = admission.certificate!;
    await expect(verifyCertificate(cert)).resolves.toBe(true);

    const tampered = { ...cert, payload: { ...cert.payload, pCorrect: 0.999999 } };
    await expect(verifyCertificate(tampered)).resolves.toBe(false);

    const tamperedVersions = {
      ...cert,
      payload: { ...cert.payload, verifierVersions: [...cert.payload.verifierVersions, "injected@9.9.9"] },
    };
    await expect(verifyCertificate(tamperedVersions)).resolves.toBe(false);
  });
});

// ===========================================================================
// Determinism / purity
// ===========================================================================

describe("determinism and purity", () => {
  it("admit() is deterministic given the same subject, calibration, and injected clock", async () => {
    const registry = new VerifierRegistry();
    registry.registerAll(acceptVerifiers("det-check"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    gate.calibrate("tool", TOOL_CALIBRATION);

    const s = subject({ subjectId: "det-check" });
    const a1 = await gate.admit(s);
    const a2 = await gate.admit(s);

    expect(a1.certificate?.signature).toBe(a2.certificate?.signature);
    expect(a1.certificate?.payload).toEqual(a2.certificate?.payload);
    expect(a1.score).toBe(a2.score);
    expect(a1.pCorrect).toBe(a2.pCorrect);
    expect(a1.threshold).toBe(a2.threshold);
    expect(a1.spentRisk).toBe(a2.spentRisk);
  });

  it("admitAll matches sequential admit() when every subject has 2+ contributing voters", async () => {
    const registry = new VerifierRegistry();
    registry.registerAll([
      ...acceptVerifiers("multi-accept"),
      ...belowThresholdVerifiers("multi-below"),
      ...tierFloorVerifiers("multi-floor"),
      ...conflictVerifiers("multi-conflict"),
    ]);
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    gate.calibrate("tool", TOOL_CALIBRATION);

    const subjects = ["multi-accept", "multi-below", "multi-floor", "multi-conflict"].map((subjectId) =>
      subject({ subjectId }),
    );

    const sequential = [];
    for (const s of subjects) sequential.push(await gate.admit(s));

    const batched = await gate.admitAll(subjects);

    expect(batched).toEqual(sequential);
  });

  it("admitAll does NOT force a single-voter subject into degraded-evidence the way sequential admit() does (documented divergence)", async () => {
    const registry = new VerifierRegistry();
    registry.register(loneVerifier("shared-solo-voter"));
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    gate.calibrate("tool", TOOL_CALIBRATION);

    // Alone via admit(): the registry has nothing else to check this lone
    // voter's votes against, so it is forced "single-verifier" -> degraded.
    const alone = await gate.admit(subject({ subjectId: "solo-alone" }));
    expect(alone.accepted).toBe(false);
    expect(alone.abstention?.code).toBe("degraded-evidence");

    // The SAME lone verifier, voting on several subjects in one admitAll()
    // batch, gives WeakVerifierEnsemble other votes from that verifier to
    // check for agreement -- registry.verifyBatch() never reports
    // "single-verifier", so the gate does not force degraded-evidence here.
    const batchSubjects = Array.from({ length: 5 }, (_, i) => subject({ subjectId: `solo-batch-${i}` }));
    const batchAdmissions = await gate.admitAll(batchSubjects);
    for (const admission of batchAdmissions) {
      expect(admission.abstention?.code).not.toBe("degraded-evidence");
      expect(admission.accepted).toBe(true);
      expect(admission.certificate).toBeDefined();
    }
  });
});

// ===========================================================================
// formatTrustGateReport
// ===========================================================================

describe("formatTrustGateReport", () => {
  it("renders aligned plain ASCII text — never HTML/markup", async () => {
    const registry = new VerifierRegistry();
    registry.registerAll([...acceptVerifiers("report-accept"), ...belowThresholdVerifiers("report-below")]);
    const gate = new UnifiedTrustGate(baseConfig({ registry }));
    gate.calibrate("tool", TOOL_CALIBRATION);

    await gate.admit(subject({ subjectId: "report-accept" }));
    await gate.admit(subject({ subjectId: "report-below" }));

    const text = formatTrustGateReport(gate.report());

    expect(text).toContain("DOMAIN");
    expect(text).toContain("tool");
    expect(text).toContain("TOTAL");
    expect(text).toContain("below-threshold=1");
    expect(text).not.toMatch(/<\/?[a-z][\s\S]*>/i); // no HTML tags anywhere
    expect(text.split("\n").length).toBeGreaterThan(3);

    // Header and separator rows share the same column widths (alignment).
    const lines = text.split("\n");
    expect(lines[0].length).toBe(lines[1].length);
  });

  it("still renders a well-formed table before anything has been admitted", () => {
    const gate = new UnifiedTrustGate(baseConfig());
    const text = formatTrustGateReport(gate.report());
    expect(text).toContain("TOTAL");
    expect(text).toContain("admitted=0");
    expect(text).not.toMatch(/<\/?[a-z][\s\S]*>/i);
  });
});
