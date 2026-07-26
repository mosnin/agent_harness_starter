# Notion-Style Example — Making a Document App Agentic

This example shows exactly how to wire the agent infrastructure into an existing
document workspace application. It is the integration seam — the part most teams
get stuck on.

Everything in this folder is a stub. The tool contracts (names, parameters, return
shapes) are fixed — they are what the agent understands. The `execute` bodies are
yours to replace with real service calls.

---

## What's here

```
notion-style/
  tools/
    pages.ts         ← CRUD on workspace pages (get, list, create, update, delete)
    search.ts        ← Full-text and semantic search across documents
    blocks.ts        ← Block-level content manipulation (append, update, get)
  agents/
    editor.ts        ← Creates and edits documents; supervised, memory-enabled
    search.ts        ← Read-only discovery agent; runs autonomously
  workflow/
    publish-pipeline.ts  ← Research → Draft → Review → Create page
  index.ts           ← Barrel: import this to register everything
  README.md          ← This file
```

---

## Step 1 — Replace the stubs with your service layer

Each tool has a comment showing exactly what to replace:

```typescript
// tools/pages.ts — before (stub)
execute: async ({ pageId }, ctx) => {
  void ctx;
  return { id: pageId, title: "Stub page..." };
},

// tools/pages.ts — after (your real code)
execute: async ({ pageId }, ctx) => {
  return await db.page.findUniqueOrThrow({
    where: { id: pageId, userId: ctx.userId },
  });
},
```

The `ctx.userId` is automatically populated from your auth session — see
[02-connecting-your-app.md](../../../../../docs/02-connecting-your-app.md).

---

## Step 2 — Wire up the agent route

In your Next.js app, add a route that uses one of these agents:

```typescript
// src/app/api/agent/route.ts
import { NextRequest } from "next/server";
import { editorAgent } from "@/agents/examples/notion-style/agents/editor";
import { getSession } from "@/lib/auth"; // your existing auth

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  const { message, pageId } = await req.json();

  const stream = editorAgent.run({
    message,
    context: {
      userId: session.userId,
      orgId: session.orgId,
      currentPageId: pageId,   // pass any extra context your agent needs
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
```

---

## Step 3 — Run the publish pipeline

The pipeline chains three agents: researcher → drafter → reviewer.

```typescript
import { runPublishPipeline } from "@/agents/examples/notion-style/workflow/publish-pipeline";

// In a background job, cron, or API route:
const { title, content, tags } = await runPublishPipeline(
  "How to build a multiplayer real-time editor",
  { userId: session.userId }
);

// Then create the page using your existing service layer
await db.page.create({ data: { title, content, tags, userId: session.userId } });
```

---

## What each agent does

### `editorAgent`
- **Role:** Tooling — writes and structures documents
- **Memory:** User-scoped, 30-day TTL, semantic retrieval — remembers user preferences
- **Governance:** `notion_delete_page` requires human approval (set `requiresApproval: true` on the tool)
- **Autonomy:** Supervised — pauses for approval on destructive actions
- **Skills:** `page-management` (all page + block tools)

### `searchAgent`
- **Role:** Retrieval — read-only discovery
- **Memory:** User-scoped, 7-day TTL
- **Autonomy:** Full — no approval gates needed (read-only)
- **Skills:** `workspace-search` (search + get tools only)

---

## Customizing for your domain

### Add domain-specific tools

```typescript
// tools/comments.ts
import { registerTool } from "@/agents/tools/registry";

registerTool({
  name: "notion_add_comment",
  description: "Add a comment to a page.",
  parameters: z.object({ pageId: z.string(), text: z.string() }),
  execute: async ({ pageId, text }, ctx) => {
    return await db.comment.create({ data: { pageId, text, userId: ctx.userId } });
  },
});
```

### Add tools to the editor's skill

```typescript
// In agents/editor.ts, update the skill registration:
defineSkill({
  name: "page-management",
  tools: [
    ...existingTools,
    "notion_add_comment",
    "notion_get_comments",
  ],
});
```

### Swap memory backends

```bash
# .env.local
MEMORY_PROVIDER=pgvector   # uses your existing Postgres + pgvector
DATABASE_URL=postgresql://...
```

### Add your own governance rules

```typescript
// In agents/editor.ts, extend withGovernance:
import { blockTools, createGovernancePolicy } from "@/agents/governance";

const domainPolicy = createGovernancePolicy({
  name: "workspace-policy",
  rules: [
    blockTools(["notion_delete_page"]),   // belt and suspenders
    {
      id: "no-bulk-delete",
      description: "Cannot delete more than 1 page per agent turn.",
      risk: "high",
      blocking: true,
      check: (ctx) => (ctx.metadata?.deletesThisTurn as number ?? 0) > 1,
    },
  ],
});
```

---

## Files to replace when moving to production

| File | What to replace | With |
|------|----------------|------|
| `tools/pages.ts` | Stub `execute` bodies | Your Prisma/Supabase calls |
| `tools/search.ts` | Stub search bodies | Postgres FTS, Algolia, Typesense |
| `tools/blocks.ts` | Stub block bodies | Your block storage layer |
| `agents/editor.ts` | `instructions` string | Your app's actual UX copy |
| `workflow/publish-pipeline.ts` | Step agents | Agents tuned for your content domain |
