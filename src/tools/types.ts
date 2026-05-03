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
  /** The actual implementation. Receives validated input. */
  execute: (input: z.infer<TInput>, ctx: ToolContext) => Promise<TOutput>;
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
