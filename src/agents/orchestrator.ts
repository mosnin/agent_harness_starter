/**
 * Multi-agent orchestrator.
 *
 * Supports two orchestration patterns:
 *
 *  1. Sequential pipeline  — run agents one after another, passing output as input
 *  2. Parallel fan-out     — run multiple agents concurrently, collect all results
 *
 * Under the hood this uses OpenAI Agents SDK handoffs for LLM-driven routing,
 * and native Promise.all for deterministic parallel execution.
 */

import { Agent, run } from "@openai/agents";
import { config } from "@/lib/config";
import { getTools } from "@/tools/registry";
import { toOpenAITool } from "./utils";
import type { AgentConfig, RunInput, RunResult } from "./types";

export interface OrchestratorConfig {
  /** The triage/router agent that decides which specialist to invoke. */
  routerAgent: AgentConfig;
  /** Specialist agents the router can hand off to. */
  specialists: AgentConfig[];
}

function buildAgent(agentConfig: AgentConfig, ctx?: RunInput["context"]): Agent {
  const toolDefs = getTools(agentConfig.tools ?? []);
  const openAITools = toolDefs.map((t) => toOpenAITool(t, ctx));

  return new Agent({
    name: agentConfig.name,
    instructions: agentConfig.instructions,
    model: agentConfig.model ?? config.openai.model,
    tools: openAITools,
    temperature: agentConfig.temperature,
  });
}

/**
 * Create a triage orchestrator.
 * The router agent uses handoffs to delegate to specialist agents automatically.
 */
export function createOrchestrator(orchConfig: OrchestratorConfig) {
  return {
    async run(input: RunInput): Promise<RunResult> {
      const specialists = orchConfig.specialists.map((s) => buildAgent(s, input.context));

      const router = new Agent({
        name: orchConfig.routerAgent.name,
        instructions: orchConfig.routerAgent.instructions,
        model: orchConfig.routerAgent.model ?? config.openai.model,
        tools: getTools(orchConfig.routerAgent.tools ?? []).map((t) =>
          toOpenAITool(t, input.context)
        ),
        handoffs: specialists,
      });

      const userMessage = input.messages.at(-1)?.content ?? "";

      const result = await run(router, userMessage, {
        maxTurns: orchConfig.routerAgent.maxTurns ?? 30,
        signal: input.signal,
      });

      return {
        finalOutput: (result as { finalOutput?: string }).finalOutput ?? "",
        messages: input.messages,
        toolCalls: [],
      };
    },
  };
}

/**
 * Run multiple agents in parallel and return all their outputs.
 * Useful for gathering diverse perspectives or splitting work across specialists.
 */
export async function runAgentsInParallel(
  agents: AgentConfig[],
  message: string,
  ctx?: RunInput["context"]
): Promise<Array<{ agentName: string; output: string; error?: string }>> {
  const tasks = agents.map(async (agentConfig) => {
    try {
      const agent = buildAgent(agentConfig, ctx);
      const result = await run(agent, message, { maxTurns: agentConfig.maxTurns ?? 20 });
      return {
        agentName: agentConfig.name,
        output: (result as { finalOutput?: string }).finalOutput ?? "",
      };
    } catch (err) {
      return {
        agentName: agentConfig.name,
        output: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  return Promise.all(tasks);
}
