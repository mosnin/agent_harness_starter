# 02 — Connecting to Your Existing App

The agent infrastructure is designed to plug into whatever auth and database your SaaS already uses — not replace them. This guide covers every connection point.

---

## Connecting your existing auth

The `AuthAdapter` interface has two methods:

```typescript
interface AuthAdapter {
  getUser(req: Request): Promise<AuthUser | null>;
  requireAuth(req: Request): Promise<AuthUser>;   // throws 401 if not authenticated
}
```

### You already use Clerk

Set `AUTH_PROVIDER=clerk` — done. The Clerk adapter (`src/agents/auth/clerk.ts`) reads your existing Clerk session automatically.

### You already use Auth0

Set `AUTH_PROVIDER=auth0` — done.

### You already use NextAuth / Auth.js

Create a custom adapter at `src/agents/auth/nextauth.ts`:

```typescript
import type { AuthAdapter, AuthUser } from "./types";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";   // ← your existing NextAuth config

export const nextAuthAdapter: AuthAdapter = {
  async getUser(req) {
    const session = await getServerSession(authOptions);
    if (!session?.user) return null;
    return {
      id: session.user.id ?? session.user.email ?? "",
      email: session.user.email ?? "",
      name: session.user.name ?? undefined,
      imageUrl: session.user.image ?? undefined,
    };
  },

  async requireAuth(req) {
    const user = await this.getUser(req);
    if (!user) {
      throw new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return user;
  },
};
```

Then register it in `src/agents/auth/index.ts`:

```typescript
// In the createAdapter() switch:
case "nextauth": {
  const { nextAuthAdapter } = require("./nextauth");
  return nextAuthAdapter;
}
```

And set `AUTH_PROVIDER=nextauth`.

### You already use Supabase Auth

```typescript
import type { AuthAdapter } from "./types";
import { createClient } from "@supabase/supabase-js";

export const supabaseAuthAdapter: AuthAdapter = {
  async getUser(req) {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) return null;

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;

    return {
      id: user.id,
      email: user.email ?? "",
      metadata: user.user_metadata,
    };
  },

  async requireAuth(req) {
    const user = await this.getUser(req);
    if (!user) throw new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    return user;
  },
};
```

### You use a custom JWT / session system

Implement the same two-method interface using your existing session lookup. The key is that `requireAuth` must throw a `Response` (not an `Error`) so the route handler can re-throw it as an HTTP response.

---

## Connecting your existing database

The `DbAdapter` interface stores agent threads, messages, and run history alongside your existing data:

```typescript
interface DbAdapter {
  createThread(userId: string, title?: string): Promise<AgentThread>;
  getThread(threadId: string): Promise<AgentThread | null>;
  listThreads(userId: string): Promise<AgentThread[]>;
  deleteThread(threadId: string): Promise<void>;
  saveMessage(msg: Omit<AgentMessage, "id" | "createdAt">): Promise<AgentMessage>;
  getMessages(threadId: string): Promise<AgentMessage[]>;
  createRun(run: Omit<AgentRun, "id" | "startedAt">): Promise<AgentRun>;
  updateRun(runId: string, update: Partial<AgentRun>): Promise<AgentRun>;
  getRun(runId: string): Promise<AgentRun | null>;
}
```

### You already use Supabase

Set `DB_PROVIDER=supabase` and run the migration:

```bash
# In Supabase Studio or via CLI:
supabase db push  # if using migrations
# or paste supabase/migrations/001_agent_tables.sql into the SQL editor
```

The three new tables (`agent_threads`, `agent_messages`, `agent_runs`) live alongside your existing tables. They use the same Supabase project.

### You already use Prisma

Add the three models from `prisma/schema.prisma` to **your existing** schema file:

```prisma
// Paste these into your existing schema.prisma
model AgentThread {
  id        String   @id @default(cuid())
  userId    String
  title     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  messages  AgentMessage[]
  runs      AgentRun[]
  @@index([userId])
  @@map("agent_threads")
}

model AgentMessage {
  id         String   @id @default(cuid())
  threadId   String
  role       String
  content    String   @db.Text
  toolCallId String?
  toolName   String?
  createdAt  DateTime @default(now())
  thread     AgentThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  @@index([threadId])
  @@map("agent_messages")
}

model AgentRun {
  id          String    @id @default(cuid())
  threadId    String
  agentName   String
  status      String
  startedAt   DateTime  @default(now())
  completedAt DateTime?
  error       String?
  metadata    String?   @db.Text
  thread      AgentThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  @@index([threadId])
  @@map("agent_runs")
}
```

