import { randomUUID } from "crypto";
import type {
  SwarmAgent,
  SwarmConfig,
  SwarmMessage,
  SwarmStats,
  SwarmTask,
  AgentStatus,
  MessageType,
} from "./types";

const DEFAULT_CONFIG: Required<Omit<SwarmConfig, "onMessage" | "onAgentJoin" | "onAgentLeave" | "onTaskComplete">> = {
  topology: "mesh",
  maxAgents: 20,
  heartbeatIntervalMs: 5000,
  taskTimeoutMs: 60000,
};

export class SwarmCoordinator {
  private config: Required<SwarmConfig>;
  private agents: Map<string, SwarmAgent> = new Map();
  private tasks: Map<string, SwarmTask> = new Map();
  private messages: SwarmMessage[] = [];
  private inFlightCount: Map<string, number> = new Map();
  private completedTaskDurations: number[] = [];

  // Round-robin index for centralized topology
  private roundRobinIndex = 0;

  constructor(config: Partial<SwarmConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      onMessage: undefined as unknown as Required<SwarmConfig>["onMessage"],
      onAgentJoin: undefined as unknown as Required<SwarmConfig>["onAgentJoin"],
      onAgentLeave: undefined as unknown as Required<SwarmConfig>["onAgentLeave"],
      onTaskComplete: undefined as unknown as Required<SwarmConfig>["onTaskComplete"],
      ...config,
    };
  }

  // ---------------------------------------------------------------------------
  // Agent lifecycle
  // ---------------------------------------------------------------------------

  registerAgent(
    agent: Omit<SwarmAgent, "status" | "load" | "lastHeartbeat">
  ): SwarmAgent {
    if (this.agents.size >= this.config.maxAgents) {
      throw new Error(
        `Cannot register agent: swarm is at capacity (${this.config.maxAgents})`
      );
    }

    const newAgent: SwarmAgent = {
      ...agent,
      id: agent.id ?? randomUUID(),
      status: "idle",
      load: 0,
      lastHeartbeat: Date.now(),
    };

    this.agents.set(newAgent.id, newAgent);
    this.inFlightCount.set(newAgent.id, 0);
    this.config.onAgentJoin?.(newAgent);
    return newAgent;
  }

  unregisterAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.agents.delete(agentId);
    this.inFlightCount.delete(agentId);
    this.config.onAgentLeave?.(agentId);
  }

  heartbeat(agentId: string, load?: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.lastHeartbeat = Date.now();
    if (load !== undefined) {
      agent.load = Math.max(0, Math.min(1, load));
    }
    // Revive offline agent if it sends a heartbeat
    if (agent.status === "offline") {
      agent.status = "idle";
    }
  }

  getAgent(agentId: string): SwarmAgent | undefined {
    this._checkOfflineAgents();
    return this.agents.get(agentId);
  }

  getAgents(filter?: { status?: AgentStatus; capability?: string }): SwarmAgent[] {
    this._checkOfflineAgents();
    let agents = Array.from(this.agents.values());
    if (filter?.status) {
      agents = agents.filter((a) => a.status === filter.status);
    }
    if (filter?.capability) {
      agents = agents.filter((a) => a.capabilities.includes(filter.capability!));
    }
    return agents;
  }

  // ---------------------------------------------------------------------------
  // Task management
  // ---------------------------------------------------------------------------

  submitTask(
    task: Omit<SwarmTask, "id" | "status" | "createdAt">
  ): SwarmTask {
    const newTask: SwarmTask = {
      ...task,
      id: randomUUID(),
      status: "pending",
      createdAt: Date.now(),
    };

    this.tasks.set(newTask.id, newTask);

    // Auto-assign if a suitable agent is available
    const agent = this.selectAgent(newTask);
    if (agent) {
      return this.assignTask(newTask.id, agent.id);
    }

    return newTask;
  }

  assignTask(taskId: string, agentId: string): SwarmTask {
    const task = this._requireTask(taskId);
    const agent = this._requireAgent(agentId);

    task.assignedTo = agentId;
    task.status = "assigned";

    agent.status = "busy";

    const count = this.inFlightCount.get(agentId) ?? 0;
    this.inFlightCount.set(agentId, count + 1);

    return task;
  }

  completeTask(taskId: string, result: unknown): SwarmTask {
    const task = this._requireTask(taskId);

    const completedAt = Date.now();
    task.status = "done";
    task.result = result;
    task.completedAt = completedAt;
    this.completedTaskDurations.push(completedAt - task.createdAt);

    if (task.assignedTo) {
      this._decrementInFlight(task.assignedTo);
    }

    this.config.onTaskComplete?.(task);
    return task;
  }

  failTask(taskId: string, error: string): SwarmTask {
    const task = this._requireTask(taskId);

    task.status = "failed";
    task.error = error;
    task.completedAt = Date.now();

    if (task.assignedTo) {
      this._decrementInFlight(task.assignedTo);
    }

    return task;
  }

  getTask(taskId: string): SwarmTask | undefined {
    return this.tasks.get(taskId);
  }

  getPendingTasks(): SwarmTask[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === "pending"
    );
  }

  // ---------------------------------------------------------------------------
  // Message bus
  // ---------------------------------------------------------------------------

  send(msg: Omit<SwarmMessage, "id" | "timestamp">): SwarmMessage {
    const fullMsg: SwarmMessage = {
      ...msg,
      id: randomUUID(),
      timestamp: Date.now(),
    };
    this.messages.push(fullMsg);
    this.config.onMessage?.(fullMsg);
    return fullMsg;
  }

  broadcast(
    fromAgentId: string,
    type: MessageType,
    payload: unknown
  ): SwarmMessage {
    return this.send({
      type,
      fromAgentId,
      toAgentId: "broadcast",
      payload,
    });
  }

  // ---------------------------------------------------------------------------
  // Load balancing
  // ---------------------------------------------------------------------------

  selectAgent(task: SwarmTask): SwarmAgent | undefined {
    this._checkOfflineAgents();

    const capable = Array.from(this.agents.values()).filter(
      (a) =>
        a.status !== "offline" &&
        a.status !== "error" &&
        task.requiredCapabilities.every((cap) => a.capabilities.includes(cap))
    );

    if (capable.length === 0) return undefined;

    const topology = this.config.topology;

    if (topology === "centralized") {
      // Round-robin across idle agents
      const idle = capable.filter((a) => a.status === "idle");
      if (idle.length === 0) return undefined;
      const index = this.roundRobinIndex % idle.length;
      this.roundRobinIndex = (this.roundRobinIndex + 1) % idle.length;
      return idle[index];
    }

    if (topology === "hierarchical") {
      // Lowest load among capable agents
      return capable.reduce((best, a) =>
        a.load < best.load ? a : best
      );
    }

    // mesh / hybrid: score = load * 0.7 + (inFlight / 10) * 0.3 — lowest wins
    return capable.reduce((best, a) => {
      const scoreA = this._score(a);
      const scoreBest = this._score(best);
      return scoreA < scoreBest ? a : best;
    });
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getStats(): SwarmStats {
    this._checkOfflineAgents();

    const allAgents = Array.from(this.agents.values());
    const allTasks = Array.from(this.tasks.values());

    const activeAgents = allAgents.filter(
      (a) => a.status === "idle" || a.status === "busy"
    ).length;

    const pendingTasks = allTasks.filter((t) => t.status === "pending").length;
    const completedTasks = allTasks.filter((t) => t.status === "done").length;
    const failedTasks = allTasks.filter((t) => t.status === "failed").length;

    const avgTaskDurationMs =
      this.completedTaskDurations.length > 0
        ? this.completedTaskDurations.reduce((a, b) => a + b, 0) /
          this.completedTaskDurations.length
        : 0;

    return {
      totalAgents: allAgents.length,
      activeAgents,
      pendingTasks,
      completedTasks,
      failedTasks,
      avgTaskDurationMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  shutdown(): void {
    this.agents.clear();
    this.tasks.clear();
    this.messages.length = 0;
    this.inFlightCount.clear();
    this.completedTaskDurations.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _score(agent: SwarmAgent): number {
    const inFlight = this.inFlightCount.get(agent.id) ?? 0;
    return agent.load * 0.7 + (inFlight / 10) * 0.3;
  }

  private _checkOfflineAgents(): void {
    const cutoff = Date.now() - this.config.heartbeatIntervalMs * 2;
    for (const agent of this.agents.values()) {
      if (agent.status !== "offline" && agent.lastHeartbeat < cutoff) {
        agent.status = "offline";
      }
    }
  }

  private _decrementInFlight(agentId: string): void {
    const count = this.inFlightCount.get(agentId) ?? 0;
    const next = Math.max(0, count - 1);
    this.inFlightCount.set(agentId, next);

    const agent = this.agents.get(agentId);
    if (agent && next === 0 && agent.status === "busy") {
      agent.status = "idle";
    }
  }

  private _requireTask(taskId: string): SwarmTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private _requireAgent(agentId: string): SwarmAgent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    return agent;
  }
}
