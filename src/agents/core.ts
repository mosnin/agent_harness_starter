/**
 * Core harness — the minimal, plugin-driven engine.
 *
 * This file has NO imports of optional features (memory, guardrails, approvals,
 * observability). All behaviour is injected through the plugins array on AgentConfig.
 *
 * For the batteries-included experience use a preset instead:
 *   import { createFullHarness } from "@/agents/presets/full";     // everything
 *   import { createStandardHarness } from "@/agents/presets/standard"; // memory + guardrails + observability
 *   import { createMinimalHarness } from "@/agents/presets/minimal";   // this file directly
 *
 * Or compose your own:
 *   import { createCustomHarness } from "@/agents/core";
 *   import { withMemory } from "@/agents/plugins/memory";
 *   import { withGuardrails } from "@/agents/plugins/guardrails";
 *
 *   const harness = createCustomHarness({
 *     name: "MyAgent",
 *     instructions: "...",
 *     plugins: [withMemory({ key: "userId" }), withGuardrails({ input: [...] })],
 *   });
 */

import { Agent, run } from "@openai/agents";
import { randomUUID } from "crypto";
import type { AgentConfig, AgentEvent, AgentContext, RunInput, RunResult, PluginRunContext } from "./types";
import { resolveAgentTools } from "./skills/index";
import { toOpenAITool } from "./utils";
import { config } from "./lib/config";
import { AgentError } from "./errors/index";

// Auto-detect serverless environments and warn about in-memory state.
// Fires once per process startup; developers don't need to call validateRuntime().
(function detectServerlessFootguns() {
  const isServerless =
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.CF_PAGES ||
    process.env.NETLIFY;
  if (isServerless) {
    console.warn(
      "[agent-harness] Serverless environment detected. " +
      "In-memory adapters (memory, cache) reset between invocations. " +
      "Set MEMORY_PROVIDER=pgvector or use setMemoryAdapter(new PgVectorAdapter()) to persist state."
    );
  }
})();

export interface AgentHarness {
  stream(input: RunInput): AsyncGenerator<AgentEvent>;
  run(input: RunInput): Promise<RunResult>;
}

export type CoreConfig = AgentConfig;

// Map a raw SDK event to our AgentEvent union. Returns null for events we ignore.
function mapSdkEvent(
  event: { type: string; data?: unknown; item?: unknown; agent?: unknown },
  agentName: string
): AgentEvent | null {
  if (event.type === "raw_model_stream_event") {
    const delta = (event.data as { delta?: { content?: string } })?.delta?.content;
    return delta ? { type: "message_delta", delta } : null;
  }

  if (event.type === "run_item_stream_event") {
    const item = event.item as {
      type?: string;
      name?: string;
      callId?: string;
      input?: unknown;
      output?: unknown;
      content?: Array<{ type: string; text?: string }>;
    };

    if (item?.type === "tool_call_item") {
      return {
        type: "tool_call",
        name: item.name ?? "",
        input: item.input,
        callId: item.callId ?? globalThis.crypto.randomUUID(),
      };
    }
    if (item?.type === "tool_call_output_item") {
      return {
        type: "tool_result",
        name: "",
        output: item.output,
        callId: (item as { callId?: string }).callId ?? "",
      };
    }
    if (item?.type === "message_output_item") {
      const text =
        item.content
          ?.filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join("") ?? "";
      return text ? { type: "message_done", content: text } : null;
    }
    return null;
  }

  if (event.type === "agent_updated_stream_event") {
    const newAgent = event.agent as { name?: string };
    return { type: "handoff", from: agentName, to: newAgent.name ?? "" };
  }

  return null;
}

function validatePluginOrder(plugins: import("./types").HarnessPlugin[]): void {
  const names = plugins.map(p => p.name);
  const memIdx = names.indexOf("memory");
  const guardrailsIdx = names.indexOf("guardrails");

  if (memIdx !== -1 && guardrailsIdx !== -1 && memIdx > guardrailsIdx) {
    console.warn(
      "[agent-harness] Plugin ordering warning: \"memory\" should come before \"guardrails\" " +
      "so retrieved memories are available when guardrails evaluate the enriched prompt. " +
      `Current order: [${names.join(", ")}]`
    );
  }
}

