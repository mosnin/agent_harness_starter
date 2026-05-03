/**
 * Agent harness — wraps the OpenAI Agents SDK `run()` with:
 *   - Streaming via AsyncGenerator
 *   - Cancellation support
 *   - Retry on transient errors
 *   - Tool context threading
 *
 * Usage:
 *   const harness = createHarness(myAgent);
 *   for await (const event of harness.stream(input)) { ... }
 */

import { Agent, run } from "@openai/agents";
import type { AgentEvent, RunInput, RunResult } from "./types";
import { getTools } from "@/tools/registry";
import { toOpenAITool } from "./utils";
import { config } from "@/lib/config";
import { withRetry } from "@/lib/utils";
import type { AgentConfig } from "./types";

export interface AgentHarness {
  /** Stream events from an agent run. */
  stream(input: RunInput): AsyncGenerator<AgentEvent>;
  /** Run the agent to completion and return the final result. */
  run(input: RunInput): Promise<RunResult>;
}

export function createHarness(agentConfig: AgentConfig): AgentHarness {
  function buildAgent(ctx: RunInput["context"]) {
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

  async function* stream(input: RunInput): AsyncGenerator<AgentEvent> {
    const agent = buildAgent(input.context);

    const userMessage = input.messages.at(-1)?.content ?? "";

    try {
      const result = run(agent, userMessage, {
        stream: true,
        maxTurns: agentConfig.maxTurns ?? 20,
        signal: input.signal,
      });

      for await (const event of await result) {
        if (event.type === "raw_model_stream_event") {
          const delta = (event.data as { delta?: { content?: string } })?.delta?.content;
          if (delta) yield { type: "message_delta", delta };
        } else if (event.type === "run_item_stream_event") {
          const item = event.item as { type?: string; name?: string; input?: unknown; output?: unknown; content?: Array<{type: string; text?: string}> };
          if (item?.type === "tool_call_item") {
            yield { type: "tool_call", name: item.name ?? "", input: item.input };
          } else if (item?.type === "tool_call_output_item") {
            yield { type: "tool_result", name: "", output: item.output };
          } else if (item?.type === "message_output_item") {
            const text = item.content
              ?.filter((c) => c.type === "output_text")
              .map((c) => c.text ?? "")
              .join("") ?? "";
            if (text) yield { type: "message_done", content: text };
          }
        } else if (event.type === "agent_updated_stream_event") {
          // handoff event
          const newAgent = event.agent as { name?: string };
          yield { type: "handoff", from: agentConfig.name, to: newAgent.name ?? "" };
        }
      }

      const finalResult = await (result as unknown as Promise<{ finalOutput: string }>);
      yield { type: "done", finalOutput: finalResult.finalOutput ?? "" };
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function runToCompletion(input: RunInput): Promise<RunResult> {
    const agent = buildAgent(input.context);
    const userMessage = input.messages.at(-1)?.content ?? "";

    const toolCalls: RunResult["toolCalls"] = [];

    const result = await withRetry(
      () =>
        run(agent, userMessage, {
          maxTurns: agentConfig.maxTurns ?? 20,
          signal: input.signal,
        }),
      { attempts: 3, baseDelay: 1000 }
    );

    return {
      finalOutput: (result as { finalOutput?: string }).finalOutput ?? "",
      messages: input.messages,
      toolCalls,
    };
  }

  return { stream, run: runToCompletion };
}
