/* ------------------------------------------------------------------ *
 * tts — a `media` category CatalogEntry (text-to-speech).
 *
 * REAL mode (ELEVENLABS_API_KEY non-empty AND a `fetchFn` transport is
 * injected): POSTs ElevenLabs' "with-timestamps" text-to-speech
 * endpoint (which returns JSON — `{audio_base64, alignment}` — rather
 * than a raw binary body, so it fits the locked `FetchLike`'s
 * text()-only response surface) and relays the base64 mp3 payload plus
 * a real duration computed from the provider's own character-timing
 * alignment.
 *
 * MOCK mode (anything else — no key, no transport, or both missing):
 * NEVER touches the network and NEVER fabricates audio. Instead it
 * REALLY synthesizes a valid mono 16-bit PCM RIFF/WAVE file: every
 * character of the input text drives one short sine-wave tone (pitch
 * derived from that character's code point) with a linear fade
 * envelope, written byte-exact via `DataView` — no `Math.random`, no
 * `Date`, no I/O. `durationMs` is derived from the actual encoded byte
 * count, never guessed.
 *
 * This module deliberately does NOT import `../tools/catalog` (that
 * module belongs to another team in this build). `CatalogEntry`,
 * `ToolFactoryOptions`, `ToolMode`, `ToolCategory` and `FetchLike`
 * below are local, structural duplicates of that locked contract —
 * TypeScript's structural typing means a value built here satisfies
 * that module's types (and vice versa) without either module ever
 * importing the other.
 * ------------------------------------------------------------------ */

import type { Tool, ToolResult } from "../agent/tools";

// ---------------------------------------------------------------------------
// Locked shapes (local structural duplicates — see file header)
// ---------------------------------------------------------------------------

export type ToolMode = "real" | "mock";
export type ToolCategory = "web" | "system" | "media" | "data";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; headers: Record<string, string>; text(): Promise<string> }>;

export interface ToolFactoryOptions {
  env?: Record<string, string | undefined>;
  fetchFn?: FetchLike;
  now?: () => number;
}

