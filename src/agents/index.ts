// ── Harness (backward-compatible default) ─────────────────────────────────────
export { createHarness } from "./harness";
export type { HarnessConfig } from "./harness";

// ── Core engine (for custom plugin composition) ────────────────────────────────
export { createCoreHarness } from "./core";
export type { CoreConfig, AgentHarness } from "./core";

// ── Plugin factories ───────────────────────────────────────────────────────────
export { withMemory } from "./plugins/memory";
export type { MemoryPluginOptions } from "./plugins/memory";

export { withGuardrails } from "./plugins/guardrails";

export { withApprovals } from "./plugins/approvals";
export type { ApprovalsPluginOptions } from "./plugins/approvals";

export { withObservability } from "./plugins/observability";
export type { ObservabilityPluginOptions } from "./plugins/observability";

// ── Preset factories ───────────────────────────────────────────────────────────
export { createMinimalHarness, createStandardHarness, createFullHarness } from "./presets/index";
export type { MinimalConfig, StandardConfig, FullConfig } from "./presets/index";

// ── Agent definitions ──────────────────────────────────────────────────────────
export { defineAgent, AgentDefinitionBuilder, reasoningAgent, toolingAgent, retrievalAgent, communicationAgent, monitoringAgent, optimizationAgent, orchestrationAgent } from "./definitions/index";
export type { AgentDefinition, AgentRole, AutonomyLevel, AgentMemoryConfig, AgentBoundaries, AgentConstraints, EscalationConfig, AgentMetricsConfig, CollaborationConfig, FeedbackConfig } from "./definitions/index";

// ── Workflow orchestration ─────────────────────────────────────────────────────
export {
  createWorkflow,
  WorkflowBuilder,
  agentStep,
  sequential,
  parallel,
  branch,
  loop,
  delegate,
  transform,
  customStep,
  withRetry,
  withTimeout,
  withFallback,
  withErrorHandler,
  createCircuitBreaker,
  ConcurrencyLimiter,
  TimeoutError,
  CircuitBreakerOpenError,
  InMemoryStateStore,
  ConsoleWorkflowLogger,
  NoopWorkflowLogger,
  InMemoryWorkflowLogger,
} from "./workflow/index";
export type {
  WorkflowBuilderConfig,
  WorkflowContext,
  WorkflowStep,
  WorkflowResult,
  Workflow,
  StepOutput,
  StepLogEntry,
  BranchCase,
  LoopConfig,
  DelegateConfig,
  DelegateTarget,
  StepType,
  StepCondition,
  WorkflowState,
  WorkflowStatus,
  StateStore,
  WorkflowLogger,
  WorkflowLogEntry,
  RetryConfig,
  CircuitBreakerConfig,
  CircuitBreaker,
  ErrorHandlerConfig,
} from "./workflow/index";

// ── Low-level orchestration ────────────────────────────────────────────────────
export {
  createOrchestrator,
  runAgentsInParallel,
  runAgentChain,
  runConditional,
  runIterative,
  runHierarchical,
} from "./orchestrator";
export type {
  OrchestratorConfig,
  ConditionalBranch,
  ConditionalOrchestrationConfig,
  IterativeOrchestrationConfig,
  IterativeResult,
  ChildOrchestrator,
  HierarchicalOrchestrationConfig,
  HierarchicalResult,
} from "./orchestrator";
export { toOpenAITool } from "./utils";
export type { AgentConfig, AgentEvent, RunInput, RunResult, ModelSettings, AgentContext, HarnessPlugin, PluginRunContext } from "./types";

// ── Structured reasoning ───────────────────────────────────────────────────────
export { withStructuredReasoning } from "./plugins/structured-reasoning";
export type { StructuredReasoningPluginOptions } from "./plugins/structured-reasoning";
export { buildStructuredReasoningPrompt, mergeInstructions } from "./lib/prompt-builder";
export type { StructuredReasoningConfig, CriticRubric, MemoryAnchorSpec } from "./lib/prompt-builder";

// ── Memory anchors ──────────────────────────────────────────────────────────────
export { anchors, AnchorStore, parseTtlMs } from "./memory/anchors";
export type { AnchorEntry, AnchorOptions } from "./memory/anchors";

// ── Security ───────────────────────────────────────────────────────────────────
export { createPolicy, applyPolicyToTools, PolicyViolationError, DEFAULT_DENY_POLICY, audit, AuditLogger, ConsoleAuditAdapter, InMemoryAuditAdapter, NoopAuditAdapter, hashInput, issueCapabilityToken, verifyCapabilityToken, resolveToolsFromToken, CapabilityError, withSecurity } from "./security/index";
export type { PolicyConfig, PolicyContext, PolicyCheckResult, AgentPolicy, AuditRecord, AuditOutcome, AuditAdapter, CapabilityTokenPayload, IssueTokenOptions, SecurityPluginOptions } from "./security/index";

