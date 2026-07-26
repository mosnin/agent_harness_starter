# Plugin Architecture

The agent harness uses a composable plugin system. Instead of one monolithic configuration object that controls every feature, you pick only the plugins your agent needs and compose them in the order you want.

## Choosing a starting point

| Import path | What you get |
|---|---|
| `@/agents/presets/minimal` | Core engine only — no optional features |
| `@/agents/presets/standard` | Memory + guardrails + observability |
| `@/agents/presets/full` | Everything (memory, guardrails, approvals, observability) |
| `@/agents` / `@/agents/harness` | Same as `full` — backward-compatible default |

All presets export a `createHarness(config)` function with the same return type (`AgentHarness`), so you can swap presets without changing route handlers or frontend code.

## Composing plugins explicitly

Use `createCustomHarness` from `@/agents/core` and pass plugins yourself:

```ts
import { createCustomHarness } from "@/agents/core";
import { withMemory } from "@/agents/plugins/memory";
import { withGuardrails } from "@/agents/plugins/guardrails";
import { withApprovals } from "@/agents/plugins/approvals";
import { withObservability } from "@/agents/plugins/observability";
import { maxLengthGuardrail } from "@/agents/guardrails";

const harness = createCustomHarness({
  name: "SupportAgent",
  instructions: (ctx) => `Helping user ${ctx.userId}.`,
  skills: ["support"],
  plugins: [
    withMemory({ key: "userId", topK: 5 }),
    withGuardrails({ input: [maxLengthGuardrail(4000)] }),
    withApprovals({ requireApprovalFor: ["send_email"] }),
    withObservability(),
  ],
});
```

Plugins run in array order for forward hooks (`onBeforeRun`, `onResolveInstructions`, `wrapTools`, `onEvent`, `onAfterRun`) and forward order for terminal hooks (`onError`, `onComplete`).

## Built-in plugin factories

### `withMemory(options)`

Retrieves semantically relevant memories and injects them into the system prompt before the agent runs. Stores the completed exchange afterward.

```ts
withMemory({
  key: "userId",    // storage key — falls back to ctx.userId at runtime
  topK: 5,          // memories to retrieve (default: 5)
  maxLength: 2000,  // max chars of injected memory block (default: 2000)
})
```

Configure the storage backend with `MEMORY_PROVIDER` env var (`memory` | `pgvector` | `pinecone`).

### `withGuardrails(guardrailSet)`

Runs input guardrails before the agent and output guardrails after. Throws `GuardrailBlockError` to abort — the harness catches it and yields `{ type: "error" }` + `{ type: "done" }`.

```ts
import { maxLengthGuardrail, piiSanitizerGuardrail, blockedKeywordsGuardrail } from "@/agents/guardrails";

withGuardrails({
  input: [maxLengthGuardrail(4000), piiSanitizerGuardrail],
  output: [blockedKeywordsGuardrail(["confidential", "internal"])],
})
```

### `withApprovals(options)`

Wraps specified tools with a human-in-the-loop gate. The harness pauses at the tool call, emits an `approval_required` SSE event, and waits for the frontend to POST to `/api/agent/[runId]/approve`.

```ts
withApprovals({
  requireApprovalFor: ["delete_file", "send_email", "deploy"],
})
```

You can also set `requiresApproval: true` on a `ToolDefinition` to apply it globally across all agents.

### `withObservability(options)`

Fires tracing/logging/metrics hooks through the configured `ObservabilityAdapter`. By default uses the global adapter (set via `setObservabilityAdapter()` in `instrumentation.ts`). Pass `adapter` to use a per-agent adapter.

```ts
withObservability()                           // use global adapter
withObservability({ adapter: myAdapter })     // per-agent adapter
```

The adapter receives: `onRunStart`, `onRunComplete`, `onRunError`, `onToolCall`, `onHandoff`, `onUsage`. See `src/agents/observability/types.ts`.

## Writing a custom plugin

Implement the `HarnessPlugin` interface from `@/agents/types`. All hooks are optional.

