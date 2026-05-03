# 03 — Building Tools

Tools are the bridge between your AI agents and your product. A tool is a typed, named function the model can decide to call. This guide covers the full anatomy and common patterns.

---

## Tool anatomy

```typescript
import { z } from "zod";
import { registerTool } from "@/agents/tools/registry";

export const myTool = registerTool({
  // Unique name — used by agents, MCP server, and logs
  name: "my_tool",

  // Shown to the model to help it decide when to call this tool.
  // Be specific: describe WHAT it does, WHEN to use it, and what it returns.
  description: "Fetches the latest invoice for a customer. Use when the user asks about billing, charges, or payment history.",

  // Zod schema — validates input AND generates the JSON schema the model sees.
  // Always add .describe() to each field; the model reads these.
  parameters: z.object({
    customerId: z.string().describe("The customer's unique ID"),
    limit: z.number().int().min(1).max(50).default(5)
      .describe("How many recent invoices to return"),
  }),

  // The implementation. Receives validated, typed input.
  // ctx.userId is the authenticated user; use it to scope queries.
  async execute({ customerId, limit }, ctx) {
    // Validate the user has permission to access this customer
    if (!await userOwnsCustomer(ctx.userId!, customerId)) {
      throw new Error("Access denied");
    }
    return fetchInvoices(customerId, { limit });
  },
});
```

Once registered, the tool is:
- Available to any agent that lists `"my_tool"` in its `tools` array
- Automatically exposed via the MCP server at `/api/mcp`
- Type-safe end-to-end

---

## Tool categories and file organization

Organize tools by domain, not by type:

```
src/agents/tools/
├── registry.ts              # registerTool / getAllTools / getTools
├── types.ts                 # ToolDefinition, ToolContext
├── index.ts                 # imports all tools (triggers registration)
│
├── web/                     # built-in: search + browser
│   ├── tavily.ts
│   └── browser.ts
│
├── sandbox/                 # built-in: code execution
│   ├── daytona.ts
│   └── modal.ts
│
├── composio/                # built-in: 3rd-party OAuth tools
│   └── index.ts
│
├── crm/                     # ← your domain tools
│   ├── contacts.ts
│   ├── deals.ts
│   └── emails.ts
│
├── billing/
│   ├── invoices.ts
│   └── subscriptions.ts
│
└── notifications/
    └── slack.ts
```

---

## Common tool patterns

### Read-only data tool

Best for: fetching records, searching data, generating reports.

```typescript
export const searchContactsTool = registerTool({
  name: "crm_search_contacts",
  description: "Search CRM contacts by name, email, or company. Returns matching contacts with their status and last activity.",
  parameters: z.object({
    query: z.string().describe("Search term — matches name, email, or company name"),
    status: z.enum(["active", "inactive", "prospect"]).optional()
      .describe("Filter by contact status"),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  async execute({ query, status, limit }, ctx) {
    return db.contacts.search({
      orgId: await getUserOrgId(ctx.userId!),
      query,
      status,
      limit,
    });
  },
});
```

### Write / mutation tool

Best for: creating records, sending messages, updating state.

```typescript
export const createContactTool = registerTool({
  name: "crm_create_contact",
  description: "Create a new CRM contact. Use only when the user explicitly asks to add or create a contact.",
  parameters: z.object({
    name: z.string().describe("Full name"),
    email: z.string().email().describe("Email address"),
    company: z.string().optional().describe("Company name"),
    notes: z.string().optional().describe("Initial notes about this contact"),
  }),
  async execute(params, ctx) {
    const orgId = await getUserOrgId(ctx.userId!);
    const contact = await db.contacts.create({ ...params, orgId, createdBy: ctx.userId! });
    return { success: true, contactId: contact.id, message: `Created contact: ${params.name}` };
  },
});
```

> **Note on mutations**: be explicit in the description that this tool creates/modifies data ("Use only when..."). This prevents the model from making unintended writes.

### External API tool

Best for: sending emails, posting to Slack, calling third-party APIs.

```typescript
export const sendEmailTool = registerTool({
  name: "send_email",
  description: "Send a transactional email to a contact. Use only when the user explicitly requests sending an email.",
  parameters: z.object({
    to: z.string().email().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body in plain text or HTML"),
  }),
  async execute({ to, subject, body }, ctx) {
    await resend.emails.send({
      from: "assistant@yourapp.com",
      to,
      subject,
      html: body,
    });
    return { sent: true, to, subject };
  },
});
```

