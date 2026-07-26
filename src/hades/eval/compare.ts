/**
 * compare.ts — the pure, dependency-light statistics foundation the
 * never-regress stack reasons with.
 *
 * Four responsibilities, all pure and synchronous:
 *
 *  1. {@link selectBaseline} — pick an HONEST baseline out of recorded
 *     history. Never averages across mismatched suites, never fabricates a
 *     baseline when the pool is empty, and always leaves an auditable
 *     `pool` + `reason` trail explaining the choice.
 *  2. {@link compareScorecards} / {@link compareToBaseline} — a paired,
 *     per-task delta between two `EvalScorecard`s, with a REAL exact
 *     McNemar significance test over the discordant pairs. Two scorecards
 *     that cannot be honestly diffed (different suite, different mode, a
 *     scorecard that fails the real `verifyScorecard`) are reported
 *     `comparable:false` with a specific reason — never silently diffed.
 *  3. {@link vtphSeries} / {@link detectChangepoint} — the V-TPH$ time
 *     series and a real two-sided CUSUM changepoint detector, so slow drift
 *     (which pairwise gating structurally misses) is still caught.
 *  4. {@link formatScorecardDelta} / {@link formatTrend} — aligned plain
 *     ASCII reporters (terminal product; no HTML, no web output).
 *
 * Import policy (locked): this module imports ONLY `./scorecard` (types +
 * the REAL `verifyScorecard`) and the `EvalHistoryEntry` TYPE from
 * `./history`. It never imports `./measure`, `./revision`, `../bench/*`,
 * `../trust/*`, `node:fs`, or any CLI module — everything here is pure and
 * synchronous, safe to run in a browserless, filesystem-less context (the
 * TUI, a worker thread, a unit test) with zero I/O.
 *
 * Honesty rules mirrored from `scorecard.ts`: a metric that cannot be
 * honestly computed (a zero-spend `vtphPerDollar`, an unmeasured risk
 * lane, a baseline that could not be selected) is NEVER silently reported
 * as a fabricated `0` or a confident-but-wrong direction — every such case
 * produces an explicit, documented, non-crashing value (`NaN`, `null`, or a
 * `reason` string) instead.
 */

import { verifyScorecard, type EvalScorecard, type EvalMode, type TaskOutcomeKind, type EvalTaskOutcome } from "./scorecard";
import type { EvalHistoryEntry } from "./history";

// ===========================================================================
// Locked public surface — module version + baseline selection
// ===========================================================================

export const EVAL_COMPARE_VERSION = 1;

export type BaselineStrategy = "latest" | "rolling-median" | "best-of-window" | "specific-sha";

export interface BaselineSelector {
  strategy: BaselineStrategy;
  branch?: string | null;
  suiteHash?: string;
  mode?: EvalMode;
  window?: number;
  sha?: string;
  excludeSha?: string;
  excludeDirty?: boolean;
}

export interface BaselineSelection {
  ok: boolean;
  entry: EvalHistoryEntry | null;
  pool: EvalHistoryEntry[];
  strategy: BaselineStrategy;
  vtphReference: number;
  verifiedCorrectReference: number;
  silentWrongReference: number;
  silentWrongRateReference: number;
  reason: string | null;
}

// ===========================================================================
// Locked public surface — paired delta
// ===========================================================================

export type DeltaDirection = "improved" | "regressed" | "unchanged";

export interface MetricDelta {
  metric: string;
  baseline: number;
  candidate: number;
  absolute: number;
  relative: number;
  direction: DeltaDirection;
  higherIsBetter: boolean;
}

export interface TaskFlip {
  taskId: string;
  category: string;
  from: TaskOutcomeKind;
  to: TaskOutcomeKind;
  severity: "regression" | "improvement" | "neutral";
}

export interface PairedSignificance {
  method: "mcnemar-exact";
  pairs: number;
  regressedFlips: number;
  improvedFlips: number;
  pValue: number;
  alpha: number;
  significant: boolean;
}

export interface ScorecardDelta {
  version: number;
  comparable: boolean;
  incomparableReason: string | null;
  baselineScorecardId: string;
  candidateScorecardId: string;
  baselineSha: string;
  candidateSha: string;
  suiteHash: string;
  verifiedCorrect: MetricDelta;
  vtph: MetricDelta;
  vtphPerDollar: MetricDelta;
  silentWrong: MetricDelta;
  silentWrongRate: MetricDelta;
  riskSilentWrongRate: MetricDelta | null;
  riskComparable: boolean;
  riskIncomparableReason: string | null;
  flips: TaskFlip[];
  regressedTaskIds: string[];
  improvedTaskIds: string[];
  paired: PairedSignificance | null;
}

export interface CompareOptions {
  alpha?: number;
}

// ===========================================================================
// Locked public surface — trend lane
// ===========================================================================

export interface TrendPoint {
  seq: number;
  sha: string;
  shortSha: string;
  recordedAtMs: number;
  branch: string | null;
  vtph: number;
  vtphPerDollar: number;
  verifiedCorrect: number;
  silentWrong: number;
  silentWrongRate: number;
}

export interface TrendSeriesOptions {
  branch?: string | null;
  suiteHash?: string;
  mode?: EvalMode;
  limit?: number;
}

export interface ChangepointReport {
  detected: boolean;
  atIndex: number | null;
  atSha: string | null;
  method: "cusum";
  statistic: number;
  threshold: number;
  meanBefore: number;
  meanAfter: number;
  drift: number;
  direction: DeltaDirection;
  points: number;
  reason: string | null;
}

// ===========================================================================
// Shared numeric helpers — non-finite-safe arithmetic, used by both the
// paired-delta lane and the changepoint lane so their honesty rules agree.
// ===========================================================================

