# Quickstart

You have an existing Next.js app. You want to add AI agents. This is the fastest path.

---

## Step 1 — Copy the agent infrastructure

```bash
# From the root of your existing project:
cp -r path/to/agent_harness_starter/src/agents  src/agents
```

That single directory is all the infrastructure. Everything else in this repo (routes, components, examples) is optional.

---

## Step 2 — Install dependencies

```bash
npm install @openai/agents openai zod
```

Optional — add only what you use:

```bash
npm install @anthropic-ai/sdk          # if using Claude
npm install @tavily/core               # if using web search
npm install @pinecone-database/pinecone # if using Pinecone for memory
```

---

## Step 3 — Set environment variables

```bash
# .env.local — minimum required
OPENAI_API_KEY=sk-...

# Optional — pick a memory backend (defaults to in-process Map)
MEMORY_PROVIDER=memory      # "memory" | "pgvector" | "pinecone"

# Optional — if using Claude
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Step 4 — Add the agent API route

```bash
mkdir -p src/app/api/agent
cp path/to/agent_harness_starter/routes/agent/route.ts src/app/api/agent/route.ts
```

---

## You're running. Test it:

```bash
curl -X POST http://localhost:3000/api/agent \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, what can you do?"}'
```

You'll get a streaming SSE response.

---

## Creating your first agent

`createAgent` is the single recommended starting point. It wires up memory, guardrails, and observability automatically:

```typescript
import { createAgent } from "@/agents";

const agent = createAgent({
  name: "SupportAgent",
  instructions: "You are a helpful customer support assistant.",
  memoryKey: "userId",   // enables per-user memory automatically
});

// Run it
const result = await agent.run("How do I reset my password?");
```

### How it scales

Start with `createAgent()`. When you need more:

```typescript
// Step 1 — Start here (memory + guardrails + observability auto-wired)
const agent = createAgent({ name: "...", instructions: "..." });

// Step 2 — Add human approval gates for irreversible actions
import { createFullHarness } from "@/agents/presets";
const agent = createFullHarness({ ..., requireApprovalFor: ["file_delete"] });

// Step 3 — Production hardening (security + governance + audit in one call)
import { withControlPlane } from "@/agents";
import { DEFAULT_GOVERNANCE_POLICY } from "@/agents/governance";
const agent = createAgent({
  ...,
  plugins: [withControlPlane({ governance: DEFAULT_GOVERNANCE_POLICY })],
});

// Step 4 — Full control
import { createCustomHarness } from "@/agents";
const agent = createCustomHarness({ ..., plugins: [withMemory(...), withGuardrails(...)] });
```

---

## What's available — take only what you need

Everything below is independent. Use one, some, or all.

### Memory — context that persists across sessions

```typescript
import { createMemoryManager, USER_LONG_TERM_POLICY } from "@/agents/memory";
import { memory } from "@/agents/memory";

const manager = createMemoryManager({ adapter: memory, policy: USER_LONG_TERM_POLICY });

// Store after a session
await manager.store(`user:${userId}`, "User prefers concise bullet-point answers.");

// Retrieve before a session
const memories = await manager.retrieve(`user:${userId}`, userMessage);
```

### Skills — named capability bundles

```typescript
import { defineSkill } from "@/agents/skills";

defineSkill({
  name: "workspace",
  description: "Read and write workspace documents.",
  tools: ["get_page", "create_page", "search_pages"],
});

// Then in your AgentConfig:
const agent = { skills: ["workspace"], ... };
```

### Workflow — multi-step agent pipelines

```typescript
import { createWorkflow, agentStep, retry } from "@/agents/workflow";

const pipeline = createWorkflow("research-and-draft")
  .add(retry(agentStep("researcher", researcherConfig), { maxAttempts: 2 }))
  .add(agentStep("drafter", drafterConfig))
  .build();

const result = await pipeline.run("Write a doc about vector databases");
```

Resilience wrappers: `retry`, `timeout`, `fallback`, `createCircuitBreaker`, `onError`.

### Governance — policy enforcement and audit trails

```typescript
import { withGovernance, STANDARD_ETHICS_POLICY, DEFAULT_GOVERNANCE_POLICY } from "@/agents/governance";

