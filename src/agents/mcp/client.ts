/**
 * MCP Client — connects to external MCP servers and exposes their tools
 * to the OpenAI Agents SDK.
 *
 * External MCP servers are configured via the MCP_SERVERS env var:
 *   MCP_SERVERS=[{"name":"my-server","url":"https://...","apiKey":"..."}]
 *
 * Call `getExternalMcpTools()` to get OpenAI-SDK-compatible tools from all
 * configured external servers.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool } from "@openai/agents";
import { z } from "zod";
import { config } from "../lib/config";

type McpServerConfig = (typeof config.mcp.servers)[number];

async function connectToServer(serverConfig: McpServerConfig): Promise<Client> {
  const headers: Record<string, string> = {};
  if (serverConfig.apiKey) {
    headers["Authorization"] = `Bearer ${serverConfig.apiKey}`;
  }

  const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
    requestInit: { headers },
  });

  const client = new Client({ name: "nextjs-agentic-client", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/**
 * Fetch all tools from all configured external MCP servers.
 * Returns them as OpenAI Agents SDK tool objects ready to pass to an Agent.
 */
export async function getExternalMcpTools() {
  const tools: ReturnType<typeof tool>[] = [];

  for (const serverConfig of config.mcp.servers) {
    try {
      const client = await connectToServer(serverConfig);
      const { tools: mcpTools } = await client.listTools();

      for (const mcpTool of mcpTools) {
        const openAITool = tool({
          name: `${serverConfig.name}__${mcpTool.name}`,
          description: mcpTool.description ?? `Tool from MCP server: ${serverConfig.name}`,
          parameters: z.record(z.unknown()),
          execute: async (input) => {
            const result = await client.callTool({
              name: mcpTool.name,
              arguments: input as Record<string, unknown>,
            });
            const text = result.content
              .filter((c) => c.type === "text")
              .map((c) => (c as { text: string }).text)
              .join("\n");
            return text;
          },
        });
        tools.push(openAITool);
      }

      await client.close();
    } catch (err) {
      console.error(`[mcp] Failed to connect to ${serverConfig.name}:`, err);
    }
  }

  return tools;
}
