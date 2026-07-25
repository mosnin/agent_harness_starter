import { describe, it, expect } from "vitest";
import { runEvalMeasurement, scriptedEvalRunner, defaultMeasureRunner } from "../measure";
import { aggregateOutcomes, verifyScorecard, formatScorecard, type ScorecardRevision } from "../scorecard";
import { EVAL_TASKS } from "../../bench/eval-suite";
import { scriptedSolvers } from "../../trust/risk-eval";
import type { EvalTask, AgentRunner, AgentRunResult } from "../../bench/vtph";
import type { AdmitFn, RiskEvalSubject } from "../../trust/risk-eval";
import { CertificateAuthority, generatePrivateKeyHex, sha256Hex } from "../../styx/certificate";

function makeRevision(overrides: Partial<ScorecardRevision> = {}): ScorecardRevision {
  return {
    sha: "c".repeat(40),
    shortSha: "ccccccc",
    dirty: false,
    workTreeHash: "d".repeat(64),
    source: "git",
    committedAtMs: 1_700_000_000_000,
    branch: "claude/hermes-swarm-framework-vbhrot",
    ...overrides,
  };
}

/** A deterministic clock: each call advances by a fixed increment. Using a
 *  fresh instance per measurement makes two independent runs reproducible. */
function makeClock(stepMs = 1): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

const smallSuite: EvalTask[] = EVAL_TASKS.slice(0, 6);

describe("scriptedEvalRunner / defaultMeasureRunner", () => {
  it("defaultMeasureRunner wraps the real faithful scripted solver", async () => {
    const { runner, label, mode } = defaultMeasureRunner();
    expect(mode).toBe("scripted");
    expect(label).toContain("faithful");
    const task = EVAL_TASKS[0];
    const result = await runner(task);
    expect(result.claimedVerified).toBe(true);
    expect(task.grade(result.output)).toBe(true); // faithful solver actually gets it right
  });

  it("scriptedEvalRunner never claims verified for the refusing solver", async () => {
    const refusing = scriptedSolvers().find((s) => s.label === "refusing")!;
    const runner = scriptedEvalRunner(refusing);
    const result = await runner(EVAL_TASKS[0]);
    expect(result.claimedVerified).toBe(false);
    expect(result.output).toBe("");
  });

  it("respects custom usd/token cost overrides", async () => {
    const faithful = scriptedSolvers().find((s) => s.label === "faithful")!;
    const runner = scriptedEvalRunner(faithful, { usdPerTask: 0.25, tokensPerTask: 100 });
    const result = await runner(EVAL_TASKS[0]);
    expect(result.usd).toBe(0.25);
    expect(result.tokensIn + result.tokensOut).toBe(100);
  });
});

describe("runEvalMeasurement -- honest mode handling", () => {
  it("throws immediately for mode='keyed-live' with no runner, before doing any work", async () => {
    let called = false;
    const tasks: EvalTask[] = [
      { id: "t", prompt: "p", category: "arithmetic", decomposable: false, grade: () => { called = true; return true; } },
    ];
    await expect(
      runEvalMeasurement({ revision: makeRevision(), mode: "keyed-live", tasks }),
    ).rejects.toThrow(/keyed-live/i);
    expect(called).toBe(false);
  });

  it("keyed-live mode works when an explicit runner IS supplied, and stamps mode='keyed-live'", async () => {
    const runner: AgentRunner = async (task) => ({
      output: "irrelevant",
      claimedVerified: false,
      tokensIn: 1,
      tokensOut: 1,
      usd: 0.001,
      provenance: [],
    });
    const scorecard = await runEvalMeasurement({
      revision: makeRevision(),
      mode: "keyed-live",
      tasks: smallSuite,
      runner,
      now: makeClock(),
    });
    expect(scorecard.mode).toBe("keyed-live");
    expect(formatScorecard(scorecard).some((l) => l.includes("keyed-live"))).toBe(true);
  });

  it("the scripted path is always stamped mode='scripted' in the scorecard and formatScorecard output", async () => {
    const scorecard = await runEvalMeasurement({
      revision: makeRevision(),
      tasks: smallSuite,
      now: makeClock(),
    });
    expect(scorecard.mode).toBe("scripted");
    expect(formatScorecard(scorecard).some((l) => l.includes("mode") && l.includes("scripted"))).toBe(true);
  });
});

