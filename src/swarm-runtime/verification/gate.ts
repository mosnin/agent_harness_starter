import type {
  Claim,
  ToolCallRecord,
  VerificationCheck,
  VerificationReport,
  Verdict,
  WorkerResult,
} from "../types";

/**
 * Optional second-opinion judge. When provided, the gate asks an independent
 * model to adversarially check whether the output is actually supported by the
 * cited evidence. Kept as a hook so the deterministic checks work with zero
 * API calls (tests, offline), and the LLM judge layers on when available.
 */
export interface Judge {
  /** Returns 0..1 support score + short rationale. Higher = better grounded. */
  assess(input: {
    output: unknown;
    claims: Claim[];
    toolTrace: ToolCallRecord[];
  }): Promise<{ score: number; rationale: string }>;
}

/**
 * An external verification layer's answer about a worker result — one vote,
 * however many verifiers were fused to produce it. Deliberately narrow: a
 * three-way decision plus human/machine-readable reasons, and nothing that
 * would drag another layer's verification framework into this one.
 *
 * `abstained` is NOT "failed quietly". It means *no verifier could judge this
 * subject at all*, and the gate must therefore behave exactly as if no hook
 * were configured. Only `abstained === false` makes `passed` meaningful.
 */
export interface ExternalVerification {
  /** Meaningful only when `abstained` is false. */
  passed: boolean;
  /** True when nothing could judge this subject — casts NO vote either way. */
  abstained: boolean;
  /** Strength label of the vote (e.g. `"T1-reference"`). Free-form on purpose:
   *  this layer must not own another layer's tier vocabulary. */
  tier: string;
  /** Why. Never empty — an unexplained verdict is not auditable. */
  reasons: string[];
}

/** Everything an external verifier gets. A superset of `WorkerResult`'s
 *  verifiable fields plus the request context, which `WorkerResult` does not
 *  carry but the manager knows (see {@link VerifyContext}). */
export interface ExternalVerifierInput {
  taskId: string;
  workerId: string;
  /** `WorkerTask.description` — the request the worker was handed. Absent when
   *  the caller did not supply it; a verifier that needs it must abstain. */
  taskDescription?: string;
  /**
   * `Goal.objective` — the request the WHOLE RUN answers, which is a different
   * string from `taskDescription` for every subtask in a decomposed plan.
   * See {@link VerifyContext.objective}.
   */
  objective?: string;
  /**
   * True when this result's `output` IS the run's answer to `objective`;
   * false when it is intermediate work product. See
   * {@link VerifyContext.isGoalAnswer} — a correctness oracle that judges an
   * intermediate result against the objective's expected answer will refute
   * perfectly good work.
   */
  isGoalAnswer?: boolean;
  output: unknown;
  claims: Claim[];
  toolTrace: ToolCallRecord[];
}

/**
 * Optional CORRECTNESS oracle, injected from above.
 *
 * Every check in this file is a *grounding* check: it asks whether an answer
 * is properly evidenced, never whether it is right. That is the deliberate
 * ceiling of this layer — it cannot recompute a task's true answer without
 * knowing what tasks mean. An `ExternalVerifier` is the seam for a layer that
 * CAN: it receives the result plus the request context and returns a pass /
 * fail / abstain.
 *
 * An implementation that judges an answer against the GOAL's expected result
 * must consult `input.isGoalAnswer` and abstain when it is not `true`. Most
 * results a swarm produces are intermediate work product whose correct output
 * is not the goal's answer, and a `fail` here is a hard veto — see
 * {@link VerifyContext} for the full argument.
 *
 * This is an interface, not an import, on purpose. `swarm-runtime` is the
 * lower layer and must never depend on `src/hades/**`; the adapter that wraps
 * the STYX trust registry lives on the hades side
 * (`src/hades/trust/swarm-bridge.ts`) and is passed in by whoever composes
 * the two. Exactly the same inversion `build-swarm.ts`'s `decorateProvider`
 * uses for the container provider.
 */
