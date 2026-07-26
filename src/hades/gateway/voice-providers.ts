/**
 * Env-driven voice provider wiring — the live connector behind Phase 8's
 * "voice memo -> transcript -> agent -> optional TTS reply" pipeline.
 *
 * Mirrors the honesty contract {@link "./engine-select"} established for the
 * swarm engine: {@link buildVoiceFromEnv} builds a REAL OpenAI-compatible
 * speech-to-text engine (Whisper `/audio/transcriptions`) the moment a key
 * is present (`HADES_STT_API_KEY` or `OPENAI_API_KEY`), and falls back to a
 * deterministic, self-announcing mock transcriber otherwise. The mock
 * transcript can never be mistaken for real speech content — it is derived
 * only from the audio clip's own byte length and content hash, never from
 * any model, and always starts with `"[mock] "`.
 *
 * Text-to-speech is real-or-nothing: only with a key present AND
 * `HADES_TTS_ENABLED === "1"` does {@link buildVoiceFromEnv} wire a real
 * `/audio/speech` engine. Every other combination builds the
 * {@link VoicePipeline} WITHOUT a TTS engine at all — there is no mock TTS,
 * because fabricating audio bytes for a "spoken" reply that was never
 * actually synthesized is exactly the claimed-but-not-real output this repo
 * refuses to produce. In that case `pipeline.speak()` honestly resolves to
 * `undefined`, and `VoiceProbe.tts.mode` reports `"offline"` — never
 * `"mock"` — because offline is the true state, not a stand-in performance.
 *
 * `VoiceProbe.detail` — like `EngineProbe.detail` in `engine-select.ts` —
 * holds ONLY environment variable NAMES and non-secret status words, never a
 * key value, so it is always safe to log or surface in a status command.
 *
 * @module hades/gateway/voice-providers
 */

import type { SpeechToText, TextToSpeech, AudioRef } from "./voice";
import { VoicePipeline } from "./voice";
import { sha256Hex } from "../styx/certificate";

// ---------------------------------------------------------------------------
// VoiceProbe
// ---------------------------------------------------------------------------

/**
 * An honest, side-channel-free report of what {@link buildVoiceFromEnv}
 * decided and why for each leg of the pipeline. `detail` never contains a
 * secret value — only variable names and status words.
 */
export interface VoiceProbe {
  stt: { mode: "real" | "mock"; detail: string };
  tts: { mode: "real" | "offline"; detail: string };
}

// ---------------------------------------------------------------------------
// Key detection (shared by STT and TTS — both ride the same provider key)
// ---------------------------------------------------------------------------

interface DetectedVoiceKey {
  /** The exact environment variable NAME that supplied the key — never the key value. */
  variable: "HADES_STT_API_KEY" | "OPENAI_API_KEY";
  apiKey: string;
}

const MISSING_KEY_DETAIL = "missing HADES_STT_API_KEY, OPENAI_API_KEY";

function detectKey(env: Record<string, string | undefined>): DetectedVoiceKey | undefined {
  if (env.HADES_STT_API_KEY) return { variable: "HADES_STT_API_KEY", apiKey: env.HADES_STT_API_KEY };
  if (env.OPENAI_API_KEY) return { variable: "OPENAI_API_KEY", apiKey: env.OPENAI_API_KEY };
  return undefined;
}

// ---------------------------------------------------------------------------
// Audio byte resolution — shared by real and mock STT
// ---------------------------------------------------------------------------

/**
 * Resolve an {@link AudioRef}'s raw bytes: inline `data` wins outright;
 * otherwise the bytes are downloaded from `url` through the injected
 * `fetchImpl`. Throws a clear, non-cryptic input error when neither is
 * present — there is nothing to transcribe.
 */
async function resolveAudioBytes(
  audio: AudioRef,
  fetchImpl: typeof fetch,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (audio.data) {
    return { bytes: audio.data, mimeType: audio.mimeType ?? "application/octet-stream" };
  }
  if (audio.url) {
    const res = await fetchImpl(audio.url);
    if (!res.ok) {
      throw new Error(`failed to download audio clip: HTTP ${res.status} fetching AudioRef.url`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mimeType = audio.mimeType ?? res.headers.get("content-type") ?? "application/octet-stream";
    return { bytes, mimeType };
  }
  throw new Error("AudioRef has neither `data` nor `url` set — nothing to transcribe");
}

/** Lowercase hex encoding of raw bytes — the deterministic string fed to `sha256Hex`. */
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function fileNameFor(mimeType: string): string {
  if (mimeType.includes("ogg")) return "voice-note.ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "voice-note.mp3";
  if (mimeType.includes("wav")) return "voice-note.wav";
  if (mimeType.includes("webm")) return "voice-note.webm";
  if (mimeType.includes("m4a") || mimeType.includes("mp4")) return "voice-note.m4a";
  return "voice-note.bin";
}

// ---------------------------------------------------------------------------
// Real STT — OpenAI-compatible Whisper transcription endpoint
// ---------------------------------------------------------------------------

const STT_PATH = "/audio/transcriptions";

function createRealStt(opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl: typeof fetch;
}): SpeechToText {
  return {
    async transcribe(audio: AudioRef): Promise<string> {
      const { bytes, mimeType } = await resolveAudioBytes(audio, opts.fetchImpl);

      const form = new FormData();
      form.append("model", opts.model);
      form.append("file", new Blob([bytes as unknown as BlobPart], { type: mimeType }), fileNameFor(mimeType));

      const res = await opts.fetchImpl(`${opts.baseUrl}${STT_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}` },
        body: form,
      });
      if (!res.ok) {
        // Deliberately status + path only — never the response body, which
        // could echo request details back (and never the key, which never
        // appears in a thrown message anywhere in this module).
        throw new Error(`speech-to-text request failed: HTTP ${res.status} at ${STT_PATH}`);
      }
      const data = (await res.json()) as { text?: string };
      return data.text ?? "";
    },
  };
}

