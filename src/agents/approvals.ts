/**
 * Human-in-the-loop approval store.
 *
 * When the harness encounters a tool in requireApprovalFor[], it:
 *   1. Generates a unique approvalId
 *   2. Stores the pending approval here
 *   3. Emits an `approval_required` SSE event to the client
 *   4. Suspends the generator until the approval resolves
 *
 * The approval route (POST /api/agent/[runId]/approve) calls
 * resolveApproval(approvalId, "approved" | "rejected") to resume.
 *
 * Approvals are held in memory. For multi-replica deployments, replace this
 * with a Redis-backed or DB-backed store.
 */

import { randomUUID } from "crypto";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface PendingApproval {
  approvalId: string;
  runId: string;
  toolName: string;
  input: unknown;
  description: string;
  status: ApprovalStatus;
  createdAt: Date;
  resolve: (approved: boolean) => void;
}

const store = new Map<string, PendingApproval>();

/** Create a new pending approval and return a promise that resolves when it's acted on. */
export function createApproval(opts: {
  runId: string;
  toolName: string;
  input: unknown;
  description?: string;
}): { approvalId: string; promise: Promise<boolean> } {
  const approvalId = randomUUID();

  const promise = new Promise<boolean>((resolve) => {
    const approval: PendingApproval = {
      approvalId,
      runId: opts.runId,
      toolName: opts.toolName,
      input: opts.input,
      description: opts.description ?? `Approve execution of tool: ${opts.toolName}`,
      status: "pending",
      createdAt: new Date(),
      resolve,
    };
    store.set(approvalId, approval);
  });

  return { approvalId, promise };
}

/** Resolve a pending approval. Called by the API route. */
export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const approval = store.get(approvalId);
  if (!approval || approval.status !== "pending") return false;

  approval.status = approved ? "approved" : "rejected";
  approval.resolve(approved);
  store.delete(approvalId);
  return true;
}

/** Get a pending approval by ID (for the API route to validate). */
export function getApproval(approvalId: string): PendingApproval | undefined {
  return store.get(approvalId);
}

/** Get all pending approvals for a run. */
export function getRunApprovals(runId: string): PendingApproval[] {
  return Array.from(store.values()).filter((a) => a.runId === runId);
}

/** Clean up old pending approvals (e.g. if the run was cancelled). */
export function cancelRunApprovals(runId: string) {
  for (const [id, approval] of store) {
    if (approval.runId === runId) {
      approval.resolve(false);
      store.delete(id);
    }
  }
}
