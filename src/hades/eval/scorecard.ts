/**
 * scorecard.ts — the canonical, hash-sealed EvalScorecard.
 *
 * This is the single record shape every Phase-18 measurement module produces
 * and every downstream consumer (leaderboards, regression gates, the
 * TUI/CLI reporters) reads. It is a pure DATA + VERIFICATION module: it does
 * not run tasks, does not call agents, and does not compute V-TPH$ itself —
 * that arithmetic belongs to the real engine (`../bench/vtph`'s `runVtph`)
 * and is only ever consumed here, never re-derived for the throughput lane.
 *
 * Two properties this module exists to guarantee:
 *
 *  1. HONESTY: nothing in an `EvalScorecard` is fabricated. A lane that was
 *     never measured says so explicitly (`risk.measured === false` plus a
 *     human-readable `unmeasuredReason`) instead of silently reporting a `0`
 *     that would read as a passing result.
 *  2. REPRODUCIBILITY: `canonicalizeScorecard` produces a byte-identical
 *     string for two scorecards with identical field values, regardless of
 *     object-key insertion order, outcome array order, or which process
 *     produced them. `contentHash` is `sha256` of that canonical string, so
 *     it is the tamper-evident seal: `verifyScorecard` can detect a mutated
 *     outcome, a hand-edited aggregate, a suite mismatch, a stale hash, or an
 *     unrecognized version, each with its own diagnostic reason.
 *
 * Import policy (locked): this module imports ONLY `sha256Hex` (a real,
 * already-audited primitive) from `../styx/certificate`, plus the `EvalTask`
 * TYPE (type-only, erased at compile time) from `../bench/vtph`. It never
 * imports `runVtph`, `EVAL_TASKS`, or `runRiskEval` — those belong to
 * `measure.ts`, which is the only module allowed to actually drive the real
 * engine. This module only knows how to shape, hash, and verify the record.
 */

import { sha256Hex } from "../styx/certificate";
import type { EvalTask } from "../bench/vtph";

// ===========================================================================
// Locked public surface
// ===========================================================================

export const EVAL_SCORECARD_VERSION = 1;

/** `sha256Hex("hades.eval.scorecard.v1")` — a fixed genesis constant used to
 *  namespace every derived hash in this module (suite fingerprints,
 *  scorecard ids) so they can never collide with hashes minted by an
 *  unrelated hashing scheme that happens to hash the same raw bytes. */
export const EVAL_SCORECARD_GENESIS: string = sha256Hex("hades.eval.scorecard.v1");

/** `"scripted"` — a deterministic, non-model runner (see `measure.ts`).
 *  `"keyed-live"` — a real, caller-supplied agent runner (e.g. one that calls
 *  a live model with an API key). `runEvalMeasurement` refuses to silently
 *  downgrade a `"keyed-live"` request to the scripted lane: see `measure.ts`. */
export type EvalMode = "scripted" | "keyed-live";

/**
 * The five-way, mutually exclusive classification of one task's outcome.
 *  - `verified-correct` : claimed verified AND the ground-truth grader agrees.
 *  - `silent-wrong`     : claimed verified BUT the grader says it's wrong —
 *                         the trust-failure metric (see `../bench/vtph`).
 *  - `declined-correct` : not claimed verified, but would have graded correct.
 *  - `declined-wrong`   : not claimed verified, and would have graded wrong.
 *  - `runner-error`     : the runner itself threw; there is no output to
 *                         grade, so this is never `graded`.
 */
export type TaskOutcomeKind =
  | "verified-correct"
  | "silent-wrong"
  | "declined-correct"
  | "declined-wrong"
  | "runner-error";

/**
 * Structural mirror of Team 2's `RevisionRef` (`./revision`) — declared here
 * on purpose, never imported, to keep `eval/` and `revision`-owning modules
 * decoupled (the same house pattern `RiskEvalSubject` uses in
 * `src/hades/trust/risk-eval.ts` to mirror `TrustSubject`). Any object with
 * this shape — real git metadata or a content-addressed fallback for a
 * non-git checkout — satisfies this type.
 */
