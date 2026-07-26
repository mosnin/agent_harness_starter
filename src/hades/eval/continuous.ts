/**
 * continuous.ts — the engine behind `hades eval`: resolve the current
 * revision, run the real measurement, append it to the hash-chained history,
 * evaluate the never-regress gate against a selected baseline, and — when
 * the gate BLOCKS — automatically run bisect to localize the offending
 * revision, emitting a typed event stream the CLI/TUI can render live. Also
 * provides `evalStatus`, a strictly read-only status view (latest entry,
 * chain verification, last verdict, V-TPH$ trend + changepoint).
 *
 * This module is PURE COMPOSITION over the real engine modules it imports —
 * it never re-derives a metric, a significance test, a gate rule, or a
 * bisection strategy. Its only job is: sequence the real calls in the right
 * order, thread a single injectable clock and event sink through all of
 * them, and CONTAIN every failure so the function itself never rejects on
 * anything except a genuine programmer error (an invalid `root`).
 *
 * ## Failure containment (the property this module exists to guarantee)
 *
 * Every real seam this module calls (`measure`, `EvalHistoryLedger.append`,
 * `EvalHistoryLedger.verifyChain`/`entries`, `evaluateNeverRegressGate`,
 * `GateVerdictJournal.append`, `autoBisect`) can fail for real reasons (disk
 * I/O, lock contention, a hostile/thrown injected function, corrupted
 * on-disk state). None of those failures are allowed to reject this async
 * function or to produce a `verdict.decision === "allow"` — each is caught
 * at its call site, recorded as an `"error"` `ContinuousEvent`, and folded
 * into the result so the caller always gets back a complete, honest
 * `ContinuousEvalResult`. The ONLY two things this module lets propagate as
 * a real exception are: (a) an invalid `opts.root` (checked up front, before
 * any I/O), and (b) an injected `opts.resolve` throwing — the real
 * `resolveRevision` never throws by its own contract, so a thrown resolve is
 * a caller/test bug, not an operational failure this module is asked to
 * contain (it is not in the enumerated failure-containment list).
 *
 * ## Ordering (locked mechanics of THIS module, not of any imported one)
 *
 *  1. resolve revision (real `resolveRevision`, or an injected pin).
 *  2. open the ledger (real `EvalHistoryLedger`, or an injected instance).
 *  3. load the policy (real `loadPolicy`).
 *  4. snapshot `entries()` BEFORE any append — this snapshot is what both
 *     the dedupe check and the baseline selection use, so `selectBaseline`
 *     (e.g. a `"latest"` strategy) can never accidentally select the
 *     candidate being evaluated as its own baseline.
 *  5. `skipIfRecorded` dedupe check against that snapshot (a dirty revision
 *     is NEVER eligible for dedupe — see `resolveRevision`'s own honesty
 *     about `dirty`).
 *  6. measure (unless skipped).
 *  7. record (append to the ledger) unless `record:false` or skipped.
 *  8. verify chain integrity.
 *  9. evaluate the never-regress gate — `chainOk` fed to it is forced
 *     `false` whenever EITHER the chain verification failed OR this run's
 *     own append attempt failed, so an unrecorded candidate can never buy an
 *     `"allow"` by virtue of not having been durably persisted.
 * 10. append the verdict to the real `GateVerdictJournal` — ONLY when this
 *     run durably recorded a NEW entry (`record && recorded`), never for a
 *     dry run, a skip, or a synthetic failure verdict.
 * 11. auto-bisect — ONLY when `verdict.decision === "block"` AND
 *     `bisectOnBlock` — always in `"history-only"` mode (re-measuring an
 *     arbitrary historical git revision would require checking it out,
 *     which is out of scope for this module; every revision it can localize
 *     is one that was ACTUALLY measured and recorded, by this module or a
 *     seed).
 * 12. trend + changepoint over the post-append state, scoped to the
 *     candidate's own `suiteHash`/`branch` (T1's real `vtphSeries` +
 *     `detectChangepoint` — never re-derived here).
 *
 * Import policy (locked): `./measure`, `./revision`, `./history`,
 * `./scorecard`, `./compare`, `./regression-gate`, `./bisect`,
 * `../styx/certificate` (`sha256Hex`, for the one synthetic "engine could
 * not even obtain a candidate scorecard" failure verdict this module builds
 * by hand — never a fabricated PERFORMANCE number, only a bookkeeping
 * placeholder for a total-failure verdict). Plus `node:fs`/`node:path`
 * primitives, used only for read-only existence checks in `evalStatus` (so
 * it never triggers `EvalHistoryLedger`'s or `GateVerdictJournal`'s
 * create-header-if-missing side effect on a root that has no ledger/journal
 * yet). Never any CLI module.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  EvalHistoryLedger,
  type EvalHistoryEntry,
  type HistoryChainVerification,
} from "./history";
import { resolveRevision } from "./revision";
import { runEvalMeasurement, defaultMeasureRunner } from "./measure";
import type { EvalScorecard, ScorecardRevision } from "./scorecard";
import {
  selectBaseline,
  vtphSeries,
  detectChangepoint,
  type BaselineSelector,
  type BaselineSelection,
  type TrendPoint,
  type ChangepointReport,
  type TrendSeriesOptions,
} from "./compare";
import {
  evaluateNeverRegressGate,
  loadPolicy,
  GateVerdictJournal,
  DEFAULT_NEVER_REGRESS_POLICY,
  policyHash,
  EVAL_GATE_VERSION,
  type NeverRegressPolicy,
  type GateVerdict,
  type GateDecision,
  type GateFinding,
} from "./regression-gate";
import { autoBisect, predicateFromBaseline, type BisectReport } from "./bisect";
import { sha256Hex } from "../styx/certificate";

// ===========================================================================
// Locked public surface — version, event stream
// ===========================================================================

export const EVAL_CONTINUOUS_VERSION = 1;

export type ContinuousEventKind =
  | "revision-resolved"
  | "duplicate-skipped"
  | "measure-started"
  | "measure-finished"
  | "recorded"
  | "baseline-selected"
  | "gate-evaluated"
  | "bisect-started"
  | "bisect-finished"
  | "trend-computed"
  | "error";

export interface ContinuousEvent {
  kind: ContinuousEventKind;
  atMs: number;
  message: string;
  sha?: string;
  decision?: GateDecision;
  detail?: Record<string, string | number | boolean | null>;
}

export interface ContinuousEvalOptions {
  root: string;
  ledger?: EvalHistoryLedger;
  measure?: (revision: ScorecardRevision) => Promise<EvalScorecard>;
  resolve?: () => ScorecardRevision;
  policy?: NeverRegressPolicy;
  baseline?: BaselineSelector;
  label?: string;
  note?: string | null;
  record?: boolean;
  skipIfRecorded?: boolean;
  bisectOnBlock?: boolean;
  bisectMaxProbes?: number;
  trendLimit?: number;
  now?: () => number;
  onEvent?: (e: ContinuousEvent) => void;
}

export interface ContinuousEvalResult {
  version: number;
  revision: ScorecardRevision;
  scorecard: EvalScorecard | null;
  entry: EvalHistoryEntry | null;
  recorded: boolean;
  skipped: boolean;
  skippedReason: string | null;
  baseline: BaselineSelection;
  verdict: GateVerdict;
  bisect: BisectReport | null;
  trend: TrendPoint[];
  changepoint: ChangepointReport;
  chain: HistoryChainVerification;
  events: ContinuousEvent[];
  startedAtMs: number;
  durationMs: number;
}

export interface EvalStatusReport {
  version: number;
  root: string;
  entries: number;
  chain: HistoryChainVerification;
  latest: EvalHistoryEntry | null;
  latestVerdict: GateVerdict | null;
  baseline: BaselineSelection;
  trend: TrendPoint[];
  changepoint: ChangepointReport;
  policyHash: string;
  policySource: "file" | "default";
  warnings: string[];
}

// ===========================================================================
// Small local helpers (bookkeeping only — never a regression rule, never a
// metric, never a bisection strategy: those all stay in the real modules).
// ===========================================================================

function describeErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function emptyChain(reason: string | null): HistoryChainVerification {
  return { ok: reason === null, entries: 0, brokenAtSeq: null, reason };
}

/**
 * Hand-builds a `GateVerdict`-shaped object for the ONE case this module can
 * hit where no real `evaluateNeverRegressGate` call was even possible: a
 * total failure before a candidate scorecard could be obtained at all (the
 * ledger could not be opened, or `measure()` itself threw). This is NOT a
 * regression rule and NOT a re-implementation of `regression-gate.ts` — it
 * carries exactly one finding (`"engine-failure"`) describing WHY no real
 * evaluation happened, is always `decision:"block"` (never allow off the
 * back of a failure), and is never appended to the real `GateVerdictJournal`
 * (only verdicts produced by `evaluateNeverRegressGate` over a real,
 * durably-recorded candidate are). `policyHash` is still the REAL
 * `policyHash()` from `./regression-gate` — never re-derived here.
 */
