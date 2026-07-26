/**
 * DROP THIS FILE INTO: your-app/src/app/api/agent/route.ts
 *
 * Main agent invocation endpoint. Streams events back as SSE.
 *
 * Request body:
 *   {
 *     message:    string            // the user's message
 *     threadId?:  string            // existing thread (creates new one if omitted)
 *     agentName?: string            // which agent to use (default: "research")
 *     tools?:     string[]          // additional tool names to enable for this run
 *   }
 *
 * Response: text/event-stream
 *   data: {"type":"message_delta","delta":"..."}
 *   data: {"type":"tool_call","name":"web_search","input":{...}}
 *   data: {"type":"tool_result","name":"web_search","output":{...}}
 *   data: {"type":"done","finalOutput":"..."}
 *
 * Adding a new agent:
 *   1. Create your agent file and call registerAgent("name", config) at the bottom.
 *   2. Add an import to src/agents/examples/index.ts (or your own barrel).
 *   No edits to this route file are needed.
 *
 * See docs/02-connecting-your-app.md for wiring to your existing auth and DB.
 * See docs/12-plugin-architecture.md for the plugin system.
 */

import { z } from "zod";
import { auth } from "@/agents/auth";
import { db } from "@/agents/db";
import { sseStream } from "@/agents/lib/utils";
import { createCustomHarness } from "@/agents/core";
import { getAgentConfig, getAllAgentNames } from "@/agents/agent-registry";

// ── Agent registration ─────────────────────────────────────────────────────────
// Importing this barrel causes each agent file to call registerAgent() once.
// Add your own agents to src/agents/examples/index.ts or import a second barrel.
import "@/agents/examples";
// import "@/agents/your-agents";
// ──────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().min(1).max(32_000),
  threadId: z.string().optional(),
  agentName: z.string().default("research"),
  tools: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  try {
    const user = await auth.requireAuth(req);

    const body = await req.json().catch(() => {
      throw new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
    });

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: parsed.error.flatten() }, { status: 422 });
    }

    const { message, threadId, agentName, tools } = parsed.data;

    const agentConfig = getAgentConfig(agentName);
    if (!agentConfig) {
      return Response.json(
        {
          error: `Unknown agent: "${agentName}"`,
          available: getAllAgentNames(),
        },
        { status: 400 }
      );
    }

    const thread = threadId
      ? await db.getThread(threadId)
      : await db.createThread(user.id);

    if (!thread) {
      return Response.json({ error: "Thread not found" }, { status: 404 });
    }

    const resolvedThreadId = thread.id;

    await db.saveMessage({ threadId: resolvedThreadId, role: "user", content: message });

    const run = await db.createRun({ threadId: resolvedThreadId, status: "running", agentName });

    // Merge any extra tool names requested for this run
    const effectiveConfig = tools?.length
      ? { ...agentConfig, tools: [...(agentConfig.tools ?? []), ...tools] }
      : agentConfig;

    const harness = createCustomHarness(effectiveConfig);

    async function* eventGenerator() {
      let finalOutput = "";
      try {
        const stream = harness.stream({
          messages: [{ role: "user", content: message }],
          context: { userId: user.id, request: req, signal: req.signal },
          signal: req.signal,
        });

        for await (const event of stream) {
          yield JSON.stringify({ threadId: resolvedThreadId, runId: run.id, ...event });
          if (event.type === "message_done") finalOutput = event.content;
          if (event.type === "done") finalOutput = event.finalOutput;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield JSON.stringify({ type: "error", error: msg });
        await db.updateRun(run.id, { status: "failed", error: msg, completedAt: new Date() });
        return;
      }

      if (finalOutput) {
        await db.saveMessage({ threadId: resolvedThreadId, role: "assistant", content: finalOutput });
      }
      await db.updateRun(run.id, { status: "completed", completedAt: new Date() });
    }

    return new Response(sseStream(eventGenerator()), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Thread-Id": resolvedThreadId,
        "X-Run-Id": run.id,
      },
    });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[/api/agent]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** GET /api/agent?threadId=xxx — fetch messages for a thread */
export async function GET(req: Request) {
  const user = await auth.requireAuth(req);
  const { searchParams } = new URL(req.url);
  const threadId = searchParams.get("threadId");

  if (!threadId) {
    const threads = await db.listThreads(user.id);
    return Response.json({ threads });
  }

  const thread = await db.getThread(threadId);
  if (!thread || thread.userId !== user.id) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }

  const messages = await db.getMessages(threadId);
  return Response.json({ thread, messages });
}
