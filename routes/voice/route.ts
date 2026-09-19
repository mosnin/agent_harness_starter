/**
 * DROP THIS FILE INTO: your-app/src/app/api/voice/route.ts
 *
 * Hades voice turn: OpenAI STT → Jev/Qwen loop → OpenAI TTS.
 * Accepts multipart/form-data with an `audio` file and optional `agentName`,
 * `threadId`.
 */

import { auth } from "@/agents/auth";
import { db } from "@/agents/db";
import { createHadesHarness } from "@/agents/hades/index";
import { redactSecrets } from "@/agents/jev/redact";
import { oversizeJsonResponse } from "@/agents/lib/request-guard";
import { isThreadOwner, messagesForHarness } from "@/agents/lib/thread-history";
import { getAgentConfig, getAllAgentNames } from "@/agents/agent-registry";
import "@/agents/examples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = await auth.requireAuth(req);
    const MAX_VOICE_BYTES = 8 * 1024 * 1024;
    const oversize = oversizeJsonResponse(req, MAX_VOICE_BYTES + 64 * 1024);
    if (oversize) return oversize;
    const form = await req.formData();
    const file = form.get("audio");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "Expected multipart field `audio`" }, { status: 400 });
    }
    const agentName = String(form.get("agentName") ?? "research");
    const agentConfig = getAgentConfig(agentName);
    if (!agentConfig) {
      return Response.json({ error: `Unknown agent: "${agentName}"`, available: getAllAgentNames() }, { status: 400 });
    }

    if (file.size > MAX_VOICE_BYTES) {
      return Response.json({ error: `Audio exceeds ${MAX_VOICE_BYTES} bytes` }, { status: 413 });
    }

    const threadId = String(form.get("threadId") ?? "").trim();
    const thread = threadId ? await db.getThread(threadId, user.id) : await db.createThread(user.id);
    if (!isThreadOwner(thread, user.id)) {
      return Response.json({ error: "Thread not found" }, { status: 404 });
    }
    const history = messagesForHarness(await db.getMessages(thread.id, user.id));

    const audio = Buffer.from(await file.arrayBuffer());
    const harness = createHadesHarness(agentConfig);
    const result = await harness.voiceTurn(audio, {
      messages: history,
      context: { userId: user.id, channel: "voice", threadId: thread.id },
      signal: req.signal,
    });

    const transcript = redactSecrets(result.transcript).text;
    const finalOutput = redactSecrets(result.finalOutput).text;
    await db.saveMessage({ threadId: thread.id, role: "user", content: transcript }, user.id);
    if (finalOutput) {
      await db.saveMessage({ threadId: thread.id, role: "assistant", content: finalOutput }, user.id);
    }

    return Response.json({
      transcript,
      finalOutput,
      threadId: thread.id,
      audioBase64: result.audio ? result.audio.toString("base64") : null,
    });
  } catch (err) {
    console.error("[/api/voice]", err);
    return Response.json({ error: "Voice turn failed" }, { status: 500 });
  }
}