function buildEngineFailureVerdict(
  reason: string,
  candidateSha: string,
  evaluatedAtMs: number,
  policy: NeverRegressPolicy,
): GateVerdict {
  const finding: GateFinding = {
    rule: "engine-failure",
    severity: "block",
    message: reason,
    observed: 1,
    threshold: 0,
    taskId: null,
    waived: false,
    waiverReason: null,
  };
  const draft: Omit<GateVerdict, "contentHash"> = {
    version: EVAL_GATE_VERSION,
    decision: "block",
    evaluatedAtMs,
    candidateSha,
    candidateScorecardId: "",
    baselineSha: null,
    baselineScorecardId: null,
    baselineStrategy: null,
    policyHash: policyHash(policy),
    findings: [finding],
    delta: null,
    summary: `BLOCK: engine failure -- ${reason}`,
  };
  const contentHash = sha256Hex(
    `hades.eval.continuous.engine-failure.v${EVAL_CONTINUOUS_VERSION}:${JSON.stringify(draft)}`,
  );
  return { ...draft, contentHash };
}

function defaultBaselineSelector(revision: ScorecardRevision): BaselineSelector {
  // "rolling-median" over the WHOLE recorded pool (no window cap) is the
  // robust default for a never-regress gate: unlike "latest", a single bad
  // revision immediately preceding the candidate cannot poison the baseline
  // by itself -- the median stays anchored to the honest historical center
  // as long as regressions are the minority of recorded runs. `excludeSha`
  // guards the (otherwise-degenerate) case where the candidate's own sha is
  // already present in the pool (e.g. a re-measurement).
  return { strategy: "rolling-median", excludeSha: revision.sha, excludeDirty: true };
}

