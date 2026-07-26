import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  VerifierRegistry,
  normalizeVerdict,
  subjectKey,
  canonicalTrace,
  type TrustSubject,
  type TrustTraceStep,
  type UniversalVerifier,
  type UniversalVerdict,
} from "../registry";
import { TIER_ORDER, type TierId } from "../../styx/tiers";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function subject(overrides: Partial<TrustSubject> = {}): TrustSubject {
  return {
    domain: "tool",
    subjectId: "fs.read",
    taskId: "task-1",
    input: "read config.json",
    output: "{\"ok\":true}",
    evidence: {},
    trace: [{ seq: 1, kind: "call", detail: "fs.read(config.json)" }],
    ...overrides,
  };
}

/** An honest verifier that votes `pass` iff `subject.output` matches a target string. */
function honestVerifier(
  id: string,
  opts: { domain?: TrustSubject["domain"]; tier?: TierId; prior?: number; passWhen?: (s: TrustSubject) => boolean } = {},
): UniversalVerifier {
  return {
    id,
    version: "1.0.0",
    domain: opts.domain ?? "tool",
    tier: opts.tier ?? "T2-genrm",
    prior: opts.prior ?? 0.9,
    appliesTo: (s) => s.domain === (opts.domain ?? "tool"),
    verify: (s) => ({
      verifierId: id,
      version: "1.0.0",
      tier: opts.tier ?? "T2-genrm",
      passed: (opts.passWhen ?? (() => true))(s),
      confidence: 0.85,
      reasons: [],
      abstained: false,
    }),
  };
}

function alwaysPassVerifier(id: string, opts: { prior?: number } = {}): UniversalVerifier {
  return {
    id,
    version: "1.0.0",
    domain: "tool",
    tier: "T4-consistency",
    prior: opts.prior ?? 0.9,
    appliesTo: () => true,
    verify: () => ({
      verifierId: id,
      version: "1.0.0",
      tier: "T4-consistency",
      passed: true,
      confidence: 0.95,
      reasons: [],
      abstained: false,
    }),
  };
}

function throwingVerifier(id: string): UniversalVerifier {
  return {
    id,
    version: "1.0.0",
    domain: "tool",
    tier: "T3-agreement",
    prior: 0.8,
    appliesTo: () => true,
    verify: () => {
      throw new Error("kaboom");
    },
  };
}

function rejectingVerifier(id: string): UniversalVerifier {
  return {
    id,
    version: "1.0.0",
    domain: "tool",
    tier: "T3-agreement",
    prior: 0.8,
    appliesTo: () => true,
    verify: async () => {
      throw new Error("async kaboom");
    },
  };
}

function hangingVerifier(id: string): UniversalVerifier {
  return {
    id,
    version: "1.0.0",
    domain: "tool",
    tier: "T1-reference",
    prior: 0.95,
    appliesTo: () => true,
    verify: () => new Promise<UniversalVerdict>(() => {}), // never resolves
  };
}

function malformedVerifier(id: string, badReturn: unknown): UniversalVerifier {
  return {
    id,
    version: "1.0.0",
    domain: "tool",
    tier: "T2-genrm",
    prior: 0.9,
    appliesTo: () => true,
    verify: () => badReturn as UniversalVerdict,
  };
}

// ===========================================================================
// canonicalTrace / subjectKey
// ===========================================================================

describe("canonicalTrace", () => {
  it("is a deterministic function of step content and order", () => {
    const trace: TrustTraceStep[] = [
      { seq: 1, kind: "call", detail: "a" },
      { seq: 2, kind: "result", detail: "b" },
    ];
    expect(canonicalTrace(trace)).toBe(canonicalTrace([...trace]));
  });

  it("produces distinct output for reordered steps (order is semantically significant)", () => {
    const a: TrustTraceStep[] = [
      { seq: 1, kind: "call", detail: "x" },
      { seq: 2, kind: "result", detail: "y" },
    ];
    const b: TrustTraceStep[] = [
      { seq: 2, kind: "result", detail: "y" },
      { seq: 1, kind: "call", detail: "x" },
    ];
    expect(canonicalTrace(a)).not.toBe(canonicalTrace(b));
  });

  it("treats non-array input defensively as empty", () => {
    expect(canonicalTrace(null as unknown as TrustTraceStep[])).toBe("[]");
  });
});

