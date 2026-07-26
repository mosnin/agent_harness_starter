/**
 * PerVerifierCalibrator — Phase 16: turns raw verifier verdicts into a
 * calibrated P(correct) that is SPECIFIC to the (verifier, arm) pair that
 * produced them, the input both the risk gate (via `../styx/tiers`'s
 * `tierConfidenceFloor`) and the bandit (via `../routing/bandit.ts`, a
 * different Phase-16 team's file — never imported here, arms stay opaque
 * `armId: string`) need.
 *
 * ===========================================================================
 * THE HIERARCHY (locked)
 * ===========================================================================
 * `calibrate(verifierId, armId, score)` answers "what does this verifier's
 * raw score mean for THIS arm, in P(correct) terms?" by walking a strict
 * fallback ladder, coarsest signal last:
 *
 *   1. (verifier, arm)  -- an isotonic (PAVA) score->P(correct) curve fit
 *      ONLY on this verifier's own observations for this exact arm, used
 *      only once there are >= `minSamplesArm` of them AND the curve is
 *      judged informative (see below). `source: "verifier+arm"`.
 *   2. (verifier)       -- the same fit pooled across every arm this
 *      verifier has ever scored, used once there are >= `minSamplesVerifier`
 *      pooled observations and it too is informative. `source: "verifier"`.
 *   3. tier-prior        -- the REAL, shipped `calibrationTable()` prior for
 *      this verifier's tier (never re-derived). `source: "tier-prior"`.
 *   4. 0.5                -- a verifier this table has never heard of at all
 *      lands here (the tier-prior fallback itself defaults its prior to 0.5
 *      in that case, so this isn't a distinct code path).
 *
 * Whichever level would otherwise be selected is DEMOTED to `source:
 * "uninformative"` — and the returned `pCorrect` becomes exactly that tier's
 * static prior, never the level's own isotonic prediction — the moment
 * `../tools/verifiers.test.ts`-style adversarial behaviour is detected on
 * it: a verifier that always agrees with itself (always passes, or always
 * fails, so its raw score carries no signal at all) or one whose score is
 * ANTI-correlated with ground truth (a high score predicts *incorrect*
 * output). The anti-correlated case matters most: it would be trivial to
 * "fix" by inverting the score, but that would launder a broken verifier
 * into a confident-looking certificate, which is exactly the failure this
 * module exists to prevent. See `computeQuality` below.
 *
 * Every level (including 1 and 2 when they ARE used) is additionally
 * SHRUNK toward its parent level by a documented convex combination
 * (`shrinkageBlend`) parameterised by a pseudo-count (`opts.shrinkage`, a
 * pseudo-count of "parent-equivalent" observations, default 5): the more
 * observations a level has, the closer its own isotonic prediction is
 * trusted; few observations pull the estimate toward the (more populated,
 * more conservative) parent. This is what keeps a single new observation
 * from swinging `pCorrect` — the maximum a lone observation can move
 * `pCorrect` is bounded by `1 / (1 + shrinkage)` (proved in this file's
 * tests).
 *
 * ===========================================================================
 * REAL, SHIPPED MACHINERY -- COMPOSED, NEVER RE-IMPLEMENTED
 * ===========================================================================
 *   - `TierId`, `tierConfidenceFloor`, `VerifierVote`, `WeakVerifierEnsemble`
 *     from `../styx/tiers` -- the verifier-tier router + the label-free
 *     Dawid-Skene-style ensemble `ensembleProbability` falls back to when an
 *     arm has never been labelled (see below). `tierConfidenceFloor` is used
 *     on every `CalibratedScore` to annotate `warnings` with how far short
 *     `pCorrect` falls of that tier's actual emit floor -- exactly the
 *     number a risk gate downstream needs, computed by the REAL function,
 *     not re-derived here.
 *   - `calibrationTable` from `../tools/verifiers` -- the ONE shipped
 *     registry of verifier tiers + priors. This module never invents a
 *     prior; it reads this table (or `opts.table`, an injection point for
 *     tests/other registries, defaulting to the real one).
 *   - `brierDecomposition`, `BrierDecomposition` from `../market/reputation`
 *     -- the real Murphy decomposition (reliability/resolution/uncertainty)
 *     computes each verifier's `VerifierQuality.brier`.
 *
 * Pure: no `Date.now()`, no `Math.random()`, no I/O anywhere in this file.
 * `now` is always caller-supplied, to `fit()`.
 */

import type { TierId, VerifierVote } from "../styx/tiers";
import { tierConfidenceFloor, WeakVerifierEnsemble } from "../styx/tiers";
import { calibrationTable } from "../tools/verifiers";
import type { BrierDecomposition } from "../market/reputation";
import { brierDecomposition } from "../market/reputation";

// ---------------------------------------------------------------------------
// Locked public contract -- types
// ---------------------------------------------------------------------------

export interface VerifierObservation {
  verifierId: string;
  armId: string;
  score: number; // [0,1]
  passed: boolean;
  correct: boolean;
  at: number;
}

export type CalibrationSource = "verifier+arm" | "verifier" | "tier-prior" | "uninformative";

export interface CalibratedScore {
  verifierId: string;
  armId: string;
  rawScore: number;
  pCorrect: number;
  source: CalibrationSource;
  n: number;
  tier: TierId;
  informative: boolean;
  warnings: readonly string[];
}

