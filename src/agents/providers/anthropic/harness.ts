/**
 * Anthropic Managed Agents harness.
 *
 * Implements the same AgentHarness interface as the OpenAI harness so you can
 * swap providers without changing your route handlers or frontend components.
 *
 * Key differences from the OpenAI harness:
 *   - Tools, sandboxing, and infrastructure are managed by Anthropic
 *   - You define the agent + environment once in the Anthropic console (or via API)
 *     and reference them by ID here
 *   - No tool registry needed — Claude has built-in Bash, file I/O, and web search
 *   - Sessions are stateful server-side; the same session can be reused across turns
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY
 *   ANTHROPIC_AGENT_ID        (or pass agentId in config)
 *   ANTHROPIC_ENVIRONMENT_ID  (or pass environmentId in config)
 *
 * Optional:
 *   ANTHROPIC_SESSION_ID      (reuse an existing session)
 *
 * Docs: https://platform.claude.com/docs/en/managed-agents/overview
 */

import type { AgentEvent, RunInput, RunResult } from "../../types";
import type { AnthropicAgentConfig } from "./types";

export interface AnthropicAgentHarness {
  /** Stream events from an Anthropic managed agent session. */
  stream(input: RunInput): AsyncGenerator<AgentEvent>;
  /** Run to completion and return the final result. */
  run(input: RunInput): Promise<RunResult>;
  /** The current session ID (useful for maintaining stateful sessions). */
  getSessionId(): string | undefined;
}

export function createAnthropicHarness(agentConfig: AnthropicAgentConfig = {}): AnthropicAgentHarness {
  const agentId = agentConfig.agentId ?? process.env.ANTHROPIC_AGENT_ID;
  const environmentId = agentConfig.environmentId ?? process.env.ANTHROPIC_ENVIRONMENT_ID;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  let currentSessionId: string | undefined = agentConfig.sessionId ?? process.env.ANTHROPIC_SESSION_ID;

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for Anthropic Managed Agents.");
  }
  if (!agentId) {
    throw new Error(
      "agentId or ANTHROPIC_AGENT_ID env var is required. Create an agent at https://platform.claude.com/agents"
    );
  }
  if (!environmentId) {
    throw new Error(
      "environmentId or ANTHROPIC_ENVIRONMENT_ID env var is required. Create an environment at https://platform.claude.com/environments"
    );
  }

  async function getClient() {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    return new Anthropic({ apiKey });
  }

  async function getOrCreateSession(client: Awaited<ReturnType<typeof getClient>>): Promise<string> {
    if (currentSessionId) return currentSessionId;

    const agentParam = agentConfig.agentVersion
      ? { type: "agent" as const, id: agentId!, version: agentConfig.agentVersion }
      : agentId!;

    const session = await (client.beta as unknown as {
      sessions: {
        create: (opts: {
          agent: string | { type: "agent"; id: string; version: number };
          environment_id: string;
          vault_ids?: string[];
        }) => Promise<{ id: string }>;
      };
    }).sessions.create({
      agent: agentParam,
      environment_id: environmentId!,
      ...(agentConfig.vaultIds?.length ? { vault_ids: agentConfig.vaultIds } : {}),
    });

    currentSessionId = session.id;
    return session.id;
  }

  async function* stream(input: RunInput): AsyncGenerator<AgentEvent> {
    const client = await getClient();
    const sessionId = await getOrCreateSession(client);
    const userMessage = input.messages.at(-1)?.content ?? "";

    // Send user.message event
    await (client.beta as unknown as {
      sessions: {
        events: {
          send: (id: string, opts: {
            events: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
          }) => Promise<void>;
        };
      };
    }).sessions.events.send(sessionId, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: userMessage }],
        },
      ],
    });

    // Stream SSE events from the session
    const streamResponse = await fetch(
      `https://api.anthropic.com/v1/sessions/${sessionId}/events/stream`,
      {
        headers: {
          "x-api-key": apiKey!,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "managed-agents-2026-04-01",
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        signal: input.signal ?? agentConfig.signal,
      }
    );

    if (!streamResponse.ok || !streamResponse.body) {
      const errText = await streamResponse.text().catch(() => "");
      throw new Error(
        `Anthropic session stream error ${streamResponse.status}: ${errText}`
      );
    }

    let finalOutput = "";
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const eventType = event.type as string;

          if (eventType === "content_block_delta") {
            const delta = event.delta as { type?: string; text?: string };
            if (delta?.type === "text_delta" && delta.text) {
              finalOutput += delta.text;
              yield { type: "message_delta", delta: delta.text };
            }
          } else if (eventType === "message_stop" || eventType === "assistant.message.stop") {
            if (finalOutput) {
              yield { type: "message_done", content: finalOutput };
            }
          } else if (eventType === "tool_use" || eventType === "tool_call") {
            const toolName = (event.name ?? event.tool_name) as string;
            const toolInput = event.input ?? event.parameters;
            const callId = (event.id ?? event.call_id) as string;
            yield { type: "tool_call", name: toolName, input: toolInput, callId };
          } else if (eventType === "tool_result") {
            const output = event.output ?? event.result;
            const callId = (event.tool_use_id ?? event.call_id) as string;
            yield { type: "tool_result", name: "", output, callId };
          } else if (eventType === "agent.status" || eventType === "session.status") {
            const status = event.status as string;
            if (status === "terminated" || status === "idle") {
              // Session finished
              break;
            }
          } else if (eventType === "error") {
            throw new Error((event.message as string) ?? "Anthropic session error");
          } else if (eventType === "usage") {
            const usage = event as { input_tokens?: number; output_tokens?: number };
            yield {
              type: "usage",
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", finalOutput };
  }

  async function run(input: RunInput): Promise<RunResult> {
    const events: AgentEvent[] = [];
    for await (const event of stream(input)) {
      events.push(event);
    }

    const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
    const usage = events.find((e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage");
    const toolCalls = events
      .filter((e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call")
      .map((e) => ({ name: e.name, input: e.input, output: undefined }));

    return {
      finalOutput: done?.finalOutput ?? "",
      messages: input.messages,
      toolCalls,
      usage: usage
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }
        : undefined,
    };
  }

  return {
    stream,
    run,
    getSessionId: () => currentSessionId,
  };
}