describe("subjectKey — injection / collision resistance", () => {
  it("is a real sha256 hex digest", () => {
    const s = subject();
    const key = subjectKey(s);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Cross-check against an independent sha256 implementation over the same
    // JSON-encoded structure to prove this is a real hash, not a stub.
    const encoded = JSON.stringify({
      domain: s.domain,
      subjectId: s.subjectId,
      taskId: s.taskId,
      input: s.input,
      output: s.output,
      evidence: JSON.stringify(s.evidence),
      trace: canonicalTrace(s.trace),
    });
    expect(key).toBe(sha256Hex(encoded));
  });

  it("is deterministic and stable across repeated calls", () => {
    const s = subject();
    expect(subjectKey(s)).toBe(subjectKey(s));
  });

  it("differs when trace order differs, even with identical steps", () => {
    const a = subject({
      trace: [
        { seq: 1, kind: "call", detail: "x" },
        { seq: 2, kind: "result", detail: "y" },
      ],
    });
    const b = subject({
      trace: [
        { seq: 2, kind: "result", detail: "y" },
        { seq: 1, kind: "call", detail: "x" },
      ],
    });
    expect(subjectKey(a)).not.toBe(subjectKey(b));
  });

  it("differs when evidence key insertion order differs", () => {
    const evA: Record<string, unknown> = {};
    evA.alpha = 1;
    evA.beta = 2;
    const evB: Record<string, unknown> = {};
    evB.beta = 2;
    evB.alpha = 1;
    const a = subject({ evidence: evA });
    const b = subject({ evidence: evB });
    expect(subjectKey(a)).not.toBe(subjectKey(b));
  });

  it("does not collide under a classic delimiter-boundary attack across fields", () => {
    // A naive `subjectId + "|" + taskId` join would make these two collide:
    // ("a|b", "c") -> "a|b|c"  and  ("a", "b|c") -> "a|b|c"
    const a = subject({ subjectId: "a|b", taskId: "c" });
    const b = subject({ subjectId: "a", taskId: "b|c" });
    expect(subjectKey(a)).not.toBe(subjectKey(b));
  });

  it("does not collide when embedded separators (space, quote) straddle field boundaries", () => {
    const a = subject({ input: 'say "hi' + ' there"', output: "ok" });
    const b = subject({ input: 'say "hi', output: ' there"ok' });
    expect(subjectKey(a)).not.toBe(subjectKey(b));
  });

  it("differs across domains for otherwise-identical subjects", () => {
    const a = subject({ domain: "tool" });
    const b = subject({ domain: "memory" });
    expect(subjectKey(a)).not.toBe(subjectKey(b));
  });
});

// ===========================================================================
// normalizeVerdict — adversary-first
// ===========================================================================

