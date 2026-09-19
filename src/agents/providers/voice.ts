/**
 * OpenAI voice channel for Hades — STT + TTS.
 *
 * Jev/Qwen never hear or speak. OpenAI Whisper (or gpt-4o-transcribe)
 * turns audio into text; Hades decides; OpenAI TTS speaks the reply.
 */

import OpenAI from "openai";

export interface VoiceConfig {
  apiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
}

function voiceClient(config: VoiceConfig = {}): OpenAI {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY — required for Hades voice mode");
  }
  return new OpenAI({
    apiKey,
    // Voice must hit OpenAI, not OpenRouter.
    baseURL: process.env.OPENAI_VOICE_BASE_URL ?? "https://api.openai.com/v1",
  });
}

export async function transcribeAudio(
  audio: Buffer | Uint8Array,
  filename = "audio.webm",
  config: VoiceConfig = {}
): Promise<string> {
  if (audio.byteLength === 0) {
    throw new Error("transcribeAudio: audio buffer is empty");
  }
  const client = voiceClient(config);
  const file = new File([Buffer.from(audio)], filename);
  const result = await client.audio.transcriptions.create({
    file,
    model: config.sttModel ?? process.env.HADES_STT_MODEL ?? "whisper-1",
  });
  const text = result.text.trim();
  if (!text) throw new Error("transcribeAudio: empty transcript");
  return text;
}

export async function synthesizeSpeech(
  text: string,
  config: VoiceConfig = {}
): Promise<Buffer> {
  if (!text.trim()) {
    throw new Error("synthesizeSpeech: text is required");
  }
  const client = voiceClient(config);
  const response = await client.audio.speech.create({
    model: config.ttsModel ?? process.env.HADES_TTS_MODEL ?? "gpt-4o-mini-tts",
    voice: config.voice ?? (process.env.HADES_TTS_VOICE as VoiceConfig["voice"]) ?? "alloy",
    input: text.slice(0, 4096),
  });
  return Buffer.from(await response.arrayBuffer());
}

export async function voiceIntentHint(transcript: string): Promise<"execute_now" | "clarify" | "out_of_scope"> {
  const trimmed = transcript.trim();
  if (trimmed.length < 2) return "clarify";
  if (/\b(never mind|stop|cancel)\b/i.test(trimmed)) return "out_of_scope";
  return "execute_now";
}
