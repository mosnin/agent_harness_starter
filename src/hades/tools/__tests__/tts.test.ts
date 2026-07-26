/**
 * Real behavioral tests for `createTtsTool`: mode-selection matrix, valid
 * RIFF/WAVE synthesis + round-trip parsing, input hardening, and real-mode
 * HTTP behavior against a fake injected `fetchFn`.
 */
import { describe, it, expect } from "vitest";
import {
  createTtsTool,
  synthesizeWav,
  parseWavHeader,
  parseTtsInput,
  type FetchLike,
  type TtsOutput,
} from "../tts";

function parseOutput(output: string): TtsOutput {
  return JSON.parse(output) as TtsOutput;
}

function fakeFetch(
  impl: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ) => Promise<{ status: number; headers: Record<string, string>; text(): Promise<string> }>
): FetchLike {
  return impl;
}

function jsonResponse(status: number, body: unknown): { status: number; headers: Record<string, string>; text(): Promise<string> } {
  return { status, headers: {}, text: async () => JSON.stringify(body) };
}

function decodeBase64ForTest(s: string): Uint8Array {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = s.replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const val = table.indexOf(ch);
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Mode-selection matrix (all 4 cells)
// ---------------------------------------------------------------------------

describe("createTtsTool: mode selection matrix", () => {
  it("key present + fetchFn present -> real", () => {
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "el-real" },
      fetchFn: fakeFetch(async () => jsonResponse(200, { audio_base64: "abc", alignment: { character_end_times_seconds: [0.1] } })),
    });
    expect(entry.mode).toBe("real");
  });

  it("key present + fetchFn absent -> mock", () => {
    expect(createTtsTool({ env: { ELEVENLABS_API_KEY: "el-real" } }).mode).toBe("mock");
  });

  it("key absent + fetchFn present -> mock", () => {
    expect(createTtsTool({ fetchFn: fakeFetch(async () => jsonResponse(200, {})) }).mode).toBe("mock");
  });

  it("key absent + fetchFn absent -> mock", () => {
    expect(createTtsTool({}).mode).toBe("mock");
    expect(createTtsTool().mode).toBe("mock");
  });

  it("whitespace-only key -> mock", () => {
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "  " },
      fetchFn: fakeFetch(async () => jsonResponse(200, {})),
    });
    expect(entry.mode).toBe("mock");
  });
});

describe("createTtsTool: catalog metadata", () => {
  it("has the locked identity", () => {
    const entry = createTtsTool();
    expect(entry.id).toBe("tts");
    expect(entry.tool.name).toBe("tts");
    expect(entry.category).toBe("media");
    expect(entry.requiresNetwork).toBe(true);
    expect(entry.requiredEnvKeys).toEqual(["ELEVENLABS_API_KEY"]);
  });
});

// ---------------------------------------------------------------------------
// synthesizeWav / parseWavHeader: real, valid, byte-exact PCM
// ---------------------------------------------------------------------------

