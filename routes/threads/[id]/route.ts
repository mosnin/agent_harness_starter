/**
 * DROP THIS FILE INTO: your-app/src/app/api/threads/[id]/route.ts
 *
 * DELETE /api/threads/[id]
 *
 * The collection route advertised this and `db.deleteThread` has no owner
 * check. Anyone who guessed a thread id could wipe another user's history.
 * Auth + ownership first; missing and non-owned threads both 404.
 */

import { auth } from "@/agents/auth";
import { db } from "@/agents/db";
import { getOwnedThread } from "@/agents/lib/run-owner";

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await auth.requireAuth(req);
    const thread = await getOwnedThread(db, params.id, user.id);
    if (!thread) {
      return Response.json({ error: "Thread not found" }, { status: 404 });
    }
    await db.deleteThread(params.id);
    return Response.json({ success: true, threadId: params.id });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[/api/threads/[id]]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
