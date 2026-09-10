import { describe, it, expect } from "vitest";

import { buildVoiceFromEnv, type VoiceProbe } from "../gateway/voice-providers";
import type { AudioRef } from "../gateway/voice";

// ---------------------------------------------------------------------------
// A fake `fetch` that records every call and dispatches to a handler — no
// live network anywhere in this file.
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function readMultipartField(form: FormData, name: string): Promise<string | undefined> {
  const value = form.get(name);
  if (value == null) return undefined;
  return typeof value === "string" ? value : undefined;
}

const SENTINEL_KEY = "sk-SENTINEL-DO-NOT-LEAK-4f9c2a1e";

/** Grep every string this module could produce for the sentinel key value. */
function assertNeverLeaksSentinel(...strings: Array<string | undefined>): void {
  for (const s of strings) {
    if (s === undefined) continue;
    expect(s).not.toContain(SENTINEL_KEY);
  }
}

// ---------------------------------------------------------------------------
// Real STT
// ---------------------------------------------------------------------------

describe("buildVoiceFromEnv — real STT", () => {
  it("posts a well-formed multipart request to /audio/transcriptions and returns the transcript verbatim", async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      return new Response(JSON.stringify({ text: "the quick brown fox" }), { status: 200 });
    });

    const { pipeline, probe } = buildVoiceFromEnv({ HADES_STT_API_KEY: SENTINEL_KEY }, fetchImpl);
    expect(probe.stt.mode).toBe("real");
    expect(probe.stt.detail).toContain("HADES_STT_API_KEY");

    const audio: AudioRef = { data: new Uint8Array([1, 2, 3, 4, 5]), mimeType: "audio/ogg" };
    const transcript = await pipeline.transcribe(audio);
    expect(transcript).toBe("the quick brown fox");

    expect(calls).toHaveLength(1);
    const init = calls[0].init!;
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    // Presence only — the value itself is never asserted into any log or output.
    expect(headers.authorization).toBeDefined();
    expect(headers.authorization.startsWith("Bearer ")).toBe(true);

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(await readMultipartField(form, "model")).toBe("whisper-1");
    const file = form.get("file") as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.size).toBe(5);
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    expect([...fileBytes]).toEqual([1, 2, 3, 4, 5]);

    assertNeverLeaksSentinel(probe.stt.detail, probe.tts.detail, transcript, JSON.stringify(probe));
  });

  it("honors HADES_STT_BASE_URL and HADES_STT_MODEL overrides", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(JSON.stringify({ text: "ok" }), { status: 200 }));
    const { pipeline } = buildVoiceFromEnv(
      {
        OPENAI_API_KEY: "sk-real-key",
        HADES_STT_BASE_URL: "https://voice.example.internal/v9/",
        HADES_STT_MODEL: "whisper-large-v3",
      },
      fetchImpl,
    );
    await pipeline.transcribe({ data: new Uint8Array([9]) });
    expect(calls[0].url).toBe("https://voice.example.internal/v9/audio/transcriptions");
    const form = calls[0].init!.body as FormData;
    expect(await readMultipartField(form, "model")).toBe("whisper-large-v3");
  });

  it.each([401, 429, 500])("throws with status + path (no body echo) on HTTP %i", async (status) => {
    const secretBody = `{"error":"invalid_api_key","key":"${SENTINEL_KEY}"}`;
    const { fetchImpl } = fakeFetch(() => new Response(secretBody, { status }));
    const { pipeline } = buildVoiceFromEnv({ HADES_STT_API_KEY: SENTINEL_KEY }, fetchImpl);

    let thrown: unknown;
    try {
      await pipeline.transcribe({ data: new Uint8Array([1]) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(new RegExp(`${status}.*audio/transcriptions`));
    assertNeverLeaksSentinel(message);
    expect(message).not.toContain("invalid_api_key");
    expect(message).not.toContain(secretBody);
  });

  it("downloads url-sourced AudioRef bytes through fetchImpl before transcribing", async () => {
    const calls: string[] = [];
    const { fetchImpl } = fakeFetch((url) => {
      calls.push(url);
      if (url === "https://cdn.example.com/clip.ogg") {
        return new Response(new Uint8Array([7, 7, 7]), { status: 200, headers: { "content-type": "audio/ogg" } });
      }
      // The real transcription request.
      return new Response(JSON.stringify({ text: "downloaded then transcribed" }), { status: 200 });
    });

    const { pipeline } = buildVoiceFromEnv({ HADES_STT_API_KEY: "sk-real" }, fetchImpl);
    const transcript = await pipeline.transcribe({ url: "https://cdn.example.com/clip.ogg" });

    expect(transcript).toBe("downloaded then transcribed");
    expect(calls).toEqual(["https://cdn.example.com/clip.ogg", "https://api.openai.com/v1/audio/transcriptions"]);
  });

  it("throws a clear input error when AudioRef has neither url nor data", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("{}", { status: 200 }));
    const { pipeline } = buildVoiceFromEnv({ HADES_STT_API_KEY: "sk-real" }, fetchImpl);
    await expect(pipeline.transcribe({})).rejects.toThrow(/neither.*data.*nor.*url|nothing to transcribe/i);
  });
});