export interface VerifierQuality {
  verifierId: string;
  armId: string | null;
  n: number;
  brier: BrierDecomposition;
  ece: number;
  auc: number;
  positiveRate: number;
  informative: boolean;
  antiCorrelated: boolean;
}

export interface CalibratorOptions {
  table?: Record<string, { tier: TierId; prior: number }>;
  minSamplesArm?: number;
  minSamplesVerifier?: number;
  eceBins?: number;
  halfLifeMs?: number;
  shrinkage?: number;
}

export interface ScoredVote extends VerifierVote {
  score: number;
}

export interface EnsembleProbability {
  pCorrect: number;
  weights: Record<string, number>;
  agreement: number;
  source: "calibrated" | "label-free-ensemble" | "tier-prior";
  usedVerifiers: readonly string[];
  droppedVerifiers: readonly string[];
}

export class CalibrationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CalibrationError";
    this.code = code;
  }
}

export interface IsotonicFit {
  knots: ReadonlyArray<{ x: number; y: number }>;
  predict(x: number): number;
}

// ---------------------------------------------------------------------------
// Snapshot envelope (versioned; see `PerVerifierCalibrator.snapshot`/`restore`)
// ---------------------------------------------------------------------------

export interface SnapshotObservation {
  verifierId: string;
  armId: string;
  score: number;
  passed: boolean;
  correct: boolean;
  at: number;
}

export interface SnapshotFitEntry {
  id: string;
  armId: string | null;
  knots: ReadonlyArray<{ x: number; y: number }>;
}

export interface CalibratorSnapshot {
  version: 1;
  fitted: boolean;
  fitAt: number | null;
  observations: readonly SnapshotObservation[];
  fits: readonly SnapshotFitEntry[];
}

// ---------------------------------------------------------------------------
// Small numeric / shared helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Deterministic key for a (verifierId, armId) pair. NUL is not a legal id
 *  character in practice and is never produced by JSON, so this cannot
 *  collide across distinct (verifierId, armId) pairs. */
function pairKey(verifierId: string, armId: string): string {
  return `${verifierId}\u0000${armId}`;
}

function splitPairKey(k: string): [string, string] {
  const idx = k.indexOf("\u0000");
  return [k.slice(0, idx), k.slice(idx + 1)];
}

const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeKey(name: string, value: string): void {
  if (UNSAFE_KEYS.has(value)) {
    throw new CalibrationError(`${name} "${value}" is not a permitted identifier`, "unsafe-key");
  }
  // `pairKey` joins (verifierId, armId) with a NUL. An id that contains a NUL
  // itself would make two DISTINCT pairs collide onto one composite key --
  // e.g. ("a\u0000b", "c") and ("a", "b\u0000c") -- silently pooling one
  // verifier's calibration data into another's. Reject the separator outright
  // rather than trusting that "no real id contains a NUL".
  if (value.includes("\u0000")) {
    throw new CalibrationError(
      `${name} must not contain a NUL character (it is the internal (verifier,arm) key separator)`,
      "unsafe-key",
    );
  }
}

/** The confidence a fallback (tier-prior / uninformative) estimate is
 *  annotated against, via the REAL `tierConfidenceFloor`. Matches the
 *  worked example in `../styx/tiers.ts`'s own docstring (baseEpsilon=0.1). */
const DEFAULT_BASE_EPSILON = 0.1;

const MIN_WEIGHT = 1e-9;
const MAX_DECAY = 1e6;

/** Exponential recency decay: weight halves every `halfLifeMs`. `halfLifeMs
 *  === Infinity` (the default) disables decay entirely (constant weight 1). */
function decayWeight(at: number, now: number, halfLifeMs: number): number {
  if (halfLifeMs === Infinity) return 1;
  const age = now - at;
  const raw = Math.pow(0.5, age / halfLifeMs);
  if (!Number.isFinite(raw) || raw <= 0) return MIN_WEIGHT;
  return Math.min(MAX_DECAY, raw);
}

/** Convex combination of a level's own estimate and its parent's, weighted
 *  by how much evidence the level has (`n` observations vs. a `k`
 *  pseudo-count of parent-equivalent evidence). Strictly interpolates: as
 *  n -> 0, result -> parent; as n -> infinity, result -> raw. A single
 *  observation (n=1) can move the result at most `1/(1+k)` of the way from
 *  `parent` toward `raw`. */
function shrinkageBlend(n: number, raw: number, parent: number, k: number): number {
  const w = n / (n + k);
  return clamp01(parent + (raw - parent) * w);
}

function rawAgreement(votes: ReadonlyArray<{ passed: boolean }>): number {
  if (votes.length === 0) return 0.5;
  let pass = 0;
  for (const v of votes) if (v.passed) pass++;
  return pass / votes.length;
}

// ---------------------------------------------------------------------------
// isotonicFit -- weighted Pool-Adjacent-Violators (PAVA)
// ---------------------------------------------------------------------------

