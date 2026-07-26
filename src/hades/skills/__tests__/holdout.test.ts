/* ------------------------------------------------------------------ *
 * holdout.test.ts
 *
 * REAL-VS-MOCK POLICY: `wilsonLowerBound` / `brierScore` are imported
 * straight from `../track-record` — this file never reimplements either,
 * it only ever asserts the module under test's numbers *equal* what those
 * real functions independently compute over the same raw data. The
 * integration test at the bottom builds a real SKILL.md through the real
 * `synthesizeSkill`, backed by a real ed25519 `CertificateAuthority` (same
 * fixture conventions as `synthesize.test.ts`) — no fabricated
 * certificates, no stubbed crypto. Every `HoldoutRunner` in this file is a
 * plain deterministic function of `(skillContent, case)` — no hidden
 * randomness, no wall-clock reads outside the injected `now`.
 * ------------------------------------------------------------------ */
import { describe, expect, it, vi } from "vitest";

import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
} from "../../styx/certificate";
import type { GoalTrajectory, TaskTrajectory, ToolEvent } from "../../research/recorder";
import { brierScore, wilsonLowerBound } from "../track-record";
import { parseSkillFile, skillTemplate } from "../skill-file";
import { synthesizeSkill, canonicalTrajectoryJson, type VerifiedTrajectory } from "../synthesize";
import {
  applyHoldoutDecision,
  runHoldoutValidation,
  type ApplyResult,
  type HoldoutCase,
  type HoldoutDecision,
  type HoldoutFs,
  type HoldoutRunner,
  type HoldoutRunResult,
} from "../holdout";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
}

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

const CANDIDATE_SKILL = skillTemplate("candidate-skill");
const INCUMBENT_SKILL = skillTemplate("incumbent-skill");

/** `n` cases with stable, distinct ids: c1..cn. */
function suiteOf(n: number): HoldoutCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    objective: `holdout objective ${i + 1}`,
  }));
}

const CERT_A = sha256Hex("holdout-test-cert-a");
const CERT_B = sha256Hex("holdout-test-cert-b");

/** Verified success: success:true, verified:true, real-shaped certSha256. */
function ok(predictedP = 0.9): HoldoutRunResult {
  return { caseId: "unused", success: true, verified: true, predictedP, certSha256: CERT_A };
}

/** Unverified success: success:true but verified:false (no cert). */
function okUnverified(predictedP = 0.9): HoldoutRunResult {
  return { caseId: "unused", success: true, verified: false, predictedP };
}

/** A genuine failure. */
function fail(predictedP = 0.2, detail = "task did not complete"): HoldoutRunResult {
  return { caseId: "unused", success: false, verified: false, predictedP, detail };
}

/**
 * Builds a deterministic runner from a fixed map of caseId -> outcome
 * (or a thrown Error). Any case id not present in `outcomes` throws loudly
 * (a test bug, not a code-under-test path), so every test is explicit about
 * exactly which cases it stages.
 */
function fixedRunner(outcomes: Record<string, HoldoutRunResult | Error>): HoldoutRunner {
  return async (_skillContent: string, c: HoldoutCase): Promise<HoldoutRunResult> => {
    const outcome = outcomes[c.id];
    if (outcome === undefined) {
      throw new Error(`test bug: fixedRunner has no staged outcome for case "${c.id}"`);
    }
    if (outcome instanceof Error) throw outcome;
    return { ...outcome, caseId: c.id };
  };
}

/** Runner where every case in `suite` gets the same outcome. */
function uniformRunner(result: HoldoutRunResult): HoldoutRunner {
  return async (_skillContent: string, c: HoldoutCase): Promise<HoldoutRunResult> => ({
    ...result,
    caseId: c.id,
  });
}

const FIXED_NOW = () => 1_700_000_000_000;

// ---------------------------------------------------------------------------
// In-memory HoldoutFs
// ---------------------------------------------------------------------------

function memFs(initial: Record<string, string> = {}): HoldoutFs & { store: Record<string, string> } {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    readFile(p: string): string | null {
      return Object.prototype.hasOwnProperty.call(store, p) ? store[p] : null;
    },
    writeFile(p: string, c: string): void {
      store[p] = c;
    },
    exists(p: string): boolean {
      return Object.prototype.hasOwnProperty.call(store, p);
    },
  };
}