// ---------------------------------------------------------------------------
// Mock STT
// ---------------------------------------------------------------------------

describe("buildVoiceFromEnv — mock STT (no key)", () => {
  it("is deterministic for identical bytes and always self-announces as [mock]", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("should never be called", { status: 200 }));
    const { pipeline, probe } = buildVoiceFromEnv({}, fetchImpl);

    expect(probe.stt.mode).toBe("mock");
    expect(probe.stt.detail).toContain("HADES_STT_API_KEY");
    expect(probe.stt.detail).toContain("OPENAI_API_KEY");

    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const t1 = await pipeline.transcribe({ data: bytes });
    const t2 = await pipeline.transcribe({ data: new Uint8Array([10, 20, 30, 40, 50]) }); // same content, different array

    expect(t1).toBe(t2);
    expect(t1).toMatch(/^\[mock\] voice note \(5 bytes, sha256 [0-9a-f]{12}\)$/);
  });

  it("produces a different hash prefix for different bytes", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("unused", { status: 200 }));
    const { pipeline } = buildVoiceFromEnv({}, fetchImpl);

    const a = await pipeline.transcribe({ data: new Uint8Array([1, 2, 3]) });
    const b = await pipeline.transcribe({ data: new Uint8Array([1, 2, 4]) });
    expect(a).not.toBe(b);
  });

  it("never contains speech-like content — always starts with the exact [mock] prefix", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("unused", { status: 200 }));
    const { pipeline } = buildVoiceFromEnv({}, fetchImpl);
    const transcript = await pipeline.transcribe({ data: new Uint8Array([255, 0, 128]) });
    expect(transcript.startsWith("[mock] voice note (")).toBe(true);
  });

  it("downloads url-sourced audio for the mock path too, and never calls the network for anything else", async () => {
    const calls: string[] = [];
    const { fetchImpl } = fakeFetch((url) => {
      calls.push(url);
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const { pipeline } = buildVoiceFromEnv({}, fetchImpl);
    const transcript = await pipeline.transcribe({ url: "https://cdn.example.com/note.ogg" });
    expect(calls).toEqual(["https://cdn.example.com/note.ogg"]);
    expect(transcript).toMatch(/^\[mock\] voice note \(4 bytes, sha256 [0-9a-f]{12}\)$/);
  });

  it("throws a clear input error when AudioRef has neither url nor data", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("unused", { status: 200 }));
    const { pipeline } = buildVoiceFromEnv({}, fetchImpl);
    await expect(pipeline.transcribe({})).rejects.toThrow(/nothing to transcribe/i);
  });
});

// ---------------------------------------------------------------------------
// TTS matrix: real / offline(disabled) / offline(keyless) — no mock TTS ever
// ---------------------------------------------------------------------------

