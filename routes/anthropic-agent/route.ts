/**
 * DROP THIS FILE INTO: your-app/src/app/api/anthropic-agent/route.ts
 *
 * Anthropic Managed Agents invocation endpoint.
 * Streams events back as SSE — same event format as the OpenAI agent route.
 *
 * Prerequisites:
 *   1. Create an agent at https://platform.claude.com/agents
 *      and set ANTHROPIC_AGENT_ID=<id>
 *   2. Create an environment at https://platform.claude.com/environments
 *      and set ANTHROPIC_ENVIRONMENT_ID=<id>
 *   3. Set ANTHROPIC_API_KEY
 *
 * Request body:
 *   {
 *     message:      string            // the user's message
 *     threadId?:    string            // existing thread (creates new if omitted)
 *     sessionId?:   string            // reuse an existing Anthropic session
 *     vaultIds?:    string[]          // Anthropic vaults for MCP OAuth credentials
 *   }
 *
 * Response: text/event-stream (same AgentEvent format as /api/agent)
 *
 * The Anthropic Managed Agent handles all tooling server-side (Bash, files,
 * web search). No tool registry needed.
 */

import { z } from "zod";
import { auth } from "@/agents/auth";
import { db } from "@/agents/db";
import { sseStream } from "@/agents/lib/utils";
import { createAnthropicHarness } from "@/agents/providers/anthropic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().min(1).max(32_000),
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
  vaultIds: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  try {
    const user = await auth.requireAuth(req);

    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: parsed.error.flatten() }, { status: 422 });
    }

    const { message, threadId, sessionId, vaultIds } = parsed.data;

    const thread = threadId
      ? await db.getThread(threadId)
      : await db.createThread(user.id);

    if (!thread) {
      return Response.json({ error: "Thread not found" }, { status: 404 });
    }

    const resolvedThreadId = thread.id;

    await db.saveMessage({ threadId: resolvedThreadId, role: "user", content: message });

    const run = await db.createRun({
      threadId: resolvedThreadId,
      status: "running",
      agentName: "AnthropicManagedAgent",
    });

    const harness = createAnthropicHarness({
      sessionId,
      vaultIds,
      signal: req.signal,
    });

    async function* eventGenerator() {
      let finalOutput = "";
      try {
        const stream = harness.stream({
          messages: [{ role: "user", content: message }],
          context: { userId: user.id },
          signal: req.signal,
        });

        for await (const event of stream) {
          yield JSON.stringify({
            threadId: resolvedThreadId,
            runId: run.id,
            sessionId: harness.getSessionId(),
            ...event,
          });
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

    const currentSessionId = harness.getSessionId();

    return new Response(sseStream(eventGenerator()), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Thread-Id": resolvedThreadId,
        "X-Run-Id": run.id,
        ...(currentSessionId ? { "X-Session-Id": currentSessionId } : {}),
      },
    });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[/api/anthropic-agent]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** GET /api/anthropic-agent?threadId=xxx */
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
