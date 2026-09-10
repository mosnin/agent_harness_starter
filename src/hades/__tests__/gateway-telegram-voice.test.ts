import { describe, it, expect, vi } from "vitest";

import { TelegramVoiceConnector, createTelegramVoiceHttpTransport } from "../gateway/connectors/telegram-voice";
import type { TelegramVoiceTransport, TelegramVoiceUpdate } from "../gateway/connectors/telegram-voice";
import { VoicePipeline } from "../gateway/voice";
import type { AudioRef, SpeechToText, TextToSpeech } from "../gateway/voice";
import { AgentGatewayHandler, echoEngine } from "../gateway/agent-handler";
import { ContinuityRouter, InMemoryIdentityStore } from "../gateway/continuity";
import { BadgeStamper } from "../gateway/badge";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeTransportOpts {
  updates: TelegramVoiceUpdate[];
  /** file_id -> bytes for downloadFile to hand back. */
  files?: Record<string, Uint8Array>;
  /** file_id -> Error to throw from downloadFile instead of succeeding. */
  downloadErrors?: Record<string, Error>;
}

function fakeTransport(opts: FakeTransportOpts): {
  transport: TelegramVoiceTransport;
  sent: Array<{ chatId: string; text: string }>;
  voiceSent: Array<{ chatId: string; bytes: Uint8Array; mimeType?: string }>;
  downloadCalls: string[];
} {
  let queue = [...opts.updates];
  const sent: Array<{ chatId: string; text: string }> = [];
  const voiceSent: Array<{ chatId: string; bytes: Uint8Array; mimeType?: string }> = [];
  const downloadCalls: string[] = [];

  const transport: TelegramVoiceTransport = {
    async getUpdates() {
      const batch = queue;
      queue = [];
      return batch;
    },
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
    },
    async downloadFile(fileId) {
      downloadCalls.push(fileId);
      const err = opts.downloadErrors?.[fileId];
      if (err) throw err;
      const bytes = opts.files?.[fileId];
      if (!bytes) throw new Error(`test fixture missing bytes for file_id ${fileId}`);
      return bytes;
    },
    async sendVoice(chatId, audio, mimeType) {
      voiceSent.push({ chatId, bytes: audio, mimeType });
    },
  };

  return { transport, sent, voiceSent, downloadCalls };
}

function fakeStt(transcript: string | ((audio: AudioRef) => string)): SpeechToText & { calls: AudioRef[] } {
  const calls: AudioRef[] = [];
  return {
    calls,
    async transcribe(audio) {
      calls.push(audio);
      return typeof transcript === "function" ? transcript(audio) : transcript;
    },
  };
}

function fakeTts(): TextToSpeech & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async synthesize(text) {
      calls.push(text);
      return { data: new Uint8Array([1, 3, 5, 7]), mimeType: "audio/mpeg" };
    },
  };
}

const echoHandler = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });

/** A real handler chain: AgentGatewayHandler(echoEngine) -> ContinuityRouter -> BadgeStamper. */
function realHandlerChain(): (msg: InboundMessage) => Promise<OutboundReply> {
  const agentHandler = new AgentGatewayHandler({ engine: echoEngine() });
  const identities = new InMemoryIdentityStore();
  const continuityRouter = new ContinuityRouter(identities, agentHandler.handle, {
    newSessionId: () => "voice-test-session",
  });
  const badgeStamper = new BadgeStamper();
  return badgeStamper.wrap(continuityRouter.handle);
}

function textUpdate(updateId: number, text: string, userId = 1, chatId = 100): TelegramVoiceUpdate {
  return { update_id: updateId, message: { from: { id: userId }, chat: { id: chatId }, text } };
}

function voiceUpdate(
  updateId: number,
  voice: { file_id: string; duration?: number; mime_type?: string },
  userId = 1,
  chatId = 100,
): TelegramVoiceUpdate {
  return { update_id: updateId, message: { from: { id: userId }, chat: { id: chatId }, voice } };
}

// ---------------------------------------------------------------------------
// Text updates — must behave exactly like TelegramConnector
// ---------------------------------------------------------------------------

