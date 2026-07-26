/**
 * STYX primitive #5 — the conformal risk-controlled abstention gate.
 *
 * "Never deliver an unverified result" as math, not vibes.
 *
 * ## What this does
 *
 * Given a calibration set of `(verifierScore, wasActuallyCorrect)` pairs drawn
 * from the same process as future results, the gate computes a score threshold
 * τ such that emitting only results whose verifier score is ≥ τ bounds the
 * *silent-wrong* risk — the probability that an emitted result is wrong — at a
 * user-chosen ε. Everything below τ is abstained on (escalate the verifier
 * tier, or refuse to answer), never silently delivered.
 *
 * ## Split-conformal risk control
 *
 * This is split-conformal calibration specialized to a monotone selection
 * rule: the "nonconformity" ordering is the verifier score itself, and the
 * risk being controlled is the 0/1 loss "emitted AND wrong". The guarantee is
 * *distribution-free*: it needs no model of the score distribution, only
 * **exchangeability** — the calibration pairs and the future test pair must be
 * exchangeable draws (i.i.d. is sufficient). Under that assumption, selecting
 * τ so that the *conservative* empirical wrong-rate above τ is ≤ ε yields
 * `P(wrong | emitted) ≤ ε` marginally over calibration draws.
 *
 * ## The (+1)/(+1) finite-sample correction
 *
 * The naive empirical wrong-rate `wrong / n_selected` on a finite calibration
 * set is an unbiased-looking but *optimistic* plug-in: with small selected
 * sets it can read 0 while the true risk is far above ε. The conformal
 * correction scores each candidate threshold with
 *
 *     riskUpperBound(t) = (wrong(t) + 1) / (n_selected(t) + 1)
 *
 * i.e. it acts as if one additional, adversarially-wrong exchangeable point
 * sat just above the threshold. This is the standard finite-sample adjustment
 * from split-conformal prediction (the same `(k+1)/(n+1)` quantile shift):
 * the "+1" in the numerator accounts for the yet-unseen test point being
 * wrong, and the "+1" in the denominator accounts for it being selected.
 * Consequence: a threshold that selects only n calibration points can never
 * certify a risk below `1/(n+1)`, so tiny selected sets cannot fake
 * confidence — exactly the honest behavior we want.
 *
 * ## Why smallest-t-subject-to-bound maximizes coverage
 *
 * Emission is monotone in the threshold: lowering t only *adds* points to the
 * selected set, so coverage (the fraction of results emitted rather than
 * abstained on) is non-increasing in t. Among all thresholds whose
 * conservative risk is ≤ ε, the **smallest** one therefore emits the most —
 * abstention is minimized *subject to* the risk bound, never traded against
 * it. Likewise, a looser ε only enlarges the feasible set of thresholds, so
 * τ(ε) is non-increasing in ε and coverage is non-decreasing in ε — the
 * monotonicity holds structurally, not numerically by luck.
 *
 * ## Caveats (read before trusting the number)
 *
 * - The bound is **marginal**: it holds on average over draws of the
 *   calibration set, not conditionally on the particular calibration set you
 *   happened to get, and not per-slice of the input space.
 * - The bound **breaks under distribution shift**: if deployment-time tasks,
 *   verifier behavior, or the score→correctness relationship drift from the
 *   calibration distribution, exchangeability fails and ε is no longer a
 *   guarantee. Recalibrate on fresh data whenever the verifier ensemble, the
 *   generator, or the task mix changes.
 * - Calibration labels (`correct`) must come from ground truth or a verifier
 *   with an information edge — calibrating on a gamed verifier launders the
 *   gaming into a fake certificate (see STYX design constraints #1 and #3).
 *
 * Pure and deterministic: no randomness, no clock, no I/O.
 *
 * @module hades/styx/gate
 */

/** One labeled calibration example: a verifier score and its ground truth. */
export interface CalibrationPoint {
  /** The (calibrated) verifier score for this result — higher = more trusted. */
  score: number;
  /** Whether the result was actually correct (ground-truth label). */
  correct: boolean;
}

/** Configuration for a {@link ConformalGate}. */
export interface GateConfig {
  /** Target bound on P(wrong | emitted), e.g. 0.05. Must lie strictly in (0, 1). */
  epsilon: number;
  /** Minimum number of calibration points required to calibrate. Default 20. */
  minCalibration?: number;
}

/** The gate's verdict for a single new score. */
export interface GateDecision {
  /** True iff the result may be emitted (score cleared the threshold). */
  emit: boolean;
  /** The score that was evaluated. */
  score: number;
  /** The calibrated threshold τ in force for this decision. */
  threshold: number;
  /**
   * Empirical correct-rate among calibration points with score ≥ τ
   * (`1 - empiricalRiskAtThreshold`); 0 when the gate abstains on everything.
   */
  pCorrectEstimate: number;
}

/** Summary of the most recent calibration. */
export interface GateStats {
  /** The fitted threshold τ; +Infinity means "abstain on everything". */
  threshold: number;
  /** The ε the threshold was fitted for. */
  epsilon: number;
  /** Number of calibration points used. */
  calibrationSize: number;
  /**
   * Observed wrong-rate among calibration points with score ≥ threshold
   * (the *uncorrected* empirical rate; the fit itself used the (+1)/(+1)
   * conservative rate). Defined as 1 when no calibration point clears τ.
   */
  empiricalRiskAtThreshold: number;
  /** Fraction of calibration points with score ≥ threshold. */
  coverageAtThreshold: number;
}

