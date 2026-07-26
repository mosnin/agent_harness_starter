/**
 * Preset harness factories — pick the one that matches your needs.
 *
 *   minimal  — core only, no optional features (add your own via plugins)
 *   standard — memory + guardrails + observability (no approvals)
 *   full     — everything (memory + guardrails + approvals + observability)
 *
 * Import directly from the preset for tree-shaking:
 *   import { createHarness } from "@/agents/presets/minimal";
 *
 * Or use this barrel for convenience:
 *   import { createMinimalHarness, createStandardHarness, createFullHarness } from "@/agents/presets";
 */

export { createHarness as createMinimalHarness } from "./minimal";
export type { HarnessConfig as MinimalConfig } from "./minimal";

export { createHarness as createStandardHarness } from "./standard";
export type { StandardConfig } from "./standard";

export { createHarness as createFullHarness } from "./full";
export type { FullConfig } from "./full";

export type { AgentHarness } from "../core";
