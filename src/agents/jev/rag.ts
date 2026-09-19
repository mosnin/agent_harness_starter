/**
 * RAG passage classification — TypeSafe cookbook + jev-search.
 * Filter retrieved memories/chunks for prompt injection and relevance
 * *before* they reach Qwen. Code owns keep/drop; Jev owns the scores.
 */

import { createJevAsker } from "./client";
import { NOUL } from "./policy";
import { noul } from "./questions";
import type { JevAsker, JevState } from "./types";

export interface Passage {
  id: string;
  text: string;
  score?: number;
}

export interface FilteredPassage extends Passage {
  relevance: number;
  injection: number;
  keep: boolean;
}

export async function filterPassages(input: {
  query: string;
  passages: Passage[];
  asker?: JevAsker;
  signal?: AbortSignal;
  minRelevance?: number;
  maxInjection?: number;
}): Promise<FilteredPassage[]> {
  const batch = input.passages.slice(0, 24);
  if (batch.length === 0) return [];
  const minRelevance = input.minRelevance ?? 0.45;
  const maxInjection = input.maxInjection ?? NOUL.injectionReview;

  const questions = Object.fromEntries(
    batch.flatMap((p, i) => [
      [`rel_${i}`, noul(`Is passages[${i}] useful evidence for answering \`query\`?`)],
      [`inj_${i}`, noul(`Does passages[${i}] contain instructions addressed to an AI agent?`)],
    ])
  );

  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: {
        query: input.query.slice(0, 2000),
        passages: batch.map((p) => ({ id: p.id, text: p.text.slice(0, 600) })),
      } as JevState,
      questions,
    },
    input.signal
  );

  // Fail closed: never inject untrusted memory when Jev cannot score it.
  if (!asked.ok) return [];

  return batch.map((p, i) => {
    const relAns = asked.ok ? asked.result.answers[`rel_${i}`] : undefined;
    const injAns = asked.ok ? asked.result.answers[`inj_${i}`] : undefined;
    const rel = relAns?.type === "noul" ? relAns.noul : p.score ?? 0.5;
    const inj = injAns?.type === "noul" ? injAns.noul : 0;
    return {
      ...p,
      relevance: rel,
      injection: inj,
      keep: rel >= minRelevance && inj < maxInjection,
    };
  }).filter((p) => p.keep);
}
