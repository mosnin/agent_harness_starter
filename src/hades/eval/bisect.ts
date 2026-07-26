/**
 * bisect.ts — auto-bisect: localize a regression to the offending revision.
 *
 * Given a caller-supplied {@link RegressionPredicate} and the recorded eval
 * history (`EvalHistoryEntry[]`), {@link autoBisect} finds the FIRST revision
 * (in git-topological order) whose scorecard fails the predicate, in
 * O(log n) probes over the ordered chain of KNOWN revisions — never a linear
 * scan. "Known" revisions are every distinct sha that either has a recorded
 * `EvalHistoryEntry` or was named explicitly as `goodSha`/`badSha`; this
 * module has no way to enumerate git commits it was never told about, so it
 * bisects honestly over the universe it actually knows, and says so.
 *
 * Two operating modes, driven purely by whether `req.measure` is supplied:
 *
 *  - `"history-only"`: every probe must resolve from an already-recorded,
 *    `verifyScorecard`-clean `EvalHistoryEntry`. A known sha with no usable
 *    recorded scorecard (never measured, tampered, wrong suite) is a real
 *    GAP — the search cannot cross it, so the result is `"bracketed"`
 *    around the tightest real bracket it could establish.
 *  - `"active"`: the same resolution is attempted first; on a miss, the
 *    injected `measure(sha)` re-measures that SAME known sha for real. A
 *    `measure` that throws, returns `null`, or returns a scorecard for the
 *    wrong sha is treated exactly like a history miss (recorded in
 *    `skipped`, search degrades honestly) — it never corrupts the search.
 *    Filling a gap this way is what can promote `"bracketed"` to `"exact"`.
 *
 * Honesty rules (mirrored from `scorecard.ts`/`compare.ts`):
 *  - `"exact"` ONLY when the culprit and its immediate predecessor are
 *    ADJACENT positions in the resolved chain and BOTH were really
 *    evaluated (a real history entry or a real `measure()` result, never an
 *    assumption).
 *  - A cheap, additional monotonicity check (over already-loaded `entries`
 *    data — no extra probes, so it never affects the O(log n) probe bound)
 *    downgrades a clean-looking bisection to `"ambiguous"` whenever the
 *    known data contradicts the "good below, bad at/above" invariant a
 *    single-culprit bisection assumes — a flaky signal or multiple
 *    regressions never gets blamed on one innocent revision.
 *  - `orderSource` is always honestly reported: `"git"` only when the
 *    resolved order actually came from (or was validated against) real git
 *    ancestry; otherwise `"recorded-time"`, and the report says so instead
 *    of presenting a time-ordered guess as a git-topological fact.
 *
 * Import policy (locked): `./scorecard` (types + `verifyScorecard`),
 * `./history` (the `EvalHistoryEntry` type), `./revision` (`revisionOrder`,
 * `isAncestor`), `./compare` (`compareScorecards`, reused verbatim for
 * `flippedTaskIds` — never reimplemented here), `../styx/certificate`
 * (`sha256Hex`). Never `./measure` (the re-measure port is injected by the
 * caller), `./regression-gate`, `./continuous`, or any CLI module.
 */

import { verifyScorecard, type EvalScorecard } from "./scorecard";
import type { EvalHistoryEntry } from "./history";
import { revisionOrder, isAncestor } from "./revision";
import { compareScorecards } from "./compare";
import { sha256Hex } from "../styx/certificate";

// ===========================================================================
// Locked public surface — version, predicate
// ===========================================================================

export const EVAL_BISECT_VERSION = 1;

export interface PredicateVerdict {
  good: boolean;
  value: number;
  metric: string;
  reason: string | null;
}

export type RegressionPredicate = (sc: EvalScorecard) => PredicateVerdict;

function throughputSilentWrongRate(sc: EvalScorecard): number {
  const t = sc.throughput;
  return t.tasks > 0 ? t.silentWrong / t.tasks : Number.NaN;
}

export function verifiedThroughputPredicate(opts: {
  metric?: "verifiedCorrect" | "vtph";
  floor: number;
}): RegressionPredicate {
  const metric = opts.metric ?? "verifiedCorrect";
  return (sc: EvalScorecard): PredicateVerdict => {
    const value = metric === "vtph" ? sc.throughput.vtph : sc.throughput.verifiedCorrect;
    const good = !Number.isNaN(value) && value >= opts.floor;
    return {
      good,
      value,
      metric,
      reason: good ? null : `${metric}=${String(value)} is below the required floor ${opts.floor}`,
    };
  };
}

export function silentWrongPredicate(opts: {
  metric?: "silentWrong" | "silentWrongRate";
  ceiling: number;
}): RegressionPredicate {
  const metric = opts.metric ?? "silentWrong";
  return (sc: EvalScorecard): PredicateVerdict => {
    const value = metric === "silentWrongRate" ? throughputSilentWrongRate(sc) : sc.throughput.silentWrong;
    const good = !Number.isNaN(value) && value <= opts.ceiling;
    return {
      good,
      value,
      metric,
      reason: good ? null : `${metric}=${String(value)} exceeds the allowed ceiling ${opts.ceiling}`,
    };
  };
}

