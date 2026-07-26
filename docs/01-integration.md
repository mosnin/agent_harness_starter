# 01 — Integrating into Your Existing SaaS

This guide walks you through dropping the agent infrastructure into an already-running Next.js SaaS. You do **not** start a new project. You copy a folder structure into yours.

---

## Prerequisites

- Next.js 14 or 15 (App Router)
- TypeScript
- Node.js ≥ 20

---

## What you're copying

The repo is organized as a set of self-contained modules. Each folder maps to a directory you create inside your existing project:

```
This repo                       → Your project
─────────────────────────────────────────────────
src/agents/                     → src/agents/
src/tools/                      → src/agents/tools/     (or src/tools/)
src/mcp/                        → src/agents/mcp/
src/db/                         → src/agents/db/
src/auth/                       → src/agents/auth/
src/lib/                        → src/agents/lib/       (or merge with your existing lib/)
routes/agent/route.ts           → src/app/api/agent/route.ts
routes/mcp/route.ts             → src/app/api/mcp/route.ts
routes/threads/route.ts         → src/app/api/threads/route.ts
components/AgentChat/           → src/components/AgentChat/
components/AgentStatus/         → src/components/AgentStatus/
```

> **Convention**: this guide uses `src/agents/` as the root namespace for all agent infrastructure. This keeps it isolated from your existing code and easy to find. Adjust to your preference.

---

## Step 1 — Copy the modules

```bash
# From the root of your existing project:
cp -r path/to/agent_harness_starter/src/agents  src/agents
cp -r path/to/agent_harness_starter/src/tools   src/agents/tools
cp -r path/to/agent_harness_starter/src/mcp     src/agents/mcp
cp -r path/to/agent_harness_starter/src/db      src/agents/db
cp -r path/to/agent_harness_starter/src/auth    src/agents/auth
cp -r path/to/agent_harness_starter/src/lib     src/agents/lib

# API routes
mkdir -p src/app/api/agent src/app/api/mcp src/app/api/threads
cp path/to/agent_harness_starter/routes/agent/route.ts   src/app/api/agent/route.ts
cp path/to/agent_harness_starter/routes/mcp/route.ts     src/app/api/mcp/route.ts
cp path/to/agent_harness_starter/routes/threads/route.ts src/app/api/threads/route.ts

# UI components (optional — build your own if preferred)
cp -r path/to/agent_harness_starter/components/AgentChat   src/components/AgentChat
cp -r path/to/agent_harness_starter/components/AgentStatus src/components/AgentStatus
```

---

## Step 2 — Install dependencies

Add to your existing `package.json`. Only install what you plan to use.

```bash
# Always required
npm install @openai/agents zod@^4 @modelcontextprotocol/sdk

# Web search
npm install @tavily/core

# Parallel browser sessions (pick one)
npm install @browserbasehq/sdk playwright-core

# Composio (3rd-party OAuth tools)
npm install composio-core

# Sandbox execution (pick one)
npm install @daytonaio/sdk
# or
npm install modal

# Auth adapters (whichever you use)
npm install @clerk/nextjs
# or
npm install @auth0/nextjs-auth0

# DB adapters (whichever you use — likely already installed)
npm install @supabase/supabase-js
# or
npm install convex
# or
npm install @prisma/client prisma
```

**Zod version note**: `@openai/agents` requires Zod v4. `composio-core` uses Zod v3 internally. Add this to your `package.json` to resolve the conflict without breaking either:

```json
"overrides": {
  "composio-core>zod": "^3.24.0"
}
```

---

## Step 3 — Add environment variables

Copy the relevant sections from `.env.example` into your existing `.env.local`:

```bash
# Minimum required
OPENAI_API_KEY=sk-...

# DB + auth (match your existing providers — see docs/02-connecting-your-app.md)
DB_PROVIDER=supabase
AUTH_PROVIDER=clerk
```

Full reference: [`.env.example`](../.env.example)

---

## Step 4 — Fix import paths

Every file uses `@/agents/...` for agent infrastructure imports. You need to make sure TypeScript resolves `@/` to your project's `src/` directory.

Check your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

If your project already has this set up, you're done. If your alias is different (e.g., `~/*`), do a project-wide find-and-replace:

```bash
find src/agents -type f -name "*.ts" -exec sed -i 's|@/agents/|~/agents/|g' {} +
```

---

## Step 5 — Wire to your existing auth and DB

The copied modules include adapters for common providers, but they need to know about your existing setup. See **[02 — Connecting Your App](./02-connecting-your-app.md)** for the full walkthrough.

Quick version:
- Set `AUTH_PROVIDER=clerk` if you're already using Clerk — nothing else to change.
- Set `DB_PROVIDER=supabase` and run the SQL migration in `supabase/migrations/001_agent_tables.sql`.

---

## Step 6 — Run the agent SQL migration (if using Supabase)

```sql
-- Run in your Supabase SQL editor
-- File: supabase/migrations/001_agent_tables.sql
```

For Prisma: add the models from `prisma/schema.prisma` into your existing schema file, then run `npx prisma db push`.

For Convex: copy `convex/schema.ts` additions into your schema and run `npx convex dev`.

---

## Step 7 — Add the instrumentation hook

In your project's `src/instrumentation.ts` (create it if it doesn't exist):

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Initialize all agent tools on startup
  await import("@/agents/tools/index");

  // Validate agent config
  const { config } = await import("@/agents/lib/config");
  if (!config.openai.apiKey) {
    console.warn("[agents] OPENAI_API_KEY not set — agents will fail");
  }
}
```

---

## Step 8 — Add your first agentic feature

Add a chat panel to any existing page:

```tsx
// In any client component in your existing app:
import { AgentChat } from "@/components/AgentChat";

export default function MyFeaturePage() {
  return (
    <div className="my-existing-layout">
      {/* ... your existing UI ... */}

      {/* Add this wherever you want the agent panel */}
      <AgentChat
        agentName="research"
        placeholder="Ask me anything about your data..."
      />
    </div>
  );
}
```

---

## Verification checklist

- [ ] `npm run build` succeeds (no TypeScript errors)
- [ ] `GET /api/mcp` returns `{ "name": "...", "transport": "streamable-http" }`
- [ ] `POST /api/agent` with `{ "message": "hello" }` returns an SSE stream
- [ ] `npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp` lists your tools

---

## What to do next

| Goal | Guide |
|---|---|
| Wire to your existing auth (Clerk, Auth0, NextAuth, etc.) | [02 — Connecting Your App](./02-connecting-your-app.md) |
| Build tools specific to your product | [03 — Building Tools](./03-building-tools.md) |
| Connect external APIs and MCP servers | [04 — APIs and MCPs](./04-apis-and-mcps.md) |
| Tune models, prompts, temperature | [05 — Model Configuration](./05-model-configuration.md) |
| Multi-agent systems, handoffs, custom harness | [06 — Harness and Orchestration](./06-harness-orchestration.md) |
| Ship to production (Vercel, Railway, Docker) | [07 — Deployment](./07-deployment.md) |
