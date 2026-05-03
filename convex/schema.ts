/**
 * Convex schema — mirrors the Prisma schema.
 * Run `npx convex dev` to apply this schema.
 */

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  agent_threads: defineTable({
    userId: v.string(),
    title: v.optional(v.string()),
  })
    .index("by_user", ["userId"]),

  agent_messages: defineTable({
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
  })
    .index("by_thread", ["threadId"]),

  agent_runs: defineTable({
    threadId: v.id("agent_threads"),
    agentName: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    completedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    metadata: v.optional(v.string()),
  })
    .index("by_thread", ["threadId"]),
});