/**
 * Weighted isotonic regression via PAVA. Points sharing the same `x` are
 * first pooled into a single weighted-mean-y observation (order-independent
 * -- sums and weighted means commute regardless of insertion order, which is
 * what gives this module its determinism guarantee). The remaining unique
 * x's are then processed with the classic block-merging PAVA sweep: a new
 * singleton block is pushed for each x in ascending order, and merged with
 * its predecessor (weighted-average of both) whenever doing so is required
 * to keep the block sequence's y-values non-decreasing. The result is one
 * knot per (deduplicated) input x, with `y` equal to the value of whichever
 * block that x ended up pooled into -- exactly non-decreasing across knots
 * by construction. `predict` linearly interpolates between the two
 * bracketing knots and clamps to the first/last knot's `y` outside the knot
 * range.
 *
 * Throws `RangeError` on a non-finite x/y/w or a non-positive weight --
 * this is a pure numerical primitive, not part of the calibrator's
 * `CalibrationError`-coded error surface.
 */
export function isotonicFit(points: ReadonlyArray<{ x: number; y: number; w: number }>): IsotonicFit {
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.w)) {
      throw new RangeError(`isotonicFit: point fields must be finite numbers, got ${JSON.stringify(p)}`);
    }
    if (p.w <= 0) {
      throw new RangeError(`isotonicFit: weight must be > 0, got ${p.w}`);
    }
  }

  if (points.length === 0) {
    return { knots: [], predict: () => 0.5 };
  }

  const byX = new Map<number, { sumW: number; sumWY: number }>();
  for (const p of points) {
    const g = byX.get(p.x);
    if (g) {
      g.sumW += p.w;
      g.sumWY += p.w * p.y;
    } else {
      byX.set(p.x, { sumW: p.w, sumWY: p.w * p.y });
    }
  }

  const xs = Array.from(byX.keys()).sort((a, b) => a - b);
  const ws = xs.map((x) => byX.get(x)!.sumW);
  const ys = xs.map((x) => byX.get(x)!.sumWY / byX.get(x)!.sumW);

  interface Block {
    sumW: number;
    sumWY: number;
    y: number;
    start: number;
    end: number;
  }
  const stack: Block[] = [];
  for (let i = 0; i < xs.length; i++) {
    stack.push({ sumW: ws[i], sumWY: ws[i] * ys[i], y: ys[i], start: i, end: i });
    while (stack.length >= 2 && stack[stack.length - 2].y > stack[stack.length - 1].y) {
      const top = stack.pop()!;
      const prev = stack.pop()!;
      const sumW = prev.sumW + top.sumW;
      const sumWY = prev.sumWY + top.sumWY;
      stack.push({ sumW, sumWY, y: sumWY / sumW, start: prev.start, end: top.end });
    }
  }

  const fittedY = new Array<number>(xs.length);
  for (const blk of stack) {
    for (let i = blk.start; i <= blk.end; i++) fittedY[i] = blk.y;
  }

  const knots = xs.map((x, i) => ({ x, y: clamp01(fittedY[i]) }));

  return {
    knots,
    predict(x: number): number {
      if (knots.length === 0) return 0.5;
      const xx = Number.isFinite(x) ? x : knots[0].x <= 0.5 ? 0 : 1;
      if (xx <= knots[0].x) return knots[0].y;
      const lastKnot = knots[knots.length - 1];
      if (xx >= lastKnot.x) return lastKnot.y;
      let lo = 0;
      let hi = knots.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (knots[mid].x <= xx) lo = mid;
        else hi = mid;
      }
      const a = knots[lo];
      const b = knots[hi];
      if (b.x === a.x) return a.y;
      const t = (xx - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    },
  };
}

// ---------------------------------------------------------------------------
// Metrics: AUC (Mann-Whitney rank-sum, tie-corrected), ECE (equal-width bins)
// ---------------------------------------------------------------------------

/**
 * AUC of `scores` as a classifier of `outcomes` (1 = correct), via the
 * rank-sum / Mann-Whitney U formulation: `AUC = (sumRank(positives) -
 * nPos*(nPos+1)/2) / (nPos*nNeg)`. Ties (equal scores) are given the average
 * of the ranks they span, the standard tie correction -- this makes the
 * result independent of input order (the average-rank assignment only
 * depends on the multiset of scores, not which duplicate came "first").
 * Undefined when either class is empty (no positives or no negatives to
 * rank against) -- returns the neutral `0.5` in that case, since no
 * discrimination can be measured.
 */
function computeAUC(scores: ReadonlyArray<number>, outcomes: ReadonlyArray<0 | 1>): number {
  const n = scores.length;
  let nPos = 0;
  let nNeg = 0;
  for (const o of outcomes) if (o === 1) nPos++; else nNeg++;
  if (nPos === 0 || nNeg === 0 || n === 0) return 0.5;

  const combined = scores.map((s, i) => ({ s, isPos: outcomes[i] === 1 }));
  combined.sort((a, b) => a.s - b.s);

  const ranks = new Array<number>(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j + 1 < combined.length && combined[j + 1].s === combined[i].s) j++;
    const avgRank = (i + 1 + (j + 1)) / 2; // 1-based, inclusive of both ends
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }

  let sumRankPos = 0;
  for (let k = 0; k < combined.length; k++) if (combined[k].isPos) sumRankPos += ranks[k];

  const auc = (sumRankPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
  return clamp01(auc);
}

/**
 * Expected Calibration Error over `bins` equal-width bins of `[0,1]`,
 * weighted by (optionally decayed) observation weight. Empty-bin policy:
 * an empty bin contributes nothing to the weighted average (skipped, not
 * treated as a zero-error bin nor as an error) -- matches
 * `../market/reputation.ts`'s `calibrationGapFromBins` convention.
 */
