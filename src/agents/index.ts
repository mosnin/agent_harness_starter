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

// ── Swarm coordinator ─────────────────────────────────────────────────────────
export { SwarmCoordinator } from "./swarm/coordinator";
export { majorityVote, weightedAverage } from "./swarm/consensus";
export type { SwarmTopology, AgentStatus, MessageType, SwarmAgent, SwarmMessage, SwarmTask, SwarmConfig, SwarmStats, Vote, ConsensusResult } from "./swarm/index";

// ── Claims / work-stealing ────────────────────────────────────────────────────
export { ClaimsService } from "./claims/service";
export { createClaimsTools } from "./claims/mcp-tools";
export type { Claim, ClaimStatus, Claimant, ClaimantType, ClaimsFilter, ClaimsStats } from "./claims/types";

// ── Vector search (HNSWLite) ──────────────────────────────────────────────────
export { HNSWIndex } from "./memory/hnsw";
export { VectorStore } from "./memory/vector-store";
export type { HNSWConfig, HNSWSearchResult } from "./memory/hnsw";
export type { VectorEntry, VectorStoreConfig } from "./memory/vector-store";

// ── Embeddings service ────────────────────────────────────────────────────────
export { createEmbeddingService, MockEmbeddingService, OpenAIEmbeddingService, EmbeddingCache, chunkText, normalizeVector } from "./embeddings/index";
export type { EmbeddingService, EmbeddingResult, EmbeddingProvider, ChunkOptions, Chunk, NormalizationStrategy } from "./embeddings/types";
export type { EmbeddingServiceConfig } from "./embeddings/service";

// ── Federation (zero-trust Ed25519 peer auth) ─────────────────────────────────
export { FederationManager } from "./federation/manager";
export { PeerRegistry } from "./federation/peer-registry";
export { generateKeyPair, sign, verify, canonicalize, toHex, fromHex } from "./federation/crypto";
export type { FederationPeer, FederationMessage, FederationConfig, SignedPayload, PeerStatus } from "./federation/types";

// ── Codex / AGENTS.md adapter ─────────────────────────────────────────────────
export { generateAgentsMd, generateSkillMarkdown, generateToml } from "./codex/generators";
export { migrateClaude, migrateOpenAIAgents } from "./codex/migrator";
export { createCodexCli } from "./codex/cli";
export type { AgentsMdConfig, SkillMarkdown, CodexTomlConfig, MigrationResult } from "./codex/types";

// ── Runtime validation & discovery ────────────────────────────────────────────
// These are accessible via @/agents/runtime:
//   import { validateRuntime, getRegisteredTools, getRegisteredSkills, resolveAgentAccess } from "@/agents/runtime";
//   import type { RuntimeValidationResult } from "@/agents/runtime";
