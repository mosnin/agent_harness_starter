import { AgentEndpoint } from "../a2a/bus";
import type { A2ATransport } from "../a2a/bus";
import { RpcPeer } from "../a2a/rpc";
import type { RpcOptions } from "../a2a/rpc";
import { PubSub } from "../a2a/pubsub";
import type { TopicHandler } from "../a2a/pubsub";
import type { Team, SpawnedAgent } from "./team";

export interface TeamCoordinatorOptions {
  rpcDefaultTimeoutMs?: number;
  now?: () => number;
}

/**
 * The team's coordination hub. It runs on its own A2A endpoint
 * (`<team>.coordinator`) and gives the orchestrator team-level messaging over
 * the roster: `direct`/`request` an individual member, `announce` a topic to the
 * whole team, and `onTopic` to listen. This is what turns a bag of spawned
 * agents into a coordinated team — the addressed + broadcast surface Hermes has.
 */
export class TeamCoordinator {
  readonly endpoint: AgentEndpoint;
  private readonly rpc: RpcPeer;
  private readonly pubsub: PubSub;

  constructor(
    private readonly team: Team,
    transport: A2ATransport,
    opts: TeamCoordinatorOptions = {}
  ) {
    this.endpoint = new AgentEndpoint(
      { agentId: `${team.teamId}.coordinator`, role: "coordinator", team: team.teamId },
      transport,
      { now: opts.now, idPrefix: `${team.teamId}.coord` }
    );
    this.rpc = new RpcPeer(this.endpoint, { defaultTimeoutMs: opts.rpcDefaultTimeoutMs });
    this.pubsub = new PubSub(this.endpoint);
  }

  members(): SpawnedAgent[] {
    return this.team.members();
  }
  byRole(role: string): SpawnedAgent[] {
    return this.team.byRole(role);
  }

  private memberOrThrow(agentId: string): SpawnedAgent {
    const m = this.team.get(agentId);
    if (!m) throw new Error(`No such member in team ${this.team.teamId}: ${agentId}`);
    return m;
  }

  /** Fire-and-forget directive to one member. */
  direct<T>(agentId: string, payload: T): void | Promise<void> {
    return this.endpoint.emit(this.memberOrThrow(agentId).endpoint.address, payload);
  }

  /** RPC request to one member (the member must serve via its own RpcPeer). */
  async request<Res = unknown>(agentId: string, payload: unknown, opts?: RpcOptions): Promise<Res> {
    return this.rpc.request<Res>(this.memberOrThrow(agentId).endpoint.address, payload, opts);
  }

  /** Announce a topic to the whole team. */
  announce<T>(topic: string, payload: T): void | Promise<void> {
    return this.pubsub.publish(topic, payload, { team: this.team.teamId });
  }

  /** Subscribe the coordinator to a team topic. */
  onTopic(topic: string, handler: TopicHandler): () => void {
    return this.pubsub.subscribe(topic, handler);
  }

  close(): void {
    this.rpc.close();
    this.pubsub.close();
    this.endpoint.close();
  }
}