function safeEntries(
  ledger: EvalHistoryLedger,
  emit: (kind: ContinuousEventKind, message: string) => void,
): EvalHistoryEntry[] {
  try {
    return ledger.entries();
  } catch (err) {
    emit("error", `ledger.entries() failed: ${describeErr(err)}`);
    return [];
  }
}

function safeVerifyChain(
  ledger: EvalHistoryLedger,
  emit: (kind: ContinuousEventKind, message: string) => void,
): HistoryChainVerification {
  try {
    const chain = ledger.verifyChain();
    if (!chain.ok) {
      emit(
        "error",
        `history chain verification failed: ${chain.reason ?? "unknown"} (brokenAtSeq=${String(chain.brokenAtSeq)})`,
      );
    }
    return chain;
  } catch (err) {
    const message = `ledger.verifyChain() threw: ${describeErr(err)}`;
    emit("error", message);
    return emptyChain(message);
  }
}

// ===========================================================================
// runContinuousEval
// ===========================================================================

export async function runContinuousEval(opts: ContinuousEvalOptions): Promise<ContinuousEvalResult> {
  // The one class of failure this module lets propagate: a genuinely invalid
  // `root`, checked before any I/O -- a programmer error, not an
  // operational one.
  if (typeof opts.root !== "string" || opts.root.length === 0) {
    throw new RangeError("ContinuousEvalOptions.root must be a non-empty path");
  }

  const nowFn = opts.now ?? Date.now;
  const startedAtMs = nowFn();
  const events: ContinuousEvent[] = [];

  const emit = (
    kind: ContinuousEventKind,
    message: string,
    extra?: { sha?: string; decision?: GateDecision; detail?: Record<string, string | number | boolean | null> },
  ): void => {
    const ev: ContinuousEvent = { kind, atMs: nowFn(), message };
    if (extra?.sha !== undefined) ev.sha = extra.sha;
    if (extra?.decision !== undefined) ev.decision = extra.decision;
    if (extra?.detail !== undefined) ev.detail = extra.detail;
    events.push(ev);
    if (opts.onEvent !== undefined) {
      try {
        opts.onEvent(ev);
      } catch {
        // onEvent throwing must never break the run.
      }
    }
  };

  const record = opts.record ?? true;
  const bisectOnBlock = opts.bisectOnBlock ?? false;
  const skipIfRecorded = opts.skipIfRecorded ?? false;

  // -------------------------------------------------------------------
  // 1. Resolve revision. The real `resolveRevision` never throws (see its
  //    own module docs); an injected `resolve` that throws is a caller bug,
  //    not an operational failure enumerated for containment, so it is left
  //    to propagate rather than silently swallowed into a fake revision.
  // -------------------------------------------------------------------
  const resolveFn = opts.resolve ?? ((): ScorecardRevision => resolveRevision({ cwd: opts.root }));
  const revision = resolveFn();
  emit(
    "revision-resolved",
    `resolved revision ${revision.shortSha}${revision.dirty ? "-dirty" : ""} (${revision.source}, branch=${revision.branch ?? "(none)"})`,
    { sha: revision.sha },
  );

  const buildFailureResult = (
    reason: string,
    ledgerForRead: EvalHistoryLedger | null,
    policyForVerdict: NeverRegressPolicy,
  ): ContinuousEvalResult => {
    let entriesSnapshot: EvalHistoryEntry[] = [];
    let chain: HistoryChainVerification = emptyChain("ledger unavailable");
    if (ledgerForRead !== null) {
      entriesSnapshot = safeEntries(ledgerForRead, emit);
      chain = safeVerifyChain(ledgerForRead, emit);
    }
    let baseline: BaselineSelection;
    try {
      baseline = selectBaseline(entriesSnapshot, defaultBaselineSelector(revision));
    } catch (err) {
      emit("error", `selectBaseline threw during failure containment: ${describeErr(err)}`);
      baseline = {
        ok: false,
        entry: null,
        pool: [],
        strategy: "rolling-median",
        vtphReference: Number.NaN,
        verifiedCorrectReference: Number.NaN,
        silentWrongReference: Number.NaN,
        silentWrongRateReference: Number.NaN,
        reason: `selectBaseline threw: ${describeErr(err)}`,
      };
    }
    let trend: TrendPoint[] = [];
    try {
      trend = vtphSeries(entriesSnapshot);
    } catch {
      trend = [];
    }
    const changepoint = detectChangepoint(trend);
    const evaluatedAtMs = nowFn();
    const verdict = buildEngineFailureVerdict(reason, revision.sha, evaluatedAtMs, policyForVerdict);
    emit("error", `runContinuousEval containing a total failure: ${reason}`, { sha: revision.sha, decision: verdict.decision });
    return {
      version: EVAL_CONTINUOUS_VERSION,
      revision,
      scorecard: null,
      entry: null,
      recorded: false,
      skipped: false,
      skippedReason: null,
      baseline,
      verdict,
      bisect: null,
      trend,
      changepoint,
      chain,
      events,
      startedAtMs,
      durationMs: nowFn() - startedAtMs,
    };
  };

  // -------------------------------------------------------------------
  // 2. Open the ledger.
  // -------------------------------------------------------------------
  let ledger: EvalHistoryLedger;
  try {
    ledger = opts.ledger ?? new EvalHistoryLedger({ root: opts.root, now: nowFn });
  } catch (err) {
    emit("error", `failed to open eval history ledger at "${opts.root}": ${describeErr(err)}`);
    return buildFailureResult(
      `could not open eval history ledger: ${describeErr(err)}`,
      null,
      opts.policy ?? DEFAULT_NEVER_REGRESS_POLICY,
    );
  }

  // -------------------------------------------------------------------
  // 3. Load policy (real `loadPolicy` is itself fail-closed and never
  //    throws -- an unreadable/malformed policy file degrades to the strict
  //    default with a warning, not an exception; that degradation is still
  //    surfaced here as a contained "error" event per the containment bar).
  // -------------------------------------------------------------------
  let policy: NeverRegressPolicy;
  if (opts.policy !== undefined) {
    policy = opts.policy;
  } else {
    try {
      const loaded = loadPolicy(opts.root);
      policy = loaded.policy;
      if (loaded.source === "default" && loaded.warnings.length > 0) {
        emit(
          "error",
          `gate policy file at "${join(opts.root, "gate-policy.json")}" could not be used: ${loaded.warnings.join(" | ")}`,
        );
      }
    } catch (err) {
      emit("error", `loadPolicy threw unexpectedly: ${describeErr(err)}`);
      policy = DEFAULT_NEVER_REGRESS_POLICY;
    }
  }

  // -------------------------------------------------------------------
  // 4. Snapshot entries BEFORE any append -- both the dedupe check and the
  //    baseline selection read this snapshot, so the candidate can never
  //    select itself as its own baseline.
  // -------------------------------------------------------------------
  const entriesBeforeAppend = safeEntries(ledger, emit);

  // -------------------------------------------------------------------
  // 5. skipIfRecorded dedupe check. A dirty worktree is NEVER eligible for
  //    dedupe -- see module docs.
  // -------------------------------------------------------------------
  let scorecard: EvalScorecard | null = null;
  let entry: EvalHistoryEntry | null = null;
  let recorded = false;
  let skipped = false;
  let skippedReason: string | null = null;

  if (skipIfRecorded && revision.dirty !== true) {
    const priorForSha = entriesBeforeAppend.filter((e) => e.sha === revision.sha);
    if (priorForSha.length > 0 && entriesBeforeAppend.length > 0) {
      // "current suite/mode" convention mirrors `selectBaseline`'s own
      // suite-inference rule: the most recently recorded entry in the whole
      // ledger defines what "current" means, since this module has no way
      // to know the active suite/mode ahead of an actual measurement
      // without invoking `measure()` (which is exactly what dedupe exists
      // to avoid).
      const mostRecent = entriesBeforeAppend[entriesBeforeAppend.length - 1];
      const match = priorForSha.filter((e) => e.suiteHash === mostRecent.suiteHash && e.mode === mostRecent.mode);
      if (match.length > 0) {
        const existing = match[match.length - 1];
        skipped = true;
        skippedReason = `revision ${revision.shortSha} already recorded at seq ${existing.seq} for suiteHash=${existing.suiteHash.slice(0, 12)} mode=${existing.mode}`;
        scorecard = existing.scorecard;
        entry = existing;
        emit("duplicate-skipped", skippedReason, { sha: revision.sha });
      }
    }
  }

  // -------------------------------------------------------------------
  // 6. Measure (unless skipped).
  // -------------------------------------------------------------------
  if (!skipped) {
    emit("measure-started", `measuring revision ${revision.shortSha}${revision.dirty ? "-dirty" : ""}...`, {
      sha: revision.sha,
    });
    const measureFn =
      opts.measure ??
      (async (rev: ScorecardRevision): Promise<EvalScorecard> => {
        const def = defaultMeasureRunner();
        return runEvalMeasurement({
          revision: rev,
          runner: def.runner,
          runnerLabel: def.label,
          mode: def.mode,
          label: opts.label,
          now: opts.now,
        });
      });
    try {
      const measured = await measureFn(revision);
      if (measured === null || measured === undefined || typeof measured !== "object") {
        throw new Error(`measure() returned a non-scorecard value: ${describeErr(measured)}`);
      }
      scorecard = measured;
      emit(
        "measure-finished",
        `measured revision ${revision.shortSha}: verifiedCorrect=${scorecard.throughput.verifiedCorrect} silentWrong=${scorecard.throughput.silentWrong} vtph=${scorecard.throughput.vtph.toFixed(4)}`,
        { sha: revision.sha },
      );
    } catch (err) {
      emit("error", `measure() threw: ${describeErr(err)}`);
      return buildFailureResult(`measure() failed: ${describeErr(err)}`, ledger, policy);
    }
  }

  // From here on `scorecard` is guaranteed non-null (either measured or
  // recovered from a skip match): `skipped` only becomes true after
  // populating `scorecard` from an existing entry, and the non-skipped
  // branch above either populates `scorecard` or returns early on failure.
  if (scorecard === null) {
    return buildFailureResult("internal invariant violated: no scorecard available after measure/skip", ledger, policy);
  }
  const candidate: EvalScorecard = scorecard;

  // -------------------------------------------------------------------
  // 7. Record (append to the ledger) unless dry-run or skipped.
  // -------------------------------------------------------------------
  let appendFailed = false;
  if (!skipped && record) {
    try {
      entry = ledger.append(candidate, { note: typeof opts.note === "string" ? opts.note : undefined });
      recorded = true;
      emit("recorded", `recorded scorecard as history entry seq=${entry.seq} hash=${entry.hash.slice(0, 12)}`, {
        sha: revision.sha,
      });
    } catch (err) {
      appendFailed = true;
      emit("error", `ledger.append() threw: ${describeErr(err)}`);
    }
  }

  // -------------------------------------------------------------------
  // 8. Chain integrity.
  // -------------------------------------------------------------------
  const chain = safeVerifyChain(ledger, emit);
  const chainOkForGate = chain.ok && !appendFailed;

  // -------------------------------------------------------------------
  // 9. Baseline selection, over the PRE-append snapshot.
  // -------------------------------------------------------------------
  const baselineSelector = opts.baseline ?? defaultBaselineSelector(revision);
  let baseline: BaselineSelection;
  try {
    baseline = selectBaseline(entriesBeforeAppend, baselineSelector);
  } catch (err) {
    emit("error", `selectBaseline threw: ${describeErr(err)}`);
    baseline = {
      ok: false,
      entry: null,
      pool: [],
      strategy: baselineSelector.strategy,
      vtphReference: Number.NaN,
      verifiedCorrectReference: Number.NaN,
      silentWrongReference: Number.NaN,
      silentWrongRateReference: Number.NaN,
      reason: `selectBaseline threw: ${describeErr(err)}`,
    };
  }
  emit(
    "baseline-selected",
    baseline.ok && baseline.entry !== null
      ? `baseline: sha=${baseline.entry.sha.slice(0, 12)} strategy=${baseline.strategy} (pool=${baseline.pool.length})`
      : `no usable baseline (strategy=${baseline.strategy}): ${baseline.reason ?? "unknown"}`,
    { sha: baseline.entry?.sha },
  );

  // -------------------------------------------------------------------
  // 10. Gate evaluation -- the real `evaluateNeverRegressGate`, never
  //     re-derived. Wrapped defensively even though the real function is
  //     documented total/fail-closed.
  // -------------------------------------------------------------------
  let verdict: GateVerdict;
  try {
    verdict = evaluateNeverRegressGate({
      candidate,
      baseline,
      policy,
      chainOk: chainOkForGate,
      now: nowFn,
    });
    emit("gate-evaluated", `gate decision: ${verdict.decision.toUpperCase()} -- ${verdict.summary}`, {
      sha: revision.sha,
      decision: verdict.decision,
    });
  } catch (err) {
    emit("error", `evaluateNeverRegressGate threw: ${describeErr(err)}`);
    verdict = buildEngineFailureVerdict(
      `evaluateNeverRegressGate threw: ${describeErr(err)}`,
      revision.sha,
      nowFn(),
      policy,
    );
  }

  // -------------------------------------------------------------------
  // 11. Journal the verdict -- ONLY for a run that durably recorded a NEW
  //     entry. A dry run, a skip, or a synthetic failure verdict never
  //     touches the journal.
  // -------------------------------------------------------------------
  if (record && recorded) {
    try {
      const journal = new GateVerdictJournal({ root: opts.root, now: nowFn });
      journal.append(verdict);
    } catch (err) {
      emit("error", `GateVerdictJournal.append() threw: ${describeErr(err)}`);
    }
  }

  // -------------------------------------------------------------------
  // 12. Auto-bisect on block.
  // -------------------------------------------------------------------
  let bisect: BisectReport | null = null;
  if (verdict.decision === "block" && bisectOnBlock) {
    emit("bisect-started", `gate blocked; starting auto-bisect for revision ${revision.shortSha}`, {
      sha: revision.sha,
    });
    try {
      const entriesForBisect =
        recorded && entry !== null && !entriesBeforeAppend.some((e) => e.hash === entry?.hash)
          ? [...entriesBeforeAppend, entry]
          : entriesBeforeAppend;
      if (!baseline.ok || baseline.entry === null) {
        throw new Error("no baseline scorecard available to build a bisect predicate");
      }
      const predicate = predicateFromBaseline(baseline.entry.scorecard, { metric: "verifiedCorrect" });
      const report = await autoBisect({
        entries: entriesForBisect,
        predicate,
        badSha: revision.sha,
        maxProbes: opts.bisectMaxProbes,
        requireSuiteMatch: true,
        suiteHash: candidate.suiteHash,
        skipDirty: true,
        now: nowFn,
      });
      bisect = report;
      emit(
        "bisect-finished",
        `bisect finished: ok=${report.ok} confidence=${report.confidence} culprit=${report.culpritShortSha ?? "(none)"} probes=${report.probeCount}`,
        {
          sha: revision.sha,
          detail: { confidence: report.confidence, culpritSha: report.culpritSha ?? "", probeCount: report.probeCount },
        },
      );
    } catch (err) {
      emit("error", `autoBisect threw: ${describeErr(err)}`);
      bisect = null;
    }
  }

  // -------------------------------------------------------------------
  // 13. Trend + changepoint over the post-append state, scoped to this
  //     candidate's suite/branch (T1's real `vtphSeries`/`detectChangepoint`).
  // -------------------------------------------------------------------
  const entriesAfter = safeEntries(ledger, emit);
  const trendOpts: TrendSeriesOptions = { suiteHash: candidate.suiteHash, branch: revision.branch };
  if (opts.trendLimit !== undefined) trendOpts.limit = opts.trendLimit;
  let trend: TrendPoint[];
  try {
    trend = vtphSeries(entriesAfter, trendOpts);
  } catch (err) {
    emit("error", `vtphSeries threw: ${describeErr(err)}`);
    trend = [];
  }
  const changepoint = detectChangepoint(trend);
  emit("trend-computed", `trend: ${trend.length} point(s); changepoint.detected=${changepoint.detected}`, {
    sha: revision.sha,
  });

  const durationMs = nowFn() - startedAtMs;

  return {
    version: EVAL_CONTINUOUS_VERSION,
    revision,
    scorecard: candidate,
    entry,
    recorded,
    skipped,
    skippedReason,
    baseline,
    verdict,
    bisect,
    trend,
    changepoint,
    chain,
    events,
    startedAtMs,
    durationMs,
  };
}

