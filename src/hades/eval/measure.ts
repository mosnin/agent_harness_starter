/**
 * measure.ts — produces a real, hash-sealed `EvalScorecard` by driving the
 * ACTUAL eval engine: the real `runVtph` over the real `EVAL_TASKS` (or a
 * caller-supplied suite), and the real `runRiskEval` epsilon lane when a real
 * `AdmitFn` is injected.
 *
 * This module is deliberately the ONLY place that touches the real engine
 * modules directly; `scorecard.ts` stays a pure data/verification module. The
 * throughput lane is mapped verbatim from `runVtph`'s `VtphReport` — its
 * V-TPH$ arithmetic is never re-derived here. Per-task detail (`wallMs`,
 * `TaskOutcomeKind`, provenance count) that `runVtph`'s aggregate report does
 * not expose is captured via a non-invasive instrumentation layer: the
 * runner and each task's `grade` are wrapped so a per-task clock reading and
 * the grader's verdict can be recorded as a side effect of the SAME single
 * invocation `runVtph` already makes — never a second call to either.
 */

import {
  EVAL_SCORECARD_VERSION,
  EVAL_SCORECARD_GENESIS,
  aggregateOutcomes,
  suiteFingerprint,
  sealScorecard,
  type EvalMode,
  type EvalScorecard,
  type EvalTaskOutcome,
  type RiskLane,
  type ScorecardRevision,
  type TaskOutcomeKind,
  type ThroughputLane,
} from "./scorecard";
import { runVtph, type AgentRunner, type AgentRunResult, type EvalTask } from "../bench/vtph";
import { EVAL_TASKS } from "../bench/eval-suite";
import { runRiskEval, scriptedSolvers, type AdmitFn, type ScriptedSolver } from "../trust/risk-eval";
import { sha256Hex } from "../styx/certificate";

// ===========================================================================
// Locked public surface
// ===========================================================================

export interface MeasureOptions {
  /** The code revision this measurement is FOR — a `ScorecardRevision`. */
  revision: ScorecardRevision;
  /** defaults to the REAL `EVAL_TASKS`. */
  tasks?: EvalTask[];
  /** The agent under test. If omitted, `mode` MUST be `"scripted"` (or
   *  unset) and a deterministic scripted runner is used automatically. */
  runner?: AgentRunner;
  runnerLabel?: string;
  /** defaults to `"scripted"`. `"keyed-live"` with no `runner` throws. */
  mode?: EvalMode;
  concurrency?: number;
  label?: string;
  /** epsilon bound for the risk lane; only used when `admit` is supplied. */
  epsilon?: number;
  /** Real (or test-injected) admission port. Omit to leave the risk lane
   *  honestly `unmeasured` rather than fabricate a passing `0`. */
  admit?: AdmitFn;
  solvers?: ScriptedSolver[];
  now?: () => number;
}

/** Fallback risk epsilon when `admit` is supplied but `epsilon` is not. */
const DEFAULT_RISK_EPSILON = 0.05;

/** Build an `AgentRunner` from a deterministic, non-model `ScriptedSolver`
 *  (see `../trust/risk-eval`'s `scriptedSolvers()`). Every solver except the
 *  `"refusing"` one claims verified — `"lossy"`/`"fabricating"` are exactly
 *  the adversaries that should land in `silentWrong`, which is the point of
 *  exercising them through this harness. Cost figures are synthetic but
 *  fixed and labelled (never presented as real model spend). */
export function scriptedEvalRunner(
  solver: ScriptedSolver,
  opts?: { usdPerTask?: number; tokensPerTask?: number },
): AgentRunner {
  const usdPerTask = opts?.usdPerTask ?? 0.0005;
  const tokensPerTask = Math.max(0, opts?.tokensPerTask ?? 60);
  const tokensIn = Math.round(tokensPerTask * 0.35);
  const tokensOut = tokensPerTask - tokensIn;

  return async (task: EvalTask): Promise<AgentRunResult> => {
    const produced = solver.answer(task);
    return {
      output: produced.output,
      claimedVerified: solver.label !== "refusing",
      tokensIn,
      tokensOut,
      usd: usdPerTask,
      provenance: produced.trace.map((t) => `${t.seq}:${t.kind}:${t.detail}`),
    };
  };
}

