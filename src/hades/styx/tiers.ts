/**
 * Styx primitives #2 (verifier-tier router) and #3 (calibrated ensemble
 * fitness). Both are pure, deterministic, label-free inference-time machinery —
 * no clock, no randomness, no network.
 *
 * ---------------------------------------------------------------------------
 * #2 VERIFIER-TIER ROUTER
 * ---------------------------------------------------------------------------
 * Every branch result is routed to the *strongest applicable* verification
 * tier. The tiers, strongest→weakest:
 *
 *   T0-execution   run it against an oracle (code+tests, arithmetic). Clover-
 *                  style: a passing execution is (near) zero false positives.
 *   T1-reference   entailment against a retrieved ground-truth source.
 *   T2-genrm       a GenRM grades it against a rubric (clean context, ideally a
 *                  different model family — an information edge over the author).
 *   T3-agreement   cross-model agreement between independent families.
 *   T4-consistency consistency-only (self-agreement across samples). The weakest
 *                  edge; a same-context "are you sure?" is worth ~zero.
 *
 * The abstention threshold RISES as the tier weakens: a weak verifier must clear
 * a HIGHER calibrated-confidence bar (or the gate declines / escalates). A
 * trustworthy oracle (T0) may emit near the base error budget; a T4 signal must
 * be nearly certain before we are willing to stand behind it.
 *
 * ---------------------------------------------------------------------------
 * #3 CALIBRATED ENSEMBLE FITNESS  (Weaver-style, Dawid–Skene-style)
 * ---------------------------------------------------------------------------
 * A single LLM verifier fails at scale — false positives compound and precision
 * (not recall) is the bottleneck (Scaling Flaws, 2502.00271). Styx instead fuses
 * MANY cheap, imperfect ("weak") verifiers into ONE calibrated agreement score.
 *
 * The hard constraint: we have NO ground-truth labels at inference time. We
 * cannot measure any verifier's accuracy directly. Weaver / Dawid–Skene weak
 * supervision solves this by estimating each verifier's reliability from
 * INTER-VERIFIER AGREEMENT: a verifier that repeatedly agrees with the
 * (reliability-weighted) consensus is probably accurate and earns a high weight;
 * a verifier that repeatedly dissents — a random or adversarial one — earns a low
 * weight and is down-weighted out of the consensus. This is an EM fixed point,
 * not a heuristic: consensus and reliabilities are alternately re-estimated until
 * they stop moving.
 *
 * WHY AGREEMENT ⇒ RELIABILITY. If verifiers err independently, the majority is
 * usually right, so agreement-with-consensus is a *proxy* for agreement-with-
 * truth. Estimating one scalar reliability per verifier (a symmetric Dawid–Skene
 * confusion model) recovers, to within the consensus's own error, each
 * verifier's true accuracy — with zero labels.
 *
 * KNOWN LIMITATION — the exchangeability / shared-bias failure. The proxy holds
 * only if verifier errors are roughly independent. If ALL verifiers share the
 * SAME bias (same blind spot, same training contamination, same gameable
 * shortcut), they will agree WITH EACH OTHER while being jointly WRONG. Agreement
 * is then high and confident but miscalibrated, and this module cannot detect it
 * — inter-agreement carries no signal about a correlated error. That failure mode
 * is exactly what the S3 isomorphic-perturbation harness (`styx/perturb.ts`) and
 * held-out verifier rotation exist to catch: a passing answer must keep passing
 * under semantics-preserving rewrites, which breaks shared shortcuts that mere
 * agreement rewards. Do not read a high ensemble score as truth in the absence of
 * an independent tier (T0/T1) or a perturbation check.
 */

// ===========================================================================
// #2 — Verifier-tier router
// ===========================================================================

export type TierId =
  | "T0-execution"
  | "T1-reference"
  | "T2-genrm"
  | "T3-agreement"
  | "T4-consistency";

/** Ordered strongest → weakest. Index doubles as tier strength rank. */
export const TIER_ORDER: readonly TierId[] = [
  "T0-execution",
  "T1-reference",
  "T2-genrm",
  "T3-agreement",
  "T4-consistency",
] as const;

export interface TaskSignals {
  /** can we run/check it against an oracle (code+tests, arithmetic)? */
  executable?: boolean;
  /** is there a retrievable ground-truth source? */
  hasReference?: boolean;
  /** can a GenRM grade it against a rubric? */
  rubricAvailable?: boolean;
  /** are independent model families available for cross-agreement? */
  multiModelAvailable?: boolean;
}

/**
 * Strongest applicable tier given the signals. Priority is strict and follows
 * the router contract: executable → T0; else hasReference → T1; else
 * rubricAvailable → T2; else multiModelAvailable → T3; else the always-available
 * fallback T4-consistency. Never throws — an empty signal set routes to T4.
 */
