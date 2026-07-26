# 06 — Harness and Orchestration

The harness is the runtime loop that manages a single agent run. The orchestrator composes multiple agents with automatic handoffs. This guide shows you how to modify both.

---

## The harness

`src/agents/harness.ts` wraps `@openai/agents` `run()` with:
- **Streaming** via async generator → SSE
- **Cancellation** via `AbortSignal` (browser fetch abort → agent stops)
- **Retry** on transient OpenAI errors
- **Context threading** — `ToolContext` (including `userId`) passes through every tool call

### Using the harness

```typescript
import { createHarness } from "@/agents/harness";
import { myAgentConfig } from "@/agents/my-agent";

const harness = createHarness(myAgentConfig);

// Streaming (SSE) — for API routes
for await (const event of harness.stream({
  messages: [{ role: "user", content: userMessage }],
  context: { userId: "user-123" },
  signal: req.signal,  // cancellation
})) {
  // event.type: "message_delta" | "tool_call" | "tool_result" | "done" | "error"
}

// Blocking (for background jobs, scripts, evals)
const result = await harness.run({
  messages: [{ role: "user", content: userMessage }],
  context: { userId: "user-123" },
});
console.log(result.finalOutput);
```

---

## Customizing the harness

### Add logging / observability

```typescript
// src/agents/harness.ts — inside the stream() generator:
for await (const event of stream) {
  // Log every tool call to your observability platform
  if (event.type === "tool_call") {
    await logger.log({
      type: "tool_call",
      userId: input.context?.userId,
      agentName: agentConfig.name,
      toolName: event.name,
      input: event.input,
      runId,
    });
  }

  if (event.type === "tool_result") {
    await logger.log({ type: "tool_result", toolName: "", output: event.output });
  }

  yield event;
}
```

### Add custom timeout

```typescript
// In createHarness(), wrap the run() call:
const timeoutController = new AbortController();
const timeout = setTimeout(() => timeoutController.abort(), 120_000); // 2 min

try {
  const result = run(agent, userMessage, {
    signal: AbortSignal.any([
      timeoutController.signal,
      input.signal ?? new AbortController().signal,
    ]),
    maxTurns: agentConfig.maxTurns ?? 20,
  });
  // ...
} finally {
  clearTimeout(timeout);
}
```

### Add per-user rate limiting

```typescript
// In route handler, before calling the harness:
const recentRuns = await db.countRunsInLastHour(userId);
if (recentRuns > 20) {
  return Response.json({ error: "Rate limit: max 20 agent runs per hour" }, { status: 429 });
}
```

### Inject additional context into every tool

If you need to pass org-level data to all tools (not just `userId`):

```typescript
const orgSettings = await db.orgSettings.get(user.orgId);

const result = await harness.run({
  messages,
  context: {
    userId: user.id,
    meta: {                         // ← anything in meta is available in ctx.meta
      orgId: user.orgId,
      orgPlan: orgSettings.plan,
      timezone: orgSettings.timezone,
      featureFlags: orgSettings.flags,
    },
  },
});
```

In tools:
```typescript
async execute(params, ctx) {
  const orgId = ctx.meta?.orgId as string;
  const plan = ctx.meta?.orgPlan as string;
  // ...
}
```

---

## Single-agent patterns

### Question-answering agent

Simplest pattern: one agent with read-only tools.

```typescript
export const qaAgentConfig: AgentConfig = {
  name: "QAAgent",
  instructions: "Answer questions about the user's account data. Be concise and factual.",
  tools: ["get_subscription", "get_usage_stats", "search_docs"],
  maxTurns: 8,
  model: "gpt-4o-mini",
};
```

### Action agent (write capabilities)

Add mutation tools with confirmations baked into the instructions:

```typescript
export const actionAgentConfig: AgentConfig = {
  name: "ActionAgent",
  instructions: `Help users manage their account.
IMPORTANT: Before any write action (create, update, delete), summarize what you're about to do and ask for explicit confirmation. Only proceed after the user confirms.`,
  tools: ["get_subscription", "update_subscription", "cancel_account", "search_docs"],
  maxTurns: 15,
};
```

### Research + synthesis agent

Uses web search + browser to gather information, then synthesizes:

```typescript
export const researchAgentConfig: AgentConfig = {
  name: "ResearchAgent",
  instructions: `Research topics thoroughly using web search and browser tools.
1. Search for multiple relevant sources
2. Scrape pages that require JavaScript rendering
3. Cross-reference information before reporting
4. Cite your sources with URLs`,
  tools: ["web_search", "browser_scrape", "browser_scrape_parallel"],
  maxTurns: 12,
};
```

---

## Multi-agent patterns

### Triage + specialists (recommended for complex products)

The most common agentic architecture for SaaS products.

```
User message
    ↓
Router (cheap, fast)
    ↓ handoff
Specialist (full model, domain-specific tools)
    ↓
Final answer
```

```typescript
import { createOrchestrator } from "@/agents/orchestrator";

