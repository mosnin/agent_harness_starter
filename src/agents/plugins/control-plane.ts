/**
 * withControlPlane — production-ready security + governance + observability in one call.
 *
 * Replaces the manual combination of withSecurity, withGovernance, withObservability.
 * All three are wired together with a shared audit adapter so every decision is logged.
 *
 * Usage:
 *   import { withControlPlane } from "@/agents/plugins/control-plane";
 *   import { DEFAULT_GOVERNANCE_POLICY, STANDARD_ETHICS_POLICY } from "@/agents/governance";
 *   import { InMemoryAuditAdapter } from "@/agents/security";
 *
 *   const agent = createCustomHarness({
 *     name: "ProductionAgent",
 *     instructions: "...",
 *     plugins: [
 *       withControlPlane({
 *         governance: DEFAULT_GOVERNANCE_POLICY,
 *         ethics: STANDARD_ETHICS_POLICY,
 *         auditAdapter: new InMemoryAuditAdapter(),
 *       }),
 *     ],
 *   });
 */

import type { HarnessPlugin, PluginRunContext, AgentEvent, RunInput } from "../types";
import type { ToolDefinition } from "../tools/types";
import { withSecurity } from "../security/plugin";
import { withGovernance } from "../governance/plugin";
import { withObservability } from "./observability";

export interface ControlPlaneOptions {
  /** Governance policy (tool blocking, rate limiting, etc.). */
  governance?: import("../governance/policy").GovernancePolicy;
  /** Ethics policy (PII, harm, deception checks). */
  ethics?: import("../governance/ethics").EthicsPolicy;
  /** Audit adapter — receives every security and governance decision. */
  auditAdapter?: import("../security/audit").AuditAdapter;
  /** Tool allowlist (creates a security policy). If omitted, all tools are allowed. */
  allowTools?: string[];
  /** Tool denylist (never allow these, overrides allowTools). */
  denyTools?: string[];
  /** Set true to log decisions without enforcing them (shadow mode). Default: false. */
  auditOnly?: boolean;
}

export function withControlPlane(opts: ControlPlaneOptions = {}): HarnessPlugin {
  const { governance, ethics, auditAdapter, allowTools, denyTools, auditOnly = false } = opts;

  // Build security plugin — only wire a policyConfig when the caller has
  // specified an explicit allow/deny list; otherwise pass no policy so all
  // tools are allowed (matching the opt-in semantics of withSecurity).
  const securityPlugin = (allowTools !== undefined || denyTools !== undefined)
    ? withSecurity({
        policyConfig: {
          allow: allowTools,
          deny: denyTools,
        },
        auditAdapter,
        auditOnly,
      })
    : withSecurity({ auditAdapter, auditOnly });

  // Build governance plugin
  const governancePlugin = withGovernance({
    policy: governance,
    ethics,
    auditOnly,
  });

  // Build observability plugin
  const observabilityPlugin = withObservability();

  // All constituent plugins, in execution order
  const plugins: HarnessPlugin[] = [securityPlugin, governancePlugin, observabilityPlugin];

  return {
    name: "control-plane",

    async onBeforeRun(
      userMessage: string,
      ctx: PluginRunContext,
      input: RunInput
    ): Promise<string> {
      let msg = userMessage;
      for (const plugin of plugins) {
        if (plugin.onBeforeRun) {
          msg = await plugin.onBeforeRun(msg, ctx, input);
        }
      }
      return msg;
    },

    async wrapTools(
      tools: ToolDefinition[],
      ctx: PluginRunContext,
      pendingEvents: Map<string, AgentEvent>
    ): Promise<ToolDefinition[]> {
      let wrapped = tools;
      for (const plugin of plugins) {
        if (plugin.wrapTools) {
          wrapped = await plugin.wrapTools(wrapped, ctx, pendingEvents);
        }
      }
      return wrapped;
    },

    async onEvent(
      event: AgentEvent,
      ctx: PluginRunContext
    ): Promise<AgentEvent | null> {
      let current: AgentEvent | null = event;
      for (const plugin of plugins) {
        if (current === null) break;
        if (plugin.onEvent) {
          current = await plugin.onEvent(current, ctx);
        }
      }
      return current;
    },

    async onAfterRun(finalOutput: string, ctx: PluginRunContext): Promise<string> {
      let output = finalOutput;
      for (const plugin of plugins) {
        if (plugin.onAfterRun) {
          output = await plugin.onAfterRun(output, ctx);
        }
      }
      return output;
    },

    async onError(error: Error, ctx: PluginRunContext): Promise<void> {
      for (const plugin of plugins) {
        if (plugin.onError) {
          await plugin.onError(error, ctx);
        }
      }
    },

    async onComplete(
      ctx: PluginRunContext,
      result: { finalOutput: string; durationMs: number; error?: Error }
    ): Promise<void> {
      for (const plugin of plugins) {
        if (plugin.onComplete) {
          await plugin.onComplete(ctx, result);
        }
      }
    },
  };
}
