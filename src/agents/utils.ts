/**
 * Converts a ToolDefinition (from our registry) into the shape expected
 * by the OpenAI Agents SDK.
 */

import { tool } from "@openai/agents";
import { z } from "zod";
import type { ToolDefinition, ToolContext } from "@/tools/types";

export function toOpenAITool(def: ToolDefinition, ctx?: ToolContext) {
  return tool({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (input: unknown) => {
      const result = await def.execute(input, ctx ?? {});
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  });
}

/** Convert a ToolDefinition to a JSON Schema object (for MCP / OpenAPI). */
export function toJsonSchema(def: ToolDefinition) {
  return {
    name: def.name,
    description: def.description,
    inputSchema: z.toJSONSchema(def.parameters),
  };
}