export interface CatalogEntry {
  tool: Tool;
  id: string;
  category: ToolCategory;
  mode: ToolMode;
  requiresNetwork: boolean;
  requiredEnvKeys: string[];
  verifierId: string;
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export interface TtsOutput {
  mode: ToolMode;
  text: string;
  format: "mp3-base64" | "wav-base64";
  data: string;
  durationMs: number;
  note?: string;
}

const TOOL_NAME = "tts";
const ENV_KEY = "ELEVENLABS_API_KEY";
const ELEVENLABS_ENDPOINT_PREFIX = "https://api.elevenlabs.io/v1/text-to-speech/";
const ELEVENLABS_ENDPOINT_SUFFIX = "/with-timestamps";
const ELEVENLABS_MODEL = "eleven_multilingual_v2";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const MOCK_NOTE = "[mock] procedurally synthesized tone sequence — no speech model was called";

const MAX_TEXT_BYTES = 1_000_000;

const DEFAULT_SAMPLE_RATE = 8000;
const MIN_SAMPLE_RATE = 4000;
const MAX_SAMPLE_RATE = 48000;
const MS_PER_CHAR = 40;
const BASE_FREQ_HZ = 220;
const FREQ_STEP_HZ = 15;
const AMPLITUDE = 20000; // headroom below the int16 ceiling (32767)

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Real WAV synthesis (mock path) — byte-exact RIFF/WAVE construction
// ---------------------------------------------------------------------------

function clampSampleRate(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SAMPLE_RATE;
  return Math.max(MIN_SAMPLE_RATE, Math.min(MAX_SAMPLE_RATE, Math.round(n)));
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/**
 * Synthesize a valid mono 16-bit PCM RIFF/WAVE file for `text`. Every
 * character produces one short sine-wave "tone" whose frequency is a
 * pure function of that character's code point — same text, same
 * sample rate -> byte-identical output, every time. No randomness, no
 * clock, no external audio model.
 */
export function synthesizeWav(text: string, opts?: { sampleRate?: number }): Uint8Array {
  const sampleRate = clampSampleRate(opts?.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const samplesPerChar = Math.max(1, Math.round((sampleRate * MS_PER_CHAR) / 1000));
  const totalSamples = text.length * samplesPerChar;
  const dataBytes = totalSamples * 2; // 16-bit mono => 2 bytes/sample
  const byteRate = sampleRate * 1 * 2; // sampleRate * channels * bytesPerSample
  const blockAlign = 1 * 2; // channels * bytesPerSample

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  // RIFF header
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");

  // fmt subchunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // subchunk1 size (PCM)
  view.setUint16(20, 1, true); // audio format 1 = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample

  // data subchunk
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  const fadeLen = Math.max(1, Math.floor(samplesPerChar * 0.1));
  for (let c = 0; c < text.length; c++) {
    const code = text.charCodeAt(c);
    const freq = BASE_FREQ_HZ + (code % 40) * FREQ_STEP_HZ;
    for (let n = 0; n < samplesPerChar; n++) {
      const t = n / sampleRate;
      let envelope = 1;
      if (n < fadeLen) envelope = n / fadeLen;
      else if (n >= samplesPerChar - fadeLen) envelope = (samplesPerChar - n) / fadeLen;
      const raw = Math.sin(2 * Math.PI * freq * t) * envelope * AMPLITUDE;
      const intSample = Math.max(-32768, Math.min(32767, Math.round(raw)));
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Uint8Array(buffer);
}

function readAscii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/**
 * Parse a RIFF/WAVE byte stream by walking its chunks (robust to extra
 * metadata chunks appearing before `data`, not just fixed offsets).
 * Throws a clear error on anything that isn't a well-formed RIFF/WAVE
 * container with both a `fmt ` and a `data` chunk. Used by tests (and
 * `tts`'s own duration math) to independently prove `synthesizeWav`'s
 * output is genuinely valid, not just plausible-looking bytes.
 */
export function parseWavHeader(bytes: Uint8Array): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
} {
  if (bytes.length < 12) {
    throw new Error("tts: invalid WAV: too short to contain a RIFF header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("tts: invalid WAV: missing RIFF/WAVE markers");
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = -1;

  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (bodyStart + chunkSize > bytes.length) {
      // Truncated/corrupt chunk — stop walking rather than read out of bounds.
      break;
    }
    if (chunkId === "fmt " && chunkSize >= 16) {
      channels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      bitsPerSample = view.getUint16(bodyStart + 14, true);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }
    // RIFF chunks are word-aligned: a chunk with an odd size has one pad byte.
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (sampleRate === 0 || dataBytes < 0) {
    throw new Error("tts: invalid WAV: missing 'fmt ' or 'data' chunk");
  }
  return { sampleRate, channels, bitsPerSample, dataBytes };
}

// ---------------------------------------------------------------------------
// Base64 (manual, so invalid input can be rejected with full control)
// ---------------------------------------------------------------------------

const B64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_TABLE[(n >> 18) & 63] + B64_TABLE[(n >> 12) & 63] + B64_TABLE[(n >> 6) & 63] + B64_TABLE[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64_TABLE[(n >> 18) & 63] + B64_TABLE[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_TABLE[(n >> 18) & 63] + B64_TABLE[(n >> 12) & 63] + B64_TABLE[(n >> 6) & 63] + "=";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Input parsing — bare text string, or JSON {text, voice?}
// ---------------------------------------------------------------------------

interface ParsedTtsInput {
  text: string;
  voice: string;
}

type ParseResult = ParsedTtsInput | { error: string };

export function parseTtsInput(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { error: "empty input: expected a text string or JSON {\"text\": string, \"voice\"?: string}" };
  }

  let text: string;
  let voice = DEFAULT_VOICE_ID;

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { error: "invalid JSON input" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "JSON input must be an object" };
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.text !== "string") {
      return { error: "JSON input requires a 'text' string" };
    }
    text = obj.text;
    if (obj.voice !== undefined) {
      if (typeof obj.voice !== "string" || obj.voice.trim() === "") {
        return { error: "'voice' must be a non-empty string" };
      }
      voice = obj.voice.trim();
    }
  } else {
    text = trimmed;
  }

  if (text.trim() === "") {
    return { error: "text must be a non-empty string" };
  }
  const byteLen = new TextEncoder().encode(text).length;
  if (byteLen > MAX_TEXT_BYTES) {
    return { error: `text exceeds maximum size of ${MAX_TEXT_BYTES} bytes` };
  }

  return { text, voice };
}

// ---------------------------------------------------------------------------
// Mock path
// ---------------------------------------------------------------------------

function runMock(text: string): ToolResult {
  const wav = synthesizeWav(text);
  const header = parseWavHeader(wav);
  const durationMs = (header.dataBytes / (header.sampleRate * 2)) * 1000;
  const output: TtsOutput = {
    mode: "mock",
    text,
    format: "wav-base64",
    data: encodeBase64(wav),
    durationMs,
    note: MOCK_NOTE,
  };
  return { ok: true, output: JSON.stringify(output) };
}

// ---------------------------------------------------------------------------
// Real path — ElevenLabs "with-timestamps" endpoint via injected fetchFn
// ---------------------------------------------------------------------------

interface ElevenLabsAlignment {
  character_end_times_seconds?: unknown;
}
interface ElevenLabsResponse {
  audio_base64?: unknown;
  alignment?: ElevenLabsAlignment;
}

async function runReal(fetchFn: FetchLike, apiKey: string, text: string, voice: string): Promise<ToolResult> {
  const url = `${ELEVENLABS_ENDPOINT_PREFIX}${encodeURIComponent(voice)}${ELEVENLABS_ENDPOINT_SUFFIX}`;
  const body = JSON.stringify({ text, model_id: ELEVENLABS_MODEL });

  let res: { status: number; headers: Record<string, string>; text(): Promise<string> };
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "xi-api-key": apiKey,
      },
      body,
    });
  } catch (err) {
    return { ok: false, output: `tts: request failed: ${messageOf(err)}` };
  }

  if (res.status < 200 || res.status >= 300) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      // best-effort diagnostics only
    }
    return {
      ok: false,
      output: `tts: ElevenLabs request failed with HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`,
    };
  }

  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch (err) {
    return { ok: false, output: `tts: failed to read response body: ${messageOf(err)}` };
  }

  let parsed: ElevenLabsResponse;
  try {
    parsed = JSON.parse(bodyText) as ElevenLabsResponse;
  } catch {
    return { ok: false, output: "tts: response was not valid JSON" };
  }

  if (typeof parsed.audio_base64 !== "string" || parsed.audio_base64 === "") {
    return { ok: false, output: "tts: response missing audio data (audio_base64)" };
  }

  const times = parsed.alignment?.character_end_times_seconds;
  if (!Array.isArray(times) || times.length === 0 || typeof times[times.length - 1] !== "number") {
    return { ok: false, output: "tts: response missing timing alignment data (alignment.character_end_times_seconds)" };
  }
  const durationMs = (times[times.length - 1] as number) * 1000;

  const output: TtsOutput = {
    mode: "real",
    text,
    format: "mp3-base64",
    data: parsed.audio_base64,
    durationMs,
  };
  return { ok: true, output: JSON.stringify(output) };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const DESCRIPTION =
  "Synthesize speech from text. Input is either a bare text string or JSON " +
  '{"text": string, "voice"?: string}. Returns single-line JSON ' +
  '{"mode":"real"|"mock","text":string,"format":"mp3-base64"|"wav-base64","data":string,' +
  '"durationMs":number,"note"?:string}. Runs for real against ElevenLabs text-to-speech when ' +
  "ELEVENLABS_API_KEY and a fetch transport are configured; otherwise synthesizes a real, valid, " +
  "clearly labelled deterministic WAV tone sequence — never a fabricated voice recording.";

/**
 * Build the `tts` CatalogEntry. `mode` is decided ONCE, at construction
 * time, from `opts.env`/`opts.fetchFn` — never per-call — so a tool's
 * mode cannot silently drift mid-session.
 */
export function createTtsTool(opts: ToolFactoryOptions = {}): CatalogEntry {
  const apiKey = (opts.env?.[ENV_KEY] ?? "").trim();
  const fetchFn = opts.fetchFn;
  const mode: ToolMode = apiKey !== "" && fetchFn !== undefined ? "real" : "mock";

  const run: Tool["run"] = async (input: string): Promise<ToolResult> => {
    const parsed = parseTtsInput(input);
    if ("error" in parsed) {
      return { ok: false, output: `tts: ${parsed.error}` };
    }
    if (mode === "real") {
      return runReal(fetchFn as FetchLike, apiKey, parsed.text, parsed.voice);
    }
    return runMock(parsed.text);
  };

  const tool: Tool = {
    name: TOOL_NAME,
    description: DESCRIPTION,
    run,
  };

  return {
    tool,
    id: TOOL_NAME,
    category: "media",
    mode,
    requiresNetwork: true,
    requiredEnvKeys: [ENV_KEY],
    verifierId: "verify.tts",
  };
}