function eceFromPoints(points: ReadonlyArray<{ p: number; outcome: 0 | 1; weight: number }>, bins: number): number {
  if (points.length === 0) return 0;
  const binW = new Array<number>(bins).fill(0);
  const binSumP = new Array<number>(bins).fill(0);
  const binSumO = new Array<number>(bins).fill(0);
  let totalW = 0;
  for (const pt of points) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(pt.p * bins)));
    binW[idx] += pt.weight;
    binSumP[idx] += pt.weight * pt.p;
    binSumO[idx] += pt.weight * pt.outcome;
    totalW += pt.weight;
  }
  if (totalW <= 0) return 0;
  let acc = 0;
  for (let k = 0; k < bins; k++) {
    if (binW[k] === 0) continue;
    const conf = binSumP[k] / binW[k];
    const accy = binSumO[k] / binW[k];
    acc += (binW[k] / totalW) * Math.abs(conf - accy);
  }
  return acc;
}

const ANTI_CORRELATION_AUC_THRESHOLD = 0.4;

/**
 * A verifier(/arm) is `informative:false` when either:
 *   - its `passed` verdict never varies (always-pass or always-fail, and
 *     n>=2 so there is something to vary at all) -- its own verdict carries
 *     zero bits of information, you already know what it will say before
 *     asking; a single observation (n=1, nothing yet to contradict it) is
 *     NOT flagged degenerate on this basis alone, OR
 *   - it is anti-correlated (see below).
 * It is additionally `antiCorrelated:true` (and therefore ALSO
 * `informative:false` -- an anti-correlated signal is never "used as-is")
 * when both outcome classes are present and its AUC falls below
 * `ANTI_CORRELATION_AUC_THRESHOLD`: a HIGH score predicts an INCORRECT
 * result more often than chance. This is deliberately never inverted back
 * into a high-confidence signal -- see this file's module docstring.
 */
function computeQuality(
  verifierId: string,
  armId: string | null,
  obs: ReadonlyArray<VerifierObservation>,
  now: number,
  eceBins: number,
  halfLifeMs: number,
): VerifierQuality {
  const n = obs.length;
  const weights = obs.map((o) => decayWeight(o.at, now, halfLifeMs));
  const positiveRate = n > 0 ? obs.reduce((acc, o) => acc + (o.passed ? 1 : 0), 0) / n : 0;

  const brierPoints = obs.map((o, i) => ({ p: o.score, outcome: (o.correct ? 1 : 0) as 0 | 1, weight: weights[i] }));
  const brier = brierDecomposition(brierPoints, eceBins);
  const ece = eceFromPoints(brierPoints, eceBins);
  const auc = computeAUC(
    obs.map((o) => o.score),
    obs.map((o) => (o.correct ? 1 : 0) as 0 | 1),
  );

  let nPos = 0;
  let nNeg = 0;
  for (const o of obs) if (o.correct) nPos++; else nNeg++;
  const aucDefined = nPos > 0 && nNeg > 0;

  const degenerate = n >= 2 && (positiveRate === 0 || positiveRate === 1);
  const antiCorrelated = aucDefined && auc < ANTI_CORRELATION_AUC_THRESHOLD;
  const informative = !degenerate && !antiCorrelated;

  return { verifierId, armId, n, brier, ece, auc, positiveRate, informative, antiCorrelated };
}

// ---------------------------------------------------------------------------
// Options resolution
// ---------------------------------------------------------------------------

interface ResolvedOptions {
  table: Record<string, { tier: TierId; prior: number }>;
  minSamplesArm: number;
  minSamplesVerifier: number;
  eceBins: number;
  halfLifeMs: number;
  shrinkage: number;
}

function resolveOptions(opts: CalibratorOptions): ResolvedOptions {
  const table = opts.table ?? calibrationTable();
  if (typeof table !== "object" || table === null) {
    throw new CalibrationError("CalibratorOptions.table must be an object", "invalid-option");
  }

  const minSamplesArm = opts.minSamplesArm ?? 8;
  if (!Number.isInteger(minSamplesArm) || minSamplesArm < 1) {
    throw new CalibrationError(`minSamplesArm must be a positive integer, got ${minSamplesArm}`, "invalid-option");
  }

  const minSamplesVerifier = opts.minSamplesVerifier ?? 20;
  if (!Number.isInteger(minSamplesVerifier) || minSamplesVerifier < 1) {
    throw new CalibrationError(`minSamplesVerifier must be a positive integer, got ${minSamplesVerifier}`, "invalid-option");
  }

  const eceBins = opts.eceBins ?? 10;
  if (!Number.isInteger(eceBins) || eceBins < 1) {
    throw new CalibrationError(`eceBins must be a positive integer, got ${eceBins}`, "invalid-option");
  }

  const halfLifeMs = opts.halfLifeMs ?? Infinity;
  if (typeof halfLifeMs !== "number" || Number.isNaN(halfLifeMs) || halfLifeMs <= 0) {
    throw new CalibrationError(`halfLifeMs must be a number > 0 (or Infinity), got ${halfLifeMs}`, "invalid-option");
  }

  const shrinkage = opts.shrinkage ?? 5;
  if (!Number.isFinite(shrinkage) || shrinkage < 0) {
    throw new CalibrationError(`shrinkage must be a finite number >= 0, got ${shrinkage}`, "invalid-option");
  }

  return { table, minSamplesArm, minSamplesVerifier, eceBins, halfLifeMs, shrinkage };
}

