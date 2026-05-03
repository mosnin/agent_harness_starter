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
