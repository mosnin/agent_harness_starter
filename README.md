# Next.js Agentic Starter Kit

A production-ready scaffold for building agentic Next.js applications. Clone it, add your API keys, and ship — every integration is wired up and battle-tested so you don't spend time debugging third-party SDKs.

## What's included

| Layer | Choices |
|---|---|
| **Agent SDK** | [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) — streaming, multi-agent handoffs, cancellation |
| **Tool protocol** | [MCP](https://modelcontextprotocol.io) server + client — expose your tools to Claude Desktop, Cursor, etc. |
| **3rd-party tools** | [Composio](https://composio.dev) — per-user OAuth for GitHub, Slack, Gmail, Notion, Linear, 100+ more |
| **Web search** | [Tavily](https://tavily.com) |
| **Browsers** | [Browserbase](https://browserbase.com) or local Playwright — parallel agentic sessions |
| **Sandboxes** | [Daytona](https://daytona.io) or [Modal](https://modal.com) — isolated code execution |
| **Database** | Supabase / Convex / Prisma (swap via `DB_PROVIDER`) |
| **Auth** | Clerk / Auth0 (swap via `AUTH_PROVIDER`) |

## Quick start

```bash
git clone https://github.com/mosnin/agent_harness_starter
cd agent_harness_starter
cp .env.example .env.local   # add OPENAI_API_KEY at minimum
npm install
npm run dev
```

Open [http://localhost:3000/chat](http://localhost:3000/chat) — works immediately with the in-memory adapter and no auth (uses a dev placeholder user).

## Minimum viable configuration

```bash
# .env.local
OPENAI_API_KEY=sk-...          # required
TAVILY_API_KEY=tvly-...        # enables web_search tool
```

Everything else is optional. The app degrades gracefully when tools or providers aren't configured.

## Architecture

```
src/
├── agents/          # Agent harness, orchestrator, example agents
├── tools/           # Tool registry + adapters (Tavily, browser, sandbox, Composio)
├── mcp/             # MCP server (expose tools) + client (consume external servers)
├── db/              # DB adapters: memory | supabase | convex | prisma
├── auth/            # Auth adapters: none | clerk | auth0
├── app/api/
│   ├── agent/       # POST /api/agent — SSE streaming agent endpoint
│   └── mcp/         # /api/mcp — MCP server over Streamable HTTP transport
└── components/
    └── AgentChat/   # Drop-in chat UI (SSE consumer, tool call display)
```

## Swapping providers

All providers are selected by env var — zero code changes required.

### Database

```bash
DB_PROVIDER=supabase   # default: memory (in-process, no persistence)
DB_PROVIDER=convex
DB_PROVIDER=prisma
```

**Supabase**: run `supabase/migrations/001_agent_tables.sql` in Supabase Studio.

**Convex**: run `npx convex dev` — schema in `convex/schema.ts`.

**Prisma**: run `npm run db:generate && npm run db:push`.

### Auth

```bash
AUTH_PROVIDER=clerk    # default: none (dev-user for all requests)
AUTH_PROVIDER=auth0
```

**Clerk**: install `@clerk/nextjs`, add publishable + secret keys.

**Auth0**: install `@auth0/nextjs-auth0`, add `AUTH0_*` vars.

### Sandbox

```bash
SANDBOX_PROVIDER=daytona   # default: none
SANDBOX_PROVIDER=modal
```

### Browser

```bash
# Set BROWSERBASE_API_KEY for hosted parallel sessions
# Otherwise Playwright runs locally (headless)
```

## Adding tools

Create a file in `src/tools/`, define your tool with `registerTool`, and export it from `src/tools/index.ts`:

```typescript
// src/tools/my-category/my-tool.ts
import { z } from "zod";
import { registerTool } from "../registry";

export const myTool = registerTool({
  name: "my_tool",
  description: "Does something useful for the agent",
  parameters: z.object({
    input: z.string().describe("What to process"),
  }),
  async execute({ input }, ctx) {
    // ctx.userId is available if auth is configured
    return { result: `Processed: ${input}` };
  },
});
```

Then add it to an agent's `tools` array:

```typescript
// src/agents/examples/my-agent.ts
export const myAgentConfig: AgentConfig = {
  name: "MyAgent",
  instructions: "You help users by using my_tool...",
  tools: ["my_tool", "web_search"],
};
```

All registered tools are also automatically exposed via the MCP server at `/api/mcp`.

## Multi-agent orchestration

```typescript
import { createOrchestrator } from "@/agents/orchestrator";

const system = createOrchestrator({
  routerAgent: {
    name: "Router",
    instructions: "Route to the right specialist...",
  },
  specialists: [
    { name: "Researcher", instructions: "...", tools: ["web_search"] },
    { name: "Coder", instructions: "...", tools: ["sandbox_run_code"] },
  ],
});

const result = await system.run({ messages: [{ role: "user", content: "..." }] });
```

## Composio per-user OAuth

```bash
COMPOSIO_API_KEY=...
```

1. User visits `/api/composio/connect?app=github` → redirected to GitHub OAuth
2. After approval, Composio stores the token keyed to the user's ID
3. On the next agent call, `composio_execute` uses the user's token automatically

The `COMPOSIO_ENTITY_ID` env var controls the default entity (falls back to the authenticated `userId`).

## MCP server

The MCP server at `/api/mcp` exposes every registered tool to any MCP client:

```bash
# Inspect with the official inspector
npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp
```

Claude Desktop / Cursor config:
```json
{
  "mcpServers": {
    "my-app": { "url": "http://localhost:3000/api/mcp" }
  }
}
```

### Consuming external MCP servers

```bash
MCP_SERVERS='[{"name":"my-server","url":"https://mcp.example.com","apiKey":"..."}]'
```

Tools from external servers are available to agents as `serverName__toolName`.

## Streaming + cancellation

The `/api/agent` endpoint streams SSE events:

```typescript
const res = await fetch("/api/agent", { method: "POST", body: JSON.stringify({ message }) });
const reader = res.body.getReader();
// Events: { type: "message_delta", delta: "..." }
//         { type: "tool_call", name: "web_search", input: {...} }
//         { type: "done", finalOutput: "..." }
```

Cancel a run by aborting the fetch:
```typescript
const controller = new AbortController();
fetch("/api/agent", { signal: controller.signal, ... });
controller.abort(); // cleanly stops the agent
```

## Known gotcha: Zod versions

`@openai/agents` requires Zod v4 (peer dep). `composio-core` uses Zod v3 internally.

The `package.json` includes an npm override to resolve this:
```json
"overrides": {
  "composio-core>zod": "^3.24.0"
}
```

This gives `composio-core` its own Zod v3 while the rest of the project uses Zod v4. If you see Zod-related type errors, ensure you're importing from `zod` (v4) in your own code.

## Directory reference

| Path | Purpose |
|---|---|
| `src/lib/config.ts` | Central env-var config — import `config` everywhere |
| `src/tools/registry.ts` | Tool registry — `registerTool`, `getAllTools`, `getTools` |
| `src/agents/harness.ts` | Streaming agent runner — `createHarness(config)` |
| `src/agents/orchestrator.ts` | Multi-agent handoff orchestrator |
| `src/mcp/server.ts` | MCP server singleton |
| `src/mcp/client.ts` | MCP client (consume external servers) |
| `src/db/index.ts` | DB adapter factory — import `db` everywhere |
| `src/auth/index.ts` | Auth adapter factory — import `auth` everywhere |
| `src/app/api/agent/route.ts` | Main agent API endpoint |
| `src/app/api/mcp/route.ts` | MCP server HTTP endpoint |
| `src/components/AgentChat/` | Drop-in chat UI |
| `prisma/schema.prisma` | Prisma schema |
| `convex/schema.ts` | Convex schema |
| `supabase/migrations/` | Supabase SQL migrations |

## License

MIT
