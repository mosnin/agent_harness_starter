/**
 * The deterministic cross-platform continuity bench — Phase 7's checkpoint
 * proof: one user keeps one conversation from telegram to email.
 *
 * This wires the real gateway stack (all six {@link PlatformConnector}
 * classes, `InMemory` identity/trust stores, {@link PairingGuard},
 * {@link ContinuityRouter}, {@link BadgeStamper}, {@link AgentGatewayHandler}
 * over {@link echoEngine}, one {@link ConnectorHub}) with FAKE transports —
 * no network, no real model — and runs a short, fixed script: pair on
 * telegram, send a turn, issue a link code, redeem it on email, send a
 * second turn. Every field of {@link GatewayBenchReport} is then *measured*
 * from what actually happened during that run (session ids the turns really
 * carried, trust records the guard actually created, badges the stamper
 * actually rendered) — nothing here is asserted without being counted.
 *
 * `honest` is mandatory and hard-coded truthful: this bench never claims a
 * real transport or a real model. See gateway-bench.test.ts for the
 * "sabotage" runs (skip pairing, skip linking) that prove the measurement
 * itself — not just the happy path — actually reflects what happened.
 *
 * @module hades/gateway/gateway-bench
 */

import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";
import { InMemoryIdentityStore, IdentityLinker, ContinuityRouter } from "./continuity";
import { InMemoryTrustStore } from "./trust-store";
import { PairingGuard } from "./pairing";
import { BadgeStamper, type BadgeEvidence } from "./badge";
import { renderBadge } from "./message-format";
import { ConnectorHub } from "./connector";
import { AgentGatewayHandler, echoEngine, type GatewayAgentEngine } from "./agent-handler";

import { TelegramConnector } from "./connectors/telegram";
import type { TelegramTransport, TelegramUpdate } from "./connectors/telegram";
import { DiscordConnector } from "./connectors/discord";
import type { DiscordTransport } from "./connectors/discord";
import { SlackConnector } from "./connectors/slack";
import type { SlackTransport } from "./connectors/slack";
import { WhatsAppConnector } from "./connectors/whatsapp";
import type { WhatsAppTransport } from "./connectors/whatsapp";
import { SignalConnector } from "./connectors/signal";
import type { SignalTransport, SignalEnvelope } from "./connectors/signal";
import { EmailConnector } from "./connectors/email";
import type { EmailTransport, EmailEnvelope } from "./connectors/email";

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface GatewayBenchReport {
  platforms: string[];
  turns: number;
  pairedHandles: number;
  identities: number;
  sessionIds: string[];
  crossPlatformContinuity: boolean;
  switchedChannelFlagged: boolean;
  badges: Record<string, number>;
  durationMs: number;
  /** This bench never claims real transports or a real model — always exactly this. */
  honest: { engineMode: "mock"; transports: "fake" };
}

// ---------------------------------------------------------------------------
// Fake, in-process transports — one small harness per platform. None of
// these touch the network; each just gives us a way to push one inbound
// message through the real connector class and read back what it sent.
// ---------------------------------------------------------------------------

interface PlatformHarness {
  connector: { platform: string; start: unknown; stop: unknown; send: unknown };
  sent: { text: string }[];
  push(user: string, text: string): Promise<void>;
}

function makeTelegramHarness(): PlatformHarness & { connector: TelegramConnector } {
  const queue: TelegramUpdate[] = [];
  const sent: { chatId: string; text: string }[] = [];
  let nextUpdateId = 0;
  const transport: TelegramTransport = {
    async getUpdates(offset) {
      return queue.filter((u) => u.update_id >= offset);
    },
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
    },
  };
  const connector = new TelegramConnector(transport, { pollIntervalMs: 3_600_000 });
  return {
    connector,
    sent,
    async push(user: string, text: string): Promise<void> {
      queue.push({ update_id: nextUpdateId++, message: { from: { id: user }, chat: { id: user }, text } });
      await connector.pollOnce();
    },
  };
}

function makeDiscordHarness(): PlatformHarness & { connector: DiscordConnector } {
  const sent: { channelId: string; text: string }[] = [];
  const transport: DiscordTransport = {
    async createMessage(channelId, text) {
      sent.push({ channelId, text });
    },
  };
  const connector = new DiscordConnector(transport);
  return {
    connector,
    sent,
    async push(user: string, text: string): Promise<void> {
      await connector.ingest({ author: { id: user }, channel_id: user, content: text });
    },
  };
}

