/**
 * Guardrails plugin — runs input guardrails before the agent and output
 * guardrails on the final response. Throws to block; transforms to modify.
 *
 * Usage:
 *   import { withGuardrails } from "@/agents/plugins/guardrails";
 *   import { maxLengthGuardrail, blockedKeywordsGuardrail } from "@/agents/guardrails";
 *
 *   const harness = createCustomHarness({
 *     name: "MyAgent",
 *     instructions: "...",
 *     plugins: [
 *       withGuardrails({
 *         input: [maxLengthGuardrail(4000)],
 *         output: [blockedKeywordsGuardrail(["confidential"])],
 *       }),
 *     ],
 *   });
 */

import type { HarnessPlugin, PluginRunContext } from "../types";
import type { GuardrailSet } from "../guardrails/types";

export function withGuardrails(guardrailSet: GuardrailSet): HarnessPlugin {
  return {
    name: "guardrails",

    async onBeforeRun(
      userMessage: string,
      ctx: PluginRunContext
    ): Promise<string> {
      if (!guardrailSet.input?.length) return userMessage;
      const { runInputGuardrails } = await import("../guardrails/index");
      return runInputGuardrails(userMessage, guardrailSet.input, {
        agentName: ctx.agentName,
        userId: ctx.userId,
        runId: ctx.runId,
      });
    },

    async onAfterRun(
      finalOutput: string,
      ctx: PluginRunContext
    ): Promise<string> {
      if (!guardrailSet.output?.length) return finalOutput;
      const { runOutputGuardrails } = await import("../guardrails/index");
      return runOutputGuardrails(finalOutput, guardrailSet.output, {
        agentName: ctx.agentName,
        userId: ctx.userId,
        runId: ctx.runId,
      });
    },
  };
}
