# 04 — APIs, MCPs, and External Integrations

This guide covers three ways to bring external capabilities into your agents:
1. **Wrap a REST API as a tool** — direct SDK/fetch calls
2. **Composio** — OAuth-authenticated access to 100+ SaaS APIs without managing tokens
3. **MCP servers** — consume or expose tools over the Model Context Protocol

---

## Wrapping REST APIs as tools

The simplest integration: call any API from a tool's `execute` function.

```typescript
import { z } from "zod";
import { registerTool } from "@/agents/tools/registry";

export const getWeatherTool = registerTool({
  name: "get_weather",
  description: "Get current weather for a city. Use when the user asks about weather or conditions.",
  parameters: z.object({
    city: z.string().describe("City name, e.g. 'San Francisco'"),
    units: z.enum(["celsius", "fahrenheit"]).default("fahrenheit"),
  }),
  async execute({ city, units }) {
    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=${units === "celsius" ? "metric" : "imperial"}&appid=${process.env.OPENWEATHER_API_KEY}`
    );
    if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
    const data = await res.json();
    return {
      city: data.name,
      temperature: data.main.temp,
      description: data.weather[0].description,
      humidity: data.main.humidity,
    };
  },
});
```

### Using existing SDK clients

If your app already has API clients set up, use them directly:

```typescript
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export const getCustomerSubscriptionTool = registerTool({
  name: "billing_get_subscription",
  description: "Get the current subscription status for a customer",
  parameters: z.object({ customerId: z.string() }),
  async execute({ customerId }, ctx) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });
    return subscriptions.data[0] ?? null;
  },
});
```

---

## Composio — per-user OAuth for 100+ APIs

Composio handles the OAuth dance for you. Users authorize once; your agents can act on their behalf in GitHub, Slack, Gmail, Notion, Linear, Jira, and 100+ more.

### Setup

```bash
COMPOSIO_API_KEY=...
```

### OAuth flow

1. **Initiate connection**: send user to `/api/composio/connect?app=github`
2. **User authorizes** on GitHub
3. **Composio stores the token** — keyed to your user's ID
4. **Agent calls** `composio_execute` — Composio injects the token automatically

The user connects once. Every subsequent agent call for that user automatically uses their stored token.

### Using Composio actions in agents

```typescript
import { codeAgentConfig } from "@/agents/examples/code-agent";

export const githubAgentConfig: AgentConfig = {
  name: "GitHubAgent",
  instructions: `You help users manage their GitHub repositories.
You can create issues, list PRs, check CI status, and create branches.
Always check what repos the user has access to before taking actions.`,
  tools: [
    "composio_list_connections",  // check what's connected
    "composio_execute",           // run GitHub actions
    "web_search",                 // look up documentation
  ],
};
```

Agent usage example:
```
User: "Create a GitHub issue for the login bug we just found"
Agent → composio_execute("GITHUB_CREATE_ISSUE", { owner: "...", repo: "...", title: "Fix login bug", body: "..." })
```

### Available Composio apps (partial list)

| Category | Apps |
|---|---|
| Code | GitHub, GitLab, Bitbucket, Jira, Linear |
| Communication | Slack, Discord, Gmail, Outlook, Notion |
| CRM | HubSpot, Salesforce, Pipedrive |
| Productivity | Google Drive, Notion, Airtable, Trello, Asana |
| Finance | QuickBooks, Xero, Stripe |

Full list: [app.composio.dev/apps](https://app.composio.dev/apps)

### Limiting which apps a user can connect

```typescript
// Only expose relevant apps for your product
const ALLOWED_APPS = ["github", "slack", "notion"];

// In /api/composio/connect route:
if (!ALLOWED_APPS.includes(appName)) {
  return Response.json({ error: "App not supported" }, { status: 400 });
}
```

---

## Consuming external MCP servers

MCP servers expose tools, resources, and prompts over a standard protocol. Your agents can use tools from any MCP server — including databases, file systems, design tools, and specialized AI services.

### Configure external MCP servers

```bash
# .env.local
MCP_SERVERS='[
  {
    "name": "postgres",
    "url": "https://mcp.example.com/postgres",
    "apiKey": "..."
  },
  {
    "name": "filesystem",
    "url": "http://localhost:8080"
  }
]'
```

Tools from external servers appear as `serverName__toolName` (e.g., `postgres__query`, `filesystem__read_file`).

### Use external MCP tools in an agent

```typescript
import { getExternalMcpTools } from "@/agents/mcp/client";
import { Agent, run } from "@openai/agents";

