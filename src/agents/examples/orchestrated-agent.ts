/**
 * Example: Orchestrated multi-agent system.
 *
 * A router agent triages requests and hands off to specialist agents:
 *   - ResearchAgent  — web search + scraping
 *   - CodeAgent      — code writing + execution
 *   - ComposioAgent  — 3rd-party app actions (GitHub, Slack, etc.)
 *
 * The OpenAI Agents SDK handles the handoff logic automatically.
 */

import { createOrchestrator } from "../orchestrator";

export const orchestratedSystem = createOrchestrator({
  routerAgent: {
    name: "RouterAgent",
    instructions: `You are a routing agent. Analyze the user's request and hand off to the most appropriate specialist:

- ResearchAgent: for questions requiring web search, current events, or fact-finding
- CodeAgent: for programming tasks, data analysis, or anything requiring code execution
- ComposioAgent: for actions in external apps (GitHub issues, Slack messages, email, etc.)

Hand off immediately without asking clarifying questions unless the request is completely ambiguous.`,
    maxTurns: 5,
  },
  specialists: [
    {
      name: "ResearchAgent",
      instructions: `You are a research specialist. Search the web and synthesize information to answer questions thoroughly. Always cite your sources.`,
      tools: ["web_search", "browser_scrape"],
      maxTurns: 10,
    },
    {
      name: "CodeAgent",
      instructions: `You are a coding specialist. Write and execute code to solve programming problems. Always verify your code runs before responding.`,
      tools: ["sandbox_run_code", "web_search"],
      maxTurns: 15,
    },
    {
      name: "ComposioAgent",
      instructions: `You are an integration specialist. Execute actions in external apps using Composio. Check what apps are connected before attempting actions, and guide the user to connect apps if needed.`,
      tools: ["composio_list_connections", "composio_execute", "composio_connect_app"],
      maxTurns: 10,
    },
  ],
});
