import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: { userId: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, { userId, title }) => {
    const id = await ctx.db.insert("agent_threads", { userId, title });
    return ctx.db.get(id);
  },
});

export const get = query({
  args: { threadId: v.id("agent_threads") },
  handler: async (ctx, { threadId }) => ctx.db.get(threadId),
});

export const listByUser = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) =>
    ctx.db
      .query("agent_threads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
});

export const deleteThread = mutation({
  args: { threadId: v.id("agent_threads") },
  handler: async (ctx, { threadId }) => ctx.db.delete(threadId),
});