// ===========================================================================
// Suite-level abstain paths (before any runner call)
// ===========================================================================

describe("runHoldoutValidation — suite-level abstain", () => {
  it("abstains on an empty suite (n=0 < minCases)", async () => {
    const runner = fixedRunner({});
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, [], runner, { now: FIXED_NOW });
    expect(decision.verdict).toBe("abstain");
    expect(decision.candidate.n).toBe(0);
    expect(decision.reasons.some((r) => r.includes("suite length=0"))).toBe(true);
  });

  it("abstains when suite.length < minCases even though every case would succeed", async () => {
    const suite = suiteOf(3);
    const runner = uniformRunner(ok());
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minCases: 5,
      now: FIXED_NOW,
    });
    expect(decision.verdict).toBe("abstain");
    expect(decision.reasons.some((r) => r.includes("suite length=3 < minCases=5"))).toBe(true);
  });

  it("rejects (abstains on) a suite with duplicate case ids, naming the duplicate id", async () => {
    const suite: HoldoutCase[] = [
      { id: "dup", objective: "a" },
      { id: "other", objective: "b" },
      { id: "dup", objective: "c" },
    ];
    const runner = fixedRunner({});
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, { now: FIXED_NOW });
    expect(decision.verdict).toBe("abstain");
    expect(decision.reasons.some((r) => r.includes('duplicate case id "dup"'))).toBe(true);
  });

  it("abstains when incumbentContent is provided but does not parse as SKILL.md", async () => {
    const suite = suiteOf(5);
    const runner = uniformRunner(ok());
    const badIncumbent = "this is not a SKILL.md file at all";
    // Confirm the fixture really is unparseable, so the test is honest about what it exercises.
    expect(() => parseSkillFile(badIncumbent)).toThrow();

    const decision = await runHoldoutValidation(CANDIDATE_SKILL, badIncumbent, suite, runner, { now: FIXED_NOW });
    expect(decision.verdict).toBe("abstain");
    expect(decision.reasons.some((r) => r.includes("incumbentContent does not parse"))).toBe(true);
    expect(decision.candidate.n).toBe(0); // never ran anything
  });

  it("abstains when candidateContent does not parse as SKILL.md", async () => {
    const suite = suiteOf(5);
    const runner = uniformRunner(ok());
    const decision = await runHoldoutValidation("not a skill file", null, suite, runner, { now: FIXED_NOW });
    expect(decision.verdict).toBe("abstain");
    expect(decision.reasons.some((r) => r.includes("candidateContent does not parse"))).toBe(true);
  });
});

// ===========================================================================
// Runner-throw handling
// ===========================================================================

