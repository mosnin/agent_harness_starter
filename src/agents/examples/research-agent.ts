/**
 * Example: Research Agent
 *
 * Searches the web and scrapes pages to answer research questions.
 * Wire up: set TAVILY_API_KEY (+ BROWSERBASE_API_KEY for JS-heavy sites).
 *
 * Demonstrates:
 *   - Explicit plugin composition with createCoreHarness
 *   - withMemory for per-user semantic recall
 *   - Skills-based tool disclosure ("research" skill bundle)
 *   - Dynamic instructions receiving user context
 *   - ModelSettings tuning
 *
 * Usage:
 *   import { createResearchAgent } from "@/agents/examples/research-agent";
 *   const harness = createResearchAgent();
 *   const result = await harness.run({ messages: [{ role: "user", content: "What is X?" }] });
 */

import { createCoreHarness } from "../core";
import { withMemory } from "../plugins/memory";
import { withObservability } from "../plugins/observability";
import type { AgentConfig } from "../types";

export const researchAgentConfig: AgentConfig = {
  name: "ResearchAgent",

  instructions: (ctx) => {
    const userLabel = ctx.userId ? `User: ${ctx.userId}` : "a user";
    return `You are a thorough research assistant helping ${userLabel}.

When given a question or topic:
1. Search the web using web_search to find current, relevant sources.
2. For pages that need JavaScript rendering, use browser_scrape to get full content.
3. Synthesize the information into a clear, well-cited answer.
4. Always mention your sources (URLs) at the end.

Be concise but complete. If information is conflicting, note the discrepancy.`;
  },

  skills: ["research"],

  modelSettings: {
    temperature: 0.3,
    maxTokens: 4096,
  },

  maxTurns: 10,
};

export function createResearchAgent() {
  return createCoreHarness({
    ...researchAgentConfig,
    plugins: [
      // Retrieve relevant past Q&A pairs and inject them into the system prompt.
      // After each run, store the exchange keyed by userId for future retrieval.
      withMemory({ key: "userId", topK: 5 }),
      // Fire-and-forget tracing to whatever adapter is registered at startup.
      withObservability(),
    ],
  });
}
