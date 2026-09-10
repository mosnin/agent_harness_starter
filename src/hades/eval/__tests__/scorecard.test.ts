import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  EVAL_SCORECARD_VERSION,
  EVAL_SCORECARD_GENESIS,
  aggregateOutcomes,
  suiteFingerprint,
  canonicalizeScorecard,
  scorecardHash,
  sealScorecard,
  verifyScorecard,
  formatScorecard,
  type EvalScorecard,
  type EvalTaskOutcome,
  type ScorecardRevision,
  type RiskLane,
} from "../scorecard";
import type { EvalTask } from "../../bench/vtph";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function makeRevision(overrides: Partial<ScorecardRevision> = {}): ScorecardRevision {
  return {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    dirty: false,
    workTreeHash: "b".repeat(64),
    source: "git",
    committedAtMs: 1_700_000_000_000,
    branch: "claude/hermes-swarm-framework-vbhrot",
    ...overrides,
  };
}

function fakeTasks(ids: string[], category = "arithmetic"): EvalTask[] {
  return ids.map((id) => ({ id, prompt: `prompt-${id}`, category, decomposable: false, grade: () => true }));
}

function makeOutcome(overrides: Partial<EvalTaskOutcome> = {}): EvalTaskOutcome {
  return {
    taskId: "t1",
    category: "arithmetic",
    kind: "verified-correct",
    claimedVerified: true,
    graded: true,
    usd: 0.01,
    tokensIn: 10,
    tokensOut: 10,
    wallMs: 5,
    provenanceCount: 1,
    ...overrides,
  };
}

function unmeasuredRisk(): RiskLane {
  return {
    measured: false,
    unmeasuredReason: "test fixture: risk lane intentionally unmeasured",
    epsilon: Number.NaN,
    attempts: 0,
    accepted: 0,
    coverage: Number.NaN,
    silentWrong: 0,
    silentWrongRate: Number.NaN,
    withinBound: false,
    certificatesIssued: 0,
    certificatesVerified: 0,
    certificateFailures: 0,
  };
}

/** Build a self-consistent, sealed scorecard from a hand-controlled set of
 *  outcomes -- exercises scorecard.ts in complete isolation from measure.ts. */
function buildScorecard(
  outcomeList: EvalTaskOutcome[],
  wallClockMs: number,
  overrides: Partial<Omit<EvalScorecard, "contentHash">> = {},
): EvalScorecard {
  const { throughput, perCategory } = aggregateOutcomes(outcomeList, wallClockMs);
  const tasks = fakeTasks(outcomeList.map((o) => o.taskId));
  const draft: Omit<EvalScorecard, "contentHash"> = {
    version: EVAL_SCORECARD_VERSION,
    scorecardId: "test-scorecard-id",
    label: "unit-test",
    mode: "scripted",
    revision: makeRevision(),
    suiteHash: suiteFingerprint(tasks),
    suiteTaskIds: tasks.map((t) => t.id),
    createdAtMs: 1000,
    durationMs: 250,
    throughput,
    risk: unmeasuredRisk(),
    perCategory,
    outcomes: outcomeList,
    provenance: {
      engine: ["test-engine"],
      graderSource: "test-grader",
      runnerLabel: "test-runner",
      realComponents: ["test-component"],
    },
    ...overrides,
  };
  return sealScorecard(draft);
}

describe("EVAL_SCORECARD_GENESIS / EVAL_SCORECARD_VERSION", () => {
  it("genesis is sha256('hades.eval.scorecard.v1')", () => {
    expect(EVAL_SCORECARD_GENESIS).toBe(sha256Hex("hades.eval.scorecard.v1"));
    expect(EVAL_SCORECARD_GENESIS).toMatch(/^[0-9a-f]{64}$/);
  });

  it("version is 1", () => {
    expect(EVAL_SCORECARD_VERSION).toBe(1);
  });
});