// Fetch tools from all configured MCP servers
const mcpTools = await getExternalMcpTools();

const agent = new Agent({
  name: "DataAgent",
  instructions: "You can query our database and read files.",
  tools: mcpTools,  // ← all external MCP tools
});
```

Or mix with your registered tools:

```typescript
import { getTools } from "@/agents/tools/registry";

const agent = new Agent({
  name: "DataAgent",
  instructions: "...",
  tools: [
    ...getTools(["web_search", "crm_search_contacts"]),  // local tools
    ...await getExternalMcpTools(),                       // MCP tools
  ],
});
```

### Popular public MCP servers

| Server | What it exposes |
|---|---|
| `@modelcontextprotocol/server-postgres` | SQL query execution |
| `@modelcontextprotocol/server-filesystem` | Read/write files |
| `@modelcontextprotocol/server-github` | GitHub API |
| `@modelcontextprotocol/server-brave-search` | Brave web search |
| `@modelcontextprotocol/server-slack` | Slack messages |

---

## Exposing your app as an MCP server

Your `/api/mcp` endpoint IS an MCP server. Every tool you register is automatically available to MCP clients.

This means:
- **Claude Desktop users** can call your app's tools directly from their chat
- **Cursor users** can use your tools while coding
- **Other LLM systems** can integrate with your product via a standard protocol

```json
// Claude Desktop ~/.config/claude/claude_desktop_config.json
{
  "mcpServers": {
    "myapp": {
      "url": "https://app.yourproduct.com/api/mcp",
      "headers": {
        "Authorization": "Bearer user-api-token"
      }
    }
  }
}
```

### Securing your MCP endpoint

For internal use, add authentication to `/api/mcp`:

```typescript
// routes/mcp/route.ts
export async function POST(req: Request) {
  // Verify bearer token
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (token !== process.env.MCP_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  // ... rest of handler
}
```

For per-user access, verify the token and pass `userId` to tool context (requires customizing the MCP server initialization in `src/agents/mcp/server.ts`).

### Designing tools for MCP discoverability

When your tools will be used via MCP (not just internally), descriptions become even more important — they're what LLMs read to decide whether to call your tool:

```typescript
// Good MCP description — explains context, not just what it does
description: "Search contacts in [YourApp] CRM. Returns name, email, company, deal stage, and last activity date. Use when the user asks about their customers, leads, or prospects."

// Too vague for MCP — model won't know when to use it
description: "Get contacts"
```

---

## Handling API authentication per user

When tools need different API credentials per user (not just Composio):

```typescript
export const sendSlackMessageTool = registerTool({
  name: "send_slack_message",
  description: "Send a Slack message to a channel",
  parameters: z.object({
    channel: z.string(),
    message: z.string(),
  }),
  async execute({ channel, message }, ctx) {
    // Fetch the user's Slack token from your DB
    const integration = await db.integrations.findOne({
      userId: ctx.userId!,
      provider: "slack",
    });
    if (!integration) {
      return { error: "Slack not connected. Visit Settings → Integrations to connect." };
    }

    const slack = new WebClient(integration.accessToken);
    await slack.chat.postMessage({ channel, text: message });
    return { sent: true, channel };
  },
});
```

This pattern works for any OAuth integration you manage yourself. Use Composio when you want to avoid building and maintaining the OAuth flow.

---

## Rate limiting and API quotas

Protect external API calls from agent loops:

```typescript
import { withRetry } from "@/agents/lib/utils";

export const callExpensiveApiTool = registerTool({
  name: "expensive_api",
  description: "...",
  parameters: z.object({ query: z.string() }),
  async execute({ query }, ctx) {
    return withRetry(
      () => expensiveApi.call(query),
      {
        attempts: 3,
        baseDelay: 1000,
        onRetry: (err, attempt) => {
          console.warn(`[expensive_api] attempt ${attempt} failed:`, err);
        },
      }
    );
  },
});
```

For per-user rate limits, track call counts in your DB and throw if exceeded:

```typescript
async execute(params, ctx) {
  const count = await db.toolCallCount(ctx.userId!, "expensive_api", "1h");
  if (count > 10) throw new Error("Rate limit exceeded. Try again in an hour.");
  await db.recordToolCall(ctx.userId!, "expensive_api");
  // ... proceed
},
```
