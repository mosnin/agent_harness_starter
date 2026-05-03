/**
 * In-memory DB adapter — the default when no DB_PROVIDER is set.
 * Data is lost on server restart. Perfect for local dev and prototyping.
 */

import { randomUUID } from "crypto";
import type { DbAdapter, AgentThread, AgentMessage, AgentRun } from "./types";

const threads = new Map<string, AgentThread>();
const messages = new Map<string, AgentMessage[]>();
const runs = new Map<string, AgentRun>();

export const memoryAdapter: DbAdapter = {
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

  async getThread(threadId) {
    return threads.get(threadId) ?? null;
  },

  async listThreads(userId) {
    return Array.from(threads.values())
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  },

  async deleteThread(threadId) {
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

    // bump thread updatedAt
    const thread = threads.get(msg.threadId);
    if (thread) threads.set(msg.threadId, { ...thread, updatedAt: new Date() });

    return message;
  },

  async getMessages(threadId) {
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

  async updateRun(runId, update) {
    const existing = runs.get(runId);
    if (!existing) throw new Error(`Run not found: ${runId}`);
    const updated = { ...existing, ...update };
    runs.set(runId, updated);
    return updated;
  },

  async getRun(runId) {
    return runs.get(runId) ?? null;
  },
};