function makeSlackHarness(): PlatformHarness & { connector: SlackConnector } {
  const sent: { channel: string; text: string }[] = [];
  const transport: SlackTransport = {
    async postMessage(channel, text) {
      sent.push({ channel, text });
    },
  };
  const connector = new SlackConnector(transport);
  let eventSeq = 0;
  return {
    connector,
    sent,
    async push(user: string, text: string): Promise<void> {
      await connector.ingest({
        type: "event_callback",
        event_id: `ev-${++eventSeq}`,
        event: { type: "message", user, text, channel: user },
      });
    },
  };
}

function makeWhatsAppHarness(): PlatformHarness & { connector: WhatsAppConnector } {
  const sent: { to: string; text: string }[] = [];
  const transport: WhatsAppTransport = {
    async sendMessage(to, text) {
      sent.push({ to, text });
    },
  };
  const connector = new WhatsAppConnector(transport);
  return {
    connector,
    sent,
    async push(user: string, text: string): Promise<void> {
      await connector.ingest({
        entry: [{ changes: [{ value: { messages: [{ from: user, type: "text", text: { body: text } }] } }] }],
      });
    },
  };
}

function makeSignalHarness(): PlatformHarness & { connector: SignalConnector } {
  let queue: SignalEnvelope[] = [];
  const sent: { recipient: string; text: string }[] = [];
  const transport: SignalTransport = {
    async receive() {
      const batch = queue;
      queue = [];
      return batch;
    },
    async send(recipient, text) {
      sent.push({ recipient, text });
    },
  };
  const connector = new SignalConnector(transport, { pollIntervalMs: 3_600_000 });
  return {
    connector,
    sent,
    async push(user: string, text: string): Promise<void> {
      queue.push({ envelope: { source: user, dataMessage: { message: text } } });
      await connector.pollOnce();
    },
  };
}

function makeEmailHarness(botAddress: string): PlatformHarness & { connector: EmailConnector } {
  const queue: EmailEnvelope[] = [];
  const sent: { to: string; text: string }[] = [];
  let nextUid = 0;
  const transport: EmailTransport = {
    async poll(sinceUid) {
      return queue.filter((e) => e.uid > sinceUid);
    },
    async send(mail) {
      sent.push({ to: mail.to[0]?.address ?? "", text: mail.text });
    },
  };
  const connector = new EmailConnector(transport, { address: botAddress, pollIntervalMs: 3_600_000 });
  return {
    connector,
    sent,
    async push(fromAddress: string, text: string): Promise<void> {
      nextUid += 1;
      queue.push({
        uid: nextUid,
        messageId: `<msg-${nextUid}@bench.test>`,
        references: [],
        from: { address: fromAddress },
        to: [{ address: botAddress }],
        subject: "gateway bench",
        text,
      });
      await connector.pollOnce();
    },
  };
}

// ---------------------------------------------------------------------------
// The bench
// ---------------------------------------------------------------------------

const CONTINUATION_PREFIX = "(continuing our conversation from telegram) ";

/**
 * Run the full six-platform continuity script with fake transports and an
 * honest mock agent engine, and return a report measured (never assumed)
 * from what actually happened.
 */