// ---------------------------------------------------------------------------
// Mock STT — deterministic, self-announcing, never speech content
// ---------------------------------------------------------------------------

function createMockStt(fetchImpl: typeof fetch): SpeechToText {
  return {
    async transcribe(audio: AudioRef): Promise<string> {
      const { bytes } = await resolveAudioBytes(audio, fetchImpl);
      const hash = sha256Hex(bytesToHex(bytes)).slice(0, 12);
      return `[mock] voice note (${bytes.length} bytes, sha256 ${hash})`;
    },
  };
}

// ---------------------------------------------------------------------------
// Real TTS — OpenAI-compatible speech synthesis endpoint
// ---------------------------------------------------------------------------

const TTS_PATH = "/audio/speech";

function createRealTts(opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  fetchImpl: typeof fetch;
}): TextToSpeech {
  return {
    async synthesize(text: string): Promise<AudioRef> {
      const res = await opts.fetchImpl(`${opts.baseUrl}${TTS_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: opts.model, voice: opts.voice, input: text }),
      });
      if (!res.ok) {
        throw new Error(`text-to-speech request failed: HTTP ${res.status} at ${TTS_PATH}`);
      }
      const data = new Uint8Array(await res.arrayBuffer());
      return { data, mimeType: "audio/mpeg" };
    },
  };
}

// ---------------------------------------------------------------------------
// buildVoiceFromEnv
// ---------------------------------------------------------------------------

/**
 * Build the gateway's {@link VoicePipeline} from environment, honestly.
 *
 * | key present? | `HADES_TTS_ENABLED` | STT    | TTS                          |
 * |---|---|---|---|
 * | no            | n/a                  | mock   | none (`speak()` → `undefined`) |
 * | yes           | not `"1"`            | real   | none (`speak()` → `undefined`) |
 * | yes           | `"1"`                | real   | real                          |
 *
 * `HADES_STT_BASE_URL` overrides the OpenAI-compatible base URL for BOTH
 * legs (default `https://api.openai.com/v1`); `HADES_STT_MODEL` overrides
 * the transcription model (default `"whisper-1"`); `HADES_TTS_MODEL` /
 * `HADES_TTS_VOICE` override the synthesis model/voice (defaults `"tts-1"`
 * / `"alloy"`).
 */
export function buildVoiceFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): { pipeline: VoicePipeline; probe: VoiceProbe } {
  const key = detectKey(env);
  const baseUrl = (env.HADES_STT_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const sttModel = env.HADES_STT_MODEL ?? "whisper-1";

  const stt: SpeechToText = key
    ? createRealStt({ apiKey: key.apiKey, baseUrl, model: sttModel, fetchImpl })
    : createMockStt(fetchImpl);

  const sttProbe: VoiceProbe["stt"] = key
    ? { mode: "real", detail: `real speech-to-text active via ${key.variable}, model "${sttModel}"` }
    : { mode: "mock", detail: `${MISSING_KEY_DETAIL} — using the deterministic mock transcriber` };

  const ttsEnabled = !!key && env.HADES_TTS_ENABLED === "1";
  const ttsModel = env.HADES_TTS_MODEL ?? "tts-1";
  const ttsVoice = env.HADES_TTS_VOICE ?? "alloy";

  const tts: TextToSpeech | undefined = ttsEnabled
    ? createRealTts({ apiKey: (key as DetectedVoiceKey).apiKey, baseUrl, model: ttsModel, voice: ttsVoice, fetchImpl })
    : undefined;

  const ttsProbe: VoiceProbe["tts"] = ttsEnabled
    ? {
        mode: "real",
        detail: `real text-to-speech active via ${(key as DetectedVoiceKey).variable}, model "${ttsModel}", voice "${ttsVoice}"`,
      }
    : {
        mode: "offline",
        detail: key
          ? `HADES_TTS_ENABLED is not "1" — text-to-speech offline; replies are text-only`
          : `${MISSING_KEY_DETAIL} and HADES_TTS_ENABLED is not "1" — text-to-speech offline; replies are text-only`,
      };

  return { pipeline: new VoicePipeline(stt, tts), probe: { stt: sttProbe, tts: ttsProbe } };
}