export interface ScorecardRevision {
  sha: string;
  shortSha: string;
  dirty: boolean;
  workTreeHash: string;
  source: "git" | "content";
  committedAtMs: number | null;
  branch: string | null;
}

/** One task's fully-graded, fully-costed outcome record. */
export interface EvalTaskOutcome {
  taskId: string;
  category: string;
  kind: TaskOutcomeKind;
  /** Did the agent/gate self-report this result as verified? A claim, not truth. */
  claimedVerified: boolean;
  /** Was `EvalTask.grade` actually invoked for this task? false only for `runner-error`. */
  graded: boolean;
  usd: number;
  tokensIn: number;
  tokensOut: number;
  /** Wall-clock milliseconds for THIS task alone, from the injected clock. */
  wallMs: number;
  provenanceCount: number;
}

/** The throughput lane — mapped verbatim from the real `runVtph` engine
 *  (plus `runnerErrors`, a distinction the real engine's `declined` bucket
 *  does not itself expose but this scorecard's richer per-task outcomes do). */
export interface ThroughputLane {
  tasks: number;
  verifiedCorrect: number;
  silentWrong: number;
  declined: number;
  correctButUnclaimed: number;
  runnerErrors: number;
  wallClockMs: number;
  totalUsd: number;
  totalTokens: number;
  vtph: number;
  vtphPerDollar: number;
  provenanceCompleteRate: number;
}

/** The risk (silent-wrong epsilon) lane. When `measured` is `false`, every
 *  result-shaped field is an honest "nothing happened" value — `0` for
 *  counts that are literally zero (zero attempts really did occur), `NaN`
 *  for rates that cannot honestly be claimed as `0` (that would read as a
 *  passing measurement), and `withinBound: false` (never a fabricated pass). */
export interface RiskLane {
  measured: boolean;
  unmeasuredReason: string | null;
  epsilon: number;
  attempts: number;
  accepted: number;
  coverage: number;
  silentWrong: number;
  silentWrongRate: number;
  withinBound: boolean;
  certificatesIssued: number;
  certificatesVerified: number;
  certificateFailures: number;
}

/** Aggregated stats for one task category, normalized against the same
 *  batch wall-clock duration as the top-level throughput lane. */
export interface CategoryStat {
  tasks: number;
  verifiedCorrect: number;
  silentWrong: number;
  declined: number;
  vtph: number;
}

export interface EvalScorecard {
  version: number;
  scorecardId: string;
  label: string;
  mode: EvalMode;
  revision: ScorecardRevision;
  suiteHash: string;
  suiteTaskIds: string[];
  createdAtMs: number;
  durationMs: number;
  throughput: ThroughputLane;
  risk: RiskLane;
  perCategory: Record<string, CategoryStat>;
  outcomes: EvalTaskOutcome[];
  provenance: {
    engine: string[];
    graderSource: string;
    runnerLabel: string;
    realComponents: string[];
  };
  contentHash: string;
}

// ===========================================================================
// Suite fingerprinting
// ===========================================================================

/**
 * A deterministic, order-independent fingerprint of a task suite's identity,
 * derived purely from task ids (sorted before hashing) so it can be
 * recomputed both from a live `EvalTask[]` (here) and from a persisted
 * `suiteTaskIds: string[]` (in `verifyScorecard`, which has no access to the
 * original task objects — only what was recorded).
 */
function suiteFingerprintFromIds(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  return sha256Hex(`${EVAL_SCORECARD_GENESIS}:suite.v${EVAL_SCORECARD_VERSION}:${sorted.join("|")}`);
}

export function suiteFingerprint(tasks: readonly EvalTask[]): string {
  return suiteFingerprintFromIds(tasks.map((t) => t.id));
}

// ===========================================================================
// Aggregation — recomputes throughput + per-category stats from OUTCOME
// RECORDS. This is used two ways: (a) production code uses it to build
// `perCategory` (a lane the real engine has no equivalent for), and (b) it is
// the independent audit tool `verifyScorecard` and callers use to prove a
// scorecard's `throughput` lane has not drifted from the `outcomes` it
// claims to summarize.
// ===========================================================================

const MS_PER_HOUR = 3_600_000;