describe("runHoldoutValidation — per-case throw handling", () => {
  it("catches a single throwing case, counts it as {success:false, verified:false} with the error message as detail, and still processes the rest", async () => {
    const suite = suiteOf(6);
    const runner = fixedRunner({
      c1: ok(),
      c2: new Error("network blew up mid-case"),
      c3: ok(),
      c4: ok(),
      c5: ok(),
      c6: ok(),
    });
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minCases: 5,
      minAbsoluteWilson: 0,
      now: FIXED_NOW,
    });
    // 5 usable cases (>= minCases=5), one thrown and excluded from n.
    expect(decision.candidate.n).toBe(5);
    expect(decision.candidate.successes).toBe(5);
    const thrown = decision.candidate.failures.find((f) => f.caseId === "c2");
    expect(thrown).toBeDefined();
    expect(thrown!.detail).toBe("network blew up mid-case");
  });

  it("reports the thrown-case count in reasons", async () => {
    const suite = suiteOf(7);
    const runner = fixedRunner({
      c1: ok(),
      c2: ok(),
      c3: new Error("boom-3"),
      c4: ok(),
      c5: new Error("boom-5"),
      c6: ok(),
      c7: ok(),
    });
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minCases: 5,
      minAbsoluteWilson: 0,
      now: FIXED_NOW,
    });
    expect(decision.candidate.n).toBe(5);
    const thrownReason = decision.reasons.find((r) => r.includes("threw on"));
    expect(thrownReason).toBeDefined();
    expect(thrownReason).toContain("threw on 2/7 case(s)");
    expect(thrownReason).toContain("c3");
    expect(thrownReason).toContain("c5");
  });

  it("abstains when the candidate runner throws on enough cases that usable n falls below minCases", async () => {
    const suite = suiteOf(6);
    const runner = fixedRunner({
      c1: ok(),
      c2: new Error("e2"),
      c3: new Error("e3"),
      c4: new Error("e4"),
      c5: new Error("e5"),
      c6: ok(),
    });
    // 2 usable, 4 thrown; minCases=5 -> abstain.
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minCases: 5,
      now: FIXED_NOW,
    });
    expect(decision.verdict).toBe("abstain");
    expect(decision.candidate.n).toBe(2);
    expect(decision.reasons.some((r) => r.includes("candidate usable n=2 < minCases=5"))).toBe(true);
  });

  it("abstains when the incumbent runner throws on enough cases that usable n falls below minCases, even though the candidate has enough", async () => {
    const suite = suiteOf(5);
    let call = 0;
    // Candidate arm: all succeed. Incumbent arm: mostly throws.
    // The runner is invoked once per (skillContent, case); we key behaviour
    // off which skillContent is passed so each arm's suite is fully paired
    // against the same case ids.
    const runner: HoldoutRunner = async (skillContent, c) => {
      call++;
      if (skillContent === CANDIDATE_SKILL) {
        return { caseId: c.id, success: true, verified: true, predictedP: 0.9, certSha256: CERT_A };
      }
      // incumbent arm
      if (c.id === "c1") {
        return { caseId: c.id, success: true, verified: true, predictedP: 0.9, certSha256: CERT_B };
      }
      throw new Error(`incumbent case ${c.id} exploded`);
    };
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, INCUMBENT_SKILL, suite, runner, {
      minCases: 5,
      now: FIXED_NOW,
    });
    expect(decision.verdict).toBe("abstain");
    expect(decision.candidate.n).toBe(5);
    expect(decision.incumbent).not.toBeNull();
    expect(decision.incumbent!.n).toBe(1);
    expect(decision.reasons.some((r) => r.includes("incumbent usable n=1 < minCases=5"))).toBe(true);
    expect(call).toBeGreaterThan(0);
  });
});

// ===========================================================================
// requireVerified semantics
// ===========================================================================

