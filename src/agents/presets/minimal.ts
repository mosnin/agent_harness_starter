/**
 * Minimal preset — no plugins. Full manual control. Smallest bundle.
 *
 * No memory, no guardrails, no approvals, no observability.
 * Add only what you need via the plugins array.
 *
 * Usage:
 *   import { createMinimalHarness } from "@/agents/presets";
 *   import { withMemory } from "@/agents/plugins/memory";
 *
 *   const harness = createMinimalHarness({
 *     name: "MyAgent",
 *     instructions: "You are a helpful assistant.",
 *     plugins: [withMemory({ key: "userId" })],
 *   });
 */

export { createCustomHarness as createHarness } from "../core";
export type { CoreConfig as HarnessConfig, AgentHarness } from "../core";
