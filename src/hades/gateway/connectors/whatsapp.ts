import type { InboundMessage, OutboundReply } from "../../../swarm-runtime/gateway/gateway";
import type { DeliveryTarget, PlatformConnector } from "../connector";

export interface WhatsAppTransport {
  /** Send a text message to a WhatsApp number (E.164, no +). */
  sendMessage(to: string, text: string): Promise<void>;
}

/** A WhatsApp Cloud API webhook payload. */
export interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{ from?: string; type?: string; text?: { body?: string } }>;
      };
    }>;
  }>;
}

export interface WhatsAppConnectorOptions {
  /** Token that must match `hub.verify_token` on the GET verification handshake. */
  verifyToken?: string;
}

/** Normalize a WhatsApp text message to the platform-agnostic shape. */
export function parseWhatsApp(from: string, body: string): InboundMessage {
  return { platform: "whatsapp", user: from, channel: from, text: body };
}

/**
 * WhatsApp Cloud API connector. Meta posts inbound messages to a webhook and
 * requires a GET verification handshake first; `verify()` answers that and
 * `ingest()` walks the entry→changes→messages envelope, handling only text
 * messages (ignoring delivery/read status events), routing them, and replying
 * via an injectable send transport. Testable without a Meta app.
 */
export class WhatsAppConnector implements PlatformConnector {
  readonly platform = "whatsapp" as const;
  private handler?: (msg: InboundMessage) => Promise<OutboundReply>;

  constructor(
    private readonly transport: WhatsAppTransport,
    private readonly opts: WhatsAppConnectorOptions = {}
  ) {}

  async start(handler: (msg: InboundMessage) => Promise<OutboundReply>): Promise<void> {
    this.handler = handler;
  }
  async stop(): Promise<void> {
    this.handler = undefined;
  }
  async send(target: DeliveryTarget, text: string): Promise<void> {
    await this.transport.sendMessage(String(target.channel ?? target.user), text);
  }

  /** GET webhook verification: echo the challenge iff the verify token matches. */
  verify(mode: string, token: string, challenge: string): string | null {
    if (mode === "subscribe" && this.opts.verifyToken && token === this.opts.verifyToken) return challenge;
    return null;
  }

  /** Process an inbound webhook POST body. */
  async ingest(payload: WhatsAppWebhookPayload): Promise<void> {
    if (!this.handler) return;
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          if (m.type !== "text" || !m.from || !m.text?.body) continue;
          const msg = parseWhatsApp(m.from, m.text.body);
          const reply = await this.handler(msg);
          if (reply.text) await this.transport.sendMessage(m.from, reply.text);
        }
      }
    }
  }
}

/** Real HTTP transport for the WhatsApp Cloud API (uses global fetch). */
export function createWhatsAppHttpTransport(
  phoneNumberId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): WhatsAppTransport {
  return {
    async sendMessage(to, text) {
      await fetchImpl(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
      });
    },
  };
}
