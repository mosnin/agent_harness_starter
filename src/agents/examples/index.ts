/**
 * Barrel for all built-in example agents.
 *
 * Importing this file (or any individual agent file) registers that agent
 * in the global agent registry. The agent route handler imports this barrel
 * so all example agents are available by name without any route edits.
 *
 * To add your own agents, either:
 *   1. Add them here (import "@/my-agents/support-agent")
 *   2. Import your own barrel in the route file alongside this one
 */

export * from "./research-agent";  // registers "research"
export * from "./code-agent";      // registers "code"
// export * from "./your-agent";   // registers "your-agent-name"
