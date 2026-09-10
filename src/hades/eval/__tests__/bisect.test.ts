import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autoBisect,
  verifyBisectReport,
  formatBisectReport,
  verifiedThroughputPredicate,
  silentWrongPredicate,
  taskRegressionPredicate,
  predicateFromBaseline,
  EVAL_BISECT_VERSION,
  type BisectReport,
  type RegressionPredicate,
} from "../bisect";
import { EvalHistoryLedger, type EvalHistoryEntry } from "../history";
import { runEvalMeasurement, scriptedEvalRunner } from "../measure";
import type { EvalScorecard, ScorecardRevision } from "../scorecard";
import { EVAL_TASKS } from "../../bench/eval-suite";
import { scriptedSolvers, type ScriptedSolver, type AdmitFn, type RiskEvalSubject } from "../../trust/risk-eval";
import { sha256Hex } from "../../styx/certificate";

// ===========================================================================
// Shared fixtures
// ===========================================================================

/** 8 real tasks from the real eval corpus -- small enough to keep the
 *  (real, scripted) measurements fast, large enough for flip-detection to be
 *  meaningful. */
const SUITE = EVAL_TASKS.slice(0, 8);

const SOLVERS = scriptedSolvers();
function solverByLabel(label: ScriptedSolver["label"]): ScriptedSolver {
  const s = SOLVERS.find((x) => x.label === label);
  if (s === undefined) throw new Error(`no scripted solver labelled "${label}"`);
  return s;
}

function makeClock(stepMs = 1): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

function contentRevision(sha: string): ScorecardRevision {
  return {
    sha,
    shortSha: sha.slice(0, 12),
    dirty: false,
    workTreeHash: sha256Hex(`wt:${sha}`),
    source: "content",
    committedAtMs: null,
    branch: "main",
  };
}

/** A real, deterministic (always-abstain) admission port. Supplying ANY real
 *  `admit` fn makes `runEvalMeasurement` drive the real `runRiskEval`, which
 *  keeps every risk-lane field a finite number (never NaN). This matters for
 *  these tests specifically because `EvalHistoryLedger` persists entries via
 *  plain `JSON.stringify`/`JSON.parse` (native JSON has no NaN/Infinity
 *  representation), so an *unmeasured* risk lane's NaN fields would silently
 *  become `null` after a round trip through the ledger and desync
 *  `contentHash` -- a real, pre-existing characteristic of `EvalHistoryEntry`
 *  persistence this test suite works around by always measuring risk for
 *  real, exactly as a production caller with a real admission gate would. */
const abstainAlways: AdmitFn = async (subject: RiskEvalSubject) => ({
  accepted: false,
  domain: subject.domain,
  taskId: subject.taskId,
  score: 0,
  threshold: 1,
  pCorrect: 0,
  epsilon: 0.05,
  tier: "test-tier",
  abstention: { code: "test-always-abstain", message: "test fixture never accepts" },
});

/** Builds one real, hash-sealed scorecard for `sha` by actually driving
 *  `runEvalMeasurement` through a real scripted solver (never a fabricated
 *  number). */
async function measureAt(sha: string, label: ScriptedSolver["label"], overrides: Partial<ScorecardRevision> = {}): Promise<EvalScorecard> {
  const revision = { ...contentRevision(sha), ...overrides };
  return runEvalMeasurement({
    revision,
    tasks: SUITE,
    runner: scriptedEvalRunner(solverByLabel(label)),
    label: `measured-${sha.slice(0, 8)}`,
    mode: "scripted",
    now: makeClock(),
    epsilon: 0.05,
    admit: abstainAlways,
  });
}

/**
 * Builds a REAL chain of `n` revisions, appended to a REAL EvalHistoryLedger
 * under a real temp dir: each revision is a genuinely `runEvalMeasurement`'d
 * scorecard produced by a real scripted solver chosen per-index by
 * `labelFor`. A regression is a real measured drop (the solver actually
 * switches to "lossy"/"fabricating"), never an edited number.
 */
