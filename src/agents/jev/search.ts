/**
 * jev-search pipeline: classify intent + sources, then rerank.
 */

import { createJevAsker } from "./client";
import { choice, noul } from "./questions";
import { rerankResults, type RankCandidate, type RankedCandidate } from "./scoring";
import type { JevAsker } from "./types";
import { requireChoice } from "./validate";

export interface SearchPlan {
  window: string;
  sources: string[];
  ranked: RankedCandidate[];
}

export async function planAndRerankSearch(input: {
  request: string;
  results: RankCandidate[];
  sources?: Record<string, string>;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<SearchPlan> {
  const sources = input.sources ?? {
    web: "General web search",
    docs: "Product / internal docs",
    code: "Repository and diffs",
    news: "Recent news",
  };
  const asker = input.asker ?? createJevAsker();
  const sourceQuestions = Object.fromEntries(
    Object.entries(sources).map(([id, desc]) => [`src_${id}`, noul(`Should we search ${desc} for \`request\`?`)])
  );
  const asked = await asker.ask(
    {
      state: { request: input.request.slice(0, 2000) },
      questions: {
        window: choice("What time window does `request` need?", {
          latest: "Need current or breaking information.",
          year: "Last year is enough.",
          anytime: "Timeless / evergreen.",
        }),
        ...sourceQuestions,
      },
    },
    input.signal
  );

  const selected = Object.keys(sources).filter((id) => {
    if (!asked.ok) return true;
    const ans = asked.result.answers[`src_${id}`];
    return ans?.type === "noul" ? ans.noul >= 0.6 : true;
  });

  const ranked = await rerankResults({
    request: input.request,
    results: input.results,
    asker,
    signal: input.signal,
  });

  return {
    window: asked.ok ? requireChoice(asked.result.answers, "window").choice : "anytime",
    sources: selected.length > 0 ? selected : Object.keys(sources),
    ranked,
  };
}
