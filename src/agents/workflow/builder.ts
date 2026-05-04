/**
 * WorkflowBuilder — fluent API for composing multi-step agentic workflows.
 *
 * A workflow is an ordered list of steps executed against a shared WorkflowContext.
 * The builder produces a Workflow object with a single `run()` method — no framework
 * lock-in, compatible with any backend (Next.js API routes, Express, Inngest, etc.).
 *
 * All orchestration patterns are available as builder methods:
 *   .agent()       — single agent (sequential)
 *   .sequential()  — ordered chain of steps
 *   .parallel()    — concurrent fan-out
 *   .branch()      — conditional routing (first-match)
 *   .loop()        — iterate until stop condition
 *   .delegate()    — multi-agent coordination with optional supervisor
 *   .transform()   — pure function (no LLM)
 *   .custom()      — bring-your-own execute function
 *
 * Resilience wrappers available via the resilience module:
 *   withRetry, withTimeout, withFallback, withCircuitBreaker, withErrorHandler
 *
 * Usage:
 *   import { createWorkflow } from "@/agents/workflow";
 *   import { agentStep, parallel, branch, loop } from "@/agents/workflow/steps";
 *   import { withRetry, withTimeout } from "@/agents/workflow/resilience";
 *
 *   const workflow = createWorkflow("research-pipeline")
 *     .add(agentStep("gather", researchAgent))
 *     .add(withRetry(agentStep("analyze", analysisAgent), { maxAttempts: 2 }))
 *     .add(branch("review-gate", [
 *       { when: (ctx) => ctx.stepOutputs.analyze?.output.includes("risk"),
 *         step: agentStep("review", reviewAgent) }
 *     ], agentStep("auto-pass", noopAgent)))
 *     .build();
 *
 *   const result = await workflow.run(userMessage, { userId: "u123" });
 */

import { randomUUID } from "crypto";
import type { AgentConfig, RunInput } from "../types";
import type {
  WorkflowContext,
  WorkflowStep,
  WorkflowResult,
  Workflow,
  BranchCase,
  LoopConfig,
  DelegateConfig,
} from "./types";
import {
  agentStep,
  sequential,
  parallel,
  branch,
  loop,
  delegate,
  transform,
  customStep,
} from "./steps";
import type { StateStore, WorkflowLogger } from "./state";
import { NoopWorkflowLogger } from "./state";

// ── Builder config ────────────────────────────────────────────────────────────

export interface WorkflowBuilderConfig {
  /** Persist workflow state for durability / observability. */
  stateStore?: StateStore;
  /** Log workflow lifecycle events. Default: NoopWorkflowLogger. */
  logger?: WorkflowLogger;
  /**
   * Global timeout for the entire workflow in ms.
   * Individual steps can have their own timeouts via withTimeout().
   */
  timeoutMs?: number;
  /** Custom metadata to attach to every WorkflowState record. */
  metadata?: Record<string, unknown>;
}

// ── WorkflowBuilder ───────────────────────────────────────────────────────────

export class WorkflowBuilder {
  private readonly steps: WorkflowStep[] = [];
  private readonly cfg: WorkflowBuilderConfig;

  constructor(
    private readonly workflowName: string,
    cfg: WorkflowBuilderConfig = {}
  ) {
    this.cfg = cfg;
  }

  // ── Step adders ─────────────────────────────────────────────────────────────

  /** Add any WorkflowStep (including wrapped ones). */
  add(step: WorkflowStep): this {
    this.steps.push(step);
    return this;
  }

  /** Shorthand: add a single-agent step. */
  agent(name: string, agentConfig: AgentConfig): this {
    return this.add(agentStep(name, agentConfig));
  }

  /** Shorthand: add a sequential sub-pipeline. */
  sequential(name: string, steps: WorkflowStep[]): this {
    return this.add(sequential(name, steps));
  }

  /** Shorthand: add a parallel fan-out. */
  parallel(name: string, steps: WorkflowStep[]): this {
    return this.add(parallel(name, steps));
  }

  /** Shorthand: add a branch (conditional routing). */
  branch(name: string, cases: BranchCase[], fallback: WorkflowStep): this {
    return this.add(branch(name, cases, fallback));
  }

  /** Shorthand: add a loop (iterative). */
  loop(name: string, innerStep: WorkflowStep, loopConfig: LoopConfig): this {
    return this.add(loop(name, innerStep, loopConfig));
  }

