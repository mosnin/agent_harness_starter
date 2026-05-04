# Tools Playbook — Integration Guide

A practical toolkit for wiring tools into agentic systems: from defining a single tool to building chained multi-step flows with permission enforcement and fallback handling.

---

## 1. Defining a Tool

Every tool is a `ToolDefinition`: a name, description, Zod schema, and execute function.

```typescript
import { z } from "zod";
import { registerTool } from "@/agents/tools";

const weatherTool = registerTool({
  name: "get_weather",
  description: "Get current weather for a city.",
  parameters: z.object({
    city: z.string().describe("City name, e.g. 'Tokyo'"),
    units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  }),
  execute: async ({ city, units }, ctx) => {
    // ctx.userId, ctx.signal available for auth and cancellation
    const response = await fetch(`https://api.weather.example/${city}?units=${units}`, {
      signal: ctx.signal,
    });
    if (!response.ok) throw new Error(`Weather API error: ${response.status}`);
    return response.json();
  },
});
```

That's it. The tool is now available by name to any agent that lists `"get_weather"` in its `tools` array.

---

## 2. Tool Abstraction Layer (standardized output)

Wrap any tool with `createAbstractTool` to get:
- Consistent `ToolResult` output (agents know if it succeeded)
- Automatic timeout enforcement
- Typed fallback on error
- Selection hints (tags, priority, cost)

```typescript
import { createAbstractTool } from "@/agents/tools";
import { z } from "zod";

const safeScraper = createAbstractTool({
  name: "browser_scrape",
  description: "Scrape a web page. Returns structured content.",
  parameters: z.object({ url: z.string().url() }),
  tags: ["web", "read-only"],
  priority: 2,
  cost: "moderate",
  timeoutMs: 20_000,

  execute: async ({ url }, ctx) => {
    const html = await fetchPage(url, ctx.signal);
    return { url, content: extractText(html), wordCount: extractText(html).split(/\s+/).length };
  },

  // Fallback when scraping fails (e.g. JS-heavy page)
  onError: async (err, { url }) => {
    return { url, content: `Scraping failed: ${err.message}`, wordCount: 0 };
  },
});

registerTool(safeScraper);
```

**How agents interpret ToolResult:**

```typescript
// The agent receives this structure, not a raw object:
{
  ok: true,
  data: { url: "...", content: "...", wordCount: 1200 },
  durationMs: 3420,
  toolName: "browser_scrape",
}

// On error:
{
  ok: false,
  error: "Connection timeout",
  durationMs: 20000,
  toolName: "browser_scrape",
  hint: "retry",  // "retry" | "escalate" | "use_fallback"
}
```

The agent sees `ok: false` and can decide to retry, use a different tool, or escalate.

---

## 3. Tool Permissions (per-agent access control)

Limit which agents can see which tools. Non-permitted tools are not given to the model.

```typescript
import { createToolPermissions } from "@/agents/tools";
import { getAllTools } from "@/agents/tools";

const permissions = createToolPermissions()
  .allow("*",            ["get_current_time", "get_weather"])  // all agents
  .allow("researcher",   ["web_search", "browser_scrape"])
  .allow("coder",        ["sandbox_run_code", "shell_exec"])
  .allow("supervisor",   ["web_search", "browser_scrape", "sandbox_run_code"])
  .deny("*",             ["db_delete", "file_delete"])         // nobody
  .deny("coder",         ["web_search"])                       // coder searches via code only
  .build();

// Resolve tools for a specific agent
const coderTools = permissions.resolve("coder", getAllTools());
// → [sandbox_run_code, shell_exec, get_current_time, get_weather]
// shell_exec is allowed but db_delete/file_delete are blocked

// Check a single tool
permissions.canUse("researcher", "web_search"); // true
permissions.canUse("researcher", "shell_exec"); // false
```

**Wire permissions into your route or harness:**

```typescript
import { createCustomHarness } from "@/agents/core";
import { getAllTools } from "@/agents/tools";

const agentConfig = {
  ...baseConfig,
  tools: permissions.resolve("researcher", getAllTools()).map((t) => t.name),
};
const harness = createCustomHarness(agentConfig);
```

---

## 4. Tool Error Handling and Fallback

### Option A: Per-tool fallback (via `createAbstractTool`)

```typescript
const resilientSearch = createAbstractTool({
  name: "web_search",
  execute: async ({ query }) => await tavilySearch(query),
  onError: async (err, { query }) => {
    // Fallback to a different provider
    return await bingSearch(query);
  },
});
```

### Option B: Wrapping any tool with a fallback function

```typescript
import { getTool, registerTool } from "@/agents/tools";

function withFallback<T>(primary: ToolDefinition, fallbackFn: (err: Error, input: unknown) => Promise<T>): ToolDefinition {
  return {
    ...primary,
    execute: async (input, ctx) => {
      try {
        return await primary.execute(input, ctx);
      } catch (err) {
        return fallbackFn(err instanceof Error ? err : new Error(String(err)), input);
      }
    },
  };
}

registerTool(withFallback(getTool("web_search")!, async (err) => ({
  results: [],
  error: err.message,
  fallback: true,
})));
```

### Option C: Retry wrapper

```typescript
function withRetry(tool: ToolDefinition, maxAttempts = 3, baseDelayMs = 500): ToolDefinition {
  return {
    ...tool,
    execute: async (input, ctx) => {
      for (let i = 1; i <= maxAttempts; i++) {
        try {
          return await tool.execute(input, ctx);
        } catch (err) {
          if (i === maxAttempts) throw err;
          await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (i - 1)));
        }
      }
    },
  };
}
```

---

## 5. Tool Chaining (multi-step flows)

Chain multiple tools where each output feeds the next input.

```typescript
import { createToolChain, registerTool } from "@/agents/tools";
import { z } from "zod";

