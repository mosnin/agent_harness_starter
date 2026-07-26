/**
 * Extended agent definition types.
 *
 * AgentDefinition extends the base AgentConfig with:
 *   - role: semantic category (reasoning, tooling, retrieval, etc.)
 *   - boundaries: what the agent cannot do and when to defer
 *   - autonomy: how much freedom the agent has to act without approval
 *   - memory: what context persists across tasks
 *   - constraints: hard limits on tools and irreversible actions
 *   - escalation: when and how to hand off to a more capable agent
 *   - metrics: optional performance tracking
 *   - collaboration: how this agent interacts with peers
 *   - feedback: how outcomes adjust future behavior
 */

import type { AgentConfig } from "../types";

// ── Agent roles (categorized by function) ─────────────────────────────────────

export type AgentRole =
  | "reasoning"     // chains-of-thought, planning, multi-step deduction
  | "tooling"       // executes actions via tools (API calls, shell, code)
  | "retrieval"     // fetches and ranks information (RAG, search, DB)
  | "communication" // composes messages, summaries, emails, user-facing text
  | "monitoring"    // watches system health, alerts, evaluates outputs
  | "optimization"  // improves quality via critic loops, re-ranking, scoring
  | "orchestration" // coordinates other agents (supervisor/router role)
  | "custom";       // user-defined role

// ── Autonomy levels ───────────────────────────────────────────────────────────

/**
 * How much freedom the agent has before requiring human or supervisor approval.
 *
 *   full       — acts without any approval (fire-and-forget)
 *   supervised — requires approval for high-risk tools (see constraints.requireApproval)
 *   assisted   — every non-trivial action gets a confirmation step
 *   manual     — agent plans but a human executes every step
 */
export type AutonomyLevel = "full" | "supervised" | "assisted" | "manual";

// ── Memory configuration ──────────────────────────────────────────────────────

export interface AgentMemoryConfig {
  /**
   * Scope of semantic memory recall.
   *   "none"    — no memory retrieval
   *   "session" — recall within the current thread/session only
   *   "user"    — recall across all sessions for this user
   *   "global"  — recall across all users (shared knowledge base)
   */
  scope: "none" | "session" | "user" | "global";
  /** How many memory entries to inject. Default: 5. */
  topK?: number;
  /** Max tokens to use for injected memories. Default: 1000. */
  maxTokens?: number;
  /** Whether to write new outputs back to memory after each run. Default: true. */
  persist?: boolean;
  /** TTL for stored memories. Default: "7d". */
  ttl?: string;
}

// ── Boundaries — what the agent cannot do ────────────────────────────────────

export interface AgentBoundaries {
  /**
   * Tool names this agent is never allowed to use.
   * Enforced by the security policy layer.
   */
  blockedTools?: string[];
  /**
   * Topics or task types the agent should refuse and defer.
   * These are injected into the system prompt as hard rules.
   */
  refuseTopics?: string[];
  /**
   * When to defer to another agent or a human.
   * A plain-language description injected into the system prompt.
   * Example: "Defer to the legal agent when the user asks about contracts."
   */
  deferWhen?: string[];
  /**
   * Maximum output length in characters. Outputs beyond this are truncated.
   * Default: unlimited.
   */
  maxOutputLength?: number;
}

// ── Constraints — hard limits ─────────────────────────────────────────────────

export interface AgentConstraints {
  /**
   * Tools that require explicit human approval before execution.
   * Works with the approvals plugin.
   */
  requireApproval?: string[];
  /**
   * Tool names that are irreversible. The agent will warn before calling them.
   * Injected as a caution into the system prompt.
   */
  irreversibleTools?: string[];
  /**
   * Hard token budget for a single run. Prevents runaway chains.
   * Default: modelSettings.maxTokens.
   */
  maxTokensPerRun?: number;
  /**
   * Maximum wall-clock time for a single run in ms. Default: 120_000 (2 min).
   */
  maxDurationMs?: number;
  /**
   * If true, the agent cannot initiate new sub-agent calls or handoffs.
   * Use for leaf agents in a hierarchy.
   */
  noHandoffs?: boolean;
}