async function buildChain(opts: {
  root: string;
  n: number;
  labelFor: (i: number) => ScriptedSolver["label"];
  shaFor?: (i: number) => string;
  overridesFor?: (i: number) => Partial<ScorecardRevision>;
}): Promise<{ entries: EvalHistoryEntry[]; shas: string[] }> {
  let recordedAt = 1_700_000_000_000;
  const ledger = new EvalHistoryLedger({ root: opts.root, now: () => (recordedAt += 1000) });
  const shas: string[] = [];
  for (let i = 0; i < opts.n; i++) {
    const sha = opts.shaFor ? opts.shaFor(i) : sha256Hex(`${opts.root}::chain::${i}`).slice(0, 40);
    shas.push(sha);
    const sc = await measureAt(sha, opts.labelFor(i), opts.overridesFor ? opts.overridesFor(i) : {});
    ledger.append(sc, { note: `rev-${i}` });
  }
  return { entries: ledger.entries(), shas };
}

const SILENT_WRONG_GATE: RegressionPredicate = silentWrongPredicate({ ceiling: 0 });

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hades-bisect-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: dir });
}
function commitFile(dir: string, filename: string, content: string, message: string): string {
  writeFileSync(join(dir, filename), content);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
  return git(dir, ["rev-parse", "HEAD"]);
}

// ===========================================================================
// Predicate builders
// ===========================================================================

describe("predicate builders", () => {
  it("verifiedThroughputPredicate: floor met is good, below floor is bad", async () => {
    const sc = await measureAt("a".repeat(40), "faithful");
    const p = verifiedThroughputPredicate({ floor: SUITE.length });
    const v = p(sc);
    expect(v.good).toBe(true);
    expect(v.value).toBe(SUITE.length);
    expect(v.metric).toBe("verifiedCorrect");
    expect(v.reason).toBeNull();

    const strict = verifiedThroughputPredicate({ floor: SUITE.length + 1 });
    const bad = strict(sc);
    expect(bad.good).toBe(false);
    expect(bad.reason).not.toBeNull();
  });

  it("silentWrongPredicate: faithful is good, lossy is bad with a real drop", async () => {
    const good = await measureAt("b".repeat(40), "faithful");
    const bad = await measureAt("c".repeat(40), "lossy");
    const p = silentWrongPredicate({ ceiling: 0 });
    expect(p(good).good).toBe(true);
    expect(p(good).value).toBe(0);
    const badVerdict = p(bad);
    expect(badVerdict.good).toBe(false);
    expect(badVerdict.value).toBeGreaterThan(0);
    expect(badVerdict.reason).toContain("exceeds");
  });

  it("silentWrongPredicate supports the silentWrongRate metric", async () => {
    const bad = await measureAt("d".repeat(40), "fabricating");
    const p = silentWrongPredicate({ metric: "silentWrongRate", ceiling: 0.1 });
    const v = p(bad);
    expect(v.metric).toBe("silentWrongRate");
    expect(v.good).toBe(false);
    expect(v.value).toBeCloseTo(1, 5);
  });

  it("taskRegressionPredicate: tracks one task's outcome kind", async () => {
    const good = await measureAt("e".repeat(40), "faithful");
    const bad = await measureAt("f".repeat(40), "lossy");
    const taskId = SUITE[0].id;
    const p = taskRegressionPredicate(taskId);
    expect(p(good).good).toBe(true);
    expect(p(bad).good).toBe(false);
    expect(p(bad).reason).toContain(taskId);
  });

  it("taskRegressionPredicate: a task absent from the suite is honestly reported (not a fabricated bad)", async () => {
    const sc = await measureAt("1".repeat(40), "faithful");
    const p = taskRegressionPredicate("no-such-task-id");
    const v = p(sc);
    expect(v.good).toBe(true);
    expect(v.reason).toContain("not present");
  });

  it("predicateFromBaseline: candidate at/above baseline is good, below is bad", async () => {
    const baseline = await measureAt("2".repeat(40), "faithful");
    const p = predicateFromBaseline(baseline, { metric: "verifiedCorrect", tolerance: 0 });
    const same = await measureAt("3".repeat(40), "faithful");
    const worse = await measureAt("4".repeat(40), "lossy");
    expect(p(same).good).toBe(true);
    expect(p(worse).good).toBe(false);
  });
});

// ===========================================================================
// CHECKPOINT: injected, really-measured regression, exact localization
// ===========================================================================

