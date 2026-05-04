# 22 — Go to Production

Checklist for hardening your agent system: routing, caching, governance, security, Redis, deployment.

**References:** [07 — Routing and caching](07-routing-and-caching.md), [18 — Governance playbook](18-governance-playbook.md), [19 — Routing playbook](19-routing-playbook.md)

---

## Production checklist

- [ ] Swap in-memory adapters for persistent backends (Redis, PgVector)
- [ ] Choose the right preset for your risk profile
- [ ] Issue per-run capability tokens
- [ ] Enable governance + ethics checks
- [ ] Set a cost routing policy (cheap model for simple queries)
- [ ] Wire observability to your APM
- [ ] Handle serverless cold starts

---

## 1 — Choose the right preset

| Preset | Use when |
|--------|----------|
| `createStandardHarness()` / `createAgent()` | Agents that read data or draft content |
| `createFullHarness()` | Agents that send emails, delete records, charge cards |
| `createCustomHarness()` | You need precise control over which plugins run |

```typescript
import { createFullHarness } from "@/agents/presets";

// Agents that take irreversible actions need human approval gates
const agent = createFullHarness({
  name: "DataCleanupAgent",
  instructions: "...",
  requireApprovalFor: ["file_delete", "db_delete", "send_email"],
});
```

---

## 2 — Persistent memory (Redis / PgVector)

In-memory adapters lose state between serverless invocations. Replace them before shipping:

```typescript
// src/agents/adapters.ts
import { setMemoryAdapter } from "@/agents/memory";
import { PgVectorAdapter } from "@/agents/memory/pgvector";

// Call once at startup (e.g., in your Next.js instrumentation.ts)
export function initAdapters() {
  setMemoryAdapter(new PgVectorAdapter({
    connectionString: process.env.DATABASE_URL!,
    tableName: "agent_memories",
  }));
}
```

---

## 3 — Redis cache for routing

The cost router caches model-selection decisions. Without Redis, decisions are lost between invocations:

```typescript
import { createCacheManager, RedisCache } from "@/agents/routing";
import { Redis } from "@upstash/redis";

export const cache = createCacheManager(
  new RedisCache(
    new Redis({ url: process.env.UPSTASH_URL!, token: process.env.UPSTASH_TOKEN! })
  )
);
```

---

## 4 — Cost routing (cheap model for simple queries)

```typescript
import { createRouter } from "@/agents/routing";

const router = createRouter({
  rules: [
    {
      // Simple FAQ-style questions → cheap fast model
      when: (signals) => signals.estimatedTokens < 500 && !signals.requiresTools,
      model: "gpt-4o-mini",
      rationale: "Low complexity, no tools needed",
    },
    {
      // Complex multi-step reasoning → capable model
      when: (signals) => signals.estimatedTokens > 2000 || signals.requiresTools,
      model: "gpt-4o",
      rationale: "High complexity or tool use required",
    },
  ],
  defaultModel: "gpt-4o-mini",
  cache,
});

// In your route handler:
const plan = await router.plan(message, { userId, tools: agentConfig.tools });
const agent = createAgent({ ...agentConfig, model: plan.model });
```

---

## 5 — Governance and ethics

Enforce policy on every agent call. Zero-config default blocks the most common dangerous actions:

```typescript
import { withGovernance, DEFAULT_GOVERNANCE_POLICY, STANDARD_ETHICS_POLICY } from "@/agents/governance";

const agent = createAgent({
  name: "ProductionAgent",
  instructions: "...",
  plugins: [
    withGovernance({
      policy: DEFAULT_GOVERNANCE_POLICY,   // blocks shell_exec, file_delete, etc.
      ethics: STANDARD_ETHICS_POLICY,      // checks PII, harmful content, deception
      auditOnly: false,                    // true = log only (useful for shadow mode)
    }),
  ],
});
```

---

## 6 — Capability tokens (NHI security)

Issue a short-lived token per run. The token limits which tools this specific run can use:

```typescript
import { issueCapabilityToken, verifyCapabilityToken } from "@/agents/security";

// At the start of each run (in your route handler):
const token = await issueCapabilityToken({
  sub: userId,
  runId: crypto.randomUUID(),
  tools: ["web_search", "lookup_order"],   // only these tools for this run
  ttl: "15m",
  aud: "support-agent",   // NEW: scope to this specific agent
  iss: "acme-platform",   // NEW: identify your platform
});

// Pass the token to the agent context
const result = await agent.run(message, { userId, capabilityToken: token });
```

When verifying, you can assert the expected audience to prevent tokens issued for one agent from being used with another:

```typescript
// Reject tokens not scoped to this agent
const caps = await verifyCapabilityToken(token, { expectedAud: "support-agent" });
```

Requires `AGENT_CAPABILITY_SECRET` (min 32 chars) in your environment.

---

## 7 — Serverless deployment notes

**Next.js on Vercel:**
- Use the App Router with `export const runtime = "nodejs"` on agent routes (not `"edge"`) — some adapters require Node.js APIs
- The `PgVectorAdapter` and `CapabilityError` module use `crypto` — Node.js runtime only
- Set `maxDuration = 60` (or higher) on agent routes to avoid function timeout during long runs

```typescript
// src/app/api/agent/route.ts
export const runtime = "nodejs";
export const maxDuration = 60;
```

**AWS Lambda / Cloudflare Workers:**
- Same Node.js runtime requirement
- Cold starts: call `initAdapters()` outside the handler so it runs once per container

**Health check:**
- Add a `GET /api/agent/health` route that returns 200 — useful for load balancer probes

---

## 8 — Observability

Wire up your APM before going live:

```typescript
import { setObservabilityAdapter } from "@/agents/observability";

// DataDog example
setObservabilityAdapter({
  onRunStart: (span) => datadogMetrics.increment("agent.run.start", { agent: span.agentName }),
  onRunEnd: (span) => {
    datadogMetrics.histogram("agent.run.duration", span.durationMs, { agent: span.agentName });
    if (span.error) datadogMetrics.increment("agent.run.error", { agent: span.agentName });
  },
  onToolCall: (span) => datadogMetrics.increment("agent.tool.call", { tool: span.toolName }),
});
```

---

## 9 — Runtime validation

Validate your agent runtime configuration at startup to catch missing secrets or misconfigured adapters before they cause runtime failures in production:

```typescript
// src/instrumentation.ts (Next.js) or server startup
import { validateRuntime } from "@/agents";

const { valid, warnings, errors } = validateRuntime({
  warnOnInMemory: true,
  requireOpenAIKey: true,
  requireCapabilitySecret: true,
});

if (!valid) {
  throw new Error("Agent runtime misconfigured:\n" + errors.join("\n"));
}
warnings.forEach(w => console.warn("[agents]", w));
```

- `errors` — fatal misconfigurations (missing required env vars, invalid secrets). Throws to prevent startup.
- `warnings` — non-fatal issues (e.g., using in-memory adapters in a serverless environment) that won't block startup but should be reviewed before production.

---

## Pre-launch verification

```bash
# 1. Type check
npx tsc --noEmit

# 2. Tests
npx vitest run

# 3. Build
npm run build:lib

# 4. Smoke test the API route
curl -X POST https://your-domain.com/api/agent \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "userId": "smoke-test"}'
```
