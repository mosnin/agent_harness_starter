# Anthropic Managed Agents (Alternative Provider)

This starter kit supports **two agent providers** that can be used independently or side-by-side:

| | OpenAI Agents SDK | Anthropic Managed Agents |
|---|---|---|
| **Provider** | OpenAI (`@openai/agents`) | Anthropic (beta) |
| **Tools** | Your own (tool registry) | Built-in: Bash, files, web, MCP |
| **Sandboxing** | Daytona / Modal / local | Managed by Anthropic |
| **Sessions** | Stateless per run | Persistent server-side |
| **Best for** | Custom tools, fine control | Long-running tasks, less infra |
| **Route** | `/api/agent` | `/api/anthropic-agent` |

Both providers emit the **same `AgentEvent` SSE format**, so the same frontend components and SSE parsing code work with either.

---

## Setup

### 1. Create an agent

Go to [platform.claude.com/agents](https://platform.claude.com/agents) and create an agent. Configure:
- **Model**: claude-opus-4-5, claude-sonnet-4-5, etc.
- **System prompt**: your agent's instructions
- **Tools**: Bash, web search, file I/O (managed by Anthropic)
- **MCP servers**: any external MCP servers to connect

Copy the agent ID.

### 2. Create an environment

Go to [platform.claude.com/environments](https://platform.claude.com/environments) and create an environment. Configure:
- **Packages**: pre-installed runtimes (Python, Node.js, Go, etc.)
- **Network access**: which hosts the agent can reach
- **Mounted files**: files available in the container on startup

Copy the environment ID.

### 3. Set env vars

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_AGENT_ID=ag_...
ANTHROPIC_ENVIRONMENT_ID=env_...
```

### 4. Add the route

Copy `routes/anthropic-agent/route.ts` to `src/app/api/anthropic-agent/route.ts`.

---

## Usage

### Via the API route

```typescript
// Same request body as /api/agent
const response = await fetch("/api/anthropic-agent", {
  method: "POST",
  body: JSON.stringify({ message: "List all Python files in the project" }),
});
// SSE stream — same AgentEvent format as /api/agent
```

### Reusing sessions across turns

The `X-Session-Id` response header contains the Anthropic session ID.
Pass it back to continue the same session (preserving container state):

```typescript
let sessionId: string | undefined;

async function sendMessage(message: string) {
  const response = await fetch("/api/anthropic-agent", {
    method: "POST",
    body: JSON.stringify({ message, sessionId }),
  });
  sessionId = response.headers.get("X-Session-Id") ?? sessionId;
  // stream events...
}
```

### Direct usage in server code

```typescript
import { createAnthropicHarness } from "@/agents/providers/anthropic";

const harness = createAnthropicHarness({
  agentId: "ag_...",
  environmentId: "env_...",
  // sessionId: "ses_...", // optional — reuse an existing session
});

// Run to completion
const result = await harness.run({
  messages: [{ role: "user", content: "Run the test suite and report failures." }],
});

// Or stream
for await (const event of harness.stream({ messages: [...] })) {
  if (event.type === "message_delta") process.stdout.write(event.delta);
}
```

---

## MCP authentication (Vaults)

For MCP servers requiring OAuth, use Anthropic Vaults to store credentials:

```typescript
const harness = createAnthropicHarness({
  vaultIds: ["vault_abc123"],  // created at platform.claude.com/vaults
});
```

Anthropic manages token refresh automatically.

---

## Choosing a provider

Use **OpenAI Agents SDK** when:
- You need custom business-logic tools (DB queries, API calls, etc.)
- You want to own the full tool execution stack
- You need fine-grained control over model settings and tool routing

Use **Anthropic Managed Agents** when:
- The task is primarily code execution, file manipulation, or web research
- You want zero infra — no sandboxes to configure
- You need long-running, stateful sessions (hours of autonomous work)
- You want automatic prompt caching and compaction from Anthropic

You can use both in the same application — route different request types to different providers.
