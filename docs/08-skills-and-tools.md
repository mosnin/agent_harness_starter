# Skills, Tools & Progressive Disclosure

## Concept

Tools are the functions your agent calls. Skills are named **bundles of tools** — a way to limit what the model sees at any one time.

Exposing 40 tools at once burns tokens, confuses the model, and degrades response quality. Skills solve this by giving each agent only the tools it actually needs.

---

## Tools

Every tool is a typed function registered in the global tool registry:

```typescript
import { z } from "zod";
import { registerTool } from "@/agents/tools/registry";

export const myTool = registerTool({
  name: "my_tool",
  description: "What this tool does (the model reads this).",
  category: "data",        // optional — for grouping in skills/UIs
  requiresApproval: false, // set true to require human sign-off before execution
  parameters: z.object({
    input: z.string().describe("The input to process"),
  }),
  async execute({ input }, ctx) {
    // ctx.userId, ctx.meta, ctx.signal all available
    return { result: `processed: ${input}` };
  },
});
```

Import your tool file in `src/agents/tools/index.ts` and it auto-registers.

### SandboxConfig

For shell/file tools, restrict what's allowed:

```typescript
registerTool({
  name: "shell_exec",
  sandboxConfig: {
    allowedCommands: ["node", "python3", "git"],
    allowedDirectories: ["/tmp/sandbox", "/home/app/workspace"],
    timeoutMs: 30_000,
    maxOutputBytes: 50_000,
  },
  // ...
});
```

---

## Skills

Define a skill bundle in `src/agents/skills/index.ts`:

```typescript
import { defineSkill } from "@/agents/skills";

defineSkill({
  name: "customer-support",
  description: "Tools for resolving customer issues",
  tools: ["lookup_order", "issue_refund", "create_ticket", "send_email"],
});
```

Use it in an agent:

```typescript
const supportAgent: AgentConfig = {
  name: "SupportAgent",
  skills: ["customer-support"],  // only these 4 tools are visible to the model
  // ...
};
```

Mix skills and explicit tools:

```typescript
{
  skills: ["customer-support"],
  tools: ["web_search"],  // added on top of the skill bundle
}
```

### Built-in Skills

| Name | Tools |
|------|-------|
| `web` | `web_search`, `browser_scrape` |
| `code` | `shell_exec`, `file_read`, `file_write`, `file_list` |
| `integrations` | `composio_execute`, `composio_list_connections`, `composio_connect_app` |
| `research` | `web_search`, `browser_scrape` |

---

## Tool Approval (Human-in-the-Loop)

Mark tools as requiring approval at the tool level:

```typescript
registerTool({
  name: "issue_refund",
  requiresApproval: true,
  // ...
});
```

Or at the agent level for any subset of tools:

```typescript
const agentConfig: AgentConfig = {
  requireApprovalFor: ["issue_refund", "delete_record"],
  // ...
};
```

When the agent tries to call an approved tool, the harness:
1. Pauses execution
2. Emits `{ type: "approval_required", approvalId, toolName, input, description }` via SSE
3. Waits until `POST /api/agent/[runId]/approve` is called with `{ approvalId, decision: "approved" | "rejected" }`
4. Resumes or throws depending on the decision

See `routes/agent/[runId]/approve/route.ts` for the endpoint.

---

## Prebuilt Sandbox Tools

### Shell Execution

```typescript
import { createShellTool } from "@/agents/tools/sandbox/shell";

// Create a restricted shell tool for your agent
export const nodeShell = createShellTool({
  allowedCommands: ["node", "npm", "npx"],
  allowedDirectories: ["/tmp/workspace"],
  timeoutMs: 60_000,
});
```

### File Operations

```typescript
import { createFileTools } from "@/agents/tools/sandbox/files";

const { fileRead, fileWrite, fileList, filePatch } = createFileTools({
  allowedDirectories: ["/tmp/workspace"],
  maxFileSizeBytes: 200_000,
});
```

`filePatch` applies a unified diff — ideal for targeted code edits without rewriting entire files.

---

## MCP Tools

Plug in external MCP servers as tool sources:

```typescript
// src/agents/mcp/client.ts — already set up
// Configure via MCP_SERVERS env var:
// MCP_SERVERS='[{"name":"github","url":"https://...","apiKey":"..."}]'
```

Or import MCP tools directly into an agent using the `@openai/agents` MCP client.
