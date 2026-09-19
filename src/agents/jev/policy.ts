/**
 * Pure policy layer. Jev owns semantic judgment; this file owns thresholds,
 * abstention, fail-open / fail-closed, and cache-aware downgrade guards.
 *
 * Distilled from jev-router, jcm-router, GodsBoy skill router, jev-judgment,
 * safer-with-jev, jev-mcp, and LangChain AutoMode / ModelRouter middleware.
 */

import { choiceMargin } from "./questions";
import type { ChoiceAnswer, PolicyAction, PolicyDecision } from "./types";

export interface ConfidenceGate {
  /** Minimum answer.confidence (choice/score). */
  minConfidence: number;
  /** Minimum P(selected option). */
  minProbability: number;
  /** Minimum P(winner) − P(runner-up). */
  minMargin: number;
}

export const GATES = {
  routing: { minConfidence: 0.65, minProbability: 0.7, minMargin: 0.2 } satisfies ConfidenceGate,
  classification: { minConfidence: 0.85, minProbability: 0.85, minMargin: 0.5 } satisfies ConfidenceGate,
  verification: { minConfidence: 0.8, minProbability: 0.8, minMargin: 0.2 } satisfies ConfidenceGate,
  voice: { minConfidence: 0.85, minProbability: 0.85, minMargin: 0.5 } satisfies ConfidenceGate,
  quietAskAuto: { minConfidence: 0.9, minProbability: 0.9, minMargin: 0.2 } satisfies ConfidenceGate,
} as const;

export const NOUL = {
  followupReuse: 0.55,
  needsSpecialist: 0.7,
  noSkill: 0.3,
  review: 0.5,
  injectionBlock: 0.75,
  injectionReview: 0.25,
  substanceSkip: 0.3,
  secretLeak: 0.9,
  destructive: 0.9,
  exfiltration: 0.7,
  beyondScope: 0.85,
  authorized: 0.55,
  routine: 0.75,
  goalDone: 0.85,
  stuck: 0.8,
  finish: 0.85,
  requirements: 0.8,
  needsVerification: 0.65,
  exists: 0.7,
  absent: 0.35,
  skillLoad: 0.8,
  stopHook: 0.8,
  clarify: 0.85,
  abstain: 0.75,
  invented: 0.7,
} as const;

export const SCORE = {
  impactHitl: 2.5,
  severityBlock: 2,
  routeSeverity: 1.5,
  screenFollowUp: 0.7,
} as const;

export const CACHE_DOWNGRADE_TOKEN_FLOOR = 20_000;
export const LOW_CONFIDENCE_CAP = 0.3;

export function passesGate(answer: ChoiceAnswer, gate: ConfidenceGate): boolean {
  const probability = answer.probabilities[answer.choice] ?? 0;
  const margin = choiceMargin(answer.probabilities, answer.choice);
  return answer.confidence >= gate.minConfidence && probability >= gate.minProbability && margin >= gate.minMargin;
}

export function gateFailureReason(answer: ChoiceAnswer, gate: ConfidenceGate): string {
  const probability = answer.probabilities[answer.choice] ?? 0;
  const margin = choiceMargin(answer.probabilities, answer.choice);
  if (answer.confidence < gate.minConfidence) return "low-confidence";
  if (probability < gate.minProbability) return "low-probability";
  if (margin < gate.minMargin) return "low-margin";
  return "ok";
}

export function noulBand(value: number, block: number, review: number): PolicyAction {
  if (value >= block) return "block";
  if (value >= review) return "review";
  return "auto";
}

export function decideUnavailable(node: string, fallback: string, failMode: "open" | "closed" | "review"): PolicyDecision {
  if (failMode === "closed") {
    return { action: "block", value: fallback, reason: "jev-unavailable", node };
  }
  if (failMode === "review") {
    return { action: "review", value: fallback, reason: "jev-unavailable", node };
  }
  return { action: "fallback", value: fallback, reason: "jev-unavailable", node };
}

export function decideChoice(
  node: string,
  answer: ChoiceAnswer,
  gate: ConfidenceGate,
  fallback: string
): PolicyDecision {
  if (!passesGate(answer, gate)) {
    return {
      action: "review",
      value: fallback,
      reason: gateFailureReason(answer, gate),
      node,
      confidence: answer.confidence,
      probability: answer.probabilities[answer.choice],
    };
  }
  return {
    action: "auto",
    value: answer.choice,
    reason: "jev",
    node,
    confidence: answer.confidence,
    probability: answer.probabilities[answer.choice],
  };
}

export function rankIndex(id: string, order: string[]): number {
  const index = order.indexOf(id);
  return index === -1 ? 0 : index;
}
