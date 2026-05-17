import { randomUUID } from "crypto";

export type ClaimStatus =
  | "open"          // available to claim
  | "claimed"       // assigned but not started
  | "active"        // being worked on
  | "paused"        // temporarily stopped
  | "blocked"       // waiting on dependency
  | "stealable"     // claimed but inactive too long — can be reassigned
  | "completed"     // done
  | "failed"        // terminal error
  | "cancelled";    // explicitly cancelled

export type ClaimantType = "human" | "agent" | "system";

export interface Claimant {
  id: string;
  type: ClaimantType;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface Claim {
  id: string;
  title: string;
  description: string;
  status: ClaimStatus;
  priority: number;           // 1-10
  claimant?: Claimant;
  createdAt: number;
  claimedAt?: number;
  startedAt?: number;
  completedAt?: number;
  expiresAt?: number;         // auto-expire if not started
  stealAfterMs?: number;      // mark stealable if active > this duration
  result?: unknown;
  error?: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface ClaimsFilter {
  status?: ClaimStatus | ClaimStatus[];
  claimantId?: string;
  tag?: string;
  minPriority?: number;
}

export interface ClaimsStats {
  total: number;
  byStatus: Record<ClaimStatus, number>;
  avgCompletionMs: number;
  stealCount: number;
}