function emptyCategoryStat(): CategoryStat {
  return { tasks: 0, verifiedCorrect: 0, silentWrong: 0, declined: 0, vtph: 0 };
}

export function aggregateOutcomes(
  outcomes: readonly EvalTaskOutcome[],
  wallClockMs: number,
): { throughput: ThroughputLane; perCategory: Record<string, CategoryStat> } {
  let verifiedCorrect = 0;
  let silentWrong = 0;
  let declined = 0;
  let correctButUnclaimed = 0;
  let runnerErrors = 0;
  let totalUsd = 0;
  let totalTokens = 0;
  let claimedCount = 0;
  let claimedWithProvenance = 0;

  const perCategory: Record<string, CategoryStat> = {};
  const bucketFor = (category: string): CategoryStat => {
    if (perCategory[category] === undefined) perCategory[category] = emptyCategoryStat();
    return perCategory[category];
  };

  for (const o of outcomes) {
    const bucket = bucketFor(o.category);
    bucket.tasks += 1;
    totalUsd += o.usd;
    totalTokens += o.tokensIn + o.tokensOut;

    if (o.claimedVerified) {
      claimedCount += 1;
      if (o.provenanceCount > 0) claimedWithProvenance += 1;
    }

    switch (o.kind) {
      case "verified-correct":
        verifiedCorrect += 1;
        bucket.verifiedCorrect += 1;
        break;
      case "silent-wrong":
        silentWrong += 1;
        bucket.silentWrong += 1;
        break;
      case "declined-correct":
        declined += 1;
        correctButUnclaimed += 1;
        bucket.declined += 1;
        break;
      case "declined-wrong":
        declined += 1;
        bucket.declined += 1;
        break;
      case "runner-error":
        declined += 1;
        runnerErrors += 1;
        bucket.declined += 1;
        break;
      default: {
        const exhaustive: never = o.kind;
        throw new TypeError(`aggregateOutcomes: unrecognized outcome kind "${String(exhaustive)}"`);
      }
    }
  }

  const hours = wallClockMs / MS_PER_HOUR;
  const vtph = hours > 0 ? verifiedCorrect / hours : 0;
  // Unlike the real engine's guarded formula (which floors the denominator to
  // avoid ever reporting a literal Infinity), this independent recomputation
  // is allowed to surface a genuinely infinite (or, at zero verified work AND
  // zero spend, genuinely undefined) value at true zero spend. See
  // `canonicalizeScorecard`'s number encoding for how both are honestly
  // serialized rather than collapsed into a misleading `0`.
  const vtphPerDollar =
    totalUsd === 0 ? (vtph === 0 ? Number.NaN : Number.POSITIVE_INFINITY) : vtph / totalUsd;
  const provenanceCompleteRate = claimedWithProvenance / Math.max(1, claimedCount);

  for (const category of Object.keys(perCategory)) {
    const bucket = perCategory[category];
    bucket.vtph = hours > 0 ? bucket.verifiedCorrect / hours : 0;
  }

  const throughput: ThroughputLane = {
    tasks: outcomes.length,
    verifiedCorrect,
    silentWrong,
    declined,
    correctButUnclaimed,
    runnerErrors,
    wallClockMs,
    totalUsd,
    totalTokens,
    vtph,
    vtphPerDollar,
    provenanceCompleteRate,
  };

  return { throughput, perCategory };
}

// ===========================================================================
// Canonicalization + hashing
// ===========================================================================

/**
 * Encode one number as a canonical token. Finite numbers are normalized to a
 * fixed significant-figure form (killing float-representation noise across
 * processes/engines); integers are emitted verbatim (never re-rounded).
 * Non-finite values (`Infinity`, `-Infinity`, `NaN`) are NEVER silently
 * collapsed to `null`/`0` — each gets an explicit, quoted sentinel token that
 * round-trips (`Number(JSON.parse(token)) === original`).
 */
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
    return (
      "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringifyValue(obj[k])).join(",") + "}"
    );
  }
  throw new TypeError(`canonicalizeScorecard: unserializable value of type ${typeof value}`);
}

function taskIdOf(o: EvalTaskOutcome): string {
  return o.taskId;
}