describe("CHECKPOINT: real injected regression is localized exactly", () => {
  it("finds the exact culprit sha and the tasks that actually flipped", async () => {
    const n = 14;
    const regressAt = 9;
    const { entries, shas } = await buildChain({
      root: tmpRoot,
      n,
      labelFor: (i) => (i < regressAt ? "faithful" : "lossy"),
    });

    const report = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[n - 1],
    });

    expect(report.ok).toBe(true);
    expect(report.mode).toBe("history-only");
    expect(report.confidence).toBe("exact");
    expect(report.culpritSha).toBe(shas[regressAt]);
    expect(report.culpritShortSha).toBe(shas[regressAt].slice(0, 12));
    expect(report.lastGoodSha).toBe(shas[regressAt - 1]);
    expect(report.firstBadOrderIndex).toBe(regressAt);
    expect(report.culpritEntry).not.toBeNull();
    expect(report.culpritEntry?.sha).toBe(shas[regressAt]);
    expect(report.metric).toBe("silentWrong");

    // Genuine binary search: O(log n), never a linear scan.
    const bound = Math.ceil(Math.log2(n)) + 2;
    expect(report.probeCount).toBeLessThanOrEqual(bound);
    expect(report.probes.length).toBe(report.probeCount);

    // Every flipped task actually flipped verified-correct -> silent-wrong.
    expect(report.flippedTaskIds.length).toBe(SUITE.length);
    for (const id of report.flippedTaskIds) {
      expect(SUITE.map((t) => t.id)).toContain(id);
    }

    expect(verifyBisectReport(report)).toEqual({ ok: true, reason: null });
  });

  it("localizes to the FIRST bad revision when several later revisions are also bad", async () => {
    const n = 20;
    const regressAt = 13;
    const { entries, shas } = await buildChain({
      root: tmpRoot,
      n,
      labelFor: (i) => (i < regressAt ? "faithful" : "fabricating"),
    });

    const report = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[n - 1],
    });

    expect(report.confidence).toBe("exact");
    expect(report.culpritSha).toBe(shas[regressAt]);
    expect(report.lastGoodSha).toBe(shas[regressAt - 1]);
    const bound = Math.ceil(Math.log2(n)) + 2;
    expect(report.probeCount).toBeLessThanOrEqual(bound);
  });
});

// ===========================================================================
// Tampered evidence is skipped, never trusted
// ===========================================================================

describe("tampered / suite-mismatched evidence", () => {
  it("skips a tampered scorecard and degrades honestly to bracketed (history-only)", async () => {
    const n = 6;
    const regressAt = 3;
    const { entries, shas } = await buildChain({
      root: tmpRoot,
      n,
      labelFor: (i) => (i < regressAt ? "faithful" : "lossy"),
    });

    // Tamper the TRUE culprit's recorded scorecard (mutate a field without
    // recomputing contentHash) -- verifyScorecard must reject it.
    const tampered = entries.map((e) =>
      e.sha === shas[regressAt] ? { ...e, scorecard: { ...e.scorecard, contentHash: "0".repeat(64) } } : e,
    );

    const report = await autoBisect({
      entries: tampered,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[n - 1],
    });

    expect(report.skipped.some((s) => s.sha === shas[regressAt] && s.reason.startsWith("tampered-scorecard"))).toBe(true);
    expect(report.probes.some((p) => p.sha === shas[regressAt])).toBe(false);
    // Cannot cross the gap in history-only mode: honestly bracketed, not exact.
    expect(report.confidence).toBe("bracketed");
    expect(report.lastGoodSha).toBe(shas[regressAt - 1]);
    expect(report.culpritSha).toBe(shas[regressAt + 1]);
    expect(verifyBisectReport(report)).toEqual({ ok: true, reason: null });
  });

  it("active mode fills the same gap via measure() and promotes the result to exact", async () => {
    const n = 6;
    const regressAt = 3;
    const { entries, shas } = await buildChain({
      root: tmpRoot,
      n,
      labelFor: (i) => (i < regressAt ? "faithful" : "lossy"),
    });
    const tampered = entries.map((e) =>
      e.sha === shas[regressAt] ? { ...e, scorecard: { ...e.scorecard, contentHash: "0".repeat(64) } } : e,
    );

    const report = await autoBisect({
      entries: tampered,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[n - 1],
      measure: async (sha) => measureAt(sha, sha === shas[regressAt] ? "lossy" : "faithful"),
    });

    expect(report.mode).toBe("active");
    expect(report.confidence).toBe("exact");
    expect(report.culpritSha).toBe(shas[regressAt]);
    expect(report.lastGoodSha).toBe(shas[regressAt - 1]);
    const culpritProbe = report.probes.find((p) => p.sha === shas[regressAt]);
    expect(culpritProbe?.source).toBe("measured");
  });

  it("requireSuiteMatch skips entries measured on a different suite", async () => {
    const n = 5;
    const { entries, shas } = await buildChain({
      root: tmpRoot,
      n,
      labelFor: () => "faithful",
    });
    // Re-measure index 2 on a DIFFERENT (shorter) suite, same sha.
    const differentSuiteEntries: EvalHistoryEntry[] = entries.map((e, i) => {
      if (i !== 2) return e;
      return { ...e, suiteHash: `${e.suiteHash}-different`, scorecard: { ...e.scorecard, suiteHash: `${e.scorecard.suiteHash}-different` } };
    });

    const report = await autoBisect({
      entries: differentSuiteEntries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[n - 1],
      requireSuiteMatch: true,
      suiteHash: entries[0].suiteHash,
    });

    expect(report.skipped.some((s) => s.sha === shas[2] && s.reason.startsWith("suite-mismatch"))).toBe(true);
    expect(report.probes.some((p) => p.sha === shas[2])).toBe(false);
  });
});

