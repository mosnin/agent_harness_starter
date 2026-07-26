/**
 * DROP THIS FILE INTO: your-app/src/app/api/agent/[runId]/cancel/route.ts
 *
 * Cancels an in-progress agent run.
 *
 * The SSE stream for the run is severed by the client closing its connection
 * (AbortSignal), but calling this endpoint additionally:
 *   - Cancels any pending tool approvals for the run
 *   - Marks the DB run record as "cancelled"
 *
 * POST /api/agent/[runId]/cancel
 */

import { auth } from "@/agents/auth";
import { db } from "@/agents/db";
import { cancelRunApprovals } from "@/agents/approvals";

export async function POST(
  req: Request,
  { params }: { params: { runId: string } }
) {
  try {
    await auth.requireAuth(req);

    cancelRunApprovals(params.runId);

    const run = await db.getRun(params.runId);
    if (run && run.status === "running") {
      await db.updateRun(params.runId, {
        status: "cancelled",
        completedAt: new Date(),
      });
    }

    return Response.json({ success: true, runId: params.runId });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[/api/agent/[runId]/cancel]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
