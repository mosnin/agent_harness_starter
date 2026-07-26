import type { Claim, ToolCallRecord, WorkerTask } from "../types";
import type { ExecutionOutput, TaskExecutor, WorkerContext } from "./executor";

/**
 * Structural view of the project's agent harness (`@/agents` `createAgent`
 * result). Declared locally so the swarm runtime doesn't hard-depend on
 * `@openai/agents` — any object with this `run` shape works, including a mock in
 * tests. `toolCalls` is exactly what `RunResult` from `src/agents/types.ts`
 * carries.
 */
export interface RunnableHarness {
  run(input: {
    messages: Array<{ role: string; content: string }>;
    context?: Record<string, unknown>;
  }): Promise<{
    finalOutput: string;
    toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
    usage?: { totalTokens: number };
  }>;
}

export interface HarnessExecutorOptions {
  /** Build the user message from a task. */
  promptBuilder?: (task: WorkerTask) => string;
  /** Approx USD per 1K tokens, for budget accounting. */
  costPer1kTokens?: number;
}

/**
 * Runs each swarm task through the project's real agent harness — the same
 * streaming run loop, tool registry, guardrails, and memory the rest of this
 * repo uses. This is the bridge that makes swarm workers *actually do work* with
 * production plumbing rather than a demo executor.
 *
 * Crucially, it grounds the swarm's verification in the harness's real tool
 * calls: each tool the agent invoked becomes a tool-trace entry, and the claims
 * it emits cite those tool outputs as evidence — so the manager's gate confirms
 * the agent's answer against what its tools actually returned, not against the
 * text it generated.
 */
export class HarnessExecutor implements TaskExecutor {
  constructor(
    private readonly harness: RunnableHarness,
    private readonly opts: HarnessExecutorOptions = {}
  ) {}

  async execute(task: WorkerTask, ctx: WorkerContext): Promise<ExecutionOutput> {
    const prompt = this.opts.promptBuilder ? this.opts.promptBuilder(task) : defaultPrompt(task);
    ctx.log(`running harness for task ${task.id.slice(0, 8)}`);

    const result = await this.harness.run({
      messages: [{ role: "user", content: prompt }],
      context: { taskId: task.id, goalId: task.goalId, ...(task.input as Record<string, unknown>) },
    });

    const toolTrace: ToolCallRecord[] = result.toolCalls.map((c) => ({
      tool: c.name,
      args: (c.input && typeof c.input === "object" ? c.input : { value: c.input }) as Record<string, unknown>,
      ok: true,
      output: stringify(c.output),
      at: Date.now(),
    }));

    // Ground claims in the actual tool outputs the agent observed.
    const claims: Claim[] = result.toolCalls.map((c) => ({
      statement: `The agent used "${c.name}" and relied on its result.`,
      evidence: [stringify(c.output).slice(0, 300)],
      confidence: 0.8,
    }));
    // A summary claim for the final answer, grounded in the same tool outputs.
    if (result.finalOutput.trim()) {
      claims.push({
        statement: result.finalOutput.slice(0, 200),
        evidence:
          toolTrace.length > 0
            ? toolTrace.map((t) => t.output.slice(0, 120))
            : [result.finalOutput.slice(0, 120)],
        confidence: toolTrace.length > 0 ? 0.85 : 0.5,
      });
    }

    const costUsd =
      result.usage && this.opts.costPer1kTokens
        ? (result.usage.totalTokens / 1000) * this.opts.costPer1kTokens
        : undefined;

    return { output: result.finalOutput, claims, toolTrace, costUsd };
  }
}

function defaultPrompt(task: WorkerTask): string {
  const deps = (task.input as { _dependencies?: unknown[] })._dependencies;
  const feedback = (task.input as { _revisionFeedback?: string })._revisionFeedback;
  return [
    task.description,
    deps ? `\nVerified inputs from prior steps:\n${stringify(deps)}` : "",
    feedback ? `\nA prior attempt was rejected. Fix this:\n${feedback}` : "",
    "\nUse your tools to gather evidence, then answer concisely.",
  ]
    .filter(Boolean)
    .join("");
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
