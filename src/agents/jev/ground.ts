/**
 * Claim-level grounding — citation-verifier pattern without a second RTT.
 *
 * Code splits the draft. Jev scores each sentence in the same System One
 * call as postflight. High ungrounded mass → abstain, do not ship a guess.
 */

import { NOUL } from "./policy";
import { redactSecrets } from "./redact";
import type { JevAnswers, PolicyDecision } from "./types";

export const CLARIFY_REPLY =
  "I need one more detail before I act — what should I target, and what does done look like?";

export const MAX_GROUNDED_SENTENCES = 10;

export function splitSentences(text: string, max = MAX_GROUNDED_SENTENCES): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 24)
    .slice(0, max);
}

export function looksLikeAbstain(text: string): boolean {
  return /don't have enough grounded evidence|do not know|need one more detail/i.test(text);
}

export function abstainReply(evidence: string): string {
  const snippet = redactSecrets(evidence).text.trim().slice(0, 800);
  const body = snippet
    ? `What I can support from this session:\n${snippet}`
    : "No retrieved evidence was attached to this turn.";
  return `I don't have enough grounded evidence to state that confidently.\n\n${body}\n\nPoint me at a file or ask me to look it up and I'll answer from that.`;
}

export interface GroundingResult {
  decision: PolicyDecision;
  abstain?: string;
  ungrounded: number;
  scored: number;
}

export function interpretGrounding(
  answers: JevAnswers,
  input: { draft: string; evidence: string; sentences: string[]; strict?: boolean }
): GroundingResult {
  const scored = input.sentences.length;
  let ungrounded = 0;
  for (let i = 0; i < scored; i++) {
    const ans = answers[`g${i}`];
    if (ans?.type === "noul" && ans.noul >= 0.7) ungrounded += 1;
  }

  const inventedNumbers = answers.invented_numbers?.type === "noul" ? answers.invented_numbers.noul : 0;
  const inventedSources = answers.invented_sources?.type === "noul" ? answers.invented_sources.noul : 0;
  const needsAbstain = answers.needs_abstain?.type === "noul" ? answers.needs_abstain.noul : 0;
  const ratio = scored > 0 ? ungrounded / scored : 0;
  const threshold = input.strict ? 0.35 : 0.5;
  const shouldAbstain =
    !looksLikeAbstain(input.draft) &&
    (needsAbstain >= NOUL.abstain ||
      inventedNumbers >= NOUL.invented ||
      inventedSources >= NOUL.invented ||
      ratio >= threshold);

  const decision: PolicyDecision = {
    action: shouldAbstain ? "block" : ratio > 0 ? "review" : "auto",
    value: shouldAbstain ? "abstain" : "grounded",
    reason: shouldAbstain ? "ungrounded-claims" : "grounded",
    node: "grounding",
    answers,
    probability: scored > 0 ? ratio : needsAbstain,
  };

  return {
    decision,
    abstain: shouldAbstain ? abstainReply(input.evidence) : undefined,
    ungrounded,
    scored,
  };
}
