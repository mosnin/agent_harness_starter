/**
 * Example: Research Agent
 *
 * Searches the web and scrapes pages to answer research questions.
 * Wire up: set TAVILY_API_KEY (+ BROWSERBASE_API_KEY for JS-heavy sites).
 *
 * Demonstrates:
 *   - Skills-based tool disclosure (only "research" skill tools are visible)
 *   - Dynamic instructions receiving user context
 *   - Memory persistence (stores Q&A pairs keyed by userId)
 *   - ModelSettings tuning
 *
 * Usage:
 *   import { researchAgentConfig, createResearchAgent } from "@/agents/examples/research-agent";
 *   const harness = createResearchAgent();
 *   const result = await harness.run({ messages: [{ role: "user", content: "What is X?" }] });
 */

import { createHarness } from "../harness";
import type { AgentConfig } from "../types";

export const researchAgentConfig: AgentConfig = {
  name: "ResearchAgent",

  // Dynamic instructions — personalized per user context
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

  // Use the "research" skill bundle — only exposes web_search + browser_scrape
  skills: ["research"],

  modelSettings: {
    temperature: 0.3,  // lower = more factual
    maxTokens: 4096,
  },

  // Automatically retrieve and inject relevant past memories
  memoryKey: "userId",

  maxTurns: 10,
};

export function createResearchAgent() {
  return createHarness(researchAgentConfig);
}