describe("buildVoiceFromEnv — TTS matrix", () => {
  it("real: key present AND HADES_TTS_ENABLED=1 -> synthesizes real audio via /audio/speech", async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.endsWith("/audio/transcriptions")) return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
      expect(url).toBe("https://api.openai.com/v1/audio/speech");
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    });

    const { pipeline, probe } = buildVoiceFromEnv(
      { HADES_STT_API_KEY: SENTINEL_KEY, HADES_TTS_ENABLED: "1" },
      fetchImpl,
    );
    expect(probe.tts.mode).toBe("real");
    expect(probe.tts.detail).toContain("HADES_STT_API_KEY");
    assertNeverLeaksSentinel(probe.tts.detail);

    const spoken = await pipeline.speak("hello there");
    expect(spoken).toBeDefined();
    expect(spoken!.mimeType).toBe("audio/mpeg");
    expect([...spoken!.data!]).toEqual([9, 9, 9]);

    const ttsCall = calls.find((c) => c.url.endsWith("/audio/speech"))!;
    const body = JSON.parse(ttsCall.init!.body as string);
    expect(body).toMatchObject({ model: "tts-1", voice: "alloy", input: "hello there" });
  });

  it("honors HADES_TTS_MODEL / HADES_TTS_VOICE overrides", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
    const { pipeline } = buildVoiceFromEnv(
      {
        HADES_STT_API_KEY: "sk-real",
        HADES_TTS_ENABLED: "1",
        HADES_TTS_MODEL: "tts-1-hd",
        HADES_TTS_VOICE: "nova",
      },
      fetchImpl,
    );
    await pipeline.speak("text");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body).toMatchObject({ model: "tts-1-hd", voice: "nova" });
  });

  it("throws with status + path (no body echo) on non-2xx", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(`{"key":"${SENTINEL_KEY}"}`, { status: 500 }));
    const { pipeline } = buildVoiceFromEnv({ HADES_STT_API_KEY: SENTINEL_KEY, HADES_TTS_ENABLED: "1" }, fetchImpl);

    let thrown: unknown;
    try {
      await pipeline.speak("x");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/500.*audio\/speech/);
    assertNeverLeaksSentinel(message);
  });

  it("offline: key present but HADES_TTS_ENABLED is not \"1\" -> speak() is undefined, never fabricates audio", async () => {
    let ttsNetworkCalls = 0;
    const { fetchImpl } = fakeFetch((url) => {
      if (url.endsWith("/audio/speech")) ttsNetworkCalls++;
      return new Response(JSON.stringify({ text: "unused" }), { status: 200 });
    });
    const { pipeline, probe } = buildVoiceFromEnv({ HADES_STT_API_KEY: "sk-real" }, fetchImpl);
    expect(probe.tts.mode).toBe("offline");
    expect(probe.tts.detail).toContain("HADES_TTS_ENABLED");

    const spoken = await pipeline.speak("never synthesized");
    expect(spoken).toBeUndefined();
    expect(ttsNetworkCalls).toBe(0);
  });

  it("offline: no key at all -> mock STT + offline TTS, speak() is undefined", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("unused", { status: 200 }));
    const { pipeline, probe } = buildVoiceFromEnv({ HADES_TTS_ENABLED: "1" }, fetchImpl); // enabling without a key must still be offline
    expect(probe.stt.mode).toBe("mock");
    expect(probe.tts.mode).toBe("offline");
    expect(probe.tts.detail).toContain("HADES_STT_API_KEY");
    expect(probe.tts.detail).toContain("OPENAI_API_KEY");

    const spoken = await pipeline.speak("anything");
    expect(spoken).toBeUndefined();
  });

  it("full probe shape is exactly {stt:{mode,detail}, tts:{mode,detail}}", () => {
    const { fetchImpl } = fakeFetch(() => new Response("unused", { status: 200 }));
    const { probe }: { probe: VoiceProbe } = buildVoiceFromEnv({}, fetchImpl);
    expect(Object.keys(probe).sort()).toEqual(["stt", "tts"]);
    expect(Object.keys(probe.stt).sort()).toEqual(["detail", "mode"]);
    expect(Object.keys(probe.tts).sort()).toEqual(["detail", "mode"]);
  });
});

// ---------------------------------------------------------------------------
// Prefers OPENAI_API_KEY when HADES_STT_API_KEY is absent, and HADES_STT_API_KEY wins when both present
// ---------------------------------------------------------------------------

describe("buildVoiceFromEnv — key precedence", () => {
  it("uses OPENAI_API_KEY when HADES_STT_API_KEY is unset", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(JSON.stringify({ text: "ok" }), { status: 200 }));
    const { probe } = buildVoiceFromEnv({ OPENAI_API_KEY: "sk-oai" }, fetchImpl);
    expect(probe.stt.detail).toContain("OPENAI_API_KEY");
  });

  it("prefers HADES_STT_API_KEY over OPENAI_API_KEY when both are present", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(JSON.stringify({ text: "ok" }), { status: 200 }));
    const { probe } = buildVoiceFromEnv({ HADES_STT_API_KEY: "sk-hades", OPENAI_API_KEY: "sk-oai" }, fetchImpl);
    expect(probe.stt.detail).toContain("HADES_STT_API_KEY");
    expect(probe.stt.mode).toBe("real");
  });
});
