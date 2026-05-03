# 05 — Model Configuration

How you configure models, prompts, and parameters directly determines the quality, cost, and reliability of your agents. This guide covers every tunable dimension.

---

## Model selection

Set the default model in your environment:

```bash
OPENAI_MODEL=gpt-4o       # default — best balance of capability and speed
# OPENAI_MODEL=gpt-4o-mini  # 10x cheaper, good for simple tasks
# OPENAI_MODEL=o3-mini       # best for multi-step reasoning, slower
```

Override per agent in `AgentConfig`:

```typescript
// src/agents/my-agent.ts
export const myAgentConfig: AgentConfig = {
  name: "MyAgent",
  model: "gpt-4o",         // override the default
  // ...
};
```

### Choosing the right model per task

| Task type | Recommended model | Why |
|---|---|---|
| General chat, Q&A | `gpt-4o-mini` | Fast, cheap, sufficient |
| Web research, synthesis | `gpt-4o` | Better reading comprehension |
| Complex reasoning, coding | `o3-mini` or `o1` | Multi-step problem solving |
| Data extraction, classification | `gpt-4o-mini` | Structured output is consistent |
| Multi-agent orchestration (triage) | `gpt-4o-mini` | Fast routing, low cost |
| Specialist agents | `gpt-4o` | Quality for final output |

### Cost optimization strategy

Use cheaper models for routing and expensive models only for final work:

```typescript
const orchestratorConfig: OrchestratorConfig = {
  routerAgent: {
    name: "Router",
    model: "gpt-4o-mini",     // ← cheap: just routing
    instructions: "Route to the right specialist.",
    maxTurns: 3,
  },
  specialists: [
    {
      name: "Analyst",
      model: "gpt-4o",        // ← full model: final work
      instructions: "Produce detailed analysis...",
      tools: ["web_search", "get_revenue_report"],
    },
  ],
};
```

---

## System prompts (instructions)

The `instructions` field is the most impactful configuration in your agent. Treat it like code — version it, test it, and iterate.

### Structure

A good system prompt has four sections:

```typescript
instructions: `
# Role
You are a [specific role] for [your product name].
[One sentence on who you are to the user.]

# Capabilities
You have access to:
- [tool_name]: [what it does in plain English]
- [tool_name]: [what it does]

# Behavior
[Specific rules for how to behave. Be concrete.]
- Always [do X]
- Never [do Y]
- If [situation], then [action]

# Output format
[How to format responses — length, structure, tone]
- Keep responses concise unless detail is requested
- Use bullet points for lists of 3+
- Always confirm before taking write actions
`
```

### Example: Customer support agent

```typescript
instructions: `
# Role
You are a support agent for Acme SaaS. You help customers resolve billing issues,
understand their usage, and escalate complex problems to human agents.

# Capabilities
- get_subscription: Retrieve the customer's current plan and billing history
- update_billing: Apply credits, change plans, or issue refunds (requires confirmation)
- search_docs: Search the Acme knowledge base for answers
- create_support_ticket: Escalate to a human agent when you cannot resolve the issue

# Behavior
- Always start by looking up the customer's account before responding to billing questions
- Ask for confirmation before making any changes to their account ("I'll apply a $20 credit — confirm?")
- If you cannot resolve an issue, create a support ticket and give the customer the ticket number
- Never reveal internal pricing structures or other customers' data

# Output format
- Keep responses under 150 words unless the user asks for detail
- Use plain language — no internal jargon
- Always end write actions with a summary of what you did
`
```

### Injecting dynamic context into prompts

For per-user or per-session context, generate the prompt dynamically:

```typescript
// src/agents/support-agent.ts
export function createSupportAgent(user: AuthUser, orgPlan: string): AgentConfig {
  return {
    name: "SupportAgent",
    instructions: `
You are a support agent for ${orgPlan} tier customers.
The current user is ${user.name} (${user.email}) on the ${orgPlan} plan.
${orgPlan === "enterprise" ? "This is an enterprise customer — prioritize resolution time." : ""}

// ... rest of instructions
    `,
    tools: ["get_subscription", "search_docs", "create_support_ticket"],
  };
}
```

### Keeping instructions focused

Long instructions reduce model quality. Follow these rules:
- One agent = one job. Don't build a "do everything" agent.
- Tools have descriptions — don't repeat them in instructions.
- Use bullet points over paragraphs.
- Test with the shortest instructions that work.

---

## Temperature

Controls creativity vs. predictability:

