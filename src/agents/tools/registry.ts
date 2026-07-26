import type { z } from "zod";
import type { ToolDefinition, ToolRegistry } from "./types";

/**
 * Global tool registry.
 * Register tools with `registerTool`, retrieve them with `getTool` / `getAllTools`.
 * Tools registered here are automatically available to agents and the MCP server.
 */
const registry: ToolRegistry = new Map();

export function registerTool<TInput extends z.ZodTypeAny, TOutput = unknown>(
  tool: ToolDefinition<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  if (registry.has(tool.name)) {
    console.warn(`[tools] Overwriting existing tool: ${tool.name}`);
  }
  registry.set(tool.name, tool as unknown as ToolDefinition);
  return tool;
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(registry.values());
}

export function getTools(names: string[]): ToolDefinition[] {
  return names
    .map((n) => registry.get(n))
    .filter((t): t is ToolDefinition => t !== undefined);
}

/**
 * Type representing a registered tool name.
 * Use registerTool() to add names to this union at the module level.
 * TypeScript can't widen this automatically, but getToolNames() provides
 * runtime discovery and IDEs will show registered names via intellisense
 * when you use const assertions.
 */

/** Returns all registered tool names as a string array (useful for allowlists). */
export function getToolNames(): string[] {
  return Array.from(registry.keys());
}
