import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

/** A reference to an audio clip (URL, inline bytes, or both). */
export interface AudioRef {
  url?: string;
  data?: Uint8Array;
  mimeType?: string;
  durationSec?: number;
}

/** Injectable speech-to-text (Whisper, Deepgram, a local model, …). */
export interface SpeechToText {
  transcribe(audio: AudioRef): Promise<string>;
}

/** Injectable text-to-speech for spoken replies (optional). */
export interface TextToSpeech {
  synthesize(text: string): Promise<AudioRef>;
}

/** An inbound turn that may be text, voice, or both. */
export interface VoiceInbound {
  base: Omit<InboundMessage, "text">;
  text?: string;
  audio?: AudioRef;
}

export interface VoiceReply extends OutboundReply {
  audio?: AudioRef;
}

/**
 * Voice pipeline — the "voice memo transcription" capability. It transcribes an
 * inbound audio clip to text before the message reaches the swarm, and (if a TTS
 * engine is provided) can render the reply back to speech. Both ends are
 * injectable, so the whole flow tests with mock STT/TTS — no audio backend
 * needed — while production plugs in Whisper/Deepgram + a TTS voice.
 */
export class VoicePipeline {
  constructor(
    private readonly stt: SpeechToText,
    private readonly tts?: TextToSpeech
  ) {}

  async transcribe(audio: AudioRef): Promise<string> {
    return this.stt.transcribe(audio);
  }

  /** Render a text reply to speech, or undefined if no TTS is configured. */
  async speak(text: string): Promise<AudioRef | undefined> {
    return this.tts ? this.tts.synthesize(text) : undefined;
  }

  /**
   * Wrap a text handler into a voice-aware one: inbound audio is transcribed to
   * text first, and if the original turn was voice, the reply is also spoken.
   */
  voiceHandler(
    handler: (msg: InboundMessage) => Promise<OutboundReply>
  ): (input: VoiceInbound) => Promise<VoiceReply> {
    return async (input: VoiceInbound): Promise<VoiceReply> => {
      const wasVoice = !!input.audio;
      const text = input.text ?? (input.audio ? await this.transcribe(input.audio) : "");
      const msg: InboundMessage = { ...input.base, text } as InboundMessage;
      const reply = await handler(msg);
      // Speak the reply back only when the user spoke to us.
      const audio = wasVoice && reply.text ? await this.speak(reply.text) : undefined;
      return { ...reply, ...(audio ? { audio } : {}) };
    };
  }
}