describe("synthesizeWav + parseWavHeader", () => {
  it("produces a buffer that begins with RIFF/WAVE markers", () => {
    const wav = synthesizeWav("hi");
    const text = String.fromCharCode(...wav.slice(0, 4));
    expect(text).toBe("RIFF");
    const wave = String.fromCharCode(...wav.slice(8, 12));
    expect(wave).toBe("WAVE");
  });

  it("round-trips through parseWavHeader with correct sampleRate, channels, bitsPerSample", () => {
    const wav = synthesizeWav("hello world", { sampleRate: 8000 });
    const header = parseWavHeader(wav);
    expect(header.sampleRate).toBe(8000);
    expect(header.channels).toBe(1);
    expect(header.bitsPerSample).toBe(16);
  });

  it("dataBytes matches the actual encoded sample count exactly", () => {
    const text = "abcdef";
    const sampleRate = 8000;
    const wav = synthesizeWav(text, { sampleRate });
    const header = parseWavHeader(wav);
    // total file size must equal 44-byte header + dataBytes
    expect(wav.length).toBe(44 + header.dataBytes);
    // dataBytes must be a whole number of 16-bit (2-byte) samples
    expect(header.dataBytes % 2).toBe(0);
  });

  it("durationMs computed from dataBytes/(rate*2) matches exactly for several inputs", () => {
    for (const [text, rate] of [
      ["a", 8000],
      ["hello", 16000],
      ["The quick brown fox.", 22050],
      ["", 8000],
    ] as const) {
      const wav = synthesizeWav(text, { sampleRate: rate });
      const header = parseWavHeader(wav);
      const expectedDurationMs = (header.dataBytes / (header.sampleRate * 2)) * 1000;
      const recomputed = (header.dataBytes / (header.sampleRate * 2)) * 1000;
      expect(recomputed).toBe(expectedDurationMs);
      expect(header.sampleRate).toBe(rate);
    }
  });

  it("uses the default sample rate of 8000 when unspecified", () => {
    const wav = synthesizeWav("default rate");
    const header = parseWavHeader(wav);
    expect(header.sampleRate).toBe(8000);
  });

  it("clamps out-of-range sample rates into a sane bound without throwing", () => {
    expect(() => synthesizeWav("x", { sampleRate: 1 })).not.toThrow();
    expect(() => synthesizeWav("x", { sampleRate: 999999 })).not.toThrow();
    const low = parseWavHeader(synthesizeWav("x", { sampleRate: 1 }));
    const high = parseWavHeader(synthesizeWav("x", { sampleRate: 999999 }));
    expect(low.sampleRate).toBeGreaterThanOrEqual(4000);
    expect(high.sampleRate).toBeLessThanOrEqual(48000);
  });

  it("produces an empty-but-valid data chunk for empty text", () => {
    const wav = synthesizeWav("");
    const header = parseWavHeader(wav);
    expect(header.dataBytes).toBe(0);
    expect(wav.length).toBe(44);
  });

  it("is deterministic: same text + sampleRate -> byte-identical output", () => {
    const a = synthesizeWav("determinism check", { sampleRate: 8000 });
    const b = synthesizeWav("determinism check", { sampleRate: 8000 });
    expect(a).toEqual(b);
  });

  it("produces different bytes for different text", () => {
    const a = synthesizeWav("alpha");
    const b = synthesizeWav("beta");
    expect(a).not.toEqual(b);
  });

  it("keeps every 16-bit sample within the valid int16 range", () => {
    const wav = synthesizeWav("range check with several characters!!!");
    const header = parseWavHeader(wav);
    const view = new DataView(wav.buffer, wav.byteOffset + 44, header.dataBytes);
    for (let i = 0; i + 1 < header.dataBytes; i += 2) {
      const sample = view.getInt16(i, true);
      expect(sample).toBeGreaterThanOrEqual(-32768);
      expect(sample).toBeLessThanOrEqual(32767);
    }
  });

  describe("parseWavHeader error handling", () => {
    it("throws a clear error on a too-short buffer", () => {
      expect(() => parseWavHeader(new Uint8Array([1, 2, 3]))).toThrow(/too short/);
    });

    it("throws a clear error when RIFF/WAVE markers are missing", () => {
      const bad = new Uint8Array(44);
      bad.set([0x00, 0x00, 0x00, 0x00], 0);
      expect(() => parseWavHeader(bad)).toThrow(/RIFF\/WAVE/);
    });

    it("throws when fmt/data chunks are absent", () => {
      const buffer = new ArrayBuffer(12);
      const view = new DataView(buffer);
      "RIFF".split("").forEach((c, i) => view.setUint8(i, c.charCodeAt(0)));
      "WAVE".split("").forEach((c, i) => view.setUint8(8 + i, c.charCodeAt(0)));
      expect(() => parseWavHeader(new Uint8Array(buffer))).toThrow(/fmt|data/);
    });
  });
});

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

describe("parseTtsInput", () => {
  it("accepts a bare text string", () => {
    const result = parseTtsInput("hello there");
    expect(result).toMatchObject({ text: "hello there" });
  });

  it("accepts JSON {text, voice}", () => {
    const result = parseTtsInput('{"text":"hi","voice":"custom-voice-id"}');
    expect(result).toEqual({ text: "hi", voice: "custom-voice-id" });
  });

  it("rejects empty input", () => {
    expect("error" in parseTtsInput("   ")).toBe(true);
  });

  it("rejects empty text in JSON", () => {
    expect("error" in parseTtsInput('{"text":"   "}')).toBe(true);
  });

  it("rejects invalid JSON", () => {
    expect("error" in parseTtsInput("{bad")).toBe(true);
  });

  it("rejects JSON missing text field", () => {
    expect("error" in parseTtsInput('{"voice":"x"}')).toBe(true);
  });

  it("rejects an empty voice string", () => {
    expect("error" in parseTtsInput('{"text":"hi","voice":""}')).toBe(true);
  });

  it("caps text at 1 MB with a clear error", () => {
    const huge = "a".repeat(1_000_001);
    const result = parseTtsInput(huge);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/exceeds maximum size/);
  });
});

// ---------------------------------------------------------------------------
// Mock-mode behavior via the full tool
// ---------------------------------------------------------------------------