/**
 * The canonical serialization of a scorecard's CONTENT — everything except
 * `contentHash` itself (which is defined as the hash of this very output, so
 * it can never be an input to itself). Stable across processes and
 * object-key insertion order: `outcomes` are sorted by `taskId` before
 * serializing (all other object keys are sorted generically, recursively,
 * by the stable stringifier), and every number goes through `formatNumber`.
 */
export function canonicalizeScorecard(s: EvalScorecard): string {
  const normalized: EvalScorecard = {
    ...s,
    suiteTaskIds: [...s.suiteTaskIds],
    outcomes: [...s.outcomes].sort((a, b) => {
      const ta = taskIdOf(a);
      const tb = taskIdOf(b);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    }),
    contentHash: "", // self-referential field: never part of its own hash input
  };
  return stableStringifyValue(normalized);
}

export function scorecardHash(s: EvalScorecard): string {
  return sha256Hex(canonicalizeScorecard(s));
}

export function sealScorecard(s: Omit<EvalScorecard, "contentHash">): EvalScorecard {
  const draft: EvalScorecard = { ...s, contentHash: "" };
  return { ...draft, contentHash: scorecardHash(draft) };
}

/**
 * Independently verify a scorecard's internal consistency. Checks run in
 * order from most specific/local to most global, so each of the following
 * gets its own distinct `reason` and is caught by the FIRST check able to
 * see it:
 *
 *  1. `version` this module doesn't understand.
 *  2. `suiteHash` that doesn't match `suiteTaskIds` (recomputed from the ids
 *     alone, exactly as `suiteFingerprint` would from the live tasks).
 *  3. `throughput` (verifiedCorrect/silentWrong/declined/totalUsd/etc.) that
 *     disagrees with `aggregateOutcomes(outcomes, throughput.wallClockMs)` —
 *     catches BOTH a mutated `outcomes` array and a hand-edited `throughput`
 *     total, since both manifest as the same disagreement.
 *  4. A `contentHash` that doesn't match `scorecardHash(s)` — the catch-all
 *     for any tampering not already caught above (e.g. corrupting the hash
 *     field itself while leaving everything else self-consistent).
 */
export function verifyScorecard(s: EvalScorecard): { ok: boolean; reason: string | null } {
  if (s.version !== EVAL_SCORECARD_VERSION) {
    return { ok: false, reason: `unsupported-version:${String(s.version)}` };
  }

  const expectedSuiteHash = suiteFingerprintFromIds(s.suiteTaskIds);
  if (expectedSuiteHash !== s.suiteHash) {
    return { ok: false, reason: "suite-hash-mismatch" };
  }

  const recomputed = aggregateOutcomes(s.outcomes, s.throughput.wallClockMs);
  const t = s.throughput;
  const r = recomputed.throughput;
  const throughputAgrees =
    t.tasks === r.tasks &&
    t.verifiedCorrect === r.verifiedCorrect &&
    t.silentWrong === r.silentWrong &&
    t.declined === r.declined &&
    t.correctButUnclaimed === r.correctButUnclaimed &&
    t.runnerErrors === r.runnerErrors &&
    t.totalUsd === r.totalUsd &&
    t.totalTokens === r.totalTokens;
  if (!throughputAgrees) {
    return { ok: false, reason: "throughput-outcome-mismatch" };
  }

  const expectedHash = scorecardHash(s);
  if (expectedHash !== s.contentHash) {
    return { ok: false, reason: "content-hash-mismatch" };
  }

  return { ok: true, reason: null };
}

// ===========================================================================
// Reporting — aligned ASCII text, CLI/TUI-ready. No HTML, no web output.
// ===========================================================================

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function formatVtphPerDollar(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
}

