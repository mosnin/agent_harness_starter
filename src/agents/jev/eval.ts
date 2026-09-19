/**
 * Evaluation and calibration — jev-eval, jevcal, WindTunnel, abide, decider.
 *
 * Compare Jev answers to gold labels and keep a running reliability picture
 * so Hades can raise thresholds on noisy nodes.
 */

import type { JevAnswer, PolicyAction } from "./types";

export interface GoldCase {
  id: string;
  node: string;
  expected: string | number | boolean;
  answer: JevAnswer;
  action?: PolicyAction;
}

export interface NodeCalibration {
  node: string;
  n: number;
  accuracy: number;
  brier: number;
  meanConfidence: number;
  verdict: "decisive" | "weak" | "noisy" | "skipped";
}

function predictedValue(answer: JevAnswer): string {
  if (answer.type === "noul") return answer.noul >= 0.5 ? "true" : "false";
  if (answer.type === "choice") return answer.choice;
  return String(Math.round(answer.score));
}

function predictedProbability(answer: JevAnswer, gold: string): number {
  if (answer.type === "noul") {
    return gold === "true" || gold === "1" || gold === "yes" ? answer.noul : 1 - answer.noul;
  }
  if (answer.type === "choice") {
    return answer.probabilities[gold] ?? 0;
  }
  const key = gold;
  return answer.probabilities[key] ?? 0;
}

function confidenceOf(answer: JevAnswer): number {
  if (answer.type === "noul") return Math.abs(answer.noul - 0.5) * 2;
  return answer.confidence;
}

export function evaluateCases(cases: GoldCase[]): NodeCalibration[] {
  const byNode = new Map<string, GoldCase[]>();
  for (const item of cases) {
    const list = byNode.get(item.node) ?? [];
    list.push(item);
    byNode.set(item.node, list);
  }

  const results: NodeCalibration[] = [];
  for (const [node, list] of byNode) {
    if (list.length < 5) {
      results.push({ node, n: list.length, accuracy: 0, brier: 1, meanConfidence: 0, verdict: "skipped" });
      continue;
    }
    let correct = 0;
    let brier = 0;
    let conf = 0;
    for (const item of list) {
      const gold = String(item.expected);
      if (predictedValue(item.answer) === gold) correct += 1;
      const p = predictedProbability(item.answer, gold);
      brier += (1 - p) ** 2;
      conf += confidenceOf(item.answer);
    }
    const accuracy = correct / list.length;
    const meanBrier = brier / list.length;
    const meanConfidence = conf / list.length;
    let verdict: NodeCalibration["verdict"] = "decisive";
    if (meanConfidence < 0.7 && accuracy < 0.75) verdict = "weak";
    if (accuracy < 0.55) verdict = "noisy";
    results.push({ node, n: list.length, accuracy, brier: meanBrier, meanConfidence, verdict });
  }
  return results;
}

export function suggestedThreshold(cal: NodeCalibration, current: number): number {
  if (cal.verdict === "noisy") return Math.min(0.95, current + 0.1);
  if (cal.verdict === "weak") return Math.min(0.9, current + 0.05);
  if (cal.verdict === "decisive" && cal.accuracy >= 0.9) return Math.max(0.55, current - 0.05);
  return current;
}

export interface EvalReport {
  nodes: NodeCalibration[];
  cases: number;
  passed: number;
}

export function runEval(cases: GoldCase[]): EvalReport {
  const nodes = evaluateCases(cases);
  const passed = cases.filter((item) => predictedValue(item.answer) === String(item.expected)).length;
  return { nodes, cases: cases.length, passed };
}