// ===========================================================================
// evalStatus — strictly read-only.
// ===========================================================================

export function evalStatus(opts: {
  root: string;
  ledger?: EvalHistoryLedger;
  branch?: string | null;
  baseline?: BaselineSelector;
  trendLimit?: number;
  now?: () => number;
}): EvalStatusReport {
  if (typeof opts.root !== "string" || opts.root.length === 0) {
    throw new RangeError("evalStatus: root must be a non-empty path");
  }
  const nowFn = opts.now ?? Date.now;
  const warnings: string[] = [];

  const historyPath = join(opts.root, "history.jsonl");
  const journalPath = join(opts.root, "gate-verdicts.jsonl");
  const historyExists = opts.ledger !== undefined || existsSync(historyPath);

  let entries: EvalHistoryEntry[] = [];
  let chain: HistoryChainVerification = { ok: true, entries: 0, brokenAtSeq: null, reason: null };

  if (historyExists) {
    // Never construct a fresh `EvalHistoryLedger` for a root that has no
    // history file yet -- the constructor's create-header-if-missing
    // behavior would be a write, which a strictly read-only status view
    // must never perform.
    const ledger = opts.ledger ?? new EvalHistoryLedger({ root: opts.root, now: nowFn });
    try {
      entries = ledger.entries();
    } catch (err) {
      warnings.push(`ledger.entries() failed: ${describeErr(err)}`);
      entries = [];
    }
    try {
      chain = ledger.verifyChain();
      if (!chain.ok) {
        warnings.push(`history chain verification failed: ${chain.reason ?? "unknown"} at seq ${String(chain.brokenAtSeq)}`);
      }
    } catch (err) {
      const message = `ledger.verifyChain() threw: ${describeErr(err)}`;
      warnings.push(message);
      chain = emptyChain(message);
    }
  } else {
    warnings.push(`no history.jsonl found at "${opts.root}" -- reporting an empty ledger without creating one`);
  }

  const scoped = opts.branch !== undefined ? entries.filter((e) => e.branch === opts.branch) : entries;
  const latest = scoped.length > 0 ? scoped[scoped.length - 1] : null;

  let latestVerdict: GateVerdict | null = null;
  if (latest !== null) {
    if (existsSync(journalPath)) {
      try {
        const journal = new GateVerdictJournal({ root: opts.root, now: nowFn });
        latestVerdict = journal.latest(latest.sha);
      } catch (err) {
        warnings.push(`GateVerdictJournal read failed: ${describeErr(err)}`);
        latestVerdict = null;
      }
    } else {
      warnings.push(`no gate-verdicts.jsonl found at "${opts.root}" -- latestVerdict is unavailable`);
    }
  }

  const baselineSelector: BaselineSelector =
    opts.baseline ??
    (opts.branch !== undefined
      ? { strategy: "rolling-median", branch: opts.branch, excludeDirty: true }
      : { strategy: "rolling-median", excludeDirty: true });
  let baseline: BaselineSelection;
  try {
    baseline = selectBaseline(entries, baselineSelector);
  } catch (err) {
    warnings.push(`selectBaseline threw: ${describeErr(err)}`);
    baseline = {
      ok: false,
      entry: null,
      pool: [],
      strategy: baselineSelector.strategy,
      vtphReference: Number.NaN,
      verifiedCorrectReference: Number.NaN,
      silentWrongReference: Number.NaN,
      silentWrongRateReference: Number.NaN,
      reason: `selectBaseline threw: ${describeErr(err)}`,
    };
  }

  const trendOpts: TrendSeriesOptions = {};
  if (opts.branch !== undefined) trendOpts.branch = opts.branch;
  if (latest !== null) trendOpts.suiteHash = latest.suiteHash;
  if (opts.trendLimit !== undefined) trendOpts.limit = opts.trendLimit;
  let trend: TrendPoint[] = [];
  try {
    trend = vtphSeries(entries, trendOpts);
  } catch (err) {
    warnings.push(`vtphSeries threw: ${describeErr(err)}`);
    trend = [];
  }
  const changepoint = detectChangepoint(trend);

  let policy: NeverRegressPolicy;
  let policySource: "file" | "default";
  try {
    const loaded = loadPolicy(opts.root);
    policy = loaded.policy;
    policySource = loaded.source;
    if (loaded.source === "default" && loaded.warnings.length > 0) {
      warnings.push(...loaded.warnings);
    }
  } catch (err) {
    warnings.push(`loadPolicy threw unexpectedly: ${describeErr(err)}`);
    policy = DEFAULT_NEVER_REGRESS_POLICY;
    policySource = "default";
  }

  return {
    version: EVAL_CONTINUOUS_VERSION,
    root: opts.root,
    entries: entries.length,
    chain,
    latest,
    latestVerdict,
    baseline,
    trend,
    changepoint,
    policyHash: policyHash(policy),
    policySource,
    warnings,
  };
}

