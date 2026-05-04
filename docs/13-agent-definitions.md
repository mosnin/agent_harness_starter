# Agent Definitions — Actionable Toolkit

A guide to defining agents with explicit roles, boundaries, memory, escalation, and constraints.

---

## What is an AgentDefinition?

An `AgentDefinition` is an `AgentConfig` plus production metadata: **role**, **boundaries**, **autonomy level**, **memory scope**, **constraints**, **escalation rules**, **performance metrics**, **collaboration protocol**, and **feedback mechanism**.

You never need to fill in every field. Start minimal; add properties as your system grows.

---

## Quickstart

```typescript
import { defineAgent } from "@/agents/definitions";
import { registerAgent } from "@/agents/agent-registry";

const researcher = defineAgent("researcher")
  .role("retrieval")
  .description("Searches the web and synthesizes cited answers.")
  .instructions("You are a research assistant. Always cite sources.")
  .tools(["web_search", "browser_scrape"])
  .memory({ scope: "user", topK: 5 })
  .boundaries({ blockedTools: ["shell_exec", "file_write"] })
  .autonomy("supervised")
  .build();

registerAgent("researcher", researcher);
```

---

## Agent Roles (by function)

| Role | Purpose | Default Settings |
|------|---------|-----------------|
| `reasoning` | Planning, deduction, chain-of-thought | temp 0.1, maxTurns 20 |
| `tooling` | API calls, shell, code execution | temp 0.0, requireApproval for shell/file |
| `retrieval` | RAG, web search, DB lookups | temp 0.2, memory on, no write tools |
| `communication` | Messages, emails, summaries | temp 0.7, maxOutputLength 4000 |
| `monitoring` | Health checks, alerting, evaluation | metrics on, auto-escalate |
| `optimization` | Critic loops, re-ranking, scoring | structured reasoning on |
| `orchestration` | Supervisor, router, coordinator | isSupervisor, canDelegate |

### Using presets (skip boilerplate):

```typescript
import { retrievalAgent, toolingAgent, monitoringAgent } from "@/agents/definitions";

const webSearch = retrievalAgent("web-search")
  .instructions("Search and summarize the web.")
  .tools(["web_search"])
  .build();

const coder = toolingAgent("code-executor")
  .instructions("Write and run Python code.")
  .tools(["sandbox_run_code"])
  .build();

const monitor = monitoringAgent("health-checker", "supervisor")
  .instructions("Check response quality and alert on regressions.")
  .build();
```

---

## Agent Boundaries

Boundaries define what an agent **cannot do** and **when to defer**.

```typescript
defineAgent("analyst")
  .boundaries({
    // Hard-block tools (enforced by security policy)
    blockedTools: ["shell_exec", "db_delete"],

    // Topics the agent must refuse (injected as prompt rules)
    refuseTopics: ["legal advice", "medical diagnosis"],

    // When to defer (injected as prompt rules)
    deferWhen: [
      "Defer to the legal agent when the user asks about contracts.",
      "Defer when the task requires real-time stock prices.",
    ],

    // Truncate outputs longer than this
    maxOutputLength: 8000,
  })
```

---

## Autonomy Levels

| Level | Behaviour |
|-------|-----------|
| `full` | Acts without any approval. Use for fully automated pipelines. |
| `supervised` | Requires human/supervisor approval for high-risk tools (default). |
| `assisted` | Every non-trivial action gets a confirmation step. |
| `manual` | Agent plans only; a human executes every step. |

```typescript
defineAgent("deploy-agent")
  .autonomy("supervised")
  .constraints({ requireApproval: ["kubectl_apply", "terraform_apply"] })
```

---

## Memory Configuration

Memory controls what context persists across tasks.

```typescript
defineAgent("support-agent")
  .memory({
    scope: "user",     // recall across all sessions for this user
    topK: 5,           // inject top 5 most relevant memories
    maxTokens: 1000,   // cap injected memory size
    persist: true,     // write outputs back to memory
    ttl: "7d",         // expire stored memories after 7 days
  })
```

Scopes:
- `"none"` — no memory (stateless agent)
- `"session"` — recall within current thread only
- `"user"` — recall across all sessions for a user
- `"global"` — shared knowledge base across all users

---

## Constraints (hard limits)