export function taskRegressionPredicate(taskId: string): RegressionPredicate {
  const metric = `task:${taskId}`;
  return (sc: EvalScorecard): PredicateVerdict => {
    const outcome = sc.outcomes.find((o) => o.taskId === taskId);
    if (outcome === undefined) {
      return { good: true, value: Number.NaN, metric, reason: `task "${taskId}" is not present in this scorecard's suite` };
    }
    const good = outcome.kind === "verified-correct";
    return {
      good,
      value: good ? 1 : 0,
      metric,
      reason: good ? null : `task "${taskId}" outcome is "${outcome.kind}" (not verified-correct)`,
    };
  };
}

type BaselineMetric = "verifiedCorrect" | "vtph" | "silentWrong" | "silentWrongRate";

function metricValueOf(sc: EvalScorecard, metric: BaselineMetric): number {
  switch (metric) {
    case "verifiedCorrect":
      return sc.throughput.verifiedCorrect;
    case "vtph":
      return sc.throughput.vtph;
    case "silentWrong":
      return sc.throughput.silentWrong;
    case "silentWrongRate":
      return throughputSilentWrongRate(sc);
    default: {
      const exhaustive: never = metric;
      throw new TypeError(`predicateFromBaseline: unknown metric "${String(exhaustive)}"`);
    }
  }
}

function higherIsBetter(metric: BaselineMetric): boolean {
  return metric === "verifiedCorrect" || metric === "vtph";
}

export function predicateFromBaseline(
  baseline: EvalScorecard,
  opts?: { metric?: BaselineMetric; tolerance?: number },
): RegressionPredicate {
  const metric = opts?.metric ?? "verifiedCorrect";
  const tolerance = opts?.tolerance ?? 0;
  const baselineValue = metricValueOf(baseline, metric);
  const better = higherIsBetter(metric);
  return (sc: EvalScorecard): PredicateVerdict => {
    const value = metricValueOf(sc, metric);
    let good: boolean;
    if (Number.isNaN(value) || Number.isNaN(baselineValue)) {
      good = false;
    } else if (better) {
      good = value >= baselineValue - tolerance;
    } else {
      good = value <= baselineValue + tolerance;
    }
    return {
      good,
      value,
      metric,
      reason: good
        ? null
        : `${metric}=${String(value)} vs baseline ${String(baselineValue)} exceeds tolerance ${tolerance}`,
    };
  };
}

// ===========================================================================
// Locked public surface — bisect request/report
// ===========================================================================

export type BisectMode = "history-only" | "active";
export type BisectConfidence = "exact" | "bracketed" | "ambiguous" | "none";

export interface BisectProbe {
  sha: string;
  shortSha: string;
  orderIndex: number;
  source: "history" | "measured";
  good: boolean;
  value: number;
  metric: string;
  scorecardId: string;
  probedAtMs: number;
  note: string | null;
}

export interface BisectRequest {
  entries: readonly EvalHistoryEntry[];
  predicate: RegressionPredicate;
  goodSha?: string;
  badSha?: string;
  order?: (shas: readonly string[]) => string[];
  measure?: (sha: string) => Promise<EvalScorecard | null>;
  maxProbes?: number;
  requireSuiteMatch?: boolean;
  suiteHash?: string;
  skipDirty?: boolean;
  now?: () => number;
}

export interface BisectReport {
  version: number;
  ok: boolean;
  mode: BisectMode;
  confidence: BisectConfidence;
  culpritSha: string | null;
  culpritShortSha: string | null;
  culpritEntry: EvalHistoryEntry | null;
  lastGoodSha: string | null;
  firstBadOrderIndex: number | null;
  probes: BisectProbe[];
  probeCount: number;
  candidatesConsidered: number;
  skipped: Array<{ sha: string; reason: string }>;
  flippedTaskIds: string[];
  metric: string;
  orderSource: "git" | "recorded-time";
  reason: string | null;
  startedAtMs: number;
  durationMs: number;
  contentHash: string;
}

// ===========================================================================
// Canonicalization + hashing (mirrors scorecard.ts's approach; self-contained
// here since it is a fully generic recursive stringifier, not scorecard-
// specific, and this module deliberately does not import it).
// ===========================================================================

function formatNumber(n: number): string {
  if (n === Number.POSITIVE_INFINITY) return '"Infinity"';
  if (n === Number.NEGATIVE_INFINITY) return '"-Infinity"';
  if (Number.isNaN(n)) return '"NaN"';
  const normalized = Object.is(n, -0) ? 0 : n;
  if (Number.isInteger(normalized) && Math.abs(normalized) < Number.MAX_SAFE_INTEGER) {
    return String(normalized);
  }
  const fixed = Number(normalized.toPrecision(12));
  return String(Object.is(fixed, -0) ? 0 : fixed);
}

function stableStringifyValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringifyValue(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringifyValue(obj[k])).join(",") + "}";
  }
  throw new TypeError(`canonicalizeBisectReport: unserializable value of type ${typeof value}`);
}

function canonicalizeReport(r: BisectReport): string {
  const normalized: BisectReport = {
    ...r,
    probes: [...r.probes],
    skipped: r.skipped.map((s) => ({ ...s })),
    flippedTaskIds: [...r.flippedTaskIds],
    contentHash: "",
  };
  return stableStringifyValue(normalized);
}

function reportHash(r: BisectReport): string {
  return sha256Hex(canonicalizeReport(r));
}

function sealReport(r: Omit<BisectReport, "contentHash">): BisectReport {
  const draft: BisectReport = { ...r, contentHash: "" };
  return { ...draft, contentHash: reportHash(draft) };
}

/**
 * Independently verifies a {@link BisectReport}'s internal consistency.
 * Checks run from most specific to most global, each with its own reason:
 *
 *  1. unsupported `version`.
 *  2. `probeCount` disagreeing with `probes.length` (an added/removed probe).
 *  3. a claimed `culpritSha` that is not actually present in `probes` as a
 *     BAD probe (a swapped culprit), or whose `orderIndex` disagrees with
 *     `firstBadOrderIndex`.
 *  4. a claimed `lastGoodSha` that is not actually present in `probes` as a
 *     GOOD probe, or (when `confidence === "exact"`) is not literally
 *     adjacent (`orderIndex` one less) to the culprit's probe.
 *  5. a `contentHash` that does not match the recomputed hash — the
 *     catch-all for any tampering not already caught above.
 */
export function verifyBisectReport(r: BisectReport): { ok: boolean; reason: string | null } {
  if (r.version !== EVAL_BISECT_VERSION) {
    return { ok: false, reason: `unsupported-version:${String(r.version)}` };
  }
  if (r.probeCount !== r.probes.length) {
    return { ok: false, reason: "probe-count-mismatch" };
  }

  if (r.ok && r.culpritSha !== null) {
    const culpritProbe = r.probes.find((p) => p.sha === r.culpritSha);
    if (culpritProbe === undefined) {
      return { ok: false, reason: "culprit-not-probed" };
    }
    if (culpritProbe.good !== false) {
      return { ok: false, reason: "culprit-probe-not-bad" };
    }
    if (r.firstBadOrderIndex !== null && culpritProbe.orderIndex !== r.firstBadOrderIndex) {
      return { ok: false, reason: "culprit-order-index-mismatch" };
    }
    if (r.lastGoodSha !== null) {
      const goodProbe = r.probes.find((p) => p.sha === r.lastGoodSha);
      if (goodProbe === undefined) {
        return { ok: false, reason: "last-good-not-probed" };
      }
      if (goodProbe.good !== true) {
        return { ok: false, reason: "last-good-probe-not-good" };
      }
      if (r.confidence === "exact" && goodProbe.orderIndex !== culpritProbe.orderIndex - 1) {
        return { ok: false, reason: "exact-confidence-not-adjacent" };
      }
    } else if (r.confidence === "exact") {
      return { ok: false, reason: "exact-confidence-without-last-good" };
    }
  }

  const expectedHash = reportHash(r);
  if (expectedHash !== r.contentHash) {
    return { ok: false, reason: "content-hash-mismatch" };
  }

  return { ok: true, reason: null };
}

// ===========================================================================
// Chain ordering
// ===========================================================================

function isPermutationOf(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((v, i) => v === bs[i]);
}

function recordedTimeOrder(shas: readonly string[], shaToEntries: Map<string, EvalHistoryEntry[]>): string[] {
  const timeOf = (sha: string): number => {
    const list = shaToEntries.get(sha);
    if (list === undefined || list.length === 0) return Number.POSITIVE_INFINITY;
    return Math.min(...list.map((e) => e.recordedAtMs));
  };
  const withOriginalIndex = shas.map((sha, i) => ({ sha, i, t: timeOf(sha) }));
  withOriginalIndex.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.i - b.i));
  return withOriginalIndex.map((x) => x.sha);
}

