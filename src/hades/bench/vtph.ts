/**
 * V-TPH$ — **Verified Tasks per Hour per Dollar**: the honest North-Star
 * benchmark harness.
 *
 * Every other throughput number a multi-agent system can quote is gameable. An
 * agent can emit tokens fast (high tokens/sec), declare everything "done" (high
 * task/hour), and still be worthless if the answers are wrong — or, worse,
 * *confidently* wrong. V-TPH$ is designed to be **ungameable** by construction:
 *
 *   1. Correctness is decided by an INDEPENDENT, pure, deterministic
 *      ground-truth grader ({@link EvalTask.grade}) — never by the agent's own
 *      say-so. The agent's self-assessment ({@link AgentRunResult.claimedVerified})
 *      is treated as a *claim to be audited*, not as truth.
 *   2. The score ({@link VtphReport.vtph}) counts ONLY `verifiedCorrect` results —
 *      tasks the agent delivered as trustworthy (`claimedVerified===true`) AND
 *      that the independent grader confirms (`grade===true`). Nothing else earns
 *      throughput.
 *
 * Because of (2), claiming "verified" on a wrong output does **not** inflate the
 * score. It cannot: a wrong output never satisfies `grade`, so it can never land
 * in `verifiedCorrect`. Instead it lands in {@link VtphReport.silentWrong} — the
 * single most important number in this whole harness.
 *
 * ## silentWrong is the trust metric
 *
 * `silentWrong` = the agent asserted `claimedVerified===true` but the ground
 * truth says the output is WRONG. This is a **trust failure**: the system handed
 * a human (or a downstream agent) a bad answer wearing a "verified" badge. A
 * single-agent baseline with no real verification gate will have a high
 * `silentWrong` — it says "done" whether or not it actually got it right. The
 * entire thesis of a verification-gated swarm is that an adversarial verifier
 * can drive **silentWrong → 0** (decline instead of lying) while keeping
 * `verifiedCorrect` high. This harness is the scoreboard that will later show
 * whether that thesis holds. A system that games "verified" only inflates
 * `silentWrong`, which is exactly the metric you do NOT want to inflate.
 *
 * ## The North Star: {@link VtphReport.vtphPerDollar}
 *
 * `vtph` normalizes verified work by wall-clock hours (so real parallelism
 * counts — a swarm that verifies 10 tasks in the time one agent verifies 1 wins
 * here). `vtphPerDollar` further divides by LLM spend, so a swarm that burns 5×
 * the tokens to get 2× the verified work is correctly scored as *less*
 * efficient. This is the number that decides whether a verification-gated swarm
 * actually beats a single agent per unit of money.
 *
 * Both denominators are FLOORED so the metric cannot be gamed (or nuked) by a
 * degenerate measurement: elapsed wall-clock is clamped to at least
 * {@link MIN_WALL_CLOCK_MS} (1ms) before converting to hours, and spend is
 * clamped to at least $1e-9. Without the time floor, a batch whose wall-clock
 * rounds to 0ms would collapse `vtph`/`vtphPerDollar` to 0 while a 1ms batch
 * prints hundreds of millions — an absurd comparison between two lanes that
 * may have IDENTICAL verified-correct counts. The floor makes sub-millisecond
 * runs saturate at a comparable ceiling instead of jumping between 0 and ∞.
 *
 * ## The trust-adjusted headline: {@link VtphReport.verifiedYield}
 *
 * `verifiedYield = (verifiedCorrect - 10·silentWrong) / max(totalUsd, 1e-9)` —
 * trust per dollar. Each silent-wrong carries a 10× penalty, so a lane that
 * lies scores strictly worse than one that declines the same tasks. Wall-clock
 * deliberately never appears in this denominator: throughput lives in `vtph`;
 * `verifiedYield` answers "how much *trustworthy* work did each dollar buy".
 *
 * Everything is deterministic under an injected `now` and a deterministic
 * runner: wall-clock is sampled with `now()` exactly once before and once after
 * the batch, there is no `Math.random`, and each task's `grade` is invoked
 * exactly once. That makes V-TPH$ numbers reproducible and auditable.
 */

/** A single benchmark task with an independent ground-truth grader. */
export interface EvalTask {
  id: string;
  prompt: string;
  category: string;
  /** Whether this task can be split into subtasks (used by later swarm strategies). */
  decomposable: boolean;
  /**
   * Ground-truth grader — MUST be pure & deterministic. Returns `true` iff
   * `output` is a correct answer to this task. This is the ONLY authority on
   * correctness; the agent's `claimedVerified` flag is never trusted here.
   * Invoked exactly once per task per run.
   */
  grade: (output: string) => boolean;
}

