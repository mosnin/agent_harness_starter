import type { HarnessPlugin, PluginRunContext, AgentEvent, RunInput } from "../types";
import type { ToolDefinition } from "../tools/types";

/**
 * Compose multiple plugins into one. All lifecycle hooks are called in order.
 * Note: each hook is explicitly enumerated here — if a new hook is added to
 * HarnessPlugin, this file must be updated to forward it.
 */
export function composePlugins(name: string, plugins: HarnessPlugin[]): HarnessPlugin {
  const active = plugins.filter(Boolean);
  return {
    name,
    async onBeforeRun(msg: string, ctx: PluginRunContext, input: RunInput): Promise<string> {
      let result = msg;
      for (const p of active) if (p.onBeforeRun) result = await p.onBeforeRun(result, ctx, input);
      return result;
    },
    async onResolveInstructions(instructions: string, userMessage: string, ctx: PluginRunContext): Promise<string> {
      let result = instructions;
      for (const p of active) if (p.onResolveInstructions) result = await p.onResolveInstructions(result, userMessage, ctx);
      return result;
    },
    async wrapTools(tools: ToolDefinition[], ctx: PluginRunContext, pending: Map<string, AgentEvent>): Promise<ToolDefinition[]> {
      let result = tools;
      for (const p of active) if (p.wrapTools) result = await p.wrapTools(result, ctx, pending);
      return result;
    },
    async onEvent(event: AgentEvent, ctx: PluginRunContext): Promise<AgentEvent | null> {
      let result: AgentEvent | null = event;
      for (const p of active) { if (!result) break; if (p.onEvent) result = await p.onEvent(result, ctx); }
      return result;
    },
    async onAfterRun(output: string, ctx: PluginRunContext): Promise<string> {
      let result = output;
      for (const p of active) if (p.onAfterRun) result = await p.onAfterRun(result, ctx);
      return result;
    },
    async onError(err: Error, ctx: PluginRunContext): Promise<void> {
      for (const p of active) await Promise.resolve(p.onError?.(err, ctx)).catch(() => {});
    },
    async onComplete(ctx: PluginRunContext, result: { finalOutput: string; durationMs: number; error?: Error }): Promise<void> {
      for (const p of active) await Promise.resolve(p.onComplete?.(ctx, result)).catch(() => {});
    },
  };
}