describe("runEvalMeasurement -- end-to-end over the REAL EVAL_TASKS with the REAL faithful solver", () => {
  it("produces a scorecard whose throughput agrees with an independent recomputation from outcomes", async () => {
    const solver = scriptedSolvers().find((s) => s.label === "faithful")!;
    const runner = scriptedEvalRunner(solver);
    const scorecard = await runEvalMeasurement({
      revision: makeRevision(),
      runner,
      runnerLabel: "faithful-e2e",
      now: makeClock(),
    });

    expect(scorecard.suiteTaskIds).toHaveLength(EVAL_TASKS.length);
    expect(scorecard.outcomes).toHaveLength(EVAL_TASKS.length);

    // Independently recompute from the RECORDED outcomes and the recorded
    // batch wall-clock, and assert agreement with the real-runVtph-sourced
    // throughput lane -- the aggregate must never drift from its own record.
    const recomputed = aggregateOutcomes(scorecard.outcomes, scorecard.throughput.wallClockMs);
    expect(recomputed.throughput.verifiedCorrect).toBe(scorecard.throughput.verifiedCorrect);
    expect(recomputed.throughput.silentWrong).toBe(scorecard.throughput.silentWrong);
    expect(recomputed.throughput.totalUsd).toBeCloseTo(scorecard.throughput.totalUsd, 10);
    expect(recomputed.throughput.declined).toBe(scorecard.throughput.declined);
    expect(recomputed.throughput.runnerErrors).toBe(scorecard.throughput.runnerErrors);

    // The faithful solver actually derives correct answers for every real task.
    expect(scorecard.throughput.verifiedCorrect).toBe(EVAL_TASKS.length);
    expect(scorecard.throughput.silentWrong).toBe(0);
    expect(scorecard.throughput.runnerErrors).toBe(0);

    expect(verifyScorecard(scorecard)).toEqual({ ok: true, reason: null });
  });

  it("grade() is invoked exactly once per task (counting-wrapper proof over a real task)", async () => {
    const realTask = EVAL_TASKS.find((t) => t.category === "arithmetic")!;
    let gradeCalls = 0;
    const countingTask: EvalTask = {
      ...realTask,
      grade: (output: string) => {
        gradeCalls += 1;
        return realTask.grade(output);
      },
    };
    const solver = scriptedSolvers().find((s) => s.label === "faithful")!;
    const runner = scriptedEvalRunner(solver);
    await runEvalMeasurement({ revision: makeRevision(), tasks: [countingTask], runner, now: makeClock() });
    expect(gradeCalls).toBe(1);
  });

  it("per-task wallMs is measured individually, not a divided batch total", async () => {
    // A deterministic clock that advances by a distinct, task-dependent
    // amount each call lets us prove wallMs differs per task rather than
    // being wallClockMs/tasks.length for every entry.
    let n = 0;
    const now = (): number => {
      n += 1;
      return n * n; // 1, 4, 9, 16, ... -- non-uniform steps
    };
    const solver = scriptedSolvers().find((s) => s.label === "faithful")!;
    const runner = scriptedEvalRunner(solver);
    const scorecard = await runEvalMeasurement({
      revision: makeRevision(),
      tasks: smallSuite,
      runner,
      runnerLabel: "wallms-probe",
      concurrency: 1, // force strictly sequential task processing
      now,
    });
    const wallMsValues = scorecard.outcomes.map((o) => o.wallMs);
    expect(wallMsValues.every((w) => w >= 0)).toBe(true);
    // Not every wallMs is identical (which a naive "divide batch total by n"
    // implementation would produce).
    expect(new Set(wallMsValues).size).toBeGreaterThan(1);
    const uniformShare = scorecard.throughput.wallClockMs / scorecard.outcomes.length;
    expect(wallMsValues.some((w) => Math.abs(w - uniformShare) > 1e-6)).toBe(true);
  });

  it("determinism: two independent runs with fresh deterministic clocks produce an IDENTICAL contentHash", async () => {
    const solver = scriptedSolvers().find((s) => s.label === "faithful")!;
    const revision = makeRevision();
    const run = () =>
      runEvalMeasurement({
        revision,
        tasks: smallSuite,
        runner: scriptedEvalRunner(solver),
        runnerLabel: "determinism-probe",
        label: "determinism-probe-scorecard",
        now: makeClock(),
      });
    const [s1, s2] = await Promise.all([run(), run()]);
    expect(s1.contentHash).toBe(s2.contentHash);
    expect(s1.createdAtMs).toBe(s2.createdAtMs);
    expect(s1.scorecardId).toBe(s2.scorecardId);
  });
});