describe("runHoldoutValidation — requireVerified", () => {
  it("(c) requireVerified=true (default): 10/10 UNVERIFIED candidate successes rolls back against a 6/10-VERIFIED incumbent", async () => {
    const suite = suiteOf(10);
    const candidateOutcomes: Record<string, HoldoutRunResult> = {};
    const incumbentOutcomes: Record<string, HoldoutRunResult> = {};
    for (let i = 1; i <= 10; i++) {
      candidateOutcomes[`c${i}`] = okUnverified(0.95);
      incumbentOutcomes[`c${i}`] = i <= 6 ? ok(0.9) : fail(0.1);
    }
    const runner: HoldoutRunner = async (skillContent, c) => {
      const outcome = skillContent === CANDIDATE_SKILL ? candidateOutcomes[c.id] : incumbentOutcomes[c.id];
      return { ...outcome, caseId: c.id };
    };

    const decision = await runHoldoutValidation(CANDIDATE_SKILL, INCUMBENT_SKILL, suite, runner, {
      now: FIXED_NOW,
    });

    // Every candidate case "succeeded" per the runner, but none were
    // verified — none of them should count toward wilsonLower.
    expect(decision.candidate.successes).toBe(10);
    expect(decision.candidate.verifiedSuccesses).toBe(0);
    expect(decision.candidate.wilsonLower).toBe(wilsonLowerBound(0, 10));
    expect(decision.incumbent!.wilsonLower).toBe(wilsonLowerBound(6, 10));
    expect(decision.verdict).toBe("rollback");
  });

  it("requireVerified=false flips the same scenario to accept (raw successes now count)", async () => {
    const suite = suiteOf(10);
    const candidateOutcomes: Record<string, HoldoutRunResult> = {};
    const incumbentOutcomes: Record<string, HoldoutRunResult> = {};
    for (let i = 1; i <= 10; i++) {
      candidateOutcomes[`c${i}`] = okUnverified(0.95);
      incumbentOutcomes[`c${i}`] = i <= 6 ? ok(0.9) : fail(0.1);
    }
    const runner: HoldoutRunner = async (skillContent, c) => {
      const outcome = skillContent === CANDIDATE_SKILL ? candidateOutcomes[c.id] : incumbentOutcomes[c.id];
      return { ...outcome, caseId: c.id };
    };

    const decision = await runHoldoutValidation(CANDIDATE_SKILL, INCUMBENT_SKILL, suite, runner, {
      requireVerified: false,
      now: FIXED_NOW,
    });

    expect(decision.candidate.wilsonLower).toBe(wilsonLowerBound(10, 10));
    expect(decision.incumbent!.wilsonLower).toBe(wilsonLowerBound(6, 10));
    expect(decision.verdict).toBe("accept");
  });

  it("verifiedSuccesses is always the true verified count, independent of requireVerified", async () => {
    const suite = suiteOf(6);
    const outcomes: Record<string, HoldoutRunResult> = {
      c1: ok(),
      c2: ok(),
      c3: okUnverified(),
      c4: okUnverified(),
      c5: fail(),
      c6: fail(),
    };
    const runner = fixedRunner(outcomes);
    const withRequire = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      requireVerified: true,
      minAbsoluteWilson: 0,
      now: FIXED_NOW,
    });
    const withoutRequire = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      requireVerified: false,
      minAbsoluteWilson: 0,
      now: FIXED_NOW,
    });
    expect(withRequire.candidate.verifiedSuccesses).toBe(2);
    expect(withoutRequire.candidate.verifiedSuccesses).toBe(2);
    expect(withRequire.candidate.successes).toBe(4);
    expect(withoutRequire.candidate.successes).toBe(4);
  });
});

// ===========================================================================
// Boundary honesty: >= is accept, < is rollback
// ===========================================================================

describe("runHoldoutValidation — boundary honesty", () => {
  it("(d) candidate exactly at incumbent.wilsonLower + minLift accepts", async () => {
    const suite = suiteOf(8);
    // Identical, deterministic outcomes for both arms -> identical wilsonLower.
    const outcomes: Record<string, HoldoutRunResult> = {};
    for (let i = 1; i <= 8; i++) outcomes[`c${i}`] = i <= 5 ? ok(0.8) : fail(0.2);
    const runner = fixedRunner(outcomes);

    const decision = await runHoldoutValidation(CANDIDATE_SKILL, INCUMBENT_SKILL, suite, runner, {
      minLift: 0, // bar == incumbent.wilsonLower exactly
      now: FIXED_NOW,
    });

    expect(decision.candidate.wilsonLower).toBe(decision.incumbent!.wilsonLower);
    expect(decision.candidate.wilsonLower).toBe(decision.incumbent!.wilsonLower + 0);
    expect(decision.verdict).toBe("accept");
  });

  it("(d) an epsilon below the bar rolls back", async () => {
    const suite = suiteOf(8);
    const outcomes: Record<string, HoldoutRunResult> = {};
    for (let i = 1; i <= 8; i++) outcomes[`c${i}`] = i <= 5 ? ok(0.8) : fail(0.2);
    const runner = fixedRunner(outcomes);

    const decision = await runHoldoutValidation(CANDIDATE_SKILL, INCUMBENT_SKILL, suite, runner, {
      minLift: 1e-9, // candidate.wilsonLower (== incumbent's) is now strictly < bar
      now: FIXED_NOW,
    });

    const bar = decision.incumbent!.wilsonLower + 1e-9;
    expect(decision.candidate.wilsonLower).toBeLessThan(bar);
    expect(decision.verdict).toBe("rollback");
  });
});

// ===========================================================================
// No-incumbent path
// ===========================================================================

