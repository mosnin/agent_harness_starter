import { describe, it, expect } from "vitest";
import { VoicePipeline } from "../gateway/voice";
import type { AudioRef, SpeechToText, TextToSpeech } from "../gateway/voice";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

function fakeStt(transcript: string): SpeechToText & { calls: AudioRef[] } {
  const calls: AudioRef[] = [];
  return {
    calls,
    async transcribe(audio) {
      calls.push(audio);
      return transcript;
    },
  };
}

function fakeTts(): TextToSpeech & { spoken: string[] } {
  const spoken: string[] = [];
  return {
    spoken,
    async synthesize(text) {
      spoken.push(text);
      return { url: `tts://${encodeURIComponent(text)}`, mimeType: "audio/ogg" };
    },
  };
}

const base: Omit<InboundMessage, "text"> = { platform: "telegram", user: "u1", channel: "c1" };
const echo = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });

describe("VoicePipeline", () => {
  it("transcribes inbound audio and speaks the reply back", async () => {
    const stt = fakeStt("hello there");
    const tts = fakeTts();
    const pipe = new VoicePipeline(stt, tts);
    const handler = pipe.voiceHandler(echo);

    const reply = await handler({ base, audio: { url: "blob://abc" } });

    expect(stt.calls).toHaveLength(1);
    expect(stt.calls[0].url).toBe("blob://abc");
    expect(reply.text).toBe("echo:hello there");
    expect(tts.spoken).toEqual(["echo:hello there"]);
    expect(reply.audio?.url).toBe("tts://echo%3Ahello%20there");
  });

  it("does not speak a reply for a text-only inbound turn", async () => {
    const stt = fakeStt("unused");
    const tts = fakeTts();
    const pipe = new VoicePipeline(stt, tts);
    const handler = pipe.voiceHandler(echo);

    const reply = await handler({ base, text: "typed message" });

    expect(stt.calls).toHaveLength(0);
    expect(reply.text).toBe("echo:typed message");
    expect(tts.spoken).toHaveLength(0);
    expect(reply.audio).toBeUndefined();
  });

  it("prefers provided text over transcription when both are present", async () => {
    const stt = fakeStt("from audio");
    const pipe = new VoicePipeline(stt);
    const handler = pipe.voiceHandler(echo);

    const reply = await handler({ base, text: "from text", audio: { url: "blob://x" } });

    expect(stt.calls).toHaveLength(0);
    expect(reply.text).toBe("echo:from text");
  });

  it("omits reply audio when no TTS engine is configured", async () => {
    const stt = fakeStt("spoke");
    const pipe = new VoicePipeline(stt);
    const handler = pipe.voiceHandler(echo);

    const reply = await handler({ base, audio: { url: "blob://y" } });

    expect(reply.text).toBe("echo:spoke");
    expect(reply.audio).toBeUndefined();
    expect(await pipe.speak("anything")).toBeUndefined();
  });
});