// ===========================================================================
// measure() port robustness
// ===========================================================================

describe("measure() port never corrupts the search", () => {
  /** A 3-revision chain (good, tampered-middle, bad) whose middle sha is
   *  GUARANTEED to be the sole binary-search midpoint (the only candidate
   *  strictly between good and bad), so tampering it exercises the exact
   *  `measure()` failure mode under test deterministically. */
  async function tamperedMiddleChain(): Promise<{ entries: EvalHistoryEntry[]; shas: string[] }> {
    const { entries, shas } = await buildChain({ root: tmpRoot, n: 3, labelFor: (i) => (i < 2 ? "faithful" : "lossy") });
    const tampered = entries.map((e) => (e.sha === shas[1] ? { ...e, scorecard: { ...e.scorecard, contentHash: "1".repeat(64) } } : e));
    return { entries: tampered, shas };
  }

  it("measure() throwing is recorded in skipped and degrades to a bracket, never crashing", async () => {
    const { entries, shas } = await tamperedMiddleChain();
    const report = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[2],
      measure: async (sha) => {
        if (sha === shas[1]) throw new Error("simulated measure failure");
        return measureAt(sha, "faithful");
      },
    });
    expect(report.skipped.some((s) => s.sha === shas[1] && s.reason.startsWith("measure-threw"))).toBe(true);
    expect(report.probes.some((p) => p.sha === shas[1])).toBe(false);
    expect(report.confidence).toBe("bracketed");
    expect(report.lastGoodSha).toBe(shas[0]);
    expect(report.culpritSha).toBe(shas[2]);
  });

  it("measure() returning null is recorded in skipped and degrades to a bracket, never crashing", async () => {
    const { entries, shas } = await tamperedMiddleChain();
    const report = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[2],
      measure: async (sha) => (sha === shas[1] ? null : measureAt(sha, "faithful")),
    });
    expect(report.skipped.some((s) => s.sha === shas[1] && s.reason === "measure-returned-null")).toBe(true);
    expect(report.probes.some((p) => p.sha === shas[1])).toBe(false);
    expect(report.confidence).toBe("bracketed");
  });

  it("measure() returning a scorecard for the WRONG sha is recorded in skipped and degrades to a bracket", async () => {
    const { entries, shas } = await tamperedMiddleChain();
    const report = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[2],
      measure: async (sha) => (sha === shas[1] ? measureAt(shas[2], "faithful") : measureAt(sha, "faithful")),
    });
    expect(report.skipped.some((s) => s.sha === shas[1] && s.reason.startsWith("measure-wrong-sha"))).toBe(true);
    expect(report.probes.some((p) => p.sha === shas[1])).toBe(false);
    expect(report.confidence).toBe("bracketed");
  });
});

// ===========================================================================
// Non-monotone signals
// ===========================================================================

