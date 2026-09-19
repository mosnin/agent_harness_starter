import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { loadOwnedRun, requireOwnedRun, requireOwnedThread } from "./lib/auth";
import { runDoc, runStatus } from "./lib/validators";

export const create = internalMutation({
  args: {
    threadId: v.id("agent_threads"),
    status: runStatus,
    agentName: v.string(),
  },
  returns: runDoc,
  handler: async (ctx, { threadId, status, agentName }) => {
    await requireOwnedThread(ctx, threadId);
    const id = await ctx.db.insert("agent_runs", { threadId, status, agentName });
    const created = await ctx.db.get(id);
    if (!created) {
      throw new Error("Run not found");
    }
    return created;
  },
});

export const get = internalQuery({
  args: { runId: v.id("agent_runs") },
  returns: v.union(runDoc, v.null()),
  handler: async (ctx, { runId }) => {
    const { run } = await loadOwnedRun(ctx, runId);
    return run;
  },
});

export const listByThread = internalQuery({
  args: { threadId: v.id("agent_threads") },
  returns: v.array(runDoc),
  handler: async (ctx, { threadId }) => {
    await requireOwnedThread(ctx, threadId);
    return await ctx.db
      .query("agent_runs")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .collect();
  },
});

export const update = internalMutation({
  args: {
    runId: v.id("agent_runs"),
    status: v.optional(runStatus),
    error: v.optional(v.string()),
    completedAt: v.optional(v.number()),
  },
  returns: runDoc,
  handler: async (ctx, { runId, ...patch }) => {
    await requireOwnedRun(ctx, runId);
    await ctx.db.patch(runId, patch);
    const updated = await ctx.db.get(runId);
    if (!updated) {
      throw new Error("Run not found");
    }
    return updated;
  },
});
