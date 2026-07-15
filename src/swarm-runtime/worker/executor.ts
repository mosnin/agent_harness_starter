import type { Claim, ToolCallRecord, WorkerTask } from "../types";

export interface ExecutionOutput {
  output: unknown;
  claims: Claim[];
  toolTrace: ToolCallRecord[];
  /** Optional USD cost incurred (LLM tokens, tool fees) for budget accounting. */
  costUsd?: number;
}

export interface WorkerContext {
  workerId: string;
  model?: string;
  log: (line: string) => void;
}

/**
 * A worker's brain. Given a task, it produces an output plus the grounded
 * claims and tool trace the manager's verification gate will scrutinize.
 * Kept as an interface so the runtime is SDK-agnostic: tests use the demo
 * executor, production plugs in an LLM-backed one.
 */
export interface TaskExecutor {
  execute(task: WorkerTask, ctx: WorkerContext): Promise<ExecutionOutput>;
}

/**
 * Deterministic executor used for inline/dev runs and tests. It does *real*
 * grounded work — every claim it emits cites an actual recorded tool call — so
 * it exercises the full verification pipeline without any API keys. This is
 * also the reference implementation showing how a well-behaved worker must
 * ground its output: observe via tools, then cite what it observed.
 */
export class DemoExecutor implements TaskExecutor {
  async execute(task: WorkerTask, ctx: WorkerContext): Promise<ExecutionOutput> {
    const trace: ToolCallRecord[] = [];
    const objective = String((task.input as { objective?: unknown }).objective ?? task.description);
    const angle = String((task.input as { angle?: unknown }).angle ?? "general");

    // "Tool call": deterministic analysis of the objective. Recorded so the
    // claim below is traceable to observed evidence.
    const wordCount = objective.trim().split(/\s+/).filter(Boolean).length;
    trace.push({
      tool: "analyze_objective",
      args: { objective, angle },
      ok: true,
      output: `angle=${angle} tokens=${wordCount}`,
      at: Date.now(),
    });
    ctx.log(`analyzed objective from angle "${angle}" (${wordCount} tokens)`);

    const isSynthesis = (task.input as { mode?: string }).mode === "synthesize";
    const deps = (task.input as { _dependencies?: Array<{ output: unknown }> })._dependencies ?? [];

    let output: string;
    const claims: Claim[] = [];

    if (isSynthesis) {
      trace.push({
        tool: "collect_dependencies",
        args: { count: deps.length },
        ok: true,
        output: JSON.stringify(deps).slice(0, 500),
        at: Date.now(),
      });
      output = `Synthesis for "${objective}": integrated ${deps.length} verified sub-result(s).`;
      claims.push({
        statement: `Synthesis integrates ${deps.length} verified upstream result(s).`,
        evidence: [`collect_dependencies returned ${deps.length}`, `angle=${angle} tokens=${wordCount}`],
        confidence: deps.length > 0 ? 0.9 : 0.6,
      });
    } else {
      output = `Analysis (${angle}): objective has ${wordCount} tokens; angle "${angle}" applied.`;
      claims.push({
        statement: `The objective contains ${wordCount} tokens when analyzed from the "${angle}" angle.`,
        evidence: [`analyze_objective output: angle=${angle} tokens=${wordCount}`],
        confidence: 0.85,
      });
    }

    return { output, claims, toolTrace: trace };
  }
}