export const customerSuccessSystem = createOrchestrator({
  routerAgent: {
    name: "Router",
    model: "gpt-4o-mini",
    instructions: `You are a routing agent for Acme's customer success system.
Analyze the request and hand off to the right specialist:
- BillingAgent: billing questions, subscription changes, refund requests
- TechnicalAgent: API errors, integration issues, bug reports
- OnboardingAgent: new user setup, feature discovery, getting started
Never answer questions yourself — always hand off immediately.`,
    maxTurns: 3,
  },
  specialists: [
    {
      name: "BillingAgent",
      model: "gpt-4o",
      instructions: "Handle all billing and subscription questions...",
      tools: ["get_subscription", "update_billing", "search_docs"],
      maxTurns: 12,
    },
    {
      name: "TechnicalAgent",
      model: "gpt-4o",
      instructions: "Debug technical issues and API errors...",
      tools: ["search_docs", "get_api_logs", "create_support_ticket", "web_search"],
      maxTurns: 15,
    },
    {
      name: "OnboardingAgent",
      model: "gpt-4o",
      instructions: "Guide new users through setup and features...",
      tools: ["search_docs", "get_user_progress", "send_onboarding_email"],
      maxTurns: 10,
    },
  ],
});
```

Usage:
```typescript
const result = await customerSuccessSystem.run({
  messages: [{ role: "user", content: "My payment failed last week" }],
  context: { userId },
});
```

### Parallel fan-out

Run multiple agents simultaneously and collect all their outputs. Useful for getting diverse perspectives or splitting a large task.

```typescript
import { runAgentsInParallel } from "@/agents/orchestrator";

// Research the same topic from multiple angles simultaneously
const results = await runAgentsInParallel(
  [
    { name: "MarketResearcher", instructions: "Research market trends for...", tools: ["web_search"] },
    { name: "CompetitorAnalyst", instructions: "Analyze competitors for...", tools: ["web_search", "browser_scrape"] },
    { name: "CustomerInsights", instructions: "Find customer feedback about...", tools: ["web_search"] },
  ],
  userMessage,
  { userId }
);

// Synthesize results with a final agent
const synthesis = await synthesisHarness.run({
  messages: [
    { role: "user", content: userMessage },
    {
      role: "assistant",
      content: `Research findings:\n${results.map(r => `**${r.agentName}**: ${r.output}`).join("\n\n")}`,
    },
    { role: "user", content: "Now synthesize these findings into a single coherent analysis." },
  ],
});
```

### Sequential pipeline

Chain agents where each one's output is the next one's input:

```typescript
async function runPipeline(userInput: string, userId: string) {
  // Stage 1: Extract intent and data
  const extractResult = await extractHarness.run({
    messages: [{ role: "user", content: userInput }],
    context: { userId },
  });

  // Stage 2: Fetch relevant data based on extracted intent
  const dataResult = await dataHarness.run({
    messages: [
      { role: "user", content: userInput },
      { role: "assistant", content: extractResult.finalOutput },
      { role: "user", content: "Now fetch the relevant data." },
    ],
    context: { userId },
  });

  // Stage 3: Generate final response with full context
  return formatterHarness.run({
    messages: [
      { role: "user", content: userInput },
      { role: "assistant", content: dataResult.finalOutput },
      { role: "user", content: "Format this as a customer-facing report." },
    ],
    context: { userId },
  });
}
```

---

## Background agent jobs

For long-running tasks that shouldn't block an HTTP response:

```typescript
// API route — starts the job and returns immediately
export async function POST(req: Request) {
  const user = await auth.requireAuth(req);
  const { task } = await req.json();

  // Create a pending run record
  const thread = await db.createThread(user.id, task.title);
  const run = await db.createRun({ threadId: thread.id, status: "pending", agentName: "automation" });

  // Queue the background job (use your existing job queue)
  await jobQueue.enqueue("run-agent", {
    runId: run.id,
    threadId: thread.id,
    userId: user.id,
    task,
  });

  return Response.json({ runId: run.id, threadId: thread.id });
}

// Background worker
async function processAgentJob({ runId, threadId, userId, task }) {
  await db.updateRun(runId, { status: "running" });
  try {
    const result = await automationHarness.run({
      messages: [{ role: "user", content: task.instructions }],
      context: { userId },
    });
    await db.saveMessage({ threadId, role: "assistant", content: result.finalOutput });
    await db.updateRun(runId, { status: "completed", completedAt: new Date() });
  } catch (err) {
    await db.updateRun(runId, { status: "failed", error: err.message });
  }
}
```

---

## When to use which pattern

| Scenario | Pattern |
|---|---|
| Chat widget on any page | Single agent |
| Customer support with multiple departments | Triage + specialists |
| Competitive research, multi-source analysis | Parallel fan-out |
| Data ETL, report generation | Sequential pipeline |
| "Do this while I'm away" automation | Background job |
| Internal admin tools, power user features | Single agent with write tools |
| Scheduled reporting | Background job + cron |

---

## Observability

Track every agent run for debugging and improvement:

```typescript
// Log to your existing observability tool (Datadog, Sentry, PostHog, etc.)
for await (const event of harness.stream(input)) {
  if (event.type === "tool_call") {
    analytics.track("agent_tool_call", {
      userId: input.context?.userId,
      tool: event.name,
      agentName: agentConfig.name,
    });
  }

  if (event.type === "error") {
    Sentry.captureException(new Error(event.error), {
      extra: { agentName: agentConfig.name, userId: input.context?.userId },
    });
  }

  if (event.type === "done") {
    analytics.track("agent_run_completed", {
      userId: input.context?.userId,
      agentName: agentConfig.name,
      outputLength: event.finalOutput.length,
    });
  }

  yield event;
}
```
