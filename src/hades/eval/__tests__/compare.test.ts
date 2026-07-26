import { describe, it, expect } from "vitest";

import {
  EVAL_COMPARE_VERSION,
  selectBaseline,
  compareScorecards,
  compareToBaseline,
  vtphSeries,
  detectChangepoint,
  formatScorecardDelta,
  formatTrend,
  type ScorecardDelta,
  type TrendPoint,
} from "../compare";
import {
  aggregateOutcomes,
  sealScorecard,
  suiteFingerprint,
  EVAL_SCORECARD_VERSION,
  type EvalScorecard,
  type EvalTaskOutcome,
  type ScorecardRevision,
  type RiskLane,
  type TaskOutcomeKind,
  type EvalMode,
} from "../scorecard";
import type { EvalHistoryEntry } from "../history";
import { runEvalMeasurement, scriptedEvalRunner } from "../measure";
import { scriptedSolvers } from "../../trust/risk-eval";
import type { AdmitFn, RiskEvalSubject } from "../../trust/risk-eval";
import { EVAL_TASKS } from "../../bench/eval-suite";
import type { EvalTask, AgentRunner } from "../../bench/vtph";
import { CertificateAuthority, generatePrivateKeyHex, sha256Hex } from "../../styx/certificate";

// ===========================================================================
// Shared test fixtures
// ===========================================================================

/** A deterministic clock: each call advances by a fixed increment, matching
 *  the pattern `measure.test.ts` already uses for reproducible V-TPH$. */
function makeClock(stepMs = 1): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

function makeRevision(overrides: Partial<ScorecardRevision> = {}): ScorecardRevision {
  return {
    sha: "c".repeat(40),
    shortSha: "cccccccccccc",
    dirty: false,
    workTreeHash: "d".repeat(64),
    source: "git",
    committedAtMs: 1_700_000_000_000,
    branch: "claude/hermes-swarm-framework-vbhrot",
    ...overrides,
  };
}

const faithful = scriptedSolvers().find((s) => s.label === "faithful")!;
const fabricating = scriptedSolvers().find((s) => s.label === "fabricating")!;
const lossy = scriptedSolvers().find((s) => s.label === "lossy")!;

/** Real, deterministic, per-task solver selection: fabricating for even task
 *  index, faithful for odd. Both branches invoke a REAL scripted solver's
 *  `answer()` against the real task -- this is a test-harness routing
 *  choice, never a fabricated result. */
function mixedRunner(tasks: readonly EvalTask[]): AgentRunner {
  const indexOf = new Map(tasks.map((t, i) => [t.id, i]));
  const faithfulRunner = scriptedEvalRunner(faithful);
  const fabricatingRunner = scriptedEvalRunner(fabricating);
  return async (task) => {
    const i = indexOf.get(task.id) ?? 0;
    return i % 2 === 0 ? fabricatingRunner(task) : faithfulRunner(task);
  };
}

// ---------------------------------------------------------------------------
// Synthetic (clearly labelled) EvalScorecard fixtures for selectBaseline /
// McNemar-property unit tests. These are NOT engine-driven regressions --
// they exist purely to give the pure selection/statistics math controlled,
// hand-checkable inputs. Every fixture is built via the REAL
// `aggregateOutcomes` + `sealScorecard` (never a hand-edited post-seal
// field), so every fixture is internally self-consistent and would pass
// `verifyScorecard`.
// ---------------------------------------------------------------------------

function fixtureOutcome(taskId: string, kind: TaskOutcomeKind, overrides: Partial<EvalTaskOutcome> = {}): EvalTaskOutcome {
  return {
    taskId,
    category: "arithmetic",
    kind,
    claimedVerified: kind === "verified-correct" || kind === "silent-wrong",
    graded: kind !== "runner-error",
    usd: 0.001,
    tokensIn: 10,
    tokensOut: 10,
    wallMs: 5,
    provenanceCount: 1,
    ...overrides,
  };
}

/** `n` outcomes, all `verified-correct`, distinct synthetic taskIds. Paired
 *  with a fixed 1-hour `wallClockMs`, this makes `vtph === n` exactly --
 *  convenient, hand-checkable round numbers for selection-logic tests. */
function allVerifiedOutcomes(n: number, prefix = "s"): EvalTaskOutcome[] {
  const out: EvalTaskOutcome[] = [];
  for (let i = 0; i < n; i++) out.push(fixtureOutcome(`${prefix}${i}`, "verified-correct"));
  return out;
}

/**
 * A FIXED-size (`total`) suite of outcomes where exactly the first `n` are
 * `verified-correct` and the rest are `declined-wrong`. Because `total`
 * (hence the taskId SET) stays constant across calls, every fixture built
 * from this helper with the same `total`/`prefix` shares one `suiteHash` --
 * essential for the rolling-median/best-of-window/specific-sha pool tests,
 * which must combine several REAL historical entries from a single suite.
 * `vtph === n` exactly, same round-number convenience as
 * {@link allVerifiedOutcomes}.
 */
function outcomesWithVerifiedCount(n: number, total: number, prefix = "t"): EvalTaskOutcome[] {
  const out: EvalTaskOutcome[] = [];
  for (let i = 0; i < total; i++) {
    out.push(fixtureOutcome(`${prefix}${i}`, i < n ? "verified-correct" : "declined-wrong"));
  }
  return out;
}

function fakeTask(id: string): EvalTask {
  return { id, prompt: "synthetic-fixture-prompt", category: "arithmetic", decomposable: false, grade: () => true };
}

let fixtureScorecardCounter = 0;

