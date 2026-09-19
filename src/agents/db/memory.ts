/**
 * In-memory DB adapter — the default when no DB_PROVIDER is set.
 * Data is lost on server restart. Perfect for local dev and prototyping.
 */

const randomUUID = () => globalThis.crypto.randomUUID();
import type { DbAdapter, AgentThread, AgentMessage, AgentRun } from "./types";
import { assertOwned, ownedOrNull } from "./owner";

export function createMemoryAdapter(): DbAdapter {
  const threads = new Map<string, AgentThread>();
  const messages = new Map<string, AgentMessage[]>();
  const runs = new Map<string, AgentRun>();

  function requireThread(threadId: string, userId: string | undefined, action: string): AgentThread {
    const thread = threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    assertOwned(thread.userId, userId, action);
    return thread;
  }

  return {
    async createThread(userId, title) {
      const thread: AgentThread = {
        id: randomUUID(),
        userId,
        title,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      threads.set(thread.id, thread);
      return thread;
    },

    async getThread(threadId, userId) {
      const thread = threads.get(threadId) ?? null;
      return ownedOrNull(thread, thread?.userId, userId);
    },

    async listThreads(userId) {
      return Array.from(threads.values())
        .filter((t) => t.userId === userId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    },

    async deleteThread(threadId, userId) {
      const thread = threads.get(threadId);
      if (!thread) return;
      assertOwned(thread.userId, userId, "delete");
      threads.delete(threadId);
      messages.delete(threadId);
      for (const [runId, run] of runs) {
        if (run.threadId === threadId) runs.delete(runId);
      }
    },

    async saveMessage(msg, userId) {
      requireThread(msg.threadId, userId, "write");
      const message: AgentMessage = {
        ...msg,
        id: randomUUID(),
        createdAt: new Date(),
      };
      const list = messages.get(msg.threadId) ?? [];
      list.push(message);
      messages.set(msg.threadId, list);
      const thread = threads.get(msg.threadId);
      if (thread) threads.set(msg.threadId, { ...thread, updatedAt: new Date() });
      return message;
    },

    async getMessages(threadId, userId, opts) {
      const thread = threads.get(threadId);
      if (!ownedOrNull(thread ?? null, thread?.userId, userId)) return [];
      const rows = messages.get(threadId) ?? [];
      const limit = opts?.limit;
      if (limit !== undefined && Number.isFinite(limit) && limit >= 0) {
        return rows.slice(-limit);
      }
      return rows;
    },

    async createRun(run, userId) {
      requireThread(run.threadId, userId, "write");
      const record: AgentRun = {
        ...run,
        id: randomUUID(),
        startedAt: new Date(),
      };
      runs.set(record.id, record);
      return record;
    },

    async updateRun(runId, update, userId) {
      const existing = runs.get(runId);
      if (!existing) throw new Error(`Run not found: ${runId}`);
      requireThread(existing.threadId, userId, "write");
      const updated = { ...existing, ...update };
      runs.set(runId, updated);
      return updated;
    },

    async getRun(runId, userId) {
      const run = runs.get(runId);
      if (!run) return null;
      const thread = threads.get(run.threadId);
      return ownedOrNull(run, thread?.userId, userId);
    },
  };
}

export const memoryAdapter: DbAdapter = createMemoryAdapter();