/**
 * Canonical ordering for a multiset of observations, independent of
 * insertion order. Floating-point summation is not associative, so
 * `computeQuality`/`brierDecomposition`/`eceFromPoints`/`isotonicFit`'s
 * internal sums could otherwise differ in their last bit or two depending
 * on which order the SAME set of numbers was added in. Sorting into a fixed
 * canonical order before any summation makes every downstream sum operate
 * on the identical sequence regardless of how the caller called `observe()`,
 * which is what gives this module its determinism guarantee (item 8 of the
 * comprehensiveness bar): identical multisets, different insertion order,
 * bit-identical `fit()` output.
 */
function canonicalOrder(list: ReadonlyArray<VerifierObservation>): VerifierObservation[] {
  return [...list].sort(
    (a, b) =>
      a.score - b.score ||
      a.at - b.at ||
      Number(a.correct) - Number(b.correct) ||
      Number(a.passed) - Number(b.passed) ||
      a.verifierId.localeCompare(b.verifierId) ||
      a.armId.localeCompare(b.armId),
  );
}

// ---------------------------------------------------------------------------
// PerVerifierCalibrator
// ---------------------------------------------------------------------------

export class PerVerifierCalibrator {
  private readonly opts: ResolvedOptions;
  private readonly raw = new Map<string, Map<string, VerifierObservation[]>>();
  private readonly armsWithData = new Set<string>();

  private armFits = new Map<string, IsotonicFit>();
  private verifierFits = new Map<string, IsotonicFit>();
  private armQuality = new Map<string, VerifierQuality>();
  private verifierQuality = new Map<string, VerifierQuality>();

  private fitted = false;
  private lastFitAt: number | null = null;

  constructor(opts: CalibratorOptions = {}) {
    this.opts = resolveOptions(opts);
  }

  observe(o: VerifierObservation): void {
    if (!o || typeof o !== "object") {
      throw new CalibrationError("observe: observation must be an object", "malformed-observation");
    }
    if (typeof o.verifierId !== "string" || o.verifierId.length === 0) {
      throw new CalibrationError("observe: verifierId must be a non-empty string", "invalid-verifier-id");
    }
    if (typeof o.armId !== "string" || o.armId.length === 0) {
      throw new CalibrationError("observe: armId must be a non-empty string", "invalid-arm-id");
    }
    assertSafeKey("verifierId", o.verifierId);
    assertSafeKey("armId", o.armId);
    if (typeof o.score !== "number" || !Number.isFinite(o.score)) {
      throw new CalibrationError(`observe: score must be a finite number, got ${o.score}`, "invalid-score");
    }
    if (o.score < 0 || o.score > 1) {
      throw new CalibrationError(`observe: score must be in [0,1], got ${o.score}`, "score-out-of-range");
    }
    if (typeof o.passed !== "boolean") {
      throw new CalibrationError("observe: passed must be a boolean", "invalid-flag");
    }
    if (typeof o.correct !== "boolean") {
      throw new CalibrationError("observe: correct must be a boolean", "invalid-flag");
    }
    if (typeof o.at !== "number" || !Number.isFinite(o.at)) {
      throw new CalibrationError(`observe: at must be a finite number, got ${o.at}`, "invalid-timestamp");
    }

    let armMap = this.raw.get(o.verifierId);
    if (!armMap) {
      armMap = new Map();
      this.raw.set(o.verifierId, armMap);
    }
    let list = armMap.get(o.armId);
    if (!list) {
      list = [];
      armMap.set(o.armId, list);
    }
    list.push({ verifierId: o.verifierId, armId: o.armId, score: o.score, passed: o.passed, correct: o.correct, at: o.at });
    this.armsWithData.add(o.armId);
    // New evidence invalidates the previous fit -- `calibrate()` must not
    // silently keep serving a now-stale curve.
    this.fitted = false;
  }

  /** Idempotent: recomputes every PAVA fit + quality metric from the full
   *  observation history, deterministically, as of `now`. */
  fit(now: number): void {
    if (typeof now !== "number" || !Number.isFinite(now)) {
      throw new CalibrationError(`fit: now must be a finite number, got ${now}`, "invalid-now");
    }

    const armFits = new Map<string, IsotonicFit>();
    const verifierFits = new Map<string, IsotonicFit>();
    const armQuality = new Map<string, VerifierQuality>();
    const verifierQuality = new Map<string, VerifierQuality>();

    const verifierIds = Array.from(this.raw.keys()).sort();
    for (const vId of verifierIds) {
      const armMap = this.raw.get(vId)!;
      const armIds = Array.from(armMap.keys()).sort();
      const pooled: VerifierObservation[] = [];
      for (const aId of armIds) {
        // Canonicalize BEFORE any summation (isotonicFit's x-grouping,
        // brierDecomposition, eceFromPoints, computeAUC) so the result is
        // identical regardless of the order `observe()` was called in --
        // floating-point addition is not associative.
        const obsList = canonicalOrder(armMap.get(aId)!);
        pooled.push(...obsList);
        const points = obsList.map((o) => ({ x: o.score, y: o.correct ? 1 : 0, w: decayWeight(o.at, now, this.opts.halfLifeMs) }));
        armFits.set(pairKey(vId, aId), isotonicFit(points));
        armQuality.set(pairKey(vId, aId), computeQuality(vId, aId, obsList, now, this.opts.eceBins, this.opts.halfLifeMs));
      }
      const canonicalPooled = canonicalOrder(pooled);
      const vPoints = canonicalPooled.map((o) => ({ x: o.score, y: o.correct ? 1 : 0, w: decayWeight(o.at, now, this.opts.halfLifeMs) }));
      verifierFits.set(vId, isotonicFit(vPoints));
      verifierQuality.set(vId, computeQuality(vId, null, canonicalPooled, now, this.opts.eceBins, this.opts.halfLifeMs));
    }

    this.armFits = armFits;
    this.verifierFits = verifierFits;
    this.armQuality = armQuality;
    this.verifierQuality = verifierQuality;
    this.fitted = true;
    this.lastFitAt = now;
  }

