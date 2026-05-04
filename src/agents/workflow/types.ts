/**
 * Core types for the workflow orchestration system.
 *
 * A Workflow is a directed graph of Steps. Each step transforms the
 * WorkflowContext and passes it to the next step(s). Steps are composable:
 * any step can itself contain a nested workflow (hierarchical).
 *
 * WorkflowContext is the shared state threaded through all steps.
 * It carries the original input, per-step outputs, metadata, and any
 * custom fields the user attaches.
 */

import type { AgentConfig, RunInput } from "../types";

// ── Workflow context ──────────────────────────────────────────────────────────

export interface WorkflowContext {
  /** The original user message that started this workflow. */
  readonly originalMessage: string;
  /** Per-request context (userId, orgId, etc.) */
  readonly agentContext: RunInput["context"];
  /** AbortSignal forwarded from the request. */
  readonly signal?: AbortSignal;

  /** Accumulated outputs keyed by step name. */
  stepOutputs: Record<string, StepOutput>;
  /** The "current" message passed to the next step. Starts as originalMessage. */
  currentMessage: string;
  /** Running log of all step executions. */
  log: StepLogEntry[];

  /** Custom user-defined fields. Attach anything you need between steps. */
  [key: string]: unknown;
}

export interface StepOutput {
  stepName: string;
  agentName?: string;
  output: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface StepLogEntry {
  stepName: string;
  startedAt: number;
  durationMs: number;
  status: "ok" | "skipped" | "error";
  error?: string;
}

// ── Step interface ────────────────────────────────────────────────────────────

/**
 * A step is the fundamental unit of a workflow.
 * It receives the current WorkflowContext, does work, and returns the updated context.
 * Returning null/undefined skips output mutation (noop step).
 */
export interface WorkflowStep {
  readonly name: string;
  readonly type: StepType;
  execute(ctx: WorkflowContext): Promise<WorkflowContext>;
}

export type StepType =
  | "agent"       // single agent call
  | "sequential"  // ordered chain of steps
  | "parallel"    // concurrent fan-out, all results collected
  | "branch"      // conditional routing: first matching predicate wins
  | "loop"        // iterate until stop condition or max passes
  | "delegate"    // multi-agent coordinator: one agent assigns work to others
  | "transform"   // pure function, no LLM call
  | "custom";     // user-supplied execute function

// ── Condition / predicate types ───────────────────────────────────────────────

export type StepCondition = (ctx: WorkflowContext) => boolean | Promise<boolean>;

export interface BranchCase {
  when: StepCondition;
  step: WorkflowStep;
  label?: string;
}

// ── Loop config ───────────────────────────────────────────────────────────────

export interface LoopConfig {
  /** Stop when this returns true. */
  until: (ctx: WorkflowContext, iteration: number) => boolean | Promise<boolean>;
  /** Hard iteration cap. Default: 5. */
  maxIterations?: number;
  /**
   * How to build the next input message from the context.
   * Default: use ctx.currentMessage.
   */
  buildNextInput?: (ctx: WorkflowContext, iteration: number) => string;
}

// ── Delegation config ─────────────────────────────────────────────────────────

export interface DelegateTarget {
  name: string;
  agent: AgentConfig;
  /** Only invoke this target when the condition returns true. */
  when?: StepCondition;
}

export interface DelegateConfig {
  /**
   * The coordinator agent that decides which targets to invoke and synthesizes results.
   * If omitted, all eligible targets run and outputs are joined with newlines.
   */
  coordinator?: AgentConfig;
  targets: DelegateTarget[];
  /**
   * Whether to run eligible targets in parallel (default) or sequentially.
   * Sequential is useful when targets have dependencies.
   */
  mode?: "parallel" | "sequential";
}

// ── Workflow result ───────────────────────────────────────────────────────────

export interface WorkflowResult {
  finalOutput: string;
  stepOutputs: Record<string, StepOutput>;
  log: StepLogEntry[];
  durationMs: number;
}

// ── Workflow ──────────────────────────────────────────────────────────────────

export interface Workflow {
  readonly name: string;
  run(
    message: string,
    agentContext?: RunInput["context"],
    signal?: AbortSignal
  ): Promise<WorkflowResult>;
}