describe("normalizeVerdict", () => {
  const source = honestVerifier("norm.honest", { tier: "T2-genrm", prior: 0.8 });

  it("passes through a well-formed verdict unchanged (modulo pass-through fields)", () => {
    // T0-execution / prior 0.95 / confidence 0.95 clears its tier's
    // calibrated confidence floor, so no "below-tier-floor" annotation is
    // expected here — that behavior is covered separately below.
    const clearSource = honestVerifier("norm.honest.clear", { tier: "T0-execution", prior: 0.95 });
    const v = normalizeVerdict(
      { verifierId: "norm.honest.clear", version: "1.0.0", tier: "T0-execution", passed: true, confidence: 0.95, reasons: [] },
      clearSource,
    );
    expect(v).toEqual({
      verifierId: "norm.honest.clear",
      version: "1.0.0",
      tier: "T0-execution",
      passed: true,
      confidence: 0.95,
      reasons: [],
      abstained: false,
    });
  });

  it("annotates (but does not reject) a verdict whose confidence is below its own tier's calibrated floor", () => {
    const v = normalizeVerdict({ passed: true, confidence: 0.5 }, source); // T2-genrm floor(eps=0.1) = 0.975
    expect(v.abstained).toBe(false);
    expect(v.passed).toBe(true);
    expect(v.confidence).toBe(0.5);
    expect(v.reasons).toContain("below-tier-floor");
  });

  it.each([null, undefined, "not-an-object", 42, true])("abstains on non-object return value %p", (bad) => {
    const v = normalizeVerdict(bad, source);
    expect(v.abstained).toBe(true);
    expect(v.passed).toBe(false);
    expect(v.confidence).toBe(0);
    expect(v.reasons).toContain("invalid-verdict-shape");
  });

  it("abstains when passed is not boolean", () => {
    const v = normalizeVerdict({ passed: "yes", confidence: 0.9 }, source);
    expect(v.abstained).toBe(true);
    expect(v.reasons).toContain("invalid-passed-field");
  });

  it.each([NaN, Infinity, -Infinity, "0.9", null, undefined])(
    "abstains on non-finite confidence %p",
    (bad) => {
      const v = normalizeVerdict({ passed: true, confidence: bad }, source);
      expect(v.abstained).toBe(true);
      expect(v.passed).toBe(false);
      expect(v.reasons).toContain("non-finite-confidence");
    },
  );

  it.each([-0.0001, -1, 1.0001, 2, 999])("abstains on out-of-range confidence %p", (bad) => {
    const v = normalizeVerdict({ passed: true, confidence: bad }, source);
    expect(v.abstained).toBe(true);
    expect(v.reasons).toContain("confidence-out-of-range");
  });

  it("never counts a malformed verdict as a pass", () => {
    for (const bad of [null, { passed: "yes" }, { passed: true, confidence: NaN }, { passed: true, confidence: 5 }]) {
      const v = normalizeVerdict(bad, source);
      expect(v.passed).toBe(false);
      expect(v.abstained).toBe(true);
    }
  });

  it("honors an explicit self-abstain regardless of passed/confidence", () => {
    const v = normalizeVerdict({ abstained: true, passed: true, confidence: 0.99 }, source);
    expect(v.abstained).toBe(true);
    expect(v.passed).toBe(false);
    expect(v.confidence).toBe(0);
    expect(v.reasons).toContain("verifier-self-abstained");
  });

  it("clamps confidence to the verifier's registered prior (prior acts as a ceiling)", () => {
    const cappedSource = honestVerifier("norm.capped", { prior: 0.55 });
    const v = normalizeVerdict({ passed: true, confidence: 0.99 }, cappedSource);
    expect(v.confidence).toBe(0.55);
    expect(v.reasons).toContain("confidence-capped-by-prior");
  });

  it("does not touch confidence when it is already <= prior", () => {
    const cappedSource = honestVerifier("norm.uncapped", { prior: 0.9 });
    const v = normalizeVerdict({ passed: true, confidence: 0.4 }, cappedSource);
    expect(v.confidence).toBe(0.4);
    expect(v.reasons).not.toContain("confidence-capped-by-prior");
  });

  it("clamps a tier overclaim down to the verifier's registered tier", () => {
    const t3Source = honestVerifier("norm.t3", { tier: "T3-agreement" });
    const v = normalizeVerdict({ passed: true, confidence: 0.5, tier: "T0-execution" }, t3Source);
    expect(v.tier).toBe("T3-agreement");
    expect(v.reasons.some((r) => r.startsWith("tier-overclaim-clamped"))).toBe(true);
  });

  it("allows a verifier to self-report a WEAKER tier than registered (not an overclaim)", () => {
    const t1Source = honestVerifier("norm.t1", { tier: "T1-reference" });
    const v = normalizeVerdict({ passed: true, confidence: 0.5, tier: "T4-consistency" }, t1Source);
    expect(v.tier).toBe("T4-consistency");
    expect(v.reasons.some((r) => r.startsWith("tier-overclaim-clamped"))).toBe(false);
  });

  it("falls back to the verifier's registered tier when tier is missing/invalid", () => {
    const v = normalizeVerdict({ passed: true, confidence: 0.5, tier: "not-a-real-tier" }, source);
    expect(v.tier).toBe(source.tier);
  });

  it("always stamps verifierId/version from the registered source, not the raw payload", () => {
    const v = normalizeVerdict({ verifierId: "someone-else", version: "9.9.9", passed: true, confidence: 0.1 }, source);
    expect(v.verifierId).toBe(source.id);
    expect(v.version).toBe(source.version);
  });
});

// ===========================================================================
// VerifierRegistry — registration integrity
// ===========================================================================

