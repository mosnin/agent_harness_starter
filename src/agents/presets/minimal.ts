/**
 * Minimal preset — core harness with zero optional features.
 *
 * No memory, no guardrails, no approvals, no observability.
 * Add only what you need via the plugins array.
 *
 * Usage:
 *   import { createHarness } from "@/agents/presets/minimal";
 *   import { withMemory } from "@/agents/plugins/memory";
 *
 *   const harness = createHarness({
 *     name: "MyAgent",
 *     instructions: "You are a helpful assistant.",
 *     plugins: [withMemory({ key: "userId" })],
 *   });
 */

export { createCoreHarness as createHarness } from "../core";
export type { CoreConfig as HarnessConfig, AgentHarness } from "../core";
