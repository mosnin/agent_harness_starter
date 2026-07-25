/**
 * Voice-capable Telegram connector — Phase 8's "voice memo -> transcript ->
 * agent -> optional TTS reply" running on a real platform.
 *
 * {@link TelegramVoiceConnector} mirrors {@link "./telegram".TelegramConnector}'s
 * shape exactly for text: long-poll `getUpdates`, `parseTelegram` the
 * update, hand it to the shared handler chain, `sendMessage` the reply. The
 * only new behavior is what happens when an update carries a Telegram
 * `voice` note instead of `text`: the connector downloads the raw bytes via
 * {@link TelegramVoiceTransport.downloadFile}, wraps the shared handler in
 * `pipeline.voiceHandler(...)` (see `../voice`) so the audio is transcribed
 * before the handler ever sees it, sends the reply text back, and — only
 * when the reply actually carries synthesized audio (the turn was voice AND
 * the pipeline has a TTS engine configured) — also calls
 * {@link TelegramVoiceTransport.sendVoice}.
 *
 * A failure anywhere in that voice leg (download, transcription, TTS) is
 * caught locally and reported to the user as one honest, stack-trace-free
 * line — it never crashes the poll loop, and the offset still advances past
 * the failed update so a single poison voice note can never wedge every
 * update behind it.
 *
 * @module hades/gateway/connectors/telegram-voice
 */

import type { InboundMessage, OutboundReply } from "../../../swarm-runtime/gateway/gateway";
import { parseTelegram } from "../../../swarm-runtime/gateway/gateway";
import type { DeliveryTarget, PlatformConnector } from "../connector";
import type { TelegramTransport, TelegramUpdate } from "./telegram";
import type { AudioRef, VoiceReply } from "../voice";
import { VoicePipeline } from "../voice";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A Telegram update that may additionally carry a `voice` note. */
export interface TelegramVoiceUpdate extends TelegramUpdate {
  message?: TelegramUpdate["message"] & {
    voice?: { file_id: string; duration?: number; mime_type?: string };
  };
}

/** {@link TelegramTransport} extended with the two operations voice notes need. */
export interface TelegramVoiceTransport extends TelegramTransport {
  /** Download a Telegram file's raw bytes given its `file_id` (Bot API `getFile` + file download). */
  downloadFile(fileId: string): Promise<Uint8Array>;
  /** Send a voice reply (Bot API `sendVoice`). */
  sendVoice(chatId: string, audio: Uint8Array, mimeType?: string): Promise<void>;
}

export interface TelegramVoiceConnectorOptions {
  pollIntervalMs?: number;
}

const VOICE_FAILURE_TEXT = "I couldn't process that voice message";

// ---------------------------------------------------------------------------
// TelegramVoiceConnector
// ---------------------------------------------------------------------------

/**
 * Voice-capable Telegram connector. Long-polls `getUpdates` exactly like
 * {@link "./telegram".TelegramConnector}; text updates flow through the
 * shared handler unchanged, and `voice` updates flow through
 * `pipeline.voiceHandler(handler)` instead. All network/audio I/O is behind
 * {@link TelegramVoiceTransport}, so the whole thing is testable with a fake
 * transport and a fake/mocked {@link VoicePipeline} — no bot token or audio
 * backend required.
 */
