import type { InboundMessage, OutboundReply, GatewayPlatform } from "../../swarm-runtime/gateway/gateway";
import type { DeliveryTarget, PlatformConnector } from "./connector";

/**
 * A connector with no external transport — messages are pushed in via
 * `receive()` and outbound sends are captured in `sent`. Doubles as a test
 * fixture for the hub and connectors, and as a real in-process channel (e.g. a
 * REPL or another local process feeding the same gateway).
 */
export class InMemoryConnector implements PlatformConnector {
  readonly platform: GatewayPlatform;
  readonly sent: Array<{ target: DeliveryTarget; text: string }> = [];
  private handler?: (msg: InboundMessage) => Promise<OutboundReply>;
  private running = false;

  constructor(platform: GatewayPlatform = "generic") {
    this.platform = platform;
  }

  async start(handler: (msg: InboundMessage) => Promise<OutboundReply>): Promise<void> {
    this.handler = handler;
    this.running = true;
  }

  async send(target: DeliveryTarget, text: string): Promise<void> {
    this.sent.push({ target, text });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.handler = undefined;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Simulate an inbound message: routes it through the hub's handler and, if a
   * reply is produced, delivers it back via `send` (mirroring real connector
   * behaviour). Returns the reply for assertions.
   */
  async receive(msg: Omit<InboundMessage, "platform">): Promise<OutboundReply> {
    if (!this.handler) throw new Error("connector not started");
    const full: InboundMessage = { ...msg, platform: this.platform };
    const reply = await this.handler(full);
    if (reply.text) await this.send({ user: msg.user, channel: msg.channel }, reply.text);
    return reply;
  }
}
