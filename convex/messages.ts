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
    const id = await ctx.db.insert("agent_messages", args);
    await ctx.db.patch(args.threadId, { updatedAt: Date.now() });
    const created = await ctx.db.get(id);
    if (!created) {
      throw new Error("Message not found");
    }
    return created;
  },
});

export const list = internalQuery({
  args: { threadId: v.id("agent_threads") },
  returns: v.array(messageDoc),
  handler: async (ctx, { threadId }) => {
    await requireOwnedThread(ctx, threadId);
    return await ctx.db
      .query("agent_messages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
  },
});
