import { describe, it, expect } from "vitest";
import { SignalConnector } from "../gateway/connectors/signal";
import type { SignalTransport, SignalEnvelope } from "../gateway/connectors/signal";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

function fakeTransport(envelopes: SignalEnvelope[]): SignalTransport & { sent: Array<{ to: string; text: string }> } {
  let queue = [...envelopes];
  const sent: Array<{ to: string; text: string }> = [];
  return {
    sent,
    async receive() { const b = queue; queue = []; return b; },
    async send(recipient, text) { sent.push({ to: recipient, text }); },
  };
}

const echo = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });

describe("SignalConnector", () => {
  it("routes data messages and replies to the source", async () => {
    const t = fakeTransport([
      { envelope: { source: "+15550001", dataMessage: { message: "hi" } } },
      { envelope: { sourceNumber: "+15550002", dataMessage: { message: "yo" } } },
    ]);
    const conn = new SignalConnector(t);
    await conn.start(echo);
    await conn.pollOnce();
    expect(t.sent).toEqual([
      { to: "+15550001", text: "echo:hi" },
      { to: "+15550002", text: "echo:yo" },
    ]);
    await conn.stop();
  });

  it("skips receipts and empty envelopes", async () => {
    const t = fakeTransport([
      { envelope: { source: "+1", dataMessage: {} } }, // no message
      { envelope: {} }, // empty
    ]);
    const conn = new SignalConnector(t);
    await conn.start(echo);
    await conn.pollOnce();
    expect(t.sent).toHaveLength(0);
    await conn.stop();
  });
});
