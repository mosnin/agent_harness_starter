/**
 * MCP Server — exposes all registered tools over the Model Context Protocol.
 *
 * This lets any MCP-compatible client (Claude Desktop, Cursor, other LLMs)
 * discover and call your tools without code changes.
 *
 * The server is mounted at /api/mcp in Next.js (see routes/mcp/route.ts).
 *
 * Docs: https://modelcontextprotocol.io
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllTools } from "../tools/registry";
import type { ToolContext } from "../tools/types";

/**
 * Create a new MCP server bound to the given per-request context.
 *
 * A new instance is created per request (not a singleton) so that each
 * request carries its own userId, signal, and request reference into every
 * tool execution.
 */
export function getMcpServer(ctx: ToolContext = {}): McpServer {
  const server = new McpServer({
    name: "nextjs-agentic-starter",
    version: "0.1.0",
  });

  // Register every tool in the registry as an MCP tool
  for (const toolDef of getAllTools()) {
    server.tool(
      toolDef.name,
      toolDef.description,
      // MCP expects raw JSON schema — use Zod v4's built-in toJSONSchema
      (() => {
        try {
          const jsonSchema = z.toJSONSchema(toolDef.parameters) as {
            properties?: Record<string, unknown>;
          };
          return jsonSchema.properties ?? {};
        } catch {
          return {};
        }
      })(),
      async (args: Record<string, unknown>) => {
        const result = await toolDef.execute(toolDef.parameters.parse(args), ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );
  }

  return server;
}
