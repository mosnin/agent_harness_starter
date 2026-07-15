/**
 * Agent-to-Agent (A2A) messaging — the layer Hermes has that the swarm's
 * manager↔worker bus didn't: agents in a team addressing *each other* directly.
 *
 * This module defines the wire model — addresses and the message envelope — plus
 * pure helpers. Transport lives in `bus.ts`; teams build on top.
 */

/** Identifies one agent (optionally by its role and team) on the A2A fabric. */
export interface AgentAddress {
  agentId: string;
  role?: string;
  team?: string;
}

/** Special recipient: every subscriber (optionally scoped to a topic/team). */
export interface BroadcastAddress {
  broadcast: true;
  team?: string;
  topic?: string;
}

export type Recipient = AgentAddress | BroadcastAddress;

export type A2AKind = "event" | "request" | "response" | "stream" | "stream_end" | "error";

/** The A2A envelope. `payload` is opaque to the bus. */
export interface A2AMessage<T = unknown> {
  id: string;
  from: AgentAddress;
  to: Recipient;
  kind: A2AKind;
  /** Pub/sub topic for events/broadcasts. */
  topic?: string;
  /** Correlates a response/stream chunk back to its originating request. */
  correlationId?: string;
  payload: T;
  ts: number;
}

export function isBroadcast(to: Recipient): to is BroadcastAddress {
  return (to as BroadcastAddress).broadcast === true;
}

/** Stable string key for an agent address (agentId is the identity). */
export function addressKey(addr: AgentAddress): string {
  return addr.agentId;
}

export function sameAddress(a: AgentAddress, b: AgentAddress): boolean {
  return a.agentId === b.agentId;
}

/**
 * Does a message directed at `to` reach the agent `self`? Direct messages match
 * by agentId; broadcasts match every agent, narrowed by team when the broadcast
 * scopes one (topic filtering is applied by the subscriber, not here).
 */
export function deliversTo(to: Recipient, self: AgentAddress): boolean {
  if (isBroadcast(to)) {
    if (to.team && to.team !== self.team) return false;
    return true;
  }
  return to.agentId === self.agentId;
}

/** Injectable envelope factory — deterministic ids + clock for tests. */
export class MessageFactory {
  private seq = 0;
  constructor(
    private readonly self: AgentAddress,
    private readonly opts: { now?: () => number; idPrefix?: string } = {}
  ) {}

  private nextId(): string {
    const prefix = this.opts.idPrefix ?? this.self.agentId;
    return `${prefix}-${++this.seq}`;
  }
  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  event<T>(to: Recipient, payload: T, topic?: string): A2AMessage<T> {
    return { id: this.nextId(), from: this.self, to, kind: "event", topic, payload, ts: this.now() };
  }

  request<T>(to: AgentAddress, payload: T, correlationId?: string): A2AMessage<T> {
    const id = this.nextId();
    return { id, from: this.self, to, kind: "request", correlationId: correlationId ?? id, payload, ts: this.now() };
  }

  respond<T>(to: AgentAddress, correlationId: string, payload: T, kind: A2AKind = "response"): A2AMessage<T> {
    return { id: this.nextId(), from: this.self, to, kind, correlationId, payload, ts: this.now() };
  }

  broadcast<T>(payload: T, opts: { team?: string; topic?: string } = {}): A2AMessage<T> {
    const to: BroadcastAddress = { broadcast: true, team: opts.team, topic: opts.topic };
    return { id: this.nextId(), from: this.self, to, kind: "event", topic: opts.topic, payload, ts: this.now() };
  }
}
