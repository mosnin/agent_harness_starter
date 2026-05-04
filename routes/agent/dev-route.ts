/**
 * ZERO-CONFIG DEV ROUTE — works immediately, no wiring required.
 *
 * Copy to: your-app/src/app/api/agent/route.ts
 *
 * Zero-config development route. Uses built-in dev adapters:
 *   - auth: accepts any request, returns { id: "dev-user" } — no real auth
 *   - db:   in-memory thread store, reset on server restart
 *
 * To switch to real auth/DB: copy routes/agent/route.ts instead and
 * wire @/agents/auth and @/agents/db to your actual adapters.
 * See docs/02-connecting-your-app.md.
 */
import { z } from "zod";
import { auth } from "@/agents/auth";
import { db } from "@/agents/db";
import { createAgent } from "@/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().min(1).max(32_000),
  agentName: z.string().optional(),
});

export async function POST(req: Request) {
  const user = await auth.requireAuth(req);
  const { message } = bodySchema.parse(await req.json());
  const thread = await db.createThread(user.id);

  const agent = createAgent({
    name: "assistant",
    instructions: "You are a helpful assistant.",
  });

  const stream = agent.stream({
    messages: [{ role: "user", content: message }],
    context: { userId: user.id },
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      for await (const event of stream) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (event.type === "done") {
          await db.saveMessage({ threadId: thread.id, role: "assistant", content: event.finalOutput });
        }
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
