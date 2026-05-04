# Next.js Agentic Starter Kit

Drop this into your existing Next.js SaaS and get 80% of your agentic infrastructure done correctly — streaming agents, tool registry, MCP server, multi-agent orchestration, and swappable DB/auth adapters, all pre-wired.

**This is not a standalone app.** It's a set of modules you copy into your existing project, connect to your existing auth and database, and wire up with your domain-specific tools.

---

## Why this over alternatives?

- **Governance engine built-in** — policy enforcement, ethics checks, and compliance audit trails are first-class, not afterthoughts.
- **Capability tokens per run (NHI)** — every agent run is scoped with non-human identity tokens, enabling fine-grained per-run tool authorization.
- **MCP server out of the box** — every registered tool is instantly available to Claude Desktop, Cursor, or any MCP client at `/api/mcp` with no extra config.
- **Copy-don't-inherit** — you own the source; no SDK lock-in, no hidden abstractions, no breaking upgrades forced on you.
- **OpenAI Agents SDK native** — built on the official `@openai/agents` SDK, so handoffs, tracing, and model updates come from the source.

---

## What you get

```
Agentic capability                    Already handled
────────────────────────────────────────────────────────────
Streaming agent runs (SSE)          ✓ routes/agent/route.ts
Multi-agent handoffs                ✓ src/agents/orchestrator.ts
Tool registry                       ✓ src/agents/tools/registry.ts
MCP server + client                 ✓ src/agents/mcp/ + routes/mcp/
Cancellation + retry                ✓ src/agents/harness.ts
Web search (Tavily)                 ✓ src/agents/tools/web/tavily.ts
Parallel browser sessions           ✓ src/agents/tools/web/browser.ts
Sandboxed code execution            ✓ src/agents/tools/sandbox/
Composio OAuth (100+ APIs)          ✓ src/agents/tools/composio/
Thread + message persistence        ✓ src/agents/db/
Auth adapter interface              ✓ src/agents/auth/
Supabase / Convex / Prisma support  ✓ DB_PROVIDER env var
Clerk / Auth0 support               ✓ AUTH_PROVIDER env var
Chat UI component                   ✓ components/AgentChat/
```

You bring: your existing auth, your existing database, and your domain-specific tools.

---

## How to add it to your project

### 1. Copy the modules

```bash
# Clone the starter
git clone https://github.com/mosnin/agent_harness_starter /tmp/agent-starter

# Copy into your existing project
cp -r /tmp/agent-starter/src/agents    your-project/src/agents
cp -r /tmp/agent-starter/routes        your-project/src/app/api    # merge into existing api/
cp -r /tmp/agent-starter/components    your-project/src/components  # merge
```

> The entire agent infrastructure lives under `src/agents/`. It doesn't touch your existing code.

### 2. Install dependencies

```bash
# Core (always required)
npm install @openai/agents zod@^4 @modelcontextprotocol/sdk

# Tools you want to use
npm install @tavily/core                        # web search
npm install @browserbasehq/sdk playwright-core  # browser automation
npm install composio-core                        # OAuth for 100+ APIs
npm install @daytonaio/sdk                       # code sandboxes

# Fix Zod version conflict between @openai/agents and composio-core
```

Add to `package.json`:
```json
"overrides": {
  "composio-core>zod": "^3.24.0"
}
```

### 3. Add environment variables

```bash
# Minimum to get started
OPENAI_API_KEY=sk-...

# Match your existing setup
DB_PROVIDER=supabase          # supabase | convex | prisma
AUTH_PROVIDER=clerk           # clerk | auth0
```

Full reference: [`.env.example`](./.env.example)

### 4. Wire to your existing auth and DB

If you already use Clerk: set `AUTH_PROVIDER=clerk` — done.
If you already use Supabase: set `DB_PROVIDER=supabase`, run the migration SQL — done.

See **[docs/02-connecting-your-app.md](./docs/02-connecting-your-app.md)** for all providers including NextAuth, custom JWT, MongoDB, DynamoDB, etc.

### 5. Add your first agent to a page

```tsx
import { AgentChat } from "@/components/AgentChat";

export default function DashboardPage() {
  return (
    <div>
      {/* ... your existing dashboard UI ... */}
      <AgentChat agentName="research" placeholder="Ask me about your data..." />
    </div>
  );
}
```

---

## How it works

```
User types in AgentChat
        ↓
POST /api/agent  (routes/agent/route.ts)
        ↓
auth.requireAuth()  →  your existing auth
        ↓
createHarness(agentConfig)  →  @openai/agents run()
        ↓
Agent calls tools  →  your registered tools
        ↓
SSE stream → AgentChat renders events in real time
        ↓
db.saveMessage()  →  your existing database
```

---

## Adding tools for your product

Tools connect your domain data and actions to the agent. Register them once; they're available everywhere:

```typescript
// src/agents/tools/crm/contacts.ts
import { z } from "zod";
import { registerTool } from "@/agents/tools/registry";

export const searchContactsTool = registerTool({
  name: "crm_search_contacts",
  description: "Search CRM contacts by name, email, or company.",
  parameters: z.object({
    query: z.string(),
    limit: z.number().default(10),
  }),
  async execute({ query, limit }, ctx) {
    // ctx.userId = authenticated user from your auth adapter
    return YourContactService.search({ query, limit, userId: ctx.userId });
  },
});
```