// ===========================================================================
// Reporting -- aligned ASCII text, CLI/TUI-ready. No HTML, no web output.
// ===========================================================================

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function formatChainLine(label: string, chain: HistoryChainVerification): string {
  return chain.ok
    ? `${label} : true (${chain.entries} entries)`
    : `${label} : false (broken at seq ${String(chain.brokenAtSeq)}: ${chain.reason ?? "unknown"})`;
}

/** Local, self-contained aligned formatter for a `GateVerdict` -- mirrors
 *  `regression-gate.ts`'s own `formatGateVerdict`, kept local (rather than
 *  imported) since `GateVerdict.findings`/`.summary` are already fully
 *  self-describing data this module owns rendering of at its own
 *  aggregate-result granularity (alongside bisect/trend/events in one
 *  report), and the locked import list for this module does not include a
 *  formatter symbol from `./regression-gate`. */
function formatVerdictSection(v: GateVerdict): string[] {
  const lines: string[] = [];
  lines.push(`  decision    : ${v.decision.toUpperCase()}`);
  lines.push(`  summary     : ${v.summary}`);
  lines.push(`  baselineSha : ${v.baselineSha ?? "(none)"}`);
  lines.push(`  policyHash  : ${v.policyHash}`);
  if (v.findings.length === 0) {
    lines.push("  findings    : (none)");
  } else {
    lines.push(`  findings (${v.findings.length}):`);
    for (const f of v.findings) {
      lines.push(`    [${f.severity.toUpperCase().padEnd(5)}] ${f.rule}${f.taskId !== null ? `:${f.taskId}` : ""} -- ${f.message}`);
    }
  }
  return lines;
}

