/**
 * Multi-agent orchestrator.
 *
 * Supports five orchestration patterns:
 *
 *  1. Triage/router     — a classifier agent uses SDK handoffs to delegate to
 *                         the right specialist automatically.
 *  2. Parallel fan-out  — run multiple agents concurrently, collect all outputs.
 *  3. Sequential chain  — pipe the output of one agent as input to the next.
 *  4. Conditional       — branch to different agents based on predicates applied
 *                         to the input or prior agent output.
 *  5. Iterative/loop    — repeat an agent (or chain) until a stop condition is
 *                         met (e.g. critic score ≥ threshold, max passes).
 *  6. Hierarchical      — a supervisor orchestrator manages a set of child
 *                         orchestrators (each with their own specialists).
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

// ── Conditional orchestration ─────────────────────────────────────────────────

export interface ConditionalBranch {
  /**
   * Predicate evaluated against the current message (and optional prior output).
   * Branches are evaluated in array order — first match wins.
   * Return true to select this branch.
   */
  when: (input: string, priorOutput?: string, ctx?: RunInput["context"]) => boolean | Promise<boolean>;
  /** Agent to run if the predicate matches. */
  agent: AgentConfig;
  /** Human-readable label for logging. */
  label?: string;
}

export interface ConditionalOrchestrationConfig {
  /** Ordered list of condition → agent branches. First match wins. */
  branches: ConditionalBranch[];
  /** Fallback agent when no branch predicate matches. Required. */
  fallback: AgentConfig;
}

/**
 * Run the first agent whose predicate matches the input.
 * If no predicate matches, runs the fallback agent.
 *
 * Example:
 *   runConditional({
 *     branches: [
 *       { when: (msg) => /urgent/i.test(msg), agent: escalationAgent, label: "urgent" },
 *       { when: (msg) => msg.length < 50,      agent: quickAgent,      label: "short" },
 *     ],
 *     fallback: generalAgent,
 *   }, message)
 */
export async function runConditional(
  config: ConditionalOrchestrationConfig,
  message: string,
  ctx?: RunInput["context"]
): Promise<{ agentName: string; branch: string; output: string }> {
  for (const branch of config.branches) {
    const match = await Promise.resolve(branch.when(message, undefined, ctx));
    if (match) {
      const agent = await buildAgent(branch.agent, ctx);
      const result = await run(agent, message, {
        maxTurns: branch.agent.maxTurns ?? 20,
        context: ctx ?? {},
      });
      return {
        agentName: branch.agent.name,
        branch: branch.label ?? branch.agent.name,
        output: (result as { finalOutput?: string }).finalOutput ?? "",
      };
    }
  }

  const fallback = await buildAgent(config.fallback, ctx);
  const result = await run(fallback, message, {
    maxTurns: config.fallback.maxTurns ?? 20,
    context: ctx ?? {},
  });
  return {
    agentName: config.fallback.name,
    branch: "fallback",
    output: (result as { finalOutput?: string }).finalOutput ?? "",
  };
}

// ── Iterative / loop orchestration ────────────────────────────────────────────

export interface IterativeOrchestrationConfig {
  /** The agent to run each iteration. */
  agent: AgentConfig;
  /**
   * Stop condition evaluated after each iteration.
   * Return true to stop, false to continue.
   * Receives the current output, the iteration index (0-based), and context.
   */
  stopWhen: (
    output: string,
    iteration: number,
    ctx?: RunInput["context"]
  ) => boolean | Promise<boolean>;
  /** Hard limit on iterations. Default: 5. Prevents infinite loops. */
  maxIterations?: number;
  /**
   * How to build the input for the next iteration.
   * Default: pass the previous output directly.
   */
  buildNextInput?: (
    previousOutput: string,
    iteration: number,
    originalMessage: string
  ) => string;
}

export interface IterativeResult {
  iterations: Array<{ iteration: number; input: string; output: string }>;
  finalOutput: string;
  stoppedBy: "condition" | "max_iterations";
}

/**
 * Run an agent in a loop until the stop condition is met or maxIterations is reached.
 *
 * Useful for critic-revision cycles, retry-until-confident flows,
 * and incremental refinement pipelines.
 *
 * Example:
 *   runIterative({
 *     agent: draftAgent,
 *     stopWhen: async (output) => await judgeScore(output) >= 8,
 *     maxIterations: 3,
 *   }, userMessage)
 */
