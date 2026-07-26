import { describe, it } from "vitest";

import { assertConnectorContract } from "../gateway/connector-contract";
import type { ConnectorContractHarness } from "../gateway/connector-contract";
import type { PlatformConnector } from "../gateway/connector";

import { TelegramConnector } from "../gateway/connectors/telegram";
import type { TelegramTransport, TelegramUpdate } from "../gateway/connectors/telegram";
import { DiscordConnector } from "../gateway/connectors/discord";
import type { DiscordTransport } from "../gateway/connectors/discord";
import { SlackConnector } from "../gateway/connectors/slack";
import type { SlackTransport } from "../gateway/connectors/slack";
import { WhatsAppConnector } from "../gateway/connectors/whatsapp";
import type { WhatsAppTransport } from "../gateway/connectors/whatsapp";
import { SignalConnector } from "../gateway/connectors/signal";
import type { SignalTransport, SignalEnvelope } from "../gateway/connectors/signal";
import { EmailConnector } from "../gateway/connectors/email";
import type { EmailTransport, EmailEnvelope } from "../gateway/connectors/email";

// ---------------------------------------------------------------------------
// Six scripted-fake harnesses, one per real connector class. Each is its own
// small adapter from "assertConnectorContract's generic emitInbound/outbox
// vocabulary" to that platform's actual transport shape — no two platforms
// look alike (poll vs. webhook, chat-id vs. channel-id vs. email thread), so
// this is exactly the layer the shared contract is supposed to prove
// equivalent behavior across.
// ---------------------------------------------------------------------------

function telegramHarness(): ConnectorContractHarness {
  let queue: TelegramUpdate[] = [];
  const sent: Array<{ chatId: string; text: string }> = [];
  let nextUpdateId = 0;
  const transport: TelegramTransport = {
    async getUpdates() {
      const batch = queue;
      queue = [];
      return batch;
    },
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
    },
  };
  const connector = new TelegramConnector(transport, { pollIntervalMs: 3_600_000 });
  return {
    connector,
    outbox: () => sent.map((s) => ({ user: s.chatId, text: s.text })),
    async emitInbound(user, text, channel) {
      queue.push({
        update_id: nextUpdateId++,
        message: { from: { id: user }, chat: { id: channel ?? user }, text },
      });
      await connector.pollOnce();
      // If the connector wasn't listening (stopped), pollOnce() short-circuits
      // before ever calling getUpdates(), leaving this update stuck in the
      // fake queue where it would wrongly resurface on the NEXT poll after a
      // restart. A real bot polling a real API would only ever see it once
      // (whenever it next asks); dropping it here on a no-op poll keeps the
      // fake honest about "message arrived while stopped" rather than
      // silently replaying it later.
      queue = [];
    },
  };
}

function discordHarness(): ConnectorContractHarness {
  const sent: Array<{ channelId: string; text: string }> = [];
  const transport: DiscordTransport = {
    async createMessage(channelId, text) {
      sent.push({ channelId, text });
    },
  };
  const connector = new DiscordConnector(transport);
  return {
    connector,
    outbox: () => sent.map((s) => ({ user: s.channelId, text: s.text })),
    async emitInbound(user, text, channel) {
      await connector.ingest({ author: { id: user }, channel_id: channel ?? user, content: text });
    },
  };
}

function slackHarness(): ConnectorContractHarness {
  const sent: Array<{ channel: string; text: string }> = [];
  const transport: SlackTransport = {
    async postMessage(channel, text) {
      sent.push({ channel, text });
    },
  };
  const connector = new SlackConnector(transport);
  let eventSeq = 0;
  return {
    connector,
    outbox: () => sent.map((s) => ({ user: s.channel, text: s.text })),
    async emitInbound(user, text, channel) {
      await connector.ingest({
        type: "event_callback",
        event_id: `ev-${++eventSeq}`,
        event: { type: "message", user, text, channel: channel ?? user },
      });
    },
  };
}

