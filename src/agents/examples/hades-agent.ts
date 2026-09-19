/**
 * Example: Hades agent — Jev decisions, Qwen generation.
 *
 * Registers as "hades" so /api/agent?agentName=hades and /api/hades
 * can look it up without route edits.
 */

import { createHadesHarness } from "../hades/index";
import { withMemory } from "../plugins/memory";
import { withObservability } from "../plugins/observability";
import { registerAgent } from "../agent-registry";
import type { AgentConfig } from "../types";

export const hadesAgentConfig: AgentConfig = {
  name: "Hades",
  instructions: (ctx) => {
    const userLabel = ctx.userId ? `User: ${ctx.userId}` : "a user";
    return `You are Hades, helping ${userLabel}.
Jev already screened this request and routed a Qwen model.
Do the work. Do not re-decide policy. Cite sources when you search.`;
  },
  skills: ["research"],
  memoryKey: "userId",
  modelSettings: {
    temperature: 0.3,
    maxTokens: 4096,
  },
  maxTurns: 10,
  plugins: [
    withMemory({ key: "userId", topK: 5, jevFilter: true }),
    withObservability(),
  ],
};

registerAgent("hades", hadesAgentConfig);

export function createHadesExampleAgent() {
  return createHadesHarness(hadesAgentConfig);
}
