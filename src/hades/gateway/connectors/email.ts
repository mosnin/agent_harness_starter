/**
 * Email connector: threaded conversations over IMAP-poll inbound + SMTP
 * outbound. Real when HADES_EMAIL_* credentials are present, honestly
 * offline otherwise (see {@link createEmailEnvTransport}), and fully
 * deterministic under test via a fake {@link EmailTransport} (or, one layer
 * down, a fake {@link TextSocketFactory} exercising the real SMTP/IMAP
 * clients without any network).
 */
import type { InboundMessage, OutboundReply, GatewayPlatform } from "../../../swarm-runtime/gateway/gateway";
import type { DeliveryTarget, PlatformConnector } from "../connector";
import { parseMessage, buildMessage } from "./email-mime";
import { SmtpClient } from "./smtp-client";
import { ImapClient } from "./imap-client";
import type { TextSocketFactory } from "./smtp-client";
import { nodeTlsSocketFactory } from "./smtp-client";

/** "email" is a first-class member of the central `GatewayPlatform` union (gateway.ts) — no cast needed. */
export const EMAIL_PLATFORM: GatewayPlatform = "email";

export interface EmailAddress {
  name?: string;
  address: string;
}

/** A normalized inbound message pulled off the mailbox. */
export interface EmailEnvelope {
  uid: number;
  messageId: string;
  inReplyTo?: string;
  references: string[];
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  text: string;
  date?: number;
}

/** A message to send out (reply or fresh thread). */
export interface OutgoingEmail {
  to: EmailAddress[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}

/** Injectable transport — the only thing that talks to a real mailbox. */
export interface EmailTransport {
  /** Envelopes with uid strictly greater than `sinceUid`. */
  poll(sinceUid: number): Promise<EmailEnvelope[]>;
  send(mail: OutgoingEmail): Promise<void>;
}

export interface EmailConnectorOptions {
  /** This mailbox's own address — used to detect (and skip) self-sent mail. */
  address: string;
  pollIntervalMs?: number;
  now?: () => number;
}

interface ThreadState {
  subject: string;
  messageId: string;
  references: string[];
}

/**
 * Email connector. Polls an {@link EmailTransport} for new mail, normalizes
 * each message to an {@link InboundMessage} keyed by RFC5322 thread (the
 * first References entry, falling back to In-Reply-To, falling back to the
 * message's own Message-ID), routes it through the handler, and replies with
 * correct `Re:`/In-Reply-To/References threading. Self-sent mail is skipped
 * so a reply can never trigger itself.
 */
export class EmailConnector implements PlatformConnector {
  readonly platform = EMAIL_PLATFORM;
  private handler?: (msg: InboundMessage) => Promise<OutboundReply>;
  private timer?: ReturnType<typeof setInterval>;
  private highWaterUid = 0;
  private readonly threadsByChannel = new Map<string, ThreadState>();

  constructor(
    private readonly transport: EmailTransport,
    private readonly opts: EmailConnectorOptions
  ) {}

  async start(handler: (msg: InboundMessage) => Promise<OutboundReply>): Promise<void> {
    this.handler = handler;
    this.timer = setInterval(() => void this.pollOnce(), this.opts.pollIntervalMs ?? 30_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.handler = undefined;
  }

  async send(target: DeliveryTarget, text: string): Promise<void> {
    const thread = target.channel ? this.threadsByChannel.get(target.channel) : undefined;
    const mail: OutgoingEmail = {
      to: [{ address: target.user }],
      subject: thread ? rePrefix(thread.subject) : "",
      text,
      inReplyTo: thread?.messageId,
      references: thread?.references,
    };
    await this.transport.send(mail);
  }

  /** Drain one batch of new mail. Public so tests can drive it deterministically, without timers. */
  async pollOnce(): Promise<void> {
    if (!this.handler) return;
    const envelopes = await this.transport.poll(this.highWaterUid);
    for (const env of envelopes) {
      this.highWaterUid = Math.max(this.highWaterUid, env.uid);

      if (env.from.address.toLowerCase() === this.opts.address.toLowerCase()) {
        continue; // our own reply looping back through the mailbox — never re-trigger on it
      }

      const channel = threadKeyFor(env);
      this.threadsByChannel.set(channel, {
        subject: env.subject,
        messageId: env.messageId,
        references: [...env.references, env.messageId],
      });

      const msg: InboundMessage = {
        platform: EMAIL_PLATFORM,
        user: env.from.address.toLowerCase(),
        channel,
        text: env.text === "" ? env.subject : env.text,
      };

      const reply = await this.handler(msg);
      if (reply.text) await this.send({ user: msg.user, channel }, reply.text);
    }
  }
}

function threadKeyFor(env: EmailEnvelope): string {
  if (env.references.length > 0) return env.references[0];
  if (env.inReplyTo) return env.inReplyTo;
  return env.messageId;
}

function rePrefix(subject: string): string {
  return /^re:\s*/i.test(subject) ? subject : `Re: ${subject}`;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function generateMessageId(address: string, now: () => number): string {
  const domain = address.split("@")[1] || "localhost";
  const rand = Math.random().toString(36).slice(2, 10);
  return `<${now()}.${rand}@${domain}>`;
}

const REQUIRED_EMAIL_ENV_VARS = ["HADES_EMAIL_ADDRESS", "HADES_EMAIL_IMAP_HOST", "HADES_EMAIL_SMTP_HOST", "HADES_EMAIL_USER", "HADES_EMAIL_PASS"] as const;

/**
 * Build a real {@link EmailTransport} from `HADES_EMAIL_*` env vars, or
 * honestly report "offline" (naming only the missing VARIABLE NAMES, never
 * key material) when any required var is absent. Never fabricates a mailbox.
 */
export function createEmailEnvTransport(
  env: Record<string, string | undefined>,
  socketFactory?: TextSocketFactory
): { transport?: EmailTransport; mode: "real" | "offline"; reason?: string; address?: string } {
  const missing = REQUIRED_EMAIL_ENV_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    return { mode: "offline", reason: `Email connector offline: missing ${missing.join(", ")}` };
  }

  const address = env.HADES_EMAIL_ADDRESS as string;
  const imapHost = env.HADES_EMAIL_IMAP_HOST as string;
  const smtpHost = env.HADES_EMAIL_SMTP_HOST as string;
  const user = env.HADES_EMAIL_USER as string;
  const pass = env.HADES_EMAIL_PASS as string;
  const imapPort = parsePort(env.HADES_EMAIL_IMAP_PORT, 993);
  const smtpPort = parsePort(env.HADES_EMAIL_SMTP_PORT, 465);
  const factory = socketFactory ?? nodeTlsSocketFactory();
  const now = () => Date.now();

  const imap = new ImapClient({ host: imapHost, port: imapPort, user, pass, socketFactory: factory });
  const smtp = new SmtpClient({ host: smtpHost, port: smtpPort, user, pass, socketFactory: factory });

  const transport: EmailTransport = {
    async poll(sinceUid) {
      const fetched = await imap.fetchNewer(sinceUid);
      const envelopes = fetched.map(({ uid, raw }) => ({ uid, ...parseMessage(raw) }));
      return envelopes.sort((a, b) => a.uid - b.uid);
    },
    async send(mail) {
      const messageId = generateMessageId(address, now);
      const raw = buildMessage({ from: { address }, mail, messageId, date: new Date(now()) });
      await smtp.sendMail(address, { ...mail, raw });
    },
  };

  return { transport, mode: "real", address };
}
