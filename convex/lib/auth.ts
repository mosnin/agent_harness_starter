/**
 * Convex RLS-style wrappers: every public/internal function that
 * touches agent_* rows must have an identity and must own the thread.
 *
 * The Next.js adapter calls these with ConvexHttpClient.setAdminAuth
 * acting as the HTTP user (`issuer: "hades"`, `subject: userId`).
 * Unauthenticated Convex URL callers get "Not authenticated".
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type DbCtx = QueryCtx | MutationCtx;

export async function requireIdentity(ctx: DbCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  const subject = identity?.subject?.trim();
  if (!subject) {
    throw new Error("Not authenticated");
  }
  return subject;
}

export async function requireOwnedThread(
  ctx: DbCtx,
  threadId: Id<"agent_threads">
) {
  const subject = await requireIdentity(ctx);
  const thread = await ctx.db.get(threadId);
  if (!thread || thread.userId !== subject) {
    throw new Error("Unauthorized");
  }
  return { subject, thread };
}

export async function loadOwnedThread(
  ctx: DbCtx,
  threadId: Id<"agent_threads">
) {
  const subject = await requireIdentity(ctx);
  const thread = await ctx.db.get(threadId);
  if (!thread || thread.userId !== subject) {
    return { subject, thread: null };
  }
  return { subject, thread };
}

export async function requireOwnedRun(ctx: DbCtx, runId: Id<"agent_runs">) {
  const subject = await requireIdentity(ctx);
  const run = await ctx.db.get(runId);
  if (!run) {
    throw new Error("Unauthorized");
  }
  const thread = await ctx.db.get(run.threadId);
  if (!thread || thread.userId !== subject) {
    throw new Error("Unauthorized");
  }
  return { subject, run, thread };
}

export async function loadOwnedRun(ctx: DbCtx, runId: Id<"agent_runs">) {
  const subject = await requireIdentity(ctx);
  const run = await ctx.db.get(runId);
  if (!run) {
    return { subject, run: null, thread: null };
  }
  const thread = await ctx.db.get(run.threadId);
  if (!thread || thread.userId !== subject) {
    return { subject, run: null, thread: null };
  }
  return { subject, run, thread };
}
