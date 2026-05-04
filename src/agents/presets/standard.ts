/**
 * Standard preset — memory + guardrails + observability. Best for most production agents.
 *
 * Automatically wires up:
 *   - Memory (if memoryKey is set)
 *   - Guardrails (if guardrails is set)
 *   - Observability (always — uses the global adapter)
 *
 * No human-in-the-loop approvals. Use createFullHarness() or withApprovals() for that.
 *
 * Usage:
 *   import { createStandardHarness } from "@/agents/presets";
 *   import { maxLengthGuardrail } from "@/agents/guardrails";
 *
 *   const harness = createStandardHarness({
 *     name: "SupportAgent",
 *     instructions: (ctx) => `Helping user ${ctx.userId}`,
 *     memoryKey: "userId",
 *     guardrails: { input: [maxLengthGuardrail(4000)] },
 *   });
 */

import { createCustomHarness } from "../core";
import type { AgentHarness } from "../core";
import { withMemory } from "../plugins/memory";
import { withGuardrails } from "../plugins/guardrails";
import { withObservability } from "../plugins/observability";
import type { AgentConfig } from "../types";
import type { GuardrailSet } from "../guardrails/types";

export interface StandardConfig extends AgentConfig {
  guardrails?: GuardrailSet;
}

export type { AgentHarness };

export function createHarness(agentConfig: StandardConfig): AgentHarness {
  const plugins = [...(agentConfig.plugins ?? [])];
  const has = (name: string) => plugins.some((p) => p.name === name);

  if (agentConfig.memoryKey && !has("memory")) {
    plugins.unshift(withMemory({ key: agentConfig.memoryKey }));
  }
  if (agentConfig.guardrails && !has("guardrails")) {
    plugins.push(withGuardrails(agentConfig.guardrails));
  }
  if (!has("observability")) {
    plugins.push(withObservability());
  }

  return createCustomHarness({ ...agentConfig, plugins });
}
