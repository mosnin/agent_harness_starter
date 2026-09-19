/**
 * Strict answer validation (super-jev / jcm-router pattern).
 * Partial or malformed answers must never silently route a run.
 */

import type { JevAnswer, JevAnswers, JevQuestion, JevQuestions, SystemOneResult } from "./types";

const PROB_SUM_TOLERANCE = 0.08;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${field}: expected a finite number`);
  }
  return value;
}

function validateProbabilities(
  probabilities: unknown,
  allowed?: string[]
): Record<string, number> {
  if (!isRecord(probabilities)) {
    throw new Error("probabilities must be an object");
  }
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [key, raw] of Object.entries(probabilities)) {
    if (allowed && !allowed.includes(key)) {
      throw new Error(`Unexpected probability key "${key}"`);
    }
    const value = asNumber(raw, `probabilities.${key}`);
    if (value < -0.01 || value > 1.01) {
      throw new Error(`Probability for "${key}" is out of range`);
    }
    out[key] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > PROB_SUM_TOLERANCE) {
    throw new Error(`Probabilities must sum to ~1 (got ${sum.toFixed(3)})`);
  }
  return out;
}

function argMax(probabilities: Record<string, number>): string {
  let bestKey = "";
  let best = -Infinity;
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > best) {
      best = value;
      bestKey = key;
    }
  }
  if (!bestKey) throw new Error("Empty probability distribution");
  return bestKey;
}

export function validateAnswer(question: JevQuestion, raw: unknown, id: string): JevAnswer {
  if (!isRecord(raw) || raw.type !== question.type) {
    throw new Error(`Answer "${id}" has type "${String((raw as { type?: string })?.type)}" expected "${question.type}"`);
  }

  if (question.type === "noul") {
    const noulValue = asNumber(raw.noul, `${id}.noul`);
    if (noulValue < -0.01 || noulValue > 1.01) {
      throw new Error(`Answer "${id}".noul must be in [0, 1]`);
    }
    return { type: "noul", noul: Math.min(1, Math.max(0, noulValue)) };
  }

  if (question.type === "choice") {
    const keys = Object.keys(question.criteria);
    const probabilities = validateProbabilities(raw.probabilities, keys);
    const chosen = typeof raw.choice === "string" ? raw.choice : argMax(probabilities);
    if (!keys.includes(chosen)) {
      throw new Error(`Answer "${id}".choice "${chosen}" is not in criteria`);
    }
    const expected = argMax(probabilities);
    const choice = probabilities[chosen] >= (probabilities[expected] ?? 0) - 0.02 ? chosen : expected;
    const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : probabilities[choice] ?? 0;
    return { type: "choice", choice, probabilities, confidence };
  }

  const keys = question.criteria.map((_, i) => String(i));
  const probabilities = validateProbabilities(raw.probabilities, keys);
  let expected = 0;
  for (const [key, value] of Object.entries(probabilities)) {
    expected += Number(key) * value;
  }
  const scoreValue = typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : expected;
  const legend: Record<string, string> = isRecord(raw.legend)
    ? Object.fromEntries(
        Object.entries(raw.legend).map(([k, v]) => [k, typeof v === "string" ? v : String(v)])
      )
    : Object.fromEntries(question.criteria.map((level, i) => [String(i), level]));
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0;
  return { type: "score", score: scoreValue, legend, probabilities, confidence };
}

export function validateResult(questions: JevQuestions, raw: unknown): SystemOneResult {
  if (!isRecord(raw)) throw new Error("Jev response is not an object");
  if (!isRecord(raw.answers)) throw new Error("Jev response is missing answers");

  const answers: JevAnswers = {};
  for (const [id, question] of Object.entries(questions)) {
    if (!(id in raw.answers)) {
      throw new Error(`Jev response is missing answer "${id}"`);
    }
    answers[id] = validateAnswer(question, raw.answers[id], id);
  }

  const usage = isRecord(raw.usage)
    ? {
        input_tokens: typeof raw.usage.input_tokens === "number" ? raw.usage.input_tokens : undefined,
        output_tokens: typeof raw.usage.output_tokens === "number" ? raw.usage.output_tokens : undefined,
      }
    : undefined;

  return {
    model: typeof raw.model === "string" ? raw.model : "jev-latest",
    answers,
    ...(usage ? { usage } : {}),
  };
}

export function requireNoul(answers: JevAnswers, id: string): number {
  const answer = answers[id];
  if (!answer || answer.type !== "noul") {
    throw new Error(`Expected noul answer "${id}"`);
  }
  return answer.noul;
}

export function requireChoice(answers: JevAnswers, id: string): ChoiceAnswerSafe {
  const answer = answers[id];
  if (!answer || answer.type !== "choice") {
    throw new Error(`Expected choice answer "${id}"`);
  }
  return answer;
}

export function requireScore(answers: JevAnswers, id: string): { score: number; confidence: number } {
  const answer = answers[id];
  if (!answer || answer.type !== "score") {
    throw new Error(`Expected score answer "${id}"`);
  }
  return { score: answer.score, confidence: answer.confidence };
}

export type ChoiceAnswerSafe = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
