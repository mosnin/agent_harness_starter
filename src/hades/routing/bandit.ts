/**
 * BudgetedRouterBandit — Phase 16: a seeded, contextual Thompson-sampling
 * bandit that routes a task to the opaque arm (`armId: string`, supplied by
 * the caller — this module knows nothing about backends, models, or any
 * other Phase-16 team's routing policy) that maximises MEASURED
 * verified-throughput-per-dollar, subject to a HARD dollar budget enforced
 * via a Lagrangian (bandits-with-knapsacks-style) dual price.
 *
 * This module is deliberately narrow: it composes nothing from
 * `../backends/**` (hard-banned — `backends/route-bandit.ts` is a different,
 * UCB1-over-BackendManager policy and shares no code, algorithm, or state
 * with this one) and imports only {@link TaskSignals} from `../styx/tiers`
 * for the context type. Every other input — candidate arms, per-arm cost
 * estimates, and outcome telemetry — is supplied by the caller.
 *
 * ===========================================================================
 * LOCKED ALGORITHM (implemented exactly as described below)
 * ===========================================================================
 *
 * 1. HIERARCHICAL POSTERIOR ON P(verified). For every (arm, context-bucket)
 *    pair we keep a Beta(alpha, beta) posterior, where `context-bucket` is
 *    `fnv1a(ctx.category) % contextBuckets` (a small, fixed-cardinality hash
 *    bucket — this bounds memory and lets semantically-close categories that
 *    collide share statistics, which is a *feature*, not an approximation
 *    error, at the bucket counts this module targets). Each pull increments
 *    `pulls` and, if verified, `verified`, at BOTH the bucket level and the
 *    arm's GLOBAL level (the aggregate across every bucket that arm has ever
 *    been pulled in).
 *
 *    Before use, the bucket-level (alpha, beta) is SHRUNK toward the arm's
 *    global (alpha, beta) by the configured `shrinkage` in [0, 1]:
 *
 *        effAlpha = (1 - shrinkage) * bucketAlpha + shrinkage * globalAlpha
 *        effBeta  = (1 - shrinkage) * bucketBeta  + shrinkage * globalBeta
 *
 *    shrinkage = 0 -> pure per-bucket posterior (no borrowing).
 *    shrinkage = 1 -> pure global posterior (bucket signal ignored).
 *    A never-before-seen category hashes into a bucket with zero pulls, so
 *    its bucket posterior IS the prior — shrinkage then pulls the effective
 *    posterior toward the arm's GLOBAL posterior instead of a flat 0.5,
 *    exactly the "cold categories borrow strength from the global" property
 *    this module is required to have.
 *
 *    `alpha`/`beta` at zero pulls are seeded from a Beta prior parameterised
 *    by `priorPulls` (pseudo-observations) and `priorPVerified` (prior mean):
 *    `priorAlpha = priorPVerified * priorPulls`, `priorBeta = (1 -
 *    priorPVerified) * priorPulls`, both floored at a tiny epsilon so the
 *    Beta distribution stays well-defined even at `priorPulls = 0`.
 *
 * 2. COST / LATENCY POSTERIORS. `meanUsd` and `meanWallMs` are plain
 *    MEASURED running means of `BanditOutcome.usd` / `BanditOutcome.wallMs`
 *    (arm-global, and per-bucket) — no Bayesian smoothing, just arithmetic
 *    means — but every USE of a mean (or of a caller-supplied cost estimate)
 *    is passed through an explicit floor, `USD_FLOOR` / `MS_FLOOR`, before it
 *    can appear as a divisor. This is the sole and complete defence against
 *    an arm reporting (or a caller estimating) a cost/latency of `0` driving
 *    any score to `Infinity`.
 *
 * 3. THE INDEX. For a candidate arm, given a Thompson draw `sampledP ~
 *    Beta(effAlpha, effBeta)` (via an in-file seeded PRNG, see below):
 *
 *        index = sampledP / max(usdEstimate, USD_FLOOR)
 *                          / max(wallMsEstimate, MS_FLOOR)
 *                - lambda * usdEstimate
 *
 *    `usdEstimate` is the caller's `estimateUsd(armId)`, itself clamped to
 *    `>= USD_FLOOR` (a non-finite or throwing estimator falls back to that
 *    arm's measured mean cost, or `USD_FLOOR` if there is none yet).
 *    `wallMsEstimate` is the arm's measured `meanWallMs` (bucket if the
 *    bucket has pulls, else global, else `MS_FLOOR`) — `select()` takes no
 *    latency-estimate parameter, so the ONLY source of a latency estimate is
 *    this module's own measured history. `lambda * usdEstimate` is the
 *    Lagrangian shadow price: it does not change the ranking of arms with
 *    equal cost, but penalises the more expensive of two arms with similar
 *    verified-per-dollar-per-ms merit, which is what keeps the bandit from
 *    picking a "moderately better, dramatically pricier" arm once money is
 *    tight.
 *
 * 4. THE DUAL (lambda). This is a primal-dual / bandits-with-knapsacks-style
 *    online gradient ascent with NO horizon parameter. After every
 *    `update()` (a real, measured spend), let `paceBefore = spentUsd /
 *    pullsSoFar` computed from the state BEFORE this outcome is folded in
 *    (the running average $/pull to date). Under a stationary spend-rate
 *    assumption this average IS the "remaining-budget pace": if the process
 *    keeps spending at exactly `paceBefore` per pull it exhausts
 *    `budgetRemainingUsd` in exactly `budgetRemainingUsd / paceBefore` more
 *    pulls — which is precisely the number of pulls the historical rate
 *    already implies, so no separate horizon input is needed. The gradient
 *    is this pull's `usd` minus that pace:
 *
 *        gradient = usd - paceBefore                 (0 on the very first pull)
 *        gradient += usd   IF this single pull's usd exceeds the budget
 *                          remaining before it (an emergency brake so one
 *                          outlier-expensive pull near exhaustion snaps
 *                          lambda up hard rather than drifting up slowly)
 *        lambda   = clamp(lambda + lambdaStep * gradient, 0, lambdaMax)
 *
 *    Spending faster than the established pace pushes lambda UP (future
 *    picks get penalised for cost, cooling burn); spending slower pulls
 *    lambda DOWN (the dual relaxes, willing to explore/spend more). This is
 *    exactly the "neither burn the budget early nor hoard it" behaviour
 *    bandits-with-knapsacks duals are built to produce, without assuming a
 *    fixed number of rounds.
 *
 * 5. FORCED EXPLORATION. Every arm in a `select()` candidate set that has
 *    ZERO recorded pulls (arm-global, across every context) is force-picked
 *    — deterministically, the lexicographically smallest such arm id — with
 *    NO Thompson draw consumed (no PRNG call at all on that path), before
 *    any Thompson competition happens. This guarantees the documented "cold
 *    start" property and keeps forced-exploration decisions independent of
 *    PRNG stream position.
 *
 * 6. BUDGET EXHAUSTION. If `budgetRemainingUsd <= 0`, `select()` does not
 *    return `null` and does not throw: it deterministically returns the
 *    candidate with the lowest available cost estimate (ties broken
 *    lexicographically), reason `"budget-shadow-priced"`. This is a
 *    *signal*, not an enforcement mechanism — the module never fabricates a
 *    spend cap by refusing to answer; a caller that wants a hard stop reads
 *    `budgetRemainingUsd` and stops calling `update()` with real spend once
 *    it is exhausted. `spentUsd()` is always the literal sum of every
 *    `usd` ever passed to `update()`, so a caller can never be surprised by
 *    hidden accounting.
 *
 * 7. RANDOMNESS. The ONLY source of randomness anywhere in this module is an
 *    in-file seeded xorshift128 PRNG (`Xorshift128`, seeded via a splitmix32
 *    expansion of the integer `seed` into four non-zero 32-bit state words).
 *    `Math.random` and `Date.now` are never called anywhere in this file.
 *    Beta draws are produced from two Gamma(shape, 1) draws (`x / (x + y)`),
 *    Gamma draws via Marsaglia–Tsang (boosted for shape < 1 via the standard
 *    `Gamma(a) = Gamma(a+1) * U^(1/a)` identity), and Gamma's normal variates
 *    via Box–Muller — all consuming uniforms exclusively from the seeded
 *    PRNG. The PRNG counts every raw draw it produces (`draws`), which is
 *    exactly what `snapshot()`/`restore()` persist and replay to make a
 *    resumed bandit continue the identical decision sequence.
 *
 * ===========================================================================
 * NON-EXPLOITABILITY
 * ===========================================================================
 * `update()` validates every numeric field of `BanditOutcome` and THROWS a
 * typed {@link BanditStateError} for `usd`/`wallMs`/`fannedOut` that is
 * `NaN`, `Infinity`/`-Infinity`, or negative — these are not "extreme
 * measurements", they are malformed telemetry, and are rejected rather than
 * folded into a posterior. Legitimate-but-extreme values (`usd: 0`, `usd:
 * 1e-12`) ARE accepted (a task genuinely can cost nothing), but every
 * consumer of a mean/estimate derived from them runs it through `USD_FLOOR`
 * / `MS_FLOOR` before it can appear as a divisor, so no accepted value —
 * however small — can drive `index` to `Infinity` and no rejected value can
 * silently corrupt a posterior.
 */