function formatBisectSection(r: BisectReport): string[] {
  const lines: string[] = [];
  lines.push(`  ok          : ${r.ok}`);
  lines.push(`  confidence  : ${r.confidence}`);
  lines.push(`  culpritSha  : ${r.culpritSha ?? "(none)"}`);
  lines.push(`  lastGoodSha : ${r.lastGoodSha ?? "(none)"}`);
  lines.push(`  probeCount  : ${r.probeCount}`);
  lines.push(`  orderSource : ${r.orderSource}`);
  if (r.reason !== null) lines.push(`  reason      : ${r.reason}`);
  return lines;
}

function formatTrendSection(points: readonly TrendPoint[], cp: ChangepointReport): string[] {
  const lines: string[] = [];
  if (points.length === 0) {
    lines.push("  (no trend data)");
  } else {
    const headers = ["SEQ", "SHA", "VTPH", "SILENT-WRONG"];
    const rows = points.map((p) => [String(p.seq), p.shortSha, p.vtph.toFixed(4), String(p.silentWrong)]);
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    lines.push("  " + headers.map((h, i) => padRight(h, widths[i])).join("  "));
    for (const r of rows) lines.push("  " + r.map((c, i) => padRight(c, widths[i])).join("  "));
  }
  lines.push(`  changepoint : detected=${cp.detected}${cp.detected ? ` atSha=${cp.atSha ?? "?"} drift=${cp.drift.toFixed(4)}` : ""}`);
  return lines;
}