describe("VerifierRegistry — registration", () => {
  let registry: VerifierRegistry;
  beforeEach(() => {
    registry = new VerifierRegistry();
  });

  it("registers and lists verifiers deterministically sorted by id", () => {
    registry.registerAll([honestVerifier("zeta"), honestVerifier("alpha"), honestVerifier("mid")]);
    expect(registry.list().map((v) => v.id)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("has() reflects registration state", () => {
    expect(registry.has("alpha")).toBe(false);
    registry.register(honestVerifier("alpha"));
    expect(registry.has("alpha")).toBe(true);
  });

  it("calibration() reports tier/prior/domain for every registered verifier", () => {
    registry.register(honestVerifier("a1", { tier: "T1-reference", prior: 0.77, domain: "memory" }));
    expect(registry.calibration()).toEqual({ a1: { tier: "T1-reference", prior: 0.77, domain: "memory" } });
  });

  it("re-registering the identical (id, version) is an idempotent no-op", () => {
    const v = honestVerifier("dup");
    registry.register(v);
    expect(() => registry.register({ ...v })).not.toThrow();
    expect(registry.list()).toHaveLength(1);
  });

  it("re-registering the same id with a DIFFERENT version is a hard error", () => {
    registry.register(honestVerifier("dup"));
    const v2: UniversalVerifier = { ...honestVerifier("dup"), version: "2.0.0" };
    expect(() => registry.register(v2)).toThrow(/conflicting version/);
    // no silent last-write-wins: the original registration is untouched
    expect(registry.calibration().dup).toBeDefined();
    expect(registry.list().find((v) => v.id === "dup")?.version).toBe("1.0.0");
  });

  it("rejects ids that violate the documented charset", () => {
    for (const badId of ["", "A", "Has-Upper", "has space", "x", "no/slash", "-leadingdash"]) {
      expect(() => registry.register(honestVerifier(badId))).toThrow();
    }
  });

  it("rejects an invalid domain", () => {
    const bad = { ...honestVerifier("bad-domain"), domain: "not-a-domain" } as unknown as UniversalVerifier;
    expect(() => registry.register(bad)).toThrow();
  });

  it("rejects an invalid tier", () => {
    const bad = { ...honestVerifier("bad-tier"), tier: "T9-madeup" } as unknown as UniversalVerifier;
    expect(() => registry.register(bad)).toThrow();
  });

  it("rejects a prior outside [0,1]", () => {
    expect(() => registry.register(honestVerifier("bad-prior-hi", { prior: 1.5 }))).toThrow();
    expect(() => registry.register(honestVerifier("bad-prior-lo", { prior: -0.1 }))).toThrow();
    expect(() => registry.register(honestVerifier("bad-prior-nan", { prior: NaN }))).toThrow();
  });
});

// ===========================================================================
// VerifierRegistry — select()
// ===========================================================================

describe("VerifierRegistry — select()", () => {
  let registry: VerifierRegistry;
  beforeEach(() => {
    registry = new VerifierRegistry();
  });

  it("only selects verifiers whose domain matches and appliesTo() is true", () => {
    registry.registerAll([
      honestVerifier("tool.v1", { domain: "tool" }),
      honestVerifier("memory.v1", { domain: "memory" }),
    ]);
    const s = subject({ domain: "tool" });
    expect(registry.select(s).map((v) => v.id)).toEqual(["tool.v1"]);
  });

  it("excludes (not throws) a verifier whose appliesTo() throws", () => {
    const bad: UniversalVerifier = {
      id: "throws-applies",
      version: "1.0.0",
      domain: "tool",
      tier: "T4-consistency",
      prior: 0.5,
      appliesTo: () => {
        throw new Error("nope");
      },
      verify: () => ({ verifierId: "throws-applies", version: "1.0.0", tier: "T4-consistency", passed: true, confidence: 0.5, reasons: [], abstained: false }),
    };
    registry.register(bad);
    expect(() => registry.select(subject())).not.toThrow();
    expect(registry.select(subject())).toEqual([]);
  });

  it("rejects a verifier whose registered domain disagrees with a subject it claims via appliesTo, with a reason, not by silently running it", () => {
    const confused: UniversalVerifier = {
      id: "confused.verifier",
      version: "1.0.0",
      domain: "memory", // registered as memory
      tier: "T4-consistency",
      prior: 0.5,
      appliesTo: () => true, // but claims EVERY subject, including "tool" ones
      verify: () => ({ verifierId: "confused.verifier", version: "1.0.0", tier: "T4-consistency", passed: true, confidence: 0.99, reasons: [], abstained: false }),
    };
    registry.register(confused);
    const s = subject({ domain: "tool" });
    expect(registry.select(s)).toEqual([]);

    const diag = registry.selectWithDiagnostics(s).find((d) => d.verifier.id === "confused.verifier");
    expect(diag?.included).toBe(false);
    expect(diag?.reason).toMatch(/domain-mismatch/);
  });
});

// ===========================================================================
// VerifierRegistry — verify(): adversarial per-verifier handling
// ===========================================================================

describe("VerifierRegistry — verify() adversarial handling", () => {
  let registry: VerifierRegistry;
  beforeEach(() => {
    registry = new VerifierRegistry();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a throwing verifier abstains and is never counted as a pass", async () => {
    registry.register(throwingVerifier("bad.throws"));
    const result = await registry.verify(subject());
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].abstained).toBe(true);
    expect(result.verdicts[0].passed).toBe(false);
    expect(result.verdicts[0].reasons).toContain("verifier-threw");
    expect(result.abstainedIds).toEqual(["bad.throws"]);
    expect(result.degradedReason).toBe("all-abstained");
  });

  it("a verifier returning a rejected promise abstains and is never counted as a pass", async () => {
    registry.register(rejectingVerifier("bad.rejects"));
    const result = await registry.verify(subject());
    expect(result.verdicts[0].abstained).toBe(true);
    expect(result.verdicts[0].reasons).toContain("verifier-threw");
  });

  it("a hanging verifier abstains via timeout (no real sleeping)", async () => {
    vi.useFakeTimers();
    registry.register(hangingVerifier("bad.hangs"));
    const p = registry.verify(subject(), { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    const result = await p;
    expect(result.verdicts[0].abstained).toBe(true);
    expect(result.verdicts[0].reasons).toContain("verifier-timeout");
  }, 10_000);

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "not-a-verdict"],
    ["NaN confidence", { passed: true, confidence: NaN }],
    ["Infinity confidence", { passed: true, confidence: Infinity }],
    ["out-of-range confidence", { passed: true, confidence: 42 }],
  ] as const)("a verifier returning %s abstains", async (_label, badReturn) => {
    registry.register(malformedVerifier("bad.malformed", badReturn));
    const result = await registry.verify(subject());
    expect(result.verdicts[0].abstained).toBe(true);
    expect(result.verdicts[0].passed).toBe(false);
  });

  it("degradedReason is 'no-verifier' when nothing is selected", async () => {
    const result = await registry.verify(subject());
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("no-verifier");
    expect(result.score).toBe(0.5);
    expect(result.verdicts).toEqual([]);
  });
});