// ── Governance ─────────────────────────────────────────────────────────────────
export { createGovernancePolicy, evaluate, blockTools, blockContentPatterns, restrictAgentTargets, rateLimit, DEFAULT_GOVERNANCE_POLICY, GovernancePolicyViolationError, createEthicsPolicy, STANDARD_ETHICS_RULES, STANDARD_ETHICS_POLICY, noIdentityDeception, noPiiInOutput, noHarmfulContent, flagFabricatedCitations, requireAuthorizationForCommitments, noDiscriminatoryLanguage, createComplianceTracker, compliance, createEscalationHandler, checkEscalationTriggers, lowConfidenceTrigger, sensitiveToolTrigger, repeatedViolationTrigger, EscalationError, createAdaptationPolicy, withGovernance } from "./governance/index";
export type { RiskLevel, GovernanceOutcome, GovernanceContext, GovernanceRule, GovernanceDecision, ComplianceRecord, EscalationEvent, EscalationReason, GovernancePolicyConfig, GovernancePolicy, EthicsPolicyConfig, EthicsPolicy, ComplianceTrackerConfig, ComplianceTracker, ComplianceSink, ComplianceQuery, ComplianceStats, EscalationHandlerConfig, EscalationHandler, EscalationTrigger, AdaptationPolicyConfig, AdaptationPolicy, AdaptationProposal, AdaptationLogEntry, ProposalType, ProposalStatus, GovernancePluginOptions } from "./governance/index";

// ── Cost routing ───────────────────────────────────────────────────────────────
export { createRouter, defaultRouter, exactCacheKey, semanticCacheKey, toolCacheKey, TTL, InMemoryCache, RedisCache, createCacheManager, defaultCache, CONTEXT_BUDGETS, estimateTokens, trimChunks, truncateHistory, trimSystemPrompt, buildContext } from "./routing/index";
export type { RouterConfig, RouterSignals, ModelPlan, EscalateRules, CacheAdapter, CacheSetOptions, CacheManager, RedisClient, ContextBudgetConfig, RetrievalChunk, Message, BuiltContext } from "./routing/index";

// ── Skills ─────────────────────────────────────────────────────────────────────
export { defineSkill, registerSkill, getSkill, getAllSkills, resolveSkillTools, resolveAgentTools } from "./skills/index";
export type { SkillDefinition } from "./skills/index";

// ── Memory ─────────────────────────────────────────────────────────────────────
export { memory, formatMemoriesForPrompt } from "./memory/index";
export type { MemoryAdapter, MemoryEntry } from "./memory/index";

// ── Observability ──────────────────────────────────────────────────────────────
export { setObservabilityAdapter, getObservabilityAdapter, safeEmit } from "./observability/index";
export type { ObservabilityAdapter, RunSpan, ToolSpan, UsageEvent } from "./observability/index";

// ── Guardrails ─────────────────────────────────────────────────────────────────
export {
  runInputGuardrails,
  runOutputGuardrails,
  maxLengthGuardrail,
  piiSanitizerGuardrail,
  requireJsonOutputGuardrail,
  blockedKeywordsGuardrail,
  GuardrailBlockError,
  GuardrailHumanReviewError,
} from "./guardrails/index";
export type { GuardrailSet, InputGuardrail, OutputGuardrail } from "./guardrails/types";

// ── Approvals ──────────────────────────────────────────────────────────────────
export { createApproval, resolveApproval, getApproval, cancelRunApprovals } from "./approvals";

// ── Tools ──────────────────────────────────────────────────────────────────────
export { registerTool, getTool, getAllTools, getTools } from "./tools/registry";
export type { ToolDefinition, ToolContext, SandboxToolConfig } from "./tools/types";

// ── Anthropic provider ─────────────────────────────────────────────────────────
export { createAnthropicHarness } from "./providers/anthropic";
export type { AnthropicAgentHarness, AnthropicAgentConfig } from "./providers/anthropic";

// ── Agent registry ─────────────────────────────────────────────────────────────
export { registerAgent, getAgentConfig, getAllAgentNames } from "./agent-registry";

// ── Example agents ─────────────────────────────────────────────────────────────
export { createResearchAgent, researchAgentConfig } from "./examples/research-agent";
export { createCodeAgent, codeAgentConfig } from "./examples/code-agent";
export { orchestratedSystem } from "./examples/orchestrated-agent";