describe("non-monotone signals", () => {
  it("good -> bad -> good -> bad yields ambiguous, never a confident single culprit", async () => {
    const pattern: ScriptedSolver["label"][] = ["faithful", "faithful", "lossy", "faithful", "lossy", "faithful", "lossy", "lossy"];
    const { entries, shas } = await buildChain({
      root: tmpRoot,
      n: pattern.length,
      labelFor: (i) => pattern[i],
    });

    const report = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[pattern.length - 1],
    });

    expect(report.confidence).toBe("ambiguous");
    expect(report.reason).toContain("non-monotone");
    // The earliest defensible transition: index1 (good) -> index2 (bad).
    expect(report.lastGoodSha).toBe(shas[1]);
    expect(report.culpritSha).toBe(shas[2]);
    expect(verifyBisectReport(report)).toEqual({ ok: true, reason: null });
  });
});

// ===========================================================================
// Boundary chains: bad from the start, all-good
// ===========================================================================

describe("boundary chains", () => {
  it("a chain bad from its first revision reports the first revision as culprit, no fabricated good ancestor", async () => {
    const { entries, shas } = await buildChain({
      root: tmpRoot,
      n: 6,
      labelFor: () => "lossy",
    });

    const report = await autoBisect({ entries, predicate: SILENT_WRONG_GATE });

    expect(report.ok).toBe(true);
    expect(report.confidence).toBe("bracketed");
    expect(report.culpritSha).toBe(shas[0]);
    expect(report.lastGoodSha).toBeNull();
    expect(report.reason).toContain("no good ancestor");
  });

  it("an all-good chain yields ok:false, confidence:none, culprit null", async () => {
    const { entries } = await buildChain({
      root: tmpRoot,
      n: 6,
      labelFor: () => "faithful",
    });

    const report = await autoBisect({ entries, predicate: SILENT_WRONG_GATE });

    expect(report.ok).toBe(false);
    expect(report.confidence).toBe("none");
    expect(report.culpritSha).toBeNull();
    expect(report.reason).toContain("no regression detected");
  });
});

// ===========================================================================
// goodSha/badSha relationship validation
// ===========================================================================

describe("goodSha/badSha relationship validation", () => {
  it("refuses when badSha precedes goodSha in the resolved chain order (synthetic, recorded-time)", async () => {
    const { entries, shas } = await buildChain({
      root: tmpRoot,
      n: 6,
      labelFor: (i) => (i < 3 ? "faithful" : "lossy"),
    });

    const report = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[5],
      badSha: shas[1],
    });

    expect(report.ok).toBe(false);
    expect(report.confidence).toBe("none");
    expect(report.reason).toContain("precedes");
  });

  it("refuses when goodSha/badSha are not ancestor-related (real divergent git branches)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "hades-bisect-repo-"));
    try {
      initRepo(repo);
      commitFile(repo, "root.txt", "root", "root commit");
      execFileSync("git", ["checkout", "-q", "-b", "branchA"], { cwd: repo });
      const shaA = commitFile(repo, "a.txt", "a", "commit A");
      execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });
      execFileSync("git", ["checkout", "-q", "-b", "branchB"], { cwd: repo });
      const shaB = commitFile(repo, "b.txt", "b", "commit B");

      const report = await withCwd(repo, () =>
        autoBisect({ entries: [], predicate: SILENT_WRONG_GATE, goodSha: shaA, badSha: shaB }),
      );

      expect(report.ok).toBe(false);
      expect(report.confidence).toBe("none");
      expect(report.culpritSha).toBeNull();
      expect(report.reason).toMatch(/not ancestor-related|precedes/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Shas absent from history entirely
// ===========================================================================

describe("shas absent from history entirely", () => {
  it("history-only mode cannot resolve an unrecorded sha", async () => {
    const goodSha = "5".repeat(40);
    const badSha = "6".repeat(40);
    const report = await autoBisect({ entries: [], predicate: SILENT_WRONG_GATE, goodSha, badSha });

    expect(report.ok).toBe(false);
    expect(report.confidence).toBe("none");
    expect(report.skipped.some((s) => s.sha === badSha && s.reason.includes("unrecorded"))).toBe(true);
  });

  it("active mode resolves the same unrecorded shas via measure()", async () => {
    const goodSha = "7".repeat(40);
    const badSha = "8".repeat(40);
    const report = await autoBisect({
      entries: [],
      predicate: SILENT_WRONG_GATE,
      goodSha,
      badSha,
      measure: async (sha) => measureAt(sha, sha === badSha ? "fabricating" : "faithful"),
    });

    expect(report.ok).toBe(true);
    expect(report.confidence).toBe("exact");
    expect(report.culpritSha).toBe(badSha);
    expect(report.probes.every((p) => p.source === "measured")).toBe(true);
  });
});

// ===========================================================================
// maxProbes exhaustion
// ===========================================================================

describe("maxProbes exhaustion", () => {
  it("returns the best honest bracket, never a fabricated culprit", async () => {
    const n = 20;
    const regressAt = 10;
    const { entries, shas } = await buildChain({
      root: tmpRoot,
      n,
      labelFor: (i) => (i < regressAt ? "faithful" : "lossy"),
    });

    const report = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[n - 1],
      maxProbes: 3,
    });

    expect(report.probeCount).toBeLessThanOrEqual(3);
    expect(report.confidence).not.toBe("exact");
    expect(report.reason).toBeTruthy();
    // Whatever bracket it landed on must still be HONEST: the recorded good
    // probe really is good, the recorded bad probe really is bad.
    const goodProbe = report.probes.find((p) => p.sha === report.lastGoodSha);
    const badProbe = report.probes.find((p) => p.sha === report.culpritSha);
    expect(goodProbe?.good).toBe(true);
    expect(badProbe?.good).toBe(false);
  });
});

