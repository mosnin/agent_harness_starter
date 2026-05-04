/**
 * Compliance tracking — an immutable audit trail of every governance decision.
 *
 * Every agent action that passes through a governance policy produces a
 * ComplianceRecord. Records can be queried for review, exported for audits,
 * or forwarded to external compliance systems (SIEM, data warehouses, etc.).
 *
 * Usage:
 *   import { createComplianceTracker } from "@/agents/governance/compliance";
 *
 *   const tracker = createComplianceTracker();
 *
 *   // Record a decision
 *   tracker.record({ agentId, action, decision, content });
 *
 *   // Query the log
 *   tracker.query({ agentId: "planner", outcome: "blocked", since: Date.now() - 86400_000 });
 *
 *   // Export all records (for external SIEM / data warehouse)
 *   const records = tracker.export();
 */

import { randomUUID, createHash } from "crypto";
import type { ComplianceRecord, GovernanceDecision, GovernanceContext, GovernanceOutcome } from "./types";

// ── Compliance tracker interface ──────────────────────────────────────────────

export interface ComplianceQuery {
  agentId?: string;
  userId?: string;
  outcome?: GovernanceOutcome;
  ruleId?: string;
  action?: string;
  /** Filter to records at or after this timestamp (ms). */
  since?: number;
  /** Filter to records at or before this timestamp (ms). */
  until?: number;
  limit?: number;
}

export interface ComplianceStats {
  total: number;
  byOutcome: Record<GovernanceOutcome, number>;
  byRuleId: Record<string, number>;
  violationRate: number;
}

export interface ComplianceTracker {
  /** Record a governance decision. */
  record(
    ctx: GovernanceContext,
    decision: GovernanceDecision
  ): ComplianceRecord;

  /** Query compliance records. */
  query(filter?: ComplianceQuery): ComplianceRecord[];

  /** Aggregate statistics over the stored records. */
  stats(filter?: Pick<ComplianceQuery, "agentId" | "userId" | "since" | "until">): ComplianceStats;

  /** Export all records as a JSON array (for external systems). */
  export(): ComplianceRecord[];

  /** Clear all records (use only in tests). */
  clear(): void;
}

// ── Compliance sink interface ─────────────────────────────────────────────────

export interface ComplianceSink {
  /**
   * Called for every recorded compliance record.
   * Forward to a SIEM, database, message queue, etc.
   * Errors are swallowed to avoid blocking the agent.
   */
  write(record: ComplianceRecord): void | Promise<void>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface ComplianceTrackerConfig {
  /** Maximum records kept in memory. Oldest are evicted. Default: 10_000. */
  maxRecords?: number;
  /** External sink (database, SIEM, etc.). */
  sink?: ComplianceSink;
  /**
   * Whether to store a SHA-256 content hash instead of raw content.
   * Protects sensitive data while preserving audit integrity. Default: true.
   */
  hashContent?: boolean;
}

export function createComplianceTracker(
  config: ComplianceTrackerConfig = {}
): ComplianceTracker {
  const maxRecords = config.maxRecords ?? 10_000;
  const hashContent = config.hashContent !== false;
  const records: ComplianceRecord[] = [];

  function record(ctx: GovernanceContext, decision: GovernanceDecision): ComplianceRecord {
    const contentHash = ctx.content
      ? createHash("sha256").update(ctx.content).digest("hex").slice(0, 16)
      : undefined;

    const entry: ComplianceRecord = {
      id: randomUUID(),
      agentId: ctx.agentId,
      userId: ctx.userId,
      threadId: ctx.threadId,
      action: ctx.action,
      decision,
      content: hashContent ? undefined : ctx.content,
      contentHash,
      timestamp: ctx.timestamp ?? Date.now(),
    };

    records.push(entry);

    if (records.length > maxRecords) {
      records.shift();
    }

    if (config.sink) {
      Promise.resolve(config.sink.write(entry)).catch(() => undefined);
    }

    return entry;
  }

  function query(filter: ComplianceQuery = {}): ComplianceRecord[] {
    let result = records;

    if (filter.agentId)  result = result.filter((r) => r.agentId === filter.agentId);
    if (filter.userId)   result = result.filter((r) => r.userId === filter.userId);
    if (filter.outcome)  result = result.filter((r) => r.decision.outcome === filter.outcome);
    if (filter.ruleId)   result = result.filter((r) => r.decision.ruleId === filter.ruleId);
    if (filter.action)   result = result.filter((r) => r.action === filter.action);
    if (filter.since)    result = result.filter((r) => r.timestamp >= filter.since!);
    if (filter.until)    result = result.filter((r) => r.timestamp <= filter.until!);

    return filter.limit ? result.slice(-filter.limit) : result;
  }

  function stats(
    filter: Pick<ComplianceQuery, "agentId" | "userId" | "since" | "until"> = {}
  ): ComplianceStats {
    const subset = query(filter);
    const byOutcome = {} as Record<GovernanceOutcome, number>;
    const byRuleId: Record<string, number> = {};

    for (const r of subset) {
      const o = r.decision.outcome;
      byOutcome[o] = (byOutcome[o] ?? 0) + 1;
      if (r.decision.ruleId) {
        byRuleId[r.decision.ruleId] = (byRuleId[r.decision.ruleId] ?? 0) + 1;
      }
    }

    const violations = (byOutcome["blocked"] ?? 0) + (byOutcome["escalated"] ?? 0) + (byOutcome["flagged"] ?? 0);
    return {
      total: subset.length,
      byOutcome,
      byRuleId,
      violationRate: subset.length > 0 ? violations / subset.length : 0,
    };
  }

  return {
    record,
    query,
    stats,
    export: () => [...records],
    clear: () => { records.length = 0; },
  };
}

// ── Global singleton (shared across all governance evaluations) ───────────────

declare global {
  // eslint-disable-next-line no-var
  var __complianceTracker: ComplianceTracker | undefined;
}

export const compliance: ComplianceTracker =
  globalThis.__complianceTracker ??
  (globalThis.__complianceTracker = createComplianceTracker());
