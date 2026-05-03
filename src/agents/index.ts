// Harness & orchestration
export { createHarness } from "./harness";
export type { HarnessConfig } from "./harness";
export { createOrchestrator, runAgentsInParallel, runAgentChain } from "./orchestrator";
export { toOpenAITool } from "./utils";
export type { AgentConfig, AgentEvent, RunInput, RunResult, ModelSettings, AgentContext } from "./types";

// Skills
export { defineSkill, registerSkill, getSkill, getAllSkills, resolveSkillTools, resolveAgentTools } from "./skills/index";
export type { SkillDefinition } from "./skills/index";

// Memory
export { memory, formatMemoriesForPrompt } from "./memory/index";
export type { MemoryAdapter, MemoryEntry } from "./memory/index";

// Observability
export { setObservabilityAdapter, getObservabilityAdapter, safeEmit } from "./observability/index";
export type { ObservabilityAdapter, RunSpan, ToolSpan, UsageEvent } from "./observability/index";

// Guardrails
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

// Approvals
export { createApproval, resolveApproval, getApproval, cancelRunApprovals } from "./approvals";

// Tools
export { registerTool, getTool, getAllTools, getTools } from "./tools/registry";
export type { ToolDefinition, ToolContext, SandboxToolConfig } from "./tools/types";

// Anthropic Managed Agents provider (alternative to OpenAI Agents SDK)
export { createAnthropicHarness } from "./providers/anthropic";
export type { AnthropicAgentHarness, AnthropicAgentConfig } from "./providers/anthropic";

// Example agents — copy and customize these
export { createResearchAgent, researchAgentConfig } from "./examples/research-agent";
export { createCodeAgent, codeAgentConfig } from "./examples/code-agent";
export { orchestratedSystem } from "./examples/orchestrated-agent";
