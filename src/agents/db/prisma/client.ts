/**
 * Prisma DB adapter.
 * Works with any database Prisma supports: PostgreSQL, MySQL, SQLite, MongoDB, etc.
 * Run `npm run db:generate` then `npm run db:push` after configuring DATABASE_URL.
 */

import type { DbAdapter, AgentThread, AgentMessage, AgentRun } from "../types";
import { assertOwned, ownedOrNull } from "../owner";

function getPrismaClient() {
  const { PrismaClient } = require("@prisma/client");
  const globalWithPrisma = global as typeof globalThis & { prisma?: InstanceType<typeof PrismaClient> };
  if (!globalWithPrisma.prisma) {
    globalWithPrisma.prisma = new PrismaClient();
  }
  return globalWithPrisma.prisma as {
    agentThread: {
      create: (args: object) => Promise<unknown>;
      findUnique: (args: object) => Promise<unknown>;
      findMany: (args: object) => Promise<unknown[]>;
      delete: (args: object) => Promise<void>;
    };
    agentMessage: {
      create: (args: object) => Promise<unknown>;
      findMany: (args: object) => Promise<unknown[]>;
    };
    agentRun: {
      create: (args: object) => Promise<unknown>;
      update: (args: object) => Promise<unknown>;
      findUnique: (args: object) => Promise<unknown>;
    };
  };
}

export const prismaAdapter: DbAdapter = {
  async createThread(userId, title) {
    const prisma = getPrismaClient();
    const data = await prisma.agentThread.create({
      data: { userId, title },
    });
    return dbToThread(data as Record<string, unknown>);
  },

  async getThread(threadId, userId) {
    const prisma = getPrismaClient();
    const data = await prisma.agentThread.findUnique({ where: { id: threadId } });
    const thread = data ? dbToThread(data as Record<string, unknown>) : null;
    return ownedOrNull(thread, thread?.userId, userId);
  },

  async listThreads(userId) {
    const prisma = getPrismaClient();
    const data = await prisma.agentThread.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    return data.map((d) => dbToThread(d as Record<string, unknown>));
  },

  async deleteThread(threadId, userId) {
    const prisma = getPrismaClient();
    const data = await prisma.agentThread.findUnique({ where: { id: threadId } });
    if (!data) return;
    const thread = dbToThread(data as Record<string, unknown>);
    assertOwned(thread.userId, userId, "delete");
    await prisma.agentThread.delete({ where: { id: threadId } });
  },

  async saveMessage(msg, userId) {
    const prisma = getPrismaClient();
    const thread = await prismaAdapter.getThread(msg.threadId, userId);
    if (!thread) throw new Error(`Thread not found: ${msg.threadId}`);
    const data = await prisma.agentMessage.create({
      data: {
        threadId: msg.threadId,
        role: msg.role,
        content: msg.content,
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
      },
    });
    return dbToMessage(data as Record<string, unknown>);
  },

  async getMessages(threadId, userId) {
    const thread = await prismaAdapter.getThread(threadId, userId);
    if (!thread) return [];
    const prisma = getPrismaClient();
    const data = await prisma.agentMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: "asc" },
    });
    return data.map((d) => dbToMessage(d as Record<string, unknown>));
  },

  async createRun(run, userId) {
    const thread = await prismaAdapter.getThread(run.threadId, userId);
    if (!thread) throw new Error(`Thread not found: ${run.threadId}`);
    const prisma = getPrismaClient();
    const data = await prisma.agentRun.create({
      data: {
        threadId: run.threadId,
        status: run.status,
        agentName: run.agentName,
        error: run.error,
        metadata: run.metadata ? JSON.stringify(run.metadata) : undefined,
      },
    });
    return dbToRun(data as Record<string, unknown>);
  },

  async updateRun(runId, update, userId) {
    const existing = await prismaAdapter.getRun(runId, userId);
    if (!existing) throw new Error(`Run not found: ${runId}`);
    const prisma = getPrismaClient();
    const data = await prisma.agentRun.update({
      where: { id: runId },
      data: {
        ...(update.status && { status: update.status }),
        ...(update.error !== undefined && { error: update.error }),
        ...(update.completedAt && { completedAt: update.completedAt }),
        ...(update.metadata && { metadata: JSON.stringify(update.metadata) }),
      },
    });
    return dbToRun(data as Record<string, unknown>);
  },

  async getRun(runId, userId) {
    const prisma = getPrismaClient();
    const data = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!data) return null;
    const run = dbToRun(data as Record<string, unknown>);
    const thread = await prismaAdapter.getThread(run.threadId, userId);
    return thread ? run : null;
  },
};

function dbToThread(row: Record<string, unknown>): AgentThread {
  return {
    id: row.id as string,
    userId: row.userId as string,
    title: row.title as string | undefined,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

function dbToMessage(row: Record<string, unknown>): AgentMessage {
  return {
    id: row.id as string,
    threadId: row.threadId as string,
    role: row.role as AgentMessage["role"],
    content: row.content as string,
    toolCallId: row.toolCallId as string | undefined,
    toolName: row.toolName as string | undefined,
    createdAt: row.createdAt as Date,
  };
}

function dbToRun(row: Record<string, unknown>): AgentRun {
  return {
    id: row.id as string,
    threadId: row.threadId as string,
    status: row.status as AgentRun["status"],
    agentName: row.agentName as string,
    startedAt: row.startedAt as Date,
    completedAt: row.completedAt as Date | undefined,
    error: row.error as string | undefined,
    metadata: row.metadata
      ? JSON.parse(row.metadata as string)
      : undefined,
  };
}
