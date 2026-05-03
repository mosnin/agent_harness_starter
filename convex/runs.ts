import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: {
    threadId: v.id("agent_threads"),
    status: v.string(),
    agentName: v.string(),
  },
  handler: async (ctx, { threadId, status, agentName }) => {
    const id = await ctx.db.insert("agent_runs", { threadId, status, agentName });
    return ctx.db.get(id);
  },
});

export const get = query({
  args: { runId: v.id("agent_runs") },
  handler: async (ctx, { runId }) => ctx.db.get(runId),
});

export const listByThread = query({
  args: { threadId: v.id("agent_threads") },
  handler: async (ctx, { threadId }) =>
    ctx.db
      .query("agent_runs")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .collect(),
});

export const update = mutation({
  args: {
    runId: v.id("agent_runs"),
    status: v.optional(v.string()),
    error: v.optional(v.string()),
    completedAt: v.optional(v.number()),
  },
  handler: async (ctx, { runId, ...patch }) => {
    await ctx.db.patch(runId, patch);
    return ctx.db.get(runId);
  },
});