describe("runHoldoutValidation — no incumbent (minAbsoluteWilson floor)", () => {
  it("(e) accepts a strong candidate with no incumbent when wilsonLower >= minAbsoluteWilson", async () => {
    const suite = suiteOf(20);
    const outcomes: Record<string, HoldoutRunResult> = {};
    for (let i = 1; i <= 20; i++) outcomes[`c${i}`] = ok(0.95); // 20/20 verified successes
    const runner = fixedRunner(outcomes);

    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minAbsoluteWilson: 0.6,
      now: FIXED_NOW,
    });
    expect(decision.incumbent).toBeNull();
    expect(decision.candidate.wilsonLower).toBeGreaterThanOrEqual(0.6);
    expect(decision.verdict).toBe("accept");
  });

  it("(e) rolls back a weak candidate with no incumbent when wilsonLower < minAbsoluteWilson", async () => {
    const suite = suiteOf(20);
    const outcomes: Record<string, HoldoutRunResult> = {};
    for (let i = 1; i <= 20; i++) outcomes[`c${i}`] = i <= 10 ? ok(0.6) : fail(0.3);
    const runner = fixedRunner(outcomes);

    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minAbsoluteWilson: 0.6,
      now: FIXED_NOW,
    });
    expect(decision.incumbent).toBeNull();
    expect(decision.candidate.wilsonLower).toBeLessThan(0.6);
    expect(decision.verdict).toBe("rollback");
  });
});

// ===========================================================================
// predictedP out of [0,1]: counted as failure, never clamped
// ===========================================================================

describe("runHoldoutValidation — out-of-range predictedP", () => {
  it("counts predictedP > 1 as a failure with detail, and it does not count toward successes or wilsonLower", async () => {
    const suite = suiteOf(5);
    const outcomes: Record<string, HoldoutRunResult> = {
      c1: ok(0.9),
      c2: ok(0.9),
      c3: { caseId: "c3", success: true, verified: true, predictedP: 1.5, certSha256: CERT_A },
      c4: ok(0.9),
      c5: ok(0.9),
    };
    const runner = fixedRunner(outcomes);
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minAbsoluteWilson: 0,
      now: FIXED_NOW,
    });

    expect(decision.candidate.n).toBe(5); // still counted in n — it ran, it just failed
    expect(decision.candidate.successes).toBe(4); // c3 downgraded to a failure
    expect(decision.candidate.wilsonLower).toBe(wilsonLowerBound(4, 5));
    const badCase = decision.candidate.failures.find((f) => f.caseId === "c3");
    expect(badCase).toBeDefined();
    expect(badCase!.detail).toContain("1.5");
    expect(badCase!.detail).toContain("out of [0,1]");
  });

  it("counts predictedP < 0 as a failure with detail too", async () => {
    const suite = suiteOf(5);
    const outcomes: Record<string, HoldoutRunResult> = {
      c1: ok(0.9),
      c2: ok(0.9),
      c3: ok(0.9),
      c4: ok(0.9),
      c5: { caseId: "c5", success: true, verified: true, predictedP: -0.2, certSha256: CERT_A },
    };
    const runner = fixedRunner(outcomes);
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minAbsoluteWilson: 0,
      now: FIXED_NOW,
    });
    expect(decision.candidate.n).toBe(5);
    expect(decision.candidate.successes).toBe(4);
    const badCase = decision.candidate.failures.find((f) => f.caseId === "c5");
    expect(badCase!.detail).toContain("-0.2");
  });
});

// ===========================================================================
// No fabrication: aggregates match direct recomputation via the real engines
// ===========================================================================

