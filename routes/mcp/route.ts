/**
 * DROP THIS FILE INTO: your-app/src/app/api/mcp/route.ts
 *
 * MCP server endpoint (Streamable HTTP transport, 2025-03-26 spec).
 * All tools in src/agents/tools/ are automatically exposed here.
 *
 * Connect from Claude Desktop / Cursor:
 *   { "mcpServers": { "my-app": { "url": "https://your-app.com/api/mcp" } } }
 *
 * Inspect locally:
 *   npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getMcpServer } from "@/agents/mcp/server";
import { auth } from "@/agents/auth";
import type { ToolContext } from "@/agents/tools/types";
// Import all tools to ensure they're registered before the MCP server is initialized
import "@/agents/tools/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolve per-request ToolContext from the incoming request.
 * Auth failures are non-fatal — unauthenticated callers (Claude Desktop,
 * local dev) still get a working MCP server, just without a userId.
 * Enforce auth here if your tools require it in production.
 */
async function resolveContext(req: Request): Promise<ToolContext> {
  try {
    const user = await auth.requireAuth(req);
    return { userId: user.id, request: req, signal: req.signal };
  } catch {
    return { request: req, signal: req.signal };
  }
}

export async function POST(req: Request) {
  const ctx = await resolveContext(req);
  const server = getMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
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

  const ctx = await resolveContext(req);
  const server = getMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
