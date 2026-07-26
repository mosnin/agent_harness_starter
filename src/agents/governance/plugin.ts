/**
 * withGovernance plugin — enforces governance policy on every tool call
 * and agent output, recording all decisions in the compliance tracker.
 *
 * Usage:
 *   import { withGovernance } from "@/agents/governance/plugin";
 *   import { DEFAULT_GOVERNANCE_POLICY } from "@/agents/governance/policy";
 *   import { STANDARD_ETHICS_POLICY } from "@/agents/governance/ethics";
 *
 *   const agent = createAgent({
 *     plugins: [
 *       withGovernance({
 *         policy: DEFAULT_GOVERNANCE_POLICY,
 *         ethics: STANDARD_ETHICS_POLICY,
 *         compliance: myTracker,
 *         escalation: myEscalationHandler,
 *       }),
 *     ],
 *   });
 */

import type { HarnessPlugin, PluginRunContext } from "../types";
import type { ToolDefinition } from "../tools/types";
import type { GovernancePolicy } from "./policy";
import type { EthicsPolicy } from "./ethics";
import type { ComplianceTracker } from "./compliance";
import type { EscalationHandler } from "./escalation";
import type { GovernanceContext } from "./types";
import { evaluate, GovernancePolicyViolationError } from "./policy";

export interface GovernancePluginOptions {
  /** Governance policy to enforce on tool calls. */
  policy?: GovernancePolicy;
  /** Ethics policy to enforce on outputs. */
  ethics?: EthicsPolicy;
  /** Compliance tracker to log all decisions. */
  compliance?: ComplianceTracker;
  /** Escalation handler for high/critical decisions. */
  escalation?: EscalationHandler;
  /**
   * If true, log violations but don't block execution.
   * Useful for dry-run / shadow mode before rollout.
   * Default: false.
   */
  auditOnly?: boolean;
  /** Agent ID to use in governance context. Default: "unknown". */
  agentId?: string;
}

export function withGovernance(opts: GovernancePluginOptions = {}): HarnessPlugin {
  const { policy, ethics, compliance, escalation, auditOnly = false } = opts;

  return {
    name: "governance",

    wrapTools(tools: ToolDefinition[], _ctx: PluginRunContext): ToolDefinition[] {
      if (!policy) return tools;

      return tools.map((tool) => ({
        ...tool,
        execute: async (input: Parameters<typeof tool.execute>[0], toolCtx: Parameters<typeof tool.execute>[1]) => {
          const govCtx: GovernanceContext = {
            agentId: opts.agentId ?? _ctx.agentName,
            action: `tool:${tool.name}`,
            content: JSON.stringify(input),
            metadata: { input },
            timestamp: Date.now(),
          };

          const decision = await evaluate(policy, govCtx);
          compliance?.record(govCtx, decision);

          if (decision.outcome === "escalated" && escalation) {
            await escalation.escalate(govCtx, "high_risk_action", decision.reason);
          }

          if (decision.outcome === "blocked" && !auditOnly) {
            throw new GovernancePolicyViolationError(decision, tool.name);
          }

          return tool.execute(input, toolCtx);
        },
      }));
    },

    async onAfterRun(finalOutput: string, runCtx: PluginRunContext): Promise<string> {
      if (!ethics) return finalOutput;

      const govCtx: GovernanceContext = {
        agentId: opts.agentId ?? runCtx.agentName,
        action: "output",
        content: finalOutput,
        metadata: {},
        timestamp: Date.now(),
      };

      const decision = await ethics.evaluate(govCtx);
      compliance?.record(govCtx, decision);

      if (decision.outcome === "escalated" && escalation) {
        await escalation.escalate(govCtx, "ethical_concern", decision.reason);
      }

      if (decision.outcome === "blocked" && !auditOnly) {
        throw new GovernancePolicyViolationError(decision);
      }

      return finalOutput;
    },
  };
}