/** The default runner used when a measurement is requested with no explicit
 *  `runner`: the real, deterministic `"faithful"` scripted solver. */
export function defaultMeasureRunner(): { runner: AgentRunner; label: string; mode: "scripted" } {
  const solvers = scriptedSolvers();
  const faithful = solvers.find((s) => s.label === "faithful") ?? solvers[0];
  return {
    runner: scriptedEvalRunner(faithful),
    label: `scripted:${faithful.id}`,
    mode: "scripted",
  };
}

interface SideChannelEntry {
  wallMs: number;
  threw: boolean;
  result?: AgentRunResult;
  correct?: boolean;
}

/**
 * Drive one measurement over `opts.tasks` (default the real `EVAL_TASKS`)
 * through `opts.runner` (default the real deterministic scripted runner),
 * and seal the result into an `EvalScorecard`.
 */
export async function runEvalMeasurement(opts: MeasureOptions): Promise<EvalScorecard> {
  const mode: EvalMode = opts.mode ?? "scripted";

  if (mode === "keyed-live" && opts.runner === undefined) {
    throw new Error(
      "runEvalMeasurement: mode 'keyed-live' requires an explicit opts.runner. Refusing to silently " +
        "fall back to the scripted lane -- that would produce a scorecard stamped as scripted work while " +
        "the caller asked for (and expected a scorecard to honestly report) a live keyed run.",
    );
  }

  const now = opts.now ?? ((): number => performance.now());
  const tasks = opts.tasks ?? EVAL_TASKS;
  const label = opts.label ?? "hades-eval-scorecard";
  const concurrency = opts.concurrency;

  let runner: AgentRunner;
  let runnerLabel: string;
  if (opts.runner !== undefined) {
    runner = opts.runner;
    runnerLabel = opts.runnerLabel ?? (mode === "keyed-live" ? "keyed-live-runner" : "custom-scripted-runner");
  } else {
    const def = defaultMeasureRunner();
    runner = def.runner;
    runnerLabel = opts.runnerLabel ?? def.label;
  }

  const createdAtMs = now();

  // -------------------------------------------------------------------
  // Instrumentation: wrap the runner to capture a per-task wall-clock
  // reading, and wrap each task's grade function to capture its verdict —
  // both as side effects of the SAME single invocation `runVtph` makes of
  // each, never a second call to either.
  // -------------------------------------------------------------------
  const sideChannel = new Map<string, SideChannelEntry>();

  const wrappedRunner: AgentRunner = async (task: EvalTask): Promise<AgentRunResult> => {
    const start = now();
    try {
      const result = await runner(task);
      const end = now();
      sideChannel.set(task.id, { wallMs: end - start, threw: false, result });
      return result;
    } catch (err) {
      const end = now();
      sideChannel.set(task.id, { wallMs: end - start, threw: true });
      throw err;
    }
  };

  const instrumentedTasks: EvalTask[] = tasks.map((t) => ({
    ...t,
    grade: (output: string): boolean => {
      const correct = t.grade(output);
      const entry = sideChannel.get(t.id);
      if (entry !== undefined) entry.correct = correct;
      return correct;
    },
  }));

  const vtphReport = await runVtph(wrappedRunner, instrumentedTasks, {
    label: runnerLabel,
    concurrency,
    now,
  });

  const outcomes: EvalTaskOutcome[] = tasks.map((t) => {
    const entry = sideChannel.get(t.id);
    if (entry === undefined || entry.threw || entry.result === undefined) {
      return {
        taskId: t.id,
        category: t.category,
        kind: "runner-error" as TaskOutcomeKind,
        claimedVerified: false,
        graded: false,
        usd: 0,
        tokensIn: 0,
        tokensOut: 0,
        wallMs: entry?.wallMs ?? 0,
        provenanceCount: 0,
      };
    }
    const { result } = entry;
    const isCorrect = entry.correct === true;
    const kind: TaskOutcomeKind = result.claimedVerified
      ? isCorrect
        ? "verified-correct"
        : "silent-wrong"
      : isCorrect
        ? "declined-correct"
        : "declined-wrong";
    return {
      taskId: t.id,
      category: t.category,
      kind,
      claimedVerified: result.claimedVerified,
      graded: true,
      usd: result.usd,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      wallMs: entry.wallMs,
      provenanceCount: result.provenance.length,
    };
  });

  // -------------------------------------------------------------------
  // Risk lane: REAL runRiskEval, only when a real AdmitFn is supplied.
  // -------------------------------------------------------------------
  let risk: RiskLane;
  if (opts.admit !== undefined) {
    const epsilon = opts.epsilon ?? DEFAULT_RISK_EPSILON;
    const report = await runRiskEval({
      tasks,
      solvers: opts.solvers,
      epsilon,
      admit: opts.admit,
      now,
    });
    risk = {
      measured: true,
      unmeasuredReason: null,
      epsilon: report.epsilon,
      attempts: report.attempts,
      accepted: report.accepted,
      coverage: report.coverage,
      silentWrong: report.silentWrong,
      silentWrongRate: report.silentWrongRate,
      withinBound: report.withinBound,
      certificatesIssued: report.certificatesIssued,
      certificatesVerified: report.certificatesVerified,
      certificateFailures: report.certificateFailures.length,
    };
  } else {
    risk = {
      measured: false,
      unmeasuredReason:
        "no AdmitFn supplied (opts.admit) -- the risk lane requires a real admission gate to drive " +
        "runRiskEval. Reporting a fabricated 0 here would misrepresent an untested silent-wrong rate as " +
        "a passing measurement, so every result-shaped field below is an honest 'nothing happened' value: " +
        "0 for counts that are literally zero, NaN (never a claimed 0%) for rates, withinBound=false.",
      epsilon: opts.epsilon ?? Number.NaN,
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

  const durationMs = now() - createdAtMs;

  const suiteTaskIds = tasks.map((t) => t.id);
  const suiteHash = suiteFingerprint(tasks);

  const throughput: ThroughputLane = {
    tasks: vtphReport.tasks,
    verifiedCorrect: vtphReport.verifiedCorrect,
    silentWrong: vtphReport.silentWrong,
    declined: vtphReport.declined,
    correctButUnclaimed: vtphReport.correctButUnclaimed,
    runnerErrors: outcomes.filter((o) => o.kind === "runner-error").length,
    wallClockMs: vtphReport.wallClockMs,
    totalUsd: vtphReport.totalUsd,
    totalTokens: vtphReport.totalTokens,
    vtph: vtphReport.vtph,
    vtphPerDollar: vtphReport.vtphPerDollar,
    provenanceCompleteRate: vtphReport.provenanceCompleteRate,
  };

  const { perCategory } = aggregateOutcomes(outcomes, vtphReport.wallClockMs);

  const scorecardId = sha256Hex(
    `${EVAL_SCORECARD_GENESIS}:${opts.revision.sha}:${suiteHash}:${label}:${mode}:${createdAtMs}`,
  );

  const engine: string[] = [
    "runVtph (../bench/vtph) -- real V-TPH$ throughput engine; throughput lane mapped verbatim, never re-derived",
    "EVAL_TASKS (../bench/eval-suite) -- the real eval corpus, unless a caller-supplied task list overrides it",
  ];
  const realComponents: string[] = [
    "runVtph -- executed the real task suite through the real (or caller-supplied) runner",
    "EvalTask.grade -- pure, deterministic ground-truth grader, invoked exactly once per task by runVtph",
  ];
  if (opts.admit !== undefined) {
    engine.push("runRiskEval (../trust/risk-eval) -- real silent-wrong epsilon checkpoint");
    realComponents.push("runRiskEval -- drove the injected AdmitFn against the real task suite");
  }

  const draft: Omit<EvalScorecard, "contentHash"> = {
    version: EVAL_SCORECARD_VERSION,
    scorecardId,
    label,
    mode,
    revision: opts.revision,
    suiteHash,
    suiteTaskIds,
    createdAtMs,
    durationMs,
    throughput,
    risk,
    perCategory,
    outcomes,
    provenance: {
      engine,
      graderSource:
        "EvalTask.grade from the real eval corpus (../bench/eval-suite EVAL_TASKS) -- pure, deterministic " +
        "ground-truth graders; never the runner's own claim.",
      runnerLabel,
      realComponents,
    },
  };

  return sealScorecard(draft);
}