function makeFixtureScorecard(opts: {
  outcomes: EvalTaskOutcome[];
  wallClockMs?: number;
  revision?: Partial<ScorecardRevision>;
  mode?: EvalMode;
  createdAtMs?: number;
  riskMeasured?: boolean;
}): EvalScorecard {
  const wallClockMs = opts.wallClockMs ?? 3_600_000; // 1 hour -- vtph === verifiedCorrect count
  const { throughput, perCategory } = aggregateOutcomes(opts.outcomes, wallClockMs);
  const suiteTaskIds = opts.outcomes.map((o) => o.taskId);
  const suiteHash = suiteFingerprint(suiteTaskIds.map(fakeTask));
  const revision: ScorecardRevision = {
    sha: `fixture-sha-${fixtureScorecardCounter}`,
    shortSha: `fx${fixtureScorecardCounter}`,
    dirty: false,
    workTreeHash: "e".repeat(64),
    source: "content",
    committedAtMs: 1_700_000_000_000 + fixtureScorecardCounter,
    branch: "main",
    ...opts.revision,
  };
  const risk: RiskLane = opts.riskMeasured
    ? {
        measured: true,
        unmeasuredReason: null,
        epsilon: 0.05,
        attempts: opts.outcomes.length,
        accepted: opts.outcomes.length,
        coverage: 1,
        silentWrong: throughput.silentWrong,
        silentWrongRate: opts.outcomes.length > 0 ? throughput.silentWrong / opts.outcomes.length : 0,
        withinBound: true,
        certificatesIssued: 0,
        certificatesVerified: 0,
        certificateFailures: 0,
      }
    : {
        measured: false,
        unmeasuredReason: "fixture: risk lane not measured (no AdmitFn)",
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
  fixtureScorecardCounter += 1;
  const createdAtMs = opts.createdAtMs ?? fixtureScorecardCounter;
  const draft: Omit<EvalScorecard, "contentHash"> = {
    version: EVAL_SCORECARD_VERSION,
    scorecardId: sha256Hex(`compare-test-fixture:${suiteHash}:${wallClockMs}:${createdAtMs}:${fixtureScorecardCounter}`),
    label: "compare-test-fixture",
    mode: opts.mode ?? "scripted",
    revision,
    suiteHash,
    suiteTaskIds,
    createdAtMs,
    durationMs: wallClockMs,
    throughput,
    risk,
    perCategory,
    outcomes: opts.outcomes,
    provenance: {
      engine: ["compare.test.ts fixture -- synthetic outcomes for selectBaseline/McNemar unit tests"],
      graderSource: "synthetic fixture, not the real corpus",
      runnerLabel: "compare-test-fixture-runner",
      realComponents: ["aggregateOutcomes", "sealScorecard"],
    },
  };
  return sealScorecard(draft);
}

function makeHistoryEntry(seq: number, scorecard: EvalScorecard, overrides: Partial<EvalHistoryEntry> = {}): EvalHistoryEntry {
  return {
    seq,
    recordedAtMs: scorecard.createdAtMs,
    branch: scorecard.revision.branch,
    sha: scorecard.revision.sha,
    mode: scorecard.mode,
    suiteHash: scorecard.suiteHash,
    scorecard,
    note: null,
    prevHash: "p".repeat(64),
    hash: `h-${seq}`,
    ...overrides,
  };
}

// ===========================================================================
// selectBaseline
// ===========================================================================

describe("selectBaseline -- edge cases and pool auditability", () => {
  it("returns ok:false with NaN references on an empty history", () => {
    const sel = selectBaseline([], { strategy: "latest" });
    expect(sel.ok).toBe(false);
    expect(sel.entry).toBeNull();
    expect(sel.pool).toEqual([]);
    expect(sel.reason).toBe("empty-history");
    expect(Number.isNaN(sel.vtphReference)).toBe(true);
    expect(Number.isNaN(sel.verifiedCorrectReference)).toBe(true);
    expect(Number.isNaN(sel.silentWrongReference)).toBe(true);
    expect(Number.isNaN(sel.silentWrongRateReference)).toBe(true);
  });

  it("returns ok:false when branch filtering leaves nothing", () => {
    const sc = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3), revision: { branch: "main" } });
    const entries = [makeHistoryEntry(0, sc)];
    const sel = selectBaseline(entries, { strategy: "latest", branch: "some-other-branch" });
    expect(sel.ok).toBe(false);
    expect(sel.reason).toContain("branch=");
  });

  it("returns ok:false when excludeSha removes the only entry (candidate's own sha)", () => {
    const sc = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3), revision: { sha: "candidate-sha" } });
    const entries = [makeHistoryEntry(0, sc)];
    const sel = selectBaseline(entries, { strategy: "latest", excludeSha: "candidate-sha" });
    expect(sel.ok).toBe(false);
    expect(sel.reason).toContain("excludeSha");
  });

  it("excludeDirty drops dirty-worktree entries from the pool", () => {
    const clean = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(5, "c"), revision: { dirty: false, sha: "clean" } });
    const dirty = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(9, "d"), revision: { dirty: true, sha: "dirty" } });
    const entries = [makeHistoryEntry(0, clean), makeHistoryEntry(1, dirty)];
    const sel = selectBaseline(entries, { strategy: "latest", excludeDirty: true });
    expect(sel.ok).toBe(true);
    expect(sel.entry!.scorecard.revision.dirty).toBe(false);
    expect(sel.vtphReference).toBe(5);
  });

  it("ok:false when excludeDirty removes every remaining entry", () => {
    const dirty = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(2), revision: { dirty: true } });
    const entries = [makeHistoryEntry(0, dirty)];
    const sel = selectBaseline(entries, { strategy: "latest", excludeDirty: true });
    expect(sel.ok).toBe(false);
  });

  it("never averages across mixed suiteHashes: infers the LATEST suite and narrows the pool", () => {
    const suiteA1 = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(2, "a"), revision: { sha: "a1" } });
    const suiteB1 = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3, "b"), revision: { sha: "b1" } });
    const suiteA2 = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(2, "a"), revision: { sha: "a2" } });
    const suiteB2 = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3, "b"), revision: { sha: "b2" } });
    // interleaved seq order, latest (seq 3) belongs to suite B
    const entries = [
      makeHistoryEntry(0, suiteA1),
      makeHistoryEntry(1, suiteB1),
      makeHistoryEntry(2, suiteA2),
      makeHistoryEntry(3, suiteB2),
    ];
    const sel = selectBaseline(entries, { strategy: "latest" });
    expect(sel.ok).toBe(true);
    expect(sel.reason).toContain("inferred");
    expect(sel.pool).toHaveLength(2);
    expect(sel.pool.every((e) => e.suiteHash === suiteB2.suiteHash)).toBe(true);
    expect(sel.entry!.scorecard.revision.sha).toBe("b2");
  });

  it("ok:false when an explicit suiteHash matches nothing", () => {
    const sc = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(4) });
    const entries = [makeHistoryEntry(0, sc)];
    const sel = selectBaseline(entries, { strategy: "latest", suiteHash: "does-not-exist" });
    expect(sel.ok).toBe(false);
    expect(sel.reason).toContain("does-not-exist");
  });

  it("'latest' picks the highest-seq entry and its own throughput numbers", () => {
    const e1 = makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(10, 50), revision: { sha: "r1" } });
    const e2 = makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(20, 50), revision: { sha: "r2" } });
    const entries = [makeHistoryEntry(0, e1), makeHistoryEntry(1, e2)];
    const sel = selectBaseline(entries, { strategy: "latest" });
    expect(sel.ok).toBe(true);
    expect(sel.entry!.scorecard.revision.sha).toBe("r2");
    expect(sel.vtphReference).toBe(20);
    expect(sel.verifiedCorrectReference).toBe(20);
    expect(sel.silentWrongReference).toBe(0);
    expect(sel.silentWrongRateReference).toBe(0);
  });

  it("'specific-sha' finds the unique match", () => {
    const e1 = makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(7, 50), revision: { sha: "target" } });
    const e2 = makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(3, 50), revision: { sha: "other" } });
    const entries = [makeHistoryEntry(0, e1), makeHistoryEntry(1, e2)];
    const sel = selectBaseline(entries, { strategy: "specific-sha", sha: "target" });
    expect(sel.ok).toBe(true);
    expect(sel.entry!.sha).toBe("target");
    expect(sel.reason).toBeNull();
  });

  it("'specific-sha' with several recorded runs picks the LATEST and says so in reason", () => {
    const run1 = makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(5, 50), revision: { sha: "dup" }, createdAtMs: 1 });
    const run2 = makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(15, 50), revision: { sha: "dup" }, createdAtMs: 2 });
    const entries = [makeHistoryEntry(0, run1), makeHistoryEntry(1, run2)];
    const sel = selectBaseline(entries, { strategy: "specific-sha", sha: "dup" });
    expect(sel.ok).toBe(true);
    expect(sel.entry!.seq).toBe(1);
    expect(sel.vtphReference).toBe(15);
    expect(sel.reason).toMatch(/latest/i);
    expect(sel.reason).toContain("2 recorded runs");
  });

  it("'specific-sha' fails honestly when the sha was never recorded", () => {
    const sc = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3) });
    const entries = [makeHistoryEntry(0, sc)];
    const sel = selectBaseline(entries, { strategy: "specific-sha", sha: "never-seen" });
    expect(sel.ok).toBe(false);
    expect(sel.reason).toContain("never-seen");
  });

  it("'specific-sha' fails when no sha is given", () => {
    const sc = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3) });
    const entries = [makeHistoryEntry(0, sc)];
    const sel = selectBaseline(entries, { strategy: "specific-sha" });
    expect(sel.ok).toBe(false);
    expect(sel.reason).toContain("sha");
  });

  it("'rolling-median' odd window picks the true middle value by vtph", () => {
    const vals = [10, 20, 30];
    const entries = vals.map((v, i) => makeHistoryEntry(i, makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(v, 50), revision: { sha: `r${i}` } })));
    const sel = selectBaseline(entries, { strategy: "rolling-median", window: 3 });
    expect(sel.ok).toBe(true);
    expect(sel.vtphReference).toBe(20);
    expect(sel.pool).toHaveLength(3);
  });

  it("'rolling-median' even window uses the documented lower-median rule (not interpolated)", () => {
    // seq order deliberately NOT sorted by vtph, to prove the rule sorts by
    // value, not by recency.
    const order = [20, 10, 40, 30];
    const entries = order.map((v, i) => makeHistoryEntry(i, makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(v, 50), revision: { sha: `q${i}` } })));
    const sel = selectBaseline(entries, { strategy: "rolling-median", window: 4 });
    expect(sel.ok).toBe(true);
    // sorted ascending: [10,20,30,40], n=4 even -> lower median index (4/2-1=1) -> value 20
    expect(sel.vtphReference).toBe(20);
    expect(sel.reason).toMatch(/even-length window/);
  });

  it("'rolling-median' window larger than the pool clamps to the whole pool, with a note", () => {
    const vals = [5, 15];
    const entries = vals.map((v, i) => makeHistoryEntry(i, makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(v, 50), revision: { sha: `w${i}` } })));
    const sel = selectBaseline(entries, { strategy: "rolling-median", window: 100 });
    expect(sel.ok).toBe(true);
    expect(sel.pool).toHaveLength(2);
    expect(sel.reason).toContain("exceeds available pool");
  });

  it("'rolling-median' window of 0 fails honestly rather than aggregating nothing", () => {
    const sc = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3) });
    const entries = [makeHistoryEntry(0, sc)];
    const sel = selectBaseline(entries, { strategy: "rolling-median", window: 0 });
    expect(sel.ok).toBe(false);
    expect(sel.reason).toContain("window is 0");
  });

  it("'rolling-median' window of 1 degenerates to a single-entry baseline", () => {
    const vals = [5, 15, 25];
    const entries = vals.map((v, i) => makeHistoryEntry(i, makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(v, 50), revision: { sha: `u${i}` } })));
    const sel = selectBaseline(entries, { strategy: "rolling-median", window: 1 });
    expect(sel.ok).toBe(true);
    expect(sel.vtphReference).toBe(25); // the single most recent entry
  });

  it("'best-of-window' picks the entry with the highest vtph verbatim (never a synthetic average)", () => {
    const order = [10, 50, 30];
    const entries = order.map((v, i) => makeHistoryEntry(i, makeFixtureScorecard({ outcomes: outcomesWithVerifiedCount(v, 50), revision: { sha: `bw${i}` } })));
    const sel = selectBaseline(entries, { strategy: "best-of-window", window: 3 });
    expect(sel.ok).toBe(true);
    expect(sel.vtphReference).toBe(50);
    expect(sel.verifiedCorrectReference).toBe(50);
    expect(sel.entry!.sha).toBe("bw1");
  });

  it("rejects an invalid (non-integer / negative) window", () => {
    const sc = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3) });
    const entries = [makeHistoryEntry(0, sc)];
    expect(selectBaseline(entries, { strategy: "rolling-median", window: -1 }).ok).toBe(false);
    expect(selectBaseline(entries, { strategy: "rolling-median", window: 1.5 }).ok).toBe(false);
  });

  it("mode filter narrows the pool", () => {
    const scripted = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(4), mode: "scripted", revision: { sha: "sc" } });
    const keyed = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(9, "k"), mode: "keyed-live", revision: { sha: "kl" } });
    const entries = [makeHistoryEntry(0, scripted), makeHistoryEntry(1, keyed)];
    const sel = selectBaseline(entries, { strategy: "latest", mode: "scripted" });
    expect(sel.ok).toBe(true);
    expect(sel.entry!.mode).toBe("scripted");
  });
});

