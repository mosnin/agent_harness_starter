/**
 * holdout — the Phase-10 exit gate for learned skills.
 *
 * `synthesize.ts` turns GATE-VERIFIED trajectories into a candidate
 * SKILL.md. `refine.ts` grows an existing skill's tool allowlist from
 * further GATE-VERIFIED uses. Neither module asks the one question that
 * actually decides whether a candidate skill is *good*: does it raise
 * verified success on real, held-out runs relative to what is already
 * installed? This module is that question, answered honestly.
 *
 * {@link runHoldoutValidation} runs a *paired* comparison: the candidate
 * skill content and the incumbent skill content (if any) are each run
 * through the caller-supplied {@link HoldoutRunner} over the exact same
 * {@link HoldoutCase} suite, and the resulting {@link HoldoutArmStats} are
 * compared with the same Wilson-lower-bound / Brier machinery
 * `track-record.ts` already uses everywhere else in Hades — this module
 * imports `wilsonLowerBound` and `brierScore` rather than reimplementing
 * either, so a skill's fate is decided by the exact same statistics its
 * ongoing track record is decided by. `applyHoldoutDecision` then performs
 * the atomic apply/rollback: `accept` writes the candidate over the skill
 * file, `rollback` restores the incumbent verbatim (or refuses, with a
 * reason, when there is no incumbent to restore to), and `abstain` touches
 * nothing at all.
 *
 * REAL-VS-MOCK POLICY: this module never invents an outcome. Every number in
 * a returned {@link HoldoutArmStats} is an aggregate over what the injected
 * {@link HoldoutRunner} actually returned for that case — a case the runner
 * never got to (because the suite was too short, or another case threw) does
 * not silently contribute a synthetic "success" or "failure"; it is simply
 * absent from `n`. `wilsonLowerBound` and `brierScore` are imported, not
 * reimplemented, from `./track-record` — this file contains no probability
 * math of its own beyond counting. There is no LLM anywhere in this module,
 * no `Date.now()` outside the injectable `opts.now`, and no filesystem
 * access beyond the caller-injected {@link HoldoutFs} used by
 * `applyHoldoutDecision`.
 *
 * THE DECISION RULE (implemented exactly, see {@link runHoldoutValidation}):
 *
 *  - Reject the suite outright (verdict `"abstain"`, no runs performed) when
 *    the suite has duplicate case ids, or when `incumbentContent` is
 *    provided but does not parse as a SKILL.md.
 *  - Abstain (never accept, never rollback) when the *usable* candidate
 *    sample size (`candidate.n`, i.e. cases the runner didn't throw on) is
 *    below `minCases`, or (when there is an incumbent) the incumbent's
 *    usable sample size is below `minCases`. Thin evidence proves nothing
 *    either way.
 *  - With no incumbent (`incumbentContent === null`): `accept` iff
 *    `candidate.wilsonLower >= minAbsoluteWilson`, else `rollback` (nothing
 *    to roll back *to* on disk, but the verdict still names "do not keep
 *    this candidate").
 *  - With an incumbent: `accept` iff
 *    `candidate.wilsonLower >= incumbent.wilsonLower + minLift`, else
 *    `rollback`.
 *
 * A runner that throws for a given case is caught right there and folded in
 * as `{ success: false, verified: false }` with the thrown message as
 * `detail` — one bad case can never crash the suite — and the count of such
 * thrown cases is both subtracted from the arm's usable `n` and called out
 * explicitly in `reasons`.
 */

import { brierScore, wilsonLowerBound } from "./track-record";
import { parseSkillFile } from "./skill-file";

// ---------------------------------------------------------------------------
// Types (locked contract)
// ---------------------------------------------------------------------------

export interface HoldoutCase {
  id: string;
  objective: string;
  input?: unknown;
}

export interface HoldoutRunResult {
  caseId: string;
  success: boolean;
  verified: boolean;
  predictedP: number;
  certSha256?: string;
  detail?: string;
}

export type HoldoutRunner = (skillContent: string, c: HoldoutCase) => Promise<HoldoutRunResult>;

export interface HoldoutArmStats {
  n: number;
  successes: number;
  verifiedSuccesses: number;
  wilsonLower: number;
  brier: number;
  failures: Array<{ caseId: string; detail: string }>;
}

export type HoldoutVerdict = "accept" | "rollback" | "abstain";

export interface HoldoutDecision {
  verdict: HoldoutVerdict;
  candidate: HoldoutArmStats;
  incumbent: HoldoutArmStats | null;
  minCases: number;
  minLift: number;
  minAbsoluteWilson: number;
  reasons: string[];
  decidedAt: number;
}

