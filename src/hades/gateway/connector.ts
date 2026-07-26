import type { InboundMessage, OutboundReply, GatewayPlatform } from "../../swarm-runtime/gateway/gateway";
import { RateLimiter } from "./rate-limiter";

/** Where to deliver an outbound reply on a platform. */
export interface DeliveryTarget {
  user: string;
  channel?: string;
}

/**
 * A live connection to a messaging platform. Each connector normalizes the
 * platform's inbound events to {@link InboundMessage}, hands them to a message
 * handler, and delivers the handler's reply back. Transports are injectable so
 * every connector is testable without real credentials.
 */
export interface PlatformConnector {
  readonly platform: GatewayPlatform;
  /** Begin receiving; call `handler` per inbound message and send its reply. */
  start(handler: (msg: InboundMessage) => Promise<OutboundReply>): Promise<void>;
  /** Deliver an outbound message (used for proactive/mirrored sends). */
  send(target: DeliveryTarget, text: string): Promise<void>;
  stop(): Promise<void>;
}

/** Observes inbound/outbound traffic (logging, dashboard mirror, audit). */
export type Mirror = (event: { direction: "in" | "out"; platform: string; user: string; text: string }) => void;

export interface ConnectorHubOptions {
  rateLimiter?: RateLimiter;
  mirror?: Mirror;
  /** Reply text sent when a user is rate-limited. */
  rateLimitedReply?: string;
}

/**
 * Central hub the Hades gateway runs: registers platform connectors, and for
 * each inbound message applies rate limiting and mirroring before routing it to
 * the shared handler (which drives the swarm). One handler, many channels — the
 * "lives where you do, from a single gateway process" model.
 */
export class ConnectorHub {
  private connectors = new Map<string, PlatformConnector>();

  constructor(
    private readonly handler: (msg: InboundMessage) => Promise<OutboundReply>,
    private readonly opts: ConnectorHubOptions = {}
  ) {}

  register(connector: PlatformConnector): void {
    this.connectors.set(connector.platform, connector);
  }
  get(platform: string): PlatformConnector | undefined {
    return this.connectors.get(platform);
  }
  list(): PlatformConnector[] {
    return [...this.connectors.values()];
  }

  async startAll(): Promise<void> {
    await Promise.all(this.list().map((c) => c.start((m) => this.route(c, m))));
  }
  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((c) => c.stop()));
  }

  /** Proactively send to a platform (e.g. a scheduled report). */
  async deliver(platform: string, target: DeliveryTarget, text: string): Promise<boolean> {
    const c = this.connectors.get(platform);
    if (!c) return false;
    this.opts.mirror?.({ direction: "out", platform, user: target.user, text });
    await c.send(target, text);
    return true;
  }

  /** The wrapped handler each connector calls: rate-limit → mirror → handle. */
  private async route(connector: PlatformConnector, msg: InboundMessage): Promise<OutboundReply> {
    const key = `${msg.platform}:${msg.user}`;
    if (this.opts.rateLimiter && !this.opts.rateLimiter.tryAcquire(key)) {
      const text = this.opts.rateLimitedReply ?? "You're sending messages too quickly — please slow down.";
      return { text, accepted: false };
    }
    this.opts.mirror?.({ direction: "in", platform: msg.platform, user: msg.user, text: msg.text });
    const reply = await this.handler(msg);
    if (reply.text) this.opts.mirror?.({ direction: "out", platform: msg.platform, user: msg.user, text: reply.text });
    return reply;
  }
}