// Add to any agent's plugins array:
withGovernance({
  policy: DEFAULT_GOVERNANCE_POLICY,   // blocks dangerous tools
  ethics: STANDARD_ETHICS_POLICY,      // checks outputs for PII, harm, deception
  auditOnly: false,                    // set true to log-only before enforcing
})
```

### Agent definitions — typed, self-documenting agent configs

```typescript
import { defineAgent } from "@/agents/definitions";

const agent = defineAgent("document-assistant")
  .role("tooling")
  .instructions((ctx) => `Help ${ctx.userId} manage their workspace.`)
  .skills(["workspace"])
  .memory({ scope: "user", ttl: "30d", topK: 5 })
  .boundaries({ refuseTopics: ["Delete content without confirmation"] })
  .autonomy("supervised")
  .build();
```

### Security — tool-level access control

```typescript
import { withSecurity, createPolicy } from "@/agents/security";

const policy = createPolicy({
  allowList: ["get_page", "search_pages"],   // only these tools
});

withSecurity({ policy })  // add to plugins
```

---

## Serverless & edge runtime considerations

The default in-memory adapters (memory, cache) use `globalThis` singletons. These work correctly in long-running processes (traditional Node.js servers, containers). In serverless or edge environments, state is not shared across invocations.

**If you deploy to serverless (Vercel Functions, AWS Lambda, Cloudflare Workers):**

```typescript
// ✗ Default in-memory adapter — state lost between invocations
import { memory } from "@/agents/memory";

// ✓ Persistent adapter — state survives across cold starts
import { PgVectorAdapter } from "@/agents/memory/pgvector";
import { setMemoryAdapter } from "@/agents/memory";
setMemoryAdapter(new PgVectorAdapter());  // call once at startup

// ✓ For cache — use Redis instead of the in-memory default
import { createCacheManager, RedisCache } from "@/agents/routing";
import { Redis } from "@upstash/redis";
const cache = createCacheManager(new RedisCache(new Redis({ url: "...", token: "..." })));
```

**Edge runtimes (Cloudflare Workers, Vercel Edge):**

Some adapters use Node.js APIs (`crypto`, `Buffer`). The capability token module and PgVector adapter require a Node.js runtime. Auth adapters and the governance policy engine are edge-compatible.

---

## Domain example — making a document app like Notion agentic

See [`src/agents/examples/notion-style/`](src/agents/examples/notion-style/README.md) for a complete walkthrough:
- Stub tools wired to your DB (get/create/update/delete pages, search, blocks)
- Two agents: `editorAgent` (writes) and `searchAgent` (reads)
- A publish pipeline: research → draft → review → create page
- Instructions on replacing each stub with your real service calls

---

## Full documentation

| Guide | What it covers |
|-------|---------------|
| [01 — Integration](docs/01-integration.md) | Detailed copy instructions, tsconfig aliases, first run |
| [02 — Connecting your app](docs/02-connecting-your-app.md) | Auth, DB, session context |
| [03 — Building tools](docs/03-building-tools.md) | Tool patterns, authorization, testing |
| [13 — Agent definitions](docs/13-agent-definitions.md) | Roles, boundaries, autonomy levels |
| [14 — Workflow orchestration](docs/14-workflow-orchestration.md) | Pipeline patterns, retry, timeout, fallback |
| [15 — Tools playbook](docs/15-tools-playbook.md) | Permissions, chaining, abstraction |
| [16 — Skills playbook](docs/16-skills-playbook.md) | I/O contracts, evaluation |
| [17 — Memory playbook](docs/17-memory-playbook.md) | Retrieval strategies, TTL, privacy |
| [18 — Governance playbook](docs/18-governance-playbook.md) | Policy, ethics, compliance, escalation |
| [20 — Build a support agent](docs/20-build-a-support-agent.md) | End-to-end: single agent, memory, guardrails, curl test |
| [21 — Build a multi-agent system](docs/21-build-a-multi-agent-system.md) | Triage router → specialists → workflow pipeline |
| [22 — Go to production](docs/22-go-to-production.md) | Routing, caching, governance, Redis, deployment |
