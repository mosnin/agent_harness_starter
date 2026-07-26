/**
 * GET  /api/threads         — list threads for authenticated user
 * POST /api/threads         — create a new thread
 * DELETE /api/threads/:id   — delete a thread
 */

import { z } from "zod";
import { auth } from "@/agents/auth";
import { db } from "@/agents/db";

export async function GET(req: Request) {
  const user = await auth.requireAuth(req);
  const threads = await db.listThreads(user.id);
  return Response.json({ threads });
}

export async function POST(req: Request) {
  const user = await auth.requireAuth(req);
  const body = await req.json().catch(() => ({}));
  const title = z.string().optional().parse((body as Record<string, unknown>).title);
  const thread = await db.createThread(user.id, title);
  return Response.json({ thread }, { status: 201 });
}
