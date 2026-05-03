/**
 * Multi-agent orchestrator.
 *
 * Supports three orchestration patterns:
 *
 *  1. Triage/router     — a classifier agent uses SDK handoffs to delegate to
 *                         the right specialist automatically.
 *  2. Parallel fan-out  — run multiple agents concurrently, collect all outputs.
 *  3. Sequential chain  — pipe the output of one agent as input to the next.
 *
 * Handoffs use the OpenAI Agents SDK's first-class handoff support. The router
 * receives the full list of specialists as eligible handoff targets; the SDK
 * automatically injects a handoff tool for each one.
 *
 * For custom routing logic, provide `routerConfig.customRouter`:
 *   customRouter: async (input, specialists) => specialists.find(s => ...)
 * This lets you use deterministic rules, embeddings, or a secondary model to
 * choose the target agent before any LLM call is made.
 */

import { Agent, run } from "@openai/agents";
import { randomUUID } from "crypto";
import type { AgentConfig, AgentEvent, RunInput, RunResult } from "./types";
import { resolveAgentTools } from "./skills/index";
import { toOpenAITool } from "./utils";
import { config } from "./lib/config";
import { safeEmit } from "./observability/index";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveInstructions(
  agentConfig: AgentConfig,
  ctx: RunInput["context"]
): Promise<string> {
  if (typeof agentConfig.instructions === "function") {
    return agentConfig.instructions(ctx ?? {});
  }
  return agentConfig.instructions;
}

async function buildAgent(agentConfig: AgentConfig, ctx?: RunInput["context"]): Promise<Agent> {
  const toolDefs = resolveAgentTools(agentConfig.tools ?? [], agentConfig.skills ?? []);
  const openAITools = toolDefs.map((t) => toOpenAITool(t, ctx));
  const instructions = await resolveInstructions(agentConfig, ctx);
  const { modelSettings } = agentConfig;

  return new Agent({
    name: agentConfig.name,
    instructions,
    model: agentConfig.model ?? config.openai.model,
    tools: openAITools,
    ...(modelSettings?.temperature !== undefined && { temperature: modelSettings.temperature }),
  });
}

// ── Orchestrator types ────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  /** The triage/router agent that decides which specialist to invoke. */
  routerAgent: AgentConfig;
  /** Specialist agents the router can hand off to. */
  specialists: AgentConfig[];
  /**
   * Optional programmatic pre-routing function.
   * Return the target specialist config to skip the LLM router entirely,
   * or return null to fall through to the LLM router.
   */
  customRouter?: (
    input: string,
    specialists: AgentConfig[],
    ctx?: RunInput["context"]
  ) => Promise<AgentConfig | null>;
}

// ── Triage orchestrator ────────────────────────────────────────────────────────

/**
 * Create a triage orchestrator.
 * The router agent uses handoffs to delegate to specialist agents.
 */