// ===========================================================================
// VerifierRegistry — tier overclaim / weakest-tier-wins
// ===========================================================================

describe("VerifierRegistry — tier semantics", () => {
  let registry: VerifierRegistry;
  beforeEach(() => {
    registry = new VerifierRegistry();
  });

  it("a co-voting weak (T4) verifier drags the fused tier down even though a strong (T0) verifier also passed", async () => {
    const oracle: UniversalVerifier = {
      id: "oracle.t0",
      version: "1.0.0",
      domain: "tool",
      tier: "T0-execution",
      prior: 0.99,
      appliesTo: () => true,
      verify: () => ({ verifierId: "oracle.t0", version: "1.0.0", tier: "T0-execution", passed: true, confidence: 0.98, reasons: [], abstained: false }),
    };
    const weak: UniversalVerifier = {
      id: "weak.t4",
      version: "1.0.0",
      domain: "tool",
      tier: "T4-consistency",
      prior: 0.6,
      appliesTo: () => true,
      verify: () => ({ verifierId: "weak.t4", version: "1.0.0", tier: "T4-consistency", passed: true, confidence: 0.55, reasons: [], abstained: false }),
    };
    registry.registerAll([oracle, weak]);
    const result = await registry.verify(subject());
    expect(result.tier).toBe("T4-consistency");
    expect(result.tier).not.toBe("T0-execution");
  });

  it("an abstaining verifier's tier does not drag down the fused tier of the verifiers that actually contributed", async () => {
    const oracle: UniversalVerifier = {
      id: "oracle.t0b",
      version: "1.0.0",
      domain: "tool",
      tier: "T0-execution",
      prior: 0.99,
      appliesTo: () => true,
      verify: () => ({ verifierId: "oracle.t0b", version: "1.0.0", tier: "T0-execution", passed: true, confidence: 0.98, reasons: [], abstained: false }),
    };
    const strong2: UniversalVerifier = {
      id: "oracle2.t0",
      version: "1.0.0",
      domain: "tool",
      tier: "T0-execution",
      prior: 0.97,
      appliesTo: () => true,
      verify: () => ({ verifierId: "oracle2.t0", version: "1.0.0", tier: "T0-execution", passed: true, confidence: 0.9, reasons: [], abstained: false }),
    };
    const abstainer = throwingVerifier("weak.abstains"); // T3-agreement, but throws -> abstains
    registry.registerAll([oracle, strong2, abstainer]);
    const result = await registry.verify(subject());
    expect(result.tier).toBe("T0-execution");
    expect(result.abstainedIds).toContain("weak.abstains");
  });

  it("a verdict claiming a stronger tier than registered cannot leak that strength into the fused result", async () => {
    const overclaimer: UniversalVerifier = {
      id: "overclaimer",
      version: "1.0.0",
      domain: "tool",
      tier: "T4-consistency", // registered weak
      prior: 0.9,
      appliesTo: () => true,
      verify: () => ({ verifierId: "overclaimer", version: "1.0.0", tier: "T0-execution", passed: true, confidence: 0.9, reasons: [], abstained: false }), // claims oracle-tier
    };
    const honest2: UniversalVerifier = {
      id: "honest2",
      version: "1.0.0",
      domain: "tool",
      tier: "T4-consistency",
      prior: 0.9,
      appliesTo: () => true,
      verify: () => ({ verifierId: "honest2", version: "1.0.0", tier: "T4-consistency", passed: true, confidence: 0.9, reasons: [], abstained: false }),
    };
    registry.registerAll([overclaimer, honest2]);
    const result = await registry.verify(subject());
    expect(result.tier).toBe("T4-consistency");
    const overclaimVerdict = result.verdicts.find((v) => v.verifierId === "overclaimer");
    expect(overclaimVerdict?.tier).toBe("T4-consistency");
    expect(overclaimVerdict?.reasons.some((r) => r.startsWith("tier-overclaim-clamped"))).toBe(true);
  });
});