export class TelegramVoiceConnector implements PlatformConnector {
  readonly platform = "telegram" as const;
  private handler?: (msg: InboundMessage) => Promise<OutboundReply>;
  private offset = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly transport: TelegramVoiceTransport,
    private readonly pipeline: VoicePipeline,
    private readonly opts: TelegramVoiceConnectorOptions = {},
  ) {}

  async start(handler: (msg: InboundMessage) => Promise<OutboundReply>): Promise<void> {
    this.handler = handler;
    this.timer = setInterval(() => void this.pollOnce(), this.opts.pollIntervalMs ?? 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.handler = undefined;
  }

  async send(target: DeliveryTarget, text: string): Promise<void> {
    await this.transport.sendMessage(String(target.channel ?? target.user), text);
  }

  /** Drain one batch of updates. Public so tests can drive it deterministically. */
  async pollOnce(): Promise<void> {
    if (!this.handler) return;
    const updates: TelegramVoiceUpdate[] = await this.transport.getUpdates(this.offset);

    for (const u of updates) {
      // Offset advances past every update seen this batch — including ones
      // this loop goes on to skip — exactly like TelegramConnector, so a
      // skipped or poison update is never re-delivered on the next poll.
      this.offset = Math.max(this.offset, u.update_id + 1);

      const message = u.message;
      if (!message) continue;

      if (message.voice) {
        await this.handleVoiceUpdate(message, message.voice);
        continue;
      }

      if (!message.text) continue;
      const msg = parseTelegram({ message });
      const reply = await this.handler(msg);
      if (reply.text) await this.transport.sendMessage(msg.channel ?? msg.user, reply.text);
    }
  }

  /** Handle one `voice`-bearing update: download, transcribe, route, reply — never throws. */
  private async handleVoiceUpdate(
    message: NonNullable<TelegramVoiceUpdate["message"]>,
    voice: NonNullable<NonNullable<TelegramVoiceUpdate["message"]>["voice"]>,
  ): Promise<void> {
    const { text: _discardedText, ...base } = parseTelegram({ message });
    const chatId = base.channel ?? base.user;

    try {
      if (!voice.file_id) {
        throw new Error("voice message is missing a file_id");
      }

      const data = await this.transport.downloadFile(voice.file_id);
      const audio: AudioRef = { data, mimeType: voice.mime_type, durationSec: voice.duration };

      const voiceHandler = this.pipeline.voiceHandler(this.handler!);
      const reply: VoiceReply = await voiceHandler({ base, audio });

      if (reply.text) await this.transport.sendMessage(chatId, reply.text);
      if (reply.audio?.data) await this.transport.sendVoice(chatId, reply.audio.data, reply.audio.mimeType);
    } catch (err) {
      // One honest line, never a stack trace, and never fatal to the poll loop.
      const reason = err instanceof Error ? err.message : String(err);
      await this.transport.sendMessage(chatId, `${VOICE_FAILURE_TEXT}: ${reason}`);
    }
  }
}

// ---------------------------------------------------------------------------
// createTelegramVoiceHttpTransport — the real Bot API transport
// ---------------------------------------------------------------------------

/** Real HTTP transport for the Telegram Bot API, voice-capable (uses global fetch). */
export function createTelegramVoiceHttpTransport(
  token: string,
  fetchImpl: typeof fetch = fetch,
): TelegramVoiceTransport {
  const base = `https://api.telegram.org/bot${token}`;
  const fileBase = `https://api.telegram.org/file/bot${token}`;

  return {
    async getUpdates(offset) {
      const res = await fetchImpl(`${base}/getUpdates?offset=${offset}&timeout=25`);
      const data = (await res.json()) as { ok: boolean; result?: TelegramVoiceUpdate[] };
      return data.result ?? [];
    },
    async sendMessage(chatId, text) {
      await fetchImpl(`${base}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    },
    async downloadFile(fileId) {
      const metaRes = await fetchImpl(`${base}/getFile?file_id=${encodeURIComponent(fileId)}`);
      if (!metaRes.ok) {
        throw new Error(`Telegram getFile failed: HTTP ${metaRes.status} for file_id ${fileId}`);
      }
      const meta = (await metaRes.json()) as { ok: boolean; result?: { file_path?: string } };
      const filePath = meta.result?.file_path;
      if (!filePath) {
        throw new Error(`Telegram getFile returned no file_path for file_id ${fileId}`);
      }
      const fileRes = await fetchImpl(`${fileBase}/${filePath}`);
      if (!fileRes.ok) {
        throw new Error(`Telegram file download failed: HTTP ${fileRes.status} for ${filePath}`);
      }
      return new Uint8Array(await fileRes.arrayBuffer());
    },
    async sendVoice(chatId, audio, mimeType) {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("voice", new Blob([audio as unknown as BlobPart], { type: mimeType ?? "audio/ogg" }), "voice-reply.ogg");
      await fetchImpl(`${base}/sendVoice`, { method: "POST", body: form });
    },
  };
}