describe("runHoldoutValidation — arm stats are honest aggregates", () => {
  it("wilsonLower/brier for the candidate arm exactly match wilsonLowerBound/brierScore over the raw runner outputs", async () => {
    const suite = suiteOf(9);
    const outcomes: Record<string, HoldoutRunResult> = {
      c1: ok(0.9),
      c2: ok(0.8),
      c3: fail(0.3),
      c4: ok(0.7),
      c5: fail(0.4),
      c6: ok(0.95),
      c7: fail(0.2),
      c8: ok(0.6),
      c9: ok(0.85),
    };
    const runner = fixedRunner(outcomes);
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minAbsoluteWilson: 0,
      now: FIXED_NOW,
    });

    const raw = Object.values(outcomes).map((o) => ({ predictedP: o.predictedP, success: o.success }));
    const verifiedSuccessCount = Object.values(outcomes).filter(
      (o) => o.success && o.verified && typeof o.certSha256 === "string",
    ).length;

    expect(decision.candidate.brier).toBe(brierScore(raw));
    expect(decision.candidate.wilsonLower).toBe(wilsonLowerBound(verifiedSuccessCount, 9));
    expect(decision.candidate.successes).toBe(6);
    expect(decision.candidate.verifiedSuccesses).toBe(verifiedSuccessCount);
  });

  it("failures[] contains exactly the genuinely-failed cases with their runner-supplied detail", async () => {
    const suite = suiteOf(4);
    const outcomes: Record<string, HoldoutRunResult> = {
      c1: ok(),
      c2: fail(0.3, "assertion mismatch in step 2"),
      c3: ok(),
      c4: fail(0.1, "timed out"),
    };
    const runner = fixedRunner(outcomes);
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minCases: 4,
      minAbsoluteWilson: 0,
      now: FIXED_NOW,
    });
    expect(decision.candidate.failures).toEqual([
      { caseId: "c2", detail: "assertion mismatch in step 2" },
      { caseId: "c4", detail: "timed out" },
    ]);
  });
});

// ===========================================================================
// Reasons interpolate real numbers, fixed 4-decimal
// ===========================================================================

describe("runHoldoutValidation — reasons format numbers as fixed 4-decimal", () => {
  it("the accept/rollback reason string contains fmt()'d wilsonLower values matching the engines' convention", async () => {
    const suite = suiteOf(10);
    const outcomes: Record<string, HoldoutRunResult> = {};
    for (let i = 1; i <= 10; i++) outcomes[`c${i}`] = i <= 7 ? ok(0.8) : fail(0.2);
    const runner = fixedRunner(outcomes);
    const decision = await runHoldoutValidation(CANDIDATE_SKILL, null, suite, runner, {
      minAbsoluteWilson: 0.6,
      now: FIXED_NOW,
    });
    const expected = fmt(decision.candidate.wilsonLower);
    expect(expected).toMatch(/^-?\d+\.\d{4}$/);
    expect(decision.reasons.join(" ")).toContain(expected);
  });
});

// ===========================================================================
// applyHoldoutDecision
// ===========================================================================

describe("applyHoldoutDecision", () => {
  const baseDecision: Omit<HoldoutDecision, "verdict"> = {
    candidate: { n: 5, successes: 5, verifiedSuccesses: 5, wilsonLower: 0.7, brier: 0.05, failures: [] },
    incumbent: { n: 5, successes: 3, verifiedSuccesses: 3, wilsonLower: 0.4, brier: 0.2, failures: [] },
    minCases: 5,
    minLift: 0.02,
    minAbsoluteWilson: 0.6,
    reasons: ["synthetic test decision"],
    decidedAt: 1_700_000_000_000,
  };

  it("accept writes candidateContent verbatim to skillPath", () => {
    const fs = memFs();
    const decision: HoldoutDecision = { ...baseDecision, verdict: "accept" };
    const result = applyHoldoutDecision(decision, {
      skillPath: "/skills/foo/SKILL.md",
      candidateContent: CANDIDATE_SKILL,
      incumbentContent: INCUMBENT_SKILL,
      fs,
    });
    expect(result.applied).toBe("candidate");
    expect(fs.store["/skills/foo/SKILL.md"]).toBe(CANDIDATE_SKILL);
  });

  it("rollback (with an incumbent) restores incumbentContent verbatim, not a re-serialized copy", () => {
    const fs = memFs({ "/skills/foo/SKILL.md": "some stale on-disk content, ignored" });
    const decision: HoldoutDecision = { ...baseDecision, verdict: "rollback" };
    const result = applyHoldoutDecision(decision, {
      skillPath: "/skills/foo/SKILL.md",
      candidateContent: CANDIDATE_SKILL,
      incumbentContent: INCUMBENT_SKILL,
      fs,
    });
    expect(result.applied).toBe("incumbent");
    expect(fs.store["/skills/foo/SKILL.md"]).toBe(INCUMBENT_SKILL);
  });

  it("rollback with a null incumbent refuses to write anything and says why", () => {
    const fs = memFs({ "/skills/foo/SKILL.md": "original content stays untouched" });
    const writeSpy = vi.spyOn(fs, "writeFile");
    const decision: HoldoutDecision = { ...baseDecision, incumbent: null, verdict: "rollback" };
    const result = applyHoldoutDecision(decision, {
      skillPath: "/skills/foo/SKILL.md",
      candidateContent: CANDIDATE_SKILL,
      incumbentContent: null,
      fs,
    });
    expect(result.applied).toBe("none");
    expect(result.reasons.some((r) => r.includes("nothing to roll back to"))).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(fs.store["/skills/foo/SKILL.md"]).toBe("original content stays untouched");
  });

  it("abstain never writes anything", () => {
    const fs = memFs({ "/skills/foo/SKILL.md": "untouched" });
    const writeSpy = vi.spyOn(fs, "writeFile");
    const decision: HoldoutDecision = { ...baseDecision, verdict: "abstain" };
    const result = applyHoldoutDecision(decision, {
      skillPath: "/skills/foo/SKILL.md",
      candidateContent: CANDIDATE_SKILL,
      incumbentContent: INCUMBENT_SKILL,
      fs,
    });
    expect(result.applied).toBe("none");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(fs.store["/skills/foo/SKILL.md"]).toBe("untouched");
  });

  it("applied result's path always matches the requested skillPath, across all three verdicts", () => {
    const fs = memFs();
    for (const verdict of ["accept", "rollback", "abstain"] as const) {
      const decision: HoldoutDecision = { ...baseDecision, verdict };
      const result: ApplyResult = applyHoldoutDecision(decision, {
        skillPath: "/some/skill/path/SKILL.md",
        candidateContent: CANDIDATE_SKILL,
        incumbentContent: INCUMBENT_SKILL,
        fs,
      });
      expect(result.path).toBe("/some/skill/path/SKILL.md");
    }
  });
});