/**
 * Resolves the ordered chain for `candidateShas`, ALWAYS ascending
 * (earliest/oldest revision first, most recent last) — the convention this
 * whole module relies on for its default `goodSha`/`badSha` endpoints and
 * for "does bad precede good" validation. A caller-supplied `reqOrder` is
 * trusted verbatim, in whatever order it returns (and labelled `"git"`), as
 * long as it returns a genuine permutation of the input — the caller owns
 * both the ordering and its direction. The DEFAULT path, however, calls the
 * real `revisionOrder`, which wraps `git rev-list --topo-order` — and
 * `rev-list` walks from a tip toward its ancestors, so its raw output is
 * NEWEST-first. That raw order is reversed here before use, so the default
 * path's output is ascending exactly like every other path's.
 *
 * The default git path is trusted only when at least two candidates are
 * independently confirmed as real, resolvable git commits
 * (`isAncestor(sha, sha)`, which git only accepts for a real revision).
 * Anything less reliable — git absent, a hostile order function, or fewer
 * than two recognizable commits among the candidates — degrades honestly to
 * `recordedAtMs` ordering, labelled `"recorded-time"`.
 */
function resolveChainOrder(
  candidateShas: readonly string[],
  shaToEntries: Map<string, EvalHistoryEntry[]>,
  reqOrder: ((shas: readonly string[]) => string[]) | undefined,
): { ordered: string[]; source: "git" | "recorded-time" } {
  if (reqOrder !== undefined) {
    let out: string[];
    try {
      out = reqOrder(candidateShas);
    } catch {
      out = [];
    }
    if (isPermutationOf(out, candidateShas)) {
      return { ordered: out, source: "git" };
    }
    // Hostile/garbage order function -- fall through to the default path.
  }

  let gitRecognized = 0;
  for (const sha of candidateShas) {
    if (isAncestor(sha, sha)) gitRecognized += 1;
    if (gitRecognized >= 2) break;
  }
  if (gitRecognized >= 2) {
    let out: string[] = [];
    try {
      // git rev-list --topo-order walks from a tip toward its ancestors, so
      // its raw output is newest-first -- reverse to this module's ascending
      // (oldest-first) convention.
      out = revisionOrder(candidateShas).reverse();
    } catch {
      out = [];
    }
    if (isPermutationOf(out, candidateShas)) {
      return { ordered: out, source: "git" };
    }
  }

  return { ordered: recordedTimeOrder(candidateShas, shaToEntries), source: "recorded-time" };
}

// ===========================================================================
// History resolution
// ===========================================================================

function chooseHistoryEntry(
  sha: string,
  shaToEntries: Map<string, EvalHistoryEntry[]>,
  skipDirty: boolean,
  predicate: RegressionPredicate,
  pushSkip: (sha: string, reason: string) => void,
): { entry: EvalHistoryEntry; note: string | null } | null {
  const list = shaToEntries.get(sha);
  if (list === undefined || list.length === 0) return null;

  const bySeqDesc = [...list].sort((a, b) => b.seq - a.seq);
  const chosen = bySeqDesc[0];

  const verify = verifyScorecard(chosen.scorecard);
  if (!verify.ok) {
    pushSkip(sha, `tampered-scorecard:${verify.reason ?? "unknown"}`);
    return null;
  }
  if (skipDirty && chosen.scorecard.revision.dirty === true) {
    pushSkip(sha, "dirty-worktree");
    return null;
  }

  let note: string | null = null;
  if (list.length > 1) {
    const verdicts = list.map((e) => predicate(e.scorecard).good);
    const allSame = verdicts.every((v) => v === verdicts[0]);
    note = allSame
      ? `${list.length} recorded runs at this sha; using the most recent (seq ${chosen.seq})`
      : `${list.length} recorded runs at this sha with DIFFERING verdicts (flaky) -- using the most recent (seq ${chosen.seq}) rather than averaging`;
  }
  return { entry: chosen, note };
}

interface KnownRep {
  sha: string;
  idx: number;
  good: boolean;
}

function collectKnownReps(
  shaToEntries: Map<string, EvalHistoryEntry[]>,
  indexOf: Map<string, number>,
  predicate: RegressionPredicate,
  skipDirty: boolean,
): KnownRep[] {
  const noop = (): void => {
    /* the monotonicity scan must not double-report skips already recorded by resolveProbe */
  };
  const reps: KnownRep[] = [];
  for (const sha of shaToEntries.keys()) {
    const idx = indexOf.get(sha);
    if (idx === undefined) continue;
    const chosen = chooseHistoryEntry(sha, shaToEntries, skipDirty, predicate, noop);
    if (chosen === null) continue;
    reps.push({ sha, idx, good: predicate(chosen.entry.scorecard).good });
  }
  reps.sort((a, b) => a.idx - b.idx);
  return reps;
}

function scanMonotonicityViolation(reps: readonly KnownRep[], goodIdx: number | null, badIdx: number | null): string | null {
  for (const r of reps) {
    if (goodIdx !== null && r.idx <= goodIdx && !r.good) {
      return `non-monotone signal: revision at chain position ${r.idx} (sha ${r.sha.slice(0, 12)}) is BAD, at or before position ${goodIdx} which was assumed GOOD`;
    }
    if (badIdx !== null && r.idx >= badIdx && r.good) {
      return `non-monotone signal: revision at chain position ${r.idx} (sha ${r.sha.slice(0, 12)}) is GOOD, at or after position ${badIdx} which was assumed BAD (the culprit)`;
    }
  }
  return null;
}

