import { randomUUID } from "crypto";
import type { Claim, ClaimStatus, Claimant, ClaimsFilter, ClaimsStats } from "./types";

const TERMINAL_STATUSES = new Set<ClaimStatus>(["completed", "failed", "cancelled"]);

const VALID_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  open:      ["claimed", "cancelled"],
  claimed:   ["active", "cancelled"],
  active:    ["paused", "blocked", "completed", "failed", "cancelled"],
  paused:    ["active", "blocked", "cancelled"],
  blocked:   ["active", "cancelled", "failed"],
  stealable: ["claimed"],
  completed: [],
  failed:    [],
  cancelled: [],
};

export class ClaimsService {
  private claims = new Map<string, Claim>();
  private stealCount = 0;
  private completionDurations: number[] = [];

  private getClaim(claimId: string): Claim {
    const claim = this.claims.get(claimId);
    if (!claim) {
      throw new Error(`Claim not found: ${claimId}`);
    }
    return claim;
  }

  private transition(claimId: string, to: ClaimStatus): Claim {
    const claim = this.getClaim(claimId);
    const allowed = VALID_TRANSITIONS[claim.status];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid transition for claim ${claimId}: ${claim.status} → ${to}`
      );
    }
    const updated: Claim = { ...claim, status: to };
    this.claims.set(claimId, updated);
    return updated;
  }

  create(input: {
    title: string;
    description: string;
    priority?: number;
    tags?: string[];
    expiresAt?: number;
    stealAfterMs?: number;
    metadata?: Record<string, unknown>;
  }): Claim {
    const claim: Claim = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      status: "open",
      priority: Math.min(10, Math.max(1, input.priority ?? 5)),
      createdAt: Date.now(),
      tags: input.tags ?? [],
      expiresAt: input.expiresAt,
      stealAfterMs: input.stealAfterMs,
      metadata: input.metadata,
    };
    this.claims.set(claim.id, claim);
    return claim;
  }

  claim(claimId: string, claimant: Claimant): Claim {
    this.transition(claimId, "claimed");
    const updated: Claim = {
      ...this.getClaim(claimId),
      claimant,
      claimedAt: Date.now(),
    };
    this.claims.set(claimId, updated);
    return updated;
  }

  start(claimId: string): Claim {
    this.transition(claimId, "active");
    const updated: Claim = {
      ...this.getClaim(claimId),
      startedAt: Date.now(),
    };
    this.claims.set(claimId, updated);
    return updated;
  }

  pause(claimId: string, reason?: string): Claim {
    this.transition(claimId, "paused");
    const claim = this.getClaim(claimId);
    if (reason) {
      const updated: Claim = { ...claim, metadata: { ...claim.metadata, pauseReason: reason } };
      this.claims.set(claimId, updated);
      return updated;
    }
    return claim;
  }

  resume(claimId: string): Claim {
    return this.transition(claimId, "active");
  }

  block(claimId: string, reason?: string): Claim {
    this.transition(claimId, "blocked");
    const claim = this.getClaim(claimId);
    if (reason) {
      const updated: Claim = { ...claim, metadata: { ...claim.metadata, blockReason: reason } };
      this.claims.set(claimId, updated);
      return updated;
    }
    return claim;
  }

  complete(claimId: string, result?: unknown): Claim {
    const before = this.getClaim(claimId);
    this.transition(claimId, "completed");
    const completedAt = Date.now();
    const updated: Claim = {
      ...this.getClaim(claimId),
      completedAt,
      result,
    };
    this.claims.set(claimId, updated);
    if (before.startedAt !== undefined) {
      this.completionDurations.push(completedAt - before.startedAt);
    }
    return updated;
  }

  fail(claimId: string, error: string): Claim {
    this.transition(claimId, "failed");
    const updated: Claim = {
      ...this.getClaim(claimId),
      error,
      completedAt: Date.now(),
    };
    this.claims.set(claimId, updated);
    return updated;
  }

  cancel(claimId: string): Claim {
    return this.transition(claimId, "cancelled");
  }

  steal(claimId: string, newClaimant: Claimant): Claim {
    const claim = this.getClaim(claimId);
    if (claim.status !== "stealable") {
      throw new Error(
        `Cannot steal claim ${claimId}: status is "${claim.status}", expected "stealable"`
      );
    }
    this.stealCount++;
    const updated: Claim = {
      ...claim,
      status: "claimed",
      claimant: newClaimant,
      claimedAt: Date.now(),
      startedAt: undefined,
    };
    this.claims.set(claimId, updated);
    return updated;
  }

  tick(): { expired: string[]; markedStealable: string[] } {
    const now = Date.now();
    const expired: string[] = [];
    const markedStealable: string[] = [];

    for (const claim of this.claims.values()) {
      // Expire open/claimed claims past expiresAt
      if (
        claim.expiresAt !== undefined &&
        claim.expiresAt < now &&
        (claim.status === "open" || claim.status === "claimed")
      ) {
        const updated: Claim = { ...claim, status: "failed", error: "expired" };
        this.claims.set(claim.id, updated);
        expired.push(claim.id);
        continue;
      }

      // Mark stealable: active claims past stealAfterMs
      if (
        claim.status === "active" &&
        claim.stealAfterMs !== undefined &&
        claim.startedAt !== undefined &&
        claim.startedAt + claim.stealAfterMs < now
      ) {
        const updated: Claim = { ...claim, status: "stealable" };
        this.claims.set(claim.id, updated);
        markedStealable.push(claim.id);
      }
    }

    return { expired, markedStealable };
  }

  get(claimId: string): Claim | undefined {
    return this.claims.get(claimId);
  }

  list(filter?: ClaimsFilter): Claim[] {
    let results = Array.from(this.claims.values());

    if (filter) {
      if (filter.status !== undefined) {
        if (Array.isArray(filter.status)) {
          const statusSet = new Set(filter.status);
          results = results.filter((c) => statusSet.has(c.status));
        } else {
          results = results.filter((c) => c.status === filter.status);
        }
      }
      if (filter.claimantId !== undefined) {
        results = results.filter((c) => c.claimant?.id === filter.claimantId);
      }
      if (filter.tag !== undefined) {
        const tag = filter.tag;
        results = results.filter((c) => c.tags.includes(tag));
      }
      if (filter.minPriority !== undefined) {
        const min = filter.minPriority;
        results = results.filter((c) => c.priority >= min);
      }
    }

    return results;
  }

  getStats(): ClaimsStats {
    const byStatus: Record<ClaimStatus, number> = {
      open: 0,
      claimed: 0,
      active: 0,
      paused: 0,
      blocked: 0,
      stealable: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const claim of this.claims.values()) {
      byStatus[claim.status]++;
    }

    const avgCompletionMs =
      this.completionDurations.length > 0
        ? this.completionDurations.reduce((a, b) => a + b, 0) /
          this.completionDurations.length
        : 0;

    return {
      total: this.claims.size,
      byStatus,
      avgCompletionMs,
      stealCount: this.stealCount,
    };
  }

  findBest(claimant: Claimant, preferredTags?: string[]): Claim | undefined {
    const open = this.list({ status: "open" });
    if (open.length === 0) return undefined;

    const preferred = preferredTags ?? [];

    open.sort((a, b) => {
      // Sort by priority descending first
      if (b.priority !== a.priority) return b.priority - a.priority;
      // Then by tag match count descending
      const aMatches = a.tags.filter((t) => preferred.includes(t)).length;
      const bMatches = b.tags.filter((t) => preferred.includes(t)).length;
      return bMatches - aMatches;
    });

    return open[0];
  }
}
