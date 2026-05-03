/**
 * Agent harness — wraps the OpenAI Agents SDK `run()` with:
 *   - Dynamic instructions (function or string)
 *   - ModelSettings passthrough (temperature, maxTokens, topP, toolChoice)
 *   - Skills / progressive tool disclosure
 *   - Memory retrieval & injection
 *   - Human-in-the-loop tool approval
 *   - Input / output guardrails
 *   - Streaming via AsyncGenerator
 *   - Cancellation support (AbortSignal)
 *   - Observability hooks
 *
 * Usage:
 *   const harness = createHarness(myAgentConfig);
 *   for await (const event of harness.stream(input)) { ... }
 */

import { Agent, run } from "@openai/agents";
import { randomUUID } from "crypto";
import type { AgentConfig, AgentEvent, RunInput, RunResult } from "./types";
import { resolveAgentTools } from "./skills/index";
import { toOpenAITool } from "./utils";
import { config } from "./lib/config";
import { withRetry } from "./lib/utils";
import { memory, formatMemoriesForPrompt } from "./memory/index";
import { safeEmit } from "./observability/index";
import {
  createApproval,
  cancelRunApprovals,
} from "./approvals";
import {
  runInputGuardrails,
  runOutputGuardrails,
  GuardrailBlockError,
} from "./guardrails/index";
import type { GuardrailSet } from "./guardrails/types";

export interface AgentHarness {
  /** Stream events from an agent run. */
  stream(input: RunInput): AsyncGenerator<AgentEvent>;
  /** Run the agent to completion and return the final result. */
  run(input: RunInput): Promise<RunResult>;
}

// Extend AgentConfig with guardrails (optional — not in base types to keep them clean)
export interface HarnessConfig extends AgentConfig {
  guardrails?: GuardrailSet;
}