// ===========================================================================
// Determinism
// ===========================================================================

describe("runHoldoutValidation — determinism", () => {
  it("the same injected deterministic runner over the same inputs yields deeply-equal decisions, including reasons ordering", async () => {
    const suite = suiteOf(12);
    const outcomes: Record<string, HoldoutRunResult> = {};
    for (let i = 1; i <= 12; i++) {
      outcomes[`c${i}`] = i % 3 === 0 ? fail(0.25, `case ${i} failed deterministically`) : ok(0.85);
    }
    const runner = fixedRunner(outcomes);
    const opts = { minCases: 5, minLift: 0.02, minAbsoluteWilson: 0.6, now: FIXED_NOW } as const;

    const d1 = await runHoldoutValidation(CANDIDATE_SKILL, INCUMBENT_SKILL, suite, fixedRunner(outcomes), opts);
    const d2 = await runHoldoutValidation(CANDIDATE_SKILL, INCUMBENT_SKILL, suite, fixedRunner(outcomes), opts);

    expect(d1).toEqual(d2);
    expect(d1.reasons).toEqual(d2.reasons);
    void runner; // constructed identically each call; unused directly, kept for clarity of intent
  });
});

// ===========================================================================
// Integration: a real synthesized skill, run through the real gate
// ===========================================================================

