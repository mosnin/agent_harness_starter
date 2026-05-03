/**
 * Convex DB adapter.
 * Requires running `npx convex dev` and deploying the functions in /convex.
 * Real-time subscriptions are available via Convex's React hooks (separate from this adapter).
 */

import type { DbAdapter, AgentThread, AgentMessage, AgentRun } from "../types";
import { config } from "../../lib/config";

function getConvexClient() {
  const { ConvexHttpClient } = require("convex/browser");
  return new ConvexHttpClient(config.db.convex.url) as {
    mutation: (path: string, args: Record<string, unknown>) => Promise<unknown>;
    query: (path: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

export const convexAdapter: DbAdapter = {
  async createThread(userId, title) {
    const client = getConvexClient();
    const data = await client.mutation("threads:create", { userId, title: title ?? null });
    return data as AgentThread;
  },

  async getThread(threadId) {
    const client = getConvexClient();
    const data = await client.query("threads:get", { threadId });
    return (data as AgentThread | null) ?? null;
  },

  async listThreads(userId) {
    const client = getConvexClient();
    const data = await client.query("threads:listByUser", { userId });
    return data as AgentThread[];
  },

  async deleteThread(threadId) {
    const client = getConvexClient();
    await client.mutation("threads:delete", { threadId });
  },

  async saveMessage(msg) {
    const client = getConvexClient();
    const data = await client.mutation("messages:save", msg);
    return data as AgentMessage;
  },

  async getMessages(threadId) {
    const client = getConvexClient();
    const data = await client.query("messages:list", { threadId });
    return data as AgentMessage[];
  },

  async createRun(run) {
    const client = getConvexClient();
    const data = await client.mutation("runs:create", run);
    return data as AgentRun;
  },

  async updateRun(runId, update) {
    const client = getConvexClient();
    const data = await client.mutation("runs:update", { runId, ...update });
    return data as AgentRun;
  },

  async getRun(runId) {
    const client = getConvexClient();
    const data = await client.query("runs:get", { runId });
    return (data as AgentRun | null) ?? null;
  },
};