// ===========================================================================
// skipDirty
// ===========================================================================

describe("skipDirty", () => {
  it("skips a dirty-worktree scorecard when requested", async () => {
    const n = 5;
    // index 2 is genuinely measured with revision.dirty:true from the start
    // (never mutated post-hoc, which would break contentHash and be caught
    // as tampering instead of exercising the dirty-worktree path).
    const { entries: clean0, shas: cleanShas } = await buildChain({
      root: tmpRoot,
      n,
      labelFor: (i) => (i < 3 ? "faithful" : "lossy"),
    });
    const clean = await autoBisect({ entries: clean0, predicate: SILENT_WRONG_GATE, goodSha: cleanShas[0], badSha: cleanShas[n - 1] });
    expect(clean.skipped.some((s) => s.reason === "dirty-worktree")).toBe(false);

    const { entries: dirtied, shas } = await buildChain({
      root: join(tmpRoot, "dirty"),
      n,
      labelFor: (i) => (i < 3 ? "faithful" : "lossy"),
      overridesFor: (i) => (i === 2 ? { dirty: true } : {}),
    });

    const withSkip = await autoBisect({
      entries: dirtied,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[n - 1],
      skipDirty: true,
    });
    expect(withSkip.skipped.some((s) => s.sha === shas[2] && s.reason === "dirty-worktree")).toBe(true);
  });
});

// ===========================================================================
// Multiple recorded runs at the same sha (reconciliation)
// ===========================================================================

describe("multiple recorded runs at the same sha", () => {
  it("uses the most recent run deterministically and surfaces flakiness in the note", async () => {
    let recordedAt = 1_700_000_000_000;
    const ledger = new EvalHistoryLedger({ root: tmpRoot, now: () => (recordedAt += 1000) });
    // goodSha is recorded FIRST so recorded-time ordering places it before
    // the flaky sha, as intended (goodSha must precede badSha in the
    // resolved chain).
    const goodSha = "a".repeat(40);
    const goodEntry = await measureAt(goodSha, "faithful");
    ledger.append(goodEntry, { note: "good anchor" });

    const sha = "9".repeat(40);
    const firstRun = await measureAt(sha, "faithful");
    ledger.append(firstRun, { note: "first run" });
    const secondRun = await measureAt(sha, "lossy");
    ledger.append(secondRun, { note: "second (flaky) run" });

    const report = await autoBisect({
      entries: ledger.entries(),
      predicate: SILENT_WRONG_GATE,
      goodSha,
      badSha: sha,
    });

    const probe = report.probes.find((p) => p.sha === sha);
    expect(probe).toBeDefined();
    // Most recent (seq 1, the lossy run) wins -- deterministic, not averaged.
    expect(probe?.good).toBe(false);
    expect(probe?.note).toContain("flaky");
    expect(probe?.note).toContain("2 recorded runs");
  });
});