export function createOrchestrator(orchConfig: OrchestratorConfig) {
  return {
    async run(input: RunInput): Promise<RunResult> {
      const runId = randomUUID();
      const userMessage = input.messages.at(-1)?.content ?? "";

      // Try custom router first
      if (orchConfig.customRouter) {
        const target = await orchConfig.customRouter(
          userMessage,
          orchConfig.specialists,
          input.context
        );
        if (target) {
          const agent = await buildAgent(target, input.context);
          const result = await run(agent, userMessage, {
            maxTurns: target.maxTurns ?? 20,
            signal: input.signal,
            context: input.context ?? {},
          });
          return {
            finalOutput: (result as { finalOutput?: string }).finalOutput ?? "",
            messages: input.messages,
            toolCalls: [],
          };
        }
      }

      // LLM-driven handoff routing
      const specialists = await Promise.all(
        orchConfig.specialists.map((s) => buildAgent(s, input.context))
      );

      const routerInstructions = await resolveInstructions(orchConfig.routerAgent, input.context);
      const routerTools = resolveAgentTools(
        orchConfig.routerAgent.tools ?? [],
        orchConfig.routerAgent.skills ?? []
      ).map((t) => toOpenAITool(t, input.context));

      const router = new Agent({
        name: orchConfig.routerAgent.name,
        instructions: routerInstructions,
        model: orchConfig.routerAgent.model ?? config.openai.model,
        tools: routerTools,
        handoffs: specialists,
      });

      await safeEmit("onRunStart", {
        runId,
        agentName: orchConfig.routerAgent.name,
        model: orchConfig.routerAgent.model ?? config.openai.model,
        startedAt: new Date(),
        userId: input.context?.userId as string | undefined,
      });

      const result = await run(router, userMessage, {
        maxTurns: orchConfig.routerAgent.maxTurns ?? 30,
        signal: input.signal,
        context: input.context ?? {},
      });

      const finalOutput = (result as { finalOutput?: string }).finalOutput ?? "";
      return { finalOutput, messages: input.messages, toolCalls: [] };
    },

    async *stream(input: RunInput): AsyncGenerator<AgentEvent> {
      const runId = randomUUID();
      const userMessage = input.messages.at(-1)?.content ?? "";

      const specialists = await Promise.all(
        orchConfig.specialists.map((s) => buildAgent(s, input.context))
      );

      const routerInstructions = await resolveInstructions(orchConfig.routerAgent, input.context);

      const router = new Agent({
        name: orchConfig.routerAgent.name,
        instructions: routerInstructions,
        model: orchConfig.routerAgent.model ?? config.openai.model,
        tools: resolveAgentTools(
          orchConfig.routerAgent.tools ?? [],
          orchConfig.routerAgent.skills ?? []
        ).map((t) => toOpenAITool(t, input.context)),
        handoffs: specialists,
      });

      try {
        const result = run(router, userMessage, {
          stream: true,
          maxTurns: orchConfig.routerAgent.maxTurns ?? 30,
          signal: input.signal,
          context: input.context ?? {},
        });

        let finalOutput = "";
        for await (const event of await result) {
          if (event.type === "raw_model_stream_event") {
            const delta = (event.data as { delta?: { content?: string } })?.delta?.content;
            if (delta) yield { type: "message_delta", delta };
          } else if (event.type === "run_item_stream_event") {
            const item = event.item as {
              type?: string;
              name?: string;
              callId?: string;
              input?: unknown;
              output?: unknown;
              content?: Array<{ type: string; text?: string }>;
            };
            if (item?.type === "tool_call_item") {
              yield { type: "tool_call", name: item.name ?? "", input: item.input, callId: item.callId ?? runId };
            } else if (item?.type === "message_output_item") {
              const text = item.content?.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("") ?? "";
              if (text) { finalOutput = text; yield { type: "message_done", content: text }; }
            }
          } else if (event.type === "agent_updated_stream_event") {
            const newAgent = event.agent as { name?: string };
            await safeEmit("onHandoff", orchConfig.routerAgent.name, newAgent.name ?? "", runId);
            yield { type: "handoff", from: orchConfig.routerAgent.name, to: newAgent.name ?? "" };
          }
        }

        const resolved = await (result as unknown as Promise<{ finalOutput: string }>);
        finalOutput = resolved.finalOutput ?? finalOutput;
        yield { type: "done", finalOutput };
      } catch (err) {
        yield { type: "error", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ── Parallel fan-out ──────────────────────────────────────────────────────────

/**
 * Run multiple agents in parallel and return all their outputs.
 * Useful for gathering diverse perspectives or splitting work across specialists.
 */
export async function runAgentsInParallel(
  agents: AgentConfig[],
  message: string,
  ctx?: RunInput["context"]
): Promise<Array<{ agentName: string; output: string; error?: string }>> {
  return Promise.all(
    agents.map(async (agentConfig) => {
      try {
        const agent = await buildAgent(agentConfig, ctx);
        const result = await run(agent, message, {
          maxTurns: agentConfig.maxTurns ?? 20,
          context: ctx ?? {},
        });
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
    })
  );
}

// ── Sequential chain ──────────────────────────────────────────────────────────

/**
 * Run agents sequentially, piping the output of each as input to the next.
 * Useful for multi-step pipelines where each agent refines the output.
 */
export async function runAgentChain(
  agents: AgentConfig[],
  initialMessage: string,
  ctx?: RunInput["context"]
): Promise<{ steps: Array<{ agentName: string; output: string }>; finalOutput: string }> {
  const steps: Array<{ agentName: string; output: string }> = [];
  let currentMessage = initialMessage;

  for (const agentConfig of agents) {
    const agent = await buildAgent(agentConfig, ctx);
    const result = await run(agent, currentMessage, {
      maxTurns: agentConfig.maxTurns ?? 20,
      context: ctx ?? {},
    });
    const output = (result as { finalOutput?: string }).finalOutput ?? "";
    steps.push({ agentName: agentConfig.name, output });
    currentMessage = output;
  }

  return { steps, finalOutput: currentMessage };
}