export function routeTier(sig: TaskSignals): TierId {
  if (sig && sig.executable) return "T0-execution";
  if (sig && sig.hasReference) return "T1-reference";
  if (sig && sig.rubricAvailable) return "T2-genrm";
  if (sig && sig.multiModelAvailable) return "T3-agreement";
  return "T4-consistency";
}

/**
 * Fraction of the base error budget a tier is ALLOWED to spend. Strongest tier
 * spends its full budget (the oracle is trustworthy); each weaker tier is
 * permitted a strictly smaller slice, so the required confidence floor rises.
 * Documented, monotonically non-increasing values.
 */
const TIER_BUDGET_FRACTION: Record<TierId, number> = {
  "T0-execution": 1.0, // full base budget — a passing oracle is ~zero-FP
  "T1-reference": 0.5, // entailment against a source: half the budget
  "T2-genrm": 0.25, // rubric grade, clean/cross-context: a quarter
  "T3-agreement": 0.1, // cross-model agreement: a tenth
  "T4-consistency": 0.02, // consistency-only: near-zero slack, near-certain or decline
};

/**
 * The minimum calibrated P(correct) required to EMIT at a given tier. Rises as
 * the tier weakens: floor(T0) ≤ floor(T1) ≤ … ≤ floor(T4).
 *
 * Mapping (pure lookup): floor = 1 − baseEpsilon · budgetFraction(tier), where
 * budgetFraction is 1.0 at T0 down to 0.02 at T4. So the floor climbs from
 * ~(1 − baseEpsilon) at T0 toward ~1 at T4. `baseEpsilon` is the user's base
 * silent-wrong budget; it is clamped to [0,1] and the result is clamped to
 * [0,1]. Example (baseEpsilon = 0.1): T0 = 0.90, T1 = 0.95, T2 = 0.975,
 * T3 = 0.99, T4 = 0.998.
 */
export function tierConfidenceFloor(tier: TierId, baseEpsilon: number): number {
  const eps = clamp01(Number.isFinite(baseEpsilon) ? baseEpsilon : 0);
  const fraction = TIER_BUDGET_FRACTION[tier];
  if (fraction === undefined) {
    throw new RangeError(`tierConfidenceFloor: unknown tier "${tier}"`);
  }
  return clamp01(1 - eps * fraction);
}

// ===========================================================================
// #3 — Label-free weak-verifier ensemble (Dawid–Skene-style)
// ===========================================================================

/** One weak verifier's binary vote on one item. */
export interface VerifierVote {
  verifierId: string;
  /** true ⇒ this verifier believes the item is correct. */
  passed: boolean;
}

export interface EnsembleResult {
  /** calibrated P(correct) in [0,1] — reliability-weighted pass fraction. */
  score: number;
  /** per-verifier estimated reliability (accuracy), in [0,1]. Global across
   *  items — the same map is attached to every item's result. */
  weights: Record<string, number>;
  /** raw (unweighted) fraction of votes on this item that were `pass`. */
  agreement: number;
}

interface EnsembleOpts {
  maxIters?: number;
  tolerance?: number;
}

/**
 * Estimate each verifier's reliability from agreement across many items (no
 * labels), then produce a per-item calibrated score.
 *
 * Algorithm (deterministic EM fixed point):
 *   1. Initialise every reliability weight to 0.5 (maximally uninformative).
 *   2. Repeat, up to `maxIters`:
 *        E-step  consensus_i = reliability-WEIGHTED majority of item i's votes
 *                (passWeight = Σ r_v·[vote=pass], failWeight = Σ r_v·[vote=fail];
 *                 consensus = pass iff passWeight ≥ failWeight, ties → pass).
 *        M-step  reliability_v = (# items where v voted AND v's vote = consensus)
 *                              / (# items where v voted).
 *      Stop when the largest reliability change < `tolerance`.
 *   3. Per-item score = passWeight / (passWeight + failWeight) — the normalised
 *      reliability-weighted pass vote. Empty item ⇒ 0.5.
 *
 * Because the first E-step runs with all weights equal, step 2 bootstraps from a
 * plain unweighted majority (which breaks the symmetric-init fixed point), then
 * sharpens: accurate verifiers pull weight toward their true accuracy, an
 * always-wrong verifier collapses toward 0 and drops out of the consensus.
 *
 * Deterministic: fixed 0.5 init, no randomness, tie-break to `pass`, stable
 * verifier ordering. Pure: no clock/random/network.
 */
export class WeakVerifierEnsemble {
  private readonly maxIters: number;
  private readonly tolerance: number;
  private rel: Map<string, number> = new Map();
  private fitted = false;