export function formatContinuousResult(r: ContinuousEvalResult): string[] {
  const lines: string[] = [];
  lines.push("HADES CONTINUOUS EVAL");
  lines.push("=".repeat(72));
  lines.push(`revision       : ${r.revision.shortSha}${r.revision.dirty ? "-dirty" : ""} (${r.revision.source})`);
  lines.push(`branch         : ${r.revision.branch ?? "(none)"}`);
  lines.push(`recorded       : ${r.recorded}`);
  lines.push(`skipped        : ${r.skipped}${r.skippedReason !== null ? ` -- ${r.skippedReason}` : ""}`);
  lines.push(`entry seq      : ${r.entry !== null ? r.entry.seq : "(none)"}`);
  lines.push(formatChainLine("chain ok      ", r.chain));
  lines.push(`durationMs     : ${r.durationMs}`);
  lines.push("");

  lines.push("GATE VERDICT");
  lines.push(...formatVerdictSection(r.verdict));
  lines.push("");

  if (r.bisect !== null) {
    lines.push("BISECT");
    lines.push(...formatBisectSection(r.bisect));
    lines.push("");
  }

  lines.push("TREND");
  lines.push(...formatTrendSection(r.trend, r.changepoint));
  lines.push("");

  lines.push(`EVENTS (${r.events.length})`);
  for (const e of r.events) {
    lines.push(`  [${e.atMs}] ${padRight(e.kind, 18)} ${e.message}`);
  }

  return lines;
}