  private tierPriorFor(verifierId: string): { tier: TierId; prior: number } {
    const entry = this.opts.table[verifierId];
    if (!entry) return { tier: "T4-consistency", prior: 0.5 };
    return { tier: entry.tier, prior: clamp01(entry.prior) };
  }

  calibrate(verifierId: string, armId: string, score: number): CalibratedScore {
    const warnings: string[] = [];
    let s = score;
    if (!Number.isFinite(s)) {
      warnings.push("raw score was not finite; clamped for prediction");
      s = 0;
    } else if (s < 0 || s > 1) {
      warnings.push("raw score outside [0,1]; clamped for prediction");
      s = clamp01(s);
    }

    const { tier, prior: tierPrior } = this.tierPriorFor(verifierId);

    const finish = (pCorrect: number, source: CalibrationSource, n: number, informative: boolean): CalibratedScore => {
      const clamped = clamp01(pCorrect);
      const floor = tierConfidenceFloor(tier, DEFAULT_BASE_EPSILON);
      const w = [...warnings];
      if (clamped < floor) {
        w.push(`pCorrect ${clamped.toFixed(4)} is below this tier's confidence floor ${floor.toFixed(4)}`);
      }
      return { verifierId, armId, rawScore: score, pCorrect: clamped, source, n, tier, informative, warnings: w };
    };

    if (!this.fitted) {
      warnings.push("calibrator has not been fit (or new observations arrived since the last fit); returning the tier prior");
      return finish(tierPrior, "tier-prior", 0, false);
    }

    const armKey = pairKey(verifierId, armId);
    const armObsN = this.raw.get(verifierId)?.get(armId)?.length ?? 0;
    const armQ = this.armQuality.get(armKey);
    const verifierObsN = Array.from(this.raw.get(verifierId)?.values() ?? []).reduce((acc, l) => acc + l.length, 0);
    const verifierQ = this.verifierQuality.get(verifierId);

    if (armObsN >= this.opts.minSamplesArm) {
      if (armQ && armQ.informative && !armQ.antiCorrelated) {
        const armFit = this.armFits.get(armKey)!;
        const raw = armFit.predict(s);
        const parent =
          verifierObsN >= this.opts.minSamplesVerifier && verifierQ && verifierQ.informative && !verifierQ.antiCorrelated
            ? this.verifierFits.get(verifierId)!.predict(s)
            : tierPrior;
        const blended = shrinkageBlend(armObsN, raw, parent, this.opts.shrinkage);
        return finish(blended, "verifier+arm", armObsN, true);
      }
      warnings.push("this verifier's signal for this arm is degenerate or anti-correlated with correctness; using the tier prior instead");
      return finish(tierPrior, "uninformative", armObsN, false);
    }

    if (verifierObsN >= this.opts.minSamplesVerifier) {
      if (verifierQ && verifierQ.informative && !verifierQ.antiCorrelated) {
        const vFit = this.verifierFits.get(verifierId)!;
        const raw = vFit.predict(s);
        const blended = shrinkageBlend(verifierObsN, raw, tierPrior, this.opts.shrinkage);
        return finish(blended, "verifier", verifierObsN, true);
      }
      warnings.push("this verifier's pooled signal is degenerate or anti-correlated with correctness; using the tier prior instead");
      return finish(tierPrior, "uninformative", verifierObsN, false);
    }

    if (armObsN > 0 || verifierObsN > 0) {
      warnings.push(`insufficient samples for a (verifier,arm) or (verifier)-level fit (arm n=${armObsN}, verifier n=${verifierObsN})`);
    }
    return finish(tierPrior, "tier-prior", armObsN, false);
  }

  quality(verifierId: string, armId?: string): VerifierQuality | undefined {
    if (armId !== undefined) return this.armQuality.get(pairKey(verifierId, armId));
    return this.verifierQuality.get(verifierId);
  }

  /** One entry per verifier that has ever been observed (pooled across all
   *  its arms, `armId: null`), sorted by `verifierId` -- deterministic
   *  regardless of observation insertion order. */
  report(): VerifierQuality[] {
    return Array.from(this.verifierQuality.keys())
      .sort()
      .map((id) => this.verifierQuality.get(id)!);
  }

