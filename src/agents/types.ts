import type { ToolContext } from "./tools/types";

/**
 * Full agent configuration — mirrors every knob exposed by the OpenAI Agents SDK.
 *
 * Identity & behavior
 *   name          — semantic label used in logging, handoffs, and UI
 *   instructions  — system prompt as a static string OR a dynamic function
 *                   that receives the current context and returns a string.
 *                   Use the function form for per-user, per-tenant, or
 *                   state-dependent prompts.
 *
 * Model & generation
 *   model         — any OpenAI model ID (gpt-4o, o3-mini, etc.)
 *   modelSettings — temperature, maxTokens, topP, toolChoice, etc.
 *
 * Tools & skills
 *   tools         — tool names from the registry to make available
 *   skills        — skill bundle names (progressive disclosure; see skills/)
 *   handoffs      — agent names this agent is allowed to hand off to
 *
 * Context & memory
 *   context       — arbitrary object available to dynamic instructions and tools.
 *                   Typically: { userId, orgId, userProfile, sessionData, ... }
 *   memoryKey     — if set, the harness loads relevant memories from the
 *                   MemoryAdapter and injects them into the system prompt.
 *
 * Execution
 *   maxTurns      — max LLM + tool call iterations (prevents runaway loops)
 *   requireApprovalFor — tool names that must be explicitly approved by the
 *                   user before the harness will execute them
 */
export interface AgentConfig {
  // ── Identity ─────────────────────────────────────────────────────────────
  name: string;

  /** Static system prompt, or a function for dynamic per-context instructions. */
  instructions: string | ((ctx: AgentContext) => string | Promise<string>);

  // ── Model ─────────────────────────────────────────────────────────────────
  /** OpenAI model ID. Defaults to OPENAI_MODEL env var (gpt-4o). */
  model?: string;

  /** Fine-grained generation parameters. */
  modelSettings?: ModelSettings;

  // ── Tools & skills ────────────────────────────────────────────────────────
  /** Tool names from the registry. */
  tools?: string[];

  /**
   * Skill bundle names. Skills are curated subsets of tools the model
   * discovers progressively — prevents overwhelming it with the full toolbox.
   * See src/agents/skills/.
   */
  skills?: string[];

  /** Agent names this agent can hand off to (multi-agent orchestration). */
  handoffs?: string[];

  // ── Context & memory ─────────────────────────────────────────────────────
  /**
   * Arbitrary context object passed to dynamic instructions and tools.
   * Typically populated per-request with user/org/session data.
   * Available in tools via ctx.meta.
   */
  context?: Record<string, unknown>;

  /**
   * If set, the harness automatically retrieves relevant memories for this key
   * (usually userId or threadId) and prepends them to the system prompt.
   */
  memoryKey?: string;

  // ── Execution ─────────────────────────────────────────────────────────────
  /** Max LLM + tool iterations. Default: 20. */
  maxTurns?: number;

  /**
   * Tool names that require explicit user approval before execution.
   * The harness pauses and emits an `approval_required` event; the run
   * resumes only after calling POST /api/agent/[runId]/approve.
   */
  requireApprovalFor?: string[];

  // ── Guardrails ────────────────────────────────────────────────────────────
  /**
   * Input and output guardrails.
   * Input guardrails run before the agent processes the user's message.
   * Output guardrails run on the final response before it is returned.
   * Import built-ins from src/agents/guardrails/index.ts or define your own.
   */
  guardrails?: import("./guardrails/types").GuardrailSet;
}

/** Fine-grained model/generation settings. */
export interface ModelSettings {
  /** 0.0–2.0. Higher = more creative. Default: model default (~1.0). */
  temperature?: number;
  /** Max tokens in the model's response. */
  maxTokens?: number;
  /** Nucleus sampling. */
  topP?: number;
  /**
   * Tool choice strategy:
   *   "auto"     — model decides (default)
   *   "required" — model must call a tool
   *   "none"     — model cannot call tools
   *   { type: "function", function: { name } } — force a specific tool
   */
  toolChoice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  /** Parallel tool calls. Default: true. */
  parallelToolCalls?: boolean;
}

/** Per-run context available to dynamic instructions and tools. */
export interface AgentContext {
  /** Authenticated user ID from your auth adapter. */
  userId?: string;
  /** Any additional per-request data (orgId, sessionData, feature flags, etc.). */
  [key: string]: unknown;
}

// ── Events ───────────────────────────────────────────────────────────────────

/** Every event emitted by the harness during a streaming run. */
export type AgentEvent =
  | { type: "message_delta"; delta: string }
  | { type: "message_done"; content: string }
  | { type: "tool_call"; name: string; input: unknown; callId: string }
  | { type: "tool_result"; name: string; output: unknown; callId: string }
  | { type: "handoff"; from: string; to: string }
  | {
      type: "approval_required";
      runId: string;
      approvalId: string;
      toolName: string;
      input: unknown;
      description: string;
    }
  | { type: "error"; error: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: "done"; finalOutput: string };

// ── Run I/O ───────────────────────────────────────────────────────────────────

export interface RunInput {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** Merged into AgentConfig.context — use for per-request overrides. */
  context?: ToolContext;
  signal?: AbortSignal;
}

export interface RunResult {
  finalOutput: string;
  messages: Array<{ role: string; content: string }>;
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