describe("TelegramVoiceConnector — text updates", () => {
  it("normalizes text updates, routes to the handler, and replies via sendMessage without touching the voice pipeline", async () => {
    const { transport, sent, downloadCalls } = fakeTransport({
      updates: [textUpdate(1, "hello"), textUpdate(2, "again")],
    });
    const stt = fakeStt(() => {
      throw new Error("STT must never be invoked for a text-only turn");
    });
    const pipeline = new VoicePipeline(stt);
    const conn = new TelegramVoiceConnector(transport, pipeline);
    await conn.start(echoHandler);
    await conn.pollOnce();

    expect(sent.map((s) => s.text)).toEqual(["echo:hello", "echo:again"]);
    expect(sent[0].chatId).toBe("100");
    expect(downloadCalls).toHaveLength(0);
    expect(stt.calls).toHaveLength(0);
    await conn.stop();
  });

  it("advances the offset past processed updates so they are not re-delivered", async () => {
    let requestedOffset = -1;
    const transport: TelegramVoiceTransport = {
      async getUpdates(offset) {
        requestedOffset = offset;
        return offset === 0 ? [textUpdate(7, "hi")] : [];
      },
      async sendMessage() {},
      async downloadFile() {
        throw new Error("unused");
      },
      async sendVoice() {},
    };
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(fakeStt("unused")));
    await conn.start(echoHandler);
    await conn.pollOnce();
    await conn.pollOnce();
    expect(requestedOffset).toBe(8);
    await conn.stop();
  });

  it("skips updates with neither text nor voice, but still advances the offset past them", async () => {
    const { transport, sent } = fakeTransport({
      updates: [
        { update_id: 1, message: { from: { id: 1 }, chat: { id: 1 } } }, // e.g. a sticker
        textUpdate(2, "next"),
      ],
    });
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(fakeStt("unused")));
    await conn.start(echoHandler);
    await conn.pollOnce();
    expect(sent.map((s) => s.text)).toEqual(["echo:next"]);
    await conn.stop();
  });
});

// ---------------------------------------------------------------------------
// Voice updates — through the real voice pipeline and a real handler chain
// ---------------------------------------------------------------------------

