/**
 * Governance types — shared interfaces for policy, escalation,
 * compliance, ethics, and adaptation subsystems.
 */

// ── Severity / risk ───────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type GovernanceOutcome =
  | "allowed"
  | "blocked"
  | "escalated"
  | "flagged"
  | "modified";

// ── Governance context ────────────────────────────────────────────────────────

/** Runtime context passed to every governance check. */
export interface GovernanceContext {
  agentId: string;
  userId?: string;
  threadId?: string;
  action: string;       // e.g. "tool:shell_exec", "output", "store_memory"
  content?: string;     // message or tool input being evaluated
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

// ── Governance rule ───────────────────────────────────────────────────────────

export interface GovernanceRule {
  /** Unique rule identifier. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Risk level triggered by a violation. */
  risk: RiskLevel;
  /** Whether violation should block the action entirely. */
  blocking?: boolean;
  /**
   * Predicate: return true if the rule is violated.
   * Async to allow DB lookups, external policy APIs, etc.
   */
  check(ctx: GovernanceContext): boolean | Promise<boolean>;
}

// ── Governance decision ───────────────────────────────────────────────────────

export interface GovernanceDecision {
  outcome: GovernanceOutcome;
  ruleId?: string;
  risk: RiskLevel;
  reason: string;
  /** Modified content (when outcome === "modified"). */
  modifiedContent?: string;
  timestamp: number;
}

// ── Compliance record ─────────────────────────────────────────────────────────

export interface ComplianceRecord {
  id: string;
  agentId: string;
  userId?: string;
  threadId?: string;
  action: string;
  decision: GovernanceDecision;
  content?: string;
  contentHash?: string;
  timestamp: number;
}

// ── Escalation event ──────────────────────────────────────────────────────────

export type EscalationReason =
  | "high_risk_action"
  | "policy_violation"
  | "low_confidence"
  | "irreversible_action"
  | "ethical_concern"
  | "manual_request"
  | "repeated_violation";

export interface EscalationEvent {
  id: string;
  agentId: string;
  userId?: string;
  threadId?: string;
  reason: EscalationReason;
  description: string;
  context: GovernanceContext;
  timestamp: number;
  resolved: boolean;
  resolvedAt?: number;
  resolution?: string;
}