Add to `src/agents/tools/index.ts`:
```typescript
export * from "./crm/contacts";
```

The tool is now available to agents AND the MCP server at `/api/mcp` — no extra config.

---

## Multi-agent orchestration

```typescript
import { createOrchestrator } from "@/agents/orchestrator";

const support = createOrchestrator({
  routerAgent: {
    name: "Router",
    model: "gpt-4o-mini",        // cheap: just routing
    instructions: "Route to Billing or Technical support.",
  },
  specialists: [
    {
      name: "BillingAgent",
      model: "gpt-4o",
      instructions: "Handle billing questions...",
      tools: ["billing_get_invoice", "billing_create_refund"],
    },
    {
      name: "TechnicalAgent",
      model: "gpt-4o",
      instructions: "Debug technical issues...",
      tools: ["dev_get_logs", "search_docs", "web_search"],
    },
  ],
});

const result = await support.run({
  messages: [{ role: "user", content: userMessage }],
  context: { userId },
});
```

---

## MCP server

Your `/api/mcp` endpoint exposes every registered tool to any MCP client:

```bash
# Inspect
npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp

# Claude Desktop
{ "mcpServers": { "myapp": { "url": "https://yourapp.com/api/mcp" } } }
```

Consume external MCP servers by adding them to `MCP_SERVERS` in `.env.local`.

---

## Documentation

| Guide | What it covers |
|---|---|
| **[01 — Integration](./docs/01-integration.md)** | Step-by-step: copy files, install deps, fix imports, first run |
| **[02 — Connecting Your App](./docs/02-connecting-your-app.md)** | Wire to your existing auth, DB, services, and user model |
| **[03 — Building Tools](./docs/03-building-tools.md)** | Tool anatomy, patterns, authorization, testing |
| **[04 — APIs and MCPs](./docs/04-apis-and-mcps.md)** | REST APIs, Composio OAuth, consuming/exposing MCP servers |
| **[05 — Model Configuration](./docs/05-model-configuration.md)** | Model selection, prompts, temperature, context, cost |
| **[06 — Harness and Orchestration](./docs/06-harness-orchestration.md)** | Streaming, cancellation, multi-agent patterns, observability |
| **[07 — Deployment](./docs/07-deployment.md)** | Vercel, Docker, migrations, rate limiting, cost controls |

---

## Domain examples

Copy these as starting points for your SaaS type:

| Directory | What's inside |
|---|---|
| [`examples/crm/`](./examples/crm/) | Contact search, deal updates, note-taking, outreach |
| [`examples/ecommerce/`](./examples/ecommerce/) | Order lookup, refunds, shipment tracking, address updates |
| [`examples/devtools/`](./examples/devtools/) | Repo status, issue management, CI monitoring, deployments |

---

## File structure

```
agent_harness_starter/
├── src/agents/                # Copy to: your-project/src/agents/
│   ├── harness.ts             # Streaming run loop, retry, cancellation
│   ├── orchestrator.ts        # Multi-agent handoffs and parallel runs
│   ├── types.ts               # AgentConfig, AgentEvent, RunInput, RunResult
│   ├── utils.ts               # Tool → OpenAI SDK adapter, JSON schema export
│   ├── tools/
│   │   ├── registry.ts        # registerTool, getAllTools, getTools
│   │   ├── types.ts           # ToolDefinition, ToolContext
│   │   ├── index.ts           # Import here to register your tools
│   │   ├── web/               # Tavily search, parallel browser scraping
│   │   ├── sandbox/           # Daytona and Modal code execution
│   │   └── composio/          # Per-user OAuth for 100+ APIs
│   ├── mcp/
│   │   ├── server.ts          # MCP server (exposes all tools)
│   │   └── client.ts          # MCP client (consume external servers)
│   ├── db/                    # DB adapters: memory | supabase | convex | prisma
│   ├── auth/                  # Auth adapters: none | clerk | auth0
│   ├── lib/
│   │   ├── config.ts          # Central env-var config
│   │   └── utils.ts           # SSE stream, retry, sleep
│   └── examples/              # Reference agent configs (research, code)
│
├── routes/                    # Copy to: your-project/src/app/api/
│   ├── agent/route.ts         # POST /api/agent — streaming SSE endpoint
│   ├── mcp/route.ts           # GET+POST /api/mcp — MCP server
│   ├── threads/route.ts       # GET/POST /api/threads
│   └── composio/connect/route.ts  # GET /api/composio/connect
│
├── components/                # Copy to: your-project/src/components/
│   ├── AgentChat/             # Drop-in streaming chat UI
│   └── AgentStatus/           # Running indicator with cancel button
│
├── examples/                  # Domain-specific starting points
│   ├── crm/                   # CRM SaaS tools + agent configs
│   ├── ecommerce/             # E-commerce tools + agent configs
│   └── devtools/              # Dev platform tools + agent configs
│
├── docs/                      # Integration guides
├── prisma/schema.prisma       # Add to your existing Prisma schema
├── convex/                    # Add to your existing Convex project
├── supabase/migrations/       # Run in your existing Supabase project
└── .env.example               # All env vars with documentation
```

---

## License

MIT
