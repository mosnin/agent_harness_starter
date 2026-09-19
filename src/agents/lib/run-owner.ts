/**
 * Approve / cancel used to auth the caller and then trust `runId`.
 * Anyone who saw an SSE `runId` could cancel another user's run or
 * resolve their HITL approval. Code loads the run's thread and checks
 * ownership the same way ingress does.
 */

import type { AgentRun, AgentThread, DbAdapter } from "../db/types";
import { isThreadOwner } from "./thread-history";

export async function getOwnedThread(
  database: Pick<DbAdapter, "getThread">,
  threadId: string,
  userId: string
): Promise<AgentThread | null> {
  const thread = await database.getThread(threadId);
  return isThreadOwner(thread, userId) ? thread : null;
}

export async function getOwnedRun(
  database: Pick<DbAdapter, "getRun" | "getThread">,
  runId: string,
  userId: string
): Promise<AgentRun | null> {
  const run = await database.getRun(runId);
  if (!run) return null;
  const thread = await database.getThread(run.threadId);
  return isThreadOwner(thread, userId) ? run : null;
}
