/**
 * @deprecated This file is kept for internal structural reasons only.
 * Use named presets from "@/agents/presets" instead:
 *   import { createFullHarness }     from "@/agents/presets"; // everything + approvals
 *   import { createStandardHarness } from "@/agents/presets"; // memory + guardrails + observability
 *   import { createMinimalHarness }  from "@/agents/presets"; // no plugins
 *
 * Or compose your own:
 *   import { createCustomHarness } from "@/agents/core";
 *   import { withMemory, withGuardrails } from "@/agents/plugins";
 */

import { createHarness as createFullHarness } from "./presets/full";
import type { FullConfig } from "./presets/full";
import type { AgentHarness } from "./core";

export type HarnessConfig = FullConfig;
export type { AgentHarness };
