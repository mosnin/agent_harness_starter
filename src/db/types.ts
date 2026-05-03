/** Shared database types used by all adapters. */

export interface AgentThread {
  id: string;
  userId: string;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  createdAt: Date;
}

export interface AgentRun {
  id: string;
  threadId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  agentName: string;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The interface every DB adapter must implement.
 * Swap providers by changing DB_PROVIDER in .env.local.
 */
export interface DbAdapter {
  // Threads
  createThread(userId: string, title?: string): Promise<AgentThread>;
  getThread(threadId: string): Promise<AgentThread | null>;
  listThreads(userId: string): Promise<AgentThread[]>;
  deleteThread(threadId: string): Promise<void>;

  // Messages
  saveMessage(msg: Omit<AgentMessage, "id" | "createdAt">): Promise<AgentMessage>;
  getMessages(threadId: string): Promise<AgentMessage[]>;

  // Runs
  createRun(run: Omit<AgentRun, "id" | "startedAt">): Promise<AgentRun>;
  updateRun(runId: string, update: Partial<AgentRun>): Promise<AgentRun>;
  getRun(runId: string): Promise<AgentRun | null>;
}
