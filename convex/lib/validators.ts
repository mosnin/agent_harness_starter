import { v } from "convex/values";

export const threadDoc = v.object({
  _id: v.id("agent_threads"),
  _creationTime: v.number(),
  userId: v.string(),
  title: v.optional(v.string()),
  updatedAt: v.optional(v.number()),
});

export const messageDoc = v.object({
  _id: v.id("agent_messages"),
  _creationTime: v.number(),
  threadId: v.id("agent_threads"),
  role: v.union(
    v.literal("user"),
    v.literal("assistant"),
    v.literal("system"),
    v.literal("tool")
  ),
  content: v.string(),
  toolCallId: v.optional(v.string()),
  toolName: v.optional(v.string()),
});

export const runStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled")
);

export const runDoc = v.object({
  _id: v.id("agent_runs"),
  _creationTime: v.number(),
  threadId: v.id("agent_threads"),
  agentName: v.string(),
  status: runStatus,
  completedAt: v.optional(v.number()),
  error: v.optional(v.string()),
  metadata: v.optional(v.string()),
});