export async function runGatewayBench(opts: { now?: () => number } = {}): Promise<GatewayBenchReport> {
  const now = opts.now ?? (() => Date.now());
  const start = now();

  const identities = new InMemoryIdentityStore();
  const trust = new InMemoryTrustStore();

  let linkCodeSeq = 0;
  const linker = new IdentityLinker(identities, {
    generateCode: () => `LINK-${++linkCodeSeq}`,
    now: () => 0,
  });

  let pairCodeSeq = 0;
  const guard = new PairingGuard({
    trust,
    identities,
    linker,
    now: () => 0,
    // RE_PAIR only accepts [A-Za-z0-9]{4,12} — no separators.
    generateCode: () => `PAIR${++pairCodeSeq}`,
  });

  // Measurement state: what actually happened, not what we assume happens.
  let turnsRun = 0;
  const turnSessionIds: string[] = [];
  const turnPlatforms: string[] = [];

  const baseEngine = echoEngine();
  const countingEngine: GatewayAgentEngine = {
    mode: baseEngine.mode,
    async respond(turn) {
      turnsRun += 1;
      turnSessionIds.push(turn.sessionId);
      turnPlatforms.push(turn.platform);
      return baseEngine.respond(turn);
    },
  };

  const agentHandler = new AgentGatewayHandler({ engine: countingEngine, now });

  let sessionSeq = 0;
  const router = new ContinuityRouter(identities, agentHandler.handle, {
    newSessionId: () => `sess-${++sessionSeq}`,
  });

  const guarded = guard.wrap(router.handle);

  const badgeTally: Record<string, number> = {};
  const badgeStamper = new BadgeStamper({
    render: (stamped, platform) => {
      badgeTally[stamped.badge] = (badgeTally[stamped.badge] ?? 0) + 1;
      return renderBadge(stamped, platform);
    },
  });

  // BadgeStamper.wrap requires its inner handler's declared return type to
  // carry `evidence?`; PairingGuard.wrap's declared return type doesn't
  // (evidence only ever flows through AgentGatewayHandler's replies, several
  // layers inside `guarded`). The object itself carries `evidence` at
  // runtime whenever it originated there — this cast only tells TypeScript
  // what is already true, it does not change any data.
  const topHandler = badgeStamper.wrap(
    (msg: InboundMessage) => guarded(msg) as Promise<OutboundReply & { evidence?: BadgeEvidence }>,
  );

  const hub = new ConnectorHub(topHandler);

  const telegram = makeTelegramHarness();
  const discord = makeDiscordHarness();
  const slack = makeSlackHarness();
  const whatsapp = makeWhatsAppHarness();
  const signal = makeSignalHarness();
  const email = makeEmailHarness("hades-bench@example.test");

  hub.register(telegram.connector);
  hub.register(discord.connector);
  hub.register(slack.connector);
  hub.register(whatsapp.connector);
  hub.register(signal.connector);
  hub.register(email.connector);

  await hub.startAll();

  try {
    // 1. Owner issues a pairing code; the user redeems it on telegram.
    const { code: pairCode } = guard.issuePairingCode();
    await telegram.push("tg-user-1", `/pair ${pairCode}`);

    // 2. First turn, on telegram.
    await telegram.push("tg-user-1", "hello from telegram");

    // 3. The now-trusted telegram handle issues a link code.
    await telegram.push("tg-user-1", "/link");
    const issueReplyText = telegram.sent[telegram.sent.length - 1]?.text ?? "";
    const linkMatch = issueReplyText.match(/Link code: (\S+)/);
    if (!linkMatch) {
      throw new Error(
        `runGatewayBench: telegram "/link" did not return a link code (got ${JSON.stringify(issueReplyText)}) — cannot continue the continuity script`,
      );
    }
    const linkCode = linkMatch[1];

    // 4. The same human redeems that code on email — a brand-new channel.
    await email.push("alice@example.test", `/link ${linkCode}`);

    // 5. Second turn, now on email.
    await email.push("alice@example.test", "hello from email");
  } finally {
    await hub.stopAll();
  }

  const end = now();

  const distinctSessionIds = [...new Set(turnSessionIds)];
  const distinctPlatforms = [...new Set(turnPlatforms)];
  const crossPlatformContinuity = distinctPlatforms.length >= 2 && distinctSessionIds.length === 1;

  const lastEmailReply = email.sent[email.sent.length - 1]?.text ?? "";
  const switchedChannelFlagged = lastEmailReply.includes(CONTINUATION_PREFIX);

  const pairedHandles = trust.all().filter((r) => r.level === "trusted" || r.level === "owner").length;

  return {
    platforms: hub.list().map((c) => c.platform),
    turns: turnsRun,
    pairedHandles,
    identities: identities.size(),
    sessionIds: distinctSessionIds,
    crossPlatformContinuity,
    switchedChannelFlagged,
    badges: badgeTally,
    durationMs: end - start,
    honest: { engineMode: "mock", transports: "fake" },
  };
}

// ---------------------------------------------------------------------------
// CLI formatting
// ---------------------------------------------------------------------------

/** Render a {@link GatewayBenchReport} as plain lines for a CLI to print. */
export function formatGatewayBenchReport(r: GatewayBenchReport): string[] {
  const badgeSummary =
    Object.entries(r.badges)
      .map(([badge, count]) => `${badge}=${count}`)
      .join(", ") || "(none)";

  return [
    `Gateway continuity bench — ${r.honest.engineMode} engine, ${r.honest.transports} transports`,
    `Platforms wired: ${r.platforms.join(", ") || "(none)"}`,
    `Turns executed: ${r.turns}`,
    `Paired handles: ${r.pairedHandles}`,
    `Identities: ${r.identities}`,
    `Session ids seen: ${r.sessionIds.join(", ") || "(none)"}`,
    `Cross-platform continuity: ${r.crossPlatformContinuity ? "yes" : "no"}`,
    `Switched-channel prefix flagged: ${r.switchedChannelFlagged ? "yes" : "no"}`,
    `Badges: ${badgeSummary}`,
    `Duration: ${r.durationMs}ms`,
  ];
}