describe("runEvalMeasurement -- degenerate inputs", () => {
  it("an empty task list produces a well-formed, verifiable scorecard", async () => {
    const scorecard = await runEvalMeasurement({ revision: makeRevision(), tasks: [], now: makeClock() });
    expect(scorecard.outcomes).toHaveLength(0);
    expect(scorecard.throughput.tasks).toBe(0);
    expect(scorecard.throughput.verifiedCorrect).toBe(0);
    expect(Object.keys(scorecard.perCategory)).toHaveLength(0);
    expect(verifyScorecard(scorecard)).toEqual({ ok: true, reason: null });
  });

  it("an all-declining runner yields declined for every task and zero verified/silent-wrong", async () => {
    const refusing = scriptedSolvers().find((s) => s.label === "refusing")!;
    const scorecard = await runEvalMeasurement({
      revision: makeRevision(),
      tasks: smallSuite,
      runner: scriptedEvalRunner(refusing),
      now: makeClock(),
    });
    expect(scorecard.throughput.verifiedCorrect).toBe(0);
    expect(scorecard.throughput.silentWrong).toBe(0);
    expect(scorecard.throughput.declined).toBe(smallSuite.length);
    expect(scorecard.outcomes.every((o) => o.kind === "declined-wrong" || o.kind === "declined-correct")).toBe(true);
    expect(verifyScorecard(scorecard).ok).toBe(true);
  });

  it("an all-silent-wrong runner (real fabricating solver) yields silentWrong for every task", async () => {
    const fabricating = scriptedSolvers().find((s) => s.label === "fabricating")!;
    const scorecard = await runEvalMeasurement({
      revision: makeRevision(),
      tasks: smallSuite,
      runner: scriptedEvalRunner(fabricating),
      now: makeClock(),
    });
    expect(scorecard.throughput.silentWrong).toBe(smallSuite.length);
    expect(scorecard.throughput.verifiedCorrect).toBe(0);
    expect(scorecard.outcomes.every((o) => o.kind === "silent-wrong")).toBe(true);
    expect(verifyScorecard(scorecard).ok).toBe(true);
  });

  it("a runner that throws on every task records runner-error outcomes and never crashes the batch", async () => {
    const throwingRunner: AgentRunner = async () => {
      throw new Error("simulated runner failure");
    };
    const scorecard = await runEvalMeasurement({
      revision: makeRevision(),
      tasks: smallSuite,
      runner: throwingRunner,
      now: makeClock(),
    });
    expect(scorecard.outcomes).toHaveLength(smallSuite.length);
    expect(scorecard.outcomes.every((o) => o.kind === "runner-error")).toBe(true);
    expect(scorecard.outcomes.every((o) => o.graded === false)).toBe(true);
    expect(scorecard.throughput.runnerErrors).toBe(smallSuite.length);
    expect(scorecard.throughput.declined).toBe(smallSuite.length);
    expect(scorecard.throughput.verifiedCorrect).toBe(0);
    expect(verifyScorecard(scorecard).ok).toBe(true);
  });
});