export function formatScorecard(s: EvalScorecard): string[] {
  const lines: string[] = [];
  lines.push("HADES EVAL SCORECARD");
  lines.push("=".repeat(64));
  lines.push(`scorecardId  : ${s.scorecardId}`);
  lines.push(`version      : ${s.version}`);
  lines.push(`label        : ${s.label}`);
  lines.push(`mode         : ${s.mode}`);
  lines.push(
    `revision     : ${s.revision.shortSha}${s.revision.dirty ? "-dirty" : ""} (${s.revision.source})`,
  );
  lines.push(`branch       : ${s.revision.branch ?? "(detached/unknown)"}`);
  lines.push(`suiteHash    : ${s.suiteHash}`);
  lines.push(`suite tasks  : ${s.suiteTaskIds.length}`);
  lines.push(`createdAtMs  : ${s.createdAtMs}`);
  lines.push(`durationMs   : ${s.durationMs}`);
  lines.push("");

  lines.push("THROUGHPUT (V-TPH$ -- real runVtph engine)");
  lines.push(`  tasks                  : ${s.throughput.tasks}`);
  lines.push(`  verifiedCorrect        : ${s.throughput.verifiedCorrect}`);
  lines.push(`  silentWrong            : ${s.throughput.silentWrong}`);
  lines.push(`  declined               : ${s.throughput.declined}`);
  lines.push(`  correctButUnclaimed    : ${s.throughput.correctButUnclaimed}`);
  lines.push(`  runnerErrors           : ${s.throughput.runnerErrors}`);
  lines.push(`  wallClockMs            : ${s.throughput.wallClockMs.toFixed(3)}`);
  lines.push(`  totalUsd               : ${s.throughput.totalUsd.toFixed(6)}`);
  lines.push(`  totalTokens            : ${s.throughput.totalTokens}`);
  lines.push(`  vtph                   : ${s.throughput.vtph.toFixed(4)}`);
  lines.push(`  vtphPerDollar          : ${formatVtphPerDollar(s.throughput.vtphPerDollar)}`);
  lines.push(`  provenanceCompleteRate : ${s.throughput.provenanceCompleteRate.toFixed(4)}`);
  lines.push("");

  lines.push("RISK (silent-wrong epsilon lane -- real runRiskEval when measured)");
  if (!s.risk.measured) {
    lines.push(`  UNMEASURED: ${s.risk.unmeasuredReason ?? "no reason given"}`);
  } else {
    lines.push(`  epsilon                : ${s.risk.epsilon.toFixed(4)}`);
    lines.push(`  attempts               : ${s.risk.attempts}`);
    lines.push(`  accepted               : ${s.risk.accepted}`);
    lines.push(`  coverage               : ${s.risk.coverage.toFixed(4)}`);
    lines.push(`  silentWrong            : ${s.risk.silentWrong}`);
    lines.push(`  silentWrongRate        : ${s.risk.silentWrongRate.toFixed(4)}`);
    lines.push(`  withinBound            : ${s.risk.withinBound}`);
    lines.push(`  certificatesIssued     : ${s.risk.certificatesIssued}`);
    lines.push(`  certificatesVerified   : ${s.risk.certificatesVerified}`);
    lines.push(`  certificateFailures    : ${s.risk.certificateFailures}`);
  }
  lines.push("");

  const categories = Object.keys(s.perCategory).sort();
  if (categories.length > 0) {
    lines.push("PER-CATEGORY");
    const headers = ["CATEGORY", "TASKS", "VERIFIED", "SILENT-WRONG", "DECLINED", "VTPH"];
    const rows = categories.map((c) => {
      const b = s.perCategory[c];
      return [
        c,
        String(b.tasks),
        String(b.verifiedCorrect),
        String(b.silentWrong),
        String(b.declined),
        b.vtph.toFixed(3),
      ];
    });
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    lines.push(headers.map((h, i) => padRight(h, widths[i])).join("  "));
    lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) lines.push(row.map((c, i) => padRight(c, widths[i])).join("  "));
    lines.push("");
  }

  lines.push("PROVENANCE");
  lines.push(`  runnerLabel    : ${s.provenance.runnerLabel}`);
  lines.push(`  graderSource   : ${s.provenance.graderSource}`);
  lines.push("  engine:");
  for (const e of s.provenance.engine) lines.push(`    - ${e}`);
  lines.push("  realComponents:");
  for (const c of s.provenance.realComponents) lines.push(`    - ${c}`);
  lines.push("");
  lines.push(`contentHash  : ${s.contentHash}`);

  return lines;
}