/** What an agent runner returns for one task. */
export interface AgentRunResult {
  output: string;
  /**
   * Did the agent / its verification gate SELF-report this result as
   * verified/trustworthy? This is a *claim*, audited against `grade` — never
   * taken as ground truth.
   */
  claimedVerified: boolean;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  /** Audit-trail entries backing the claim (may be empty). */
  provenance: string[];
}

/** Injectable agent under test: maps a task to a (possibly async) result. */
export type AgentRunner = (task: EvalTask) => Promise<AgentRunResult>;

/** The aggregated V-TPH$ scorecard for one runner over a task suite. */
export interface VtphReport {
  label: string;
  tasks: number;
  /** claimedVerified===true && grade(output)===true — the only work that scores. */
  verifiedCorrect: number;
  /** claimedVerified===true && grade(output)===false — the TRUST FAILURE metric. */
  silentWrong: number;
  /** claimedVerified===false — not delivered as trustworthy (includes throws). */
  declined: number;
  /** claimedVerified===false && grade===true — right but not claimed (a subset of declined). */
  correctButUnclaimed: number;
  /** Raw measured elapsed ms (NOT floored — the floor applies only to the
   *  `vtph` denominator, mirroring how `totalUsd` stays raw while the
   *  `vtphPerDollar` denominator is floored). */
  wallClockMs: number;
  totalTokens: number;
  totalUsd: number;
  /** verifiedCorrect / (max(wallClockMs, MIN_WALL_CLOCK_MS) / 3_600_000).
   *  The 1ms floor keeps a batch whose wall-clock rounds to 0ms from
   *  collapsing to 0 (or dividing by zero) — sub-millisecond runs saturate
   *  at a sane ceiling instead. */
  vtph: number;
  /** vtph / max(totalUsd, 1e-9) — THE NORTH STAR. */
  vtphPerDollar: number;
  /** (verifiedCorrect - 10·silentWrong) / max(totalUsd, 1e-9) — the
   *  TRUST-ADJUSTED headline. Each silent-wrong carries a 10× penalty, so a
   *  lane that lies scores strictly worse than one that declines (a decline
   *  merely fails to earn; a lie costs tenfold), and can go NEGATIVE.
   *  Wall-clock deliberately never appears in this denominator: this is a
   *  trust-per-dollar metric — throughput lives in `vtph`. */
  verifiedYield: number;
  /** fraction of claimedVerified results whose provenance is non-empty. */
  provenanceCompleteRate: number;
}

/** One millisecond-hour: how many ms are in an hour. */
const MS_PER_HOUR = 3_600_000;

/** Floor for the `vtph` time denominator: elapsed wall-clock is clamped to at
 *  least this many ms before converting to hours, exactly as `totalUsd` is
 *  clamped to 1e-9 in the dollar denominators. 1ms is the resolution of a
 *  `Date.now` clock — anything below it is measurement noise, not speed. */
export const MIN_WALL_CLOCK_MS = 1;

/**
 * Run every task in `tasks` through `runner` with **bounded concurrency**
 * (default 8) and produce a {@link VtphReport}.
 *
 * Wall-clock is sampled with `now()` exactly once before and once after the
 * whole batch, so it reflects real parallelism (a runner that overlaps its work
 * finishes the batch in less wall-clock). Tokens and USD are summed across all
 * tasks. Every task is classified into exactly one of
 * {verifiedCorrect, silentWrong, declined} by `(claimedVerified, grade(output))`,
 * with `correctButUnclaimed` tracked as a subset of `declined`.
 *
 * A runner that throws on a task is guarded: that task counts as `declined` with
 * zero tokens/usd and no provenance, and the batch never crashes. `grade` is
 * called exactly once per successfully-run task (and not at all for a throwing
 * one, since there is no output to grade).
 */