export interface ExternalVerifier {
  verify(input: ExternalVerifierInput): Promise<ExternalVerification>;
}

/**
 * What the CALLER knows that a `WorkerResult` does not carry. A result records
 * what a worker produced, never what it was asked — but a correctness oracle
 * is worthless without the request, so the manager supplies it here.
 *
 * Entirely optional: with no `externalVerifier` configured the gate ignores
 * this argument completely, so `verify(result)` and `verify(result, ctx)` are
 * the same call.
 *
 * ## Why `objective` and `isGoalAnswer` are separate from `taskDescription`
 *
 * A planner decomposes one objective into many subtasks, and every subtask's
 * description tends to QUOTE the objective (the shipped `DeterministicPlanner`
 * literally interpolates it: `Investigate the objective from the "code" angle:
 * <objective>`). So the request text a worker saw is NOT evidence that the
 * worker was supposed to produce the objective's final answer — an
 * "investigate" subtask legitimately returns prose.
 *
 * A correctness oracle handed only `taskDescription` therefore cannot tell
 * "wrong answer" from "intermediate work product", and will refute the second
 * as if it were the first. Since a refutation is a hard veto here, that turns
 * the oracle into a machine for failing correct runs. `isGoalAnswer` is the
 * caller's explicit statement of which single result is being offered AS the
 * answer; `objective` is the request that answer is judged against.
 */
export interface VerifyContext {
  /** `WorkerTask.description` — the request text the worker was given. */
  taskDescription?: string;
  /**
   * `Goal.objective` — the request the whole run answers, and the canonical
   * place any machine-checkable reference lives. Supplied separately from
   * `taskDescription` because a planner may paraphrase, truncate or omit the
   * objective when writing a subtask.
   */
  objective?: string;
  /**
   * True ONLY when this result's output is the run's answer to `objective`.
   * The manager knows this and nobody below it does — see
   * `SwarmManager.answersGoal`, which is the same predicate `synthesize()`
   * uses to pick the goal's answer, so the two can never disagree.
   *
   * Omitted or false means "intermediate work product". A correctness oracle
   * MUST NOT judge such a result against the objective's expected answer.
   */
  isGoalAnswer?: boolean;
}

export interface GateConfig {
  /** Minimum weighted score to `accept`. Default 0.75. */
  acceptThreshold?: number;
  /** Below this the verdict is `reject` (not `revise`). Default 0.4. */
  rejectThreshold?: number;
  /** Optional independent LLM judge. */
  judge?: Judge;
  /**
   * Optional external correctness oracle (see {@link ExternalVerifier}).
   * Omitted — the default everywhere — the gate behaves exactly as it always
   * has: no extra check is appended, no score moves, no verdict changes.
   */
  externalVerifier?: ExternalVerifier;
  /**
   * Phrases that signal ungrounded speculation. A claim whose statement uses
   * these while citing no evidence is treated as a hallucination.
   */
  hedgeMarkers?: string[];
}

/**
 * Weight of an external verifier's *positive* vote.
 *
 * A pass is worth the same as the LLM judge's — a meaningful contribution,
 * never a rescue. The grounding checks total weight 9 with the keystone
 * `evidence-traceable` at 3; an ungrounded result scores 2/9 = 0.22, and
 * adding a passing external vote only moves it to 4/11 = 0.36, still under
 * the 0.4 reject threshold (and `evidence-traceable` failing is an
 * unconditional reject anyway). "This answer is correct" must never launder
 * "this answer cites nothing": a correct answer a worker cannot evidence is
 * still a worker that guessed.
 *
 * A *failing* vote's weight is incidental — it is enforced as a hard veto in
 * `decide()`, not by arithmetic. See {@link VerificationGate.verify}.
 */
const EXTERNAL_VERIFIER_WEIGHT = 2;

const DEFAULT_HEDGES = [
  "i think",
  "probably",
  "might be",
  "i assume",
  "i believe",
  "as far as i know",
  "presumably",
  "it should be",
  "i guess",
];