describe("TelegramVoiceConnector — voice updates", () => {
  it("downloads the voice file, transcribes it, routes through a REAL handler chain, and replies with the badge-stamped text", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { transport, sent, downloadCalls } = fakeTransport({
      updates: [voiceUpdate(1, { file_id: "file-abc", duration: 4, mime_type: "audio/ogg" })],
      files: { "file-abc": bytes },
    });

    const stt = fakeStt("what is the capital of Testland");
    const pipeline = new VoicePipeline(stt);
    const conn = new TelegramVoiceConnector(transport, pipeline);
    await conn.start(realHandlerChain());
    await conn.pollOnce();

    expect(downloadCalls).toEqual(["file-abc"]);
    expect(stt.calls).toHaveLength(1);
    expect(stt.calls[0].data).toBe(bytes);
    expect(stt.calls[0].mimeType).toBe("audio/ogg");
    expect(stt.calls[0].durationSec).toBe(4);

    expect(sent).toHaveLength(1);
    // echoEngine's mock reply embeds the transcript verbatim, followed by an
    // (honestly unverified — no STYX evidence from the mock engine) badge line.
    expect(sent[0].text).toContain("what is the capital of Testland");
    expect(sent[0].text).toContain("◻︎ unverified");
    await conn.stop();
  });

  it("a voice update becomes an InboundMessage whose text is the mock transcript when no real STT is wired", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const { transport, sent } = fakeTransport({
      updates: [voiceUpdate(1, { file_id: "f1" })],
      files: { f1: bytes },
    });
    // A deterministic fake standing in for the honest "[mock] voice note (...)" transcriber.
    const stt = fakeStt("[mock] voice note (3 bytes, sha256 abcdef123456)");
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(stt));
    await conn.start(echoHandler);
    await conn.pollOnce();

    expect(sent[0].text).toBe("echo:[mock] voice note (3 bytes, sha256 abcdef123456)");
  });

  it("sends a voice reply via sendVoice when TTS is configured, and never for a text turn", async () => {
    const bytes = new Uint8Array([1, 1, 1]);
    const { transport, sent, voiceSent } = fakeTransport({
      updates: [textUpdate(1, "typed"), voiceUpdate(2, { file_id: "f1" })],
      files: { f1: bytes },
    });
    const stt = fakeStt("spoken words");
    const tts = fakeTts();
    const pipeline = new VoicePipeline(stt, tts);
    const conn = new TelegramVoiceConnector(transport, pipeline);
    await conn.start(echoHandler);
    await conn.pollOnce();

    expect(sent.map((s) => s.text)).toEqual(["echo:typed", "echo:spoken words"]);
    expect(voiceSent).toHaveLength(1);
    expect(voiceSent[0].chatId).toBe("100");
    expect([...voiceSent[0].bytes]).toEqual([1, 3, 5, 7]);
    expect(voiceSent[0].mimeType).toBe("audio/mpeg");
    expect(tts.calls).toEqual(["echo:spoken words"]);
  });

  it("never calls sendVoice when TTS is configured but the turn was text-only", async () => {
    const { transport, sent, voiceSent } = fakeTransport({ updates: [textUpdate(1, "hi")] });
    const pipeline = new VoicePipeline(fakeStt("unused"), fakeTts());
    const conn = new TelegramVoiceConnector(transport, pipeline);
    await conn.start(echoHandler);
    await conn.pollOnce();

    expect(sent).toHaveLength(1);
    expect(voiceSent).toHaveLength(0);
  });

  it("never calls sendVoice for a voice turn when no TTS engine is configured", async () => {
    const { transport, voiceSent } = fakeTransport({
      updates: [voiceUpdate(1, { file_id: "f1" })],
      files: { f1: new Uint8Array([1]) },
    });
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(fakeStt("text")));
    await conn.start(echoHandler);
    await conn.pollOnce();
    expect(voiceSent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Poison-message resilience
// ---------------------------------------------------------------------------

describe("TelegramVoiceConnector — failure handling never crashes the poll loop", () => {
  it("a voice update missing file_id yields an honest one-line failure reply, advances the offset, and the next update in the batch still processes", async () => {
    const { transport, sent } = fakeTransport({
      updates: [voiceUpdate(1, { file_id: "" }), textUpdate(2, "still alive")],
    });
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(fakeStt("unused")));
    await conn.start(echoHandler);
    await conn.pollOnce();

    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain("couldn't process that voice message");
    expect(sent[0].text.includes("\n")).toBe(false); // one line, no stack trace
    expect(sent[0].text).not.toMatch(/at .*:\d+:\d+/); // no stack-frame-looking content
    expect(sent[1].text).toBe("echo:still alive");
  });

  it("a downloadFile failure yields an honest failure reply and does not stop subsequent updates from processing", async () => {
    const { transport, sent, downloadCalls } = fakeTransport({
      updates: [voiceUpdate(1, { file_id: "broken" }), voiceUpdate(2, { file_id: "ok" }), textUpdate(3, "tail")],
      files: { ok: new Uint8Array([1, 2, 3]) },
      downloadErrors: { broken: new Error("simulated network failure downloading from Telegram") },
    });
    const stt = fakeStt("transcribed ok");
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(stt));
    await conn.start(echoHandler);
    await conn.pollOnce();

    expect(downloadCalls).toEqual(["broken", "ok"]);
    expect(sent).toHaveLength(3);
    expect(sent[0].text).toContain("couldn't process that voice message");
    expect(sent[0].text).toContain("simulated network failure downloading from Telegram");
    expect(sent[1].text).toBe("echo:transcribed ok");
    expect(sent[2].text).toBe("echo:tail");
  });

  it("an STT failure yields an honest failure reply without crashing the loop", async () => {
    const { transport, sent } = fakeTransport({
      updates: [voiceUpdate(1, { file_id: "f1" }), textUpdate(2, "after")],
      files: { f1: new Uint8Array([1]) },
    });
    const stt: SpeechToText = {
      async transcribe() {
        throw new Error("model unavailable");
      },
    };
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(stt));
    await conn.start(echoHandler);
    await conn.pollOnce();

    expect(sent[0].text).toBe("I couldn't process that voice message: model unavailable");
    expect(sent[1].text).toBe("echo:after");
  });

  it("advances the offset past a failed voice update even though it never reached sendMessage-worthy success", async () => {
    let requestedOffset = -1;
    let call = 0;
    const transport: TelegramVoiceTransport = {
      async getUpdates(offset) {
        requestedOffset = offset;
        call++;
        return call === 1 ? [voiceUpdate(5, { file_id: "" })] : [];
      },
      async sendMessage() {},
      async downloadFile() {
        throw new Error("unused");
      },
      async sendVoice() {},
    };
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(fakeStt("unused")));
    await conn.start(echoHandler);
    await conn.pollOnce();
    await conn.pollOnce();
    expect(requestedOffset).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Mixed batches, duration/mime pass-through, send(), stop()
// ---------------------------------------------------------------------------

describe("TelegramVoiceConnector — batching, metadata, and lifecycle", () => {
  it("preserves ordering across a mixed batch of text and voice updates", async () => {
    const order: string[] = [];
    const handler = async (m: InboundMessage): Promise<OutboundReply> => {
      order.push(m.text);
      return { text: `ack:${m.text}`, accepted: true };
    };
    const { transport, sent } = fakeTransport({
      updates: [textUpdate(1, "one"), voiceUpdate(2, { file_id: "f2" }), textUpdate(3, "three")],
      files: { f2: new Uint8Array([2]) },
    });
    const stt = fakeStt("two-from-audio");
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(stt));
    await conn.start(handler);
    await conn.pollOnce();

    expect(order).toEqual(["one", "two-from-audio", "three"]);
    expect(sent.map((s) => s.text)).toEqual(["ack:one", "ack:two-from-audio", "ack:three"]);
  });

  it("passes voice duration and mime type through to the AudioRef unchanged", async () => {
    const { transport } = fakeTransport({
      updates: [voiceUpdate(1, { file_id: "f1", duration: 17, mime_type: "audio/webm" })],
      files: { f1: new Uint8Array([1, 2]) },
    });
    const stt = fakeStt("x");
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(stt));
    await conn.start(echoHandler);
    await conn.pollOnce();

    expect(stt.calls[0].durationSec).toBe(17);
    expect(stt.calls[0].mimeType).toBe("audio/webm");
  });

  it("send() delivers proactively via transport.sendMessage using channel over user", async () => {
    const { transport, sent } = fakeTransport({ updates: [] });
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(fakeStt("unused")));
    await conn.send({ user: "u1", channel: "c1" }, "proactive text");
    await conn.send({ user: "u2" }, "no channel");
    expect(sent).toEqual([
      { chatId: "c1", text: "proactive text" },
      { chatId: "u2", text: "no channel" },
    ]);
  });

  it("stop() clears the poll timer: no further handler/poll activity after stop", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = fakeTransport({ updates: [] });
      const conn = new TelegramVoiceConnector(transport, new VoicePipeline(fakeStt("unused")), { pollIntervalMs: 10 });
      const pollSpy = vi.spyOn(conn, "pollOnce");
      await conn.start(echoHandler);

      await vi.advanceTimersByTimeAsync(35);
      const callsBeforeStop = pollSpy.mock.calls.length;
      expect(callsBeforeStop).toBeGreaterThan(0);

      await conn.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(pollSpy.mock.calls.length).toBe(callsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pollOnce is a no-op once stopped (handler cleared)", async () => {
    const { transport, sent } = fakeTransport({ updates: [textUpdate(1, "late")] });
    const conn = new TelegramVoiceConnector(transport, new VoicePipeline(fakeStt("unused")));
    await conn.start(echoHandler);
    await conn.stop();
    await conn.pollOnce();
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createTelegramVoiceHttpTransport — the real Bot API transport shape
// ---------------------------------------------------------------------------

describe("createTelegramVoiceHttpTransport", () => {
  function fakeGlobalFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("downloadFile calls getFile then downloads from the file endpoint", async () => {
    const { fetchImpl, calls } = fakeGlobalFetch((url) => {
      if (url.includes("/getFile")) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/abc.oga" } }), { status: 200 });
      }
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    });
    const transport = createTelegramVoiceHttpTransport("TEST-TOKEN", fetchImpl);
    const bytes = await transport.downloadFile("file-xyz");

    expect([...bytes]).toEqual([4, 5, 6]);
    expect(calls[0].url).toContain("api.telegram.org/botTEST-TOKEN/getFile?file_id=file-xyz");
    expect(calls[1].url).toBe("https://api.telegram.org/file/botTEST-TOKEN/voice/abc.oga");
  });

  it("downloadFile throws a clear error when getFile has no file_path", async () => {
    const { fetchImpl } = fakeGlobalFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const transport = createTelegramVoiceHttpTransport("TOKEN", fetchImpl);
    await expect(transport.downloadFile("missing")).rejects.toThrow(/file_path/);
  });

  it("sendVoice posts multipart form data with chat_id and voice fields", async () => {
    const { fetchImpl, calls } = fakeGlobalFetch(() => new Response("{}", { status: 200 }));
    const transport = createTelegramVoiceHttpTransport("TOKEN", fetchImpl);
    await transport.sendVoice("chat-1", new Uint8Array([1, 2, 3]), "audio/ogg");

    expect(calls[0].url).toBe("https://api.telegram.org/botTOKEN/sendVoice");
    const form = calls[0].init!.body as FormData;
    expect(form.get("chat_id")).toBe("chat-1");
    const voiceField = form.get("voice") as Blob;
    expect(voiceField).toBeInstanceOf(Blob);
    expect(voiceField.size).toBe(3);
  });
});
