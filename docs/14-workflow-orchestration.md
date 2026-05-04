# Workflow Orchestration — Actionable Toolkit

A guide to composing multi-step agentic workflows using all five orchestration patterns.

---

## Overview

The workflow system provides a fluent `createWorkflow()` builder that composes any combination of:

| Pattern | Method | When to use |
|---------|--------|-------------|
| Sequential | `.agent()` / `.sequential()` | Steps must happen in order |
| Parallel | `.parallel()` | Independent work that can run at once |
| Conditional | `.branch()` | Route based on content or prior output |
| Iterative | `.loop()` | Refine until a quality bar is met |
| Hierarchical | `.delegate()` | Fan out to specialists; supervisor synthesizes |

Plus resilience wrappers: `withRetry`, `withTimeout`, `withFallback`, `withCircuitBreaker`, `withErrorHandler`.

---

## 1. Sequential Orchestration

Steps run in order. Each step receives the output of the previous as `ctx.currentMessage`.

```typescript
import { createWorkflow } from "@/agents/workflow";

const pipeline = createWorkflow("research-report")
  .agent("gather",   gatherAgent)   // step 1: research
  .agent("analyze",  analyzeAgent)  // step 2: receives gather's output
  .agent("write",    writerAgent)   // step 3: receives analyze's output
  .build();

const result = await pipeline.run("What are the latest LLM cost trends?", { userId });
console.log(result.finalOutput);
console.log(result.stepOutputs.gather.output);  // individual step outputs
```

**Named sub-pipelines** using `.sequential()`:

```typescript
import { agentStep, sequential } from "@/agents/workflow/steps";

const reportStep = sequential("report", [
  agentStep("outline", outlineAgent),
  agentStep("draft",   draftAgent),
  agentStep("polish",  polishAgent),
]);

createWorkflow("full-pipeline")
  .agent("research", researchAgent)
  .add(reportStep)
  .build();
```

---

## 2. Parallel Orchestration

All steps run concurrently. Results are collected into a JSON object keyed by step name, set as `ctx.currentMessage`.

```typescript
import { parallel, agentStep } from "@/agents/workflow/steps";

const gatherAll = parallel("gather", [
  agentStep("legal",   legalAgent),
  agentStep("market",  marketAgent),
  agentStep("tech",    techAgent),
]);

createWorkflow("due-diligence")
  .add(gatherAll)
  .agent("synthesize", summaryAgent)  // receives JSON of all three outputs
  .build();
```

Individual outputs are also in `result.stepOutputs.legal`, `.market`, `.tech`.

---

## 3. Conditional Orchestration

Route to the first branch whose predicate matches. If no branch matches, use the fallback.

```typescript
import { branch, agentStep } from "@/agents/workflow/steps";

const routeByUrgency = branch("triage", [
  {
    when: (ctx) => /urgent|asap|critical/i.test(ctx.currentMessage),
    step: agentStep("escalate", escalationAgent),
    label: "urgent",
  },
  {
    when: async (ctx) => {
      const score = await getComplexityScore(ctx.currentMessage);
      return score > 0.8;
    },
    step: agentStep("deep-research", deepResearchAgent),
    label: "complex",
  },
], agentStep("standard", standardAgent)); // fallback

createWorkflow("smart-router")
  .add(routeByUrgency)
  .build();
```

Access which branch ran via `result.stepOutputs.triage.metadata.branch`.

**Conditional based on a prior step's output:**

```typescript
branch("post-research-gate", [
  {
    when: (ctx) => ctx.stepOutputs.research?.output.includes("inconclusive"),
    step: agentStep("deeper-search", deeperSearchAgent),
  },
], agentStep("proceed", writerAgent))
```

---

## 4. Iterative Orchestration (Critic Loop)

Run a step in a loop until a stop condition is met or `maxIterations` is reached.