// ===========================================================================
// VerifierRegistry — single-subject verify() degradation
// ===========================================================================

describe("VerifierRegistry — verify() degradation semantics", () => {
  let registry: VerifierRegistry;
  beforeEach(() => {
    registry = new VerifierRegistry();
  });

  it("single contributing verifier: score is that verdict's own prior-damped confidence, marked degraded", async () => {
    registry.register(honestVerifier("solo", { prior: 0.7 }));
    const result = await registry.verify(subject());
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("single-verifier");
    // honestVerifier reports confidence 0.85, capped by prior 0.7
    expect(result.score).toBe(0.7);
    expect(result.weights.solo).toBeCloseTo(0.7);
  });

  it("two+ contributing verifiers: real ensemble runs, not degraded", async () => {
    registry.registerAll([
      honestVerifier("a1", { prior: 0.9 }),
      honestVerifier("a2", { prior: 0.9 }),
    ]);
    const result = await registry.verify(subject());
    expect(result.degraded).toBe(false);
    expect(result.degradedReason).toBeUndefined();
    // reliabilities() should now be populated from the real ensemble fit
    expect(Object.keys(registry.reliabilities()).sort()).toEqual(["a1", "a2"]);
  });

  it("all verifiers abstaining: degraded 'all-abstained', neutral score", async () => {
    registry.registerAll([throwingVerifier("t1"), throwingVerifier("t2")]);
    const result = await registry.verify(subject());
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("all-abstained");
    expect(result.score).toBe(0.5);
  });
});

// ===========================================================================
// VerifierRegistry — determinism
// ===========================================================================