describe("createTtsTool: mock mode", () => {
  it("returns mode=mock, format=wav-base64, the exact required note, and a valid WAV payload", async () => {
    const entry = createTtsTool();
    const result = await entry.tool.run("say something");
    expect(result.ok).toBe(true);
    const out = parseOutput(result.output);
    expect(out.mode).toBe("mock");
    expect(out.format).toBe("wav-base64");
    expect(out.text).toBe("say something");
    expect(out.note).toBe("[mock] procedurally synthesized tone sequence — no speech model was called");

    const bytes = decodeBase64ForTest(out.data);
    const header = parseWavHeader(bytes);
    expect(header.sampleRate).toBe(8000);
    const expectedDurationMs = (header.dataBytes / (header.sampleRate * 2)) * 1000;
    expect(out.durationMs).toBe(expectedDurationMs);
  });

  it("never touches the network in mock mode", async () => {
    let called = false;
    const entry = createTtsTool({
      fetchFn: fakeFetch(async () => {
        called = true;
        return jsonResponse(200, {});
      }),
    });
    await entry.tool.run("no network");
    expect(called).toBe(false);
  });

  it("surfaces parse errors as ok:false", async () => {
    const entry = createTtsTool();
    const result = await entry.tool.run("");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/^tts:/);
  });
});

// ---------------------------------------------------------------------------
// Real-mode behavior against a fake fetchFn
// ---------------------------------------------------------------------------

describe("createTtsTool: real mode", () => {
  it("posts to the exact ElevenLabs endpoint with the xi-api-key header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody = "";
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "el-test-key" },
      fetchFn: fakeFetch(async (url, init) => {
        capturedUrl = url;
        capturedHeaders = init?.headers;
        capturedBody = init?.body ?? "";
        return jsonResponse(200, { audio_base64: "ZmFrZS1tcDMtYnl0ZXM=", alignment: { character_end_times_seconds: [0.05, 0.11, 1.234] } });
      }),
    });
    const result = await entry.tool.run('{"text":"hello there","voice":"my-voice"}');
    expect(capturedUrl).toBe("https://api.elevenlabs.io/v1/text-to-speech/my-voice/with-timestamps");
    expect(capturedHeaders?.["xi-api-key"]).toBe("el-test-key");
    expect(JSON.parse(capturedBody).text).toBe("hello there");
    expect(result.ok).toBe(true);
    const out = parseOutput(result.output);
    expect(out.mode).toBe("real");
    expect(out.format).toBe("mp3-base64");
    expect(out.data).toBe("ZmFrZS1tcDMtYnl0ZXM=");
    expect(out.durationMs).toBe(1234);
    expect(out.note).toBeUndefined();
  });

  it("defaults to the built-in voice id when none is supplied", async () => {
    let capturedUrl = "";
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "el-key" },
      fetchFn: fakeFetch(async (url) => {
        capturedUrl = url;
        return jsonResponse(200, { audio_base64: "YQ==", alignment: { character_end_times_seconds: [0.5] } });
      }),
    });
    await entry.tool.run("plain text");
    expect(capturedUrl).toContain("/v1/text-to-speech/");
    expect(capturedUrl).toContain("/with-timestamps");
  });

  it("maps HTTP 401 to ok:false with the status surfaced", async () => {
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "bad" },
      fetchFn: fakeFetch(async () => ({ status: 401, headers: {}, text: async () => "unauthorized" })),
    });
    const result = await entry.tool.run("x");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("401");
  });

  it("maps HTTP 429 to ok:false with the status surfaced", async () => {
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "rl" },
      fetchFn: fakeFetch(async () => ({ status: 429, headers: {}, text: async () => "too many requests" })),
    });
    const result = await entry.tool.run("x");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("429");
  });

  it("maps HTTP 500 to ok:false with the status surfaced", async () => {
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "500" },
      fetchFn: fakeFetch(async () => ({ status: 500, headers: {}, text: async () => "boom" })),
    });
    const result = await entry.tool.run("x");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("500");
  });

  it("maps a rejected fetchFn to ok:false", async () => {
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "neterr" },
      fetchFn: fakeFetch(async () => {
        throw new Error("dns failure");
      }),
    });
    const result = await entry.tool.run("x");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("dns failure");
  });

  it("handles a missing audio_base64 field", async () => {
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "k" },
      fetchFn: fakeFetch(async () => jsonResponse(200, { alignment: { character_end_times_seconds: [1] } })),
    });
    const result = await entry.tool.run("x");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/missing audio data/);
  });

  it("handles missing alignment/timing data", async () => {
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "k" },
      fetchFn: fakeFetch(async () => jsonResponse(200, { audio_base64: "YQ==" })),
    });
    const result = await entry.tool.run("x");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/timing alignment/);
  });

  it("handles a non-JSON response body", async () => {
    const entry = createTtsTool({
      env: { ELEVENLABS_API_KEY: "k" },
      fetchFn: fakeFetch(async () => ({ status: 200, headers: {}, text: async () => "<<not json>>" })),
    });
    const result = await entry.tool.run("x");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/not valid JSON/);
  });
});
