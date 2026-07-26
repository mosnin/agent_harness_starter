import type { SwarmManager } from "../manager/manager";

/**
 * Self-contained tool definition (same shape the rest of this repo uses for
 * MCP/tool registries) that drives a live {@link SwarmManager}. Register these
 * with the project's MCP server to let an external client — Claude Desktop,
 * Cursor, another agent — spawn goals, watch progress, and cancel work.
 *
 * Goals run asynchronously: `swarm_run_goal` returns a goalId immediately, then
 * the client polls `swarm_goal_status`. This keeps each tool call fast and
 * non-blocking even for long swarms.
 */
export interface SwarmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (manager: SwarmManager, args: Record<string, unknown>) => Promise<unknown>;
}

export function createSwarmMcpTools(manager: SwarmManager): SwarmToolDefinition[] {
  return [
    {
      name: "swarm_run_goal",
      description:
        "Dispatch a goal to the swarm. Returns a goalId immediately; the goal runs in the background under the verification gate. Poll swarm_goal_status for progress.",
      parameters: {
        objective: { type: "string", description: "The goal for the swarm to accomplish.", required: true },
        timeoutMs: { type: "number", description: "Optional wall-clock ceiling in ms." },
        maxWorkerRuns: { type: "number", description: "Optional budget: max total worker runs." },
        maxToolCalls: { type: "number", description: "Optional budget: max total tool calls." },
      },
      async execute(mgr, args) {
        const budget =
          args.maxWorkerRuns != null || args.maxToolCalls != null
            ? {
                maxWorkerRuns: args.maxWorkerRuns != null ? Number(args.maxWorkerRuns) : undefined,
                maxToolCalls: args.maxToolCalls != null ? Number(args.maxToolCalls) : undefined,
              }
            : undefined;
        const { goalId, done } = await mgr.startGoal(String(args.objective), {
          timeoutMs: args.timeoutMs != null ? Number(args.timeoutMs) : undefined,
          budget,
        });
        // Don't leave the background run's rejection unhandled.
        void done.catch(() => undefined);
        return { goalId, status: "running" };
      },
    },

    {
      name: "swarm_goal_status",
      description: "Get the status, synthesis, task breakdown, contradictions, and resource usage of a goal.",
      parameters: {
        goalId: { type: "string", description: "The goal id returned by swarm_run_goal.", required: true },
      },
      async execute(mgr, args) {
        const goalId = String(args.goalId);
        const goal = mgr.getGoal(goalId);
        if (!goal) return { error: "unknown goalId" };
        const tasks = mgr.listTasks(goalId);
        return {
          status: goal.status,
          objective: goal.objective,
          synthesis: goal.synthesis,
          contradictions: goal.contradictions ?? [],
          usage: mgr.getUsage(goalId),
          tasks: tasks.map((t) => ({ id: t.id, description: t.description, status: t.status, attempts: t.attempts })),
        };
      },
    },

    {
      name: "swarm_cancel_goal",
      description: "Cancel a running goal. In-flight results are discarded.",
      parameters: {
        goalId: { type: "string", description: "The goal id to cancel.", required: true },
        reason: { type: "string", description: "Optional cancellation reason." },
      },
      async execute(mgr, args) {
        const cancelled = mgr.cancelGoal(String(args.goalId), args.reason ? String(args.reason) : undefined);
        return { cancelled };
      },
    },

    {
      name: "swarm_list_workers",
      description: "List the swarm's worker agents and their status, load, and capabilities.",
      parameters: {},
      async execute(mgr) {
        return mgr.listWorkers().map((w) => ({
          workerId: w.workerId,
          status: w.status,
          load: w.load,
          capabilities: w.capabilities,
          killReason: w.killReason,
        }));
      },
    },

    {
      name: "swarm_provenance",
      description:
        "Audit trail for a goal: for each accepted result, the claims and which evidence was confirmed against the worker's tool trace.",
      parameters: {
        goalId: { type: "string", description: "The goal id to inspect.", required: true },
      },
      async execute(mgr, args) {
        return {
          groundingRate: mgr.groundingRate(),
          records: mgr.listProvenance(String(args.goalId)),
        };
      },
    },
  ];
}
