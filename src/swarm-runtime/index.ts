/**
 * @module swarm-runtime
 *
 * Lightweight, Hermes-inspired swarm orchestration. A manager agent decomposes
 * a goal, spawns isolated worker agents (Docker containers in production, child
 * processes or inline for dev/test), delegates tasks over a pull-based bus, and
 * accepts a result only after it clears the anti-hallucination verification
 * gate and anti-rogue guardrails.
 *
 * Quick start (no Docker, single process):
 *
 *   import { createInlineSwarm } from "@/swarm-runtime";
 *   const swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize: 3 });
 *   const goal = await swarm.runGoal("Summarize the repo's architecture");
 *   console.log(goal.synthesis);
 *   await swarm.shutdown();
 */

export * from "./types";
export * from "./providers";
export * from "./bus";
export * from "./verification";
export * from "./manager";
export * from "./worker";
export * from "./persistence/index";
export * from "./mcp/index";
export { createInlineSwarm } from "./factory";
export type { InlineSwarmOptions } from "./factory";
export { buildSwarm, SwarmServer, DASHBOARD_HTML } from "./server/index";
export type { BuildSwarmOptions, BuiltSwarm, SwarmMode } from "./server/index";
