# 21 — Build a Multi-Agent System

End-to-end: triage router → specialist agents → workflow pipeline.

**References:** [06 — Harness orchestration](06-harness-orchestration.md), [14 — Workflow orchestration](14-workflow-orchestration.md)

---

## What we're building

A multi-agent system that:
1. Routes each user message to the right specialist (billing, technical, sales)
2. Specialists run in parallel where possible
3. A workflow pipeline handles complex multi-step tasks (research → draft → review)

---

## Step 1 — Define specialist agents

```typescript
// src/agents/specialists.ts
import { createAgent } from "@/agents";

export const billingAgent = createAgent({
  name: "BillingAgent",
  instructions: "You handle billing questions: invoices, refunds, payment methods.",
  tools: ["lookup_invoice", "process_refund"],
  memoryKey: "userId",
});

export const techAgent = createAgent({
  name: "TechAgent",
  instructions: "You handle technical support: bugs, integrations, API questions.",
  tools: ["lookup_error_logs", "check_service_status"],
  memoryKey: "userId",
});

export const salesAgent = createAgent({
  name: "SalesAgent",
  instructions: "You handle sales inquiries: pricing, plans, upgrades.",
  tools: ["lookup_pricing", "create_quote"],
  memoryKey: "userId",
});
```

---

## Step 2 — Build the triage router

```typescript
// src/agents/triage.ts
import { createOrchestrator, runConditional } from "@/agents";
import { billingAgent, techAgent, salesAgent } from "./specialists";

export async function triageRequest(message: string, userId: string): Promise<string> {
  return runConditional(
    message,
    [
      {
        when: (msg) => /invoice|refund|payment|billing/i.test(msg),
        agent: billingAgent,
        context: { userId },
      },
      {
        when: (msg) => /bug|error|api|integration|broken/i.test(msg),
        agent: techAgent,
        context: { userId },
      },
      {
        when: (msg) => /price|plan|upgrade|purchase/i.test(msg),
        agent: salesAgent,
        context: { userId },
      },
    ],
    // Fallback: general support
    billingAgent,
    { userId }
  );
}
```

---

## Step 3 — Build a workflow pipeline for complex tasks

For multi-step tasks (e.g., generating a detailed support report), use `createWorkflow`:

```typescript
// src/agents/report-pipeline.ts
import {
  createWorkflow, agentStep, parallel,
  retry, timeout,
  InMemoryStateStore, ConsoleWorkflowLogger,
} from "@/agents/workflow";
import { createAgent } from "@/agents";

const dataGathererConfig = {
  name: "DataGatherer",
  instructions: "Gather relevant data from all sources for the given customer issue.",
  tools: ["lookup_invoice", "lookup_error_logs", "check_service_status"],
};

const analyzerConfig = {
  name: "Analyzer",
  instructions: "Analyze the gathered data and identify root causes and patterns.",
};

const reportWriterConfig = {
  name: "ReportWriter",
  instructions: "Write a clear, actionable support report based on the analysis.",
};

export const reportPipeline = createWorkflow("support-report", {
  stateStore: new InMemoryStateStore(),
  logger: new ConsoleWorkflowLogger(),
  timeoutMs: 120_000,
})
  .add(
    retry(
      agentStep("gather", dataGathererConfig),
      { maxAttempts: 2, backoff: "fixed", baseDelayMs: 1000 }
    )
  )
  .add(
    timeout(
      agentStep("analyze", analyzerConfig),
      30_000   // 30s max for analysis
    )
  )
  .add(agentStep("write", reportWriterConfig))
  .build();
```

---

## Step 4 — Wire everything to an API route

```typescript
// src/app/api/support/route.ts
import { NextRequest } from "next/server";
import { triageRequest } from "@/agents/triage";
import { reportPipeline } from "@/agents/report-pipeline";

export async function POST(req: NextRequest) {
  const { message, userId, mode } = await req.json();

  if (mode === "report") {
    // Multi-step pipeline
    const result = await reportPipeline.run(message, { userId });
    return Response.json({ output: result.output });
  }

  // Single-turn triage
  const output = await triageRequest(message, userId);
  return Response.json({ output });
}
```

---

## Step 5 — Test it

```bash
# Billing triage
curl -X POST http://localhost:3000/api/support \
  -H "Content-Type: application/json" \
  -d '{"message": "I need a refund for invoice INV-789", "userId": "u1"}'

# Tech triage
curl -X POST http://localhost:3000/api/support \
  -H "Content-Type: application/json" \
  -d '{"message": "I keep getting a 429 error from the API", "userId": "u1"}'

# Complex report pipeline
curl -X POST http://localhost:3000/api/support \
  -H "Content-Type: application/json" \
  -d '{"message": "Generate a full report on user u1 billing issues this month", "userId": "u1", "mode": "report"}'
```

---

## Patterns used

| Pattern | When to use |
|---------|------------|
| `runConditional` | Route to the right specialist based on content |
| `runAgentsInParallel` | Gather data from multiple sources simultaneously |
| `runAgentChain` | Pass one agent's output as the next agent's input |
| `createWorkflow` | Multi-step pipelines with state, logging, and resilience |
| `retry()` | Wrap flaky steps (external API calls, LLM calls) |
| `timeout()` | Cap slow steps (vector search, heavy analysis) |

---

## Next steps

- Add governance: apply ethics and policy checks to each agent (see [18 — Governance playbook](18-governance-playbook.md))
- Go to production: Redis cache, capability tokens, serverless considerations (see [22 — Go to production](22-go-to-production.md))