```typescript
import { loop, agentStep } from "@/agents/workflow/steps";

const refinementLoop = loop(
  "refine",
  agentStep("drafter", draftingAgent),
  {
    // Stop when quality is high enough
    until: async (ctx, iteration) => {
      const score = await judgeQuality(ctx.currentMessage);
      return score >= 0.85 || iteration >= 2;
    },
    maxIterations: 3,

    // Build the next input from the previous output
    buildNextInput: (ctx, iteration) =>
      `Previous draft (attempt ${iteration}):\n${ctx.currentMessage}\n\nRevise to improve accuracy and completeness.`,
  }
);

createWorkflow("quality-pipeline")
  .agent("research", researchAgent)
  .add(refinementLoop)
  .build();
```

**Combined critic + loop pattern:**

```typescript
import { sequential } from "@/agents/workflow/steps";

const criticLoop = loop("critic-loop",
  sequential("draft-and-critique", [
    agentStep("draft",   draftAgent),
    agentStep("critic",  criticAgent),   // outputs a score in its message
    agentStep("revise",  revisionAgent),
  ]),
  {
    until: (ctx) => ctx.currentMessage.includes("APPROVED"),
    maxIterations: 2,
  }
);
```

---

## 5. Hierarchical Orchestration (Multi-Agent Delegation)

Fan out to multiple specialist agents; a coordinator synthesizes the results.

```typescript
import { delegate } from "@/agents/workflow/steps";

const delegation = delegate("analyze", {
  coordinator: summaryAgent,  // synthesizes all outputs
  targets: [
    { name: "legal",  agent: legalAgent },
    { name: "market", agent: marketAgent },
    {
      name: "security",
      agent: securityAgent,
      // Only invoke when relevant
      when: (ctx) => ctx.currentMessage.toLowerCase().includes("api"),
    },
  ],
  mode: "parallel",  // or "sequential" if targets have dependencies
});

createWorkflow("full-analysis")
  .add(delegation)
  .build();
```

Without a coordinator, outputs are concatenated as `[agent]: output`.

---

## Resilience Wrappers

### Retry

```typescript
import { withRetry } from "@/agents/workflow/resilience";

const robustSearch = withRetry(agentStep("search", searchAgent), {
  maxAttempts: 3,
  backoff: "exponential",  // "fixed" | "linear" | "exponential"
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  retryWhen: (err) => err.message.includes("rate limit"),
  onRetry: (err, attempt) => console.warn(`Retry ${attempt}: ${err.message}`),
});
```

### Timeout

```typescript
import { withTimeout } from "@/agents/workflow/resilience";

const timedSearch = withTimeout(agentStep("search", searchAgent), 15_000); // 15s
```

### Fallback

```typescript
import { withFallback } from "@/agents/workflow/resilience";

const searchWithFallback = withFallback(
  agentStep("web-search",  webSearchAgent),   // primary
  agentStep("cache-lookup", cacheAgent),       // fallback if primary fails
);
```

### Circuit Breaker

```typescript
import { createCircuitBreaker } from "@/agents/workflow/resilience";

const cb = createCircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  onStateChange: (from, to, step) => {
    metrics.increment(`circuit_breaker.${step}.${to}`);
  },
});

const protectedStep = cb.wrap(agentStep("external-api", apiAgent));
```

### Error Handler (graceful degradation)

```typescript
import { withErrorHandler } from "@/agents/workflow/resilience";

const graceful = withErrorHandler(agentStep("analysis", analysisAgent), {
  handle: (err, stepName, ctx) => {
    // Return a fallback message instead of crashing the workflow
    return `Analysis unavailable (${err.message}). Proceeding with raw data.`;
  },
});
```

### Concurrency Limiter

```typescript
import { ConcurrencyLimiter } from "@/agents/workflow/resilience";

const limiter = new ConcurrencyLimiter(3); // max 3 parallel agent calls

const limitedSearch = limiter.wrapStep(agentStep("search", searchAgent));
```

---

## State Management

### Persist workflow runs

