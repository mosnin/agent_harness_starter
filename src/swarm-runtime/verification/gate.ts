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

export interface GateConfig {
  /** Minimum weighted score to `accept`. Default 0.75. */
  acceptThreshold?: number;
  /** Below this the verdict is `reject` (not `revise`). Default 0.4. */
  rejectThreshold?: number;
  /** Optional independent LLM judge. */
  judge?: Judge;
  /**
   * Phrases that signal ungrounded speculation. A claim whose statement uses
   * these while citing no evidence is treated as a hallucination.
   */
  hedgeMarkers?: string[];
}

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
  private readonly hedges: string[];

  constructor(config: GateConfig = {}) {
    this.acceptThreshold = config.acceptThreshold ?? 0.75;
    this.rejectThreshold = config.rejectThreshold ?? 0.4;
    this.judge = config.judge;
    this.hedges = (config.hedgeMarkers ?? DEFAULT_HEDGES).map((h) => h.toLowerCase());
  }

  async verify(result: WorkerResult): Promise<VerificationReport> {
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

    const score = weightedScore(checks);
    const verdict = this.decide(score, checks);
    const feedback = this.buildFeedback(verdict, checks);
    return this.report(result, verdict, score, checks, feedback);
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

  private decide(score: number, checks: VerificationCheck[]): Verdict {
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

  private buildFeedback(verdict: Verdict, checks: VerificationCheck[]): string {
    if (verdict === "accept") return "All grounding checks passed.";
    const failed = checks.filter((c) => !c.passed);
    const lines = failed.map((c) => `- [${c.name}] ${c.detail}`);
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
