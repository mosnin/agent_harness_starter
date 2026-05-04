export { createPolicy, applyPolicyToTools, PolicyViolationError, DEFAULT_DENY_POLICY } from "./policy";
export type { PolicyConfig, PolicyContext, PolicyCheckResult, AgentPolicy } from "./policy";

export { audit, AuditLogger, ConsoleAuditAdapter, InMemoryAuditAdapter, NoopAuditAdapter, hashInput } from "./audit";
export type { AuditRecord, AuditOutcome, AuditAdapter } from "./audit";

export { issueCapabilityToken, verifyCapabilityToken, resolveToolsFromToken, CapabilityError } from "./capabilities";
export type { CapabilityTokenPayload, IssueTokenOptions } from "./capabilities";

// ── withSecurity plugin ───────────────────────────────────────────────────────
export { withSecurity } from "./plugin";
export type { SecurityPluginOptions } from "./plugin";
