
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
 *
 * Plugins
 *   plugins       — ordered list of HarnessPlugin instances. Use the built-in
 *                   factories (withMemory, withGuardrails, withApprovals,
 *                   withObservability) or implement HarnessPlugin directly.
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
  /**
   * Tool names this agent can use.
   * Call getToolNames() from "@/agents/tools/registry" to see all registered tools.
   * Call getRegisteredTools() from "@/agents" for full ToolDefinition objects.
   */
  tools?: string[];

  /**
   * Skill bundle names. Skills are curated subsets of tools the model
   * discovers progressively — prevents overwhelming it with the full toolbox.
   * See src/agents/skills/.
   * Call getRegisteredSkills() from "@/agents" to see all registered skill names.
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

  /** Tenant/org ID for multi-tenant deployments. Scopes memory and policy decisions. */
  orgId?: string;

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

  // ── Plugins ───────────────────────────────────────────────────────────────
  /**
   * Ordered list of plugins applied to every run of this agent.
   * Plugins are called in array order for before-hooks (onBeforeRun,
   * onResolveInstructions, wrapTools, onEvent) and in REVERSE array order
   * for after-hooks (onAfterRun, onError, onComplete) so that teardown
   * mirrors setup — the last plugin to set up is the first to tear down.
   *
   * Use the built-in factories:
   *   withMemory()       — semantic memory retrieval + storage
   *   withGuardrails()   — input/output content filtering
   *   withApprovals()    — human-in-the-loop tool approval
   *   withObservability() — tracing, logging, metrics
   *
   * Or implement HarnessPlugin directly for custom integrations.
   */
  plugins?: HarnessPlugin[];
}

// ── Plugin system ─────────────────────────────────────────────────────────────

/**
 * Per-run context available to every plugin hook.
 * Populated by the harness at run start; read-only inside hooks.
 */
export interface PluginRunContext {
  /** Unique ID for this run (UUID). */
  runId: string;
  /** Name of the agent from AgentConfig.name. */
  agentName: string;
  /** Resolved model ID (e.g. "gpt-4o"). */
  model: string;
  /** Authenticated user ID (from input.context.userId). */
  userId?: string;
  /** Date.now() at the start of the run. */
  startedAt: number;
  /**
   * AbortSignal from RunInput.signal — forward to long-running async operations
   * inside plugin hooks so they respect cancellation.
   */
  signal?: AbortSignal;
  /**
   * Full per-run context (same object as RunInput.context).
   * Access custom fields (orgId, featureFlags, etc.) via this.
   */
  context: AgentContext;
  /**
   * Distributed trace ID shared across all agents in a single workflow.
   * Propagated from the calling agent via input.context.traceId so that all
   * spans in a multi-agent handoff chain share one root trace.
   * Auto-generated (randomUUID) if not provided by the caller.
   */
  traceId?: string;
  /**
   * Span ID for this specific agent run (always a fresh randomUUID).
   * Use as the "parent span" when instrumenting child operations.
   */
  spanId?: string;
  /**
   * Span ID of the calling agent (set from input.context.spanId).
   * Undefined for the root agent in a workflow.
   */
  parentSpanId?: string;
  /**
   * W3C traceparent header value for this run: `00-{traceId}-{spanId}-01`.
   * Forward in outbound HTTP calls (e.g. `traceparent` header) so downstream
   * services and APMs can correlate spans across service boundaries.
   */
  traceparent?: string;
}

/**
 * A HarnessPlugin hooks into specific lifecycle points of an agent run.
 *
 * All hooks are optional — implement only what your plugin needs.
 * Plugins are called in array order for before-hooks (onBeforeRun,
 * onResolveInstructions, wrapTools, onEvent) and in REVERSE array order
 * for after-hooks (onAfterRun, onError, onComplete) so that teardown
 * mirrors setup.
 */
export interface HarnessPlugin {
  readonly name: string;

  /**
   * Transform or validate the user message before the agent runs.
   * Called in plugin array order. Each plugin receives the output of the previous.
   * Throw to abort the run — core emits an error event then done.
   */
  onBeforeRun?(
    userMessage: string,
    ctx: PluginRunContext,
    input: RunInput
  ): Promise<string> | string;

  /**
   * Enrich the resolved instructions string before the OpenAI Agent is built.
   * Called after dynamic instructions are resolved and after onBeforeRun
   * (so userMessage is already normalized). Ideal for memory injection.
   */
  onResolveInstructions?(
    instructions: string,
    userMessage: string,
    ctx: PluginRunContext
  ): Promise<string> | string;

  /**
   * Wrap tool definitions before they are converted to OpenAI tools.
   * The pendingEvents Map is a side-channel: tools can push events into it
   * from within closures, and the streaming loop drains it each iteration.
   * Used by the approvals plugin to emit approval_required events.
   */
  wrapTools?(
    tools: import("./tools/types").ToolDefinition[],
    ctx: PluginRunContext,
    pendingEvents: Map<string, AgentEvent>
  ): Promise<import("./tools/types").ToolDefinition[]> | import("./tools/types").ToolDefinition[];

  /**
   * Intercept each stream event before it is yielded to the caller.
   * Return null to suppress the event. Return the event (possibly mutated).
   * Called in plugin array order.
   */
  onEvent?(
    event: AgentEvent,
    ctx: PluginRunContext
  ): Promise<AgentEvent | null> | AgentEvent | null;

  /**
   * Transform or validate the final output after the run completes.
   * Called in plugin array order. Throw to block — core emits error + done.
   */
  onAfterRun?(
    finalOutput: string,
    ctx: PluginRunContext
  ): Promise<string> | string;

  /**
   * Called when an unhandled error escapes the SDK run.
   * Use for cleanup (e.g. cancel pending approvals).
   */
  onError?(error: Error, ctx: PluginRunContext): Promise<void> | void;

  /**
   * Always called after the run ends, whether it succeeded or failed.
   * Use for storage writes (memory), metric flushes, span finalization, etc.
   */
  onComplete?(
    ctx: PluginRunContext,
    result: { finalOutput: string; durationMs: number; error?: Error }
  ): Promise<void> | void;
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
  /** Conversation thread ID. */
  threadId?: string;
  /** Unique run ID (auto-populated by the harness). */
  runId?: string;
  /** Tenant/org ID for multi-tenant deployments. Scopes memory and policy decisions. */
  orgId?: string;
  /** Distributed trace ID (OpenTelemetry compatible). Auto-generated if not provided. */
  traceId?: string;
  /** Current span ID (OpenTelemetry compatible). Auto-generated per run. */
  spanId?: string;
  /**
   * W3C traceparent header value: `00-{traceId}-{spanId}-01`.
   * Set by the harness after generating traceId and spanId.
   */
  traceparent?: string;
  /** Any additional per-request data (sessionData, feature flags, etc.). */
  metadata?: Record<string, unknown>;
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
  | { type: "error"; error: string; code?: string; guardName?: string; toolName?: string; remediation?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: "done"; finalOutput: string; traceId?: string; spanId?: string; traceparent?: string };

// ── Run I/O ───────────────────────────────────────────────────────────────────

export interface RunInput {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** Merged into AgentConfig.context — use for per-request overrides. */
  context?: AgentContext;
  signal?: AbortSignal;
}

export interface RunResult {
  finalOutput: string;
  messages: Array<{ role: string; content: string }>;
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
