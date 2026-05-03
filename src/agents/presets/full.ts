/**
 * Full preset — everything wired up automatically.
 *
 * Automatically wires up:
 *   - Memory (if memoryKey is set)
 *   - Guardrails (if guardrails is set)
 *   - Approvals (if requireApprovalFor is set or tools have requiresApproval)
 *   - Observability (always — uses the global adapter)
 *
 * This is the drop-in equivalent of the original harness.ts behaviour.
 * Existing code using createHarness from "@/agents" continues to work unchanged.
 *
 * Usage:
 *   import { createHarness } from "@/agents/presets/full";
 *
 *   const harness = createHarness({
 *     name: "ResearchAgent",
 *     instructions: "You are a research assistant.",
 *     memoryKey: "userId",
 *     requireApprovalFor: ["web_search"],
 *     guardrails: { input: [maxLengthGuardrail(4000)] },
 *   });
 */

import { createCoreHarness } from "../core";
import type { AgentHarness } from "../core";
import { withMemory } from "../plugins/memory";
import { withGuardrails } from "../plugins/guardrails";
import { withApprovals } from "../plugins/approvals";
import { withObservability } from "../plugins/observability";
import type { AgentConfig } from "../types";
import type { GuardrailSet } from "../guardrails/types";

export interface FullConfig extends AgentConfig {
  guardrails?: GuardrailSet;
}

export type { AgentHarness };

export function createHarness(agentConfig: FullConfig): AgentHarness {
  const plugins = [...(agentConfig.plugins ?? [])];

  if (agentConfig.memoryKey) {
    plugins.unshift(withMemory({ key: agentConfig.memoryKey }));
  }
  if (agentConfig.guardrails) {
    plugins.push(withGuardrails(agentConfig.guardrails));
  }
  if (agentConfig.requireApprovalFor?.length) {
    plugins.push(withApprovals({ requireApprovalFor: agentConfig.requireApprovalFor }));
  }
  plugins.push(withObservability());

  return createCoreHarness({ ...agentConfig, plugins });
}
