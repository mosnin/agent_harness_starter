import type { z } from "zod";

/** A typed, registerable tool definition. */
export interface ToolDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput = unknown,
> {
  /** Unique identifier used by the agent and tool registry. */
  name: string;
  /** Human-readable description sent to the model. */
  description: string;
  /** Zod schema for validating and typing the input. */
  parameters: TInput;
  /** The actual implementation. Receives validated input + per-request context. */
  execute: (input: z.infer<TInput>, ctx: ToolContext) => Promise<TOutput>;

  /**
   * If true, the harness emits an `approval_required` event before executing
   * this tool and pauses until the user approves or rejects.
   * Can also be set per-agent via AgentConfig.requireApprovalFor.
   */
  requiresApproval?: boolean;

  /**
   * Sandbox / shell execution constraints.
   * Only relevant for shell/file tools; ignored by other tools.
   */
  sandboxConfig?: SandboxToolConfig;

  /**
   * Optional category for grouping tools in skills and UIs.
   * Examples: "web", "code", "files", "communication", "data"
   */
  category?: string;
}

/** Constraints applied to sandboxed shell / file tools. */
export interface SandboxToolConfig {
  /** Shell commands that may be executed (e.g. ["node", "python3", "git"]). Empty = deny all. */
  allowedCommands?: string[];
  /** Filesystem paths the tool may read from or write to. */
  allowedDirectories?: string[];
  /** Max execution time in milliseconds. Default: 30 000. */
  timeoutMs?: number;
  /** Max stdout/stderr bytes to capture. Default: 50 000. */
  maxOutputBytes?: number;
}

/** Per-request context passed to every tool invocation. */
export interface ToolContext {
  /** Authenticated user ID (if auth is configured). */
  userId?: string;
  /** Raw Next.js request (available in API routes). */
  request?: Request;
  /** Abort signal for cancellation support. */
  signal?: AbortSignal;
  /** Arbitrary metadata — useful for per-tenant configs, trace IDs, etc. */
  meta?: Record<string, unknown>;
}

/** A map of tool name → ToolDefinition. */
export type ToolRegistry = Map<string, ToolDefinition>;