function findEarliestTransition(
  reps: readonly KnownRep[],
): { lastGood: string | null; firstBad: string | null; firstBadIdx: number | null } {
  for (let i = 0; i < reps.length - 1; i++) {
    if (reps[i].good && !reps[i + 1].good) {
      return { lastGood: reps[i].sha, firstBad: reps[i + 1].sha, firstBadIdx: reps[i + 1].idx };
    }
  }
  if (reps.length > 0 && !reps[0].good) {
    return { lastGood: null, firstBad: reps[0].sha, firstBadIdx: reps[0].idx };
  }
  return { lastGood: null, firstBad: null, firstBadIdx: null };
}

// ===========================================================================
// autoBisect
// ===========================================================================

const DEFAULT_MAX_PROBES = 256;

interface FinalizeInput {
  mode: BisectMode;
  ok: boolean;
  confidence: BisectConfidence;
  culpritSha: string | null;
  lastGoodSha: string | null;
  firstBadOrderIndex: number | null;
  reason: string | null;
}

export async function autoBisect(req: BisectRequest): Promise<BisectReport> {
  const nowFn = req.now ?? Date.now;
  const startedAtMs = nowFn();
  const mode: BisectMode = req.measure !== undefined ? "active" : "history-only";
  const maxProbes = req.maxProbes !== undefined && req.maxProbes > 0 ? req.maxProbes : DEFAULT_MAX_PROBES;
  const requireSuiteMatch = req.requireSuiteMatch === true;
  const skipDirty = req.skipDirty === true;

  const skipped: Array<{ sha: string; reason: string }> = [];
  const seenSkips = new Set<string>();
  const pushSkip = (sha: string, reason: string): void => {
    const key = `${sha}::${reason}`;
    if (seenSkips.has(key)) return;
    seenSkips.add(key);
    skipped.push({ sha, reason });
  };

  const probes: BisectProbe[] = [];
  const probeScorecards = new Map<string, EvalScorecard>();
  let metric = "";
  let probeBudgetUsed = 0;

  // -------------------------------------------------------------------
  // 1. Suite filtering + sha -> entries[] map.
  // -------------------------------------------------------------------
  let effectiveSuiteHash: string | undefined = req.suiteHash;
  if (requireSuiteMatch && effectiveSuiteHash === undefined) {
    const bySeq = [...req.entries].sort((a, b) => a.seq - b.seq);
    if (bySeq.length > 0) effectiveSuiteHash = bySeq[bySeq.length - 1].suiteHash;
  }

  const shaToEntries = new Map<string, EvalHistoryEntry[]>();
  for (const e of req.entries) {
    if (requireSuiteMatch && effectiveSuiteHash !== undefined && e.suiteHash !== effectiveSuiteHash) {
      pushSkip(e.sha, `suite-mismatch:${e.suiteHash}!=${effectiveSuiteHash}`);
      continue;
    }
    const arr = shaToEntries.get(e.sha) ?? [];
    arr.push(e);
    shaToEntries.set(e.sha, arr);
  }

  const finalize = (input: FinalizeInput): BisectReport => {
    const culpritEntryChosen =
      input.culpritSha !== null ? chooseHistoryEntry(input.culpritSha, shaToEntries, skipDirty, req.predicate, pushSkip) : null;
    const culpritEntry = culpritEntryChosen !== null ? culpritEntryChosen.entry : null;
    const culpritProbe = input.culpritSha !== null ? probes.find((p) => p.sha === input.culpritSha) ?? null : null;
    const culpritShortSha = culpritProbe?.shortSha ?? culpritEntry?.scorecard.revision.shortSha ?? null;

    let flippedTaskIds: string[] = [];
    if (input.lastGoodSha !== null && input.culpritSha !== null) {
      const goodSc = probeScorecards.get(input.lastGoodSha);
      const badSc = probeScorecards.get(input.culpritSha);
      if (goodSc !== undefined && badSc !== undefined) {
        const delta = compareScorecards(goodSc, badSc);
        if (delta.comparable) flippedTaskIds = delta.flips.map((f) => f.taskId);
      }
    }

    return sealReport({
      version: EVAL_BISECT_VERSION,
      ok: input.ok,
      mode,
      confidence: input.confidence,
      culpritSha: input.culpritSha,
      culpritShortSha,
      culpritEntry,
      lastGoodSha: input.lastGoodSha,
      firstBadOrderIndex: input.firstBadOrderIndex,
      probes,
      probeCount: probes.length,
      candidatesConsidered,
      skipped,
      flippedTaskIds,
      metric,
      orderSource,
      reason: input.reason,
      startedAtMs,
      durationMs: nowFn() - startedAtMs,
    });
  };

  // -------------------------------------------------------------------
  // 2. Candidate chain.
  // -------------------------------------------------------------------
  const candidateSet = new Set<string>(shaToEntries.keys());
  if (req.goodSha !== undefined) candidateSet.add(req.goodSha);
  if (req.badSha !== undefined) candidateSet.add(req.badSha);
  const candidateShas = [...candidateSet];

  let candidatesConsidered = candidateShas.length;
  let orderSource: "git" | "recorded-time" = "recorded-time";

  if (candidateShas.length === 0) {
    return finalize({
      mode,
      ok: false,
      confidence: "none",
      culpritSha: null,
      lastGoodSha: null,
      firstBadOrderIndex: null,
      reason: "no candidate revisions: entries is empty and neither goodSha nor badSha was supplied",
    });
  }

  const { ordered, source } = resolveChainOrder(candidateShas, shaToEntries, req.order);
  orderSource = source;
  candidatesConsidered = ordered.length;
  const indexOf = new Map(ordered.map((sha, i) => [sha, i]));

  // -------------------------------------------------------------------
  // 3. Structural validation of an explicit goodSha/badSha pair.
  // -------------------------------------------------------------------
  if (req.goodSha !== undefined && req.badSha !== undefined) {
    const gi = indexOf.get(req.goodSha);
    const bi = indexOf.get(req.badSha);
    if (gi !== undefined && bi !== undefined && bi < gi) {
      return finalize({
        mode,
        ok: false,
        confidence: "none",
        culpritSha: null,
        lastGoodSha: null,
        firstBadOrderIndex: null,
        reason: `badSha (${req.badSha.slice(0, 12)}) precedes goodSha (${req.goodSha.slice(0, 12)}) in the resolved (${orderSource}) chain order -- refusing to bisect a backwards range; swap goodSha/badSha if this was unintentional`,
      });
    }
    if (orderSource === "git" && isAncestor(req.goodSha, req.goodSha) && isAncestor(req.badSha, req.badSha)) {
      const goodAncestorOfBad = isAncestor(req.goodSha, req.badSha);
      const badAncestorOfGood = isAncestor(req.badSha, req.goodSha);
      if (!goodAncestorOfBad && !badAncestorOfGood) {
        return finalize({
          mode,
          ok: false,
          confidence: "none",
          culpritSha: null,
          lastGoodSha: null,
          firstBadOrderIndex: null,
          reason: `goodSha (${req.goodSha.slice(0, 12)}) and badSha (${req.badSha.slice(0, 12)}) are not ancestor-related -- refusing to fabricate a bisection range between unrelated revisions`,
        });
      }
      if (badAncestorOfGood) {
        return finalize({
          mode,
          ok: false,
          confidence: "none",
          culpritSha: null,
          lastGoodSha: null,
          firstBadOrderIndex: null,
          reason: `badSha (${req.badSha.slice(0, 12)}) is a real git ancestor of goodSha (${req.goodSha.slice(0, 12)}) -- badSha predates goodSha; refusing to bisect a backwards range`,
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // 4. resolveProbe -- the single entry point that turns a known sha into
  //    real evidence (history first, then measure() in active mode).
  // -------------------------------------------------------------------
  const probeCache = new Map<string, BisectProbe | null>();

  async function resolveProbe(sha: string): Promise<BisectProbe | null> {
    if (probeCache.has(sha)) return probeCache.get(sha) ?? null;
    if (probeBudgetUsed >= maxProbes) {
      probeCache.set(sha, null);
      return null;
    }
    probeBudgetUsed += 1;
    const orderIndex = indexOf.get(sha) ?? -1;

    const chosen = chooseHistoryEntry(sha, shaToEntries, skipDirty, req.predicate, pushSkip);
    if (chosen !== null) {
      const verdict = req.predicate(chosen.entry.scorecard);
      if (metric === "") metric = verdict.metric;
      const probe: BisectProbe = {
        sha,
        shortSha: chosen.entry.scorecard.revision.shortSha,
        orderIndex,
        source: "history",
        good: verdict.good,
        value: verdict.value,
        metric: verdict.metric,
        scorecardId: chosen.entry.scorecard.scorecardId,
        probedAtMs: nowFn(),
        note: chosen.note,
      };
      probes.push(probe);
      probeScorecards.set(sha, chosen.entry.scorecard);
      probeCache.set(sha, probe);
      return probe;
    }

    if (req.measure !== undefined) {
      let sc: EvalScorecard | null;
      try {
        sc = await req.measure(sha);
      } catch (err) {
        pushSkip(sha, `measure-threw:${err instanceof Error ? err.message : String(err)}`);
        probeCache.set(sha, null);
        return null;
      }
      if (sc === null) {
        pushSkip(sha, "measure-returned-null");
        probeCache.set(sha, null);
        return null;
      }
      if (sc.revision.sha !== sha) {
        pushSkip(sha, `measure-wrong-sha:expected=${sha}:got=${sc.revision.sha}`);
        probeCache.set(sha, null);
        return null;
      }
      const verify = verifyScorecard(sc);
      if (!verify.ok) {
        pushSkip(sha, `measure-tampered-scorecard:${verify.reason ?? "unknown"}`);
        probeCache.set(sha, null);
        return null;
      }
      if (requireSuiteMatch && effectiveSuiteHash !== undefined && sc.suiteHash !== effectiveSuiteHash) {
        pushSkip(sha, `measure-suite-mismatch:${sc.suiteHash}!=${effectiveSuiteHash}`);
        probeCache.set(sha, null);
        return null;
      }
      if (skipDirty && sc.revision.dirty === true) {
        pushSkip(sha, "measure-dirty-worktree");
        probeCache.set(sha, null);
        return null;
      }
      const verdict = req.predicate(sc);
      if (metric === "") metric = verdict.metric;
      const probe: BisectProbe = {
        sha,
        shortSha: sc.revision.shortSha,
        orderIndex,
        source: "measured",
        good: verdict.good,
        value: verdict.value,
        metric: verdict.metric,
        scorecardId: sc.scorecardId,
        probedAtMs: nowFn(),
        note: null,
      };
      probes.push(probe);
      probeScorecards.set(sha, sc);
      probeCache.set(sha, probe);
      return probe;
    }

    pushSkip(sha, "unrecorded-revision-in-history-only-mode");
    probeCache.set(sha, null);
    return null;
  }

  // -------------------------------------------------------------------
  // 5. Establish the good/bad endpoints (default: earliest/latest known
  //    revision in the resolved chain).
  // -------------------------------------------------------------------
  const badSha = req.badSha ?? ordered[ordered.length - 1];
  const goodSha = req.goodSha ?? ordered[0];

  const badProbe = await resolveProbe(badSha);
  if (badProbe === null) {
    return finalize({
      mode,
      ok: false,
      confidence: "none",
      culpritSha: null,
      lastGoodSha: null,
      firstBadOrderIndex: null,
      reason: `badSha (${badSha.slice(0, 12)}) could not be resolved to a usable scorecard (see skipped[])`,
    });
  }
  if (badProbe.good) {
    return finalize({
      mode,
      ok: false,
      confidence: "none",
      culpritSha: null,
      lastGoodSha: null,
      firstBadOrderIndex: null,
      reason: `badSha (${badSha.slice(0, 12)}) passes the predicate (metric=${badProbe.metric}, value=${String(badProbe.value)}) -- no regression detected`,
    });
  }

  const goodProbe = await resolveProbe(goodSha);
  if (goodProbe === null) {
    return finalize({
      mode,
      ok: false,
      confidence: "none",
      culpritSha: null,
      lastGoodSha: null,
      firstBadOrderIndex: null,
      reason: `goodSha (${goodSha.slice(0, 12)}) could not be resolved to a usable scorecard (see skipped[])`,
    });
  }

  let culpritSha: string;
  let lastGoodSha: string | null;
  let firstBadOrderIndex: number;
  let confidence: BisectConfidence;
  let reason: string | null = null;

  if (!goodProbe.good) {
    // The earliest known revision already fails the predicate -- there is no
    // good ancestor anywhere in recorded history to bisect against.
    culpritSha = goodSha;
    lastGoodSha = null;
    firstBadOrderIndex = indexOf.get(goodSha) ?? 0;
    confidence = "bracketed";
    reason =
      "the earliest known revision in the resolved chain already fails the predicate -- no good ancestor exists in recorded history";
  } else {
    let goodIdx = indexOf.get(goodSha) ?? 0;
    let badIdx = indexOf.get(badSha) ?? ordered.length - 1;

    while (badIdx - goodIdx > 1) {
      if (probeBudgetUsed >= maxProbes) break;
      const mid = Math.floor((goodIdx + badIdx) / 2);
      const rangeSize = badIdx - goodIdx - 1;
      let resolved: BisectProbe | null = null;
      let resolvedIdx: number | null = null;

      for (let offset = 0; offset <= rangeSize && resolved === null; offset++) {
        if (probeBudgetUsed >= maxProbes) break;
        if (offset === 0) {
          if (mid > goodIdx && mid < badIdx) {
            const p = await resolveProbe(ordered[mid]);
            if (p !== null) {
              resolved = p;
              resolvedIdx = mid;
            }
          }
          continue;
        }
        const upIdx = mid + offset;
        const downIdx = mid - offset;
        if (resolved === null && upIdx < badIdx) {
          const p = await resolveProbe(ordered[upIdx]);
          if (p !== null) {
            resolved = p;
            resolvedIdx = upIdx;
          }
        }
        if (resolved === null && probeBudgetUsed < maxProbes && downIdx > goodIdx) {
          const p = await resolveProbe(ordered[downIdx]);
          if (p !== null) {
            resolved = p;
            resolvedIdx = downIdx;
          }
        }
      }

      if (resolved === null || resolvedIdx === null) break;
      if (resolved.good) goodIdx = resolvedIdx;
      else badIdx = resolvedIdx;
    }

    culpritSha = ordered[badIdx];
    lastGoodSha = ordered[goodIdx];
    firstBadOrderIndex = badIdx;

    if (badIdx - goodIdx === 1) {
      confidence = "exact";
    } else {
      confidence = "bracketed";
      const gap = badIdx - goodIdx - 1;
      reason = `search exhausted resolvable candidates between chain positions ${goodIdx} and ${badIdx}; ${gap} revision(s) in between could not be resolved (see skipped[])`;
    }
  }

  // -------------------------------------------------------------------
  // 6. Monotonicity check -- free (reads already-loaded `entries`, adds no
  //    probes), can only ever downgrade confidence, never upgrade it.
  // -------------------------------------------------------------------
  const reps = collectKnownReps(shaToEntries, indexOf, req.predicate, skipDirty);
  const boundGoodIdx = lastGoodSha !== null ? (indexOf.get(lastGoodSha) ?? null) : null;
  const violation = scanMonotonicityViolation(reps, boundGoodIdx, firstBadOrderIndex);
  if (violation !== null) {
    const earliest = findEarliestTransition(reps);
    if (earliest.firstBad !== null) {
      await resolveProbe(earliest.firstBad);
      if (earliest.lastGood !== null) await resolveProbe(earliest.lastGood);
      culpritSha = earliest.firstBad;
      lastGoodSha = earliest.lastGood;
      firstBadOrderIndex = earliest.firstBadIdx ?? firstBadOrderIndex;
    }
    confidence = "ambiguous";
    reason = reason !== null ? `${violation} | ${reason}` : violation;
  }

  return finalize({
    mode,
    ok: true,
    confidence,
    culpritSha,
    lastGoodSha,
    firstBadOrderIndex,
    reason,
  });
}

// ===========================================================================
// Reporting -- aligned ASCII text, CLI/TUI-ready. No HTML, no web output.
// ===========================================================================

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function formatBisectReport(r: BisectReport): string[] {
  const lines: string[] = [];
  lines.push("HADES EVAL AUTO-BISECT REPORT");
  lines.push("=".repeat(72));
  lines.push(`ok           : ${r.ok}`);
  lines.push(`mode         : ${r.mode}`);
  lines.push(`confidence   : ${r.confidence}`);
  lines.push(`metric       : ${r.metric || "(none)"}`);
  lines.push(`orderSource  : ${r.orderSource}`);
  lines.push(`candidates   : ${r.candidatesConsidered}`);
  lines.push(`probeCount   : ${r.probeCount}`);
  lines.push(`culpritSha   : ${r.culpritSha ?? "(none)"}`);
  lines.push(`lastGoodSha  : ${r.lastGoodSha ?? "(none)"}`);
  if (r.reason !== null) lines.push(`reason       : ${r.reason}`);
  lines.push("");

  const sortedProbes = [...r.probes].sort((a, b) => a.orderIndex - b.orderIndex);
  if (sortedProbes.length === 0) {
    lines.push("(no probes)");
  } else {
    lines.push("PROBES");
    const headers = ["IDX", "SHA", "SOURCE", "VERDICT", "VALUE", "METRIC", "NOTE"];
    const rows = sortedProbes.map((p) => [
      String(p.orderIndex),
      p.shortSha,
      p.source,
      p.good ? "GOOD" : "BAD",
      Number.isFinite(p.value) ? p.value.toFixed(4) : String(p.value),
      p.metric,
      p.note ?? "",
    ]);
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    lines.push(headers.map((h, i) => padRight(h, widths[i])).join("  "));
    lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    const totalWidth = widths.reduce((a, w) => a + w + 2, 0);
    for (let i = 0; i < sortedProbes.length; i++) {
      lines.push(rows[i].map((c, j) => padRight(c, widths[j])).join("  "));
      const p = sortedProbes[i];
      const next = sortedProbes[i + 1];
      if (p.sha === r.lastGoodSha && next !== undefined && next.sha === r.culpritSha) {
        lines.push("  " + "^".repeat(Math.max(1, totalWidth - 2)) + " GOOD/BAD TRANSITION");
      }
    }
    lines.push("");
  }

  lines.push(`skipped (${r.skipped.length}):`);
  if (r.skipped.length === 0) {
    lines.push("  (none)");
  } else {
    for (const s of r.skipped) lines.push(`  ${s.sha.slice(0, 12)} : ${s.reason}`);
  }
  lines.push("");

  lines.push(`flippedTaskIds (${r.flippedTaskIds.length}): ${r.flippedTaskIds.join(", ") || "(none)"}`);
  lines.push("");
  lines.push(`contentHash  : ${r.contentHash}`);

  return lines;
}
