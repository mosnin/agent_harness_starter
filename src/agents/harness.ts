/**
 * Backward-compatible harness — automatically wires up memory, guardrails,
 * approvals, and observability based on AgentConfig fields.
 *
 * This is the same interface as before — all existing callers continue to work
 * without modification.
 *
 * For new agents, consider importing directly from the preset you need:
 *   import { createHarness } from "@/agents/presets/minimal";   // core only
 *   import { createHarness } from "@/agents/presets/standard";  // common features
 *   import { createHarness } from "@/agents/presets/full";      // everything
 *
 * Or compose your own with individual plugin factories:
 *   import { createCoreHarness } from "@/agents/core";
 *   import { withMemory, withGuardrails } from "@/agents/plugins";
 */

import { createHarness as createFullHarness } from "./presets/full";
import type { FullConfig } from "./presets/full";
import type { AgentHarness } from "./core";

/** Backward-compatible config type. */
export type HarnessConfig = FullConfig;

export type { AgentHarness };

export function createHarness(agentConfig: HarnessConfig): AgentHarness {
  return createFullHarness(agentConfig);
}
