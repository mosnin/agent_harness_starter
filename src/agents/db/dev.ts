// Development-only DB adapter — uses in-memory maps. Never use in production.
import type { DbAdapter, AgentThread, AgentMessage, AgentRun } from "./types";

const randomUUID = () => globalThis.crypto.randomUUID();

const threads = new Map<string, AgentThread>();
const messages = new Map<string, AgentMessage[]>();
const runs = new Map<string, AgentRun>();

export const devDb: DbAdapter = {
  async createThread(userId: string, title?: string) {
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

  async getThread(threadId: string) {
    return threads.get(threadId) ?? null;
  },

  async listThreads(userId: string) {
    return [...threads.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  },

  async deleteThread(threadId: string) {
    threads.delete(threadId);
    messages.delete(threadId);
  },

  async saveMessage(msg) {
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

  async getMessages(threadId: string) {
    return messages.get(threadId) ?? [];
  },

  async createRun(run) {
    const record: AgentRun = {
      ...run,
      id: randomUUID(),
      startedAt: new Date(),
    };
    runs.set(record.id, record);
    return record;
  },

  async updateRun(runId: string, update) {
    const existing = runs.get(runId);
    if (!existing) throw new Error(`Run not found: ${runId}`);
    const updated = { ...existing, ...update };
    runs.set(runId, updated);
    return updated;
  },

  async getRun(runId: string) {
    return runs.get(runId) ?? null;
  },
};