export async function runIterative(
  config: IterativeOrchestrationConfig,
  initialMessage: string,
  ctx?: RunInput["context"]
): Promise<IterativeResult> {
  const {
    agent: agentConfig,
    stopWhen,
    maxIterations = 5,
    buildNextInput = (prev) => prev,
  } = config;

  const iterations: Array<{ iteration: number; input: string; output: string }> = [];
  let currentInput = initialMessage;
  let stoppedBy: IterativeResult["stoppedBy"] = "max_iterations";

  for (let i = 0; i < maxIterations; i++) {
    const agent = await buildAgent(agentConfig, ctx);
    const result = await run(agent, currentInput, {
      maxTurns: agentConfig.maxTurns ?? 20,
      context: ctx ?? {},
    });
    const output = (result as { finalOutput?: string }).finalOutput ?? "";
    iterations.push({ iteration: i, input: currentInput, output });

    const stop = await Promise.resolve(stopWhen(output, i, ctx));
    if (stop) {
      stoppedBy = "condition";
      return { iterations, finalOutput: output, stoppedBy };
    }

    currentInput = buildNextInput(output, i + 1, initialMessage);
  }

  return {
    iterations,
    finalOutput: iterations.at(-1)?.output ?? "",
    stoppedBy,
  };
}

// ── Hierarchical orchestration ────────────────────────────────────────────────

export interface ChildOrchestrator {
  /** Label used in result and logging. */
  name: string;
  /**
   * Run this sub-orchestrator with the given message and context.
   * Returns the final output string.
   */
  run: (message: string, ctx?: RunInput["context"]) => Promise<string>;
  /**
   * Optional predicate: only invoke this child if true.
   * When omitted, the child is always invoked.
   */
  when?: (message: string, ctx?: RunInput["context"]) => boolean | Promise<boolean>;
}

export interface HierarchicalOrchestrationConfig {
  /**
   * The supervisor agent that aggregates child outputs into a final response.
   * Receives a synthesis prompt (child names + outputs) as input.
   */
  supervisor: AgentConfig;
  /** Child orchestrators to fan out to. */
  children: ChildOrchestrator[];
  /**
   * How to build the supervisor's synthesis prompt.
   * Default: JSON block listing each child name and output.
   */
  buildSynthesisPrompt?: (
    originalMessage: string,
    childResults: Array<{ name: string; output: string }>
  ) => string;
}

export interface HierarchicalResult {
  childResults: Array<{ name: string; output: string; skipped?: boolean }>;
  supervisorOutput: string;
}

/**
 * Fan out to multiple child orchestrators (potentially each with their own agents),
 * then have a supervisor agent synthesize the results.
 *
 * Children run in parallel. The supervisor receives a structured summary of all outputs.
 *
 * Example:
 *   runHierarchical({
 *     supervisor: synthesisAgent,
 *     children: [
 *       { name: "legal",  run: (msg, ctx) => legalOrchestrator.run({ messages: [...], context: ctx }) },
 *       { name: "market", run: (msg, ctx) => marketOrchestrator.run(msg, ctx) },
 *     ],
 *   }, userMessage)
 */
export async function runHierarchical(
  config: HierarchicalOrchestrationConfig,
  message: string,
  ctx?: RunInput["context"]
): Promise<HierarchicalResult> {
  const {
    supervisor,
    children,
    buildSynthesisPrompt = defaultSynthesisPrompt,
  } = config;

  // Fan out to all eligible children in parallel
  const childResults = await Promise.all(
    children.map(async (child) => {
      if (child.when) {
        const eligible = await Promise.resolve(child.when(message, ctx));
        if (!eligible) return { name: child.name, output: "", skipped: true as const };
      }
      const output = await child.run(message, ctx);
      return { name: child.name, output };
    })
  );

  // Supervisor synthesizes active children's outputs
  const synthesisPrompt = buildSynthesisPrompt(message, childResults.filter((r) => !r.skipped));
  const supervisorAgent = await buildAgent(supervisor, ctx);
  const result = await run(supervisorAgent, synthesisPrompt, {
    maxTurns: supervisor.maxTurns ?? 20,
    context: ctx ?? {},
  });

  return {
    childResults,
    supervisorOutput: (result as { finalOutput?: string }).finalOutput ?? "",
  };
}

function defaultSynthesisPrompt(
  originalMessage: string,
  childResults: Array<{ name: string; output: string }>
): string {
  const outputs = childResults
    .map((r) => `### ${r.name}\n${r.output}`)
    .join("\n\n");
  return `Original request:\n${originalMessage}\n\nSub-agent outputs:\n\n${outputs}\n\nSynthesize the above into a single coherent response.`;
}