  ensembleProbability(armId: string, votes: readonly ScoredVote[]): EnsembleProbability {
    if (!Array.isArray(votes) || votes.length === 0) {
      return {
        pCorrect: 0.5,
        weights: {},
        agreement: 0.5,
        source: this.armsWithData.has(armId) ? "calibrated" : "label-free-ensemble",
        usedVerifiers: [],
        droppedVerifiers: [],
      };
    }

    // No ground truth has ever been recorded for this arm -- there is
    // nothing to calibrate against, so fall back to the REAL label-free
    // (Dawid-Skene-style) weak-verifier ensemble. It has no cross-item
    // agreement history to learn from here (a single vote-set is one EM
    // "item"), so its reliabilities collapse to agreement-with-this-item's-
    // own-consensus -- an honest, deterministic use of the real algorithm
    // rather than a fabricated number.
    if (!this.armsWithData.has(armId)) {
      const ensemble = new WeakVerifierEnsemble();
      const item: VerifierVote[] = votes.map((v) => ({ verifierId: v.verifierId, passed: v.passed }));
      const [result] = ensemble.fitPredict([item]);
      const usedVerifiers = Object.keys(result.weights).filter((id) => (result.weights[id] ?? 0) > 0);
      const droppedVerifiers = Object.keys(result.weights).filter((id) => !((result.weights[id] ?? 0) > 0));
      return {
        pCorrect: clamp01(result.score),
        weights: result.weights,
        agreement: result.agreement,
        source: "label-free-ensemble",
        usedVerifiers,
        droppedVerifiers,
      };
    }

    const used: string[] = [];
    const dropped: string[] = [];
    const weights: Record<string, number> = {};
    let weightedSum = 0;
    let weightTotal = 0;

    for (const v of votes) {
      const cs = this.calibrate(v.verifierId, armId, v.score);
      const q = this.armQuality.get(pairKey(v.verifierId, armId)) ?? this.verifierQuality.get(v.verifierId);
      let w: number;
      if (q && (!q.informative || q.antiCorrelated)) {
        w = 0;
        dropped.push(v.verifierId);
      } else if (q) {
        // Weight by how far this verifier's discrimination sits from chance
        // (AUC=0.5): a near-perfect discriminator (AUC~1) gets full weight,
        // a barely-informative one gets a small but nonzero weight.
        w = clamp01(Math.abs(q.auc - 0.5) * 2);
        used.push(v.verifierId);
      } else {
        // Never observed at all -- unproven, not adversarial. Give it a
        // neutral, modest weight rather than either full trust or a drop.
        w = 0.5;
        used.push(v.verifierId);
      }
      weights[v.verifierId] = w;
      weightedSum += w * cs.pCorrect;
      weightTotal += w;
    }

    if (weightTotal <= 0) {
      // Every voting verifier was dropped as bad -- fully degraded: average
      // their (already tier-prior-bounded) calibrated estimates.
      const avg = votes.reduce((acc, v) => acc + this.calibrate(v.verifierId, armId, v.score).pCorrect, 0) / votes.length;
      return {
        pCorrect: clamp01(avg),
        weights,
        agreement: rawAgreement(votes),
        source: "tier-prior",
        usedVerifiers: [],
        droppedVerifiers: dropped,
      };
    }

    const pCorrect = clamp01(weightedSum / weightTotal);
    const usedVotes = votes.filter((v) => used.includes(v.verifierId));
    const agreement = usedVotes.length > 0 ? rawAgreement(usedVotes) : rawAgreement(votes);
    return { pCorrect, weights, agreement, source: "calibrated", usedVerifiers: used, droppedVerifiers: dropped };
  }

  snapshot(): CalibratorSnapshot {
    const observations: SnapshotObservation[] = [];
    for (const vId of Array.from(this.raw.keys()).sort()) {
      const armMap = this.raw.get(vId)!;
      for (const aId of Array.from(armMap.keys()).sort()) {
        for (const o of armMap.get(aId)!) {
          observations.push({ verifierId: o.verifierId, armId: o.armId, score: o.score, passed: o.passed, correct: o.correct, at: o.at });
        }
      }
    }

    const fits: SnapshotFitEntry[] = [];
    if (this.fitted) {
      for (const vId of Array.from(this.verifierFits.keys()).sort()) {
        fits.push({ id: vId, armId: null, knots: this.verifierFits.get(vId)!.knots.map((k) => ({ ...k })) });
      }
      for (const k of Array.from(this.armFits.keys()).sort()) {
        const [vId, aId] = splitPairKey(k);
        fits.push({ id: vId, armId: aId, knots: this.armFits.get(k)!.knots.map((x) => ({ ...x })) });
      }
    }

    return { version: 1, fitted: this.fitted, fitAt: this.lastFitAt, observations, fits };
  }

