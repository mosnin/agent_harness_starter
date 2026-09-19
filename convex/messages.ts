import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { requireOwnedThread } from "./lib/auth";
import { messageDoc } from "./lib/validators";

export const save = internalMutation({
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
  returns: messageDoc,
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, args.threadId);
    const max = 32_000;
    const content = args.content.length <= max ? args.content : `${args.content.slice(0, max)}…`;
    const id = await ctx.db.insert("agent_messages", { ...args, content });
    await ctx.db.patch(args.threadId, { updatedAt: Date.now() });
    const created = await ctx.db.get(id);
    if (!created) {
      throw new Error("Message not found");
    }
    return created;
  },
});

export const list = internalQuery({
  args: { threadId: v.id("agent_threads"), limit: v.optional(v.number()) },
  returns: v.array(messageDoc),
  handler: async (ctx, { threadId, limit }) => {
    await requireOwnedThread(ctx, threadId);
    const indexed = ctx.db
      .query("agent_messages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId));
    const take = limit !== undefined && Number.isFinite(limit) && limit >= 0 ? limit : 100;
    const newest = await indexed.order("desc").take(take);
    return newest.reverse();
  },
});
