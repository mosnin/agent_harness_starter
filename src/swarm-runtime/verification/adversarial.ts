import type { WorkerResult } from "../types";
import { isEvidenceTraceable } from "./gate";

export interface Refutation {
  refuted: boolean;
  reasons: string[];
  /** How strongly the skeptic believes the result is unsound (0..1). */
  confidence: number;
}

/**
 * An adversarial verifier is an *independent skeptic*: instead of scoring how
 * grounded a result is, it actively tries to knock it down. It runs after the
 * verification gate has already accepted a result and looks for failure modes
 * the gate's grounding checks don't cover — overconfidence, unfalsifiable
 * absolutes, and claims whose evidence doesn't actually match. Requiring a
 * result to *survive* refutation is a stronger bar than merely passing grounding.
 */
export interface AdversarialVerifier {
  refute(result: WorkerResult): Promise<Refutation>;
}

const ABSOLUTES = /\b(always|never|guaranteed|impossible|certainly|100%|every single|without exception|undeniably)\b/i;

export interface RuleBasedAdversaryOptions {
  /** Number of concern points that trigger a refutation. Default 1 strong or 2 soft. */
  refuteThreshold?: number;
}

/**
 * Deterministic, dependency-free skeptic. Complements the gate rather than
 * duplicating it: it targets rhetorical/epistemic red flags (absolute language,
 * overconfidence relative to evidence, evidence that doesn't match its claim)
 * that a grounded-but-overreaching answer can still exhibit.
 */
export class RuleBasedAdversary implements AdversarialVerifier {
  private readonly threshold: number;
  constructor(opts: RuleBasedAdversaryOptions = {}) {
    this.threshold = opts.refuteThreshold ?? 1;
  }

  async refute(result: WorkerResult): Promise<Refutation> {
    const reasons: string[] = [];
    let strong = 0;

    const outStr = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    if (ABSOLUTES.test(outStr)) {
      reasons.push("output makes an unfalsifiable absolute claim");
      strong += 1;
    }

    for (const claim of result.claims) {
      if (ABSOLUTES.test(claim.statement)) {
        reasons.push(`claim uses an absolute: "${trunc(claim.statement)}"`);
        strong += 1;
      }
      // Overconfident: near-certain with a single thin evidence item.
      if (claim.confidence >= 0.95 && claim.evidence.length < 2) {
        reasons.push(`near-certain confidence on thin evidence: "${trunc(claim.statement)}"`);
      }
      // Evidence that does not actually trace to what was observed.
      const untraceable = claim.evidence.filter(
        (e) => result.toolTrace.length > 0 && !isEvidenceTraceable(e, result.toolTrace)
      );
      if (untraceable.length > 0 && untraceable.length === claim.evidence.length) {
        reasons.push(`no evidence for "${trunc(claim.statement)}" matches the tool log`);
        strong += 1;
      }
    }

    const soft = reasons.length - strong;
    const refuted = strong >= this.threshold || soft >= 2;
    const confidence = Math.min(1, strong * 0.4 + soft * 0.2);
    return { refuted, reasons, confidence };
  }
}

/**
 * LLM-backed skeptic. Prompts a model to argue *against* the result and parse a
 * verdict. Falls back to "not refuted" on parse/transport failure so an outage
 * never silently blocks good work (the gate remains the primary guard).
 */
export class LLMAdversary implements AdversarialVerifier {
  constructor(private readonly chat: (prompt: string) => Promise<string>) {}

  async refute(result: WorkerResult): Promise<Refutation> {
    const prompt = [
      "You are a skeptical reviewer. Try hard to REFUTE the following result.",
      "Look for unsupported leaps, evidence that doesn't match the claim, and overreach.",
      'Answer ONLY as JSON: { "refuted": boolean, "reasons": string[], "confidence": 0..1 }.',
      "",
      `OUTPUT: ${JSON.stringify(result.output)}`,
      `CLAIMS: ${JSON.stringify(result.claims)}`,
      `TOOL TRACE: ${JSON.stringify(result.toolTrace.map((t) => ({ tool: t.tool, output: t.output })))}`,
    ].join("\n");
    try {
      const raw = await this.chat(prompt);
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      return {
        refuted: !!parsed.refuted,
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      };
    } catch {
      return { refuted: false, reasons: ["adversary unavailable"], confidence: 0 };
    }
  }
}

function trunc(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
