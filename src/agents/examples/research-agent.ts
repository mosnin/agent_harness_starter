/**
 * Example: Research Agent
 *
 * Searches the web and scrapes pages to answer research questions.
 * Wire up: set TAVILY_API_KEY (+ BROWSERBASE_API_KEY for JS-heavy sites).
 *
 * Demonstrates:
 *   - Plugins embedded directly in AgentConfig (self-contained config)
 *   - Self-registration via registerAgent (no route edits needed)
 *   - withMemory for per-user semantic recall
 *   - Skills-based tool disclosure ("research" skill bundle)
 *   - Dynamic instructions receiving user context
 *
 * Usage:
 *   import "@/agents/examples/research-agent"; // registers "research"
 *   // or import the barrel: import "@/agents/examples";
 */

import { createCoreHarness } from "../core";
import { withMemory } from "../plugins/memory";
import { withObservability } from "../plugins/observability";
import { registerAgent } from "../agent-registry";
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

  plugins: [
    withMemory({ key: "userId", topK: 5 }),
    withObservability(),
  ],
};

// Self-register so the agent route can look this up by name without
// any manual edits to the route file.
registerAgent("research", researchAgentConfig);

export function createResearchAgent() {
  return createCoreHarness(researchAgentConfig);
}