describe("suiteFingerprint", () => {
  it("is deterministic for the same task list", () => {
    const tasks = fakeTasks(["a", "b", "c"]);
    expect(suiteFingerprint(tasks)).toBe(suiteFingerprint(tasks));
  });

  it("is independent of task order (sorted internally)", () => {
    const forward = fakeTasks(["a", "b", "c"]);
    const shuffled = fakeTasks(["c", "a", "b"]);
    expect(suiteFingerprint(forward)).toBe(suiteFingerprint(shuffled));
  });

  it("differs when the task id set differs", () => {
    const a = fakeTasks(["a", "b"]);
    const b = fakeTasks(["a", "c"]);
    expect(suiteFingerprint(a)).not.toBe(suiteFingerprint(b));
  });

  it("returns a hex sha256", () => {
    expect(suiteFingerprint(fakeTasks(["x"]))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("aggregateOutcomes", () => {
  it("classifies every TaskOutcomeKind into the right buckets and computes vtph by hand", () => {
    const outcomes: EvalTaskOutcome[] = [
      makeOutcome({ taskId: "t1", category: "arithmetic", kind: "verified-correct", usd: 0.02, tokensIn: 5, tokensOut: 5 }),
      makeOutcome({ taskId: "t2", category: "arithmetic", kind: "verified-correct", usd: 0.02, tokensIn: 5, tokensOut: 5 }),
      makeOutcome({ taskId: "t3", category: "extraction", kind: "silent-wrong", claimedVerified: true, usd: 0.01 }),
      makeOutcome({ taskId: "t4", category: "extraction", kind: "declined-correct", claimedVerified: false, usd: 0.01 }),
      makeOutcome({ taskId: "t5", category: "reasoning", kind: "declined-wrong", claimedVerified: false, usd: 0.01 }),
      makeOutcome({ taskId: "t6", category: "reasoning", kind: "runner-error", claimedVerified: false, usd: 0, tokensIn: 0, tokensOut: 0, provenanceCount: 0 }),
    ];
    const wallClockMs = 3_600_000; // exactly 1 hour
    const { throughput, perCategory } = aggregateOutcomes(outcomes, wallClockMs);

    expect(throughput.tasks).toBe(6);
    expect(throughput.verifiedCorrect).toBe(2);
    expect(throughput.silentWrong).toBe(1);
    expect(throughput.correctButUnclaimed).toBe(1);
    expect(throughput.runnerErrors).toBe(1);
    // declined = declined-correct + declined-wrong + runner-error
    expect(throughput.declined).toBe(3);
    expect(throughput.totalUsd).toBeCloseTo(0.02 + 0.02 + 0.01 + 0.01 + 0.01 + 0, 10);
    // t1,t2: 5+5 each; t3,t4,t5: default (10+10) each; t6: 0
    expect(throughput.totalTokens).toBe((5 + 5) + (5 + 5) + (10 + 10) + (10 + 10) + (10 + 10) + 0);
    // 1 hour wall clock -> vtph === verifiedCorrect count
    expect(throughput.vtph).toBeCloseTo(2, 10);
    expect(throughput.vtphPerDollar).toBeCloseTo(throughput.vtph / throughput.totalUsd, 10);

    expect(perCategory.arithmetic.tasks).toBe(2);
    expect(perCategory.arithmetic.verifiedCorrect).toBe(2);
    expect(perCategory.extraction.tasks).toBe(2);
    expect(perCategory.extraction.silentWrong).toBe(1);
    expect(perCategory.extraction.declined).toBe(1);
    expect(perCategory.reasoning.declined).toBe(2);
  });

  it("vtph is 0 (not NaN/Infinity) when wallClockMs is 0", () => {
    const outcomes = [makeOutcome({ kind: "verified-correct" })];
    const { throughput } = aggregateOutcomes(outcomes, 0);
    expect(throughput.vtph).toBe(0);
  });

  it("vtphPerDollar is a genuine Infinity at verified work with exactly zero spend", () => {
    const outcomes = [makeOutcome({ kind: "verified-correct", usd: 0 })];
    const { throughput } = aggregateOutcomes(outcomes, 3_600_000);
    expect(throughput.vtph).toBeGreaterThan(0);
    expect(throughput.vtphPerDollar).toBe(Number.POSITIVE_INFINITY);
  });

  it("vtphPerDollar is NaN (not fabricated 0) at zero verified work AND zero spend", () => {
    const outcomes = [makeOutcome({ kind: "declined-wrong", claimedVerified: false, usd: 0 })];
    const { throughput } = aggregateOutcomes(outcomes, 3_600_000);
    expect(throughput.vtph).toBe(0);
    expect(Number.isNaN(throughput.vtphPerDollar)).toBe(true);
  });

  it("handles an empty outcome list without crashing", () => {
    const { throughput, perCategory } = aggregateOutcomes([], 1000);
    expect(throughput.tasks).toBe(0);
    expect(throughput.verifiedCorrect).toBe(0);
    expect(Object.keys(perCategory)).toHaveLength(0);
  });
});

describe("sealScorecard / scorecardHash / canonicalizeScorecard", () => {
  it("seals a scorecard with a hex sha256 contentHash that verifyScorecard accepts", () => {
    const sealed = buildScorecard([makeOutcome()], 3_600_000);
    expect(sealed.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyScorecard(sealed)).toEqual({ ok: true, reason: null });
  });

  it("contentHash equals scorecardHash of the sealed record", () => {
    const sealed = buildScorecard([makeOutcome()], 3_600_000);
    expect(scorecardHash(sealed)).toBe(sealed.contentHash);
  });

  it("canonicalization is independent of outcome ARRAY order", () => {
    const a = makeOutcome({ taskId: "a1", category: "arithmetic" });
    const b = makeOutcome({ taskId: "b2", category: "extraction", kind: "silent-wrong" });
    // Fix suiteTaskIds/suiteHash identically across both builds so only the
    // OUTCOMES array order differs -- suiteTaskIds intentionally preserves
    // caller-given order and is not itself resorted by canonicalization.
    const fixedSuiteTaskIds = ["a1", "b2"];
    const fixedSuiteHash = suiteFingerprint(fakeTasks(fixedSuiteTaskIds));
    const forward = buildScorecard([a, b], 3_600_000, {
      suiteTaskIds: fixedSuiteTaskIds,
      suiteHash: fixedSuiteHash,
    });
    const backward = buildScorecard([b, a], 3_600_000, {
      suiteTaskIds: fixedSuiteTaskIds,
      suiteHash: fixedSuiteHash,
    });
    expect(canonicalizeScorecard(forward)).toBe(canonicalizeScorecard(backward));
    expect(forward.contentHash).toBe(backward.contentHash);
  });

  it("canonicalization is independent of top-level object-key insertion order", () => {
    const sealed = buildScorecard([makeOutcome()], 3_600_000);
    // Re-spread with a different key insertion order (JS object key order is
    // insertion order for string keys, so this genuinely exercises re-ordering).
    const reordered: EvalScorecard = {
      contentHash: sealed.contentHash,
      provenance: sealed.provenance,
      outcomes: sealed.outcomes,
      perCategory: sealed.perCategory,
      risk: sealed.risk,
      throughput: sealed.throughput,
      durationMs: sealed.durationMs,
      createdAtMs: sealed.createdAtMs,
      suiteTaskIds: sealed.suiteTaskIds,
      suiteHash: sealed.suiteHash,
      revision: sealed.revision,
      mode: sealed.mode,
      label: sealed.label,
      scorecardId: sealed.scorecardId,
      version: sealed.version,
    };
    expect(canonicalizeScorecard(reordered)).toBe(canonicalizeScorecard(sealed));
  });

  it("two independent seals of the SAME logical content produce an IDENTICAL contentHash", () => {
    const outcomes1 = [makeOutcome({ taskId: "x" }), makeOutcome({ taskId: "y", kind: "silent-wrong" })];
    const outcomes2 = [makeOutcome({ taskId: "x" }), makeOutcome({ taskId: "y", kind: "silent-wrong" })];
    const s1 = buildScorecard(outcomes1, 3_600_000);
    const s2 = buildScorecard(outcomes2, 3_600_000);
    expect(s1.contentHash).toBe(s2.contentHash);
  });

  it("Infinity vtphPerDollar serializes to an explicit sentinel that round-trips through the canonical form", () => {
    const sealed = buildScorecard([makeOutcome({ kind: "verified-correct", usd: 0 })], 3_600_000);
    expect(sealed.throughput.vtphPerDollar).toBe(Number.POSITIVE_INFINITY);
    const canonical = canonicalizeScorecard(sealed);
    expect(canonical).toContain('"Infinity"');
    expect(canonical).not.toMatch(/"vtphPerDollar":null/);
    expect(canonical).not.toMatch(/"vtphPerDollar":0(?![.\d])/);
    // The sentinel round-trips back to the exact original value.
    expect(Number("Infinity")).toBe(Number.POSITIVE_INFINITY);
    expect(verifyScorecard(sealed).ok).toBe(true);
  });

  it("NaN risk fields serialize to an explicit sentinel, never null/0", () => {
    const sealed = buildScorecard([makeOutcome()], 3_600_000, { risk: unmeasuredRisk() });
    const canonical = canonicalizeScorecard(sealed);
    expect(canonical).toContain('"NaN"');
    expect(verifyScorecard(sealed).ok).toBe(true);
  });
});

describe("verifyScorecard -- adversarial detection", () => {
  it("detects an unsupported version", () => {
    const sealed = buildScorecard([makeOutcome()], 3_600_000);
    const tampered: EvalScorecard = { ...sealed, version: 999 };
    const result = verifyScorecard(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unsupported-version");
  });

  it("detects a suiteHash that does not match suiteTaskIds", () => {
    const sealed = buildScorecard([makeOutcome()], 3_600_000);
    const tampered: EvalScorecard = { ...sealed, suiteHash: "0".repeat(64) };
    const result = verifyScorecard(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("suite-hash-mismatch");
  });

  it("detects a mutated outcomes array (throughput no longer agrees with aggregateOutcomes)", () => {
    const sealed = buildScorecard([makeOutcome({ kind: "verified-correct" })], 3_600_000);
    const mutatedOutcomes = [...sealed.outcomes, makeOutcome({ taskId: "extra", kind: "silent-wrong" })];
    const tampered: EvalScorecard = { ...sealed, outcomes: mutatedOutcomes };
    const result = verifyScorecard(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("throughput-outcome-mismatch");
  });

  it("detects a hand-edited throughput total that disagrees with aggregateOutcomes", () => {
    const sealed = buildScorecard([makeOutcome({ kind: "verified-correct" })], 3_600_000);
    const tampered: EvalScorecard = {
      ...sealed,
      throughput: { ...sealed.throughput, verifiedCorrect: sealed.throughput.verifiedCorrect + 5 },
    };
    const result = verifyScorecard(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("throughput-outcome-mismatch");
  });

  it("detects a wrong contentHash even when everything else is self-consistent", () => {
    const sealed = buildScorecard([makeOutcome()], 3_600_000);
    const tampered: EvalScorecard = { ...sealed, contentHash: "f".repeat(64) };
    const result = verifyScorecard(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content-hash-mismatch");
  });

  it("passes for an untouched sealed scorecard", () => {
    const sealed = buildScorecard([makeOutcome(), makeOutcome({ taskId: "t2", kind: "silent-wrong" })], 3_600_000);
    expect(verifyScorecard(sealed)).toEqual({ ok: true, reason: null });
  });
});

describe("formatScorecard", () => {
  it("renders plain-text lines including mode, contentHash, and per-category stats", () => {
    const sealed = buildScorecard(
      [makeOutcome({ taskId: "a", category: "arithmetic" }), makeOutcome({ taskId: "b", category: "extraction", kind: "silent-wrong" })],
      3_600_000,
    );
    const lines = formatScorecard(sealed);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.some((l) => l.includes("mode") && l.includes("scripted"))).toBe(true);
    expect(lines.some((l) => l.includes(sealed.contentHash))).toBe(true);
    expect(lines.some((l) => l.includes("arithmetic"))).toBe(true);
    expect(lines.some((l) => l.includes("extraction"))).toBe(true);
  });

  it("renders an UNMEASURED risk lane honestly, without a fabricated PASS", () => {
    const sealed = buildScorecard([makeOutcome()], 3_600_000, { risk: unmeasuredRisk() });
    const lines = formatScorecard(sealed);
    expect(lines.some((l) => l.includes("UNMEASURED"))).toBe(true);
  });

  it("does not throw for a degenerate empty-outcomes scorecard", () => {
    const sealed = buildScorecard([], 0);
    expect(() => formatScorecard(sealed)).not.toThrow();
    expect(verifyScorecard(sealed).ok).toBe(true);
  });
});