// ===========================================================================
// Order source honesty
// ===========================================================================

describe("orderSource honesty", () => {
  it("labels recorded-time ordering honestly for synthetic (non-git) shas", async () => {
    const { entries, shas } = await buildChain({ root: tmpRoot, n: 5, labelFor: (i) => (i < 3 ? "faithful" : "lossy") });
    const report = await autoBisect({ entries, predicate: SILENT_WRONG_GATE, goodSha: shas[0], badSha: shas[4] });
    expect(report.orderSource).toBe("recorded-time");
  });

  it("labels real git ordering as git when the default path resolves real commits", async () => {
    const repo = mkdtempSync(join(tmpdir(), "hades-bisect-gitorder-"));
    try {
      initRepo(repo);
      const realShas: string[] = [];
      for (let i = 0; i < 5; i++) {
        realShas.push(commitFile(repo, `f${i}.txt`, `content-${i}`, `commit ${i}`));
      }
      const { entries } = await buildChain({
        root: tmpRoot,
        n: 5,
        labelFor: (i) => (i < 3 ? "faithful" : "lossy"),
        shaFor: (i) => realShas[i],
      });

      const report = await withCwd(repo, () =>
        autoBisect({ entries, predicate: SILENT_WRONG_GATE, goodSha: realShas[0], badSha: realShas[4] }),
      );

      expect(report.orderSource).toBe("git");
      expect(report.confidence).toBe("exact");
      expect(report.culpritSha).toBe(realShas[3]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("trusts a caller-supplied order function verbatim (labelled git)", async () => {
    const { entries, shas } = await buildChain({ root: tmpRoot, n: 4, labelFor: (i) => (i < 2 ? "faithful" : "lossy") });
    const reversed = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[3],
      order: (input) => [...input].reverse(),
    });
    // Reversing the order flips which sha is "earlier" -- badSha now precedes
    // goodSha in the (trusted, reversed) chain, so this must refuse rather
    // than silently bisect a nonsensical range.
    expect(reversed.orderSource).toBe("git");
    expect(reversed.ok).toBe(false);
    expect(reversed.reason).toContain("precedes");
  });

  it("falls back honestly when a hostile order function returns garbage", async () => {
    const { entries, shas } = await buildChain({ root: tmpRoot, n: 5, labelFor: (i) => (i < 3 ? "faithful" : "lossy") });
    const report = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[4],
      order: () => ["not", "a", "real", "permutation"],
    });
    expect(report.orderSource).toBe("recorded-time");
    expect(report.confidence).toBe("exact");
    expect(report.culpritSha).toBe(shas[3]);
  });
});

// ===========================================================================
// formatBisectReport
// ===========================================================================

describe("formatBisectReport", () => {
  it("renders an aligned ASCII probe table with the good/bad transition marked", async () => {
    const { entries, shas } = await buildChain({ root: tmpRoot, n: 8, labelFor: (i) => (i < 5 ? "faithful" : "lossy") });
    const report = await autoBisect({ entries, predicate: SILENT_WRONG_GATE, goodSha: shas[0], badSha: shas[7] });
    const lines = formatBisectReport(report);

    expect(lines[0]).toContain("AUTO-BISECT");
    expect(lines.some((l) => l.includes("PROBES"))).toBe(true);
    expect(lines.some((l) => l.includes("GOOD/BAD TRANSITION"))).toBe(true);
    expect(lines.some((l) => l.includes(report.contentHash))).toBe(true);
    expect(report.culpritSha).not.toBeNull();
    expect(lines.some((l) => l.includes(report.culpritSha as string))).toBe(true);
  });

  it("handles a report with no probes gracefully", async () => {
    const report = await autoBisect({ entries: [], predicate: SILENT_WRONG_GATE });
    const lines = formatBisectReport(report);
    expect(lines.some((l) => l.includes("no probes"))).toBe(true);
  });
});

// ===========================================================================
// verifyBisectReport -- tamper detection
// ===========================================================================