describe("VerifierRegistry — determinism", () => {
  it("fused output is identical regardless of registration order", async () => {
    const verifiers = [
      honestVerifier("d1", { prior: 0.8 }),
      honestVerifier("d2", { prior: 0.85, passWhen: () => false }),
      honestVerifier("d3", { prior: 0.75 }),
    ];

    const forward = new VerifierRegistry();
    forward.registerAll(verifiers);
    const backward = new VerifierRegistry();
    backward.registerAll([...verifiers].reverse());

    const s = subject();
    const [resultForward, resultBackward] = await Promise.all([forward.verify(s), backward.verify(s)]);

    expect(resultForward).toEqual(resultBackward);
  });

  it("fused output is identical regardless of async resolution order", async () => {
    function delayedVerifier(id: string, delayMs: number, passed: boolean): UniversalVerifier {
      return {
        id,
        version: "1.0.0",
        domain: "tool",
        tier: "T3-agreement",
        prior: 0.85,
        appliesTo: () => true,
        verify: () =>
          new Promise<UniversalVerdict>((resolve) => {
            setTimeout(
              () =>
                resolve({
                  verifierId: id,
                  version: "1.0.0",
                  tier: "T3-agreement",
                  passed,
                  confidence: 0.8,
                  reasons: [],
                  abstained: false,
                }),
              delayMs,
            );
          }),
      };
    }

    // Same three verifiers, but registered/delayed so resolution order flips.
    const slowFirst = new VerifierRegistry();
    slowFirst.registerAll([delayedVerifier("r1", 30, true), delayedVerifier("r2", 20, false), delayedVerifier("r3", 10, true)]);
    const fastFirst = new VerifierRegistry();
    fastFirst.registerAll([delayedVerifier("r1", 10, true), delayedVerifier("r2", 20, false), delayedVerifier("r3", 30, true)]);

    const s = subject();
    const [a, b] = await Promise.all([slowFirst.verify(s), fastFirst.verify(s)]);

    // verdict order (by id) and content must match regardless of resolution timing
    expect(a.verdicts.map((v) => v.verifierId)).toEqual(["r1", "r2", "r3"]);
    expect(b.verdicts.map((v) => v.verifierId)).toEqual(["r1", "r2", "r3"]);
    expect(a.score).toBe(b.score);
    expect(a.agreement).toBe(b.agreement);
    expect(a.weights).toEqual(b.weights);
    expect(a.tier).toBe(b.tier);
  });
});

// ===========================================================================
// verifyBatch() — real single-fitPredict-call fusion + adversarial reliability
// ===========================================================================