  /** Shorthand: add a delegate (multi-agent coordination). */
  delegate(name: string, delegateConfig: DelegateConfig): this {
    return this.add(delegate(name, delegateConfig));
  }

  /** Shorthand: add a pure transform (no LLM). */
  transform(name: string, fn: (ctx: WorkflowContext) => string | Promise<string>): this {
    return this.add(transform(name, fn));
  }

  /** Shorthand: add a custom step. */
  custom(name: string, execute: (ctx: WorkflowContext) => Promise<WorkflowContext>): this {
    return this.add(customStep(name, execute));
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  build(): Workflow {
    const steps = [...this.steps];
    const { stateStore, logger = new NoopWorkflowLogger(), timeoutMs, metadata } = this.cfg;
    const workflowName = this.workflowName;

    return {
      name: workflowName,

      async run(
        message: string,
        agentContext: RunInput["context"] = {},
        signal?: AbortSignal
      ): Promise<WorkflowResult> {
        const runId = randomUUID();
        const startedAt = Date.now();

        const ctx: WorkflowContext = {
          originalMessage: message,
          agentContext,
          signal,
          stepOutputs: {},
          currentMessage: message,
          log: [],
        };

        // Save initial state
        await stateStore?.save({
          runId,
          workflowName,
          status: "running",
          currentStep: null,
          startedAt,
          contextSnapshot: { currentMessage: message, stepOutputs: {}, log: [] },
          metadata,
        });

        logger.info(runId, workflowName, `Workflow started with message: ${message.slice(0, 100)}`);

        async function executeSteps(): Promise<WorkflowContext> {
          let current = ctx;
          for (const step of steps) {
            if (signal?.aborted) throw new Error("Workflow cancelled");
            logger.info(runId, workflowName, `Executing step: ${step.name}`, step.name);
            await stateStore?.save({
              runId,
              workflowName,
              status: "running",
              currentStep: step.name,
              startedAt,
              contextSnapshot: {
                currentMessage: current.currentMessage,
                stepOutputs: current.stepOutputs,
                log: current.log,
              },
              metadata,
            });
            try {
              current = await step.execute(current);
              logger.info(runId, workflowName, `Step completed: ${step.name}`, step.name);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error(runId, workflowName, `Step failed: ${step.name} — ${msg}`, step.name);
              await stateStore?.save({
                runId,
                workflowName,
                status: "failed",
                currentStep: step.name,
                startedAt,
                completedAt: Date.now(),
                durationMs: Date.now() - startedAt,
                contextSnapshot: {
                  currentMessage: current.currentMessage,
                  stepOutputs: current.stepOutputs,
                  log: current.log,
                },
                error: msg,
                metadata,
              });
              throw err;
            }
          }
          return current;
        }

        let finalCtx: WorkflowContext;
        try {
          if (timeoutMs !== undefined) {
            finalCtx = await Promise.race([
              executeSteps(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Workflow "${workflowName}" timed out after ${timeoutMs}ms`)), timeoutMs)
              ),
            ]);
          } else {
            finalCtx = await executeSteps();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(runId, workflowName, `Workflow failed: ${msg}`);
          throw err;
        }

        const durationMs = Date.now() - startedAt;

        await stateStore?.save({
          runId,
          workflowName,
          status: "completed",
          currentStep: null,
          startedAt,
          completedAt: Date.now(),
          durationMs,
          contextSnapshot: {
            currentMessage: finalCtx.currentMessage,
            stepOutputs: finalCtx.stepOutputs,
            log: finalCtx.log,
          },
          metadata,
        });

        logger.info(runId, workflowName, `Workflow completed in ${durationMs}ms`);

        return {
          finalOutput: finalCtx.currentMessage,
          stepOutputs: finalCtx.stepOutputs,
          log: finalCtx.log,
          durationMs,
        };
      },
    };
  }
}

/**
 * Create a new WorkflowBuilder. This is the primary entry point.
 *
 * @param name - Workflow name (used in state, logs, and error messages)
 * @param config - Optional: stateStore, logger, timeoutMs, metadata
 */
export function createWorkflow(name: string, config?: WorkflowBuilderConfig): WorkflowBuilder {
  return new WorkflowBuilder(name, config);
}
