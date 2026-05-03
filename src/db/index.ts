/**
 * DB adapter factory.
 * Reads DB_PROVIDER env var and returns the appropriate adapter.
 * Falls back to in-memory adapter for zero-config local dev.
 *
 * Usage:
 *   import { db } from "@/db";
 *   const thread = await db.createThread(userId, "My first chat");
 */

import type { DbAdapter } from "./types";
import { config } from "@/lib/config";
import { memoryAdapter } from "./memory";

const g = globalThis as typeof globalThis & { __db?: DbAdapter };

function createAdapter(): DbAdapter {
  const provider = config.db.provider;

  switch (provider) {
    case "supabase": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { supabaseAdapter } = require("./supabase/client");
      return supabaseAdapter as DbAdapter;
    }
    case "convex": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { convexAdapter } = require("./convex/client");
      return convexAdapter as DbAdapter;
    }
    case "prisma": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { prismaAdapter } = require("./prisma/client");
      return prismaAdapter as DbAdapter;
    }
    default:
      if (provider !== "supabase" && provider !== "convex" && provider !== "prisma") {
        console.info("[db] Using in-memory adapter (DB_PROVIDER not set). Data won't persist.");
      }
      return memoryAdapter;
  }
}

// Singleton — survives Next.js HMR in dev
export const db: DbAdapter = g.__db ?? (g.__db = createAdapter());

export type { DbAdapter, AgentThread, AgentMessage, AgentRun } from "./types";
