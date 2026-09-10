import { describe, it, expect } from "vitest";
import { WhatsAppConnector } from "../gateway/connectors/whatsapp";
import type { WhatsAppTransport } from "../gateway/connectors/whatsapp";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

function fakeTransport(): WhatsAppTransport & { sent: Array<{ to: string; text: string }> } {
  const sent: Array<{ to: string; text: string }> = [];
  return { sent, async sendMessage(to, text) { sent.push({ to, text }); } };
}

const echo = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });

function textMessage(from: string, body: string) {
  return { entry: [{ changes: [{ value: { messages: [{ from, type: "text", text: { body } }] } }] }] };
}

describe("WhatsAppConnector", () => {
  it("verifies the webhook challenge with the right token", () => {
    const conn = new WhatsAppConnector(fakeTransport(), { verifyToken: "s3cret" });
    expect(conn.verify("subscribe", "s3cret", "chal")).toBe("chal");
    expect(conn.verify("subscribe", "wrong", "chal")).toBeNull();
  });

  it("routes a text message and replies to the sender", async () => {
    const t = fakeTransport();
    const conn = new WhatsAppConnector(t);
    await conn.start(echo);
    await conn.ingest(textMessage("15551234567", "hi"));
    expect(t.sent).toEqual([{ to: "15551234567", text: "echo:hi" }]);
  });

  it("ignores status/non-text events", async () => {
    const t = fakeTransport();
    const conn = new WhatsAppConnector(t);
    await conn.start(echo);
    await conn.ingest({ entry: [{ changes: [{ value: { messages: [{ from: "1", type: "image" }] } }] }] });
    await conn.ingest({ entry: [{ changes: [{ value: {} }] }] }); // status event, no messages
    expect(t.sent).toHaveLength(0);
  });
});
