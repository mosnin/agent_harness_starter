import { describe, it, expect } from "vitest";
import { SlackConnector } from "../gateway/connectors/slack";
import type { SlackTransport } from "../gateway/connectors/slack";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

function fakeTransport(): SlackTransport & { sent: Array<{ channel: string; text: string }> } {
  const sent: Array<{ channel: string; text: string }> = [];
  return { sent, async postMessage(channel, text) { sent.push({ channel, text }); } };
}

const echo = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });

describe("SlackConnector", () => {
  it("answers the url_verification challenge", async () => {
    const conn = new SlackConnector(fakeTransport());
    await conn.start(echo);
    const res = await conn.ingest({ type: "url_verification", challenge: "abc123" });
    expect(res.challenge).toBe("abc123");
  });

  it("routes a message event and posts a reply", async () => {
    const t = fakeTransport();
    const conn = new SlackConnector(t);
    await conn.start(echo);
    await conn.ingest({ event: { type: "message", user: "U1", text: "hi", channel: "C1" } });
    expect(t.sent).toEqual([{ channel: "C1", text: "echo:hi" }]);
  });

  it("ignores the bot's own and edited messages", async () => {
    const t = fakeTransport();
    const conn = new SlackConnector(t);
    await conn.start(echo);
    await conn.ingest({ event: { type: "message", bot_id: "B1", text: "loop", channel: "C1" } });
    await conn.ingest({ event: { type: "message", subtype: "message_changed", text: "edit", channel: "C1" } });
    expect(t.sent).toHaveLength(0);
  });

  it("dedupes retried events by event_id", async () => {
    const t = fakeTransport();
    const conn = new SlackConnector(t);
    await conn.start(echo);
    const payload = { event_id: "Ev1", event: { type: "message", user: "U1", text: "x", channel: "C1" } };
    await conn.ingest(payload);
    await conn.ingest(payload); // retry → ignored
    expect(t.sent).toHaveLength(1);
  });
});
