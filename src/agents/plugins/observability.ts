/**
 * Observability plugin — fires tracing/logging/metrics hooks through the
 * configured ObservabilityAdapter (defaults to the global adapter).
 *
 * Usage:
 *   import { withObservability } from "@/agents/plugins/observability";
 *   import { MyTracingAdapter } from "./my-tracing";
 *
 *   // With global adapter (set via setObservabilityAdapter in instrumentation.ts):
 *   plugins: [withObservability()]
 *
 *   // With a specific adapter:
 *   plugins: [withObservability({ adapter: new MyTracingAdapter() })]
 */

import type { HarnessPlugin, AgentEvent, PluginRunContext, RunInput } from "../types";
import type { ObservabilityAdapter } from "../observability/types";

export interface ObservabilityPluginOptions {
  /** Use a specific adapter instead of the global one. */
  adapter?: ObservabilityAdapter;
}

export function withObservability(opts: ObservabilityPluginOptions = {}): HarnessPlugin {
  async function getAdapter(): Promise<ObservabilityAdapter> {
    if (opts.adapter) return opts.adapter;
    const { getObservabilityAdapter } = await import("../observability/index");
    return getObservabilityAdapter();
  }

  return {
    name: "observability",

    async onBeforeRun(
      userMessage: string,
      ctx: PluginRunContext,
      _input: RunInput
    ): Promise<string> {
      const adapter = await getAdapter();
      await Promise.resolve(adapter.onRunStart?.({
        runId: ctx.runId,
        agentName: ctx.agentName,
        model: ctx.model,
        startedAt: new Date(ctx.startedAt),
        userId: ctx.userId,
      })).catch(() => {});
      return userMessage;
    },

    async onEvent(
      event: AgentEvent,
      ctx: PluginRunContext
    ): Promise<AgentEvent | null> {
      const adapter = await getAdapter();

      if (event.type === "tool_call") {
        await Promise.resolve(adapter.onToolCall?.({
          runId: ctx.runId,
          agentName: ctx.agentName,
          toolName: event.name,
          callId: event.callId,
          input: event.input,
          startedAt: new Date(),
        })).catch(() => {});
      } else if (event.type === "handoff") {
        await Promise.resolve(adapter.onHandoff?.(event.from, event.to, ctx.runId)).catch(() => {});
      } else if (event.type === "usage") {
        await Promise.resolve(adapter.onUsage?.({
          runId: ctx.runId,
          agentName: ctx.agentName,
          model: ctx.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          userId: ctx.userId,
        })).catch(() => {});
      }

      return event;
    },

    async onComplete(
      ctx: PluginRunContext,
      result: { finalOutput: string; durationMs: number; error?: Error }
    ): Promise<void> {
      const adapter = await getAdapter();
      const span = {
        runId: ctx.runId,
        agentName: ctx.agentName,
        model: ctx.model,
        startedAt: new Date(ctx.startedAt),
        userId: ctx.userId,
      };

      if (result.error) {
        await Promise.resolve(adapter.onRunError?.(span, result.error, result.durationMs)).catch(() => {});
      } else {
        await Promise.resolve(adapter.onRunComplete?.(span, {
          finalOutput: result.finalOutput,
          durationMs: result.durationMs,
        })).catch(() => {});
      }
    },
  };
}