```typescript
export const agentConfig: AgentConfig = {
  temperature: 0.3,   // more deterministic — good for data tasks, tool calling
  // temperature: 0.7, // default — balanced
  // temperature: 1.2, // more creative — good for writing, brainstorming
};
```

### Recommendations by task type

| Task | Temperature |
|---|---|
| Data extraction, SQL generation | 0.0–0.2 |
| Tool selection and routing | 0.2–0.4 |
| Q&A, summarization | 0.4–0.7 |
| Creative writing, brainstorming | 0.8–1.2 |

---

## Max turns

`maxTurns` limits the LLM ↔ tool call loop. This is your primary protection against runaway agents:

```typescript
export const agentConfig: AgentConfig = {
  maxTurns: 10,   // stops after 10 LLM + tool iterations
};
```

| Agent type | Recommended maxTurns |
|---|---|
| Simple Q&A (no tools) | 3–5 |
| Single tool use | 5–8 |
| Research (multiple searches) | 10–15 |
| Code generation + execution | 15–20 |
| Multi-step automation | 20–30 |

Too low → agent gives up on complex tasks. Too high → a bug causes expensive loops.

---

## Context window management

For long conversations, trim the message history before passing to the agent:

```typescript
// In your API route, before calling the harness:
const messages = await db.getMessages(threadId);

// Keep last N messages to stay within context limits
const MAX_HISTORY = 20;
const trimmedMessages = messages.slice(-MAX_HISTORY);

const result = await harness.run({
  messages: trimmedMessages.map(m => ({ role: m.role, content: m.content })),
  context: { userId },
});
```

For token-aware trimming:

```typescript
import { encoding_for_model } from "tiktoken";

function trimToTokenLimit(messages: Message[], maxTokens = 8000): Message[] {
  const enc = encoding_for_model("gpt-4o");
  let tokens = 0;
  const trimmed: Message[] = [];

  for (const msg of [...messages].reverse()) {
    const count = enc.encode(msg.content).length;
    if (tokens + count > maxTokens) break;
    trimmed.unshift(msg);
    tokens += count;
  }
  return trimmed;
}
```

---

## Tool choice strategies

By default the model decides when to call tools. You can influence this:

```typescript
// Force the model to use at least one tool (useful for data-fetching agents)
// Currently via instructions, not an SDK parameter:
instructions: `
Always look up the customer's account data before responding.
Never answer billing questions from memory — always call get_subscription first.
`

// Tell the model not to over-use tools:
instructions: `
Only search the web if you do not already know the answer confidently.
Prefer using cached data over making new API calls.
`
```

---

## Multi-model configuration

Different parts of a pipeline can use different models. The orchestrated system in `examples/orchestrated-agent.ts` uses this:

```typescript
// Fast, cheap model for routing decisions
routerAgent: { model: "gpt-4o-mini", maxTurns: 3 }

// Full model for producing the final answer
specialistAgents: [
  { model: "gpt-4o", maxTurns: 15 },     // research
  { model: "o3-mini", maxTurns: 20 },     // coding
]
```

---

## Per-tenant model configuration

For B2B SaaS, let enterprise customers configure their own model preferences:

```typescript
// In your API route:
const orgSettings = await db.orgSettings.get(user.orgId);

const agentConfig: AgentConfig = {
  name: "SupportAgent",
  model: orgSettings.preferredModel ?? config.openai.model,
  temperature: orgSettings.temperature ?? 0.5,
  instructions: orgSettings.customInstructions
    ? `${baseInstructions}\n\nAdditional company context:\n${orgSettings.customInstructions}`
    : baseInstructions,
};
```

---

## Testing prompt changes

Before shipping a prompt change:

1. **Smoke test**: verify the agent still answers basic questions correctly
2. **Edge cases**: test with ambiguous, adversarial, and empty inputs
3. **Tool calling**: verify tools are called at the right times (not too often, not too rarely)
4. **Refusal behavior**: verify the agent refuses inappropriate requests

A lightweight eval pattern:

```typescript
// scripts/eval-agent.ts
import { createHarness } from "@/agents/harness";
import { myAgentConfig } from "@/agents/my-agent";

const cases = [
  { input: "What is my current subscription?", expectToolCall: "get_subscription" },
  { input: "Delete my account", expectRefusal: true },
  { input: "How do I export my data?", expectToolCall: "search_docs" },
];

for (const tc of cases) {
  const harness = createHarness(myAgentConfig);
  const result = await harness.run({ messages: [{ role: "user", content: tc.input }] });
  // ... assert expectations
}
```
