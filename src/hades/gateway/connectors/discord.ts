import type { InboundMessage, OutboundReply } from "../../../swarm-runtime/gateway/gateway";
import { parseDiscord } from "../../../swarm-runtime/gateway/gateway";
import type { DeliveryTarget, PlatformConnector } from "../connector";

export interface DiscordTransport {
  createMessage(channelId: string, text: string): Promise<void>;
}

/** A Discord gateway MESSAGE_CREATE dispatch (or the inner message object). */
export interface DiscordMessagePayload {
  author?: { id?: string; bot?: boolean };
  channel_id?: string;
  content?: string;
}

/**
 * Discord connector. Discord pushes MESSAGE_CREATE events over its gateway/
 * webhook; `ingest(payload)` normalizes them (skipping bot authors and empty
 * content) via `parseDiscord`, routes them, and replies through an injectable
 * `createMessage` transport. Testable with a fake transport.
 */
export class DiscordConnector implements PlatformConnector {
  readonly platform = "discord" as const;
  private handler?: (msg: InboundMessage) => Promise<OutboundReply>;

  constructor(private readonly transport: DiscordTransport) {}

  async start(handler: (msg: InboundMessage) => Promise<OutboundReply>): Promise<void> {
    this.handler = handler;
  }
  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async send(target: DeliveryTarget, text: string): Promise<void> {
    await this.transport.createMessage(String(target.channel ?? target.user), text);
  }

  /** Process one MESSAGE_CREATE payload. */
  async ingest(payload: DiscordMessagePayload): Promise<void> {
    if (!this.handler || payload.author?.bot || !payload.content?.trim()) return;
    const msg = parseDiscord(payload);
    const reply = await this.handler(msg);
    if (reply.text) await this.transport.createMessage(msg.channel ?? msg.user, reply.text);
  }
}

/** Real HTTP transport for the Discord REST API (create-message). */
export function createDiscordHttpTransport(botToken: string, fetchImpl: typeof fetch = fetch): DiscordTransport {
  return {
    async createMessage(channelId, text) {
      await fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bot ${botToken}` },
        body: JSON.stringify({ content: text }),
      });
    },
  };
}
