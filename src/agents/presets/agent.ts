/**
 * createAgent — the single recommended entry point for new agents.
 *
 * Wires up memory, guardrails, and observability automatically based on
 * the config you provide. No plugins array required.
 *
 * When you need more control:
 *   createStandardHarness — same as createAgent, explicit name
 *   createFullHarness     — adds human approval gates for irreversible actions
 *   createMinimalHarness  — core only, compose plugins yourself
 *   createCustomHarness   — raw engine, bring your own everything
 *
 * Usage:
 *   import { createAgent } from "@/agents";
 *
 *   const agent = createAgent({
 *     name: "SupportAgent",
 *     instructions: "You are a helpful customer support agent.",
 *     memoryKey: "userId",
 *   });
 */

// Direct alias — no wrapper indirection.
export { createHarness as createAgent } from "./standard";
export type { StandardConfig } from "./standard";