// ── Escalation — when to hand off to a more capable agent ────────────────────

export interface EscalationConfig {
  /**
   * The name of the agent to escalate to (must be registered).
   * Example: "supervisor", "claude-opus-agent".
   */
  escalateTo: string;
  /**
   * Conditions under which escalation is triggered.
   * Each condition is a plain-language rule injected into the system prompt.
   * Example: ["When confidence is below 0.7", "When the task requires browsing"]
   */
  when: string[];
  /**
   * What to include in the escalation handoff message.
   * Default: forward the full current context.
   */
  includeContext?: "full" | "summary" | "message-only";
  /**
   * Maximum number of escalations allowed per run. Default: 1.
   */
  maxEscalations?: number;
}

// ── Performance metrics ───────────────────────────────────────────────────────

export interface AgentMetricsConfig {
  /** Whether to enable per-run metric collection. Default: false. */
  enabled: boolean;
  /**
   * Custom metric names to track (in addition to built-ins).
   * Built-ins: latencyMs, inputTokens, outputTokens, toolCallCount, errorRate.
   */
  customMetrics?: string[];
  /**
   * Target SLAs. Used by the monitoring/alerting layer.
   */
  sla?: {
    maxLatencyMs?: number;
    maxErrorRate?: number;     // 0.0–1.0
    minQualityScore?: number;  // 0.0–1.0
  };
}

// ── Collaboration protocol ────────────────────────────────────────────────────

export interface CollaborationConfig {
  /**
   * Agent names this agent can call (delegate to).
   * Empty means no delegation; use this to enforce topology.
   */
  canDelegate?: string[];
  /**
   * Agent names that can delegate to this agent.
   * Informational — used for documentation and topology visualization.
   */
  acceptsDelegationFrom?: string[];
  /**
   * How this agent shares state with peers.
   *   "none"    — no sharing (default)
   *   "context" — passes WorkflowContext (in-process only)
   *   "store"   — persists to a shared StateStore before delegating
   */
  stateSharing?: "none" | "context" | "store";
  /**
   * Whether this agent aggregates results from peers (supervisor pattern).
   * Default: false.
   */
  isSupervisor?: boolean;
}

// ── Feedback mechanism ────────────────────────────────────────────────────────

export interface FeedbackConfig {
  /**
   * Whether to run a critic pass on the agent's output before returning it.
   * Uses the structuredReasoning critic loop if withStructuredReasoning is enabled.
   */
  selfCritique?: boolean;
  /**
   * External evaluation function. Receives the output and returns a score 0–1.
   * If the score is below `minScore`, the run is retried (up to `maxRetries` times).
   */
  evaluate?: (output: string, ctx: Record<string, unknown>) => number | Promise<number>;
  minScore?: number;
  maxRetries?: number;
  /**
   * Whether to persist evaluation scores for future routing decisions
   * (lower-scoring intents escalate to larger models automatically).
   */
  persistScores?: boolean;
}

// ── Full AgentDefinition ──────────────────────────────────────────────────────

export interface AgentDefinition extends AgentConfig {
  /** Semantic role category for this agent. */
  role: AgentRole;
  /** What this agent cannot do and when to defer. */
  boundaries?: AgentBoundaries;
  /** How much the agent can act without human approval. Default: "supervised". */
  autonomy?: AutonomyLevel;
  /** Memory scope and persistence config. */
  memory?: AgentMemoryConfig;
  /** Hard limits on tools and reversibility. */
  constraints?: AgentConstraints;
  /** When and how to escalate to a more capable agent. */
  escalation?: EscalationConfig;
  /** Optional performance metric collection. */
  metrics?: AgentMetricsConfig;
  /** How this agent collaborates with peers. */
  collaboration?: CollaborationConfig;
  /** How this agent learns from outcomes. */
  feedback?: FeedbackConfig;
  /** Human-readable description for documentation. */
  description?: string;
}