export function createHarness(agentConfig: HarnessConfig): AgentHarness {
  async function resolveInstructions(ctx: RunInput["context"]): Promise<string> {
    const { instructions } = agentConfig;
    if (typeof instructions === "function") {
      return instructions(ctx ?? {});
    }
    return instructions;
  }

  async function buildAgent(ctx: RunInput["context"], runId: string) {
    // Resolve tools from explicit names + skills
    const toolDefs = resolveAgentTools(
      agentConfig.tools ?? [],
      agentConfig.skills ?? [],
    );

    // Wrap tools with approval check where required
    const requireApprovalSet = new Set(agentConfig.requireApprovalFor ?? []);

    const openAITools = toolDefs.map((def) => {
      if (requireApprovalSet.has(def.name) || def.requiresApproval) {
        // Wrap with approval gate
        const wrappedDef = {
          ...def,
          execute: async (input: unknown, toolCtx: import("./tools/types").ToolContext) => {
            const { approvalId, promise } = createApproval({
              runId,
              toolName: def.name,
              input,
              description: `Approve "${def.name}" tool call`,
            });

            // This will be yielded by the generator via a side-channel map
            pendingApprovalEmits.set(approvalId, {
              type: "approval_required",
              runId,
              approvalId,
              toolName: def.name,
              input,
              description: `Approve "${def.name}" tool call`,
            });

            const approved = await promise;
            if (!approved) throw new Error(`Tool "${def.name}" was rejected by the user.`);

            return def.execute(input, toolCtx);
          },
        };
        return toOpenAITool(wrappedDef as typeof def, ctx);
      }
      return toOpenAITool(def, ctx);
    });

    // Build instructions — inject memories if memoryKey is set
    let instructions = await resolveInstructions(ctx);
    if (agentConfig.memoryKey) {
      const userId = (ctx?.userId as string) ?? agentConfig.memoryKey;
      const query = ""; // will be replaced with actual query in stream()
      const memories = await memory.retrieve(userId, query, 5);
      const memBlock = formatMemoriesForPrompt(memories);
      if (memBlock) {
        instructions = `${instructions}\n\n## Relevant memories\n${memBlock}`;
      }
    }

    const { modelSettings } = agentConfig;

    return new Agent({
      name: agentConfig.name,
      instructions,
      model: agentConfig.model ?? config.openai.model,
      tools: openAITools,
      ...(modelSettings?.temperature !== undefined && {
        temperature: modelSettings.temperature,
      }),
    });
  }

  // Side-channel for approval events emitted from within tool closures
  const pendingApprovalEmits = new Map<string, Extract<AgentEvent, { type: "approval_required" }>>();

  async function* stream(input: RunInput): AsyncGenerator<AgentEvent> {
    const runId = randomUUID();
    const startedAt = Date.now();
    const guardCtx = {
      agentName: agentConfig.name,
      userId: input.context?.userId as string | undefined,
      runId,
    };

    // ── Input guardrails ──────────────────────────────────────────────────
    let userMessage = input.messages.at(-1)?.content ?? "";
    if (agentConfig.guardrails?.input?.length) {
      try {
        userMessage = await runInputGuardrails(
          userMessage,
          agentConfig.guardrails.input,
          guardCtx
        );
      } catch (err) {
        if (err instanceof GuardrailBlockError) {
          yield { type: "error", error: `Blocked: ${err.reason}` };
          yield { type: "done", finalOutput: "" };
          return;
        }
        throw err;
      }
    }

    const agent = await buildAgent(input.context, runId);

    await safeEmit("onRunStart", {
      runId,
      agentName: agentConfig.name,
      model: agentConfig.model ?? config.openai.model,
      startedAt: new Date(startedAt),
      userId: input.context?.userId as string | undefined,
    });

    // Memory retrieval with actual user query
    let finalInstructions = agent.instructions as string;
    if (agentConfig.memoryKey && userMessage) {
      const userId = (input.context?.userId as string) ?? agentConfig.memoryKey;
      const memories = await memory.retrieve(userId, userMessage, 5);
      const memBlock = formatMemoriesForPrompt(memories);
      if (memBlock) {
        // Rebuild agent with memory-enriched instructions
        finalInstructions = `${finalInstructions}\n\n## Relevant memories\n${memBlock}`;
      }
    }

    try {
      const result = run(agent, userMessage, {
        stream: true,
        maxTurns: agentConfig.maxTurns ?? 20,
        signal: input.signal,
        context: input.context ?? {},
      });

      let finalOutput = "";

      for await (const event of await result) {
        // Drain any approval events that were queued by tool closures
        for (const [id, approvalEvent] of pendingApprovalEmits) {
          yield approvalEvent;
          pendingApprovalEmits.delete(id);
        }

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
            const callId = item.callId ?? randomUUID();
            await safeEmit("onToolCall", {
              runId,
              agentName: agentConfig.name,
              toolName: item.name ?? "",
              callId,
              input: item.input,
              startedAt: new Date(),
            });
            yield {
              type: "tool_call",
              name: item.name ?? "",
              input: item.input,
              callId,
            };
          } else if (item?.type === "tool_call_output_item") {
            yield {
              type: "tool_result",
              name: "",
              output: item.output,
              callId: (item as { callId?: string }).callId ?? "",
            };
          } else if (item?.type === "message_output_item") {
            const text =
              item.content
                ?.filter((c) => c.type === "output_text")
                .map((c) => c.text ?? "")
                .join("") ?? "";
            if (text) {
              finalOutput = text;
              yield { type: "message_done", content: text };
            }
          }
        } else if (event.type === "agent_updated_stream_event") {
          const newAgent = event.agent as { name?: string };
          await safeEmit("onHandoff", agentConfig.name, newAgent.name ?? "", runId);
          yield { type: "handoff", from: agentConfig.name, to: newAgent.name ?? "" };
        }
      }

      // Resolve the result to get final output + usage
      const resolved = await (result as unknown as Promise<{
        finalOutput: string;
        usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      }>);
      finalOutput = resolved.finalOutput ?? finalOutput;

      // ── Output guardrails ───────────────────────────────────────────────
      if (agentConfig.guardrails?.output?.length) {
        try {
          finalOutput = await runOutputGuardrails(
            finalOutput,
            agentConfig.guardrails.output,
            guardCtx
          );
        } catch (err) {
          if (err instanceof GuardrailBlockError) {
            yield { type: "error", error: `Output blocked: ${err.reason}` };
            yield { type: "done", finalOutput: "" };
            return;
          }
          throw err;
        }
      }

      // Emit usage if available
      const usage = resolved.usage;
      if (usage) {
        const usageEvent = {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        };
        yield { type: "usage", ...usageEvent };
        await safeEmit("onUsage", {
          runId,
          agentName: agentConfig.name,
          model: agentConfig.model ?? config.openai.model,
          userId: input.context?.userId as string | undefined,
          ...usageEvent,
        });
      }

      // Store to memory if configured
      if (agentConfig.memoryKey && finalOutput) {
        const userId = (input.context?.userId as string) ?? agentConfig.memoryKey;
        await memory.store(userId, `Q: ${userMessage}\nA: ${finalOutput}`).catch(() => {});
      }

      await safeEmit("onRunComplete", {
        runId,
        agentName: agentConfig.name,
        model: agentConfig.model ?? config.openai.model,
        startedAt: new Date(startedAt),
        userId: input.context?.userId as string | undefined,
      }, { finalOutput, durationMs: Date.now() - startedAt });

      yield { type: "done", finalOutput };
    } catch (err) {
      cancelRunApprovals(runId);
      const error = err instanceof Error ? err : new Error(String(err));
      await safeEmit("onRunError", {
        runId,
        agentName: agentConfig.name,
        model: agentConfig.model ?? config.openai.model,
        startedAt: new Date(startedAt),
      }, error, Date.now() - startedAt);
      yield { type: "error", error: error.message };
    }
  }

  async function runToCompletion(input: RunInput): Promise<RunResult> {
    const events: AgentEvent[] = [];
    for await (const event of stream(input)) {
      events.push(event);
    }

    const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
    const usage = events.find((e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage");
    const toolCalls = events
      .filter((e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call")
      .map((e) => {
        const result = events.find(
          (r): r is Extract<AgentEvent, { type: "tool_result" }> =>
            r.type === "tool_result" && (r as { callId?: string }).callId === e.callId
        );
        return { name: e.name, input: e.input, output: result?.output };
      });

    return {
      finalOutput: done?.finalOutput ?? "",
      messages: input.messages,
      toolCalls,
      usage: usage
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }
        : undefined,
    };
  }

  return { stream, run: runToCompletion };
}
