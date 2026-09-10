import type { Claim, ToolCallRecord, WorkerTask } from "../types";

export interface ExecutionOutput {
  output: unknown;
  claims: Claim[];
  toolTrace: ToolCallRecord[];
  /** Optional USD cost incurred (LLM tokens, tool fees) for budget accounting. */
  costUsd?: number;
  usage?: { tokensIn: number; tokensOut: number; costMeasured: boolean };
  error?: string;
}

export interface WorkerContext {
  workerId: string;
  signal?: AbortSignal;
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
 * Deterministic orchestration fixture. It counts prompt words and combines
 * fixture outputs; it does not solve the requested real-world task.
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

    if (isSynthesis) {
      trace.push({
        tool: "collect_dependencies",
        args: { count: deps.length },
        ok: true,
        output: JSON.stringify(deps).slice(0, 500),
        at: Date.now(),
      });
      output = `Synthesis for "${objective}": integrated ${deps.length} verified sub-result(s).`;

    } else {
      output = `Analysis (${angle}): objective has ${wordCount} tokens; angle "${angle}" applied.`;

    }

    trace.push({ tool: "demo.computation", args: {}, ok: true, output, at: Date.now() });
    return { output, claims: [{ statement: output, evidence: [output], confidence: 0.5 }], toolTrace: trace, costUsd: 0 };
  }
}