describe("VerifierRegistry — verifyBatch()", () => {
  it("fuses via one real WeakVerifierEnsemble.fitPredict call, collapsing an always-pass liar's reliability against honest disagreement", async () => {
    const registry = new VerifierRegistry();

    const liar = alwaysPassVerifier("liar.always-pass", { prior: 0.95 });

    // Three honest verifiers that vote based on real subject content (agree
    // with each other on the ground truth encoded in evidence.groundTruth,
    // and mostly disagree with the liar).
    function honestByGroundTruth(id: string): UniversalVerifier {
      return {
        id,
        version: "1.0.0",
        domain: "tool",
        tier: "T2-genrm",
        prior: 0.9,
        appliesTo: () => true,
        verify: (s) => ({
          verifierId: id,
          version: "1.0.0",
          tier: "T2-genrm",
          passed: s.evidence.groundTruth === true,
          confidence: 0.85,
          reasons: [],
          abstained: false,
        }),
      };
    }
    const honestVerifiers = [honestByGroundTruth("honest.h1"), honestByGroundTruth("honest.h2"), honestByGroundTruth("honest.h3")];
    registry.registerAll([liar, ...honestVerifiers]);

    // Build a batch where ground truth is mostly false (liar always says
    // pass; honest verifiers correctly say fail most of the time), with one
    // item where ONLY the liar passes (ground truth false) to test that its
    // lone-pass score stays below honest consensus.
    const groundTruths = [false, false, false, false, true, false, false, true, false, false];
    const subjects = groundTruths.map((gt, i) =>
      subject({ subjectId: `batch-${i}`, taskId: `task-${i}`, evidence: { groundTruth: gt } }),
    );

    const results = await registry.verifyBatch(subjects);
    expect(results).toHaveLength(subjects.length);

    const reliabilities = registry.reliabilities();
    expect(reliabilities["liar.always-pass"]).toBeDefined();
    expect(reliabilities["honest.h1"]).toBeDefined();

    // The liar votes "pass" unconditionally, disagreeing with the honest
    // consensus on every false-ground-truth item (8 of 10) -> its reliability
    // must collapse well below the honest verifiers', which agree with the
    // ground-truth-driven consensus on every item.
    const avgHonest = (reliabilities["honest.h1"] + reliabilities["honest.h2"] + reliabilities["honest.h3"]) / 3;
    expect(reliabilities["liar.always-pass"]).toBeLessThan(avgHonest);
    expect(reliabilities["liar.always-pass"]).toBeLessThan(0.5);
    expect(avgHonest).toBeGreaterThan(0.5);

    // On a false-ground-truth item where the liar alone "passed" (all
    // honest verifiers correctly failed it), the fused score must stay
    // below the honest consensus score on a true-ground-truth item (where
    // everyone, including by-chance the liar, agrees it should pass).
    const liarAloneIdx = groundTruths.findIndex((gt) => gt === false);
    const honestConsensusIdx = groundTruths.findIndex((gt) => gt === true);
    expect(results[liarAloneIdx].score).toBeLessThan(results[honestConsensusIdx].score);
    expect(results[liarAloneIdx].score).toBeLessThan(0.5);
  });

  it("marks per-subject degradedReason correctly within a batch (no-verifier / all-abstained / not-degraded)", async () => {
    const registry = new VerifierRegistry();
    registry.registerAll([
      honestVerifier("batch.h1", { domain: "tool" }),
      honestVerifier("batch.h2", { domain: "tool" }),
    ]);

    const noVerifierSubject = subject({ domain: "memory", subjectId: "no-verifier-here" }); // nothing registered for memory
    const okSubject = subject({ domain: "tool", subjectId: "fine" });

    const results = await registry.verifyBatch([noVerifierSubject, okSubject]);
    expect(results[0].degradedReason).toBe("no-verifier");
    expect(results[0].degraded).toBe(true);
    expect(results[1].degraded).toBe(false);
  });

  it("a single-contributing-verifier subject inside a larger batch is NOT forced into single-verifier degradation", async () => {
    const registry = new VerifierRegistry();
    // v1 applies to everything; v2 only applies to a subset, so some items
    // in the batch have exactly one contributing verifier — but v1 has other
    // votes elsewhere in the batch to be judged against.
    const v1: UniversalVerifier = {
      id: "batch.v1",
      version: "1.0.0",
      domain: "tool",
      tier: "T3-agreement",
      prior: 0.9,
      appliesTo: () => true,
      verify: (s) => ({ verifierId: "batch.v1", version: "1.0.0", tier: "T3-agreement", passed: s.evidence.gt === true, confidence: 0.8, reasons: [], abstained: false }),
    };
    const v2: UniversalVerifier = {
      id: "batch.v2",
      version: "1.0.0",
      domain: "tool",
      tier: "T3-agreement",
      prior: 0.9,
      appliesTo: (s) => s.subjectId === "has-both",
      verify: (s) => ({ verifierId: "batch.v2", version: "1.0.0", tier: "T3-agreement", passed: s.evidence.gt === true, confidence: 0.8, reasons: [], abstained: false }),
    };
    registry.registerAll([v1, v2]);

    const subjects = [
      subject({ subjectId: "solo-1", evidence: { gt: true } }),
      subject({ subjectId: "has-both", evidence: { gt: true } }),
      subject({ subjectId: "solo-2", evidence: { gt: false } }),
      subject({ subjectId: "solo-3", evidence: { gt: true } }),
    ];
    const results = await registry.verifyBatch(subjects);
    const solo1 = results.find((r) => r.subjectKey === subjectKey(subjects[0]));
    expect(solo1?.degradedReason).toBeUndefined();
    expect(solo1?.degraded).toBe(false);
  });
});

// ===========================================================================
// Sanity: TIER_ORDER import is real and consistent
// ===========================================================================

describe("integration with the real styx tier order", () => {
  it("TIER_ORDER is imported from the real engine and used to determine weakest-tier semantics", () => {
    expect(TIER_ORDER).toEqual(["T0-execution", "T1-reference", "T2-genrm", "T3-agreement", "T4-consistency"]);
  });
});