export function formatEvalStatus(s: EvalStatusReport): string[] {
  const lines: string[] = [];
  lines.push("HADES EVAL STATUS");
  lines.push("=".repeat(72));
  lines.push(`root           : ${s.root}`);
  lines.push(`entries        : ${s.entries}`);
  lines.push(formatChainLine("chain ok      ", s.chain));
  lines.push(`policyHash     : ${s.policyHash}`);
  lines.push(`policySource   : ${s.policySource}`);
  lines.push("");

  lines.push("LATEST ENTRY");
  lines.push(
    s.latest === null
      ? "  (none)"
      : `  seq=${s.latest.seq} sha=${s.latest.sha.slice(0, 12)} branch=${s.latest.branch ?? "(none)"} mode=${s.latest.mode}`,
  );
  lines.push("");

  lines.push("LATEST VERDICT");
  lines.push(...(s.latestVerdict !== null ? formatVerdictSection(s.latestVerdict) : ["  (none)"]));
  lines.push("");

  lines.push("TREND");
  lines.push(...formatTrendSection(s.trend, s.changepoint));

  if (s.warnings.length > 0) {
    lines.push("");
    lines.push(`WARNINGS (${s.warnings.length})`);
    for (const w of s.warnings) lines.push(`  - ${w}`);
  }

  return lines;
}