describe("integration — real synthesizeSkill through runHoldoutValidation", () => {
  const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(41)));

  function tool(overrides: Partial<ToolEvent> = {}): ToolEvent {
    return { tool: "run_tests", ok: true, summary: "Ran the test suite.", at: 1_000, ...overrides };
  }

  function task(overrides: Partial<TaskTrajectory> = {}): TaskTrajectory {
    return {
      taskId: "task-1",
      description: "Validate the build",
      capability: "ci",
      tools: [tool(), tool({ tool: "lint", summary: "Ran the linter.", at: 1_100 })],
      success: true,
      startedAt: 900,
      endedAt: 1_200,
      ...overrides,
    };
  }

  function goalTrajectory(overrides: Partial<GoalTrajectory> = {}): GoalTrajectory {
    return {
      goalId: "goal-holdout-1",
      objective: "Keep CI green before merging",
      model: "test-model",
      tasks: [task()],
      success: true,
      startedAt: 800,
      endedAt: 1_300,
      ...overrides,
    };
  }

  function payloadFor(trajectory: GoalTrajectory, overrides: Partial<CertificatePayload> = {}): CertificatePayload {
    return {
      outputSha256: sha256Hex("delivered ci output"),
      taskId: trajectory.tasks[0]?.taskId ?? "task-1",
      verifierTier: "T2-genrm",
      ensembleScore: 0.95,
      pCorrect: 0.99,
      epsilon: 0.02,
      traceSha256: sha256Hex(canonicalTrajectoryJson(trajectory)),
      verifierVersions: ["exec-oracle@1.0.0"],
      issuedAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  async function verifiedFixture(
    trajectoryOverrides: Partial<GoalTrajectory> = {},
    payloadOverrides: Partial<CertificatePayload> = {},
  ): Promise<VerifiedTrajectory> {
    const trajectory = goalTrajectory(trajectoryOverrides);
    const payload = payloadFor(trajectory, payloadOverrides);
    const certificate = await ca.issue(payload);
    return { trajectory, certificate };
  }

  it("produces accept-then-rollback across two suites for a real synthesized candidate skill", async () => {
    const vt = await verifiedFixture();
    const synthesis = await synthesizeSkill([vt], { now: 1_700_000_000_000 });
    expect(synthesis.ok).toBe(true);
    const candidateContent = synthesis.content!;
    // The real synthesizer's own output must itself be parseable SKILL.md —
    // otherwise this test would be exercising a fake fixture, not the real gate.
    expect(() => parseSkillFile(candidateContent)).not.toThrow();

    const incumbentContent = skillTemplate("ci-guard-incumbent");

    const suiteStrong = suiteOf(10);
    const strongRunner: HoldoutRunner = async (skillContent, c) => {
      if (skillContent === candidateContent) {
        return { caseId: c.id, success: true, verified: true, predictedP: 0.92, certSha256: sha256Hex(c.id + "cand") };
      }
      // incumbent does worse across the same paired suite
      const idx = Number(c.id.slice(1));
      const succeeds = idx <= 4;
      return succeeds
        ? { caseId: c.id, success: true, verified: true, predictedP: 0.6, certSha256: sha256Hex(c.id + "inc") }
        : { caseId: c.id, success: false, verified: false, predictedP: 0.3, detail: "incumbent regressed on this case" };
    };

    const firstDecision = await runHoldoutValidation(candidateContent, incumbentContent, suiteStrong, strongRunner, {
      now: FIXED_NOW,
    });
    expect(firstDecision.verdict).toBe("accept");

    const fs = memFs();
    const firstApply = applyHoldoutDecision(firstDecision, {
      skillPath: "/skills/ci-guard/SKILL.md",
      candidateContent,
      incumbentContent,
      fs,
    });
    expect(firstApply.applied).toBe("candidate");
    expect(fs.store["/skills/ci-guard/SKILL.md"]).toBe(candidateContent);

    // Second suite: the same candidate now regresses relative to the
    // (now-installed) incumbent — a real "the update made things worse" run.
    const suiteWeak = suiteOf(10);
    const weakRunner: HoldoutRunner = async (skillContent, c) => {
      if (skillContent === candidateContent) {
        const idx = Number(c.id.slice(1));
        const succeeds = idx <= 3;
        return succeeds
          ? { caseId: c.id, success: true, verified: true, predictedP: 0.5, certSha256: sha256Hex(c.id + "cand2") }
          : { caseId: c.id, success: false, verified: false, predictedP: 0.4, detail: "candidate regressed on this case" };
      }
      return { caseId: c.id, success: true, verified: true, predictedP: 0.85, certSha256: sha256Hex(c.id + "inc2") };
    };

    const secondDecision = await runHoldoutValidation(candidateContent, incumbentContent, suiteWeak, weakRunner, {
      now: FIXED_NOW,
    });
    expect(secondDecision.verdict).toBe("rollback");

    const secondApply = applyHoldoutDecision(secondDecision, {
      skillPath: "/skills/ci-guard/SKILL.md",
      candidateContent,
      incumbentContent,
      fs,
    });
    expect(secondApply.applied).toBe("incumbent");
    expect(fs.store["/skills/ci-guard/SKILL.md"]).toBe(incumbentContent);
  });
});
