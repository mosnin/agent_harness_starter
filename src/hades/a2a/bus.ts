import { MessageFactory, deliversTo, isBroadcast } from "./types";
import type { A2AMessage, AgentAddress, Recipient } from "./types";

/**
 * The A2A wire. Injectable so a team runs in-process (tests) or across the swarm
 * control plane / containers (production) without changing the agents. The
 * transport is responsible only for delivery; addressing/filtering is pure
 * ({@link deliversTo}).
 */
export interface A2ATransport {
  publish(msg: A2AMessage): void | Promise<void>;
  /** Register an agent's inbox; returns an unsubscribe fn. */
  register(address: AgentAddress, handler: (msg: A2AMessage) => void): () => void;
}

interface Sub {
  address: AgentAddress;
  handler: (msg: A2AMessage) => void;
}

/**
 * In-process A2A transport with **indexed routing**. A direct message is
 * dispatched by an O(1) `Map.get(agentId)` lookup instead of scanning every
 * subscriber — the hot path for RPC and streaming, which are all point-to-point.
 * Only broadcasts fan out across subscribers (inherent, and scoped by team).
 * Delivery is synchronous; the endpoint mailbox decouples producers from
 * consumers. `routeScans` counts fan-out iterations for perf assertions.
 */
export class InMemoryA2ATransport implements A2ATransport {
  private subs = new Map<string, Sub>();
  /** Instrumentation: number of subscriber comparisons made during routing. */
  routeScans = 0;

  register(address: AgentAddress, handler: (msg: A2AMessage) => void): () => void {
    this.subs.set(address.agentId, { address, handler });
    return () => this.subs.delete(address.agentId);
  }

  publish(msg: A2AMessage): void {
    if (isBroadcast(msg.to)) {
      // Broadcast: fan out (unavoidable), skipping the sender and off-team subs.
      for (const sub of this.subs.values()) {
        this.routeScans++;
        if (sub.address.agentId === msg.from.agentId) continue;
        if (deliversTo(msg.to, sub.address)) sub.handler(msg);
      }
      return;
    }
    // Direct message: O(1) lookup — no scan over the roster.
    this.routeScans++;
    const sub = this.subs.get(msg.to.agentId);
    if (sub && sub.address.agentId !== msg.from.agentId) sub.handler(msg);
  }

  /** Currently connected agent ids (for tests / diagnostics). */
  members(): string[] {
    return [...this.subs.keys()];
  }
  size(): number {
    return this.subs.size;
  }
}

/**
 * A per-agent inbox. Supports push-style (`on`) and pull-style (`take`)
 * consumption; when a listener is attached, delivery goes to it, otherwise
 * messages queue for the next `take()`. This is what lets an agent await the
 * next A2A message like a coroutine.
 */
export class Mailbox {
  private queue: A2AMessage[] = [];
  private waiters: Array<(m: A2AMessage) => void> = [];
  private listeners: Array<(m: A2AMessage) => void> = [];

  deliver(msg: A2AMessage): void {
    for (const l of this.listeners) l(msg);
    if (this.listeners.length === 0) {
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.queue.push(msg);
    }
  }

  /** Await the next message (resolves immediately if one is queued). */
  take(): Promise<A2AMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Subscribe to messages as they arrive; returns an unsubscribe fn. */
  on(handler: (msg: A2AMessage) => void): () => void {
    this.listeners.push(handler);
    return () => {
      const i = this.listeners.indexOf(handler);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  size(): number {
    return this.queue.length;
  }
}

export interface AgentEndpointOptions {
  now?: () => number;
  idPrefix?: string;
}

/**
 * An agent's handle onto the A2A fabric: its address, an outbound
 * {@link MessageFactory}, and an inbound {@link Mailbox} wired to the transport.
 * Send events/broadcasts, receive by pull or push, and `close()` to leave.
 */
export class AgentEndpoint {
  readonly mailbox = new Mailbox();
  readonly factory: MessageFactory;
  private readonly unsub: () => void;

  constructor(
    readonly address: AgentAddress,
    private readonly transport: A2ATransport,
    opts: AgentEndpointOptions = {}
  ) {
    this.factory = new MessageFactory(address, opts);
    this.unsub = transport.register(address, (m) => this.mailbox.deliver(m));
  }

  send(msg: A2AMessage): void | Promise<void> {
    return this.transport.publish(msg);
  }
  emit<T>(to: Recipient, payload: T, topic?: string): void | Promise<void> {
    return this.send(this.factory.event(to, payload, topic));
  }
  broadcast<T>(payload: T, opts: { team?: string; topic?: string } = {}): void | Promise<void> {
    return this.send(this.factory.broadcast(payload, opts));
  }
  receive(): Promise<A2AMessage> {
    return this.mailbox.take();
  }
  on(handler: (msg: A2AMessage) => void): () => void {
    return this.mailbox.on(handler);
  }
  close(): void {
    this.unsub();
  }
}
