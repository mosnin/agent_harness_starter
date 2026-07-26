import type { WorkerTask } from "../types";
import type { ExecutionOutput, TaskExecutor, WorkerContext } from "./executor";

/**
 * Minimal shape of a child manager this executor drives — matches SwarmManager
 * without importing it (avoids a cycle: manager → worker → manager).
 */
export interface SubManager {
  runGoal(objective: string, opts?: { timeoutMs?: number }): Promise<{
    status: string;
    synthesis?: unknown;
    id: string;
  }>;
  listTasks(goalId?: string): Array<{ description: string; result?: { output: unknown } }>;
  shutdown(): Promise<void>;
}

export interface SubSwarmExecutorOptions {
  /** Factory that builds a fresh child swarm to solve a delegated task. */
  makeChild: () => Promise<SubManager>;
  /** Executor for tasks that are NOT delegated. */
  base: TaskExecutor;
  /** Decide whether a task should be handed to a child sub-swarm. */
  shouldDelegate?: (task: WorkerTask) => boolean;
  /** Child goal timeout. */
  childTimeoutMs?: number;
}

/**
 * Enables **hierarchical swarms**: a worker holding a complex task spins up an
 * entire child sub-swarm (its own manager, workers, verification gate) to solve
 * it, then returns the child's synthesized answer — grounded in the child's
 * verified sub-results. The parent's verification gate still scrutinizes the
 * returned claims, so delegation never bypasses trust: a sub-swarm's output is
 * only as trusted as its own verified evidence, re-checked at the parent.
 *
 * Delegation is opt-in per task (default: `task.input.subSwarm === true`), so a
 * plan can mark just the tasks that warrant a full sub-swarm and run the rest
 * inline.
 */
export class SubSwarmExecutor implements TaskExecutor {
  private readonly shouldDelegate: (task: WorkerTask) => boolean;

  constructor(private readonly opts: SubSwarmExecutorOptions) {
    this.shouldDelegate =
      opts.shouldDelegate ?? ((t) => (t.input as { subSwarm?: unknown }).subSwarm === true);
  }

  async execute(task: WorkerTask, ctx: WorkerContext): Promise<ExecutionOutput> {
    if (!this.shouldDelegate(task)) {
      return this.opts.base.execute(task, ctx);
    }

    const objective = String((task.input as { objective?: unknown }).objective ?? task.description);
    ctx.log(`delegating to a child sub-swarm: ${objective.slice(0, 60)}`);

    const child = await this.opts.makeChild();
    try {
      const goal = await child.runGoal(objective, { timeoutMs: this.opts.childTimeoutMs });
      const subResults = child
        .listTasks(goal.id)
        .filter((t) => t.result)
        .map((t) => ({ task: t.description, output: t.result!.output }));

      if (goal.status !== "completed") {
        return {
          output: null,
          claims: [],
          toolTrace: [{ tool: "sub_swarm", args: { objective }, ok: false, output: `child ${goal.status}`, at: Date.now() }],
        };
      }

      // The child's verified sub-results are the observed evidence; the parent
      // gate will confirm the claim below traces to them.
      const evidenceBlob = JSON.stringify(subResults);
      return {
        output: goal.synthesis,
        claims: [
          {
            statement: `A child sub-swarm resolved the delegated objective across ${subResults.length} verified sub-result(s).`,
            evidence: [`sub_swarm produced ${subResults.length} verified sub-result(s)`, evidenceBlob.slice(0, 200)],
            confidence: 0.85,
          },
        ],
        toolTrace: [
          {
            tool: "sub_swarm",
            args: { objective },
            ok: true,
            output: `verified ${subResults.length} sub-result(s): ${evidenceBlob}`.slice(0, 2000),
            at: Date.now(),
          },
        ],
      };
    } finally {
      await child.shutdown();
    }
  }
}
