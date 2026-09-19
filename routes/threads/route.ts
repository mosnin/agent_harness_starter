/**
 * GET  /api/threads         — list threads for authenticated user
 * POST /api/threads         — create a new thread
 * DELETE /api/threads/[id]  — delete an owned thread (see ./[id]/route.ts)
 */

import { z } from "zod";
import { auth } from "@/agents/auth";
import { db } from "@/agents/db";
import { capListedThreads, MAX_LIST_THREADS, readCappedJson } from "@/agents/lib/request-guard";

export async function GET(req: Request) {
  const user = await auth.requireAuth(req);
  const threads = capListedThreads(await db.listThreads(user.id, { limit: MAX_LIST_THREADS }));
  return Response.json({ threads });
}

export async function POST(req: Request) {
  const user = await auth.requireAuth(req);
  const parsedBody = await readCappedJson(req);
  if (!parsedBody.ok) return parsedBody.response;
  const record =
    parsedBody.value && typeof parsedBody.value === "object" && !Array.isArray(parsedBody.value)
      ? (parsedBody.value as Record<string, unknown>)
      : {};
  const title = z.string().max(200).optional().parse(record.title);
  const thread = await db.createThread(user.id, title);
  return Response.json({ thread }, { status: 201 });
}
