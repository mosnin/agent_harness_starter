/**
 * Pre-built agent role presets.
 *
 * Each preset returns a partially configured AgentDefinitionBuilder with
 * sensible defaults for that role. Override any setting with the fluent API.
 *
 * Usage:
 *   import { reasoningAgent, retrievalAgent, monitoringAgent } from "@/agents/definitions/presets";
 *
 *   const myResearcher = retrievalAgent("web-researcher")
 *     .instructions("Search the web and synthesize answers with citations.")
 *     .tools(["web_search", "browser_scrape"])
 *     .memory({ scope: "user", topK: 5 })
 *     .build();
 */

import { defineAgent, AgentDefinitionBuilder } from "./builder";

// ── Reasoning agent ───────────────────────────────────────────────────────────

/**
 * Chains-of-thought, planning, multi-step deduction.
 * Low temperature, high maxTurns, no irreversible tools by default.
 */
export function reasoningAgent(name: string): AgentDefinitionBuilder {
  return defineAgent(name)
    .role("reasoning")
    .modelSettings({ temperature: 0.1, maxTokens: 8192 })
    .maxTurns(20)
    .autonomy("supervised")
    .constraints({ irreversibleTools: [] });
}

// ── Tooling agent ─────────────────────────────────────────────────────────────

/**
 * Executes actions via tools (API calls, shell, code execution).
 * Requires approval for shell/file tools; blocks DB delete by default.
 */
export function toolingAgent(name: string): AgentDefinitionBuilder {
  return defineAgent(name)
    .role("tooling")
    .modelSettings({ temperature: 0.0, maxTokens: 4096 })
    .maxTurns(15)
    .autonomy("supervised")
    .constraints({
      requireApproval: ["shell_exec", "file_write"],
      irreversibleTools: ["shell_exec", "db_delete", "file_delete"],
    })
    .boundaries({ blockedTools: ["db_delete"] });
}

// ── Retrieval agent ───────────────────────────────────────────────────────────

/**
 * Fetches and ranks information (RAG, search, DB lookups).
 * Memory enabled by default; readonly tools only.
 */
export function retrievalAgent(name: string): AgentDefinitionBuilder {
  return defineAgent(name)
    .role("retrieval")
    .modelSettings({ temperature: 0.2, maxTokens: 4096 })
    .maxTurns(10)
    .autonomy("full")
    .memory({ scope: "user", topK: 5, persist: false })
    .boundaries({ blockedTools: ["shell_exec", "file_write", "db_delete"] });
}

// ── Communication agent ───────────────────────────────────────────────────────

/**
 * Composes messages, summaries, emails, user-facing text.
 * Higher temperature for more natural language; length-constrained output.
 */
export function communicationAgent(name: string): AgentDefinitionBuilder {
  return defineAgent(name)
    .role("communication")
    .modelSettings({ temperature: 0.7, maxTokens: 2048 })
    .maxTurns(5)
    .autonomy("assisted")
    .boundaries({
      maxOutputLength: 4000,
      blockedTools: ["shell_exec", "file_write", "db_delete"],
    });
}

// ── Monitoring agent ──────────────────────────────────────────────────────────

/**
 * Watches system health, evaluates outputs, emits alerts.
 * Always observability-enabled; no write tools; escalates on anomalies.
 */
export function monitoringAgent(name: string, supervisorName = "supervisor"): AgentDefinitionBuilder {
  return defineAgent(name)
    .role("monitoring")
    .modelSettings({ temperature: 0.0, maxTokens: 2048 })
    .maxTurns(5)
    .autonomy("supervised")
    .metrics({ enabled: true, sla: { maxLatencyMs: 10_000, maxErrorRate: 0.05 } })
    .boundaries({ blockedTools: ["shell_exec", "file_write", "db_delete"] })
    .escalation({
      escalateTo: supervisorName,
      when: ["When an anomaly is detected", "When error rate exceeds SLA"],
      includeContext: "summary",
    });
}

// ── Optimization agent ────────────────────────────────────────────────────────

/**
 * Improves quality via critic loops, re-ranking, and scoring.
 * Uses structured reasoning critic loop by default.
 */
export function optimizationAgent(name: string, goal: string): AgentDefinitionBuilder {
  return defineAgent(name)
    .role("optimization")
    .modelSettings({ temperature: 0.2, maxTokens: 4096 })
    .maxTurns(10)
    .autonomy("supervised")
    .boundaries({ blockedTools: ["shell_exec", "db_delete"] })
    .structuredReasoning(goal, { maxCriticLoops: 2 });
}

// ── Orchestration agent ───────────────────────────────────────────────────────

/**
 * Coordinates other agents (supervisor/router role).
 * Can delegate to all registered agents; isSupervisor flag set.
 */
export function orchestrationAgent(name: string, canDelegate: string[] = []): AgentDefinitionBuilder {
  return defineAgent(name)
    .role("orchestration")
    .modelSettings({ temperature: 0.1, maxTokens: 4096 })
    .maxTurns(30)
    .autonomy("full")
    .collaboration({ canDelegate, isSupervisor: true, stateSharing: "context" })
    .boundaries({ blockedTools: ["shell_exec", "db_delete"] });
}