  /** Reconstructs a calibrator from `snapshot()` output. Hostile-input
   *  hardened: wrong version, non-finite/out-of-range scores, non-monotone
   *  injected knots, prototype-pollution-shaped ids, and duplicate
   *  verifier/arm ids in the `fits` array are each rejected with a distinct
   *  `CalibrationError.code`, before any state is reconstructed. Embedded
   *  `fits` knots are validated for structural integrity but NEVER trusted
   *  directly -- state is always rebuilt by replaying `observations`
   *  through the normal `observe()` path and (if `fitted`) re-running
   *  `fit(fitAt)`, so a snapshot can only ever reconstruct a calibrator that
   *  is reachable via the real, validated API. */
  static restore(snap: unknown, opts?: CalibratorOptions): PerVerifierCalibrator {
    if (typeof snap !== "object" || snap === null || Array.isArray(snap)) {
      throw new CalibrationError("restore: snapshot must be a plain object", "malformed-snapshot");
    }
    const s = snap as Record<string, unknown>;

    if (s.version !== 1) {
      throw new CalibrationError(`restore: unsupported snapshot version ${JSON.stringify(s.version)}`, "unsupported-version");
    }
    if (typeof s.fitted !== "boolean") {
      throw new CalibrationError("restore: snapshot.fitted must be a boolean", "malformed-snapshot");
    }
    if (s.fitAt !== null && typeof s.fitAt !== "number") {
      throw new CalibrationError("restore: snapshot.fitAt must be a number or null", "malformed-snapshot");
    }
    if (!Array.isArray(s.observations)) {
      throw new CalibrationError("restore: snapshot.observations must be an array", "malformed-snapshot");
    }
    if (!Array.isArray(s.fits)) {
      throw new CalibrationError("restore: snapshot.fits must be an array", "malformed-snapshot");
    }

    // Validate `fits` (never trusted for state, but validated as a hostile
    // surface: duplicate ids, unsafe keys, non-finite/out-of-range knots,
    // non-monotone knot sequences).
    const seenFitIds = new Set<string>();
    for (const rawFit of s.fits) {
      if (typeof rawFit !== "object" || rawFit === null) {
        throw new CalibrationError("restore: malformed entry in snapshot.fits", "malformed-snapshot");
      }
      const f = rawFit as Record<string, unknown>;
      if (typeof f.id !== "string" || (f.armId !== null && typeof f.armId !== "string")) {
        throw new CalibrationError("restore: fits[].id/armId must be string/(string|null)", "malformed-snapshot");
      }
      assertSafeKey("fits[].id", f.id);
      if (typeof f.armId === "string") assertSafeKey("fits[].armId", f.armId);

      const composite = `${f.id}\u0000${f.armId ?? ""}`;
      if (seenFitIds.has(composite)) {
        throw new CalibrationError(`restore: duplicate (verifier,arm) entry in snapshot.fits: ${composite}`, "duplicate-verifier-id");
      }
      seenFitIds.add(composite);

      if (!Array.isArray(f.knots)) {
        throw new CalibrationError("restore: fits[].knots must be an array", "malformed-snapshot");
      }
      let prevX = -Infinity;
      let prevY = -Infinity;
      for (const rawKnot of f.knots) {
        if (typeof rawKnot !== "object" || rawKnot === null) {
          throw new CalibrationError("restore: malformed knot in snapshot.fits", "malformed-snapshot");
        }
        const kk = rawKnot as Record<string, unknown>;
        const x = kk.x;
        const y = kk.y;
        if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
          throw new CalibrationError("restore: knot.x/knot.y must be finite numbers", "invalid-score");
        }
        if (x < 0 || x > 1 || y < 0 || y > 1) {
          throw new CalibrationError("restore: knot.x/knot.y must be in [0,1]", "score-out-of-range");
        }
        if (x < prevX || y < prevY) {
          throw new CalibrationError("restore: snapshot.fits knots are not non-decreasing", "non-monotone-knots");
        }
        prevX = x;
        prevY = y;
      }
    }

    const calibrator = new PerVerifierCalibrator(opts);

    for (const rawObs of s.observations) {
      if (typeof rawObs !== "object" || rawObs === null) {
        throw new CalibrationError("restore: malformed entry in snapshot.observations", "malformed-snapshot");
      }
      const o = rawObs as Record<string, unknown>;
      if (typeof o.verifierId !== "string" || typeof o.armId !== "string") {
        throw new CalibrationError("restore: observations[].verifierId/armId must be strings", "malformed-snapshot");
      }
      if (typeof o.score !== "number" || !Number.isFinite(o.score)) {
        throw new CalibrationError("restore: observations[].score must be a finite number", "invalid-score");
      }
      if (o.score < 0 || o.score > 1) {
        throw new CalibrationError("restore: observations[].score must be in [0,1]", "score-out-of-range");
      }
      if (typeof o.passed !== "boolean" || typeof o.correct !== "boolean") {
        throw new CalibrationError("restore: observations[].passed/correct must be booleans", "malformed-snapshot");
      }
      if (typeof o.at !== "number" || !Number.isFinite(o.at)) {
        throw new CalibrationError("restore: observations[].at must be a finite number", "malformed-snapshot");
      }
      // `observe()` re-validates (including the unsafe-key check) and
      // throws its own CalibrationError-coded errors -- reused as-is.
      calibrator.observe({
        verifierId: o.verifierId,
        armId: o.armId,
        score: o.score,
        passed: o.passed,
        correct: o.correct,
        at: o.at,
      });
    }

    if (s.fitted) {
      if (typeof s.fitAt !== "number") {
        throw new CalibrationError("restore: a fitted snapshot must carry a numeric fitAt", "malformed-snapshot");
      }
      calibrator.fit(s.fitAt);
    }

    return calibrator;
  }
}
