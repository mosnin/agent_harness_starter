/**
 * Memory plugin — injects relevant memories into the system prompt and stores
 * new memories after each run.
 *
 * Usage:
 *   import { withMemory } from "@/agents/plugins/memory";
 *   const harness = createCoreHarness({
 *     name: "MyAgent",
 *     instructions: "...",
 *     plugins: [withMemory({ key: "userId" })],
 *   });
 */

import type { HarnessPlugin, PluginRunContext } from "../types";

export interface MemoryPluginOptions {
  /**
   * Storage key for memories. Typically "userId" to scope memories per user.
   * Falls back to ctx.userId at runtime, then to this literal string.
   */
  key: string;
  /** Number of memories to retrieve per run. Default: 5. */
  topK?: number;
  /** Max chars of the formatted memory block injected into instructions. Default: 2000. */
  maxLength?: number;
}

export function withMemory(opts: MemoryPluginOptions): HarnessPlugin {
  return {
    name: "memory",

    async onResolveInstructions(
      instructions: string,
      userMessage: string,
      ctx: PluginRunContext
    ): Promise<string> {
      const { memory, formatMemoriesForPrompt } = await import("../memory/index");
      const userId = ctx.userId ?? opts.key;
      const memories = await memory.retrieve(userId, userMessage, opts.topK ?? 5);
      const block = formatMemoriesForPrompt(memories, opts.maxLength ?? 2000);
      return block ? `${instructions}\n\n## Relevant memories\n${block}` : instructions;
    },

    async onComplete(
      ctx: PluginRunContext,
      result: { finalOutput: string; durationMs: number; error?: Error }
    ): Promise<void> {
      if (!result.finalOutput || result.error) return;
      const { memory } = await import("../memory/index");
      const userId = ctx.userId ?? opts.key;
      // Store the exchange for future retrieval
      await memory.store(userId, result.finalOutput).catch(() => {});
    },
  };
}
