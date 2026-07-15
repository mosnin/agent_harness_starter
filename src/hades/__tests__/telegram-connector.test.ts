import { describe, it, expect } from "vitest";
import { TelegramConnector } from "../gateway/connectors/telegram";
import type { TelegramTransport, TelegramUpdate } from "../gateway/connectors/telegram";
import { ConnectorHub } from "../gateway/connector";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

/** Fake transport: queued updates drained once, sends captured. */
function fakeTransport(updates: TelegramUpdate[]): TelegramTransport & { sent: Array<{ chatId: string; text: string }> } {
  let queue = [...updates];
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    async getUpdates() {
      const batch = queue;
      queue = [];
      return batch;
    },
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
    },
  };
}

const echo = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });

describe("TelegramConnector", () => {
  it("normalizes updates, routes them, and replies via the transport", async () => {
    const transport = fakeTransport([
      { update_id: 5, message: { from: { id: 42 }, chat: { id: 100 }, text: "hello" } },
      { update_id: 6, message: { from: { id: 42 }, chat: { id: 100 }, text: "again" } },
    ]);
    const conn = new TelegramConnector(transport);
    await conn.start(echo);
    await conn.pollOnce();

    expect(transport.sent.map((s) => s.text)).toEqual(["echo:hello", "echo:again"]);
    expect(transport.sent[0].chatId).toBe("100"); // replies to the chat
    await conn.stop();
  });

  it("advances the offset so messages aren't reprocessed", async () => {
    let requestedOffset = -1;
    const transport: TelegramTransport = {
      async getUpdates(offset) {
        requestedOffset = offset;
        return offset === 0 ? [{ update_id: 7, message: { chat: { id: 1 }, from: { id: 1 }, text: "hi" } }] : [];
      },
      async sendMessage() {},
    };
    const conn = new TelegramConnector(transport);
    await conn.start(echo);
    await conn.pollOnce(); // processes update 7
    await conn.pollOnce(); // should ask for offset 8
    expect(requestedOffset).toBe(8);
    await conn.stop();
  });

  it("works through the ConnectorHub with rate limiting", async () => {
    const transport = fakeTransport([
      { update_id: 1, message: { from: { id: 9 }, chat: { id: 9 }, text: "a" } },
    ]);
    const hub = new ConnectorHub(echo);
    const conn = new TelegramConnector(transport);
    hub.register(conn);
    await hub.startAll();
    // route via the connector's own poll (hub wired the handler)
    await conn.pollOnce();
    expect(transport.sent[0].text).toBe("echo:a");
    await hub.stopAll();
  });
});
