import type { A2ATransport } from "../a2a/bus";
import type { A2AMessage } from "../a2a/types";
import { isBroadcast } from "../a2a/types";

export type AuditEventType = "a2a" | "spawn" | "terminate" | "authorize" | "reject";

export interface AuditEvent {
  type: AuditEventType;
  at: number;
  team?: string;
  /** Who initiated (agentId / minter / policy). */
  actor?: string;
  /** Who/what it acted on (agentId / "broadcast" / capability). */
  target?: string;
  detail?: Record<string, unknown>;
}

/**
 * Append-only audit trail for the team fabric: who talked to whom over A2A, what
 * was spawned/torn down, and every authorization decision. This is the record
 * that makes a Hades swarm *accountable* — the conversation graph and the
 * spawn/permission history are always reconstructable. Injectable clock.
 */
export class AuditLog {
  private events: AuditEvent[] = [];
  constructor(private readonly now: () => number = () => Date.now()) {}

  record(e: Omit<AuditEvent, "at">): AuditEvent {
    const event: AuditEvent = { ...e, at: this.now() };
    this.events.push(event);
    return event;
  }

  a2a(from: string, to: string, kind: string, opts: { team?: string; topic?: string } = {}): void {
    this.record({ type: "a2a", actor: from, target: to, team: opts.team, detail: { kind, topic: opts.topic } });
  }
  spawn(team: string, agentId: string, backend?: string): void {
    this.record({ type: "spawn", team, target: agentId, detail: { backend } });
  }
  terminate(team: string, agentId: string): void {
    this.record({ type: "terminate", team, target: agentId });
  }
  authorize(agentId: string, capability: string, granted: boolean): void {
    this.record({ type: "authorize", actor: agentId, target: capability, detail: { granted } });
  }
  reject(from: string, reason: string): void {
    this.record({ type: "reject", actor: from, detail: { reason } });
  }

  all(): AuditEvent[] {
    return [...this.events];
  }
  ofType(type: AuditEventType): AuditEvent[] {
    return this.events.filter((e) => e.type === type);
  }
  forTeam(team: string): AuditEvent[] {
    return this.events.filter((e) => e.team === team);
  }
  forActor(actor: string): AuditEvent[] {
    return this.events.filter((e) => e.actor === actor);
  }

  /** Directed conversation graph: "from>to" → message count. */
  conversationGraph(): Record<string, number> {
    const graph: Record<string, number> = {};
    for (const e of this.ofType("a2a")) {
      const key = `${e.actor}>${e.target}`;
      graph[key] = (graph[key] ?? 0) + 1;
    }
    return graph;
  }
}

/**
 * Wraps an {@link A2ATransport} to record every published message on an
 * {@link AuditLog} — capturing the full "who talked to whom" graph. Composes with
 * the signing transport (audit outside, signing inside, or vice-versa).
 */
export class AuditingA2ATransport implements A2ATransport {
  constructor(
    private readonly inner: A2ATransport,
    private readonly log: AuditLog
  ) {}

  publish(msg: A2AMessage): void | Promise<void> {
    const to = isBroadcast(msg.to) ? "broadcast" : msg.to.agentId;
    this.log.a2a(msg.from.agentId, to, msg.kind, { team: msg.from.team, topic: msg.topic });
    return this.inner.publish(msg);
  }
  register(address: Parameters<A2ATransport["register"]>[0], handler: (msg: A2AMessage) => void): () => void {
    return this.inner.register(address, handler);
  }
}
