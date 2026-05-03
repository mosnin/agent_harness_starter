/**
 * Example: Research Agent
 *
 * Searches the web and scrapes pages to answer research questions.
 * Wire up: set TAVILY_API_KEY (+ BROWSERBASE_API_KEY for JS-heavy sites).
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
  instructions: `You are a thorough research assistant.

When given a question or topic:
1. Search the web using web_search to find current, relevant sources.
2. For pages that need JavaScript rendering, use browser_scrape to get full content.
3. Synthesize the information into a clear, well-cited answer.
4. Always mention your sources (URLs) at the end.

Be concise but complete. If information is conflicting, note the discrepancy.`,
  tools: ["web_search", "browser_scrape", "browser_scrape_parallel"],
  maxTurns: 10,
};

export function createResearchAgent() {
  return createHarness(researchAgentConfig);
}
