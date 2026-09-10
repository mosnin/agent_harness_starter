import { AgentEndpoint } from "../a2a/bus";
import type { A2ATransport } from "../a2a/bus";
import { RpcPeer } from "../a2a/rpc";
import type { HierarchyExec } from "./orchestrator";
import type { HierarchyNode } from "./tree";
import { walk } from "./tree";

/** A generous default so deep recursion over the bus never spuriously times out. */
const DEFAULT_RPC_TIMEOUT_MS = 30000;

/** One live tree node: its model, its A2A endpoint, and its RPC peer. */
interface NodeAgent {
  node: HierarchyNode;
  endpoint: AgentEndpoint;
  peer: RpcPeer;
}

export interface DistributedHierarchyOptions {
  /** Team scope for every node's A2A address. */
  team?: string;
  /** Per-hop RPC timeout in ms; 0/Infinity disables it. Defaults to 30000. */
  timeoutMs?: number;
}

/**
 * Runs a swarm hierarchy over the **real A2A message bus** instead of in-process
 * recursion. Every tree node becomes its own {@link AgentEndpoint} + {@link RpcPeer}:
 * a coordinator decomposes its task and dispatches the pieces to its children by
 * RPC, then aggregates the responses — exactly as {@link HierarchyOrchestrator}
 * does, except each hop crosses the wire. Because addressing is by agent id, every
 * node could just as well live in its own process or container behind the same
 * transport; the in-memory transport is only the test substrate. Each node keeps a
 * single peer that both *serves* (as a child answering its parent) and *requests*
 * (as a parent driving its own children).
 */
export class DistributedHierarchy<T, R> {
  private readonly agents = new Map<string, NodeAgent>();
  private driverEndpoint?: AgentEndpoint;
  private driverPeer?: RpcPeer;
  private readonly team?: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly root: HierarchyNode,
    private readonly transport: A2ATransport,
    private readonly exec: HierarchyExec<T, R>,
    opts: DistributedHierarchyOptions = {}
  ) {
    this.team = opts.team;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  /**
   * Stand up an agent (endpoint + serving RPC peer) for every node in the tree.
   * Idempotent: a second call is a no-op if the swarm is already up.
   */
  spawn(): void {
    if (this.agents.size > 0) return;

    // First pass: create an endpoint + peer for every node so children exist
    // before any parent handler tries to address them.
    walk(this.root, (node) => {
      const endpoint = new AgentEndpoint({ agentId: node.info.id, team: this.team }, this.transport);
      const peer = new RpcPeer(endpoint, { defaultTimeoutMs: this.timeoutMs });
      this.agents.set(node.info.id, { node, endpoint, peer });
    });

    // Second pass: wire each node's handler now that every peer is addressable.
    for (const agent of this.agents.values()) {
      agent.peer.serve((payload) => this.handleTask(agent, payload as T));
    }
  }

  /** The work one node does when its parent (or the driver) sends it a task. */
  private async handleTask(agent: NodeAgent, task: T): Promise<R> {
    const { node } = agent;

    // Leaf: execute directly.
    if (node.info.kind === "worker" || node.children.length === 0) {
      return this.exec.execute(task, node.info);
    }

    // Coordinator/root: decompose, pair each sub-task with a child, and fan out
    // to the children in parallel over RPC.
    const subs = this.exec.decompose(task, node.info);
    const pairs = node.children
      .map((child, i) => ({ child, subTask: subs[i] }))
      .filter((p): p is { child: HierarchyNode; subTask: T } => p.subTask !== undefined);

    const childResults = await Promise.all(
      pairs.map((p) => {
        const childAgent = this.agents.get(p.child.info.id);
        if (!childAgent) throw new Error(`No agent for child ${p.child.info.id}`);
        // Use THIS node's peer to request the child — the same peer serves the parent.
        return agent.peer.request<R>(childAgent.endpoint.address, p.subTask, { timeoutMs: this.timeoutMs });
      })
    );

    return this.exec.aggregate(childResults, task, node.info);
  }

  /**
   * Drive the whole hierarchy: send `rootTask` to the root node from a dedicated
   * driver agent and await the aggregated result. Spawns the swarm first if needed.
   */
  async run(rootTask: T): Promise<R> {
    this.spawn();

    if (!this.driverEndpoint || !this.driverPeer) {
      this.driverEndpoint = new AgentEndpoint(
        { agentId: `${this.root.info.id}.driver`, team: this.team },
        this.transport
      );
      this.driverPeer = new RpcPeer(this.driverEndpoint, { defaultTimeoutMs: this.timeoutMs });
    }

    const rootAgent = this.agents.get(this.root.info.id);
    if (!rootAgent) throw new Error(`No agent for root ${this.root.info.id}`);

    return this.driverPeer.request<R>(rootAgent.endpoint.address, rootTask, { timeoutMs: this.timeoutMs });
  }

  /** Tear down every node's peer and endpoint, plus the driver. */
  stop(): void {
    for (const agent of this.agents.values()) {
      agent.peer.close();
      agent.endpoint.close();
    }
    this.agents.clear();
    this.driverPeer?.close();
    this.driverEndpoint?.close();
    this.driverPeer = undefined;
    this.driverEndpoint = undefined;
  }

  /** Number of live node agents (excludes the driver). */
  nodeCount(): number {
    return this.agents.size;
  }
}