  constructor(opts: EnsembleOpts = {}) {
    this.maxIters = opts.maxIters !== undefined && opts.maxIters > 0 ? Math.floor(opts.maxIters) : 20;
    this.tolerance =
      opts.tolerance !== undefined && opts.tolerance >= 0 ? opts.tolerance : 1e-6;
  }

  /**
   * Fit reliabilities from `votes` (votes[i] = item i's votes) and return the
   * per-item calibrated results. The returned `weights` map is the same global
   * reliability estimate on every element.
   */
  fitPredict(votes: VerifierVote[][]): EnsembleResult[] {
    const items = Array.isArray(votes) ? votes : [];

    // Collect verifier ids in first-seen order (stable, deterministic).
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (!Array.isArray(item)) continue;
      for (const v of item) {
        if (v && typeof v.verifierId === "string" && !seen.has(v.verifierId)) {
          seen.add(v.verifierId);
          ids.push(v.verifierId);
        }
      }
    }

    // Init all reliabilities to 0.5.
    const rel = new Map<string, number>();
    for (const id of ids) rel.set(id, 0.5);

    // EM iterations.
    for (let iter = 0; iter < this.maxIters; iter++) {
      // E-step: weighted-majority consensus per item.
      const consensus: (boolean | null)[] = new Array(items.length).fill(null);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!Array.isArray(item) || item.length === 0) continue;
        let passW = 0;
        let failW = 0;
        for (const v of item) {
          if (!v || typeof v.verifierId !== "string") continue;
          const w = rel.get(v.verifierId) ?? 0.5;
          if (v.passed) passW += w;
          else failW += w;
        }
        // Tie (including all-zero weights) breaks to pass, deterministically.
        consensus[i] = passW >= failW;
      }

      // M-step: reliability = agreement-with-consensus fraction per verifier.
      const agree = new Map<string, number>();
      const total = new Map<string, number>();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const c = consensus[i];
        if (!Array.isArray(item) || c === null) continue;
        for (const v of item) {
          if (!v || typeof v.verifierId !== "string") continue;
          total.set(v.verifierId, (total.get(v.verifierId) ?? 0) + 1);
          if (v.passed === c) agree.set(v.verifierId, (agree.get(v.verifierId) ?? 0) + 1);
        }
      }

      let maxDelta = 0;
      for (const id of ids) {
        const t = total.get(id) ?? 0;
        // A verifier with no counted votes keeps its prior 0.5.
        const next = t > 0 ? (agree.get(id) ?? 0) / t : rel.get(id) ?? 0.5;
        maxDelta = Math.max(maxDelta, Math.abs(next - (rel.get(id) ?? 0.5)));
        rel.set(id, next);
      }

      if (maxDelta < this.tolerance) break;
    }

    this.rel = rel;
    this.fitted = true;

    const weights = mapToRecord(rel);
    return items.map((item) => ({
      score: this.weightedScore(item, rel),
      weights: { ...weights },
      agreement: rawAgreement(item),
    }));
  }

  /**
   * Score a single new item's votes using the reliabilities learned by the last
   * `fitPredict`. Unseen verifiers contribute a neutral 0.5 weight. An empty
   * item scores 0.5. Requires a prior fit (throws otherwise).
   */
  scoreItem(votes: VerifierVote[]): number {
    if (!this.fitted) {
      throw new Error("WeakVerifierEnsemble.scoreItem: call fitPredict first");
    }
    return this.weightedScore(votes, this.rel);
  }

  /** The learned per-verifier reliabilities (accuracy estimates) in [0,1]. */
  reliabilities(): Record<string, number> {
    return mapToRecord(this.rel);
  }

  /** Normalised reliability-weighted pass fraction; empty/zero-mass ⇒ 0.5. */
  private weightedScore(item: VerifierVote[] | undefined, rel: Map<string, number>): number {
    if (!Array.isArray(item) || item.length === 0) return 0.5;
    let passW = 0;
    let failW = 0;
    for (const v of item) {
      if (!v || typeof v.verifierId !== "string") continue;
      const w = rel.get(v.verifierId) ?? 0.5;
      if (v.passed) passW += w;
      else failW += w;
    }
    const denom = passW + failW;
    if (denom <= 0) return 0.5; // no effective evidence
    return clamp01(passW / denom);
  }
}

// ===========================================================================
// helpers
// ===========================================================================

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function rawAgreement(item: VerifierVote[] | undefined): number {
  if (!Array.isArray(item) || item.length === 0) return 0.5; // no votes ⇒ neutral
  let pass = 0;
  let n = 0;
  for (const v of item) {
    if (!v || typeof v.verifierId !== "string") continue;
    n++;
    if (v.passed) pass++;
  }
  if (n === 0) return 0.5;
  return pass / n;
}

function mapToRecord(m: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}
