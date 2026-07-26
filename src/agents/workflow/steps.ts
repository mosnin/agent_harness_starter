/**
 * Step factory functions — create WorkflowStep instances for each orchestration pattern.
 *
 * Every step receives a WorkflowContext, does work, and returns the updated context.
 * Steps are composable: pass any step as a child of sequential, parallel, branch, or loop.
 *
 * Usage:
 *   import { agentStep, parallel, branch, loop, transform, sequential } from "@/agents/workflow/steps";
 *
 *   const myWorkflow = createWorkflow("pipeline")
 *     .add(agentStep("draft", draftAgentConfig))
 *     .add(parallel("gather", [
 *       agentStep("legal",  legalAgentConfig),
 *       agentStep("market", marketAgentConfig),
 *     ]))
 *     .add(branch("review", [
 *       { when: (ctx) => ctx.stepOutputs.gather?.output.includes("risk"), step: reviewStep },
 *     ], autoApproveStep))
 *     .build();
 */

import { run, Agent } from "@openai/agents";
import { randomUUID } from "crypto";
import type { AgentConfig, RunInput } from "../types";
import { resolveAgentTools } from "../skills/index";
import { toOpenAITool } from "../utils";
import { config as libConfig } from "../lib/config";
import type {
  WorkflowContext,
  WorkflowStep,
  StepOutput,
  BranchCase,
  LoopConfig,
  DelegateConfig,
} from "./types";

// ── Internal helpers ──────────────────────────────────────────────────────────

async function resolveInstructions(
  agentConfig: AgentConfig,
  ctx: RunInput["context"]
): Promise<string> {
  if (typeof agentConfig.instructions === "function") {
    return agentConfig.instructions(ctx ?? {});
  }
  return agentConfig.instructions;
}

async function buildSdkAgent(
  agentConfig: AgentConfig,
  agentCtx: RunInput["context"]
): Promise<Agent> {
  const toolDefs = resolveAgentTools(agentConfig.tools ?? [], agentConfig.skills ?? []);
  const sdkTools = toolDefs.map((t) => toOpenAITool(t, agentCtx));
  const instructions = await resolveInstructions(agentConfig, agentCtx);
  return new Agent({
    name: agentConfig.name,
    instructions,
    model: agentConfig.model ?? libConfig.openai.model,
    tools: sdkTools,
    ...(agentConfig.modelSettings?.temperature !== undefined && {
      temperature: agentConfig.modelSettings.temperature,
    }),
  });
}

async function callAgent(
  agentConfig: AgentConfig,
  message: string,
  workflowCtx: WorkflowContext
): Promise<string> {
  const agent = await buildSdkAgent(agentConfig, workflowCtx.agentContext);
  const result = await run(agent, message, {
    maxTurns: agentConfig.maxTurns ?? 20,
    signal: workflowCtx.signal,
    context: workflowCtx.agentContext ?? {},
  });
  return (result as { finalOutput?: string }).finalOutput ?? "";
}

function recordStep(
  ctx: WorkflowContext,
  stepName: string,
  output: StepOutput,
  status: "ok" | "skipped" | "error",
  error?: string
): void {
  ctx.stepOutputs[stepName] = output;
  ctx.log.push({
    stepName,
    startedAt: output.durationMs ? Date.now() - output.durationMs : Date.now(),
    durationMs: output.durationMs,
    status,
    error,
  });
}

// ── agentStep — single agent call ─────────────────────────────────────────────

/**
 * Run a single agent. Updates ctx.currentMessage with its output.
 */
export function agentStep(name: string, agentConfig: AgentConfig): WorkflowStep {
  return {
    name,
    type: "agent",
    async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      const start = Date.now();
      const output = await callAgent(agentConfig, ctx.currentMessage, ctx);
      const stepOut: StepOutput = { stepName: name, agentName: agentConfig.name, output, durationMs: Date.now() - start };
      recordStep(ctx, name, stepOut, "ok");
      ctx.currentMessage = output;
      return ctx;
    },
  };
}

// ── sequential — ordered chain of steps ──────────────────────────────────────

/**
 * Run steps in order, passing ctx.currentMessage through each.
 */
export function sequential(name: string, steps: WorkflowStep[]): WorkflowStep {
  return {
    name,
    type: "sequential",
    async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      const start = Date.now();
      let current = ctx;
      for (const step of steps) {
        current = await step.execute(current);
      }
      recordStep(current, name, {
        stepName: name,
        output: current.currentMessage,
        durationMs: Date.now() - start,
      }, "ok");
      return current;
    },
  };
}

// ── parallel — concurrent fan-out ────────────────────────────────────────────

/**
 * Run all steps concurrently against the current message.
 * ctx.currentMessage is set to a JSON summary of all outputs.
 * Individual outputs are stored in ctx.stepOutputs[`${name}.${step.name}`].
 */
export function parallel(name: string, steps: WorkflowStep[]): WorkflowStep {
  return {
    name,
    type: "parallel",
    async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      const start = Date.now();
      const snapshot = ctx.currentMessage;

      const results = await Promise.allSettled(
        steps.map(async (step) => {
          const childCtx: WorkflowContext = {
            ...ctx,
            stepOutputs: { ...ctx.stepOutputs },
            log: [],
            currentMessage: snapshot,
          };
          const updated = await step.execute(childCtx);
          return { stepName: step.name, output: updated.currentMessage, childCtx: updated };
        })
      );

      const outputs: Record<string, string> = {};
      for (const r of results) {
        if (r.status === "fulfilled") {
          const { stepName, output, childCtx } = r.value;
          outputs[stepName] = output;
          Object.assign(ctx.stepOutputs, childCtx.stepOutputs);
          ctx.log.push(...childCtx.log);
        }
      }

      const summary = JSON.stringify(outputs, null, 2);
      recordStep(ctx, name, { stepName: name, output: summary, durationMs: Date.now() - start }, "ok");
      ctx.currentMessage = summary;
      return ctx;
    },
  };
}

