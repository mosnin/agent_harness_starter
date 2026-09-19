/**
 * DROP THIS FILE INTO: your-app/src/app/api/agent/[runId]/approve/route.ts
 *
 * Human-in-the-loop approval endpoint.
 *
 * When the agent harness requires approval for a tool call, it emits:
 *   { type: "approval_required", runId, approvalId, toolName, input, description }
 *
 * The client displays this to the user. On user action, POST here:
 *   POST /api/agent/[runId]/approve
 *   { approvalId: string, decision: "approved" | "rejected" }
 *
 * The harness's suspended generator resumes immediately.
 */

import { z } from "zod";
import { auth } from "@/agents/auth";
import { resolveApproval, getApproval } from "@/agents/approvals";
import { db } from "@/agents/db";
import { getOwnedRun } from "@/agents/lib/run-owner";
import { readCappedJson } from "@/agents/lib/request-guard";

const bodySchema = z.object({
  approvalId: z.string(),
  decision: z.enum(["approved", "rejected"]),
});

export async function POST(
  req: Request,
  { params }: { params: { runId: string } }
) {
  try {
    const user = await auth.requireAuth(req);
    if (!(await getOwnedRun(db, params.runId, user.id))) {
      return Response.json({ error: "Run not found" }, { status: 404 });
    }

    const parsedBody = await readCappedJson(req);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = bodySchema.safeParse(parsedBody.value);
    if (!parsed.success) {
      return Response.json({ error: parsed.error.flatten() }, { status: 422 });
    }

    const { approvalId, decision } = parsed.data;

    const approval = getApproval(approvalId);
    if (!approval) {
      return Response.json({ error: "Approval not found or already resolved" }, { status: 404 });
    }
    if (approval.runId !== params.runId) {
      return Response.json({ error: "Approval does not belong to this run" }, { status: 403 });
    }

    const resolved = resolveApproval(approvalId, decision === "approved");
    if (!resolved) {
      return Response.json({ error: "Failed to resolve approval" }, { status: 409 });
    }

    return Response.json({ success: true, decision });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[/api/agent/[runId]/approve]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
