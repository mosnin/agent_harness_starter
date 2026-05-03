/**
 * Example: Orchestrated multi-agent system.
 *
 * A router agent triages requests and hands off to specialist agents:
 *   - ResearchAgent  — web search + scraping
 *   - CodeAgent      — code writing + execution
 *   - ComposioAgent  — 3rd-party app actions (GitHub, Slack, etc.)
 *
 * The OpenAI Agents SDK handles handoff logic automatically via its first-class
 * handoff support — the router receives each specialist as an eligible handoff
 * target and the SDK injects a handoff tool for each one.
 *
 * Demonstrates:
 *   - LLM-driven triage/handoff routing
 *   - Dynamic instructions per specialist
 *   - Skills for progressive tool disclosure
 *   - customRouter for deterministic pre-routing
 *   - runAgentChain for sequential pipelines
 *   - runAgentsInParallel for fan-out
 */

import { createOrchestrator, runAgentChain, runAgentsInParallel } from "../orchestrator";
import type { AgentConfig } from "../types";

// ── Triage orchestrator ────────────────────────────────────────────────────────

export const orchestratedSystem = createOrchestrator({
  routerAgent: {
    name: "RouterAgent",
    instructions: (ctx) => `You are a routing agent${ctx.userId ? ` for user ${ctx.userId}` : ""}.
Analyze the user's request and hand off to the most appropriate specialist:

- ResearchAgent: for questions requiring web search, current events, or fact-finding
- CodeAgent: for programming tasks, data analysis, or anything requiring code execution
- ComposioAgent: for actions in external apps (GitHub, Slack, email, Notion, etc.)

Hand off immediately without asking clarifying questions unless the request is completely ambiguous.`,
    maxTurns: 5,
  },

  specialists: [
    {
      name: "ResearchAgent",
      instructions: `You are a research specialist. Search the web and synthesize information to answer questions thoroughly. Always cite your sources.`,
      skills: ["research"],
      maxTurns: 10,
    },
    {
      name: "CodeAgent",
      instructions: `You are a coding specialist. Write and execute code to solve programming problems. Always verify your code runs before responding.`,
      skills: ["code"],
      tools: ["sandbox_run_code"],
      maxTurns: 15,
    },
    {
      name: "ComposioAgent",
      instructions: `You are an integration specialist. Execute actions in external apps using Composio. Check what apps are connected before attempting actions, and guide the user to connect apps if needed.`,
      skills: ["integrations"],
      maxTurns: 10,
    },
  ],

  // Optional: short-circuit LLM routing with keyword detection
  customRouter: async (input, specialists) => {
    const lower = input.toLowerCase();
    if (lower.includes("github") || lower.includes("slack") || lower.includes("send email")) {
      return specialists.find((s) => s.name === "ComposioAgent") ?? null;
    }
    if (lower.includes("write code") || lower.includes("execute") || lower.includes("script")) {
      return specialists.find((s) => s.name === "CodeAgent") ?? null;
    }
    return null; // fall through to LLM router
  },
});

// ── Sequential pipeline ────────────────────────────────────────────────────────

/** Research → summarize → format. Each step receives the previous output. */
export const researchPipeline: AgentConfig[] = [
  {
    name: "Researcher",
    instructions: "Search the web and gather raw information about the topic.",
    skills: ["research"],
    maxTurns: 8,
  },
  {
    name: "Summarizer",
    instructions: "Given the raw research below, produce a concise 3-paragraph summary.",
    maxTurns: 3,
  },
  {
    name: "Formatter",
    instructions: "Format the summary as a structured markdown report with headers and bullet points.",
    maxTurns: 2,
  },
];

export async function runResearchPipeline(topic: string) {
  return runAgentChain(researchPipeline, `Research topic: ${topic}`);
}

// ── Parallel fan-out ──────────────────────────────────────────────────────────

/** Get multiple specialist opinions simultaneously. */
export async function getPerspectives(question: string) {
  return runAgentsInParallel(
    [
      {
        name: "TechPerspective",
        instructions: "Answer from a technical engineering perspective.",
        skills: ["research"],
        maxTurns: 5,
      },
      {
        name: "BusinessPerspective",
        instructions: "Answer from a business and product strategy perspective.",
        maxTurns: 5,
      },
      {
        name: "UserPerspective",
        instructions: "Answer from an end-user experience perspective.",
        maxTurns: 5,
      },
    ],
    question
  );
}