/**
 * `direction` for a signed delta, given whether a HIGHER raw value is
 * better for this metric. NaN or an exact-zero delta are both reported as
 * `"unchanged"` — never a fabricated `"improved"`/`"regressed"` guess. A
 * `±Infinity` delta (e.g. going from a real zero-spend `vtphPerDollar` to a
 * finite one) is classified normally by sign, since `Infinity` is a real,
 * orderable, non-NaN number.
 */
function classifyDirection(absolute: number, higherIsBetter: boolean): DeltaDirection {
  if (Number.isNaN(absolute) || absolute === 0) return "unchanged";
  const better = higherIsBetter ? absolute > 0 : absolute < 0;
  return better ? "improved" : "regressed";
}

/**
 * Relative change of `candidate` vs `baseline`, never a naive
 * `(c-b)/b` when `b` is `0` (which would be `Infinity`/`NaN`/`-Infinity`
 * depending on `c`'s sign — this makes that explicit and documented rather
 * than an accidental IEEE-754 fallthrough): `0` baseline and `0` candidate
 * is genuinely "no change" (`0`); `0` baseline and a nonzero candidate is a
 * genuine infinite relative change, signed by `candidate`'s sign. Either
 * side being `NaN` propagates to a `NaN` relative change — never silently
 * treated as `0`.
 */