/**
 * The anti-hallucination verification gate.
 *
 * Every worker result is scored against grounding checks *before* the manager
 * is allowed to accept it. The gate never trusts the worker's own confidence
 * number in isolation — it cross-references each claim's evidence against the
 * actual tool-call trace, so a worker cannot simply assert a fact into
 * existence. Results that fail hard are rejected; borderline results are sent
 * back for revision with concrete feedback.
 */
export class VerificationGate {
  private readonly acceptThreshold: number;
  private readonly rejectThreshold: number;
  private readonly judge?: Judge;
  private readonly externalVerifier?: ExternalVerifier;
  private readonly hedges: string[];

  constructor(config: GateConfig = {}) {
    this.acceptThreshold = config.acceptThreshold ?? 0.75;
    this.rejectThreshold = config.rejectThreshold ?? 0.4;
    this.judge = config.judge;
    this.externalVerifier = config.externalVerifier;
    this.hedges = (config.hedgeMarkers ?? DEFAULT_HEDGES).map((h) => h.toLowerCase());
  }

  /**
   * Score one worker result.
   *
   * `context` carries what the caller knows and the result does not (the task
   * description, the goal objective, and whether this result is the goal's
   * answer). It is read ONLY by a configured {@link ExternalVerifier}; with no
   * verifier configured this method is byte-for-byte the function it has
   * always been, whether `context` is passed or not.
   *
   * ## One branch never consults the external verifier
   *
   * A result carrying `error` short-circuits to `reject` at the top of this
   * method, BEFORE any check runs — the external verifier included. That is
   * deliberate and it is the one case where the appended-last rule below does
   * not apply: the worker crashed, there is no answer to be right or wrong
   * about, the verdict is already `reject`, and spending an oracle call (which
   * may be a network round-trip) to confirm a foregone conclusion would be
   * waste. Such a report has exactly one check, `worker-error`.
   *
   * ## Why a failing external verdict is a HARD VETO
   *
   * Everything else here is weighted, because every other signal is partial:
   * hedging language, confidence calibration and evidence traceability are
   * proxies for trustworthiness, so they vote and the aggregate decides. An
   * external verifier that recomputes the answer from a machine-checkable
   * reference is not a proxy — a mismatch means the answer is *provably
   * wrong*. There is no weighting of "provably wrong" that should ever come
   * out as `accept`, and letting one participate in the average would mean a
   * well-formatted wrong answer with five clean grounding checks could
   * outvote the one signal that actually knew the truth. That is precisely
   * the failure this seam exists to close, so the veto short-circuits
   * `decide()` instead of contributing arithmetic.
   *
   * A verifier that ABSTAINS or is UNAVAILABLE never vetoes and never moves
   * the score (weight 0) — the same treatment a judge outage gets, and for
   * the same reason: an oracle that could not speak is not evidence of
   * anything, and punishing grounding for its silence would make wiring one
   * up a downgrade.
   */
  async verify(result: WorkerResult, context: VerifyContext = {}): Promise<VerificationReport> {
    const checks: VerificationCheck[] = [];

    // A worker that errored can never be accepted.
    if (result.error) {
      return this.report(result, "reject", 0, [
        {
          name: "worker-error",
          passed: false,
          weight: 1,
          detail: `Worker reported an error: ${result.error}`,
        },
      ], "Worker crashed before producing a result; task must be retried.");
    }

    checks.push(this.checkHasClaims(result.claims));
    checks.push(this.checkEvidencePresence(result.claims));
    checks.push(this.checkEvidenceTraceability(result.claims, result.toolTrace));
    checks.push(this.checkNoUngroundedHedging(result.claims));
    checks.push(this.checkConfidenceCalibration(result.claims));
    checks.push(this.checkOutputSupported(result.output, result.claims));

    // Optional adversarial LLM judge (independent second opinion).
    if (this.judge) {
      try {
        const j = await this.judge.assess({
          output: result.output,
          claims: result.claims,
          toolTrace: result.toolTrace,
        });
        checks.push({
          name: "llm-judge",
          passed: j.score >= 0.6,
          weight: 2,
          detail: `judge score ${j.score.toFixed(2)}: ${j.rationale}`,
        });
      } catch (e) {
        checks.push({
          name: "llm-judge",
          passed: false,
          weight: 0, // don't punish grounding for a judge outage
          detail: `judge unavailable: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    // Optional external correctness oracle (see `ExternalVerifier`). Appended
    // last so the grounding checks' order in the report is untouched — on
    // every branch that reaches here. The errored-result branch above returns
    // before this point and never consults the verifier; see `verify()`'s docs.
    let externalVeto = false;
    if (this.externalVerifier) {
      const outcome = await this.runExternalVerifier(this.externalVerifier, result, context);
      checks.push(outcome.check);
      externalVeto = outcome.veto;
    }

    const score = weightedScore(checks);
    const verdict = this.decide(score, checks, externalVeto);
    const feedback = this.buildFeedback(verdict, checks, externalVeto);
    return this.report(result, verdict, score, checks, feedback);
  }

  /**
   * Run the injected verifier and translate its answer into one
   * `VerificationCheck` plus a veto flag.
   *
   * Adversary-first, mirroring how the registry on the other side of this
   * seam isolates its own verifiers: a throw, a rejected promise, or a
   * malformed return value all land on the weight-0 "unavailable" path and
   * NEVER on the veto path. A hook that crashes must not be able to reject
   * every result in the swarm — an outage is not a proof of wrongness.
   */
  private async runExternalVerifier(
    verifier: ExternalVerifier,
    result: WorkerResult,
    context: VerifyContext
  ): Promise<{ check: VerificationCheck; veto: boolean }> {
    const unavailable = (detail: string): { check: VerificationCheck; veto: boolean } => ({
      check: { name: "external-verifier", passed: false, weight: 0, detail },
      veto: false,
    });

    let outcome: ExternalVerification;
    try {
      outcome = await verifier.verify({
        taskId: result.taskId,
        workerId: result.workerId,
        ...(context.taskDescription === undefined ? {} : { taskDescription: context.taskDescription }),
        ...(context.objective === undefined ? {} : { objective: context.objective }),
        ...(context.isGoalAnswer === undefined ? {} : { isGoalAnswer: context.isGoalAnswer }),
        output: result.output,
        claims: result.claims,
        toolTrace: result.toolTrace,
      });
    } catch (e) {
      return unavailable(
        `external verifier unavailable: ${e instanceof Error ? e.message : String(e)}` +
          " (weight 0 — grounding is not punished for an oracle outage)"
      );
    }

    if (
      outcome === null ||
      typeof outcome !== "object" ||
      typeof outcome.passed !== "boolean" ||
      typeof outcome.abstained !== "boolean"
    ) {
      return unavailable(
        "external verifier returned a malformed verdict (expected { passed, abstained, tier, reasons });" +
          " treated as an outage, never as a failure"
      );
    }

    const tier = typeof outcome.tier === "string" && outcome.tier.length > 0 ? outcome.tier : "unlabelled";
    const why = Array.isArray(outcome.reasons) ? outcome.reasons.filter((r) => typeof r === "string") : [];
    const reasons = why.length > 0 ? why.join("; ") : "no reason given";

    if (outcome.abstained) {
      return {
        check: {
          name: "external-verifier",
          passed: false,
          weight: 0, // abstention casts no vote: the score must not move at all
          detail: `[${tier}] abstained — cast no vote: ${reasons}`,
        },
        veto: false,
      };
    }

    if (outcome.passed) {
      return {
        check: {
          name: "external-verifier",
          passed: true,
          weight: EXTERNAL_VERIFIER_WEIGHT,
          detail: `[${tier}] independently verified: ${reasons}`,
        },
        veto: false,
      };
    }

    return {
      check: {
        name: "external-verifier",
        passed: false,
        weight: EXTERNAL_VERIFIER_WEIGHT,
        detail: `[${tier}] independently REFUTED: ${reasons}`,
      },
      veto: true,
    };
  }

  // ── Individual checks ──────────────────────────────────────────────────────

  private checkHasClaims(claims: Claim[]): VerificationCheck {
    const passed = claims.length > 0;
    return {
      name: "has-claims",
      passed,
      weight: 1,
      detail: passed
        ? `${claims.length} claim(s) provided`
        : "No claims provided — output is unverifiable and cannot be trusted",
    };
  }

  private checkEvidencePresence(claims: Claim[]): VerificationCheck {
    if (claims.length === 0) {
      return { name: "evidence-present", passed: false, weight: 2, detail: "no claims to back" };
    }
    const unbacked = claims.filter((c) => c.evidence.length === 0);
    const passed = unbacked.length === 0;
    return {
      name: "evidence-present",
      passed,
      weight: 2,
      detail: passed
        ? "every claim cites at least one piece of evidence"
        : `${unbacked.length}/${claims.length} claim(s) cite no evidence: ${unbacked
            .map((c) => `"${truncate(c.statement)}"`)
            .join("; ")}`,
    };
  }

  /**
   * The keystone anti-hallucination check: evidence a worker cites must trace
   * back to something it actually observed (a tool call it made). Evidence that
   * appears nowhere in the tool trace is treated as fabricated.
   */
  private checkEvidenceTraceability(
    claims: Claim[],
    toolTrace: ToolCallRecord[]
  ): VerificationCheck {
    if (claims.length === 0) {
      return { name: "evidence-traceable", passed: false, weight: 3, detail: "no claims" };
    }
    const haystack = toolTrace
      .map((t) => `${t.tool} ${JSON.stringify(t.args)} ${t.output}`)
      .join("\n")
      .toLowerCase();

    let traceable = 0;
    let total = 0;
    const orphans: string[] = [];
    for (const claim of claims) {
      for (const ev of claim.evidence) {
        total++;
        if (isTraceable(ev, haystack)) {
          traceable++;
        } else {
          orphans.push(truncate(ev));
        }
      }
    }
    // If there were no tool calls at all, we can't disprove evidence, but we
    // also can't confirm it — treat as weakly passing only if claims are few.
    const ratio = total === 0 ? 0 : traceable / total;
    const passed = toolTrace.length === 0 ? claims.length <= 1 : ratio >= 0.5;
    return {
      name: "evidence-traceable",
      passed,
      weight: 3,
      detail:
        toolTrace.length === 0
          ? "worker made no tool calls; evidence cannot be independently traced"
          : `${traceable}/${total} evidence item(s) trace to the tool log` +
            (orphans.length ? `; untraceable: ${orphans.slice(0, 3).join("; ")}` : ""),
    };
  }

  private checkNoUngroundedHedging(claims: Claim[]): VerificationCheck {
    const offenders = claims.filter(
      (c) =>
        c.evidence.length === 0 &&
        this.hedges.some((h) => c.statement.toLowerCase().includes(h))
    );
    const passed = offenders.length === 0;
    return {
      name: "no-ungrounded-hedging",
      passed,
      weight: 1,
      detail: passed
        ? "no speculative, unbacked claims"
        : `${offenders.length} speculative claim(s) with hedging language and no evidence`,
    };
  }

  private checkConfidenceCalibration(claims: Claim[]): VerificationCheck {
    // Over-confidence: high stated confidence with zero evidence is a red flag.
    const miscalibrated = claims.filter((c) => c.confidence >= 0.8 && c.evidence.length === 0);
    const passed = miscalibrated.length === 0;
    return {
      name: "confidence-calibrated",
      passed,
      weight: 1,
      detail: passed
        ? "confidence is calibrated to evidence"
        : `${miscalibrated.length} claim(s) assert high confidence with no supporting evidence`,
    };
  }

  private checkOutputSupported(output: unknown, claims: Claim[]): VerificationCheck {
    const hasOutput = output !== undefined && output !== null && String(output).trim().length > 0;
    const passed = hasOutput && claims.length > 0;
    return {
      name: "output-supported",
      passed,
      weight: 1,
      detail: !hasOutput
        ? "empty output"
        : claims.length === 0
          ? "output has no backing claims"
          : "output is accompanied by backing claims",
    };
  }

  // ── Decision ───────────────────────────────────────────────────────────────

  private decide(score: number, checks: VerificationCheck[], externalVeto = false): Verdict {
    // An external verifier that actually refuted the answer wins outright: it
    // is the only signal here that speaks to CORRECTNESS rather than to
    // grounding, and a proof of wrongness cannot be averaged away by six
    // checks that liked the formatting. See `verify()`'s docs.
    if (externalVeto) return "reject";
    // A failed high-weight grounding check is an automatic reject regardless of
    // the aggregate score — you cannot average your way past a fabrication.
    const criticalFail = checks.some(
      (c) => !c.passed && c.weight >= 3 && c.name === "evidence-traceable"
    );
    if (criticalFail) return "reject";
    if (score >= this.acceptThreshold) return "accept";
    if (score < this.rejectThreshold) return "reject";
    return "revise";
  }

  private buildFeedback(verdict: Verdict, checks: VerificationCheck[], externalVeto = false): string {
    if (verdict === "accept") return "All grounding checks passed.";
    const failed = checks.filter((c) => !c.passed);
    const lines = failed.map((c) => `- [${c.name}] ${c.detail}`);
    // A vetoed result is usually well-grounded — telling the worker to cite
    // more tool output would send it to fix the one thing that wasn't broken.
    // Name the real problem: the answer is wrong.
    if (externalVeto) {
      return [
        "REJECTED — an independent verifier refuted this answer. Grounding cannot outvote a wrong result:",
        ...lines,
        "Redo the task and produce the correct answer; better citations will not change this verdict.",
      ].join("\n");
    }
    const header =
      verdict === "reject"
        ? "REJECTED — output is not sufficiently grounded. Redo the task and:"
        : "REVISE — tighten grounding before this can be accepted:";
    return [header, ...lines, "Cite concrete tool outputs for every claim you make."].join("\n");
  }

  private report(
    result: WorkerResult,
    verdict: Verdict,
    score: number,
    checks: VerificationCheck[],
    feedback: string
  ): VerificationReport {
    return {
      taskId: result.taskId,
      workerId: result.workerId,
      verdict,
      score,
      checks,
      feedback,
      at: Date.now(),
    };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function weightedScore(checks: VerificationCheck[]): number {
  const scored = checks.filter((c) => c.weight > 0);
  const totalWeight = scored.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 0;
  const got = scored.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
  return got / totalWeight;
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Lower-cased concatenation of a tool trace — the searchable evidence corpus. */
export function buildTraceHaystack(toolTrace: ToolCallRecord[]): string {
  return toolTrace
    .map((t) => `${t.tool} ${JSON.stringify(t.args)} ${t.output}`)
    .join("\n")
    .toLowerCase();
}

/** True if a piece of cited evidence traces back to what the worker observed. */
export function isEvidenceTraceable(evidence: string, toolTrace: ToolCallRecord[]): boolean {
  return isTraceable(evidence, buildTraceHaystack(toolTrace));
}

function isTraceable(evidence: string, haystackLower: string): boolean {
  const ev = evidence.trim().toLowerCase();
  if (ev.length === 0) return false;
  // Direct substring hit.
  if (haystackLower.includes(ev)) return true;
  // Token-overlap heuristic for paraphrased evidence: require a majority of the
  // evidence's distinctive tokens to appear in the trace. Keep words of length
  // ≥3 plus any pure-numeric token (numbers are high-signal evidence).
  const tokens = ev
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 || /^\d+$/.test(t));
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => haystackLower.includes(t)).length;
  return hits / tokens.length >= 0.6;
}
