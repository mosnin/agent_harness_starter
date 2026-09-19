/**
 * DROP THIS FILE INTO: your-app/src/app/api/voice/route.ts
 *
 * Hades voice turn: OpenAI STT → Jev/Qwen loop → OpenAI TTS.
 * Accepts multipart/form-data with an `audio` file and optional `agentName`.
 */

import { auth } from "@/agents/auth";
import { createHadesHarness } from "@/agents/hades/index";
import { getAgentConfig, getAllAgentNames } from "@/agents/agent-registry";
import "@/agents/examples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = await auth.requireAuth(req);
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

    const audio = Buffer.from(await file.arrayBuffer());
    const harness = createHadesHarness(agentConfig);
    const result = await harness.voiceTurn(audio, {
      context: { userId: user.id, channel: "voice" },
      signal: req.signal,
    });

    return Response.json({
      transcript: result.transcript,
      finalOutput: result.finalOutput,
      audioBase64: result.audio ? result.audio.toString("base64") : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/voice]", err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
