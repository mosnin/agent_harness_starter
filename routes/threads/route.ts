/**
 * GET  /api/threads         — list threads for authenticated user
 * POST /api/threads         — create a new thread
 * DELETE /api/threads/[id]  — delete an owned thread (see ./[id]/route.ts)
 */

import { z } from "zod";
import { auth } from "@/agents/auth";
import { db } from "@/agents/db";
import { capListedThreads, oversizeJsonResponse } from "@/agents/lib/request-guard";

export async function GET(req: Request) {
  const user = await auth.requireAuth(req);
  const threads = capListedThreads(await db.listThreads(user.id));
  return Response.json({ threads });
}

export async function POST(req: Request) {
  const user = await auth.requireAuth(req);
  const oversize = oversizeJsonResponse(req);
  if (oversize) return oversize;
  const body = await req.json().catch(() => ({}));
  const title = z.string().max(200).optional().parse((body as Record<string, unknown>).title);
  const thread = await db.createThread(user.id, title);
  return Response.json({ thread }, { status: 201 });
}