```ts
import type { HarnessPlugin, AgentEvent, PluginRunContext } from "@/agents/types";

const rateLimitPlugin: HarnessPlugin = {
  name: "rate-limit",

  async onBeforeRun(userMessage, ctx) {
    const allowed = await checkRateLimit(ctx.userId, ctx.context.orgId as string);
    if (!allowed) throw new Error("Rate limit exceeded. Please try again later.");
    return userMessage;
  },

  async onComplete(ctx, result) {
    await recordUsage(ctx.userId, result.durationMs);
  },
};
```

### Available hooks

| Hook | When it fires | Can modify? | Can block? |
|---|---|---|---|
| `onBeforeRun(msg, ctx, input)` | Before the agent runs, after messages are extracted | Yes — return new message | Yes — throw |
| `onResolveInstructions(inst, msg, ctx)` | After base instructions resolve, before `Agent` is built | Yes — return new instructions | No |
| `wrapTools(tools, ctx, pendingEvents)` | During agent construction | Yes — return modified tool array | No |
| `onEvent(event, ctx)` | Each stream event before yielding | Yes — return new event | Yes — return `null` to suppress |
| `onAfterRun(output, ctx)` | After the SDK run completes | Yes — return new output | Yes — throw |
| `onError(err, ctx)` | When the SDK run throws | No | No |
| `onComplete(ctx, result)` | Always, via `finally` | No | No |

### `PluginRunContext` fields

```ts
interface PluginRunContext {
  runId: string;        // UUID for this run
  agentName: string;    // from AgentConfig.name
  model: string;        // resolved model ID, e.g. "gpt-4o"
  userId?: string;      // from input.context.userId
  startedAt: number;    // Date.now() at run start
  signal?: AbortSignal; // from RunInput.signal — forward to cancelable operations
  context: AgentContext;// full input.context — access custom fields here (orgId, etc.)
}
```

### The `pendingEvents` side-channel

The `wrapTools` hook receives a `pendingEvents: Map<string, AgentEvent>`. The streaming loop drains this map every iteration. This is how `withApprovals` emits `approval_required` events from inside a tool closure — it pushes to the map, and the loop yields the event on the next iteration.

```ts
const myPlugin: HarnessPlugin = {
  name: "my-plugin",
  wrapTools(tools, ctx, pendingEvents) {
    return tools.map((def) => ({
      ...def,
      execute: async (input, toolCtx) => {
        const eventId = globalThis.crypto.randomUUID();
        pendingEvents.set(eventId, { type: "tool_call", name: def.name, input, callId: eventId });
        return def.execute(input, toolCtx);
      },
    }));
  },
};
```

## Anthropic Managed Agents

The Anthropic provider supports the same plugins (except `onResolveInstructions` and `wrapTools`, which are managed server-side):

```ts
import { createAnthropicHarness } from "@/agents/providers/anthropic";
import { withMemory, withObservability } from "@/agents/plugins";

const harness = createAnthropicHarness({
  name: "SupportAgent",
  agentId: process.env.ANTHROPIC_AGENT_ID,
  environmentId: process.env.ANTHROPIC_ENVIRONMENT_ID,
  plugins: [
    withMemory({ key: "userId" }),
    withObservability(),
  ],
});
```

## Testing plugins

Plugins are plain objects — test them in isolation without a real API key:

```ts
import { describe, it, expect, vi } from "vitest";
import { withMemory } from "@/agents/plugins/memory";

describe("withMemory", () => {
  it("injects memories into instructions", async () => {
    vi.mock("../memory/index", () => ({
      memory: { retrieve: vi.fn(async () => [{ content: "User prefers TypeScript" }]) },
      formatMemoriesForPrompt: (memories: Array<{content:string}>) =>
        memories.map((m) => m.content).join("\n"),
    }));

    const plugin = withMemory({ key: "u1" });
    const result = await plugin.onResolveInstructions!(
      "You are helpful.",
      "write me code",
      { runId: "r1", agentName: "Test", model: "gpt-4o", startedAt: 0, context: { userId: "u1" } }
    );

    expect(result).toContain("User prefers TypeScript");
  });
});
```

For integration tests of the full harness lifecycle, see `src/agents/__tests__/core.test.ts`.
