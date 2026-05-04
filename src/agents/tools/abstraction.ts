/**
 * Tool abstraction layer — standardized wrapper that adds:
 *   1. Input validation with Zod
 *   2. Output interpretation pause (agents see a structured ToolResult)
 *   3. Error handling with configurable fallback
 *   4. Tool selection hints (tags, priority, cost)
 *   5. Execution tracing
 *
 * Every tool registered through this layer produces consistent, parseable
 * output that agents can interpret before deciding the next action.
 *
 * Usage:
 *   const safeTool = createAbstractTool({
 *     name: "web_search",
 *     description: "Search the web for current information.",
 *     parameters: z.object({ query: z.string() }),
 *     tags: ["web", "read-only"],
 *     priority: 1,
 *     execute: async ({ query }) => { ... },
 *     onError: async (err) => ({ error: err.message, results: [] }),
 *   });
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext } from "./types";

// ── ToolResult — structured output all tools return ───────────────────────────

export interface ToolResult<TData = unknown> {
  /** Whether the tool executed successfully. */
  ok: boolean;
  /** The tool's data payload. Present on success. */
  data?: TData;
  /** Human-readable error when ok=false. */
  error?: string;
  /** Execution time in ms. */
  durationMs: number;
  /** Tool name (for agent parsing). */
  toolName: string;
  /** Optional machine-readable hint for the agent ("retry", "escalate", "use_fallback"). */
  hint?: string;
  /** Metadata the tool wants to pass back (pagination cursors, version info, etc.). */
  meta?: Record<string, unknown>;
}

// ── AbstractTool config ───────────────────────────────────────────────────────

export interface AbstractToolConfig<TInput extends z.ZodTypeAny, TOutput = unknown> {
  name: string;
  description: string;
  parameters: TInput;

  /**
   * Semantic tags used for tool selection.
   * Examples: ["web", "read-only"], ["code", "destructive"], ["retrieval", "fast"]
   */
  tags?: string[];

  /**
   * Priority for selection when multiple tools match.
   * Lower number = higher priority. Default: 10.
   */
  priority?: number;

  /**
   * Estimated cost tier for routing decisions.
   * "free" | "cheap" | "moderate" | "expensive"
   */
  cost?: "free" | "cheap" | "moderate" | "expensive";

  /** The actual implementation. */
  execute: (input: z.infer<TInput>, ctx: ToolContext) => Promise<TOutput>;

  /**
   * Called when execute() throws. Return fallback data or rethrow.
   * Default: returns a ToolResult with ok=false.
   */
  onError?: (error: Error, input: z.infer<TInput>, ctx: ToolContext) => Promise<TOutput> | TOutput;

  /**
   * Timeout in ms. Throws if the tool takes longer. Default: 30_000.
   */
  timeoutMs?: number;

  /**
   * Transform the raw output into a ToolResult before returning to the agent.
   * Default: wraps in { ok: true, data: output }.
   */
  wrapOutput?: (output: TOutput, durationMs: number) => ToolResult<TOutput>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createAbstractTool<TInput extends z.ZodTypeAny, TOutput = unknown>(
  config: AbstractToolConfig<TInput, TOutput>
): ToolDefinition<TInput, ToolResult<TOutput>> & {
  tags: string[];
  priority: number;
  cost: string;
} {
  const {
    name,
    description,
    parameters,
    tags = [],
    priority = 10,
    cost = "moderate",
    execute,
    onError,
    timeoutMs = 30_000,
    wrapOutput,
  } = config;

  const wrappedExecute = async (
    input: z.infer<TInput>,
    ctx: ToolContext
  ): Promise<ToolResult<TOutput>> => {
    const start = Date.now();

    const runWithTimeout = (): Promise<TOutput> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        execute(input, ctx).then(
          (r) => { clearTimeout(timer); resolve(r); },
          (e) => { clearTimeout(timer); reject(e); }
        );
      });

    try {
      const output = await runWithTimeout();
      const durationMs = Date.now() - start;
      if (wrapOutput) return wrapOutput(output, durationMs);
      return { ok: true, data: output, durationMs, toolName: name };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const durationMs = Date.now() - start;
      if (onError) {
        try {
          const fallback = await Promise.resolve(onError(error, input, ctx));
          if (wrapOutput) return wrapOutput(fallback, durationMs);
          return { ok: true, data: fallback, durationMs, toolName: name, hint: "use_fallback" };
        } catch (fallbackErr) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          return { ok: false, error: msg, durationMs, toolName: name, hint: "escalate" };
        }
      }
      return { ok: false, error: error.message, durationMs, toolName: name, hint: "retry" };
    }
  };

  return Object.assign(
    {
      name,
      description,
      parameters,
      execute: wrappedExecute,
    } as ToolDefinition<TInput, ToolResult<TOutput>>,
    { tags, priority, cost }
  );
}

// ── Tool selector ─────────────────────────────────────────────────────────────

export interface ToolSelectorConfig {
  /**
   * Select the best tool for a given query from a list of candidates.
   * Returns the tool to use, or null if none is suitable.
   */
  select(
    query: string,
    candidates: Array<ToolDefinition & { tags?: string[]; priority?: number; cost?: string }>,
    ctx?: ToolContext
  ): ToolDefinition | null;
}

/**
 * Rule-based tool selector.
 * Picks the highest-priority tool whose tags match the query context.
 */
export function createRuleBasedSelector(rules: Array<{
  /** Keywords that trigger this rule. */
  keywords: string[];
  /** Preferred tool tags when keywords match. */
  preferTags: string[];
  /** Tags to avoid when keywords match. */
  avoidTags?: string[];
}>): ToolSelectorConfig {
  return {
    select(query, candidates) {
      const lower = query.toLowerCase();

      for (const rule of rules) {
        const matches = rule.keywords.some((kw) => lower.includes(kw));
        if (!matches) continue;

        const eligible = candidates.filter((c) => {
          const tags = (c as { tags?: string[] }).tags ?? [];
          const hasPreferred = rule.preferTags.some((t) => tags.includes(t));
          const hasAvoided = rule.avoidTags?.some((t) => tags.includes(t));
          return hasPreferred && !hasAvoided;
        });

        if (eligible.length > 0) {
          return eligible.sort(
            (a, b) =>
              ((a as { priority?: number }).priority ?? 10) -
              ((b as { priority?: number }).priority ?? 10)
          )[0];
        }
      }

      // Default: highest-priority tool
      return candidates.sort(
        (a, b) =>
          ((a as { priority?: number }).priority ?? 10) -
          ((b as { priority?: number }).priority ?? 10)
      )[0] ?? null;
    },
  };
}
