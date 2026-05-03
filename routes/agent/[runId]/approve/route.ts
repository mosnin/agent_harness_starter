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

const bodySchema = z.object({
  approvalId: z.string(),
  decision: z.enum(["approved", "rejected"]),
});

export async function POST(
  req: Request,
  { params }: { params: { runId: string } }
) {
  try {
    await auth.requireAuth(req);

    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: parsed.error.flatten() }, { status: 422 });
    }

    const { approvalId, decision } = parsed.data;

    // Verify approval belongs to this run
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