export function createCustomHarness(agentConfig: CoreConfig): AgentHarness {
  const plugins = agentConfig.plugins ?? [];
  validatePluginOrder(plugins);

  async function resolveInstructions(ctx: AgentContext): Promise<string> {
    const { instructions } = agentConfig;
    return typeof instructions === "function" ? instructions(ctx) : instructions;
  }

  async function buildAgent(
    ctx: AgentContext,
    pluginCtx: PluginRunContext,
    userMessage: string
  ) {
    // Resolve base instructions then let plugins enrich them (memory injection etc.)
    let instructions = await resolveInstructions(ctx);
    for (const plugin of plugins) {
      if (plugin.onResolveInstructions) {
        instructions = await plugin.onResolveInstructions(instructions, userMessage, pluginCtx);
      }
    }

    // Per-run side-channel for events emitted from within tool closures
    const pendingEvents = new Map<string, AgentEvent>();

    // Let plugins wrap tool definitions (approval gates etc.)
    const toolDefs = resolveAgentTools(agentConfig.tools ?? [], agentConfig.skills ?? []);
    let wrappedDefs = toolDefs;
    for (const plugin of plugins) {
      if (plugin.wrapTools) {
        wrappedDefs = await plugin.wrapTools(wrappedDefs, pluginCtx, pendingEvents);
      }
    }

    const openAITools = wrappedDefs.map((def) => toOpenAITool(def, ctx));

    const { modelSettings } = agentConfig;
    const agent = new Agent({
      name: agentConfig.name,
      instructions,
      model: agentConfig.model ?? config.openai.model,
      tools: openAITools,
      ...(modelSettings?.temperature !== undefined && {
        temperature: modelSettings.temperature,
      }),
    });

    return { agent, pendingEvents };
  }

  async function* stream(input: RunInput): AsyncGenerator<AgentEvent> {
    const runId = globalThis.crypto.randomUUID();
    const startedAt = Date.now();
    // Resolve traceId — callers can pass one for distributed tracing; otherwise generate fresh.
    // callerSpanId is captured before it is overwritten so it can become parentSpanId.
    const inputCtx = input.context ?? {};
    const callerTraceId = (inputCtx as Record<string, unknown>)?.traceId as string | undefined;
    const callerSpanId = (inputCtx as Record<string, unknown>)?.spanId as string | undefined;
    const traceId = callerTraceId ?? randomUUID();
    const spanId = randomUUID(); // always fresh — this is THIS agent's span

    function toHex(uuid: string): string {
      return uuid.replace(/-/g, "");
    }
    const traceparent = `00-${toHex(traceId)}-${toHex(spanId).slice(0, 16)}-01`;

    const ctx: AgentContext = {
      ...inputCtx,
      runId,
      orgId: (inputCtx.orgId as string | undefined) ?? agentConfig.orgId,
      traceId,
      spanId,
      traceparent,
    };
    const pluginCtx: PluginRunContext = {
      runId,
      agentName: agentConfig.name,
      model: agentConfig.model ?? config.openai.model,
      userId: ctx.userId as string | undefined,
      startedAt,
      signal: input.signal,
      context: ctx,
      traceId,
      spanId,
      parentSpanId: callerSpanId,
      traceparent,
    };

    // ── onBeforeRun: transform / validate user message ────────────────────────
    let userMessage = input.messages.at(-1)?.content ?? "";
    for (const plugin of plugins) {
      if (plugin.onBeforeRun) {
        try {
          userMessage = await plugin.onBeforeRun(userMessage, pluginCtx, input);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const agentErr = err instanceof AgentError ? err : null;
          yield {
            type: "error",
            error: msg,
            ...(agentErr?.code ? { code: agentErr.code } : {}),
            ...(agentErr && "guardName" in agentErr && agentErr.guardName ? { guardName: agentErr.guardName as string } : {}),
            ...(agentErr && "toolName" in agentErr && agentErr.toolName ? { toolName: agentErr.toolName as string } : {}),
            ...(agentErr?.remediation ? { remediation: agentErr.remediation } : {}),
          };
          yield { type: "done", finalOutput: "", traceId, spanId, traceparent };
          // Still run onComplete for cleanup (REVERSE order — teardown mirrors setup)
          const durationMs = Date.now() - startedAt;
          const error = err instanceof Error ? err : new Error(msg);
          for (const p of [...plugins].reverse()) {
            await Promise.resolve(p.onComplete?.(pluginCtx, { finalOutput: "", durationMs, error })).catch(() => {});
          }
          return;
        }
      }
    }

    const { agent, pendingEvents } = await buildAgent(ctx, pluginCtx, userMessage);

    let finalOutput = "";
    let runError: Error | undefined;

    try {
      const result = run(agent, userMessage, {
        stream: true,
        maxTurns: agentConfig.maxTurns ?? 20,
        signal: input.signal,
        context: ctx,
      });

      for await (const event of await result) {
        // Drain approval-style events queued by tool closures
        for (const [id, pendingEvent] of pendingEvents) {
          yield pendingEvent;
          pendingEvents.delete(id);
        }

        const agentEvent = mapSdkEvent(event, agentConfig.name);
        if (!agentEvent) continue;

        // Track final output before plugin filtering
        if (agentEvent.type === "message_done") {
          finalOutput = agentEvent.content;
        }

        // Run onEvent plugin chain
        let current: AgentEvent | null = agentEvent;
        for (const plugin of plugins) {
          if (!current) break;
          if (plugin.onEvent) {
            current = await plugin.onEvent(current, pluginCtx);
          }
        }
        if (current) yield current;
      }

      // Resolve the streaming result for authoritative final output + usage
      const resolved = await (result as unknown as Promise<{
        finalOutput: string;
        usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      }>);
      finalOutput = resolved.finalOutput ?? finalOutput;

      // ── onAfterRun: transform / validate final output (REVERSE order) ───────
      // Reverse mirrors the before-hook setup order: last plugin to set up is
      // first to tear down, ensuring correct cleanup sequencing.
      for (const plugin of [...plugins].reverse()) {
        if (plugin.onAfterRun) {
          try {
            finalOutput = await plugin.onAfterRun(finalOutput, pluginCtx);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const agentErr = err instanceof AgentError ? err : null;
            yield {
              type: "error",
              error: msg,
              ...(agentErr?.code ? { code: agentErr.code } : {}),
              ...(agentErr && "guardName" in agentErr && agentErr.guardName ? { guardName: agentErr.guardName as string } : {}),
              ...(agentErr && "toolName" in agentErr && agentErr.toolName ? { toolName: agentErr.toolName as string } : {}),
              ...(agentErr?.remediation ? { remediation: agentErr.remediation } : {}),
            };
            yield { type: "done", finalOutput: "", traceId, spanId, traceparent };
            return;
          }
        }
      }

      // Emit usage event through the onEvent plugin chain
      const usage = resolved.usage;
      if (usage) {
        let usageEvent: AgentEvent | null = {
          type: "usage",
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        };
        for (const plugin of plugins) {
          if (!usageEvent) break;
          if (plugin.onEvent) usageEvent = await plugin.onEvent(usageEvent, pluginCtx);
        }
        if (usageEvent) yield usageEvent;
      }

      yield { type: "done", finalOutput, traceId, spanId, traceparent };
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
      // onError runs in REVERSE order (teardown mirrors setup)
      for (const plugin of [...plugins].reverse()) {
        await Promise.resolve(plugin.onError?.(runError, pluginCtx)).catch(() => {});
      }
      const agentErr = err instanceof AgentError ? err : null;
      yield {
        type: "error",
        error: runError.message,
        ...(agentErr?.code ? { code: agentErr.code } : {}),
        ...(agentErr && "guardName" in agentErr && agentErr.guardName ? { guardName: agentErr.guardName as string } : {}),
        ...(agentErr && "toolName" in agentErr && agentErr.toolName ? { toolName: agentErr.toolName as string } : {}),
        ...(agentErr?.remediation ? { remediation: agentErr.remediation } : {}),
      };
    } finally {
      const durationMs = Date.now() - startedAt;
      // onComplete runs in REVERSE order (teardown mirrors setup)
      for (const plugin of [...plugins].reverse()) {
        await Promise.resolve(plugin.onComplete?.(pluginCtx, { finalOutput, durationMs, error: runError })).catch(() => {});
      }
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
