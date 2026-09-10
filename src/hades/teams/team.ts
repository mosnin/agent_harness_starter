import { AgentEndpoint } from "../a2a/bus";
import type { A2ATransport } from "../a2a/bus";
import type { RoleRegistry, AgentRole } from "./role";
import type { RosterSlot } from "./blueprint";
import type { FormedTeam } from "./former";

/** Context handed to a spawner for one roster slot. */
export interface AgentContext {
  teamId: string;
  slot: RosterSlot;
  role: AgentRole;
  /** Shared A2A transport the agent's endpoint connects to. */
  transport: A2ATransport;
}

/** A live team member: its A2A endpoint plus a backend handle for teardown. */
export interface SpawnedAgent {
  agentId: string;
  role: string;
  endpoint: AgentEndpoint;
  /** Backend-specific handle (container id, RemoteHandle, PID…). */
  handle?: unknown;
}

/**
 * Injectable spawner: how a roster slot becomes a live, addressable agent.
 * Implementations range from in-process (tests/local) to containerized backends
 * (Modal/SSH/docker) — the {@link Team} doesn't care which.
 */
export interface AgentSpawner {
  spawn(ctx: AgentContext): Promise<SpawnedAgent>;
  stop(agent: SpawnedAgent): Promise<void>;
}

/**
 * The simplest spawner: an in-process {@link AgentEndpoint} on the shared A2A
 * transport, no container. Used for tests, local runs, and the demo path.
 */
export class InProcessAgentSpawner implements AgentSpawner {
  constructor(private readonly opts: { now?: () => number } = {}) {}

  async spawn(ctx: AgentContext): Promise<SpawnedAgent> {
    const endpoint = new AgentEndpoint(
      { agentId: ctx.slot.agentId, role: ctx.slot.role, team: ctx.teamId },
      ctx.transport,
      { now: this.opts.now, idPrefix: ctx.slot.agentId }
    );
    return { agentId: ctx.slot.agentId, role: ctx.slot.role, endpoint };
  }

  async stop(agent: SpawnedAgent): Promise<void> {
    agent.endpoint.close();
  }
}

/**
 * A live team: spawns every roster slot on the injectable spawner (in parallel,
 * for fast formation), wires each to the shared A2A transport, and tracks
 * members by id and role. `stop()` tears the whole team down. This is the unit
 * Hades forms on demand to run work in parallel.
 */
export class Team {
  private agents = new Map<string, SpawnedAgent>();
  private spawned = false;

  constructor(
    readonly formed: FormedTeam,
    private readonly spawner: AgentSpawner,
    private readonly transport: A2ATransport,
    private readonly roles: RoleRegistry
  ) {}

  get teamId(): string {
    return this.formed.teamId;
  }

  /** Spawn every roster slot concurrently. Idempotent. */
  async spawn(): Promise<SpawnedAgent[]> {
    if (this.spawned) return this.members();
    const results = await Promise.all(
      this.formed.roster.map((slot) => this.spawnSlot(slot))
    );
    for (const a of results) this.agents.set(a.agentId, a);
    this.spawned = true;
    return results;
  }

  private spawnSlot(slot: RosterSlot): Promise<SpawnedAgent> {
    const role = this.roles.get(slot.role);
    if (!role) throw new Error(`Team ${this.teamId}: unknown role ${slot.role}`);
    return this.spawner.spawn({ teamId: this.teamId, slot, role, transport: this.transport });
  }

  members(): SpawnedAgent[] {
    return [...this.agents.values()];
  }
  byRole(role: string): SpawnedAgent[] {
    return this.members().filter((a) => a.role === role);
  }
  get(agentId: string): SpawnedAgent | undefined {
    return this.agents.get(agentId);
  }
  size(): number {
    return this.agents.size;
  }

  /** Tear down every member (best-effort, in parallel). */
  async stop(): Promise<void> {
    await Promise.all(
      this.members().map((a) => this.spawner.stop(a).catch(() => undefined))
    );
    this.agents.clear();
    this.spawned = false;
  }
}