import type { TaskSignals } from "../styx/tiers";

// ===========================================================================
// Exported contract types (locked)
// ===========================================================================

export interface RoutingContext {
  taskId: string;
  category: string;
  difficulty: number; // [0,1]
  decomposable: boolean;
  signals: TaskSignals;
  promptTokens: number;
}

export interface BanditOutcome {
  armId: string;
  context: RoutingContext;
  verified: boolean;
  usd: number;
  wallMs: number;
  fannedOut: number; // extra arms pulled, >=0
}

export interface ArmPosterior {
  armId: string;
  pulls: number;
  verified: number;
  alpha: number;
  beta: number;
  meanUsd: number;
  meanWallMs: number;
  pVerifiedMean: number;
  measuredVtphPerDollar: number;
}

export type SelectionReason =
  | "forced-exploration"
  | "thompson"
  | "budget-shadow-priced"
  | "only-candidate"
  | "no-candidates";

export interface Selection {
  armId: string | null;
  reason: SelectionReason;
  sampledScore: number;
  ranked: ReadonlyArray<{ armId: string; sampledScore: number; shadowCost: number }>;
  lambda: number;
  budgetRemainingUsd: number;
}

export interface BanditOptions {
  seed: number;
  budgetUsd: number;
  priorPulls?: number;
  priorPVerified?: number;
  lambdaStep?: number;
  lambdaMax?: number;
  contextBuckets?: number;
  shrinkage?: number;
}