function relativeOf(baseline: number, candidate: number): number {
  if (Number.isNaN(baseline) || Number.isNaN(candidate)) return Number.NaN;
  if (baseline === 0) {
    if (candidate === 0) return 0;
    return candidate > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return (candidate - baseline) / Math.abs(baseline);
}

function buildMetricDelta(
  metric: string,
  baselineVal: number,
  candidateVal: number,
  higherIsBetter: boolean,
): MetricDelta {
  const absolute = candidateVal - baselineVal; // NaN/Infinity propagate honestly through IEEE-754 subtraction
  const relative = relativeOf(baselineVal, candidateVal);
  return {
    metric,
    baseline: baselineVal,
    candidate: candidateVal,
    absolute,
    relative,
    direction: classifyDirection(absolute, higherIsBetter),
    higherIsBetter,
  };
}

function emptyMetricDelta(metric: string, higherIsBetter: boolean): MetricDelta {
  return {
    metric,
    baseline: Number.NaN,
    candidate: Number.NaN,
    absolute: Number.NaN,
    relative: Number.NaN,
    direction: "unchanged",
    higherIsBetter,
  };
}

/** Throughput-lane silent-wrong RATE (distinct from the risk lane's own
 *  `silentWrongRate`, which is `silentWrong / accepted` over an admission
 *  gate). This is `silentWrong / tasks` over the whole measured suite. An
 *  empty suite (`tasks === 0`) has no honest rate to report — `NaN`, never
 *  a fabricated `0` that would read as "zero trust failures measured". */
function throughputSilentWrongRate(s: EvalScorecard): number {
  const t = s.throughput;
  return t.tasks > 0 ? t.silentWrong / t.tasks : Number.NaN;
}

// ===========================================================================
// selectBaseline
// ===========================================================================

function describeFilterValue(v: unknown): string {
  return v === undefined ? "(none)" : JSON.stringify(v);
}

function failSelection(strategy: BaselineStrategy, reason: string, pool: EvalHistoryEntry[] = []): BaselineSelection {
  return {
    ok: false,
    entry: null,
    pool,
    strategy,
    vtphReference: Number.NaN,
    verifiedCorrectReference: Number.NaN,
    silentWrongReference: Number.NaN,
    silentWrongRateReference: Number.NaN,
    reason,
  };
}

function okSelection(
  entry: EvalHistoryEntry,
  pool: EvalHistoryEntry[],
  strategy: BaselineStrategy,
  notes: readonly string[],
): BaselineSelection {
  const t = entry.scorecard.throughput;
  return {
    ok: true,
    entry,
    pool,
    strategy,
    vtphReference: t.vtph,
    verifiedCorrectReference: t.verifiedCorrect,
    silentWrongReference: t.silentWrong,
    silentWrongRateReference: t.tasks > 0 ? t.silentWrong / t.tasks : Number.NaN,
    reason: notes.length > 0 ? notes.join("; ") : null,
  };
}

type WindowResolution = { ok: true; size: number; note: string | null } | { ok: false; reason: string };

/**
 * Resolves `window` (rolling-median / best-of-window strategies) against
 * an available pool size:
 *  - `undefined` -> the WHOLE pool (no windowing requested).
 *  - `0` -> an explicit failure (there is nothing to aggregate a baseline
 *    from) rather than a silently-empty/garbage result.
 *  - larger than the pool -> clamped to the pool size, with a `note`
 *    explaining the clamp (never a silent truncation).
 *  - `1` or any other positive integer <= pool size -> used verbatim.
 */
function resolveWindow(window: number | undefined, poolSize: number): WindowResolution {
  if (window === undefined) return { ok: true, size: poolSize, note: null };
  if (!Number.isInteger(window) || window < 0) {
    return { ok: false, reason: `invalid window "${String(window)}" -- must be a non-negative integer` };
  }
  if (window === 0) {
    return { ok: false, reason: "window is 0 -- no entries available to aggregate a baseline from" };
  }
  if (window > poolSize) {
    return {
      ok: true,
      size: poolSize,
      note: `requested window ${window} exceeds available pool of ${poolSize}; using all ${poolSize} entries`,
    };
  }
  return { ok: true, size: window, note: null };
}

/**
 * Picks ONE representative entry out of `windowEntries` (a REAL historical
 * scorecard, never a Frankenstein mix of numbers from different runs) via
 * one of two documented rules:
 *  - `"median"` -- sorts by `vtph` ascending; for an ODD-length window the
 *    true middle element is used; for an EVEN-length window the LOWER
 *    median (the smaller of the two central values, at sorted index
 *    `n/2 - 1`) is used -- never interpolated, so the returned reference
 *    always equals a value that actually occurred in the pool.
 *  - `"best"` -- the entry with the highest `vtph` in the window, ties
 *    broken by higher `verifiedCorrect`, then the most recent `seq`.
 */
function pickByRule(
  windowEntries: readonly EvalHistoryEntry[],
  rule: "median" | "best",
): { entry: EvalHistoryEntry; note: string | null } {
  const withVtph = windowEntries.map((e, i) => ({ e, v: e.scorecard.throughput.vtph, i }));

  if (rule === "best") {
    let bestIdx = 0;
    for (let i = 1; i < withVtph.length; i++) {
      const a = withVtph[i];
      const b = withVtph[bestIdx];
      const av = Number.isNaN(a.v) ? Number.NEGATIVE_INFINITY : a.v;
      const bv = Number.isNaN(b.v) ? Number.NEGATIVE_INFINITY : b.v;
      if (av > bv) {
        bestIdx = i;
      } else if (av === bv) {
        const avc = a.e.scorecard.throughput.verifiedCorrect;
        const bvc = b.e.scorecard.throughput.verifiedCorrect;
        if (avc > bvc || (avc === bvc && a.e.seq > b.e.seq)) bestIdx = i;
      }
    }
    return { entry: withVtph[bestIdx].e, note: null };
  }

  const sorted = [...withVtph].sort((x, y) => {
    const xv = Number.isNaN(x.v) ? Number.POSITIVE_INFINITY : x.v;
    const yv = Number.isNaN(y.v) ? Number.POSITIVE_INFINITY : y.v;
    if (xv !== yv) return xv - yv;
    return x.i - y.i; // stable tie-break by original window position
  });
  const n = sorted.length;
  const idx = n % 2 === 1 ? (n - 1) / 2 : n / 2 - 1;
  const note =
    n % 2 === 0 && n >= 2
      ? `rolling-median: even-length window (n=${n}); using the lower median (sorted index ${idx} of ${n - 1}) -- the smaller of the two central values, never interpolated`
      : null;
  return { entry: sorted[idx].e, note };
}

/**
 * Selects an honest baseline out of recorded history. See module docs for
 * the philosophy; the pipeline, in order:
 *
 *  1. Reject an empty history outright.
 *  2. Filter by `branch` (string exact match, or `null` to require an
 *     unbranched entry -- `undefined` means "no branch filter"), `mode`,
 *     `excludeSha`, `excludeDirty`.
 *  3. Resolve `suiteHash`: if given, filter to it (empty result is a
 *     failure). If NOT given, infer it from the most recent surviving
 *     entry and narrow the pool to that suite -- this is what guarantees
 *     `selectBaseline` NEVER averages/medians across mismatched suites; a
 *     narrowing note is recorded in `reason` whenever this drops entries.
 *  4. Dispatch to the strategy.
 */
export function selectBaseline(entries: readonly EvalHistoryEntry[], sel: BaselineSelector): BaselineSelection {
  const strategy = sel.strategy;

  if (entries.length === 0) return failSelection(strategy, "empty-history");

  const sorted = [...entries].sort((a, b) => a.seq - b.seq);

  let filtered = sorted;
  if (sel.branch !== undefined) filtered = filtered.filter((e) => e.branch === sel.branch);
  if (sel.mode !== undefined) filtered = filtered.filter((e) => e.mode === sel.mode);
  if (sel.excludeSha !== undefined) filtered = filtered.filter((e) => e.sha !== sel.excludeSha);
  if (sel.excludeDirty === true) filtered = filtered.filter((e) => e.scorecard.revision.dirty !== true);

  if (filtered.length === 0) {
    return failSelection(
      strategy,
      `no history entries match filters (branch=${describeFilterValue(sel.branch)}, mode=${describeFilterValue(sel.mode)}, excludeSha=${describeFilterValue(sel.excludeSha)}, excludeDirty=${sel.excludeDirty === true})`,
    );
  }

  const notes: string[] = [];
  let pool: EvalHistoryEntry[];
  if (sel.suiteHash !== undefined) {
    pool = filtered.filter((e) => e.suiteHash === sel.suiteHash);
    if (pool.length === 0) {
      return failSelection(strategy, `no entries for suiteHash "${sel.suiteHash}" after branch/mode/exclude filters`, filtered);
    }
  } else {
    const inferredSuiteHash = filtered[filtered.length - 1].suiteHash;
    pool = filtered.filter((e) => e.suiteHash === inferredSuiteHash);
    if (pool.length < filtered.length) {
      notes.push(
        `suiteHash not specified; inferred "${inferredSuiteHash}" from the most recent matching entry (seq ${filtered[filtered.length - 1].seq}); pool narrowed from ${filtered.length} to ${pool.length} entries with a matching suiteHash (never averaging/median-ing across mismatched suites)`,
      );
    }
  }

  switch (strategy) {
    case "latest": {
      const entry = pool[pool.length - 1];
      return okSelection(entry, pool, strategy, notes);
    }

    case "specific-sha": {
      if (sel.sha === undefined || sel.sha.length === 0) {
        return failSelection(strategy, "specific-sha strategy requires a non-empty sel.sha", pool);
      }
      const matches = pool.filter((e) => e.sha === sel.sha);
      if (matches.length === 0) {
        return failSelection(strategy, `specific-sha: no recorded run for sha "${sel.sha}" in the filtered pool`, pool);
      }
      const entry = matches[matches.length - 1];
      const localNotes = [...notes];
      if (matches.length > 1) {
        localNotes.push(
          `specific-sha: ${matches.length} recorded runs for sha "${sel.sha}"; selected the latest (seq ${entry.seq}, recordedAtMs ${entry.recordedAtMs})`,
        );
      }
      return okSelection(entry, pool, strategy, localNotes);
    }

    case "rolling-median":
    case "best-of-window": {
      const windowResolution = resolveWindow(sel.window, pool.length);
      if (!windowResolution.ok) return failSelection(strategy, windowResolution.reason, pool);
      const localNotes = [...notes];
      if (windowResolution.note !== null) localNotes.push(windowResolution.note);
      const windowEntries = pool.slice(pool.length - windowResolution.size);
      const picked = pickByRule(windowEntries, strategy === "rolling-median" ? "median" : "best");
      if (picked.note !== null) localNotes.push(picked.note);
      return okSelection(picked.entry, pool, strategy, localNotes);
    }

    default: {
      const exhaustive: never = strategy;
      return failSelection(strategy, `unknown baseline strategy "${String(exhaustive)}"`, pool);
    }
  }
}

// ===========================================================================
// compareScorecards / compareToBaseline
// ===========================================================================

function normalizeAlpha(alpha: number | undefined): number {
  if (typeof alpha === "number" && Number.isFinite(alpha) && alpha > 0 && alpha < 1) return alpha;
  return 0.05;
}

function findDuplicateTaskId(outcomes: readonly EvalTaskOutcome[]): string | null {
  const seen = new Set<string>();
  for (const o of outcomes) {
    if (seen.has(o.taskId)) return o.taskId;
    seen.add(o.taskId);
  }
  return null;
}

function buildIncomparable(baseline: EvalScorecard, candidate: EvalScorecard, reason: string): ScorecardDelta {
  return {
    version: EVAL_COMPARE_VERSION,
    comparable: false,
    incomparableReason: reason,
    baselineScorecardId: baseline.scorecardId,
    candidateScorecardId: candidate.scorecardId,
    baselineSha: baseline.revision.sha,
    candidateSha: candidate.revision.sha,
    suiteHash: baseline.suiteHash,
    verifiedCorrect: emptyMetricDelta("verifiedCorrect", true),
    vtph: emptyMetricDelta("vtph", true),
    vtphPerDollar: emptyMetricDelta("vtphPerDollar", true),
    silentWrong: emptyMetricDelta("silentWrong", false),
    silentWrongRate: emptyMetricDelta("silentWrongRate", false),
    riskSilentWrongRate: null,
    riskComparable: false,
    riskIncomparableReason: reason,
    flips: [],
    regressedTaskIds: [],
    improvedTaskIds: [],
    paired: null,
  };
}

/**
 * The five-way outcome-kind "trust score" ordinal scale that gives every
 * possible `TaskOutcomeKind` PAIR a deterministic, documented severity —
 * including every `runner-error` transition, without hand-listing all 20
 * ordered pairs:
 *
 *   verified-correct (+2) > declined-correct (+1) > declined-wrong (0)
 *     > runner-error (-1) > silent-wrong (-2)
 *
 * Rationale: `verified-correct` is the best outcome (correct AND honestly
 * claimed). `declined-correct` is correct but under-confident -- safe, so
 * still positive. `declined-wrong` is wrong but HONEST about it (never
 * claimed) -- the neutral safety baseline, scored `0`. `runner-error` (a
 * crash, no output at all) is scored BELOW the honest-wrong baseline
 * (broken is worse than "tried honestly and got it wrong") but ABOVE
 * `silent-wrong`, because `silent-wrong` -- wrong AND claimed verified --
 * is the one outcome this whole harness exists to catch: a confident LIE.
 * Every flip's severity is simply the sign of the score delta: moving to a
 * higher score is an `"improvement"`, to a lower score is a `"regression"`.
 * This reproduces every case called out by the comprehensiveness bar
 * (verified-correct -> silent-wrong is the biggest possible drop, the
 * worst regression; declined-correct -> silent-wrong is also a regression;
 * silent-wrong -> declined-wrong is an improvement) while also giving every
 * `runner-error` transition an explicit, principled classification.
 */
const TRUST_SCORE: Record<TaskOutcomeKind, number> = {
  "verified-correct": 2,
  "declined-correct": 1,
  "declined-wrong": 0,
  "runner-error": -1,
  "silent-wrong": -2,
};

function classifyFlipSeverity(from: TaskOutcomeKind, to: TaskOutcomeKind): "regression" | "improvement" | "neutral" {
  const a = TRUST_SCORE[from];
  const b = TRUST_SCORE[to];
  if (b > a) return "improvement";
  if (b < a) return "regression";
  return "neutral"; // unreachable while every kind has a distinct score, kept for a future kind that ties
}

interface Paired {
  taskId: string;
  category: string;
  baselineKind: TaskOutcomeKind;
  candidateKind: TaskOutcomeKind;
  baselinePass: boolean;
  candidatePass: boolean;
}

/** Pairs outcomes by `taskId`. Assumes (and this module's suite-hash check
 *  guarantees) both scorecards share an identical suite; any `taskId`
 *  present in `baseline` but missing from `candidate` is skipped rather
 *  than crashing, so a hostile/malformed candidate degrades to a smaller
 *  paired set instead of throwing. */
function pairOutcomes(baseline: EvalScorecard, candidate: EvalScorecard): Paired[] {
  const candidateByTask = new Map(candidate.outcomes.map((o) => [o.taskId, o]));
  const pairs: Paired[] = [];
  for (const b of baseline.outcomes) {
    const c = candidateByTask.get(b.taskId);
    if (c === undefined) continue;
    pairs.push({
      taskId: b.taskId,
      category: b.category,
      baselineKind: b.kind,
      candidateKind: c.kind,
      baselinePass: b.kind === "verified-correct",
      candidatePass: c.kind === "verified-correct",
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Exact McNemar test — binomial two-sided exact p-value over the discordant
// pairs, computed via an iterative log-binomial-coefficient accumulation
// (never a factorial, so it never overflows; stable for n up to thousands).
// ---------------------------------------------------------------------------

/** log(C(n,k)), computed by an iterative running sum of
 *  `log(n-i) - log(i+1)` (never `n!`/`k!` directly, so it never overflows
 *  for any `n` a real eval suite could have). */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  if (k === 0 || k === n) return 0;
  const kk = Math.min(k, n - k);
  let logC = 0;
  for (let i = 0; i < kk; i++) {
    logC += Math.log(n - i) - Math.log(i + 1);
  }
  return logC;
}

function binomialPmfHalf(n: number, k: number): number {
  if (n === 0) return k === 0 ? 1 : 0;
  return Math.exp(logChoose(n, k) - n * Math.log(2));
}

/**
 * Exact two-sided McNemar p-value for discordant counts `b` (baseline-pass,
 * candidate-fail -- "regressed") and `c` (baseline-fail, candidate-pass --
 * "improved"), under the null hypothesis `Binomial(n=b+c, p=0.5)`:
 *
 *   p = min(1, 2 * P(X <= min(b, c)))   where X ~ Binomial(n, 0.5)
 *
 * This is the standard "two times the smaller tail" exact binomial test
 * (concordant pairs, where both sides agree, carry no information about
 * which side is better and are correctly excluded from `n`). Properties
 * exercised by this module's tests: `p ≈ 1` when `b == c` (n even, the
 * tail-sum from 0..n/2 is ~half the distribution); `p` is symmetric under
 * swapping `b`/`c` (both only ever appear via `n=b+c` and `min(b,c)`); and
 * `p` decreases monotonically as `b` grows away from `c` (holding `c`
 * fixed), since a fixed `min(b,c)=c` cumulative binomial tail shrinks as
 * `n` grows and the distribution's mass shifts away from it.
 */
function mcnemarExactPValue(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1; // no discordant pairs -- nothing distinguishes baseline from candidate
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomialPmfHalf(n, i);
  return Math.min(1, 2 * tail);
}

/**
 * Runs `verifyScorecard` on BOTH inputs and produces a paired, per-task
 * delta -- or, whenever an honest comparison is impossible, a
 * `comparable:false` result with a specific, machine-parseable reason.
 * Checks run in this fixed order, each with its own distinct reason:
 *
 *   1. `scorecard-invalid:baseline:<reason>` / `scorecard-invalid:candidate:<reason>`
 *   2. `suite-mismatch:<baselineHash>:<candidateHash>`
 *   3. `mode-mismatch:<baselineMode>:<candidateMode>`
 *   4. `version-mismatch:<baselineVersion>:<candidateVersion>`
 *   5. `duplicate-task-id:<baseline|candidate>:<taskId>` (adversarial
 *      resistance: a resealed-but-internally-inconsistent-by-taskId
 *      scorecard is caught here rather than silently mis-paired)
 *
 * The risk (silent-wrong epsilon) lane is compared ONLY when BOTH sides
 * have `risk.measured === true` -- an unmeasured `NaN` rate is never
 * treated as a passing `0`.
 */
export function compareScorecards(
  baseline: EvalScorecard,
  candidate: EvalScorecard,
  opts?: CompareOptions,
): ScorecardDelta {
  const baselineVerify = verifyScorecard(baseline);
  if (!baselineVerify.ok) {
    return buildIncomparable(baseline, candidate, `scorecard-invalid:baseline:${baselineVerify.reason ?? "unknown"}`);
  }
  const candidateVerify = verifyScorecard(candidate);
  if (!candidateVerify.ok) {
    return buildIncomparable(baseline, candidate, `scorecard-invalid:candidate:${candidateVerify.reason ?? "unknown"}`);
  }
  if (baseline.suiteHash !== candidate.suiteHash) {
    return buildIncomparable(baseline, candidate, `suite-mismatch:${baseline.suiteHash}:${candidate.suiteHash}`);
  }
  if (baseline.mode !== candidate.mode) {
    return buildIncomparable(baseline, candidate, `mode-mismatch:${baseline.mode}:${candidate.mode}`);
  }
  if (baseline.version !== candidate.version) {
    // Unreachable via two scorecards that both pass verifyScorecard TODAY
    // (scorecard.ts currently recognizes exactly one version), but this
    // module must not silently diff a future version skew, so the check
    // stays here as real dispatch logic ahead of that day.
    return buildIncomparable(baseline, candidate, `version-mismatch:${baseline.version}:${candidate.version}`);
  }
  const dupBaseline = findDuplicateTaskId(baseline.outcomes);
  if (dupBaseline !== null) {
    return buildIncomparable(baseline, candidate, `duplicate-task-id:baseline:${dupBaseline}`);
  }
  const dupCandidate = findDuplicateTaskId(candidate.outcomes);
  if (dupCandidate !== null) {
    return buildIncomparable(baseline, candidate, `duplicate-task-id:candidate:${dupCandidate}`);
  }

  const verifiedCorrect = buildMetricDelta(
    "verifiedCorrect",
    baseline.throughput.verifiedCorrect,
    candidate.throughput.verifiedCorrect,
    true,
  );
  const vtph = buildMetricDelta("vtph", baseline.throughput.vtph, candidate.throughput.vtph, true);
  const vtphPerDollar = buildMetricDelta(
    "vtphPerDollar",
    baseline.throughput.vtphPerDollar,
    candidate.throughput.vtphPerDollar,
    true,
  );
  const silentWrong = buildMetricDelta("silentWrong", baseline.throughput.silentWrong, candidate.throughput.silentWrong, false);
  const silentWrongRate = buildMetricDelta(
    "silentWrongRate",
    throughputSilentWrongRate(baseline),
    throughputSilentWrongRate(candidate),
    false,
  );

  let riskSilentWrongRate: MetricDelta | null = null;
  let riskComparable = false;
  let riskIncomparableReason: string | null = null;
  if (baseline.risk.measured && candidate.risk.measured) {
    riskSilentWrongRate = buildMetricDelta(
      "riskSilentWrongRate",
      baseline.risk.silentWrongRate,
      candidate.risk.silentWrongRate,
      false,
    );
    riskComparable = true;
  } else {
    const parts: string[] = [];
    if (!baseline.risk.measured) parts.push(`baseline unmeasured: ${baseline.risk.unmeasuredReason ?? "no reason given"}`);
    if (!candidate.risk.measured) parts.push(`candidate unmeasured: ${candidate.risk.unmeasuredReason ?? "no reason given"}`);
    riskIncomparableReason = parts.join(" | ");
  }

  const taskPairs = pairOutcomes(baseline, candidate);
  const flips: TaskFlip[] = [];
  for (const p of taskPairs) {
    if (p.baselineKind === p.candidateKind) continue;
    flips.push({
      taskId: p.taskId,
      category: p.category,
      from: p.baselineKind,
      to: p.candidateKind,
      severity: classifyFlipSeverity(p.baselineKind, p.candidateKind),
    });
  }
  const regressedTaskIds = flips.filter((f) => f.severity === "regression").map((f) => f.taskId);
  const improvedTaskIds = flips.filter((f) => f.severity === "improvement").map((f) => f.taskId);

  let paired: PairedSignificance | null = null;
  if (taskPairs.length > 0) {
    let regressedFlips = 0;
    let improvedFlips = 0;
    for (const p of taskPairs) {
      if (p.baselinePass && !p.candidatePass) regressedFlips += 1;
      else if (!p.baselinePass && p.candidatePass) improvedFlips += 1;
    }
    const alpha = normalizeAlpha(opts?.alpha);
    const pValue = mcnemarExactPValue(regressedFlips, improvedFlips);
    paired = {
      method: "mcnemar-exact",
      pairs: taskPairs.length,
      regressedFlips,
      improvedFlips,
      pValue,
      alpha,
      significant: pValue <= alpha,
    };
  }

  return {
    version: EVAL_COMPARE_VERSION,
    comparable: true,
    incomparableReason: null,
    baselineScorecardId: baseline.scorecardId,
    candidateScorecardId: candidate.scorecardId,
    baselineSha: baseline.revision.sha,
    candidateSha: candidate.revision.sha,
    suiteHash: baseline.suiteHash,
    verifiedCorrect,
    vtph,
    vtphPerDollar,
    silentWrong,
    silentWrongRate,
    riskSilentWrongRate,
    riskComparable,
    riskIncomparableReason,
    flips,
    regressedTaskIds,
    improvedTaskIds,
    paired,
  };
}

/**
 * Convenience wrapper: `null` ONLY when `selection.ok` is `false` (there is
 * genuinely no baseline to compare against). When `selection.ok` is `true`
 * but the selected history entry is itself internally inconsistent -- its
 * own `suiteHash` field disagrees with its embedded `scorecard.suiteHash`,
 * an adversarial-resistance case this module must catch rather than trust
 * -- a `comparable:false` `ScorecardDelta` is returned (not `null`, since a
 * real comparison attempt did happen and deserves a reason on record).
 */
export function compareToBaseline(
  selection: BaselineSelection,
  candidate: EvalScorecard,
  opts?: CompareOptions,
): ScorecardDelta | null {
  if (!selection.ok || selection.entry === null) return null;
  const entry = selection.entry;
  if (entry.suiteHash !== entry.scorecard.suiteHash) {
    return buildIncomparable(
      entry.scorecard,
      candidate,
      `history-entry-suite-hash-mismatch:${entry.suiteHash}:${entry.scorecard.suiteHash}`,
    );
  }
  return compareScorecards(entry.scorecard, candidate, opts);
}

// ===========================================================================
// Trend lane -- V-TPH$ series + CUSUM changepoint detection
// ===========================================================================

export function vtphSeries(entries: readonly EvalHistoryEntry[], opts: TrendSeriesOptions = {}): TrendPoint[] {
  let filtered = [...entries].sort((a, b) => a.seq - b.seq);
  if (opts.branch !== undefined) filtered = filtered.filter((e) => e.branch === opts.branch);
  if (opts.suiteHash !== undefined) filtered = filtered.filter((e) => e.suiteHash === opts.suiteHash);
  if (opts.mode !== undefined) filtered = filtered.filter((e) => e.mode === opts.mode);
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 0) {
      throw new RangeError("TrendSeriesOptions.limit must be a non-negative integer");
    }
    if (opts.limit < filtered.length) filtered = filtered.slice(filtered.length - opts.limit);
  }
  return filtered.map((e) => {
    const t = e.scorecard.throughput;
    return {
      seq: e.seq,
      sha: e.sha,
      shortSha: e.scorecard.revision.shortSha,
      recordedAtMs: e.recordedAtMs,
      branch: e.branch,
      vtph: t.vtph,
      vtphPerDollar: t.vtphPerDollar,
      verifiedCorrect: t.verifiedCorrect,
      silentWrong: t.silentWrong,
      silentWrongRate: t.tasks > 0 ? t.silentWrong / t.tasks : Number.NaN,
    };
  });
}

type ChangepointMetric = "vtph" | "verifiedCorrect" | "silentWrongRate";

const CHANGEPOINT_METRIC_HIGHER_IS_BETTER: Record<ChangepointMetric, boolean> = {
  vtph: true,
  verifiedCorrect: true,
  silentWrongRate: false,
};

function changepointMetricValue(p: TrendPoint, metric: ChangepointMetric): number {
  if (metric === "vtph") return p.vtph;
  if (metric === "verifiedCorrect") return p.verifiedCorrect;
  return p.silentWrongRate;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function stdev(xs: readonly number[], m: number): number {
  if (xs.length === 0) return 0;
  let sq = 0;
  for (const x of xs) sq += (x - m) * (x - m);
  return Math.sqrt(sq / xs.length);
}

function flatChangepointReport(points: number, reason: string): ChangepointReport {
  return {
    detected: false,
    atIndex: null,
    atSha: null,
    method: "cusum",
    statistic: 0,
    threshold: 0,
    meanBefore: Number.NaN,
    meanAfter: Number.NaN,
    drift: 0,
    direction: "unchanged",
    points,
    reason,
  };
}

/**
 * A real two-sided CUSUM (cumulative-sum) changepoint detector over
 * `points` (ascending-`seq` order is NOT assumed -- callers pass the output
 * of {@link vtphSeries}, but this function does not re-sort, so pass an
 * already-ordered series).
 *
 * Two running sums track upward (`sHi`) and downward (`sLo`) drift away
 * from the whole-series mean `m`, each reset to `0` whenever they would go
 * negative (the standard CUSUM recurrence):
 *
 *   sHi[i] = max(0, sHi[i-1] + (x[i] - m - k))
 *   sLo[i] = max(0, sLo[i-1] + (m - k - x[i]))
 *
 * `k` (the "slack", defaulting to `0.5 * stdev`) is the minimum drift per
 * point that counts as signal rather than noise -- the standard choice for
 * detecting roughly a one-sigma mean shift. `threshold` (the decision
 * interval `h`, defaulting to `5 * stdev`) is how much accumulated drift
 * triggers a detection. A changepoint is DETECTED at the first index where
 * either running sum exceeds `threshold`; `meanBefore`/`meanAfter` split
 * the series at that index (points before / points from the change onward
 * are averaged separately) and `drift = meanAfter - meanBefore`.
 *
 * NEVER a false positive by construction: a perfectly flat series has
 * `stdev = 0`, hence `k = threshold = 0`, and `x[i] - m - 0 = 0` at every
 * point, which never exceeds a strict `> 0` threshold. A series shorter
 * than `minPoints` (default `8`) is refused outright with a reason rather
 * than run through an underpowered detector. A series containing a `NaN`
 * value (an honestly-undefined measurement, e.g. `silentWrongRate` over a
 * zero-task scorecard) is also refused with a reason, rather than letting
 * `NaN` silently propagate into a misleading `detected:false`.
 */
export function detectChangepoint(
  points: readonly TrendPoint[],
  opts: { metric?: ChangepointMetric; k?: number; threshold?: number; minPoints?: number } = {},
): ChangepointReport {
  const metric = opts.metric ?? "vtph";
  const minPoints = opts.minPoints ?? 8;
  const higherIsBetter = CHANGEPOINT_METRIC_HIGHER_IS_BETTER[metric];

  if (points.length < minPoints) {
    return flatChangepointReport(
      points.length,
      `insufficient points (n=${points.length}) for changepoint detection (minPoints=${minPoints})`,
    );
  }

  const values = points.map((p) => changepointMetricValue(p, metric));
  if (values.some((v) => Number.isNaN(v))) {
    return flatChangepointReport(
      points.length,
      `series for metric "${metric}" contains a NaN value (an honestly-unmeasured point) -- CUSUM refuses to run over an undefined measurement rather than silently skipping it`,
    );
  }

  const overallMean = mean(values);
  const sd = stdev(values, overallMean);
  const k = opts.k ?? 0.5 * sd;
  const threshold = opts.threshold ?? 5 * sd;

  let sHi = 0;
  let sLo = 0;
  let peak = 0;
  let detectedAt: number | null = null;
  let detectedStatistic = 0;

  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    sHi = Math.max(0, sHi + (x - overallMean - k));
    sLo = Math.max(0, sLo + (overallMean - k - x));
    peak = Math.max(peak, sHi, sLo);
    if (detectedAt === null && (sHi > threshold || sLo > threshold)) {
      detectedAt = i;
      detectedStatistic = Math.max(sHi, sLo);
    }
  }

  if (detectedAt === null) {
    return {
      detected: false,
      atIndex: null,
      atSha: null,
      method: "cusum",
      statistic: peak,
      threshold,
      meanBefore: overallMean,
      meanAfter: overallMean,
      drift: 0,
      direction: "unchanged",
      points: points.length,
      reason:
        sd === 0
          ? "series is perfectly flat (stdev=0) -- no shift to detect"
          : `CUSUM statistic never exceeded the decision threshold (peak=${peak.toFixed(6)}, threshold=${threshold.toFixed(6)})`,
    };
  }

  const before = values.slice(0, detectedAt);
  const after = values.slice(detectedAt);
  const meanBefore = before.length > 0 ? mean(before) : overallMean;
  const meanAfter = mean(after);
  const drift = meanAfter - meanBefore;

  return {
    detected: true,
    atIndex: detectedAt,
    atSha: points[detectedAt].sha,
    method: "cusum",
    statistic: detectedStatistic,
    threshold,
    meanBefore,
    meanAfter,
    drift,
    direction: classifyDirection(drift, higherIsBetter),
    points: points.length,
    reason: null,
  };
}

// ===========================================================================
// Reporting -- aligned ASCII text, CLI/TUI-ready. No HTML, no web output.
// ===========================================================================

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function fmtNum(n: number, digits = 4): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Number.POSITIVE_INFINITY) return "Infinity";
  if (n === Number.NEGATIVE_INFINITY) return "-Infinity";
  return n.toFixed(digits);
}