function whatsAppHarness(): ConnectorContractHarness {
  const sent: Array<{ to: string; text: string }> = [];
  const transport: WhatsAppTransport = {
    async sendMessage(to, text) {
      sent.push({ to, text });
    },
  };
  const connector = new WhatsAppConnector(transport);
  return {
    connector,
    outbox: () => sent.map((s) => ({ user: s.to, text: s.text })),
    async emitInbound(user, text) {
      await connector.ingest({
        entry: [{ changes: [{ value: { messages: [{ from: user, type: "text", text: { body: text } }] } }] }],
      });
    },
  };
}

function signalHarness(): ConnectorContractHarness {
  let queue: SignalEnvelope[] = [];
  const sent: Array<{ recipient: string; text: string }> = [];
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
    outbox: () => sent.map((s) => ({ user: s.recipient, text: s.text })),
    async emitInbound(user, text) {
      queue.push({ envelope: { source: user, dataMessage: { message: text } } });
      await connector.pollOnce();
      // Same reasoning as telegram: a no-op poll (stopped) must not leave a
      // stale envelope to resurface on the next restart's poll.
      queue = [];
    },
  };
}

function emailHarness(): ConnectorContractHarness {
  const botAddress = "hades-contract@example.test";
  let queue: EmailEnvelope[] = [];
  const sent: Array<{ to: string; text: string }> = [];
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
    outbox: () => sent.map((s) => ({ user: s.to, text: s.text })),
    async emitInbound(user, text) {
      nextUid += 1;
      queue.push({
        uid: nextUid,
        messageId: `<msg-${nextUid}@contract.test>`,
        references: [],
        from: { address: user },
        to: [{ address: botAddress }],
        subject: "contract test",
        text,
      });
      await connector.pollOnce();
      // EmailConnector only advances its own high-water uid while it has a
      // handler; a message pushed while stopped is never consumed and — like
      // telegram/signal above — must not linger to double-fire on a later
      // restart poll.
      queue = [];
    },
  };
}

// ---------------------------------------------------------------------------
// One harness, six passes — the plan's "adapter contract tests per platform"
// checkpoint line.
// ---------------------------------------------------------------------------

describe("PlatformConnector contract — all six platforms", () => {
  it("telegram", async () => {
    await assertConnectorContract(telegramHarness);
  });
  it("discord", async () => {
    await assertConnectorContract(discordHarness);
  });
  it("slack", async () => {
    await assertConnectorContract(slackHarness);
  });
  it("whatsapp", async () => {
    await assertConnectorContract(whatsAppHarness);
  });
  it("signal", async () => {
    await assertConnectorContract(signalHarness);
  });
  it("email", async () => {
    await assertConnectorContract(emailHarness);
  });
});

describe("assertConnectorContract itself", () => {
  it("throws a specific, actionable error when a fake harness violates the checklist (e.g. drops messages instead of routing them)", async () => {
    let started = false;
    const broken: ConnectorContractHarness = {
      connector: {
        platform: "generic" as PlatformConnector["platform"],
        async start() {
          started = true;
        },
        async stop() {
          started = false;
        },
        async send() {
          /* no-op */
        },
      },
      outbox: () => [],
      async emitInbound() {
        if (!started) return;
        // Never calls the handler — simulates a connector that silently drops.
      },
    };

    await expect(assertConnectorContract(() => broken)).rejects.toThrow(/assertConnectorContract/);
  });

  it("throws when connector.platform is empty", async () => {
    const broken: ConnectorContractHarness = {
      connector: {
        platform: "" as unknown as PlatformConnector["platform"],
        async start() {},
        async stop() {},
        async send() {},
      },
      outbox: () => [],
      async emitInbound() {},
    };
    await expect(assertConnectorContract(() => broken)).rejects.toThrow(/non-empty string/);
  });
});