```typescript
import { createWorkflow, InMemoryStateStore, ConsoleWorkflowLogger } from "@/agents/workflow";

const store = new InMemoryStateStore(); // swap for Postgres/Redis in production
const logger = new ConsoleWorkflowLogger();

const wf = createWorkflow("pipeline", {
  stateStore: store,
  logger,
  timeoutMs: 120_000,
  metadata: { tenantId: "acme" },
}).agent("step1", agentA).build();

const result = await wf.run(message, { userId });

// Later: inspect state
const states = await store.list("pipeline");
const latest = states.at(-1);
console.log(latest?.status);        // "completed" | "failed" | "running"
console.log(latest?.contextSnapshot.stepOutputs);
```

### Custom StateStore (Postgres example)

```typescript
import type { StateStore, WorkflowState } from "@/agents/workflow";

class PostgresStateStore implements StateStore {
  async save(state: WorkflowState) {
    await db.query(
      "INSERT INTO workflow_runs VALUES ($1,$2,$3,...) ON CONFLICT(run_id) DO UPDATE ...",
      [state.runId, state.workflowName, state.status, JSON.stringify(state)]
    );
  }
  async get(runId: string) { ... }
  async list(name?: string) { ... }
  async delete(runId: string) { ... }
}
```

---

## Pure Function Steps (no LLM)

Use `transform` for formatting, filtering, or injecting computed values:

```typescript
import { transform } from "@/agents/workflow/steps";

createWorkflow("format-pipeline")
  .agent("draft", draftAgent)
  .add(transform("add-header", (ctx) =>
    `# Report\n\n${ctx.currentMessage}`
  ))
  .add(transform("inject-metadata", async (ctx) => {
    const wordCount = ctx.currentMessage.split(/\s+/).length;
    return ctx.currentMessage + `\n\n---\nWord count: ${wordCount}`;
  }))
  .build();
```

---

## Complete Example: Research-to-Report Pipeline

```typescript
import {
  createWorkflow, agentStep, parallel, branch, loop, delegate,
  withRetry, withTimeout, withFallback,
  InMemoryStateStore, ConsoleWorkflowLogger,
} from "@/agents/workflow";
import { retrievalAgent, reasoningAgent, communicationAgent, monitoringAgent } from "@/agents/definitions";

const searcher = retrievalAgent("searcher").tools(["web_search"]).build();
const analyst  = reasoningAgent("analyst").build();
const writer   = communicationAgent("writer").build();
const monitor  = monitoringAgent("monitor", "analyst").build();

const pipeline = createWorkflow("research-report", {
  stateStore: new InMemoryStateStore(),
  logger: new ConsoleWorkflowLogger(),
  timeoutMs: 180_000,
})
  // 1. Parallel gather
  .add(parallel("gather", [
    withRetry(agentStep("web",    searcher), { maxAttempts: 2 }),
    withTimeout(agentStep("deep", searcher), 30_000),
  ]))

  // 2. Branch on complexity
  .add(branch("complexity-gate", [
    {
      when: (ctx) => Object.keys(ctx.stepOutputs).length < 2,
      step: agentStep("extra-research", searcher),
      label: "needs-more",
    },
  ], agentStep("proceed", analyst)))  // fallback: analysis

  // 3. Iterative refinement
  .add(loop("refine", agentStep("draft", writer), {
    until: (ctx) => ctx.currentMessage.length > 500,
    maxIterations: 2,
  }))

  // 4. Quality gate
  .add(agentStep("review", monitor))
  .build();

export { pipeline };
```

---

## Selecting an Orchestration Pattern

| Situation | Pattern |
|-----------|---------|
| Steps build on each other's output | Sequential |
| Independent research / gathering | Parallel |
| Different tasks need different agents | Conditional |
| Output needs multiple revision passes | Iterative |
| Specialized sub-agents + synthesis | Hierarchical |
| Flaky external service | withRetry |
| Slow external service | withTimeout |
| Service that may be down | withFallback / withCircuitBreaker |
| Need run history and resume | stateStore |