```typescript
defineAgent("file-manager")
  .constraints({
    // Require human approval before executing these tools
    requireApproval: ["file_delete", "file_write"],

    // Warn the user before calling (injected as prompt caution)
    irreversibleTools: ["file_delete", "db_truncate"],

    // Hard token budget per run
    maxTokensPerRun: 8192,

    // Hard wall-clock timeout per run (ms)
    maxDurationMs: 60_000,

    // Prevent this agent from initiating sub-agent calls
    noHandoffs: true,
  })
```

---

## Escalation

When to hand off to a more capable agent.

```typescript
defineAgent("draft-writer")
  .escalation({
    escalateTo: "senior-writer",   // registered agent name
    when: [
      "When the user asks for legal or compliance language.",
      "When confidence is below 0.7.",
      "When the task requires accessing external APIs.",
    ],
    includeContext: "full",   // "full" | "summary" | "message-only"
    maxEscalations: 1,
  })
```

The `when` conditions are injected into the system prompt as explicit rules. The agent will use `escalateTo` as a handoff target (must be in `handoffs` or registered).

---

## Performance Metrics

```typescript
defineAgent("search-agent")
  .metrics({
    enabled: true,
    customMetrics: ["relevanceScore", "citationCount"],
    sla: {
      maxLatencyMs: 5_000,
      maxErrorRate: 0.02,    // 2% error rate ceiling
      minQualityScore: 0.8,  // used by feedback/evaluation
    },
  })
```

Metrics flow through the observability adapter (see `withObservability`). Connect to Datadog, Langfuse, or any custom adapter.

---

## Collaboration Protocol

```typescript
defineAgent("supervisor")
  .collaboration({
    canDelegate: ["researcher", "coder", "writer"],  // topology enforcement
    acceptsDelegationFrom: [],                        // top of hierarchy
    stateSharing: "context",                          // pass WorkflowContext
    isSupervisor: true,
  })

defineAgent("researcher")
  .collaboration({
    canDelegate: [],             // leaf agent
    acceptsDelegationFrom: ["supervisor"],
    stateSharing: "none",
  })
```

---

## Feedback Mechanisms

How agents learn and adjust from outcomes.

```typescript
defineAgent("answer-agent")
  .feedback({
    // Run a self-critique pass before returning output
    selfCritique: true,

    // External evaluation function (e.g. embedding similarity, rubric scoring)
    evaluate: async (output, ctx) => {
      const score = await myQualityScorer(output, ctx.originalMessage as string);
      return score; // 0.0–1.0
    },
    minScore: 0.75,   // retry if below threshold
    maxRetries: 2,    // up to 2 retry passes

    // Save scores so the router can escalate low-scoring intents to larger models
    persistScores: true,
  })
```

---

## Full Example: Multi-Role Pipeline

```typescript
import { defineAgent, retrievalAgent, toolingAgent, orchestrationAgent } from "@/agents/definitions";
import { registerAgent } from "@/agents/agent-registry";
import { createWorkflow, agentStep, delegate } from "@/agents/workflow";

// Define agents
const searcher = retrievalAgent("searcher")
  .instructions("Search the web for relevant information.")
  .tools(["web_search"])
  .build();

const coder = toolingAgent("coder")
  .instructions("Write and execute Python code.")
  .tools(["sandbox_run_code"])
  .build();

const supervisor = orchestrationAgent("supervisor", ["searcher", "coder"])
  .instructions("Coordinate the searcher and coder to solve the user's request.")
  .build();

// Register
[searcher, coder, supervisor].forEach((a) => registerAgent(a.name, a));

// Wire into a workflow
const pipeline = createWorkflow("research-and-code")
  .add(delegate("coordinate", {
    coordinator: supervisor,
    targets: [
      { name: "searcher", agent: searcher },
      { name: "coder",    agent: coder, when: (ctx) => ctx.currentMessage.includes("code") },
    ],
  }))
  .build();

export { pipeline };
```

---

## Quick Reference

| Feature | Method | Plugin wired automatically |
|---------|--------|---------------------------|
| Role | `.role("retrieval")` | — |
| Memory | `.memory({ scope: "user" })` | `withMemory` |
| Blocked tools | `.boundaries({ blockedTools: [...] })` | `withSecurity` |
| Refuse topics | `.boundaries({ refuseTopics: [...] })` | injected into prompt |
| Require approval | `.constraints({ requireApproval: [...] })` | `withApprovals` |
| Observability | `.metrics({ enabled: true })` | `withObservability` |
| Structured reasoning | `.structuredReasoning(goal)` | `withStructuredReasoning` |
| Custom plugin | `.plugin(myPlugin)` | (as-is) |
