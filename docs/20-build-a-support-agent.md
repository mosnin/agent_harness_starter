# 20 — Build a Support Agent

End-to-end: one agent, persistent memory, guardrails, API route, streaming curl test.

**References:** [03 — Building tools](03-building-tools.md), [09 — Auth adapters](09-auth-adapters.md), [10 — Database adapters](10-database-adapters.md), [13 — Agent definitions](13-agent-definitions.md)

---

## What we're building

A customer support agent that:
- Remembers each user's preferences across sessions
- Refuses off-topic questions (guardrail)
- Streams responses to the browser
- Runs on your existing Next.js `/api/agent` route

---

## Step 1 — Define the agent

```typescript
// src/agents/support-agent.ts
import { createAgent } from "@/agents";
import { piiSanitizerGuardrail, maxLengthGuardrail } from "@/agents/guardrails";

export const supportAgent = createAgent({
  name: "SupportAgent",
  instructions: (ctx) =>
    `You are a helpful customer support agent for Acme Corp.
    You are talking to user ${ctx.userId ?? "a guest"}.
    Only answer questions about Acme products, billing, and account issues.
    Be concise and friendly.`,

  memoryKey: "userId",   // per-user memory injected automatically

  guardrails: {
    input: [
      maxLengthGuardrail(4000),                    // reject very long inputs
    ],
    output: [
      piiSanitizerGuardrail(["email", "phone"]),   // strip PII from responses
    ],
  },
});
```

`createAgent` wires up:
- **Memory** — because `memoryKey` is set, user memories are fetched before each turn and stored after
- **Guardrails** — input/output checks run on every message
- **Observability** — every run is emitted to your observability adapter

---

## Step 2 — Register a tool (optional)

```typescript
// src/agents/tools/lookup-order.ts
import { registerTool } from "@/agents/tools/registry";

registerTool({
  name: "lookup_order",
  description: "Look up the status of a customer order by order ID.",
  parameters: z.object({
    orderId: z.string().describe("The order ID to look up"),
  }),
  execute: async ({ orderId }, ctx) => {
    // ctx.userId is available for authorization
    const order = await db.orders.findFirst({ where: { id: orderId, userId: ctx.userId } });
    if (!order) return { error: "Order not found or does not belong to this user." };
    return { status: order.status, estimatedDelivery: order.estimatedDelivery };
  },
});
```

Add the tool to the agent:

```typescript
export const supportAgent = createAgent({
  name: "SupportAgent",
  tools: ["lookup_order"],
  // ...
});
```

---

## Step 3 — Add the API route

```typescript
// src/app/api/support/route.ts
import { NextRequest } from "next/server";
import { supportAgent } from "@/agents/support-agent";

export async function POST(req: NextRequest) {
  const { message, userId } = await req.json();

  const stream = supportAgent.stream(message, { userId });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      for await (const event of stream) {
        if (event.type === "message_delta") {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        if (event.type === "run_complete") {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
```

---

## Step 4 — Test with curl

```bash
# Start dev server
npm run dev

# First message — no memory yet
curl -X POST http://localhost:3000/api/support \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the return policy?", "userId": "user_123"}'

# Second message — agent now has memory of the first turn
curl -X POST http://localhost:3000/api/support \
  -H "Content-Type: application/json" \
  -d '{"message": "Can you look up order ORD-456?", "userId": "user_123"}'

# Off-topic message — guardrail blocks it
curl -X POST http://localhost:3000/api/support \
  -H "Content-Type: application/json" \
  -d '{"message": "Write me a poem about space", "userId": "user_123"}'
```

---

## What's happening under the hood

```
Request arrives
  │
  ├─ Memory plugin: fetch user_123's memories → inject into system prompt
  │
  ├─ Input guardrail: check length → pass
  │
  ├─ Agent runs: model sees memories + user message + tools
  │
  ├─ Tool call: lookup_order → db query → result back to model
  │
  ├─ Output guardrail: strip any PII from final response
  │
  ├─ Memory plugin: store this turn in user_123's memory
  │
  └─ Stream events back to browser
```

---

## Next steps

- Add auth: wrap the route with your auth adapter (see [09 — Auth adapters](09-auth-adapters.md))
- Persist memory: swap the default in-memory adapter for PgVector or Pinecone (see [17 — Memory playbook](17-memory-playbook.md))
- Add governance: enforce ethics policy and compliance logging (see [18 — Governance playbook](18-governance-playbook.md))
- Scale up: see [21 — Build a multi-agent system](21-build-a-multi-agent-system.md)
