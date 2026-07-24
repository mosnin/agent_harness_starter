/**
 * Real-engine wiring for the `swarm_run_verified` MCP tool
 * (`./swarm-task-tool.ts`): a {@link SwarmSessionFactory} backed by the real
 * inline swarm (`src/swarm-runtime/factory.ts`'s `createInlineSwarm` — real
 * `SwarmManager`, real verification gate, real guardrails; only the isolation
 * boundary is in-process), plus a one-call helper that registers the tool on
 * an {@link McpServer}.
 *
 * The `dispatchGoal -> manager.startGoal` adaptation below is the exact same
 * one `src/desktop/core/sidecar.ts`'s `realSwarmFactory` performs — the real
 * `SwarmManager` has no method literally named `dispatchGoal`, so the port
 * wraps `startGoal` and returns its `goalId`.
 */

import { EventEmitter } from "node:events";
import { createInlineSwarm, type InlineSwarmOptions } from "../../swarm-runtime/factory";
import type { SwarmManager } from "../../swarm-runtime/manager/manager";
import type { McpServer, McpServerTool } from "./server";
import { createSwarmTaskTool, type SwarmSessionFactory, type SwarmSessionPort } from "./swarm-task-tool";

/** Adapt a live {@link SwarmManager} to the tool's {@link SwarmSessionPort}. */
export function adaptSwarmManager(manager: SwarmManager): SwarmSessionPort {
  const emitter = manager as unknown as EventEmitter;
  return {
    manager: {
      on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
      dispatchGoal: async (objective: string) => {
        const { goalId, done } = await manager.startGoal(objective);
        // The goal runs to completion in the background; its terminal state
        // reaches the tool via goal:completed/failed/aborted events. Don't
        // leave the background run's rejection unhandled.
        void done?.catch?.(() => undefined);
        return { goalId };
      },
    },
    start: async () => {
      await manager.ensurePool();
    },
    stop: async () => {
      await manager.shutdown();
    },
  };
}

/**
 * A {@link SwarmSessionFactory} over the real inline engine. Each tool call
 * gets its own fully-wired `SwarmManager` (pool, gate, guardrails) that is
 * shut down by the tool's own always-awaited `stop()` in `finally`.
 *
 * `base` lets the host pre-configure engine options (a custom planner,
 * executor, budget, …); the per-request `poolSize`/`capabilities`/
 * `maxAttempts` from the MCP client always win over `base`'s.
 */
export function realSwarmSessionFactory(base: InlineSwarmOptions = {}): SwarmSessionFactory {
  return async ({ poolSize, capabilities, maxAttempts }) => {
    const manager = await createInlineSwarm({
      ...base,
      poolSize,
      capabilities,
      maxAttempts,
    });
    return adaptSwarmManager(manager);
  };
}

/**
 * Register `swarm_run_verified` on an MCP server, backed by the real inline
 * engine by default. Returns the registered tool definition.
 */
export function registerSwarmTaskTool(
  server: McpServer,
  factory: SwarmSessionFactory = realSwarmSessionFactory(),
  opts: Parameters<typeof createSwarmTaskTool>[1] = {},
): McpServerTool {
  const tool = createSwarmTaskTool(factory, opts);
  server.register(tool);
  return tool;
}