describe("verifyBisectReport", () => {
  async function checkpointReport(): Promise<BisectReport> {
    const { entries, shas } = await buildChain({ root: tmpRoot, n: 6, labelFor: (i) => (i < 4 ? "faithful" : "lossy") });
    return autoBisect({ entries, predicate: SILENT_WRONG_GATE, goodSha: shas[0], badSha: shas[5] });
  }

  it("accepts a genuine, untampered report", async () => {
    const report = await checkpointReport();
    expect(verifyBisectReport(report)).toEqual({ ok: true, reason: null });
  });

  it("rejects an unsupported version", async () => {
    const report = await checkpointReport();
    const tampered: BisectReport = { ...report, version: 999 };
    const v = verifyBisectReport(tampered);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("unsupported-version");
  });

  it("rejects a swapped culprit (points at a known-good probe instead)", async () => {
    const report = await checkpointReport();
    const goodProbeSha = report.probes.find((p) => p.good)?.sha;
    expect(goodProbeSha).toBeDefined();
    const tampered: BisectReport = { ...report, culpritSha: goodProbeSha ?? null };
    const v = verifyBisectReport(tampered);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("culprit-probe-not-bad");
  });

  it("rejects a removed probe (probeCount now disagrees with probes.length)", async () => {
    const report = await checkpointReport();
    const tampered: BisectReport = { ...report, probes: report.probes.slice(1) };
    const v = verifyBisectReport(tampered);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("probe-count-mismatch");
  });

  it("rejects an added, fabricated probe", async () => {
    const report = await checkpointReport();
    const fabricated = { ...report.probes[0], sha: "fabricated-sha-0000000000000000000000" };
    const tampered: BisectReport = { ...report, probes: [...report.probes, fabricated] };
    const v = verifyBisectReport(tampered);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("probe-count-mismatch");
  });

  it("rejects a non-adjacent lastGoodSha under a claimed-exact confidence", async () => {
    const { entries, shas } = await buildChain({ root: tmpRoot, n: 6, labelFor: (i) => (i < 4 ? "faithful" : "lossy") });
    const report = await autoBisect({ entries, predicate: SILENT_WRONG_GATE, goodSha: shas[0], badSha: shas[5] });
    expect(report.confidence).toBe("exact");
    const otherGood = report.probes.find((p) => p.good && p.sha !== report.lastGoodSha);
    expect(otherGood).toBeDefined();
    const tampered: BisectReport = { ...report, lastGoodSha: otherGood?.sha ?? null };
    const v = verifyBisectReport(tampered);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("exact-confidence-not-adjacent");
  });

  it("rejects a directly-tampered contentHash when everything else is structurally consistent", async () => {
    const report = await checkpointReport();
    const flippedChar = report.contentHash[0] === "0" ? "1" : "0";
    const tampered: BisectReport = { ...report, contentHash: flippedChar + report.contentHash.slice(1) };
    const v = verifyBisectReport(tampered);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("content-hash-mismatch");
  });
});

// ===========================================================================
// Misc contract checks
// ===========================================================================

describe("misc", () => {
  it("EVAL_BISECT_VERSION is 1", () => {
    expect(EVAL_BISECT_VERSION).toBe(1);
  });

  it("returns a well-formed empty report when entries is empty and no good/bad shas given", async () => {
    const report = await autoBisect({ entries: [], predicate: SILENT_WRONG_GATE });
    expect(report.ok).toBe(false);
    expect(report.confidence).toBe("none");
    expect(report.mode).toBe("history-only");
    expect(report.probeCount).toBe(0);
    expect(report.candidatesConsidered).toBe(0);
    expect(verifyBisectReport(report)).toEqual({ ok: true, reason: null });
  });

  it("active mode is selected precisely by the presence of a measure() port", async () => {
    const { entries, shas } = await buildChain({ root: tmpRoot, n: 4, labelFor: (i) => (i < 2 ? "faithful" : "lossy") });
    const historyOnly = await autoBisect({ entries, predicate: SILENT_WRONG_GATE, goodSha: shas[0], badSha: shas[3] });
    expect(historyOnly.mode).toBe("history-only");
    const active = await autoBisect({
      entries,
      predicate: SILENT_WRONG_GATE,
      goodSha: shas[0],
      badSha: shas[3],
      measure: async (sha) => measureAt(sha, "faithful"),
    });
    expect(active.mode).toBe("active");
  });
});
