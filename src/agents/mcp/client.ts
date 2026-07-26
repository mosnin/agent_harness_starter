/**
 * MCP Client — connects to external MCP servers and exposes their tools
 * to the OpenAI Agents SDK.
 *
 * External MCP servers are configured via the MCP_SERVERS env var:
 *   MCP_SERVERS=[{"name":"my-server","url":"https://...","apiKey":"..."}]
 *
 * Call `getExternalMcpTools()` to get OpenAI-SDK-compatible tools from all
 * configured external servers.
 *
 * Connection pooling: each server URL is connected at most once per process
 * (or once per TTL window). Cached connections are reused so that
 * getExternalMcpTools() can be called on every request without opening a new
 * transport each time.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool } from "@openai/agents";
import { z } from "zod";
import { config } from "../lib/config";

type McpServerConfig = (typeof config.mcp.servers)[number];

// ── Connection pool ───────────────────────────────────────────────────────────

const mcpClientCache = new Map<string, { client: Client; connectedAt: number }>();
const MCP_CLIENT_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getMcpClient(serverConfig: McpServerConfig): Promise<Client> {
  const cacheKey = serverConfig.url;
  const cached = mcpClientCache.get(cacheKey);
  if (cached && Date.now() - cached.connectedAt < MCP_CLIENT_TTL_MS) {
    return cached.client;
  }

  // Close the stale connection before opening a new one (best-effort)
  if (cached) {
    await cached.client.close().catch(() => {});
    mcpClientCache.delete(cacheKey);
  }

  const headers: Record<string, string> = {};
  if (serverConfig.apiKey) {
    headers["Authorization"] = `Bearer ${serverConfig.apiKey}`;
  }

  const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
    requestInit: { headers },
  });

  const client = new Client({ name: "nextjs-agentic-client", version: "0.1.0" });
  await client.connect(transport);
  mcpClientCache.set(cacheKey, { client, connectedAt: Date.now() });
  return client;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all tools from all configured external MCP servers.
 * Returns them as OpenAI Agents SDK tool objects ready to pass to an Agent.
 *
 * Connections are pooled per server URL with a 5-minute TTL so repeated calls
 * (e.g. one per request) reuse the existing transport instead of reconnecting.
 * The client is NOT closed after listing — it is kept alive for tool execution.
 */
export async function getExternalMcpTools() {
  const tools: ReturnType<typeof tool>[] = [];

  for (const serverConfig of config.mcp.servers) {
    try {
      const client = await getMcpClient(serverConfig);
      const { tools: mcpTools } = await client.listTools();

      for (const mcpTool of mcpTools) {
        const openAITool = tool({
          name: `${serverConfig.name}__${mcpTool.name}`,
          description: mcpTool.description ?? `Tool from MCP server: ${serverConfig.name}`,
          parameters: z.object({}).catchall(z.unknown()),
          execute: async (input) => {
            // Re-fetch from pool so execute always uses a live connection
            const liveClient = await getMcpClient(serverConfig);
            const result = await liveClient.callTool({
              name: mcpTool.name,
              arguments: input as Record<string, unknown>,
            });
            const content = result.content as Array<{ type: string; text?: string }>;
            return content
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("\n");
          },
        });
        tools.push(openAITool);
      }
    } catch (err) {
      console.error(`[mcp] Failed to connect to ${serverConfig.name}:`, err);
    }
  }

  return tools;
}