```bash
npx prisma db push
```

The Prisma adapter reuses your existing `PrismaClient` singleton — no new DB connection.

### You already use Convex

Copy the table definitions from `convex/schema.ts` into your existing Convex schema. Copy `convex/threads.ts`, `convex/messages.ts` to your `convex/` directory. Run `npx convex dev`.

### You use a completely different database (MongoDB, DynamoDB, etc.)

Implement the `DbAdapter` interface directly:

```typescript
// src/agents/db/mongodb.ts
import type { DbAdapter, AgentThread } from "./types";

export const mongoAdapter: DbAdapter = {
  async createThread(userId, title) {
    const doc = await db.collection("agent_threads").insertOne({
      userId, title, createdAt: new Date(), updatedAt: new Date()
    });
    return { id: doc.insertedId.toString(), userId, title, createdAt: new Date(), updatedAt: new Date() };
  },
  // ... implement the remaining 8 methods
};
```

Then add a `case "mongodb"` to `src/agents/db/index.ts` and set `DB_PROVIDER=mongodb`.

---

## Passing your existing user data to tools

Tools receive a `ToolContext` with the authenticated user's ID. Use this to scope data access to the current user:

```typescript
// src/agents/tools/my-tool.ts
import { registerTool } from "../registry";
import { z } from "zod";
import { db } from "@/lib/db";   // ← your existing app's DB client

export const getUserDataTool = registerTool({
  name: "get_user_data",
  description: "Fetch data for the current user",
  parameters: z.object({
    dataType: z.enum(["orders", "profile", "billing"]),
  }),
  async execute({ dataType }, ctx) {
    // ctx.userId is the authenticated user from your auth adapter
    const userId = ctx.userId!;

    // Query YOUR existing database using the authenticated user's ID
    return db.query(`SELECT * FROM ${dataType} WHERE user_id = $1`, [userId]);
  },
});
```

**Key principle**: `ctx.userId` is the user ID from your auth adapter — the same ID that exists in your existing database. No separate user table needed.

---

## Sharing your existing Prisma client

If you already have a Prisma client at `src/lib/prisma.ts`, use it in the agent DB adapter instead of creating a new one:

```typescript
// src/agents/db/prisma/client.ts
// Replace the getPrismaClient() function with:
import { prisma } from "@/lib/prisma";  // ← your existing Prisma singleton
function getPrismaClient() { return prisma; }
```

---

## Protecting agent routes with your existing middleware

If you use Next.js middleware for auth, add the agent routes to your matcher:

```typescript
// middleware.ts (your existing file)
export const config = {
  matcher: [
    // ... your existing protected routes ...
    "/api/agent/:path*",
    "/api/threads/:path*",
    // Leave /api/mcp unprotected if you want external MCP client access,
    // or add a Bearer token check in routes/mcp/route.ts
  ],
};
```

---

## Accessing your existing business logic from agents

Agents work best when they can read and write your actual application data. Expose your existing service layer as tools:

```typescript
// src/agents/tools/crm/deals.ts
import { registerTool } from "../../registry";
import { z } from "zod";
import { DealService } from "@/services/deals";   // ← your existing service

export const createDealTool = registerTool({
  name: "crm_create_deal",
  description: "Create a new CRM deal for the current user's organization",
  parameters: z.object({
    title: z.string(),
    value: z.number(),
    contactId: z.string(),
    stage: z.enum(["lead", "qualified", "proposal", "closed"]),
  }),
  async execute(params, ctx) {
    // DealService uses your existing auth and DB context
    return DealService.create({ ...params, userId: ctx.userId! });
  },
});
```

This is the core pattern: **your existing services become agent tools**. The agent can then compose these tools to perform multi-step workflows that would normally require a human clicking through your UI.
