/**
 * POST /api/agent
 *
 * Main agent invocation endpoint. Streams events back as SSE.
 *
 * Request body:
 *   {
 *     message: string          // The user's message
 *     threadId?: string        // Existing thread ID (creates new one if omitted)
 *     agentName?: string       // Which agent to use (default: "research")
 *     tools?: string[]         // Tool names to enable (default: all registered)
 *   }
 *
 * Response: text/event-stream
 *   Each event: data: <json>\n\n
 *   Event types: message_delta, message_done, tool_call, tool_result, handoff, error, done
 */

import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/db";
import { sseStream } from "@/lib/utils";
import { createHarness } from "@/agents/harness";
import { researchAgentConfig } from "@/agents/examples/research-agent";
import { codeAgentConfig } from "@/agents/examples/code-agent";
import type { AgentConfig } from "@/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().min(1).max(32_000),
  threadId: z.string().optional(),
  agentName: z.enum(["research", "code", "orchestrated"]).default("research"),
  tools: z.array(z.string()).optional(),
});

const agentMap: Record<string, AgentConfig> = {
  research: researchAgentConfig,
  code: codeAgentConfig,
};

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

    // Ensure a thread exists
    const thread = threadId
      ? await db.getThread(threadId)
      : await db.createThread(user.id);

    if (!thread) {
      return Response.json({ error: "Thread not found" }, { status: 404 });
    }

    // Persist the user message
    await db.saveMessage({ threadId: thread.id, role: "user", content: message });

    // Create the agent run record
    const run = await db.createRun({
      threadId: thread.id,
      status: "running",
      agentName,
    });

    const agentConfig = agentMap[agentName] ?? researchAgentConfig;
    const effectiveConfig = tools ? { ...agentConfig, tools } : agentConfig;
    const harness = createHarness(effectiveConfig);

    async function* eventGenerator() {
      let finalOutput = "";
      try {
        const stream = harness.stream({
          messages: [{ role: "user", content: message }],
          context: { userId: user.id, request: req, signal: req.signal },
          signal: req.signal,
        });

        for await (const event of stream) {
          yield JSON.stringify({ threadId: thread.id, runId: run.id, ...event });

          if (event.type === "message_done") {
            finalOutput = event.content;
          }
          if (event.type === "done") {
            finalOutput = event.finalOutput;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield JSON.stringify({ type: "error", error: msg });
        await db.updateRun(run.id, { status: "failed", error: msg, completedAt: new Date() });
        return;
      }

      // Persist the assistant response
      if (finalOutput) {
        await db.saveMessage({ threadId: thread.id, role: "assistant", content: finalOutput });
      }

      await db.updateRun(run.id, { status: "completed", completedAt: new Date() });
    }

    return new Response(sseStream(eventGenerator()), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Thread-Id": thread.id,
        "X-Run-Id": run.id,
      },
    });
  } catch (err) {
    // If auth threw a Response, re-throw it
    if (err instanceof Response) throw err;
    console.error("[/api/agent]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** GET /api/agent?threadId=xxx — list messages for a thread */
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