/**
 * Pure helper: the smallest threshold t among the distinct calibration scores
 * such that the *conservative* empirical wrong-rate among calibration points
 * with score ≥ t satisfies `(wrong + 1) / (n_selected + 1) <= epsilon`.
 *
 * Smallest feasible t ⇒ maximum coverage subject to the risk bound (see
 * module doc). Tied scores are treated identically: every point sharing a
 * score enters or leaves the selected set together, so a threshold can never
 * split a tie.
 *
 * Returns `+Infinity` if no candidate threshold achieves the bound (the gate
 * then abstains on everything) — including for an empty calibration set and
 * for any epsilon ≤ 0. This function is pure math and never throws; input
 * validation (epsilon range, minimum calibration size) is the responsibility
 * of {@link ConformalGate.calibrate}.
 */
export function conformalThreshold(
  points: CalibrationPoint[],
  epsilon: number,
): number {
  if (points.length === 0) return Infinity;

  // Sort a copy of the scores ascending and group into distinct candidates,
  // counting total and wrong per distinct score so ties move as one block.
  const sorted = [...points].sort((a, b) => a.score - b.score);
  const candidates: { score: number; total: number; wrong: number }[] = [];
  for (const p of sorted) {
    const last = candidates[candidates.length - 1];
    if (last !== undefined && last.score === p.score) {
      last.total += 1;
      if (!p.correct) last.wrong += 1;
    } else {
      candidates.push({ score: p.score, total: 1, wrong: p.correct ? 0 : 1 });
    }
  }

  // Walk candidates from the highest score downward, maintaining suffix
  // counts: at candidate t, (selectedTotal, selectedWrong) describe exactly
  // the set S = { p : p.score >= t }. Track the smallest feasible t.
  let selectedTotal = 0;
  let selectedWrong = 0;
  let best = Infinity;
  for (let i = candidates.length - 1; i >= 0; i--) {
    selectedTotal += candidates[i].total;
    selectedWrong += candidates[i].wrong;
    const conservativeRisk = (selectedWrong + 1) / (selectedTotal + 1);
    if (conservativeRisk <= epsilon) {
      best = candidates[i].score; // keep descending: smaller feasible t wins
    }
    // No early break: feasibility is not monotone in t (adding correct
    // points below can re-satisfy the bound), so scan all candidates.
  }
  return best;
}

/**
 * A split-conformal risk-controlled abstention gate.
 *
 * Lifecycle: construct with a target ε, {@link calibrate} on labeled
 * (score, correct) pairs, then {@link decide} on fresh scores. Recalibrate
 * whenever the upstream verifier ensemble or task distribution changes —
 * the ε guarantee only holds under exchangeability with the calibration set.
 */
export class ConformalGate {
  private readonly config: GateConfig;
  private lastStats: GateStats | null = null;

  constructor(config: GateConfig) {
    this.config = config;
  }

  /**
   * Fit the threshold τ from calibration data and store the resulting stats.
   *
   * @throws {RangeError} if `epsilon` is not strictly inside (0, 1), or if
   *   fewer than `minCalibration` (default 20) points are supplied.
   */
  calibrate(points: CalibrationPoint[]): GateStats {
    const { epsilon } = this.config;
    if (typeof epsilon !== "number" || !Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 1) {
      throw new RangeError(
        `ConformalGate: epsilon must be strictly in (0, 1); got ${epsilon}`,
      );
    }
    const minCalibration = this.config.minCalibration ?? 20;
    if (points.length < minCalibration) {
      throw new RangeError(
        `ConformalGate: need at least ${minCalibration} calibration points; got ${points.length}`,
      );
    }

    const threshold = conformalThreshold(points, epsilon);

    let selectedTotal = 0;
    let selectedWrong = 0;
    for (const p of points) {
      if (p.score >= threshold) {
        selectedTotal += 1;
        if (!p.correct) selectedWrong += 1;
      }
    }

    const stats: GateStats = {
      threshold,
      epsilon,
      calibrationSize: points.length,
      // Uncorrected observed wrong-rate above τ; when nothing clears τ we
      // define the risk as 1 so pCorrectEstimate = 1 - risk = 0 (abstain-all).
      empiricalRiskAtThreshold:
        selectedTotal > 0 ? selectedWrong / selectedTotal : 1,
      coverageAtThreshold: points.length > 0 ? selectedTotal / points.length : 0,
    };
    this.lastStats = stats;
    return { ...stats };
  }

  /**
   * Decide whether a new result with this verifier score may be emitted:
   * emit iff `score >= τ`. When τ = +Infinity (no threshold met the bound),
   * the gate abstains on everything — including a literal +Infinity score.
   *
   * @throws {Error} if the gate has never been calibrated.
   */
  decide(score: number): GateDecision {
    if (this.lastStats === null) {
      throw new Error("ConformalGate: decide() called before calibrate()");
    }
    const { threshold, empiricalRiskAtThreshold, coverageAtThreshold } =
      this.lastStats;
    const emit =
      coverageAtThreshold > 0 && Number.isFinite(threshold) && score >= threshold;
    return {
      emit,
      score,
      threshold,
      pCorrectEstimate:
        coverageAtThreshold > 0 ? 1 - empiricalRiskAtThreshold : 0,
    };
  }

  /**
   * Stats from the most recent calibration.
   *
   * @throws {Error} if the gate has never been calibrated.
   */
  stats(): GateStats {
    if (this.lastStats === null) {
      throw new Error("ConformalGate: stats() called before calibrate()");
    }
    return { ...this.lastStats };
  }
}