describe("runEvalMeasurement -- risk lane", () => {
  it("is honestly unmeasured (never a fabricated 0) when no admit fn is supplied", async () => {
    const scorecard = await runEvalMeasurement({ revision: makeRevision(), tasks: smallSuite, now: makeClock() });
    expect(scorecard.risk.measured).toBe(false);
    expect(scorecard.risk.unmeasuredReason).toBeTruthy();
    expect(Number.isNaN(scorecard.risk.silentWrongRate)).toBe(true);
    expect(Number.isNaN(scorecard.risk.coverage)).toBe(true);
    expect(scorecard.risk.withinBound).toBe(false);
    expect(formatScorecard(scorecard).some((l) => l.includes("UNMEASURED"))).toBe(true);
  });

  it("drives the REAL runRiskEval when an admit fn is supplied (always-abstain admit)", async () => {
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

    const scorecard = await runEvalMeasurement({
      revision: makeRevision(),
      tasks: smallSuite,
      epsilon: 0.05,
      admit: abstainAlways,
      now: makeClock(),
    });

    expect(scorecard.risk.measured).toBe(true);
    expect(scorecard.risk.unmeasuredReason).toBeNull();
    // default scriptedSolvers() has 4 solvers x smallSuite.length tasks
    expect(scorecard.risk.attempts).toBe(smallSuite.length * 4);
    expect(scorecard.risk.accepted).toBe(0);
    expect(scorecard.risk.silentWrong).toBe(0);
    expect(scorecard.risk.withinBound).toBe(true); // 0 accepted, 0 cert failures -> within bound
    expect(scorecard.risk.certificatesIssued).toBe(0);
  });

  it("independently re-verifies real certificates for an admit fn that accepts and issues them", async () => {
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

    const scorecard = await runEvalMeasurement({
      revision: makeRevision(),
      tasks: smallSuite,
      epsilon: 0.05,
      admit: acceptAndCertify,
      solvers: [scriptedSolvers().find((s) => s.label === "faithful")!],
      now: makeClock(),
    });

    expect(scorecard.risk.measured).toBe(true);
    expect(scorecard.risk.accepted).toBe(smallSuite.length);
    expect(scorecard.risk.certificatesIssued).toBe(smallSuite.length);
    expect(scorecard.risk.certificatesVerified).toBe(smallSuite.length);
    expect(scorecard.risk.certificateFailures).toBe(0);
  });
});

describe("runEvalMeasurement -- revision passthrough and content hashing", () => {
  it("carries the caller's ScorecardRevision through verbatim", async () => {
    const revision = makeRevision({ dirty: true, branch: "some-feature-branch" });
    const scorecard = await runEvalMeasurement({ revision, tasks: smallSuite, now: makeClock() });
    expect(scorecard.revision).toEqual(revision);
  });

  it("produces a scorecardId and contentHash that change when the revision changes", async () => {
    const solver = scriptedSolvers().find((s) => s.label === "faithful")!;
    const s1 = await runEvalMeasurement({
      revision: makeRevision({ sha: "1".repeat(40) }),
      tasks: smallSuite,
      runner: scriptedEvalRunner(solver),
      now: makeClock(),
    });
    const s2 = await runEvalMeasurement({
      revision: makeRevision({ sha: "2".repeat(40) }),
      tasks: smallSuite,
      runner: scriptedEvalRunner(solver),
      now: makeClock(),
    });
    expect(s1.scorecardId).not.toBe(s2.scorecardId);
    expect(s1.contentHash).not.toBe(s2.contentHash);
  });
});
