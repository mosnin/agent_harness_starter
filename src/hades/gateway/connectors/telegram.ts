import type { InboundMessage, OutboundReply } from "../../../swarm-runtime/gateway/gateway";
import { parseTelegram } from "../../../swarm-runtime/gateway/gateway";
import type { DeliveryTarget, PlatformConnector } from "../connector";

export interface TelegramUpdate {
  update_id: number;
  message?: { from?: { id?: number | string }; chat?: { id?: number | string }; text?: string };
}

/** Injectable transport — the only thing that talks to Telegram's API. */
export interface TelegramTransport {
  /** Fetch updates newer than `offset` (Bot API getUpdates). */
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
}

export interface TelegramConnectorOptions {
  pollIntervalMs?: number;
}

/**
 * Telegram bot connector. Long-polls `getUpdates`, normalizes each message to an
 * {@link InboundMessage}, routes it through the handler, and replies via
 * `sendMessage`. All network I/O lives behind {@link TelegramTransport}, so the
 * connector is fully testable with a fake transport — no bot token required.
 */
export class TelegramConnector implements PlatformConnector {
  readonly platform = "telegram" as const;
  private handler?: (msg: InboundMessage) => Promise<OutboundReply>;
  private offset = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly transport: TelegramTransport,
    private readonly opts: TelegramConnectorOptions = {}
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
    const updates = await this.transport.getUpdates(this.offset);
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      if (!u.message?.text) continue;
      const msg = parseTelegram({ message: u.message });
      const reply = await this.handler(msg);
      if (reply.text) await this.transport.sendMessage(msg.channel ?? msg.user, reply.text);
    }
  }
}

/** Real HTTP transport for the Telegram Bot API (uses global fetch). */
export function createTelegramHttpTransport(token: string, fetchImpl: typeof fetch = fetch): TelegramTransport {
  const base = `https://api.telegram.org/bot${token}`;
  return {
    async getUpdates(offset) {
      const res = await fetchImpl(`${base}/getUpdates?offset=${offset}&timeout=25`);
      const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
      return data.result ?? [];
    },
    async sendMessage(chatId, text) {
      await fetchImpl(`${base}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    },
  };
}
