# Guardrails & Observability

## Guardrails

Guardrails validate or transform inputs/outputs before and after agent runs. They can reject requests, sanitize content, enforce output schemas, or escalate to human review.

### Input guardrails

Run before the agent processes the user message:

```typescript
import { maxLengthGuardrail, piiSanitizerGuardrail } from "@/agents/guardrails";

const agentConfig: AgentConfig = {
  guardrails: {
    input: [
      maxLengthGuardrail(8000),   // reject messages over 8000 chars
      piiSanitizerGuardrail,       // redact SSN, card numbers, emails
      // your custom guardrail here
    ],
  },
};
```

### Output guardrails

Run on the agent's final response:

```typescript
import { requireJsonOutputGuardrail, blockedKeywordsGuardrail } from "@/agents/guardrails";

const agentConfig: AgentConfig = {
  guardrails: {
    output: [
      requireJsonOutputGuardrail,                       // must be valid JSON
      blockedKeywordsGuardrail(["competitor", "price"]), // block specific content
    ],
  },
};
```

### Custom guardrails

```typescript
import { GuardrailBlockError, GuardrailHumanReviewError } from "@/agents/guardrails";
import type { InputGuardrail, OutputGuardrail } from "@/agents/guardrails";

// Block inputs with flagged content
export const contentPolicyGuardrail: InputGuardrail = {
  name: "content_policy",
  async check(input, ctx) {
    const flagged = await myContentModerationApi(input);
    if (flagged) throw new GuardrailBlockError("Input violates content policy.", "content_policy");
    return input;
  },
};

// Require human review for high-value operations
export const highValueReviewGuardrail: OutputGuardrail = {
  name: "high_value_review",
  async check(output, ctx) {
    if (output.includes("$10,000") || output.includes("refund")) {
      throw new GuardrailHumanReviewError(
        "High-value operation requires review.",
        "amount_threshold",
        { output }
      );
    }
    return output;
  },
};
```

When `GuardrailBlockError` is thrown, the harness emits `{ type: "error", error: "Blocked: <reason>" }` and stops.

---

## Observability

The `ObservabilityAdapter` interface hooks into every run, tool call, handoff, and error.

### Default: Console adapter

Out of the box, all events are logged to stdout via `ConsoleAdapter`. This is useful for development.

### Custom adapter

Implement `ObservabilityAdapter` for your backend:

```typescript
import type { ObservabilityAdapter } from "@/agents/observability";

export class DatadogAdapter implements ObservabilityAdapter {
  onRunStart(span) {
    datadogTracer.startSpan("agent.run", { tags: { agentName: span.agentName } });
  }
  onRunComplete(span, result) { /* ... */ }
  onToolCall(span) { /* ... */ }
  onUsage(event) {
    datadogMetrics.increment("agent.tokens", event.totalTokens);
  }
}
```

Register it at startup in `src/instrumentation.ts`:

```typescript
import { setObservabilityAdapter } from "@/agents/observability";
import { DatadogAdapter } from "@/observability/datadog";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  setObservabilityAdapter(new DatadogAdapter());
  // ...
}
```

All observability calls are fire-and-forget — a failing adapter never crashes the agent.

### Available hooks

| Hook | When it fires |
|------|--------------|
| `onRunStart` | Beginning of every agent run |
| `onRunComplete` | Successful completion |
| `onRunError` | Run failed with an error |
| `onToolCall` | Just before a tool executes |
| `onToolResult` | After a tool returns |
| `onHandoff` | When one agent hands off to another |
| `onUsage` | Token usage data after each run |

---

## Capability Tokens

Capability tokens are scoped, short-lived JWTs that grant an agent permission to use a specific set of tools for a single run. They implement the Non-Human Identity (NHI) principle: each run gets its own token with the minimum tools needed — never a long-lived shared credential.

```bash
# Required env var (min 32 chars)
AGENT_CAPABILITY_SECRET=your-secret-at-least-32-characters-long

# Optional — override default 15-minute TTL
AGENT_CAPABILITY_DEFAULT_TTL=10m
```

### Issue a token before the run

```typescript
import { issueCapabilityToken } from "@/agents/security";

// In your API route, issue a scoped token per user request
const token = await issueCapabilityToken({
  sub: userId,            // who is making the request
  runId: crypto.randomUUID(),
  tools: ["web_search", "get_page", "create_page"],
  ttl: "10m",             // expires after 10 minutes
});
```

### Verify the token in tool handlers

```typescript
import { verifyCapabilityToken, CapabilityError } from "@/agents/security";

// Verify before executing a sensitive tool
async function executeTool(toolName: string, token: string) {
  const caps = await verifyCapabilityToken(token);

  if (!caps.tools.includes(toolName) && !caps.tools.includes("*")) {
    throw new CapabilityError(`Token does not authorize "${toolName}".`);
  }

  // proceed with tool execution
}
```

### Resolve tools from a token (convenience helper)

```typescript
import { resolveToolsFromToken } from "@/agents/security";

// Validate token and get the allow-list in one call
const { sub, tools } = await resolveToolsFromToken(token, runId);
// tools → ["web_search", "get_page", "create_page"]
```

### Combine with withSecurity plugin

```typescript
import { withSecurity, createPolicy, issueCapabilityToken } from "@/agents/security";

const token = await issueCapabilityToken({ sub: userId, tools: ["web_search"], ttl: "5m" });

// Enforce at the plugin level — any tool not in the token is blocked
withSecurity({
  policy: createPolicy({ allowList: ["web_search"] }),
})
```

### Token payload shape

```typescript
interface CapabilityTokenPayload {
  sub: string;        // user/service identity
  runId?: string;     // locks token to a specific run
  agentName?: string; // locks token to a specific agent
  tools: string[];    // allowed tool names; "*" = all (use with care)
  iat: number;        // issued-at (seconds epoch)
  exp: number;        // expires-at (seconds epoch)
}
```

Tokens are HS256-signed JWTs. `CapabilityError` is thrown for invalid signatures, malformed tokens, or expired tokens.
