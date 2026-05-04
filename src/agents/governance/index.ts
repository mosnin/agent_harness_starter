// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  RiskLevel,
  GovernanceOutcome,
  GovernanceContext,
  GovernanceRule,
  GovernanceDecision,
  ComplianceRecord,
  EscalationEvent,
  EscalationReason,
} from "./types";

// ── Policy ────────────────────────────────────────────────────────────────────
export {
  createGovernancePolicy,
  evaluate,
  blockTools,
  blockContentPatterns,
  restrictAgentTargets,
  rateLimit,
  DEFAULT_GOVERNANCE_POLICY,
  GovernancePolicyViolationError,
} from "./policy";
export type { GovernancePolicyConfig, GovernancePolicy } from "./policy";

// ── Ethics ────────────────────────────────────────────────────────────────────
export {
  createEthicsPolicy,
  STANDARD_ETHICS_RULES,
  STANDARD_ETHICS_POLICY,
  noIdentityDeception,
  noPiiInOutput,
  noHarmfulContent,
  flagFabricatedCitations,
  requireAuthorizationForCommitments,
  noDiscriminatoryLanguage,
} from "./ethics";
export type { EthicsPolicyConfig, EthicsPolicy } from "./ethics";

// ── Compliance ────────────────────────────────────────────────────────────────
export {
  createComplianceTracker,
  compliance,
} from "./compliance";
export type {
  ComplianceTrackerConfig,
  ComplianceTracker,
  ComplianceSink,
  ComplianceQuery,
  ComplianceStats,
} from "./compliance";

// ── Escalation ────────────────────────────────────────────────────────────────
export {
  createEscalationHandler,
  checkEscalationTriggers,
  lowConfidenceTrigger,
  sensitiveToolTrigger,
  repeatedViolationTrigger,
  EscalationError,
} from "./escalation";
export type {
  EscalationHandlerConfig,
  EscalationHandler,
  EscalationTrigger,
} from "./escalation";

// ── Adaptation ────────────────────────────────────────────────────────────────
export { createAdaptationPolicy } from "./adaptation";
export type {
  AdaptationPolicyConfig,
  AdaptationPolicy,
  AdaptationProposal,
  AdaptationLogEntry,
  ProposalType,
  ProposalStatus,
} from "./adaptation";

// ── Plugin ────────────────────────────────────────────────────────────────────
export { withGovernance } from "./plugin";
export type { GovernancePluginOptions } from "./plugin";
