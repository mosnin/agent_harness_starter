import { describe, it, expect } from "vitest";
import { DiscordConnector } from "../gateway/connectors/discord";
import type { DiscordTransport } from "../gateway/connectors/discord";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

function fakeTransport(): DiscordTransport & { sent: Array<{ channelId: string; text: string }> } {
  const sent: Array<{ channelId: string; text: string }> = [];
  return { sent, async createMessage(channelId, text) { sent.push({ channelId, text }); } };
}

const echo = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });

describe("DiscordConnector", () => {
  it("routes a message and replies in the same channel", async () => {
    const t = fakeTransport();
    const conn = new DiscordConnector(t);
    await conn.start(echo);
    await conn.ingest({ author: { id: "U1" }, channel_id: "C9", content: "yo" });
    expect(t.sent).toEqual([{ channelId: "C9", text: "echo:yo" }]);
  });

  it("ignores bot authors and empty content", async () => {
    const t = fakeTransport();
    const conn = new DiscordConnector(t);
    await conn.start(echo);
    await conn.ingest({ author: { id: "B", bot: true }, channel_id: "C1", content: "loop" });
    await conn.ingest({ author: { id: "U1" }, channel_id: "C1", content: "  " });
    expect(t.sent).toHaveLength(0);
  });

  it("send() delivers proactively", async () => {
    const t = fakeTransport();
    const conn = new DiscordConnector(t);
    await conn.send({ user: "U1", channel: "C5" }, "hello");
    expect(t.sent[0]).toEqual({ channelId: "C5", text: "hello" });
  });
});