export interface HoldoutOptions {
  /** Below this usable sample size (either arm), abstain. Default 5. */
  minCases?: number;
  /** Accept requires `candidate.wilsonLower >= incumbent.wilsonLower + minLift`. Default 0.02. */
  minLift?: number;
  /** Accept floor when there is no incumbent. Default 0.6. */
  minAbsoluteWilson?: number;
  /** When true (default), only verified successes (verified:true AND a certSha256) count toward wilsonLower/successes. */
  requireVerified?: boolean;
  /** Injectable clock; defaults to `() => Date.now()`. */
  now?: () => number;
}

export interface HoldoutFs {
  readFile(p: string): string | null;
  writeFile(p: string, c: string): void;
  exists(p: string): boolean;
}

export interface ApplyResult {
  applied: "candidate" | "incumbent" | "none";
  path: string;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Formatting (matches demotion.ts / skill-evolve-command.ts convention)
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MIN_CASES = 5;
const DEFAULT_MIN_LIFT = 0.02;
const DEFAULT_MIN_ABSOLUTE_WILSON = 0.6;

function resolvedOptions(opts?: HoldoutOptions): Required<HoldoutOptions> {
  return {
    minCases: opts?.minCases ?? DEFAULT_MIN_CASES,
    minLift: opts?.minLift ?? DEFAULT_MIN_LIFT,
    minAbsoluteWilson: opts?.minAbsoluteWilson ?? DEFAULT_MIN_ABSOLUTE_WILSON,
    requireVerified: opts?.requireVerified ?? true,
    now: opts?.now ?? (() => Date.now()),
  };
}

// ---------------------------------------------------------------------------
// Suite validation
// ---------------------------------------------------------------------------

/** Finds the id of the first duplicate case in `suite`, or null if none. */
function findDuplicateCaseId(suite: readonly HoldoutCase[]): string | null {
  const seen = new Set<string>();
  for (const c of suite) {
    if (seen.has(c.id)) return c.id;
    seen.add(c.id);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Running one arm (paired: same suite, same runner, per side skill content)
// ---------------------------------------------------------------------------

interface ArmRunOutcome {
  stats: HoldoutArmStats;
  thrownCaseIds: string[];
}

/**
 * Runs the full `suite` through `runner` against `skillContent`, catching
 * any per-case throw so one bad case never aborts the rest of the suite.
 * Every case that ran (threw or not) contributes a
 * `{ predictedP, success }` pair to `brier` via `brierScore`; only cases
 * whose runner call did not throw contribute to `n`/`successes`/
 * `wilsonLower` — a thrown case carries no forecast to score against a
 * real outcome, so counting it toward `n` would silently invent evidence.
 */
async function runArm(
  skillContent: string,
  suite: readonly HoldoutCase[],
  runner: HoldoutRunner,
  requireVerified: boolean,
): Promise<ArmRunOutcome> {
  const usable: HoldoutRunResult[] = [];
  const failures: Array<{ caseId: string; detail: string }> = [];
  const thrownCaseIds: string[] = [];

  for (const c of suite) {
    let result: HoldoutRunResult;
    try {
      result = await runner(skillContent, c);
    } catch (err) {
      thrownCaseIds.push(c.id);
      const detail = err instanceof Error ? err.message : String(err);
      failures.push({ caseId: c.id, detail });
      continue;
    }

    if (!Number.isFinite(result.predictedP) || result.predictedP < 0 || result.predictedP > 1) {
      const detail = `predictedP out of [0,1]: ${String(result.predictedP)}`;
      failures.push({ caseId: c.id, detail });
      usable.push({ ...result, success: false, verified: false, detail });
      continue;
    }

    usable.push(result);
    if (!result.success) {
      failures.push({ caseId: c.id, detail: result.detail ?? "runner reported success:false" });
    }
  }

  const n = usable.length;
  const countsTowardWilson = (r: HoldoutRunResult): boolean =>
    r.success && (!requireVerified || (r.verified === true && typeof r.certSha256 === "string" && r.certSha256.length > 0));

  const successes = usable.reduce((acc, r) => acc + (r.success ? 1 : 0), 0);
  const verifiedSuccesses = usable.reduce(
    (acc, r) => acc + (r.success && r.verified === true && typeof r.certSha256 === "string" && r.certSha256.length > 0 ? 1 : 0),
    0,
  );
  const wilsonSuccesses = usable.reduce((acc, r) => acc + (countsTowardWilson(r) ? 1 : 0), 0);

  const brier = n > 0 ? brierScore(usable.map((r) => ({ predictedP: r.predictedP, success: r.success }))) : NaN;

  const stats: HoldoutArmStats = {
    n,
    successes,
    verifiedSuccesses,
    wilsonLower: wilsonLowerBound(wilsonSuccesses, n),
    brier,
    failures,
  };

  return { stats, thrownCaseIds };
}

// ---------------------------------------------------------------------------
// runHoldoutValidation
// ---------------------------------------------------------------------------

const EMPTY_ARM: HoldoutArmStats = Object.freeze({
  n: 0,
  successes: 0,
  verifiedSuccesses: 0,
  wilsonLower: 0,
  brier: NaN,
  failures: [],
}) as HoldoutArmStats;

export async function runHoldoutValidation(
  candidateContent: string,
  incumbentContent: string | null,
  suite: readonly HoldoutCase[],
  runner: HoldoutRunner,
  opts?: HoldoutOptions,
): Promise<HoldoutDecision> {
  const { minCases, minLift, minAbsoluteWilson, requireVerified, now } = resolvedOptions(opts);
  const decidedAt = now();

  // --- Suite-level validation: abstain before running anything. -----------

  const dup = findDuplicateCaseId(suite);
  if (dup !== null) {
    return {
      verdict: "abstain",
      candidate: EMPTY_ARM,
      incumbent: null,
      minCases,
      minLift,
      minAbsoluteWilson,
      reasons: [`suite contains duplicate case id "${dup}": refusing to run, no candidate/incumbent distinction is meaningful with ambiguous case identity`],
      decidedAt,
    };
  }

  if (incumbentContent !== null) {
    try {
      parseSkillFile(incumbentContent);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        verdict: "abstain",
        candidate: EMPTY_ARM,
        incumbent: null,
        minCases,
        minLift,
        minAbsoluteWilson,
        reasons: [`incumbentContent does not parse as a SKILL.md: ${detail}`],
        decidedAt,
      };
    }
  }

  // Candidate content itself must also be a parseable SKILL.md — a
  // candidate that isn't even valid SKILL.md syntax can never be "kept".
  try {
    parseSkillFile(candidateContent);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      verdict: "abstain",
      candidate: EMPTY_ARM,
      incumbent: null,
      minCases,
      minLift,
      minAbsoluteWilson,
      reasons: [`candidateContent does not parse as a SKILL.md: ${detail}`],
      decidedAt,
    };
  }

  if (suite.length < minCases) {
    return {
      verdict: "abstain",
      candidate: EMPTY_ARM,
      incumbent: null,
      minCases,
      minLift,
      minAbsoluteWilson,
      reasons: [`suite length=${suite.length} < minCases=${minCases}: too few holdout cases to decide anything`],
      decidedAt,
    };
  }

  // --- Run both arms, paired: same suite, same injected runner. -----------

  const candidateRun = await runArm(candidateContent, suite, runner, requireVerified);
  const incumbentRun =
    incumbentContent !== null ? await runArm(incumbentContent, suite, runner, requireVerified) : null;

  const reasons: string[] = [];

  if (candidateRun.thrownCaseIds.length > 0) {
    reasons.push(
      `candidate runner threw on ${candidateRun.thrownCaseIds.length}/${suite.length} case(s) ` +
        `(${candidateRun.thrownCaseIds.join(", ")}): each counted as a failure, excluded from usable n`,
    );
  }
  if (incumbentRun !== null && incumbentRun.thrownCaseIds.length > 0) {
    reasons.push(
      `incumbent runner threw on ${incumbentRun.thrownCaseIds.length}/${suite.length} case(s) ` +
        `(${incumbentRun.thrownCaseIds.join(", ")}): each counted as a failure, excluded from usable n`,
    );
  }

  // --- Abstain on thin *usable* evidence, after running. -------------------

  if (candidateRun.stats.n < minCases) {
    reasons.push(
      `candidate usable n=${candidateRun.stats.n} < minCases=${minCases} (after excluding thrown cases): abstain`,
    );
    return {
      verdict: "abstain",
      candidate: candidateRun.stats,
      incumbent: incumbentRun?.stats ?? null,
      minCases,
      minLift,
      minAbsoluteWilson,
      reasons,
      decidedAt,
    };
  }

  if (incumbentRun !== null && incumbentRun.stats.n < minCases) {
    reasons.push(
      `incumbent usable n=${incumbentRun.stats.n} < minCases=${minCases} (after excluding thrown cases): abstain`,
    );
    return {
      verdict: "abstain",
      candidate: candidateRun.stats,
      incumbent: incumbentRun.stats,
      minCases,
      minLift,
      minAbsoluteWilson,
      reasons,
      decidedAt,
    };
  }

  // --- The decision rule itself. -------------------------------------------

  if (incumbentRun === null) {
    const passes = candidateRun.stats.wilsonLower >= minAbsoluteWilson;
    reasons.push(
      `no incumbent: candidate.wilsonLower=${fmt(candidateRun.stats.wilsonLower)} ` +
        `${passes ? ">=" : "<"} minAbsoluteWilson=${fmt(minAbsoluteWilson)}: ${passes ? "accept" : "rollback"}`,
    );
    return {
      verdict: passes ? "accept" : "rollback",
      candidate: candidateRun.stats,
      incumbent: null,
      minCases,
      minLift,
      minAbsoluteWilson,
      reasons,
      decidedAt,
    };
  }

  const bar = incumbentRun.stats.wilsonLower + minLift;
  const passes = candidateRun.stats.wilsonLower >= bar;
  reasons.push(
    `candidate.wilsonLower=${fmt(candidateRun.stats.wilsonLower)} ` +
      `${passes ? ">=" : "<"} incumbent.wilsonLower+minLift=${fmt(bar)} ` +
      `(incumbent.wilsonLower=${fmt(incumbentRun.stats.wilsonLower)}, minLift=${fmt(minLift)}): ${passes ? "accept" : "rollback"}`,
  );

  return {
    verdict: passes ? "accept" : "rollback",
    candidate: candidateRun.stats,
    incumbent: incumbentRun.stats,
    minCases,
    minLift,
    minAbsoluteWilson,
    reasons,
    decidedAt,
  };
}

// ---------------------------------------------------------------------------
// applyHoldoutDecision — atomic apply/rollback of the skill file
// ---------------------------------------------------------------------------

/**
 * Applies a {@link HoldoutDecision} to `args.skillPath` via the injected
 * {@link HoldoutFs}:
 *
 *  - `"accept"`   -> writes `candidateContent` to `skillPath`.
 *  - `"rollback"` -> writes `incumbentContent` back to `skillPath` verbatim
 *                    (byte-for-byte, no re-serialization) when it is
 *                    non-null; when `incumbentContent` is `null` there is
 *                    nothing to roll back to, so this REFUSES to write
 *                    anything (`applied: "none"`) and says so in `reasons`
 *                    — silently leaving the candidate in place would be
 *                    exactly the silent-regression failure mode this gate
 *                    exists to prevent.
 *  - `"abstain"`  -> touches the filesystem not at all (`applied: "none"`).
 *
 * Never calls `fs.readFile`/`fs.exists` — this function trusts the caller's
 * `decision` (already computed by `runHoldoutValidation`) and the caller's
 * own `incumbentContent`/`candidateContent`, so a rollback restores exactly
 * the bytes the incumbent arm was actually run against, not whatever
 * happens to be on disk at apply time.
 */
export function applyHoldoutDecision(
  decision: HoldoutDecision,
  args: {
    skillPath: string;
    candidateContent: string;
    incumbentContent: string | null;
    fs: HoldoutFs;
  },
): ApplyResult {
  const { skillPath, candidateContent, incumbentContent, fs } = args;

  if (decision.verdict === "abstain") {
    return {
      applied: "none",
      path: skillPath,
      reasons: [`verdict=abstain: not writing to ${skillPath}`, ...decision.reasons],
    };
  }

  if (decision.verdict === "accept") {
    fs.writeFile(skillPath, candidateContent);
    return {
      applied: "candidate",
      path: skillPath,
      reasons: [`verdict=accept: wrote candidate to ${skillPath}`, ...decision.reasons],
    };
  }

  // verdict === "rollback"
  if (incumbentContent === null) {
    return {
      applied: "none",
      path: skillPath,
      reasons: [
        `verdict=rollback but incumbentContent is null: refusing to write anything to ${skillPath} ` +
          `(nothing to roll back to; leaving the candidate on disk would silently keep a regression)`,
        ...decision.reasons,
      ],
    };
  }

  fs.writeFile(skillPath, incumbentContent);
  return {
    applied: "incumbent",
    path: skillPath,
    reasons: [`verdict=rollback: restored incumbent to ${skillPath}`, ...decision.reasons],
  };
}

