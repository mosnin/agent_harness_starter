import type { InboundMessage, OutboundReply } from "../../../swarm-runtime/gateway/gateway";
import { parseSlack } from "../../../swarm-runtime/gateway/gateway";
import type { DeliveryTarget, PlatformConnector } from "../connector";

export interface SlackTransport {
  postMessage(channel: string, text: string): Promise<void>;
}

/** A Slack Events API payload (url_verification or an event callback). */
export interface SlackEventPayload {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: { type?: string; user?: string; text?: string; channel?: string; bot_id?: string; subtype?: string };
}

/**
 * Slack connector. Slack pushes events over HTTP, so instead of polling this
 * exposes `ingest(payload)` for the app's Events-API webhook to call: it answers
 * the URL-verification challenge, ignores the bot's own / edited messages,
 * normalizes real messages via `parseSlack`, routes them, and replies through an
 * injectable `chat.postMessage` transport. Testable with a fake transport.
 */
export class SlackConnector implements PlatformConnector {
  readonly platform = "slack" as const;
  private handler?: (msg: InboundMessage) => Promise<OutboundReply>;
  private seen = new Set<string>();

  constructor(private readonly transport: SlackTransport) {}

  async start(handler: (msg: InboundMessage) => Promise<OutboundReply>): Promise<void> {
    this.handler = handler;
  }
  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async send(target: DeliveryTarget, text: string): Promise<void> {
    await this.transport.postMessage(String(target.channel ?? target.user), text);
  }

  /**
   * Handle one Events-API payload. Returns `{ challenge }` for url_verification
   * (which the webhook must echo), otherwise `{ ok: true }` after processing.
   */
  async ingest(payload: SlackEventPayload): Promise<{ challenge?: string; ok?: boolean }> {
    if (payload.type === "url_verification") return { challenge: payload.challenge };
    // Slack retries deliver a duplicate event_id — dedupe.
    if (payload.event_id) {
      if (this.seen.has(payload.event_id)) return { ok: true };
      this.seen.add(payload.event_id);
    }
    const e = payload.event;
    // Ignore non-messages, the bot's own messages, and edits/joins (subtypes).
    if (!this.handler || !e || e.type !== "message" || e.bot_id || e.subtype || !e.text) return { ok: true };

    const msg = parseSlack({ event: e });
    const reply = await this.handler(msg);
    if (reply.text) await this.transport.postMessage(msg.channel ?? msg.user, reply.text);
    return { ok: true };
  }
}

/** Real HTTP transport for Slack's Web API (chat.postMessage). */
export function createSlackHttpTransport(botToken: string, fetchImpl: typeof fetch = fetch): SlackTransport {
  return {
    async postMessage(channel, text) {
      await fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${botToken}` },
        body: JSON.stringify({ channel, text }),
      });
    },
  };
}
