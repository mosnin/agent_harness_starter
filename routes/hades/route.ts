/**
 * DROP THIS FILE INTO: your-app/src/app/api/hades/route.ts
 *
 * Jev-powered Hades endpoint. Same SSE contract as /api/agent, but
 * routing, Auto Mode, and screens run through TypeSafe Jev. Generation
 * uses Qwen via OpenRouter.
 */

import { z } from "zod";
import { auth } from "@/agents/auth";
import { db } from "@/agents/db";
import { sseStream } from "@/agents/lib/utils";
import { createHadesHarness } from "@/agents/hades/index";
import { redactSecrets } from "@/agents/jev/redact";
import { isThreadOwner, messagesForHarness } from "@/agents/lib/thread-history";
import { getAgentConfig, getAllAgentNames } from "@/agents/agent-registry";
import "@/agents/examples";

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
      return Response.json({ error: `Unknown agent: "${agentName}"`, available: getAllAgentNames() }, { status: 400 });
    }

    const thread = threadId ? await db.getThread(threadId, user.id) : await db.createThread(user.id);
    if (!isThreadOwner(thread, user.id)) {
      return Response.json({ error: "Thread not found" }, { status: 404 });
    }
    const resolvedThreadId = thread.id;

    await db.saveMessage({ threadId: resolvedThreadId, role: "user", content: redactSecrets(message).text }, user.id);
    const history = messagesForHarness(await db.getMessages(resolvedThreadId, user.id));
    const run = await db.createRun({ threadId: resolvedThreadId, status: "running", agentName }, user.id);

    const harness = createHadesHarness({
      ...agentConfig,
      tools: tools?.length ? [...(agentConfig.tools ?? []), ...tools] : agentConfig.tools,
    });

    async function* eventGenerator() {
      let finalOutput = "";
      try {
        const stream = harness.stream({
          messages: history.length > 0 ? history : [{ role: "user", content: message }],
          context: { userId: user.id, request: req, lastUserMessage: message },
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
        await db.updateRun(run.id, { status: "failed", error: msg, completedAt: new Date() }, user.id);
        return;
      }
      if (finalOutput) {
        await db.saveMessage({
          threadId: resolvedThreadId,
          role: "assistant",
          content: redactSecrets(finalOutput).text,
        }, user.id);
      }
      await db.updateRun(run.id, { status: "completed", completedAt: new Date() }, user.id);
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
    console.error("[/api/hades]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