const searchAndScrape = createToolChain(
  "search_and_scrape",
  z.object({ query: z.string() })
)
  .description("Search the web, then scrape the top result for full content.")
  .step(
    getTool("web_search")!,
    (input) => ({ query: input.query, k: 1 })   // first step uses original input
  )
  .step(
    getTool("browser_scrape")!,
    (searchResult) => ({ url: searchResult.results[0].url })  // feed search URL to scraper
  )
  .output((scraperResult) => scraperResult.content)
  .build();

registerTool(searchAndScrape);
// Now agents can call "search_and_scrape" as a single tool
```

**Three-step chain example:**

```typescript
const fullResearchChain = createToolChain("full_research", z.object({ topic: z.string() }))
  .description("Search → scrape top 3 → summarize.")
  .step(getTool("web_search")!, (input) => ({ query: input.topic, k: 3 }))
  .step(getTool("browser_scrape")!, (results) => ({ url: results.results[0].url }))
  .step(getTool("summarize")!, (content, original) => ({
    text: content.text,
    query: original.topic,
  }))
  .build();
```

---

## 6. Tool Selection Logic

When agents have multiple tools available, guide selection with the rule-based selector.

```typescript
import { createRuleBasedSelector, getAllTools } from "@/agents/tools";

const selector = createRuleBasedSelector([
  {
    keywords: ["search", "find", "look up", "what is"],
    preferTags: ["web", "retrieval"],
    avoidTags: ["destructive"],
  },
  {
    keywords: ["run", "execute", "calculate", "compute"],
    preferTags: ["code", "compute"],
  },
  {
    keywords: ["send", "email", "notify", "message"],
    preferTags: ["communication"],
    avoidTags: ["destructive"],
  },
]);

// In a custom routing plugin or pre-processing step:
const bestTool = selector.select(userMessage, availableTools);
if (bestTool) {
  console.log(`Selected: ${bestTool.name}`);
}
```

**Tagging tools for better selection:**

```typescript
registerTool({
  name: "web_search",
  // ...
  category: "web",
  // Then use createAbstractTool for tags:
});

// Or with createAbstractTool:
createAbstractTool({
  name: "web_search",
  tags: ["web", "retrieval", "read-only"],
  priority: 1,    // lower = preferred
  cost: "cheap",
  // ...
});
```

---

## 7. Integrations (connecting external services)

### REST API integration pattern

```typescript
import { z } from "zod";
import { registerTool } from "@/agents/tools";

registerTool({
  name: "linear_create_issue",
  description: "Create a Linear issue.",
  parameters: z.object({
    title:       z.string(),
    description: z.string().optional(),
    teamId:      z.string(),
    priority:    z.number().min(0).max(4).default(0),
  }),
  execute: async (input, ctx) => {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) throw new Error("LINEAR_API_KEY not set");
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation { issueCreate(input: { title: "${input.title}", teamId: "${input.teamId}" }) { issue { id url } } }`,
      }),
      signal: ctx.signal,
    });
    const json = await res.json();
    return { issueId: json.data.issueCreate.issue.id, url: json.data.issueCreate.issue.url };
  },
  requiresApproval: true,   // require human confirmation
  category: "integrations",
});
```

### Database integration pattern

```typescript
registerTool({
  name: "db_query",
  description: "Run a read-only SQL query. Never modifies data.",
  parameters: z.object({
    sql:    z.string().regex(/^SELECT/i, "Only SELECT queries allowed"),
    params: z.array(z.unknown()).default([]),
  }),
  execute: async ({ sql, params }, ctx) => {
    const rows = await db.query(sql, params);
    return { rows, count: rows.length };
  },
});
```

### Composio OAuth tools (300+ integrations)

```typescript
// Wire up via environment:
// COMPOSIO_API_KEY=...
// Agents use it like any other tool:
tools: ["composio_github_create_pr", "composio_slack_send_message"]
```

---

## 8. Tool Output Interpretation Pattern

Agents need to pause and interpret tool output before continuing. Use the `ToolResult` structure to make this explicit in your system prompt:

**System prompt snippet to add to any tool-using agent:**

```
After each tool call, interpret the result before proceeding:
1. If ok=false: check the hint field. "retry" → try again with different input. "escalate" → hand off. "use_fallback" → use an alternative approach.
2. If ok=true but data is empty or unexpected: note this in your reasoning and adjust your plan.
3. Never pass raw tool output directly to the user without interpreting it first.
```

Use `withStructuredReasoning` to automate this:

```typescript
import { withStructuredReasoning } from "@/agents/plugins/structured-reasoning";

plugins: [
  withStructuredReasoning({
    role: "tooling",
    goal: "Execute tasks using tools while interpreting every output",
    verifyTests: [
      "Every tool call was interpreted before proceeding",
      "Error results were handled explicitly",
      "The final answer does not contain raw JSON from tool outputs",
    ],
  }),
]
```

---

## Quick Reference

| Need | Solution |
|------|---------|
| Define a tool | `registerTool({ name, description, parameters, execute })` |
| Standardized output | `createAbstractTool(config)` → returns `ToolResult` |
| Per-agent tool access | `createToolPermissions().allow("agent", ["tool"]).build()` |
| Chain tools in sequence | `createToolChain("name", schema).step(tool, mapper).build()` |
| Tool error fallback | `createAbstractTool({ onError })` or wrap manually |
| Tool retry | Wrap `execute` with exponential backoff |
| Tool selection | `createRuleBasedSelector(rules).select(query, tools)` |
| Timeout enforcement | `createAbstractTool({ timeoutMs: 15_000 })` |
| Require human approval | `requiresApproval: true` in ToolDefinition |
| Connect external API | `registerTool` with fetch in execute + `ctx.signal` |
