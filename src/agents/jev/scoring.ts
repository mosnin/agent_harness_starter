/**
 * Scoring and ranking — JevSlop, jev-search, pagegrade, citation-verifier,
 * clean-code-review, jev-bfs style composite scores.
 */

import { SLOP_LEVELS } from "./catalog";
import { createJevAsker } from "./client";
import { noul, score } from "./questions";
import type { JevAsker, JevQuestions, JevState, PolicyDecision } from "./types";
import { requireNoul, requireScore } from "./validate";

export interface QualityScoreInput {
  text: string;
  asker?: JevAsker;
  signal?: AbortSignal;
}

export interface QualityScore {
  overall: number;
  slop: number;
  grounded: number;
  specific: number;
  label: "ship" | "rewrite" | "review";
  decision: PolicyDecision;
}

export async function scoreQuality(input: QualityScoreInput): Promise<QualityScore> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: { text: input.text.slice(0, 8000) },
      questions: {
        slop: score("How much AI-slop does `text` exhibit (generic filler, hedging, ungrounded claims)?", SLOP_LEVELS),
        grounded: noul("Are the claims in `text` grounded in stated evidence or a clear caveat?"),
        specific: noul("Is `text` specific to the user's situation rather than generic advice?"),
      },
    },
    input.signal
  );

  if (!asked.ok) {
    return {
      overall: 0.5,
      slop: 1,
      grounded: 0.5,
      specific: 0.5,
      label: "review",
      decision: { action: "review", value: "review", reason: "jev-unavailable", node: "quality" },
    };
  }

  return interpretQuality(asked.result.answers);
}

export function interpretQuality(answers: import("./types").JevAnswers): QualityScore {
  const slop = requireScore(answers, "slop");
  const grounded = requireNoul(answers, "grounded");
  const specific = requireNoul(answers, "specific");
  const slopNorm = slop.score / Math.max(1, SLOP_LEVELS.length - 1);
  const overall = (grounded + specific + (1 - slopNorm)) / 3;
  const label = slop.score >= 2 && slop.confidence >= 0.7 ? "rewrite" : overall >= 0.55 ? "ship" : "review";
  return {
    overall,
    slop: slop.score,
    grounded,
    specific,
    label,
    decision: {
      action: label === "ship" ? "auto" : "review",
      value: label,
      reason: label,
      node: "quality",
      answers,
      confidence: slop.confidence,
    },
  };
}

export interface RankCandidate {
  id: string;
  title?: string;
  snippet: string;
  source?: string;
}

export interface RankedCandidate extends RankCandidate {
  relevance: number;
}

export async function rerankResults(input: {
  request: string;
  results: RankCandidate[];
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<RankedCandidate[]> {
  if (input.results.length === 0) return [];
  const batch = input.results.slice(0, 40);
  const questions = Object.fromEntries(
    batch.map((item, i) => [
      `rel_${i}`,
      noul(`Is results[${i}] (id=${item.id}) about \`request\`?`),
    ])
  );
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: {
        request: input.request.slice(0, 2000),
        results: batch.map((item) => ({
          id: item.id,
          title: item.title ?? "",
          snippet: item.snippet.slice(0, 400),
          source: item.source ?? "",
        })),
      } as JevState,
      questions,
    },
    input.signal
  );

  if (!asked.ok) {
    return batch.map((item) => ({ ...item, relevance: 0 }));
  }

  return batch
    .map((item, i) => ({
      ...item,
      relevance: (() => {
        const answer = asked.result.answers[`rel_${i}`];
        return answer?.type === "noul" ? answer.noul : 0;
      })(),
    }))
    .sort((a, b) => b.relevance - a.relevance);
}

export interface CompositeDimension {
  id: string;
  instructions: string;
  levels: string[];
  weight: number;
}

export async function compositeScore(input: {
  state: JevState;
  dimensions: CompositeDimension[];
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<{ total: number; parts: Record<string, number> }> {
  if (input.dimensions.length === 0) {
    throw new Error("compositeScore: dimensions must be non-empty");
  }
  const questions = Object.fromEntries(
    input.dimensions.map((dim) => [dim.id, score(dim.instructions, dim.levels)])
  );
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask({ state: input.state, questions }, input.signal);
  if (!asked.ok) return { total: 0, parts: {} };

  const parts: Record<string, number> = {};
  let weighted = 0;
  let weightSum = 0;
  for (const dim of input.dimensions) {
    const answer = requireScore(asked.result.answers, dim.id);
    const normalized = answer.score / Math.max(1, dim.levels.length - 1);
    parts[dim.id] = normalized;
    weighted += normalized * dim.weight;
    weightSum += dim.weight;
  }
  return { total: weightSum > 0 ? weighted / weightSum : 0, parts };
}

export const PAGE_GRADE_DIMENSIONS: CompositeDimension[] = [
  {
    id: "clarity",
    instructions: "How clear is `page_text` for a human reader?",
    levels: ["Opaque", "Skimmable", "Clear", "Excellent"],
    weight: 1,
  },
  {
    id: "seo",
    instructions: "How well does `page_text` match the apparent search intent of `task` / `url`?",
    levels: ["Off-intent", "Partial", "On-intent", "Authoritative"],
    weight: 1,
  },
  {
    id: "trust",
    instructions: "How trustworthy does `page_text` look (spam, phishing, or thin junk vs credible)?",
    levels: ["Spam", "Thin", "Credible", "Authoritative"],
    weight: 1,
  },
];

export function pageGradeQuestions(prefix = "pg_"): JevQuestions {
  return Object.fromEntries(
    PAGE_GRADE_DIMENSIONS.map((dim) => [
      `${prefix}${dim.id}`,
      score(dim.instructions, dim.levels),
    ])
  );
}

export function interpretPageGrade(
  answers: import("./types").JevAnswers,
  prefix = "pg_"
): PolicyDecision {
  let weighted = 0;
  let weightSum = 0;
  let trustScore = 1;
  let trustConfidence = 0;
  for (const dim of PAGE_GRADE_DIMENSIONS) {
    const answer = requireScore(answers, `${prefix}${dim.id}`);
    const normalized = answer.score / Math.max(1, dim.levels.length - 1);
    weighted += normalized * dim.weight;
    weightSum += dim.weight;
    if (dim.id === "trust") {
      trustScore = answer.score;
      trustConfidence = answer.confidence;
    }
  }
  const total = weightSum > 0 ? weighted / weightSum : 0;
  if (trustScore === 0 && trustConfidence >= 0.7) {
    return {
      action: "block",
      value: "spam",
      reason: "pagegrade-spam",
      node: "pagegrade",
      probability: total,
      confidence: trustConfidence,
      answers,
    };
  }
  const value = total >= 0.66 ? "good" : total >= 0.4 ? "ok" : "poor";
  return {
    action: value === "poor" ? "review" : "auto",
    value,
    reason: "pagegrade",
    node: "pagegrade",
    probability: total,
    answers,
  };
}

export async function scorePage(input: {
  url: string;
  title: string;
  excerpt: string;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: {
        url: input.url,
        title: input.title,
        page_text: input.excerpt.slice(0, 4000),
        task: input.title,
      },
      questions: pageGradeQuestions(),
    },
    input.signal
  );
  if (!asked.ok) {
    return {
      action: "review",
      value: "poor",
      reason: "jev-unavailable",
      node: "pagegrade",
    };
  }
  return interpretPageGrade(asked.result.answers);
}
