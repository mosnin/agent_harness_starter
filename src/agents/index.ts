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

// ── Orchestration ──────────────────────────────────────────────────────────────
export { createOrchestrator, runAgentsInParallel, runAgentChain } from "./orchestrator";
export { toOpenAITool } from "./utils";
export type { AgentConfig, AgentEvent, RunInput, RunResult, ModelSettings, AgentContext, HarnessPlugin, PluginRunContext } from "./types";

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