function fmtRelative(n: number): string {
  if (!Number.isFinite(n)) return fmtNum(n, 4);
  return `${(n * 100).toFixed(2)}%`;
}

export function formatScorecardDelta(d: ScorecardDelta): string[] {
  const lines: string[] = [];
  lines.push("HADES EVAL SCORECARD DELTA");
  lines.push("=".repeat(70));
  lines.push(`baseline  : ${d.baselineScorecardId} (sha ${d.baselineSha.slice(0, 12)})`);
  lines.push(`candidate : ${d.candidateScorecardId} (sha ${d.candidateSha.slice(0, 12)})`);
  lines.push(`suiteHash : ${d.suiteHash}`);
  lines.push("");

  if (!d.comparable) {
    lines.push(`INCOMPARABLE: ${d.incomparableReason ?? "unknown reason"}`);
    return lines;
  }

  lines.push("METRICS");
  const metricRows = [d.verifiedCorrect, d.vtph, d.vtphPerDollar, d.silentWrong, d.silentWrongRate];
  const headers = ["METRIC", "BASELINE", "CANDIDATE", "ABSOLUTE", "RELATIVE", "DIRECTION"];
  const rows = metricRows.map((m) => [
    m.metric,
    fmtNum(m.baseline),
    fmtNum(m.candidate),
    fmtNum(m.absolute),
    fmtRelative(m.relative),
    m.direction,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  lines.push(headers.map((h, i) => padRight(h, widths[i])).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) lines.push(r.map((c, i) => padRight(c, widths[i])).join("  "));
  lines.push("");

  lines.push("RISK (silent-wrong epsilon lane)");
  if (!d.riskComparable || d.riskSilentWrongRate === null) {
    lines.push(`  NOT COMPARABLE: ${d.riskIncomparableReason ?? "unknown reason"}`);
  } else {
    const r = d.riskSilentWrongRate;
    lines.push(`  baseline  : ${fmtNum(r.baseline)}`);
    lines.push(`  candidate : ${fmtNum(r.candidate)}`);
    lines.push(`  absolute  : ${fmtNum(r.absolute)}`);
    lines.push(`  direction : ${r.direction}`);
  }
  lines.push("");

  lines.push("PAIRED SIGNIFICANCE (McNemar exact)");
  if (d.paired === null) {
    lines.push("  n/a (no paired tasks)");
  } else {
    const p = d.paired;
    lines.push(`  pairs          : ${p.pairs}`);
    lines.push(`  regressedFlips : ${p.regressedFlips}`);
    lines.push(`  improvedFlips  : ${p.improvedFlips}`);
    lines.push(`  pValue         : ${p.pValue.toFixed(6)}`);
    lines.push(`  alpha          : ${p.alpha}`);
    lines.push(`  significant    : ${p.significant}`);
  }
  lines.push("");

  lines.push(`FLIPS (${d.flips.length})`);
  if (d.flips.length === 0) {
    lines.push("  (none)");
  } else {
    for (const f of d.flips) {
      lines.push(`  [${f.severity.toUpperCase().padEnd(11)}] ${f.taskId} (${f.category}): ${f.from} -> ${f.to}`);
    }
  }
  lines.push("");
  lines.push(`regressedTaskIds (${d.regressedTaskIds.length}): ${d.regressedTaskIds.join(", ") || "(none)"}`);
  lines.push(`improvedTaskIds  (${d.improvedTaskIds.length}): ${d.improvedTaskIds.join(", ") || "(none)"}`);

  return lines;
}

export function formatTrend(points: readonly TrendPoint[], cp?: ChangepointReport): string[] {
  const lines: string[] = [];
  lines.push("HADES V-TPH$ TREND");
  lines.push("=".repeat(70));

  if (points.length === 0) {
    lines.push("(no trend data)");
  } else {
    const headers = ["SEQ", "SHA", "BRANCH", "VTPH", "VTPH/$", "VERIFIED", "SILENT-WRONG", "SW-RATE"];
    const rows = points.map((p) => [
      String(p.seq),
      p.shortSha,
      p.branch ?? "(none)",
      fmtNum(p.vtph),
      fmtNum(p.vtphPerDollar),
      String(p.verifiedCorrect),
      String(p.silentWrong),
      fmtNum(p.silentWrongRate),
    ]);
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    lines.push(headers.map((h, i) => padRight(h, widths[i])).join("  "));
    lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    for (const r of rows) lines.push(r.map((c, i) => padRight(c, widths[i])).join("  "));
  }
  lines.push("");

  if (cp !== undefined) {
    lines.push("CHANGEPOINT (CUSUM)");
    lines.push(`  detected   : ${cp.detected}`);
    if (cp.detected) {
      lines.push(`  atIndex    : ${cp.atIndex}`);
      lines.push(`  atSha      : ${cp.atSha}`);
    }
    lines.push(`  statistic  : ${fmtNum(cp.statistic, 6)}`);
    lines.push(`  threshold  : ${fmtNum(cp.threshold, 6)}`);
    lines.push(`  meanBefore : ${fmtNum(cp.meanBefore)}`);
    lines.push(`  meanAfter  : ${fmtNum(cp.meanAfter)}`);
    lines.push(`  drift      : ${fmtNum(cp.drift)}`);
    lines.push(`  direction  : ${cp.direction}`);
    if (cp.reason !== null) lines.push(`  reason     : ${cp.reason}`);
  }

  return lines;
}