// ===========================================================================
// compareScorecards -- genuine, engine-produced comparisons
// ===========================================================================

describe("compareScorecards -- real regressions via the real engine", () => {
  const smallSuite = EVAL_TASKS.slice(0, 8);

  it("faithful baseline vs fabricating candidate: a genuine, total regression", async () => {
    const baseline = await runEvalMeasurement({
      revision: makeRevision({ sha: "baseline-faithful" }),
      tasks: smallSuite,
      runner: scriptedEvalRunner(faithful),
      now: makeClock(),
    });
    const candidate = await runEvalMeasurement({
      revision: makeRevision({ sha: "candidate-fabricating" }),
      tasks: smallSuite,
      runner: scriptedEvalRunner(fabricating),
      now: makeClock(),
    });

    const delta = compareScorecards(baseline, candidate);
    expect(delta.version).toBe(EVAL_COMPARE_VERSION);
    expect(delta.comparable).toBe(true);
    expect(delta.incomparableReason).toBeNull();

    expect(delta.verifiedCorrect.baseline).toBe(smallSuite.length);
    expect(delta.verifiedCorrect.candidate).toBe(0);
    expect(delta.verifiedCorrect.direction).toBe("regressed");

    expect(delta.silentWrong.baseline).toBe(0);
    expect(delta.silentWrong.candidate).toBe(smallSuite.length);
    expect(delta.silentWrong.direction).toBe("regressed"); // lower is better; it went up

    expect(delta.vtph.direction).toBe("regressed");

    expect(delta.flips).toHaveLength(smallSuite.length);
    expect(delta.flips.every((f) => f.from === "verified-correct" && f.to === "silent-wrong")).toBe(true);
    expect(delta.flips.every((f) => f.severity === "regression")).toBe(true);
    expect(delta.regressedTaskIds).toHaveLength(smallSuite.length);
    expect(delta.improvedTaskIds).toHaveLength(0);

    expect(delta.paired).not.toBeNull();
    expect(delta.paired!.method).toBe("mcnemar-exact");
    expect(delta.paired!.pairs).toBe(smallSuite.length);
    expect(delta.paired!.regressedFlips).toBe(smallSuite.length);
    expect(delta.paired!.improvedFlips).toBe(0);
    expect(delta.paired!.pValue).toBeLessThan(0.01);
    expect(delta.paired!.significant).toBe(true);

    // no admit fn -> risk lane honestly unmeasured on both sides
    expect(delta.riskComparable).toBe(false);
    expect(delta.riskSilentWrongRate).toBeNull();
    expect(delta.riskIncomparableReason).toContain("unmeasured");
  });

  it("identical faithful runs produce zero flips and an unchanged, non-significant delta", async () => {
    const revision = makeRevision({ sha: "identical" });
    const baseline = await runEvalMeasurement({ revision, tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const candidate = await runEvalMeasurement({ revision, tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });

    const delta = compareScorecards(baseline, candidate);
    expect(delta.comparable).toBe(true);
    expect(delta.verifiedCorrect.direction).toBe("unchanged");
    expect(delta.verifiedCorrect.absolute).toBe(0);
    expect(delta.flips).toHaveLength(0);
    expect(delta.regressedTaskIds).toHaveLength(0);
    expect(delta.improvedTaskIds).toHaveLength(0);
    expect(delta.paired!.regressedFlips).toBe(0);
    expect(delta.paired!.improvedFlips).toBe(0);
    expect(delta.paired!.pValue).toBe(1);
    expect(delta.paired!.significant).toBe(false);
  });

  it("a partial, per-task real regression (mixed runner) produces the exact hand-checkable McNemar p-value", async () => {
    const baseline = await runEvalMeasurement({
      revision: makeRevision({ sha: "baseline-mixed" }),
      tasks: smallSuite,
      runner: scriptedEvalRunner(faithful),
      now: makeClock(),
    });
    const candidate = await runEvalMeasurement({
      revision: makeRevision({ sha: "candidate-mixed" }),
      tasks: smallSuite,
      runner: mixedRunner(smallSuite),
      now: makeClock(),
    });

    const delta = compareScorecards(baseline, candidate, { alpha: 0.2 });
    expect(delta.comparable).toBe(true);
    // even task indices (0,2,4,6) use fabricating -> 4 regressions; odd stay faithful
    expect(delta.verifiedCorrect.candidate).toBe(4);
    expect(delta.silentWrong.candidate).toBe(4);
    expect(delta.regressedTaskIds).toHaveLength(4);
    expect(delta.improvedTaskIds).toHaveLength(0);
    expect(delta.paired!.regressedFlips).toBe(4);
    expect(delta.paired!.improvedFlips).toBe(0);
    // mcnemar(4,0): n=4, tail=P(X<=0)=C(4,0)/16=1/16, p=2/16=0.125 -- hand-checkable
    expect(delta.paired!.pValue).toBeCloseTo(0.125, 6);
    expect(delta.paired!.alpha).toBe(0.2);
    expect(delta.paired!.significant).toBe(true); // 0.125 <= 0.2
  });

  it("defaults alpha to 0.05 when omitted or invalid", async () => {
    const baseline = await runEvalMeasurement({ revision: makeRevision({ sha: "a1" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const candidate = await runEvalMeasurement({ revision: makeRevision({ sha: "a2" }), tasks: smallSuite, runner: scriptedEvalRunner(fabricating), now: makeClock() });
    const delta = compareScorecards(baseline, candidate, { alpha: -5 });
    expect(delta.paired!.alpha).toBe(0.05);
  });

  // The REAL runVtph engine deliberately FLOORS its vtphPerDollar denominator
  // (see scorecard.ts's own doc comment) so a real, engine-produced scorecard
  // never carries a literal Infinity -- only `aggregateOutcomes`'s own
  // independent recomputation is honest enough to report a true Infinity/NaN
  // at true-zero spend. These two tests exercise THIS module's non-finite-safe
  // arithmetic directly against that documented aggregateOutcomes formula,
  // via real, freshly-sealed (never post-seal-mutated) fixture scorecards.
  it("non-finite-safe: zero-spend candidate vs normal-spend baseline yields a real Infinity absolute and 'improved'", () => {
    const ids = allVerifiedOutcomes(5, "cost").map((o) => ({ ...o, usd: 0.01 }));
    const zeroCostIds = allVerifiedOutcomes(5, "cost").map((o) => ({ ...o, usd: 0 }));
    const baseline = makeFixtureScorecard({ outcomes: ids });
    const candidate = makeFixtureScorecard({ outcomes: zeroCostIds });
    expect(baseline.throughput.vtphPerDollar).toBeGreaterThan(0);
    expect(Number.isFinite(baseline.throughput.vtphPerDollar)).toBe(true);
    expect(candidate.throughput.vtphPerDollar).toBe(Number.POSITIVE_INFINITY);

    const delta = compareScorecards(baseline, candidate);
    expect(delta.vtphPerDollar.absolute).toBe(Number.POSITIVE_INFINITY);
    expect(delta.vtphPerDollar.direction).toBe("improved");
  });

  it("non-finite-safe: two zero-spend scorecards produce a NaN absolute and 'unchanged' (never a fabricated direction)", () => {
    const zeroCostA = allVerifiedOutcomes(5, "zc").map((o) => ({ ...o, usd: 0 }));
    const zeroCostB = allVerifiedOutcomes(5, "zc").map((o) => ({ ...o, usd: 0 }));
    const baseline = makeFixtureScorecard({ outcomes: zeroCostA });
    const candidate = makeFixtureScorecard({ outcomes: zeroCostB });
    expect(baseline.throughput.vtphPerDollar).toBe(Number.POSITIVE_INFINITY);
    expect(candidate.throughput.vtphPerDollar).toBe(Number.POSITIVE_INFINITY);
    const delta = compareScorecards(baseline, candidate);
    expect(Number.isNaN(delta.vtphPerDollar.absolute)).toBe(true);
    expect(delta.vtphPerDollar.direction).toBe("unchanged");
  });

  it("compares the risk lane ONLY when both sides are actually measured (real runRiskEval)", async () => {
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const acceptAndCertify: AdmitFn = async (subject: RiskEvalSubject) => {
      const certificate = await authority.issue({
        outputSha256: sha256Hex(subject.output),
        taskId: subject.taskId,
        verifierTier: "T0-execution",
        ensembleScore: 0.99,
        pCorrect: 0.99,
        epsilon: 0.05,
        traceSha256: sha256Hex(JSON.stringify(subject.trace)),
        verifierVersions: ["test-verifier@1"],
        issuedAt: 0,
      });
      return {
        accepted: true,
        domain: subject.domain,
        taskId: subject.taskId,
        score: 0.99,
        threshold: 0.5,
        pCorrect: 0.99,
        epsilon: 0.05,
        tier: "T0-execution",
        certificate,
      };
    };

    const baselineMeasured = await runEvalMeasurement({
      revision: makeRevision({ sha: "risk-baseline" }),
      tasks: smallSuite,
      runner: scriptedEvalRunner(faithful),
      epsilon: 0.05,
      admit: acceptAndCertify,
      solvers: [faithful],
      now: makeClock(),
    });
    const candidateMeasured = await runEvalMeasurement({
      revision: makeRevision({ sha: "risk-candidate" }),
      tasks: smallSuite,
      runner: scriptedEvalRunner(faithful),
      epsilon: 0.05,
      admit: acceptAndCertify,
      solvers: [faithful],
      now: makeClock(),
    });
    const candidateUnmeasured = await runEvalMeasurement({
      revision: makeRevision({ sha: "risk-candidate-unmeasured" }),
      tasks: smallSuite,
      runner: scriptedEvalRunner(faithful),
      now: makeClock(),
    });

    const bothMeasured = compareScorecards(baselineMeasured, candidateMeasured);
    expect(bothMeasured.riskComparable).toBe(true);
    expect(bothMeasured.riskSilentWrongRate).not.toBeNull();
    expect(bothMeasured.riskSilentWrongRate!.baseline).toBe(0);
    expect(bothMeasured.riskIncomparableReason).toBeNull();

    const oneUnmeasured = compareScorecards(baselineMeasured, candidateUnmeasured);
    expect(oneUnmeasured.riskComparable).toBe(false);
    expect(oneUnmeasured.riskSilentWrongRate).toBeNull();
    expect(oneUnmeasured.riskIncomparableReason).toContain("candidate unmeasured");
  });
});

describe("compareScorecards -- INCOMPARABLE paths (never a silent/fabricated diff)", () => {
  const smallSuite = EVAL_TASKS.slice(0, 6);

  it("scorecard-invalid:candidate when the candidate was tampered with after sealing", async () => {
    const baseline = await runEvalMeasurement({ revision: makeRevision({ sha: "valid-baseline" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const good = await runEvalMeasurement({ revision: makeRevision({ sha: "valid-candidate" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });

    const tampered: EvalScorecard = JSON.parse(JSON.stringify(good));
    tampered.outcomes[0] = { ...tampered.outcomes[0], kind: "silent-wrong" }; // mutate WITHOUT resealing

    const delta = compareScorecards(baseline, tampered);
    expect(delta.comparable).toBe(false);
    expect(delta.incomparableReason).toMatch(/^scorecard-invalid:candidate:/);
    // never a fabricated comparison
    expect(delta.flips).toHaveLength(0);
    expect(delta.paired).toBeNull();
  });

  it("scorecard-invalid:baseline when the baseline was tampered with after sealing", async () => {
    const good = await runEvalMeasurement({ revision: makeRevision({ sha: "valid-baseline-2" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const candidate = await runEvalMeasurement({ revision: makeRevision({ sha: "valid-candidate-2" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });

    const tampered: EvalScorecard = JSON.parse(JSON.stringify(good));
    tampered.throughput = { ...tampered.throughput, verifiedCorrect: tampered.throughput.verifiedCorrect + 1 };

    const delta = compareScorecards(tampered, candidate);
    expect(delta.comparable).toBe(false);
    expect(delta.incomparableReason).toMatch(/^scorecard-invalid:baseline:/);
  });

  it("suite-mismatch when the two scorecards were measured over different task suites", async () => {
    const baseline = await runEvalMeasurement({ revision: makeRevision({ sha: "suite-a" }), tasks: EVAL_TASKS.slice(0, 6), runner: scriptedEvalRunner(faithful), now: makeClock() });
    const candidate = await runEvalMeasurement({ revision: makeRevision({ sha: "suite-b" }), tasks: EVAL_TASKS.slice(0, 7), runner: scriptedEvalRunner(faithful), now: makeClock() });
    const delta = compareScorecards(baseline, candidate);
    expect(delta.comparable).toBe(false);
    expect(delta.incomparableReason).toMatch(/^suite-mismatch:/);
    expect(delta.suiteHash).toBe(baseline.suiteHash);
  });

  it("mode-mismatch when one run is scripted and the other keyed-live over the identical suite", async () => {
    const baseline = await runEvalMeasurement({ revision: makeRevision({ sha: "mode-a" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const candidate = await runEvalMeasurement({
      revision: makeRevision({ sha: "mode-b" }),
      tasks: smallSuite,
      runner: scriptedEvalRunner(faithful),
      mode: "keyed-live",
      now: makeClock(),
    });
    expect(baseline.suiteHash).toBe(candidate.suiteHash);
    const delta = compareScorecards(baseline, candidate);
    expect(delta.comparable).toBe(false);
    expect(delta.incomparableReason).toMatch(/^mode-mismatch:scripted:keyed-live$/);
  });

  it("duplicate-task-id: an adversarial resealed candidate with a repeated taskId is caught, not mis-paired", async () => {
    const baseline = await runEvalMeasurement({ revision: makeRevision({ sha: "dup-baseline" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const good = await runEvalMeasurement({ revision: makeRevision({ sha: "dup-candidate" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });

    const mutatedOutcomes = good.outcomes.map((o, i) => (i === 1 ? { ...o, taskId: good.outcomes[0].taskId } : o));
    const { throughput, perCategory } = aggregateOutcomes(mutatedOutcomes, good.throughput.wallClockMs);
    const draft: Omit<EvalScorecard, "contentHash"> = {
      ...good,
      outcomes: mutatedOutcomes,
      throughput,
      perCategory,
    };
    const resealedDuplicate = sealScorecard(draft);

    const delta = compareScorecards(baseline, resealedDuplicate);
    expect(delta.comparable).toBe(false);
    expect(delta.incomparableReason).toMatch(/^duplicate-task-id:candidate:/);
  });

  it("version-mismatch is reported as a distinct-format reason string (documented, currently unreachable via two verifyScorecard-passing scorecards -- see code comment)", () => {
    // scorecard.ts's verifyScorecard hard-rejects any version other than
    // EVAL_SCORECARD_VERSION (=1) as its FIRST check, so two scorecards
    // that both pass verifyScorecard can never disagree on `version` today.
    // This proves the overall INCOMPARABLE guarantee holds end-to-end for a
    // version-skewed pair regardless (it is caught by scorecard-invalid,
    // never silently diffed) while the dedicated `version-mismatch:` format
    // stays in place, ready for the day scorecard.ts recognizes >1 version.
    const sc = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3) });
    const skewed: EvalScorecard = { ...sc, version: 2 };
    const delta = compareScorecards(sc, skewed);
    expect(delta.comparable).toBe(false);
    expect(delta.incomparableReason).toMatch(/^scorecard-invalid:candidate:unsupported-version/);
  });
});

// ===========================================================================
// compareToBaseline
// ===========================================================================

describe("compareToBaseline", () => {
  const smallSuite = EVAL_TASKS.slice(0, 5);

  it("returns null when the selection itself failed", async () => {
    const candidate = await runEvalMeasurement({ revision: makeRevision(), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const failedSelection = selectBaseline([], { strategy: "latest" });
    expect(compareToBaseline(failedSelection, candidate)).toBeNull();
  });

  it("delegates to compareScorecards and produces an identical delta for a consistent entry", async () => {
    const baseline = await runEvalMeasurement({ revision: makeRevision({ sha: "ctb-baseline" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const candidate = await runEvalMeasurement({ revision: makeRevision({ sha: "ctb-candidate" }), tasks: smallSuite, runner: scriptedEvalRunner(fabricating), now: makeClock() });
    const entry = makeHistoryEntry(0, baseline);
    const selection = { ok: true, entry, pool: [entry], strategy: "latest" as const, vtphReference: baseline.throughput.vtph, verifiedCorrectReference: baseline.throughput.verifiedCorrect, silentWrongReference: baseline.throughput.silentWrong, silentWrongRateReference: 0, reason: null };

    const viaBaseline = compareToBaseline(selection, candidate);
    const direct = compareScorecards(baseline, candidate);
    expect(viaBaseline).toEqual(direct);
  });

  it("catches a history entry whose own suiteHash disagrees with its embedded scorecard's suiteHash", async () => {
    const baseline = await runEvalMeasurement({ revision: makeRevision({ sha: "ctb-mismatch" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const candidate = await runEvalMeasurement({ revision: makeRevision({ sha: "ctb-mismatch-cand" }), tasks: smallSuite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const inconsistentEntry = makeHistoryEntry(0, baseline, { suiteHash: "not-the-real-suite-hash" });
    const selection = { ok: true, entry: inconsistentEntry, pool: [inconsistentEntry], strategy: "latest" as const, vtphReference: 0, verifiedCorrectReference: 0, silentWrongReference: 0, silentWrongRateReference: 0, reason: null };

    const delta = compareToBaseline(selection, candidate);
    expect(delta).not.toBeNull();
    expect(delta!.comparable).toBe(false);
    expect(delta!.incomparableReason).toMatch(/^history-entry-suite-hash-mismatch:/);
  });
});

// ===========================================================================
// McNemar exact test -- property tests over synthetic, hand-checkable counts
// ===========================================================================

function deltaWithDiscordantCounts(regressed: number, improved: number, concordant: number): ScorecardDelta {
  const baselineOutcomes: EvalTaskOutcome[] = [];
  const candidateOutcomes: EvalTaskOutcome[] = [];
  let idx = 0;
  for (let i = 0; i < regressed; i++) {
    baselineOutcomes.push(fixtureOutcome(`p${idx}`, "verified-correct"));
    candidateOutcomes.push(fixtureOutcome(`p${idx}`, "silent-wrong"));
    idx++;
  }
  for (let i = 0; i < improved; i++) {
    baselineOutcomes.push(fixtureOutcome(`p${idx}`, "silent-wrong"));
    candidateOutcomes.push(fixtureOutcome(`p${idx}`, "verified-correct"));
    idx++;
  }
  for (let i = 0; i < concordant; i++) {
    baselineOutcomes.push(fixtureOutcome(`p${idx}`, "verified-correct"));
    candidateOutcomes.push(fixtureOutcome(`p${idx}`, "verified-correct"));
    idx++;
  }
  const baseline = makeFixtureScorecard({ outcomes: baselineOutcomes });
  const candidate = makeFixtureScorecard({ outcomes: candidateOutcomes });
  return compareScorecards(baseline, candidate);
}

describe("McNemar exact p-value -- mathematical properties", () => {
  it("p == 1 when regressedFlips == improvedFlips (balanced, no evidence of a real change)", () => {
    expect(deltaWithDiscordantCounts(5, 5, 0).paired!.pValue).toBe(1);
    expect(deltaWithDiscordantCounts(10, 10, 3).paired!.pValue).toBe(1);
  });

  it("is symmetric under swapping regressed/improved counts", () => {
    for (const [b, c] of [[3, 7], [1, 9], [12, 4], [0, 6]]) {
      const p1 = deltaWithDiscordantCounts(b, c, 0).paired!.pValue;
      const p2 = deltaWithDiscordantCounts(c, b, 0).paired!.pValue;
      expect(p1).toBeCloseTo(p2, 12);
    }
  });

  it("decreases monotonically as regressedFlips grows away from a fixed improvedFlips", () => {
    const improved = 3;
    const series = [3, 5, 8, 12, 20].map((regressed) => deltaWithDiscordantCounts(regressed, improved, 0).paired!.pValue);
    for (let i = 1; i < series.length; i++) {
      expect(series[i]).toBeLessThanOrEqual(series[i - 1]);
    }
    // strictly decreasing once regressed has moved past improved
    expect(series[series.length - 1]).toBeLessThan(series[0]);
  });

  it("matches a hand-computed exact value: mcnemar(5,3) over n=8", () => {
    // tail = sum_{i=0..3} C(8,i)/256 = (1+8+28+56)/256 = 93/256; p = min(1, 2*93/256)
    const expectedP = Math.min(1, (2 * 93) / 256);
    expect(deltaWithDiscordantCounts(5, 3, 0).paired!.pValue).toBeCloseTo(expectedP, 10);
  });

  it("pairs == total paired tasks (discordant + concordant), not just the discordant count", () => {
    const d = deltaWithDiscordantCounts(2, 1, 4);
    expect(d.paired!.pairs).toBe(7);
    expect(d.paired!.regressedFlips).toBe(2);
    expect(d.paired!.improvedFlips).toBe(1);
  });
});

// ===========================================================================
// vtphSeries
// ===========================================================================

describe("vtphSeries", () => {
  it("sorts by seq ascending regardless of input order and maps every field", () => {
    const s1 = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(4), revision: { sha: "v1", branch: "main" } });
    const s2 = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(9, "b"), revision: { sha: "v2", branch: "main" } });
    const entries = [makeHistoryEntry(3, s2), makeHistoryEntry(1, s1)]; // out of order on purpose
    const series = vtphSeries(entries);
    expect(series.map((p) => p.seq)).toEqual([1, 3]);
    expect(series[0].sha).toBe("v1");
    expect(series[0].vtph).toBe(4);
    expect(series[1].vtph).toBe(9);
    expect(series[0].branch).toBe("main");
  });

  it("filters by branch, suiteHash, and mode", () => {
    const a = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(2, "a"), revision: { sha: "fa", branch: "feature" } });
    const m = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3, "m"), revision: { sha: "fm", branch: "main" } });
    const entries = [makeHistoryEntry(0, a), makeHistoryEntry(1, m)];
    expect(vtphSeries(entries, { branch: "main" })).toHaveLength(1);
    expect(vtphSeries(entries, { branch: "feature" })[0].sha).toBe("fa");
    expect(vtphSeries(entries, { suiteHash: m.suiteHash })).toHaveLength(1);
    expect(vtphSeries(entries, { mode: "scripted" })).toHaveLength(2);
    expect(vtphSeries(entries, { mode: "keyed-live" })).toHaveLength(0);
  });

  it("limit keeps only the most recent N points (tail, not head)", () => {
    const entries = [1, 2, 3, 4].map((n, i) => makeHistoryEntry(i, makeFixtureScorecard({ outcomes: allVerifiedOutcomes(n * 10, `l${i}-`), revision: { sha: `l${i}` } })));
    const series = vtphSeries(entries, { limit: 2 });
    expect(series.map((p) => p.seq)).toEqual([2, 3]);
  });

  it("throws RangeError on an invalid limit", () => {
    expect(() => vtphSeries([], { limit: -1 })).toThrow(RangeError);
  });

  it("reports silentWrongRate as NaN (never a fabricated 0) for a zero-task scorecard", async () => {
    const empty = await runEvalMeasurement({ revision: makeRevision(), tasks: [], now: makeClock() });
    const series = vtphSeries([makeHistoryEntry(0, empty)]);
    expect(series).toHaveLength(1);
    expect(Number.isNaN(series[0].silentWrongRate)).toBe(true);
  });
});

// ===========================================================================
// detectChangepoint
// ===========================================================================

function syntheticPoint(seq: number, vtph: number): TrendPoint {
  return {
    seq,
    sha: `synthetic-sha-${seq}`,
    shortSha: `syn${seq}`,
    recordedAtMs: seq,
    branch: "main",
    vtph,
    vtphPerDollar: vtph,
    verifiedCorrect: vtph,
    silentWrong: 0,
    silentWrongRate: 0,
  };
}

describe("detectChangepoint -- CUSUM", () => {
  it("SYNTHETIC clearly-labelled step series: detects the drop with a tuned k/threshold", () => {
    const before = Array.from({ length: 6 }, (_, i) => syntheticPoint(i, 50));
    const after = Array.from({ length: 6 }, (_, i) => syntheticPoint(6 + i, 20));
    const points = [...before, ...after];
    const report = detectChangepoint(points, { k: 5, threshold: 20 });
    expect(report.detected).toBe(true);
    expect(report.method).toBe("cusum");
    expect(report.points).toBe(12);
    expect(report.atIndex).toBe(2);
    expect(report.meanBefore).toBe(50);
    expect(report.meanAfter).toBe(32);
    expect(report.drift).toBe(-18);
    expect(report.direction).toBe("regressed"); // vtph dropped, higher is better
    expect(report.statistic).toBeGreaterThan(20);
    expect(report.reason).toBeNull();
  });

  it("SYNTHETIC-FLAT series: never a false positive", () => {
    const points = Array.from({ length: 10 }, (_, i) => syntheticPoint(i, 42));
    const report = detectChangepoint(points);
    expect(report.detected).toBe(false);
    expect(report.atIndex).toBeNull();
    expect(report.direction).toBe("unchanged");
    expect(report.reason).toMatch(/flat/);
  });

  it("refuses to run (honestly) on a series shorter than minPoints", () => {
    const points = Array.from({ length: 3 }, (_, i) => syntheticPoint(i, 10 * i));
    const report = detectChangepoint(points, { minPoints: 8 });
    expect(report.detected).toBe(false);
    expect(report.reason).toMatch(/insufficient points/);
    expect(report.points).toBe(3);
  });

  it("refuses to run over a series containing a NaN measurement rather than silently skipping it", () => {
    const points = Array.from({ length: 9 }, (_, i) => syntheticPoint(i, 5));
    points[4] = { ...points[4], silentWrongRate: Number.NaN };
    const report = detectChangepoint(points, { metric: "silentWrongRate", minPoints: 8 });
    expect(report.detected).toBe(false);
    expect(report.reason).toMatch(/NaN/);
  });

  it("REAL seeded history: a genuine engine-produced regression (faithful -> fabricating) is caught as drift", async () => {
    const suite = EVAL_TASKS.slice(0, 3);
    const entries: EvalHistoryEntry[] = [];
    let seq = 0;
    for (let i = 0; i < 12; i++) {
      const sc = await runEvalMeasurement({
        revision: makeRevision({ sha: `stable-${i}` }),
        tasks: suite,
        runner: scriptedEvalRunner(faithful),
        now: makeClock(),
      });
      entries.push(makeHistoryEntry(seq++, sc));
    }
    for (let i = 0; i < 12; i++) {
      const sc = await runEvalMeasurement({
        revision: makeRevision({ sha: `drifted-${i}` }),
        tasks: suite,
        runner: scriptedEvalRunner(fabricating),
        now: makeClock(),
      });
      entries.push(makeHistoryEntry(seq++, sc));
    }

    const series = vtphSeries(entries);
    expect(series).toHaveLength(24);
    // faithful era measured real verifiedCorrect==suite.length; fabricating era 0
    expect(series[0].verifiedCorrect).toBe(suite.length);
    expect(series[23].verifiedCorrect).toBe(0);

    const report = detectChangepoint(series, { metric: "vtph" });
    expect(report.detected).toBe(true);
    expect(report.direction).toBe("regressed");
    expect(report.drift).toBeLessThan(0);
    expect(report.meanAfter).toBeLessThan(report.meanBefore);
    expect(typeof report.atSha).toBe("string");
    expect(series.map((p) => p.sha)).toContain(report.atSha);
  });
});

// ===========================================================================
// formatScorecardDelta / formatTrend -- aligned ASCII, stable on edge inputs
// ===========================================================================

describe("formatScorecardDelta", () => {
  it("renders an INCOMPARABLE delta compactly with its reason", () => {
    const sc = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3) });
    const other = makeFixtureScorecard({ outcomes: allVerifiedOutcomes(3, "z") }); // different suite
    const delta = compareScorecards(sc, other);
    const lines = formatScorecardDelta(delta);
    expect(lines.some((l) => l.startsWith("INCOMPARABLE:"))).toBe(true);
    expect(lines.some((l) => l.includes("suite-mismatch"))).toBe(true);
  });

  it("renders a comparable delta with aligned METRICS/FLIPS/PAIRED sections", async () => {
    const suite = EVAL_TASKS.slice(0, 5);
    const baseline = await runEvalMeasurement({ revision: makeRevision({ sha: "fmt-baseline" }), tasks: suite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const candidate = await runEvalMeasurement({ revision: makeRevision({ sha: "fmt-candidate" }), tasks: suite, runner: scriptedEvalRunner(fabricating), now: makeClock() });
    const delta = compareScorecards(baseline, candidate);
    const lines = formatScorecardDelta(delta);

    expect(lines[0]).toBe("HADES EVAL SCORECARD DELTA");
    expect(lines.some((l) => l === "METRICS")).toBe(true);
    expect(lines.some((l) => l.includes("verifiedCorrect"))).toBe(true);
    expect(lines.some((l) => l.startsWith("FLIPS ("))).toBe(true);
    expect(lines.some((l) => l.includes("PAIRED SIGNIFICANCE"))).toBe(true);
    expect(lines.some((l) => l.includes("regressed"))).toBe(true);

    // header/dashes/first-data-row of the METRICS table share the same width
    const headerIdx = lines.indexOf("METRICS") + 1;
    expect(lines[headerIdx].length).toBe(lines[headerIdx + 1].length);
    expect(lines[headerIdx + 2].length).toBe(lines[headerIdx].length);
  });

  it("is stable (never throws) on a delta with zero flips", async () => {
    const suite = EVAL_TASKS.slice(0, 3);
    const revision = makeRevision({ sha: "fmt-stable" });
    const baseline = await runEvalMeasurement({ revision, tasks: suite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const candidate = await runEvalMeasurement({ revision, tasks: suite, runner: scriptedEvalRunner(faithful), now: makeClock() });
    const lines = formatScorecardDelta(compareScorecards(baseline, candidate));
    expect(lines.some((l) => l.includes("(none)"))).toBe(true);
  });
});

describe("formatTrend", () => {
  it("is stable on an empty series with no changepoint", () => {
    const lines = formatTrend([]);
    expect(lines[0]).toBe("HADES V-TPH$ TREND");
    expect(lines).toContain("(no trend data)");
  });

  it("renders a populated trend table and an attached changepoint report", () => {
    const points = [syntheticPoint(0, 10), syntheticPoint(1, 12), syntheticPoint(2, 40)];
    const cp = detectChangepoint(points, { minPoints: 3, k: 1, threshold: 1 });
    const lines = formatTrend(points, cp);
    expect(lines.some((l) => l.includes("SEQ"))).toBe(true);
    expect(lines.some((l) => l.includes("CHANGEPOINT (CUSUM)"))).toBe(true);
    expect(lines.some((l) => l.includes(`detected   : ${cp.detected}`))).toBe(true);
  });
});

// ===========================================================================
// EVAL_COMPARE_VERSION
// ===========================================================================

describe("EVAL_COMPARE_VERSION", () => {
  it("is a stable, exported integer constant", () => {
    expect(EVAL_COMPARE_VERSION).toBe(1);
    expect(Number.isInteger(EVAL_COMPARE_VERSION)).toBe(true);
  });
});
