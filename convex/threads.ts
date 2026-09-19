import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { loadOwnedThread, requireIdentity, requireOwnedThread } from "./lib/auth";
import { threadDoc } from "./lib/validators";

export const create = internalMutation({
  args: { userId: v.string(), title: v.optional(v.string()) },
  returns: threadDoc,
  handler: async (ctx, { userId, title }) => {
    const subject = await requireIdentity(ctx);
    if (userId !== subject) {
      throw new Error("Unauthorized");
    }
    const now = Date.now();
    const id = await ctx.db.insert("agent_threads", {
      userId: subject,
      title,
      updatedAt: now,
    });
    const created = await ctx.db.get(id);
    if (!created) {
      throw new Error("Thread not found");
    }
    return created;
  },
});

export const get = internalQuery({
  args: { threadId: v.id("agent_threads") },
  returns: v.union(threadDoc, v.null()),
  handler: async (ctx, { threadId }) => {
    const { thread } = await loadOwnedThread(ctx, threadId);
    return thread;
  },
});

export const listByUser = internalQuery({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(threadDoc),
  handler: async (ctx, { userId, limit }) => {
    const subject = await requireIdentity(ctx);
    if (userId !== subject) {
      throw new Error("Unauthorized");
    }
    const take = limit !== undefined && Number.isFinite(limit) && limit >= 0 ? limit : 50;
    return await ctx.db
      .query("agent_threads")
      .withIndex("by_user_and_updated", (q) => q.eq("userId", subject))
      .order("desc")
      .take(take);
  },
});

export const deleteThread = internalMutation({
  args: { threadId: v.id("agent_threads") },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    await requireOwnedThread(ctx, threadId);
    const page = 64;
    for (;;) {
      const messages = await ctx.db
        .query("agent_messages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .take(page);
      if (messages.length === 0) break;
      for (const message of messages) {
        await ctx.db.delete(message._id);
      }
    }
    for (;;) {
      const runs = await ctx.db
        .query("agent_runs")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .take(page);
      if (runs.length === 0) break;
      for (const run of runs) {
        await ctx.db.delete(run._id);
      }
    }
    await ctx.db.delete(threadId);
    return null;
  },
});
