/**
 * @module @/agents
 *
 * Root barrel — the welcome mat. Only the ~30 items a beginner needs to start.
 *
 * Advanced features live in submodules and are still fully accessible:
 *
 *   import { ... } from "@/agents/security"        // capability tokens, policy, audit
 *   import { ... } from "@/agents/governance"      // ethics, compliance, escalation, adaptation
 *   import { ... } from "@/agents/routing"         // cost router, semantic cache, context budget
 *   import { ... } from "@/agents/guardrails"      // maxLengthGuardrail, piiSanitizerGuardrail, …
 *   import { ... } from "@/agents/memory"          // anchors, AnchorStore, formatMemoriesForPrompt, …
 *   import { ... } from "@/agents/skills"          // resolveSkillTools, getAllSkills, …
 *   import { ... } from "@/agents/workflow"        // WorkflowBuilder, delegate, transform, circuit-breaker, …
 *   import { ... } from "@/agents/observability"   // setObservabilityAdapter, ObservabilityAdapter, …
 *   import { ... } from "@/agents/providers/anthropic"  // createAnthropicHarness
 *   import { ... } from "@/agents/examples"        // createResearchAgent, createCodeAgent, …
 *   import { ... } from "@/agents/runtime"         // validateRuntime, getRegisteredTools — call at startup
 */

// ── Quickstart entry point ──────────────────────────────────────────────────
// The one function beginners use — delegates to createStandardHarness.
// For more control use the named presets below.
export { createAgent } from "./presets/agent";

// ── Core engine ─────────────────────────────────────────────────────────────
export { createCustomHarness } from "./core";
export type { CoreConfig, AgentHarness } from "./core";

// ── Preset factories ─────────────────────────────────────────────────────────
export { createMinimalHarness, createStandardHarness, createFullHarness } from "./presets/index";

// ── Plugin factories (needed for createCustomHarness) ────────────────────────
export { withMemory } from "./plugins/memory";
export { withGuardrails } from "./plugins/guardrails";
export { withApprovals } from "./plugins/approvals";
export { withObservability } from "./plugins/observability";
export { withControlPlane } from "./plugins/control-plane";
export type { ControlPlaneOptions } from "./plugins/control-plane";
export { composePlugins } from "./plugins/compose";

// ── Agent definition ─────────────────────────────────────────────────────────
export { defineAgent } from "./definitions/index";

// ── Skill definition ─────────────────────────────────────────────────────────
export { defineSkill } from "./skills/index";
export type { SkillDefinition } from "./skills/index";

// ── Core types ───────────────────────────────────────────────────────────────
export type { AgentConfig, AgentEvent, RunInput, RunResult, HarnessPlugin } from "./types";

// ── Error hierarchy ──────────────────────────────────────────────────────────
export { AgentError, GovernanceError, SecurityError, GuardrailError, WorkflowError } from "./errors/index";

// ── Guardrails ───────────────────────────────────────────────────────────────
export {
  promptInjectionGuardrail,
  sensitiveFileGuardrail,
  destructiveCommandGuardrail,
} from "./guardrails/index";
export type { InjectionDetectorOptions, InjectionPattern, DetectionResult } from "./guardrails/index";

// ── Workflow basics ──────────────────────────────────────────────────────────
export {
  createWorkflow,
  agentStep,
  sequential,
  parallel,
  branch,
  loop,
  retry,
  timeout,
  fallback,
} from "./workflow/index";

// ── Memory adapter ───────────────────────────────────────────────────────────
export { memory, setMemoryAdapter } from "./memory/index";
export type { MemoryAdapter, MemoryEntry } from "./memory/index";

// ── Tool utilities ────────────────────────────────────────────────────────────
export { createSafeExecutor, SafeExecutorError, SafeExecutorPresets } from "./tools/safe-exec";
export { createToolTelemetry } from "./tools/telemetry";

// ── Response cache ───────────────────────────────────────────────────────────
export { createResponseCache } from "./cache/index";
export type { ResponseCache, ResponseCacheOptions, CacheStats } from "./cache/index";

// ── Provider manager ──────────────────────────────────────────────────────────
export { createProviderManager } from "./providers/manager";
export type {
  ProviderManager,
  ProviderManagerConfig,
  ProviderConfig,
  ProviderStats,
  ProviderStrategy,
  SelectedProvider,
} from "./providers/manager";

// ── Guidance (CLAUDE.md policy compiler + enforcement gates) ─────────────────
export { withGuidance, compileGuidance } from "./guidance/index";
export type { GuidancePluginOptions, GuidanceRule, PolicyBundle, GateResult, GateContext } from "./guidance/index";

// ── Runtime validation & discovery ────────────────────────────────────────────
// These are accessible via @/agents/runtime:
//   import { validateRuntime, getRegisteredTools, getRegisteredSkills, resolveAgentAccess } from "@/agents/runtime";
//   import type { RuntimeValidationResult } from "@/agents/runtime";