### Aggregation / calculation tool

Best for: generating summaries, running analytics, producing reports.

```typescript
export const getRevenueReportTool = registerTool({
  name: "get_revenue_report",
  description: "Calculate revenue metrics for a given time period. Returns MRR, ARR, churn rate, and top customers.",
  parameters: z.object({
    period: z.enum(["last_7_days", "last_30_days", "last_90_days", "this_year"]),
    breakdown: z.enum(["daily", "weekly", "monthly"]).default("monthly"),
  }),
  async execute({ period, breakdown }, ctx) {
    const orgId = await getUserOrgId(ctx.userId!);
    const startDate = periodToDate(period);
    return analytics.revenueReport({ orgId, startDate, breakdown });
  },
});
```

### Multi-step tool (tool that calls other tools)

Sometimes a tool should do several things atomically. Use this for complex operations that shouldn't be interrupted:

```typescript
export const onboardCustomerTool = registerTool({
  name: "onboard_customer",
  description: "Complete full customer onboarding: create account, send welcome email, assign to CSM. Use when user asks to onboard or set up a new customer.",
  parameters: z.object({
    name: z.string(),
    email: z.string().email(),
    plan: z.enum(["starter", "growth", "enterprise"]),
  }),
  async execute({ name, email, plan }, ctx) {
    // Step 1: Create account
    const account = await AccountService.create({ name, email, plan });

    // Step 2: Send welcome email
    await EmailService.sendWelcome({ to: email, name, plan });

    // Step 3: Assign CSM
    const csm = await CSMService.assignNext({ accountId: account.id, plan });

    return {
      accountId: account.id,
      csmName: csm.name,
      message: `Onboarded ${name}. Assigned to CSM: ${csm.name}. Welcome email sent.`,
    };
  },
});
```

---

## Tool output format

Return plain objects or strings. The model can read and reason over any JSON-serializable structure.

**Good** — structured, informative:
```typescript
return {
  contacts: [...],
  total: 42,
  hasMore: true,
};
```

**Also good** — a natural language summary with key data:
```typescript
return `Found 3 contacts matching "acme": John Doe (john@acme.com), Jane Smith (jane@acme.com), Bob Jones (bob@acme.com).`;
```

**Avoid** — raw database rows with internal fields:
```typescript
// Don't return this — the model will get confused by internal DB fields
return await db.query("SELECT * FROM contacts WHERE ...");
```

---

## Tool permissions and authorization

Always authorize inside the tool itself. Do not assume the caller has checked permissions:

```typescript
async execute({ contactId }, ctx) {
  // 1. Check the user is authenticated
  if (!ctx.userId) throw new Error("Authentication required");

  // 2. Check the user owns this resource
  const contact = await db.contacts.findById(contactId);
  if (!contact) throw new Error("Contact not found");
  if (contact.orgId !== await getUserOrgId(ctx.userId)) {
    throw new Error("Access denied");
  }

  // 3. Proceed
  return contact;
},
```

---

## Adding tools to the registry

Every tool file imports `registerTool`, which auto-registers on module load. You just need to ensure the module is imported at startup.

In `src/agents/tools/index.ts`, add your tool files:

```typescript
// Built-in tools (already there)
export * from "./web/tavily";
export * from "./web/browser";

// Your domain tools — add these:
export * from "./crm/contacts";
export * from "./crm/deals";
export * from "./billing/invoices";
export * from "./notifications/slack";
```

The instrumentation hook in `src/instrumentation.ts` imports `@/agents/tools/index` on startup, which triggers all registrations.

---

## Testing tools in isolation

Test tools outside of any agent:

```typescript
// tools/crm/contacts.test.ts
import { searchContactsTool } from "./contacts";

test("returns contacts for valid query", async () => {
  const result = await searchContactsTool.execute(
    { query: "acme", limit: 5 },
    { userId: "test-user-id" }
  );
  expect(result.contacts.length).toBeGreaterThan(0);
});
```

This is much faster than running a full agent loop during development.

---

## Real-world examples

See the `examples/` directory for complete tool sets for common SaaS domains:
- [`examples/crm/`](../examples/crm/) — contacts, deals, emails, pipeline management
- [`examples/ecommerce/`](../examples/ecommerce/) — orders, products, customers, inventory
- [`examples/devtools/`](../examples/devtools/) — repositories, issues, CI runs, deployments
