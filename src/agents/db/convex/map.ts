import type { AgentMessage, AgentRun, AgentThread } from "../types";

export interface ConvexThreadRow {
  _id?: unknown;
  id?: unknown;
  userId?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  _creationTime?: unknown;
}

export interface ConvexMessageRow {
  _id?: unknown;
  id?: unknown;
  threadId?: unknown;
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  _creationTime?: unknown;
}

export interface ConvexRunRow {
  _id?: unknown;
  id?: unknown;
  threadId?: unknown;
  status?: unknown;
  agentName?: unknown;
  completedAt?: unknown;
  error?: unknown;
  metadata?: unknown;
  _creationTime?: unknown;
}

function asId(value: unknown): string {
  return String(value ?? "");
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value) return new Date(value);
  return new Date(0);
}

export function mapConvexThread(row: ConvexThreadRow): AgentThread {
  return {
    id: asId(row.id ?? row._id),
    userId: String(row.userId ?? ""),
    title: typeof row.title === "string" ? row.title : undefined,
    createdAt: asDate(row._creationTime),
    updatedAt: asDate(row.updatedAt ?? row._creationTime),
  };
}

export function mapConvexMessage(row: ConvexMessageRow): AgentMessage {
  return {
    id: asId(row.id ?? row._id),
    threadId: asId(row.threadId),
    role: row.role as AgentMessage["role"],
    content: String(row.content ?? ""),
    toolCallId: typeof row.toolCallId === "string" ? row.toolCallId : undefined,
    toolName: typeof row.toolName === "string" ? row.toolName : undefined,
    createdAt: asDate(row._creationTime),
  };
}

export function mapConvexRun(row: ConvexRunRow): AgentRun {
  let metadata: Record<string, unknown> | undefined;
  if (typeof row.metadata === "string" && row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = undefined;
    }
  } else if (row.metadata && typeof row.metadata === "object") {
    metadata = row.metadata as Record<string, unknown>;
  }
  return {
    id: asId(row.id ?? row._id),
    threadId: asId(row.threadId),
    status: row.status as AgentRun["status"],
    agentName: String(row.agentName ?? ""),
    startedAt: asDate(row._creationTime),
    completedAt: row.completedAt == null ? undefined : asDate(row.completedAt),
    error: typeof row.error === "string" ? row.error : undefined,
    metadata,
  };
}
