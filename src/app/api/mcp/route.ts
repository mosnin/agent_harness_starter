/**
 * MCP Server endpoint.
 *
 * Supports the MCP Streamable HTTP transport (2025-03-26 spec).
 * POST to this endpoint to send JSON-RPC messages.
 * GET with Accept: text/event-stream to open an SSE session.
 *
 * Connect with:
 *   npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp
 *
 * Or add to Claude Desktop's config:
 *   { "mcpServers": { "my-app": { "url": "http://localhost:3000/api/mcp" } } }
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getMcpServer } from "@/mcp/server";
// Import all tools to ensure they're registered before the MCP server is initialized
import "@/tools/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const server = getMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const body = await req.text();
  const res = await transport.handlePostMessage(body, Object.fromEntries(req.headers));

  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
}

export async function GET(req: Request) {
  const accept = req.headers.get("Accept") ?? "";

  if (!accept.includes("text/event-stream")) {
    return Response.json(
      {
        name: "nextjs-agentic-starter MCP server",
        version: "0.1.0",
        transport: "streamable-http",
        endpoint: "/api/mcp",
      },
      { status: 200 }
    );
  }

  const server = getMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  return new Response(transport.sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
