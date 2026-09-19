/**
 * Convex DB adapter.
 * Requires running `npx convex dev` and deploying the functions in /convex.
 *
 * Thread / message / run functions are **internal**. The HTTP adapter
 * authenticates with CONVEX_ADMIN_KEY (or CONVEX_DEPLOY_KEY) and acts
 * as the request user. A leaked CONVEX_URL alone cannot read or write.
 */

import type { DbAdapter, AgentThread, AgentMessage, AgentRun } from "../types";
import { config } from "../../lib/config";
import { convexActingIdentity, convexAdminKey } from "./auth";
import { mapConvexMessage, mapConvexRun, mapConvexThread } from "./map";

interface ConvexHttp {
  mutation: (path: string, args: Record<string, unknown>) => Promise<unknown>;
  query: (path: string, args?: Record<string, unknown>) => Promise<unknown>;
  setAdminAuth: (token: string, identity?: { issuer: string; subject: string }) => void;
}

function requireUserId(userId: string | undefined, method: string): string {
  if (!userId?.trim()) {
    throw new Error(`Convex adapter ${method} requires the authenticated userId`);
  }
  return userId;
}

function getConvexClient(userId: string): ConvexHttp {
  const url = config.db.convex.url;
  if (!url) {
    throw new Error("Missing CONVEX_URL (or NEXT_PUBLIC_CONVEX_URL)");
  }
  const adminKey = config.db.convex.adminKey || convexAdminKey();
  if (!adminKey) {
    throw new Error("Missing CONVEX_ADMIN_KEY (or CONVEX_DEPLOY_KEY)");
  }
  const { ConvexHttpClient } = require("convex/browser") as {
    ConvexHttpClient: new (deploymentUrl: string) => ConvexHttp;
  };
  const client = new ConvexHttpClient(url);
  client.setAdminAuth(adminKey, convexActingIdentity(userId));
  return client;
}

export const convexAdapter: DbAdapter = {
  async createThread(userId, title) {
    const client = getConvexClient(userId);
    const data = await client.mutation("threads:create", {
      userId,
      ...(title ? { title } : {}),
    });
    return mapConvexThread(data as Record<string, unknown>);
  },

  async getThread(threadId, userId) {
    const client = getConvexClient(requireUserId(userId, "getThread"));
    const data = await client.query("threads:get", { threadId });
    return data ? mapConvexThread(data as Record<string, unknown>) : null;
  },

  async listThreads(userId) {
    const client = getConvexClient(userId);
    const data = await client.query("threads:listByUser", { userId });
    return ((data as unknown[]) ?? []).map((row) =>
      mapConvexThread(row as Record<string, unknown>)
    );
  },

  async deleteThread(threadId, userId) {
    const client = getConvexClient(requireUserId(userId, "deleteThread"));
    await client.mutation("threads:deleteThread", { threadId });
  },

  async saveMessage(msg, userId) {
    const client = getConvexClient(requireUserId(userId, "saveMessage"));
    const data = await client.mutation("messages:save", msg);
    return mapConvexMessage(data as Record<string, unknown>);
  },

  async getMessages(threadId, userId) {
    const client = getConvexClient(requireUserId(userId, "getMessages"));
    const data = await client.query("messages:list", { threadId });
    return ((data as unknown[]) ?? []).map((row) =>
      mapConvexMessage(row as Record<string, unknown>)
    );
  },

  async createRun(run, userId) {
    const client = getConvexClient(requireUserId(userId, "createRun"));
    const data = await client.mutation("runs:create", run);
    return mapConvexRun(data as Record<string, unknown>);
  },

  async updateRun(runId, update, userId) {
    const client = getConvexClient(requireUserId(userId, "updateRun"));
    const data = await client.mutation("runs:update", {
      runId,
      status: update.status,
      error: update.error,
      completedAt: update.completedAt ? update.completedAt.getTime() : undefined,
    });
    return mapConvexRun(data as Record<string, unknown>);
  },

  async getRun(runId, userId) {
    const client = getConvexClient(requireUserId(userId, "getRun"));
    const data = await client.query("runs:get", { runId });
    return data ? mapConvexRun(data as Record<string, unknown>) : null;
  },
};

export type { AgentThread, AgentMessage, AgentRun };
