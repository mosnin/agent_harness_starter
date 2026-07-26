import { AgentEndpoint } from "../a2a/bus";
import type { RemoteBackendRegistry } from "../backends/backend";
import type { AgentContext, AgentSpawner, SpawnedAgent } from "./team";

export interface BackendSpawnerOptions {
  /** Named backend to provision on (omit → first available). */
  backend?: string;
  managerUrl: string;
  authToken: string;
  /** Container image / runtime ref for the worker. */
  image?: string;
  limits?: { cpus?: number; memory?: string; timeoutMs?: number };
  now?: () => number;
}

/**
 * Spawns each team member as a **containerized worker** on a `RemoteBackend`
 * (Modal/SSH/Daytona/Singularity) and connects its A2A endpoint — the on-demand
 * containerized swarm the goal calls for. `spawn` provisions with the role's
 * capabilities; `stop` closes the endpoint and terminates the worker. Because
 * the whole registry is injectable, teams of containers test without a real
 * backend (via `FakeBackend`).
 */
export class BackendAgentSpawner implements AgentSpawner {
  constructor(
    private readonly registry: RemoteBackendRegistry,
    private readonly opts: BackendSpawnerOptions
  ) {}

  async spawn(ctx: AgentContext): Promise<SpawnedAgent> {
    const { handle } = await this.registry.provision(
      {
        workerId: ctx.slot.agentId,
        capabilities: ctx.role.capabilities,
        managerUrl: this.opts.managerUrl,
        authToken: this.opts.authToken,
        image: this.opts.image,
        limits: this.opts.limits,
        env: { HADES_TEAM: ctx.teamId, HADES_ROLE: ctx.slot.role },
      },
      this.opts.backend
    );
    const endpoint = new AgentEndpoint(
      { agentId: ctx.slot.agentId, role: ctx.slot.role, team: ctx.teamId },
      ctx.transport,
      { now: this.opts.now, idPrefix: ctx.slot.agentId }
    );
    return { agentId: ctx.slot.agentId, role: ctx.slot.role, endpoint, handle };
  }

  async stop(agent: SpawnedAgent): Promise<void> {
    agent.endpoint.close();
    await this.registry.terminate(agent.agentId);
  }
}
