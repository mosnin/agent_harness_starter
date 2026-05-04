/**
 * Agent registry — a central store of named agent configs.
 *
 * Each agent file calls registerAgent() at import time (side-effect import),
 * so the route handler only needs to import the barrel to activate all agents:
 *
 *   import "@/agents/examples";   // registers research, code, etc.
 *   import "@/my-agents";         // registers your own product agents
 *
 * Then look up an agent by name:
 *   const config = getAgentConfig("research");
 *
 * Registering your own agent:
 *   import { registerAgent } from "@/agents/agent-registry";
 *   registerAgent("support", supportAgentConfig);
 */

import type { AgentConfig } from "./types";

const registry = new Map<string, AgentConfig>();

/** Register an agent config under a URL-safe name (e.g. "research", "support"). */
export function registerAgent(name: string, config: AgentConfig): void {
  if (registry.has(name)) {
    console.warn(`[agent-registry] Overwriting existing agent: "${name}"`);
  }
  registry.set(name, config);
}

/** Return the config for a registered agent, or undefined if not found. */
export function getAgentConfig(name: string): AgentConfig | undefined {
  return registry.get(name);
}

/** Names of all registered agents. */
export function getAllAgentNames(): string[] {
  return Array.from(registry.keys());
}