// ── branch — conditional routing ─────────────────────────────────────────────

/**
 * Evaluate predicates in order; run the first matching step.
 * If no predicate matches, run the fallback step.
 */
export function branch(
  name: string,
  cases: BranchCase[],
  fallback: WorkflowStep
): WorkflowStep {
  return {
    name,
    type: "branch",
    async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      const start = Date.now();
      for (const c of cases) {
        const match = await Promise.resolve(c.when(ctx));
        if (match) {
          const updated = await c.step.execute(ctx);
          recordStep(updated, name, {
            stepName: name,
            output: updated.currentMessage,
            durationMs: Date.now() - start,
            metadata: { branch: c.label ?? c.step.name },
          }, "ok");
          return updated;
        }
      }
      const updated = await fallback.execute(ctx);
      recordStep(updated, name, {
        stepName: name,
        output: updated.currentMessage,
        durationMs: Date.now() - start,
        metadata: { branch: "fallback" },
      }, "ok");
      return updated;
    },
  };
}

// ── loop — iterate until condition ────────────────────────────────────────────

/**
 * Run a step in a loop until the stop condition is met or maxIterations is reached.
 * Useful for critic-revision cycles.
 */
export function loop(
  name: string,
  innerStep: WorkflowStep,
  loopConfig: LoopConfig
): WorkflowStep {
  const { until, maxIterations = 5, buildNextInput } = loopConfig;

  return {
    name,
    type: "loop",
    async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      const start = Date.now();
      let current = ctx;

      for (let i = 0; i < maxIterations; i++) {
        if (buildNextInput) {
          current.currentMessage = buildNextInput(current, i);
        }
        current = await innerStep.execute(current);
        const stop = await Promise.resolve(until(current, i));
        if (stop) break;
      }

      recordStep(current, name, {
        stepName: name,
        output: current.currentMessage,
        durationMs: Date.now() - start,
      }, "ok");
      return current;
    },
  };
}

// ── delegate — multi-agent coordination ───────────────────────────────────────

/**
 * Fan out to multiple target agents (in parallel or sequentially),
 * then optionally have a coordinator agent synthesize the outputs.
 * If no coordinator is provided, outputs are concatenated.
 */
export function delegate(name: string, delegateConfig: DelegateConfig): WorkflowStep {
  const { coordinator, targets, mode = "parallel" } = delegateConfig;

  return {
    name,
    type: "delegate",
    async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      const start = Date.now();

      // Filter eligible targets
      const eligible = await Promise.all(
        targets.map(async (t) => {
          if (t.when) {
            const ok = await Promise.resolve(t.when(ctx));
            return ok ? t : null;
          }
          return t;
        })
      ).then((r) => r.filter(Boolean) as typeof targets);

      // Invoke targets
      const targetOutputs: Array<{ name: string; output: string }> = [];

      if (mode === "parallel") {
        const results = await Promise.allSettled(
          eligible.map(async (t) => ({
            name: t.name,
            output: await callAgent(t.agent, ctx.currentMessage, ctx),
          }))
        );
        for (const r of results) {
          if (r.status === "fulfilled") targetOutputs.push(r.value);
        }
      } else {
        for (const t of eligible) {
          const output = await callAgent(t.agent, ctx.currentMessage, ctx);
          targetOutputs.push({ name: t.name, output });
        }
      }

      // Store individual target outputs
      for (const { name: tName, output } of targetOutputs) {
        ctx.stepOutputs[`${name}.${tName}`] = { stepName: tName, output, durationMs: 0 };
      }

      // Coordinator synthesis or concatenation
      let finalOutput: string;
      if (coordinator) {
        const synthPrompt = targetOutputs
          .map((r) => `### ${r.name}\n${r.output}`)
          .join("\n\n");
        finalOutput = await callAgent(
          coordinator,
          `Original request: ${ctx.currentMessage}\n\nSub-agent outputs:\n\n${synthPrompt}\n\nSynthesize the above into one coherent response.`,
          ctx
        );
      } else {
        finalOutput = targetOutputs.map((r) => `[${r.name}]: ${r.output}`).join("\n\n");
      }

      recordStep(ctx, name, {
        stepName: name,
        output: finalOutput,
        durationMs: Date.now() - start,
        metadata: { targets: targetOutputs.map((r) => r.name) },
      }, "ok");
      ctx.currentMessage = finalOutput;
      return ctx;
    },
  };
}

// ── transform — pure function step (no LLM) ───────────────────────────────────

/**
 * Apply a synchronous or async transformation to ctx.currentMessage without an LLM call.
 * Useful for formatting, filtering, or injecting computed values.
 */
export function transform(
  name: string,
  fn: (ctx: WorkflowContext) => string | Promise<string>
): WorkflowStep {
  return {
    name,
    type: "transform",
    async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      const start = Date.now();
      const output = await Promise.resolve(fn(ctx));
      recordStep(ctx, name, { stepName: name, output, durationMs: Date.now() - start }, "ok");
      ctx.currentMessage = output;
      return ctx;
    },
  };
}

// ── custom — bring-your-own execute function ──────────────────────────────────

/**
 * Escape hatch: define a fully custom step with your own execute logic.
 */
export function customStep(
  name: string,
  execute: (ctx: WorkflowContext) => Promise<WorkflowContext>
): WorkflowStep {
  return { name, type: "custom", execute };
}

export { randomUUID };
