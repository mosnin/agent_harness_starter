import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const save = mutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("agent_messages", args);
    return ctx.db.get(id);
  },
});

export const list = query({
  args: { threadId: v.id("agent_threads") },
  handler: async (ctx, { threadId }) =>
    ctx.db
      .query("agent_messages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect(),
});