export interface BanditSnapshot {
  version: 1;
  seed: number;
  draws: number;
  spentUsd: number;
  lambda: number;
  arms: Array<{
    armId: string;
    globalPulls: number;
    globalVerified: number;
    globalUsdSum: number;
    globalWallMsSum: number;
    globalFannedOutSum: number;
    buckets: Array<{
      bucket: number;
      pulls: number;
      verified: number;
      usdSum: number;
      wallMsSum: number;
      fannedOutSum: number;
    }>;
  }>;
}

export class BanditStateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BanditStateError";
    this.code = code;
  }
}

// ===========================================================================
// Numeric floors — the entire defence against a 0/tiny cost or latency
// driving any index to Infinity.
// ===========================================================================

const USD_FLOOR = 0.0001; // $0.0001 — a hundredth of a cent
const MS_FLOOR = 10; // 10ms

// ===========================================================================
// Seeded PRNG — xorshift128 (Marsaglia), seeded via a splitmix32 expansion.
// The ONLY source of randomness in this module. No Math.random, no Date.now.
// ===========================================================================

/** splitmix32: deterministic uint32 stream generator, used only to expand a
 *  single integer seed into four well-mixed, non-zero xorshift128 state
 *  words (xorshift's state must never be all-zero). */
function splitmix32(seed: number): () => number {
  let a = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Classic 4-word xorshift128 (Marsaglia, "Xorshift RNGs", 2003). Period
 *  2^128 - 1. Tracks the total count of raw 32-bit draws it has produced
 *  (`draws`) so a snapshot can be replayed to the exact same stream
 *  position by discarding that many draws again. */
class Xorshift128 {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  draws = 0;

  constructor(seed: number) {
    const sm = splitmix32(seed);
    // OR with a small constant guarantees a non-zero word even if splitmix32
    // happens to emit 0 for one of the four words.
    this.s0 = (sm() | 1) >>> 0;
    this.s1 = (sm() | 2) >>> 0;
    this.s2 = (sm() | 4) >>> 0;
    this.s3 = (sm() | 8) >>> 0;
  }

  nextUint32(): number {
    let t = this.s3;
    const s = this.s0;
    this.s3 = this.s2;
    this.s2 = this.s1;
    this.s1 = s;
    t ^= t << 11;
    t ^= t >>> 8;
    t ^= s ^ (s >>> 19);
    this.s0 = t >>> 0;
    this.draws += 1;
    return this.s0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Discard `n` raw draws, replaying the state transitions without
   *  allocating — used by `restore()` to fast-forward to a persisted stream
   *  position. */
  skip(n: number): void {
    const k = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    for (let i = 0; i < k; i++) this.nextUint32();
  }
}

/** Box–Muller standard normal variate from two PRNG uniforms. */
function nextGaussian(rng: Xorshift128): number {
  let u = 0;
  let v = 0;
  // rng.next() is in [0,1); avoid log(0).
  while (u <= 1e-12) u = rng.next();
  while (v <= 1e-12) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) via Marsaglia–Tsang, boosted for shape < 1 via
 *  Gamma(a) = Gamma(a+1) * U^(1/a). `shape` is floored at a tiny epsilon so
 *  a pathological alpha/beta of 0 cannot loop forever or return NaN. */
function sampleGamma(shape: number, rng: Xorshift128): number {
  const a = Number.isFinite(shape) && shape > 1e-6 ? shape : 1e-6;
  if (a < 1) {
    const u = rng.next();
    return sampleGamma(a + 1, rng) * Math.pow(Math.max(u, 1e-12), 1 / a);
  }
  const d = a - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 1000; attempt++) {
    let x: number;
    let v: number;
    do {
      x = nextGaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.next();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v;
    if (Math.log(Math.max(u, 1e-300)) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
  }
  // Astronomically unlikely with a bounded loop; fall back to the mean.
  return d;
}

/** Beta(alpha, beta) via two Gamma draws. Guards the degenerate x+y===0
 *  case (both floored shapes underflowed to 0) with a neutral 0.5. */
function sampleBeta(alpha: number, beta: number, rng: Xorshift128): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  const sum = x + y;
  if (!Number.isFinite(sum) || sum <= 0) return 0.5;
  const p = x / sum;
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0.5;
}

// ===========================================================================
// Context bucketing — FNV-1a hash of category, mod contextBuckets. Pure,
// deterministic, unrelated to the PRNG stream.
// ===========================================================================

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bucketOf(category: unknown, contextBuckets: number): number {
  const n = Number.isFinite(contextBuckets) && contextBuckets >= 1 ? Math.floor(contextBuckets) : 1;
  const cat = typeof category === "string" ? category : String(category ?? "");
  return fnv1a(cat) % n;
}

// ===========================================================================
// Validation helpers
// ===========================================================================

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Throws prototype-pollution if `obj` (a plain object coming from
 *  untrusted `unknown` input, e.g. `JSON.parse`) carries any banned own
 *  key. Does not recurse — callers apply it at each level they unwrap. */
function assertNoBannedKeys(obj: object, where: string): void {
  for (const k of Object.keys(obj)) {
    if (BANNED_KEYS.has(k)) {
      throw new BanditStateError("prototype-pollution", `${where}: banned key "${k}"`);
    }
  }
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

// ===========================================================================
// Internal per-arm / per-bucket accounting
// ===========================================================================

interface BucketStats {
  pulls: number;
  verified: number;
  usdSum: number;
  wallMsSum: number;
  fannedOutSum: number;
}

function emptyStats(): BucketStats {
  return { pulls: 0, verified: 0, usdSum: 0, wallMsSum: 0, fannedOutSum: 0 };
}

interface ArmState {
  armId: string;
  global: BucketStats;
  buckets: Map<number, BucketStats>;
}

interface ResolvedOptions {
  seed: number;
  budgetUsd: number;
  priorPulls: number;
  priorPVerified: number;
  lambdaStep: number;
  lambdaMax: number;
  contextBuckets: number;
  shrinkage: number;
}

function resolveOptions(opts: BanditOptions): ResolvedOptions {
  if (!opts || typeof opts !== "object") {
    throw new BanditStateError("invalid-options", "BanditOptions must be an object");
  }
  if (!isFiniteNumber(opts.seed)) {
    throw new BanditStateError("invalid-options", `seed must be a finite number, got ${String(opts.seed)}`);
  }
  if (!isFiniteNumber(opts.budgetUsd) || opts.budgetUsd < 0) {
    throw new BanditStateError(
      "invalid-options",
      `budgetUsd must be a finite number >= 0, got ${String(opts.budgetUsd)}`,
    );
  }
  return {
    seed: opts.seed,
    budgetUsd: opts.budgetUsd,
    priorPulls: isFiniteNumber(opts.priorPulls) && opts.priorPulls >= 0 ? opts.priorPulls : 4,
    priorPVerified: isFiniteNumber(opts.priorPVerified) ? clamp(opts.priorPVerified, 0, 1) : 0.5,
    lambdaStep: isFiniteNumber(opts.lambdaStep) && opts.lambdaStep >= 0 ? opts.lambdaStep : 0.1,
    lambdaMax: isFiniteNumber(opts.lambdaMax) && opts.lambdaMax >= 0 ? opts.lambdaMax : 25,
    contextBuckets:
      isFiniteNumber(opts.contextBuckets) && opts.contextBuckets >= 1 ? Math.floor(opts.contextBuckets) : 32,
    shrinkage: isFiniteNumber(opts.shrinkage) ? clamp(opts.shrinkage, 0, 1) : 0.35,
  };
}

// ===========================================================================
// BudgetedRouterBandit
// ===========================================================================

export class BudgetedRouterBandit {
  private readonly opts: ResolvedOptions;
  private readonly rng: Xorshift128;
  private readonly arms = new Map<string, ArmState>();
  private readonly priorAlpha: number;
  private readonly priorBeta: number;

  private spentUsdTotal = 0;
  private overallPulls = 0;
  private lambdaVal = 0;

  constructor(opts: BanditOptions) {
    this.opts = resolveOptions(opts);
    this.rng = new Xorshift128(this.opts.seed);
    const eps = 1e-6;
    this.priorAlpha = Math.max(eps, this.opts.priorPVerified * this.opts.priorPulls);
    this.priorBeta = Math.max(eps, (1 - this.opts.priorPVerified) * this.opts.priorPulls);
  }

  // -------------------------------------------------------------------------
  // select
  // -------------------------------------------------------------------------

  select(ctx: RoutingContext, candidates: readonly string[], estimateUsd: (armId: string) => number): Selection {
    const budgetRemainingUsd = this.budgetRemainingUsd();

    const uniqueCandidates = this.dedupeCandidates(candidates);
    if (uniqueCandidates.length === 0) {
      return {
        armId: null,
        reason: "no-candidates",
        sampledScore: 0,
        ranked: [],
        lambda: this.lambdaVal,
        budgetRemainingUsd,
      };
    }

    const safeCtx = this.sanitizeContext(ctx);

    if (uniqueCandidates.length === 1) {
      const armId = uniqueCandidates[0];
      const usdEstimate = this.safeEstimateUsd(estimateUsd, armId);
      const score = this.meanIndex(armId, safeCtx, usdEstimate);
      const shadowCost = this.lambdaVal * usdEstimate;
      return {
        armId,
        reason: "only-candidate",
        sampledScore: score,
        ranked: [{ armId, sampledScore: score, shadowCost }],
        lambda: this.lambdaVal,
        budgetRemainingUsd,
      };
    }

    // Sort candidates lexicographically so PRNG consumption order (and thus
    // the whole decision) never depends on the order the caller listed
    // candidates in.
    const sorted = [...uniqueCandidates].sort();

    const unexplored = sorted.filter((armId) => (this.arms.get(armId)?.global.pulls ?? 0) === 0);
    if (unexplored.length > 0) {
      const armId = unexplored[0]; // lexicographically smallest, `sorted` is ascending
      const ranked = sorted.map((id) => {
        const u = this.safeEstimateUsd(estimateUsd, id);
        return { armId: id, sampledScore: this.meanIndex(id, safeCtx, u), shadowCost: this.lambdaVal * u };
      });
      const chosen = ranked.find((r) => r.armId === armId)!;
      return {
        armId,
        reason: "forced-exploration",
        sampledScore: chosen.sampledScore,
        ranked,
        lambda: this.lambdaVal,
        budgetRemainingUsd,
      };
    }

    if (budgetRemainingUsd <= 0) {
      let best: { armId: string; usd: number } | null = null;
      const ranked = sorted.map((id) => {
        const u = this.safeEstimateUsd(estimateUsd, id);
        if (best === null || u < best.usd || (u === best.usd && id < best.armId)) {
          best = { armId: id, usd: u };
        }
        return { armId: id, sampledScore: this.meanIndex(id, safeCtx, u), shadowCost: this.lambdaVal * u };
      });
      const winner = best as { armId: string; usd: number } | null;
      const armId = winner ? winner.armId : sorted[0];
      const chosen = ranked.find((r) => r.armId === armId)!;
      return {
        armId,
        reason: "budget-shadow-priced",
        sampledScore: chosen.sampledScore,
        ranked,
        lambda: this.lambdaVal,
        budgetRemainingUsd,
      };
    }

    // Normal Thompson competition.
    const ranked = sorted
      .map((id) => {
        const usdEstimate = this.safeEstimateUsd(estimateUsd, id);
        const wallMsEstimate = this.wallMsEstimateFor(id, safeCtx);
        const { alpha, beta } = this.shrunkAlphaBeta(id, safeCtx);
        const sampledP = sampleBeta(alpha, beta, this.rng);
        const usd = Math.max(usdEstimate, USD_FLOOR);
        const wallMs = Math.max(wallMsEstimate, MS_FLOOR);
        const score = sampledP / usd / wallMs - this.lambdaVal * usdEstimate;
        return {
          armId: id,
          sampledScore: Number.isFinite(score) ? score : 0,
          shadowCost: this.lambdaVal * usdEstimate,
        };
      })
      .sort((a, b) => (b.sampledScore !== a.sampledScore ? b.sampledScore - a.sampledScore : a.armId < b.armId ? -1 : 1));

    // Affordability preference: among arms whose estimate fits the remaining
    // budget, take the top-ranked one; only reach into the unaffordable set
    // if literally nothing fits (still never null/throws per contract).
    const affordable = ranked.filter((r) => this.safeEstimateUsd(estimateUsd, r.armId) <= budgetRemainingUsd);
    const winner = affordable.length > 0 ? affordable[0] : ranked[0];

    return {
      armId: winner.armId,
      reason: "thompson",
      sampledScore: winner.sampledScore,
      ranked,
      lambda: this.lambdaVal,
      budgetRemainingUsd,
    };
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  update(outcome: BanditOutcome): void {
    if (!outcome || typeof outcome !== "object") {
      throw new BanditStateError("invalid-outcome", "BanditOutcome must be an object");
    }
    if (typeof outcome.armId !== "string" || outcome.armId.length === 0) {
      throw new BanditStateError("invalid-arm-id", `armId must be a non-empty string, got ${String(outcome.armId)}`);
    }
    if (!isFiniteNumber(outcome.usd) || outcome.usd < 0) {
      throw new BanditStateError(
        "invalid-usd",
        `usd must be a finite number >= 0, got ${String(outcome.usd)} for arm "${outcome.armId}"`,
      );
    }
    if (!isFiniteNumber(outcome.wallMs) || outcome.wallMs < 0) {
      throw new BanditStateError(
        "invalid-wall-ms",
        `wallMs must be a finite number >= 0, got ${String(outcome.wallMs)} for arm "${outcome.armId}"`,
      );
    }
    if (!isFiniteNumber(outcome.fannedOut) || outcome.fannedOut < 0) {
      throw new BanditStateError(
        "invalid-fanned-out",
        `fannedOut must be a finite number >= 0, got ${String(outcome.fannedOut)} for arm "${outcome.armId}"`,
      );
    }
    const ctx = this.sanitizeContext(outcome.context, /*strict*/ true);
    const verified = Boolean(outcome.verified);

    const arm = this.getOrCreateArm(outcome.armId);
    const bucket = bucketOf(ctx.category, this.opts.contextBuckets);
    const bStats = arm.buckets.get(bucket) ?? emptyStats();

    bStats.pulls += 1;
    if (verified) bStats.verified += 1;
    bStats.usdSum += outcome.usd;
    bStats.wallMsSum += outcome.wallMs;
    bStats.fannedOutSum += outcome.fannedOut;
    arm.buckets.set(bucket, bStats);

    arm.global.pulls += 1;
    if (verified) arm.global.verified += 1;
    arm.global.usdSum += outcome.usd;
    arm.global.wallMsSum += outcome.wallMs;
    arm.global.fannedOutSum += outcome.fannedOut;

    // Dual gradient ascent on budget-burn vs. the established (== implied
    // remaining-budget) pace. See header doc section 4.
    const budgetRemainingBefore = this.budgetRemainingUsd();
    const paceBefore = this.overallPulls > 0 ? this.spentUsdTotal / this.overallPulls : outcome.usd;
    let gradient = this.overallPulls > 0 ? outcome.usd - paceBefore : 0;
    if (outcome.usd > budgetRemainingBefore) {
      gradient += outcome.usd;
    }
    this.lambdaVal = clamp(this.lambdaVal + this.opts.lambdaStep * gradient, 0, this.opts.lambdaMax);

    this.spentUsdTotal += outcome.usd;
    this.overallPulls += 1;
  }

  // -------------------------------------------------------------------------
  // posterior / lambda / spentUsd
  // -------------------------------------------------------------------------

  posterior(armId: string, ctx?: RoutingContext): ArmPosterior {
    const id = typeof armId === "string" ? armId : String(armId);
    const arm = this.arms.get(id);

    if (!ctx) {
      const global = arm?.global ?? emptyStats();
      const alpha = this.priorAlpha + global.verified;
      const beta = this.priorBeta + (global.pulls - global.verified);
      return this.buildPosterior(id, global, alpha, beta);
    }

    const safeCtx = this.sanitizeContext(ctx);
    const { alpha, beta } = this.shrunkAlphaBeta(id, safeCtx);
    const bucket = bucketOf(safeCtx.category, this.opts.contextBuckets);
    const bStats = arm?.buckets.get(bucket);
    const stats: BucketStats =
      bStats && bStats.pulls > 0 ? bStats : arm && arm.global.pulls > 0 ? arm.global : emptyStats();
    return this.buildPosterior(id, stats, alpha, beta);
  }

  lambda(): number {
    return this.lambdaVal;
  }

  spentUsd(): number {
    return this.spentUsdTotal;
  }

  budgetRemainingUsd(): number {
    return this.opts.budgetUsd - this.spentUsdTotal;
  }

  // -------------------------------------------------------------------------
  // snapshot / restore
  // -------------------------------------------------------------------------

  snapshot(): BanditSnapshot {
    return {
      version: 1,
      seed: this.opts.seed,
      draws: this.rng.draws,
      spentUsd: this.spentUsdTotal,
      lambda: this.lambdaVal,
      arms: Array.from(this.arms.values()).map((arm) => ({
        armId: arm.armId,
        globalPulls: arm.global.pulls,
        globalVerified: arm.global.verified,
        globalUsdSum: arm.global.usdSum,
        globalWallMsSum: arm.global.wallMsSum,
        globalFannedOutSum: arm.global.fannedOutSum,
        buckets: Array.from(arm.buckets.entries()).map(([bucket, s]) => ({
          bucket,
          pulls: s.pulls,
          verified: s.verified,
          usdSum: s.usdSum,
          wallMsSum: s.wallMsSum,
          fannedOutSum: s.fannedOutSum,
        })),
      })),
    };
  }

  static restore(snap: unknown, opts: BanditOptions): BudgetedRouterBandit {
    if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
      throw new BanditStateError("invalid-snapshot", "snapshot must be a non-null object");
    }
    assertNoBannedKeys(snap, "snapshot");
    const s = snap as Record<string, unknown>;

    if (s.version !== 1) {
      throw new BanditStateError("invalid-version", `unsupported snapshot version: ${String(s.version)}`);
    }
    if (!isFiniteNumber(s.seed)) {
      throw new BanditStateError("invalid-numeric", `snapshot.seed must be a finite number, got ${String(s.seed)}`);
    }
    if (!isFiniteNumber(s.draws) || s.draws < 0) {
      throw new BanditStateError("invalid-numeric", `snapshot.draws must be a finite number >= 0, got ${String(s.draws)}`);
    }
    if (!isFiniteNumber(s.spentUsd) || s.spentUsd < 0) {
      throw new BanditStateError(
        "invalid-numeric",
        `snapshot.spentUsd must be a finite number >= 0, got ${String(s.spentUsd)}`,
      );
    }
    if (!isFiniteNumber(s.lambda) || s.lambda < 0) {
      throw new BanditStateError("invalid-numeric", `snapshot.lambda must be a finite number >= 0, got ${String(s.lambda)}`);
    }
    if (!Array.isArray(s.arms)) {
      throw new BanditStateError("invalid-snapshot", "snapshot.arms must be an array");
    }

    const seenArmIds = new Set<string>();
    const parsedArms: Array<{ armId: string; global: BucketStats; buckets: Map<number, BucketStats> }> = [];

    for (const rawArm of s.arms) {
      if (!rawArm || typeof rawArm !== "object" || Array.isArray(rawArm)) {
        throw new BanditStateError("invalid-snapshot", "each snapshot.arms entry must be an object");
      }
      assertNoBannedKeys(rawArm, "snapshot.arms[]");
      const a = rawArm as Record<string, unknown>;

      if (typeof a.armId !== "string" || a.armId.length === 0) {
        throw new BanditStateError("invalid-snapshot", `snapshot.arms[].armId must be a non-empty string`);
      }
      if (seenArmIds.has(a.armId)) {
        throw new BanditStateError("duplicate-arm", `duplicate arm entry: "${a.armId}"`);
      }
      seenArmIds.add(a.armId);

      const global = parseBucketStats(a, "globalPulls", "globalVerified", "globalUsdSum", "globalWallMsSum", "globalFannedOutSum", `snapshot.arms["${a.armId}"]`);

      if (!Array.isArray(a.buckets)) {
        throw new BanditStateError("invalid-snapshot", `snapshot.arms["${a.armId}"].buckets must be an array`);
      }
      const buckets = new Map<number, BucketStats>();
      for (const rawBucket of a.buckets) {
        if (!rawBucket || typeof rawBucket !== "object" || Array.isArray(rawBucket)) {
          throw new BanditStateError("invalid-snapshot", `snapshot.arms["${a.armId}"].buckets[] must be an object`);
        }
        assertNoBannedKeys(rawBucket, `snapshot.arms["${a.armId}"].buckets[]`);
        const b = rawBucket as Record<string, unknown>;
        if (!isFiniteNumber(b.bucket) || b.bucket < 0) {
          throw new BanditStateError("invalid-numeric", `snapshot.arms["${a.armId}"].buckets[].bucket invalid`);
        }
        const stats = parseBucketStats(b, "pulls", "verified", "usdSum", "wallMsSum", "fannedOutSum", `snapshot.arms["${a.armId}"].buckets[${b.bucket}]`);
        buckets.set(Math.floor(b.bucket), stats);
      }

      parsedArms.push({ armId: a.armId, global, buckets });
    }

    const bandit = new BudgetedRouterBandit(opts);
    // Reconstruct the PRNG stream position from the persisted seed + draw
    // count (NOT from opts.seed — the snapshot's seed is authoritative for
    // exact stream continuation).
    (bandit as unknown as { rng: Xorshift128 }).rng = new Xorshift128(s.seed as number);
    (bandit as unknown as { rng: Xorshift128 }).rng.skip(s.draws as number);

    for (const parsed of parsedArms) {
      bandit.arms.set(parsed.armId, { armId: parsed.armId, global: parsed.global, buckets: parsed.buckets });
    }
    bandit.spentUsdTotal = s.spentUsd as number;
    bandit.lambdaVal = s.lambda as number;
    bandit.overallPulls = parsedArms.reduce((sum, a) => sum + a.global.pulls, 0);

    return bandit;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private dedupeCandidates(candidates: readonly string[]): string[] {
    if (!Array.isArray(candidates)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of candidates) {
      if (typeof c !== "string" || c.length === 0) continue;
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
    return out;
  }

  private sanitizeContext(ctx: RoutingContext, strict = false): RoutingContext {
    if (!ctx || typeof ctx !== "object") {
      if (strict) throw new BanditStateError("invalid-context", "context must be an object");
      return { taskId: "", category: "", difficulty: 0, decomposable: false, signals: {}, promptTokens: 0 };
    }
    if (typeof ctx.category !== "string") {
      if (strict) throw new BanditStateError("invalid-context", `context.category must be a string, got ${String(ctx.category)}`);
    }
    if (strict && typeof ctx.taskId !== "string") {
      throw new BanditStateError("invalid-context", `context.taskId must be a string, got ${String(ctx.taskId)}`);
    }
    const category = typeof ctx.category === "string" ? ctx.category : String(ctx.category ?? "");
    const difficulty = isFiniteNumber(ctx.difficulty) ? clamp(ctx.difficulty, 0, 1) : 0;
    const promptTokens = isFiniteNumber(ctx.promptTokens) && ctx.promptTokens >= 0 ? ctx.promptTokens : 0;
    const signals: TaskSignals = ctx.signals && typeof ctx.signals === "object" ? ctx.signals : {};
    return {
      taskId: typeof ctx.taskId === "string" ? ctx.taskId : "",
      category,
      difficulty,
      decomposable: Boolean(ctx.decomposable),
      signals,
      promptTokens,
    };
  }

  private getOrCreateArm(armId: string): ArmState {
    let arm = this.arms.get(armId);
    if (!arm) {
      arm = { armId, global: emptyStats(), buckets: new Map() };
      this.arms.set(armId, arm);
    }
    return arm;
  }

  private safeEstimateUsd(fn: (armId: string) => number, armId: string): number {
    let v: number;
    try {
      v = fn(armId);
    } catch {
      v = NaN;
    }
    if (!Number.isFinite(v)) {
      const arm = this.arms.get(armId);
      const fallback = arm && arm.global.pulls > 0 ? arm.global.usdSum / arm.global.pulls : USD_FLOOR;
      return Math.max(fallback, USD_FLOOR);
    }
    return Math.max(v, USD_FLOOR);
  }

  private wallMsEstimateFor(armId: string, ctx: RoutingContext): number {
    const arm = this.arms.get(armId);
    if (!arm) return MS_FLOOR;
    const bucket = bucketOf(ctx.category, this.opts.contextBuckets);
    const bStats = arm.buckets.get(bucket);
    if (bStats && bStats.pulls > 0) return Math.max(bStats.wallMsSum / bStats.pulls, MS_FLOOR);
    if (arm.global.pulls > 0) return Math.max(arm.global.wallMsSum / arm.global.pulls, MS_FLOOR);
    return MS_FLOOR;
  }

  private shrunkAlphaBeta(armId: string, ctx: RoutingContext): { alpha: number; beta: number } {
    const arm = this.arms.get(armId);
    const bucket = bucketOf(ctx.category, this.opts.contextBuckets);
    const bStats = arm?.buckets.get(bucket) ?? emptyStats();
    const global = arm?.global ?? emptyStats();

    const bucketAlpha = this.priorAlpha + bStats.verified;
    const bucketBeta = this.priorBeta + (bStats.pulls - bStats.verified);
    const globalAlpha = this.priorAlpha + global.verified;
    const globalBeta = this.priorBeta + (global.pulls - global.verified);

    const s = this.opts.shrinkage;
    return {
      alpha: (1 - s) * bucketAlpha + s * globalAlpha,
      beta: (1 - s) * bucketBeta + s * globalBeta,
    };
  }

  /** Deterministic, non-sampled index used on branches that must not consume
   *  the PRNG (forced-exploration / only-candidate / budget-exhausted):
   *  identical formula to the Thompson index but with the Beta MEAN in
   *  place of a draw. */
  private meanIndex(armId: string, ctx: RoutingContext, usdEstimate: number): number {
    const { alpha, beta } = this.shrunkAlphaBeta(armId, ctx);
    const pMean = alpha / (alpha + beta);
    const wallMs = Math.max(this.wallMsEstimateFor(armId, ctx), MS_FLOOR);
    const usd = Math.max(usdEstimate, USD_FLOOR);
    const score = pMean / usd / wallMs - this.lambdaVal * usdEstimate;
    return Number.isFinite(score) ? score : 0;
  }

  private buildPosterior(armId: string, stats: BucketStats, alpha: number, beta: number): ArmPosterior {
    const pVerifiedMean = alpha / (alpha + beta);
    const meanUsd = Math.max(stats.pulls > 0 ? stats.usdSum / stats.pulls : USD_FLOOR, USD_FLOOR);
    const meanWallMs = Math.max(stats.pulls > 0 ? stats.wallMsSum / stats.pulls : MS_FLOOR, MS_FLOOR);
    // MEASURED means measured. With zero pulls, `meanUsd`/`meanWallMs` are
    // just the division floors and `pVerifiedMean` is just the prior, so the
    // ratio below evaluates to a spectacular ~1.8e9 "verified tasks per hour
    // per dollar" that nothing on this machine ever observed. Reporting that
    // through a field named `measured*` is exactly the kind of fabricated
    // number a surface would rank arms by, so an unpulled arm reports 0.
    // (Cold-start exploration does NOT depend on this field: `select()`
    // forces every never-pulled arm before any Thompson draw.)
    const measuredVtphPerDollar =
      stats.pulls > 0 ? (pVerifiedMean * (3_600_000 / meanWallMs)) / meanUsd : 0;
    return {
      armId,
      pulls: stats.pulls,
      verified: stats.verified,
      alpha,
      beta,
      meanUsd,
      meanWallMs,
      pVerifiedMean: Number.isFinite(pVerifiedMean) ? pVerifiedMean : 0.5,
      measuredVtphPerDollar: Number.isFinite(measuredVtphPerDollar) ? measuredVtphPerDollar : 0,
    };
  }
}

function parseBucketStats(
  obj: Record<string, unknown>,
  pullsKey: string,
  verifiedKey: string,
  usdKey: string,
  wallMsKey: string,
  fannedOutKey: string,
  where: string,
): BucketStats {
  const pulls = obj[pullsKey];
  const verified = obj[verifiedKey];
  const usdSum = obj[usdKey];
  const wallMsSum = obj[wallMsKey];
  const fannedOutSum = obj[fannedOutKey];

  for (const [k, v] of [
    [pullsKey, pulls],
    [verifiedKey, verified],
    [usdKey, usdSum],
    [wallMsKey, wallMsSum],
    [fannedOutKey, fannedOutSum],
  ] as const) {
    if (!isFiniteNumber(v)) {
      throw new BanditStateError("invalid-numeric", `${where}.${k} must be a finite number, got ${String(v)}`);
    }
  }
  if ((pulls as number) < 0) {
    throw new BanditStateError("negative-pulls", `${where}.${pullsKey} must be >= 0, got ${String(pulls)}`);
  }
  if ((verified as number) < 0 || (usdSum as number) < 0 || (wallMsSum as number) < 0 || (fannedOutSum as number) < 0) {
    throw new BanditStateError("invalid-numeric", `${where}: sums/counts must be >= 0`);
  }
  if ((verified as number) > (pulls as number)) {
    throw new BanditStateError(
      "verified-exceeds-pulls",
      `${where}: verified (${String(verified)}) exceeds pulls (${String(pulls)})`,
    );
  }

  return {
    pulls: pulls as number,
    verified: verified as number,
    usdSum: usdSum as number,
    wallMsSum: wallMsSum as number,
    fannedOutSum: fannedOutSum as number,
  };
}
