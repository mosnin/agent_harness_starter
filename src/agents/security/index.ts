export { createPolicy, createAuditedPolicy, applyPolicyToTools, PolicyViolationError, DEFAULT_DENY_POLICY } from "./policy";
export type { PolicyConfig, PolicyContext, PolicyCheckResult, AgentPolicy } from "./policy";

export { audit, AuditLogger, ConsoleAuditAdapter, InMemoryAuditAdapter, NoopAuditAdapter, hashInput } from "./audit";
export type { AuditRecord, AuditOutcome, AuditAdapter } from "./audit";

export { issueCapabilityToken, verifyCapabilityToken, resolveToolsFromToken, CapabilityError, revokeToken, isTokenRevoked } from "./capabilities";
export type { CapabilityTokenPayload, IssueTokenOptions } from "./capabilities";

// ── withSecurity plugin ───────────────────────────────────────────────────────
export { withSecurity } from "./plugin";
export type { SecurityPluginOptions } from "./plugin";

export { createRedisJtiStore, setJtiStore, getJtiStore } from "./redis-jti-store";
export type { JtiStore, RedisClient } from "./redis-jti-store";

export { createRbacPolicy } from "./rbac";
export type { RbacConfig, RbacRoleConfig } from "./rbac";

export { createWebhookAuditSink } from "./sinks/webhook";
export type { WebhookAuditSinkOptions } from "./sinks/webhook";
