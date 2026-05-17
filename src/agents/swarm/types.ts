export type SwarmTopology = "mesh" | "hierarchical" | "centralized" | "hybrid";
export type AgentStatus = "idle" | "busy" | "error" | "offline";
export type MessageType = "task" | "result" | "handoff" | "heartbeat" | "control";

export interface SwarmAgent {
  id: string;
  name: string;
  status: AgentStatus;
  capabilities: string[];       // skill/tool names this agent handles
  load: number;                 // 0-1, current workload fraction
  lastHeartbeat: number;        // Date.now()
  metadata?: Record<string, unknown>;
}

export interface SwarmMessage {
  id: string;
  type: MessageType;
  fromAgentId: string;
  toAgentId: string | "broadcast";
  payload: unknown;
  timestamp: number;
  correlationId?: string;       // links request → response
}

export interface SwarmTask {
  id: string;
  description: string;
  requiredCapabilities: string[];
  payload: unknown;
  priority: number;             // 1-10, higher = more urgent
  assignedTo?: string;          // agentId
  status: "pending" | "assigned" | "in-progress" | "done" | "failed";
  createdAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

export interface SwarmConfig {
  topology: SwarmTopology;
  maxAgents: number;            // default: 20
  heartbeatIntervalMs: number;  // default: 5000
  taskTimeoutMs: number;        // default: 60000
  onMessage?: (msg: SwarmMessage) => void;
  onAgentJoin?: (agent: SwarmAgent) => void;
  onAgentLeave?: (agentId: string) => void;
  onTaskComplete?: (task: SwarmTask) => void;
}

export interface SwarmStats {
  totalAgents: number;
  activeAgents: number;
  pendingTasks: number;
  completedTasks: number;
  failedTasks: number;
  avgTaskDurationMs: number;
}