export async function runVtph(
  runner: AgentRunner,
  tasks: EvalTask[],
  opts: { label?: string; concurrency?: number; now?: () => number } = {}
): Promise<VtphReport> {
  const label = opts.label ?? "runner";
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 8));
  const now = opts.now ?? (() => performance.now());

  let verifiedCorrect = 0;
  let silentWrong = 0;
  let declined = 0;
  let correctButUnclaimed = 0;
  let totalTokens = 0;
  let totalUsd = 0;
  let claimedCount = 0;
  let claimedWithProvenance = 0;

  const process = async (task: EvalTask): Promise<void> => {
    let result: AgentRunResult;
    try {
      result = await runner(task);
    } catch {
      // Guarded: a throwing runner is a declined task with zero cost.
      declined += 1;
      return;
    }

    totalTokens += result.tokensIn + result.tokensOut;
    totalUsd += result.usd;

    if (result.claimedVerified) {
      claimedCount += 1;
      if (result.provenance.length > 0) claimedWithProvenance += 1;
    }

    const correct = task.grade(result.output); // grade called exactly once

    if (result.claimedVerified) {
      if (correct) verifiedCorrect += 1;
      else silentWrong += 1;
    } else {
      declined += 1;
      if (correct) correctButUnclaimed += 1;
    }
  };

  const start = now();
  await runWithConcurrency(tasks, concurrency, process);
  const end = now();

  const wallClockMs = end - start;
  // Floored denominators (see the module header): time clamps to ≥1ms before
  // the hour conversion, dollars clamp to ≥$1e-9 — so neither a 0ms clock nor
  // a $0 ledger can zero out (or blow up) the scores.
  const hours = Math.max(wallClockMs, MIN_WALL_CLOCK_MS) / MS_PER_HOUR;
  const vtph = verifiedCorrect / hours;
  const vtphPerDollar = vtph / Math.max(totalUsd, 1e-9);
  const verifiedYield = (verifiedCorrect - 10 * silentWrong) / Math.max(totalUsd, 1e-9);
  const provenanceCompleteRate = claimedWithProvenance / Math.max(1, claimedCount);

  return {
    label,
    tasks: tasks.length,
    verifiedCorrect,
    silentWrong,
    declined,
    correctButUnclaimed,
    wallClockMs,
    totalTokens,
    totalUsd,
    vtph,
    vtphPerDollar,
    verifiedYield,
    provenanceCompleteRate,
  };
}

/**
 * A bounded-concurrency worker pool: at most `concurrency` invocations of
 * `worker` are ever in flight at once. Each task calls the grader/runner
 * exactly once; order of completion does not affect the aggregated report.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const pump = async (): Promise<void> => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  };
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, () => pump());
  await Promise.all(lanes);
}

/** Result of {@link compareVtph}: per-runner reports plus a rendered comparison. */
export interface VtphComparison {
  reports: VtphReport[];
  markdownTable: string;
  /** best vtphPerDollar / worst vtphPerDollar (guarded against divide-by-zero). */
  vtphPerDollarSpeedup: number;
}

/**
 * Run several runners over the SAME task suite and render a comparison.
 *
 * The markdown table has columns:
 * `label | tasks | verifiedCorrect | silentWrong | vtph | $ | vtphPerDollar | verifiedYield`.
 * `vtphPerDollarSpeedup` is the best runner's `vtphPerDollar` divided by the
 * worst's — how many times more verified work per dollar the winner delivers.
 * Runners are executed sequentially and each is handed the same injected `now`,
 * so the comparison is deterministic for deterministic runners.
 */
export async function compareVtph(
  runners: Array<{ label: string; runner: AgentRunner }>,
  tasks: EvalTask[],
  opts: { concurrency?: number; now?: () => number } = {}
): Promise<VtphComparison> {
  const reports: VtphReport[] = [];
  for (const { label, runner } of runners) {
    reports.push(
      await runVtph(runner, tasks, { label, concurrency: opts.concurrency, now: opts.now })
    );
  }

  const markdownTable = renderTable(reports);

  let vtphPerDollarSpeedup = 1;
  if (reports.length > 0) {
    const values = reports.map((r) => r.vtphPerDollar);
    const best = Math.max(...values);
    const worst = Math.min(...values);
    vtphPerDollarSpeedup = worst > 0 ? best / worst : best > 0 ? Infinity : 1;
  }

  return { reports, markdownTable, vtphPerDollarSpeedup };
}

/** Render the comparison table. The `$` column is total USD spent; `Yield$`
 *  is {@link VtphReport.verifiedYield} (trust-adjusted, may be negative). */
function renderTable(reports: VtphReport[]): string {
  const header =
    "| Runner | Tasks | Verified✓ | Silent✗ | V-TPH | $ | **V-TPH$/$** | Yield$ |\n" +
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = reports
    .map(
      (r) =>
        `| ${r.label} | ${r.tasks} | ${r.verifiedCorrect} | ${r.silentWrong} | ` +
        `${r.vtph.toFixed(2)} | ${r.totalUsd.toFixed(4)} | ${r.vtphPerDollar.toFixed(2)} | ` +
        `${r.verifiedYield.toFixed(2)} |`
    )
    .join("\n");
  return `${header}\n${body}`;
}
