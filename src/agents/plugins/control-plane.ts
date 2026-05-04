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
  const constituents: HarnessPlugin[] = [securityPlugin, governancePlugin, observabilityPlugin].filter(Boolean);

  return {
    name: "control-plane",

    async onBeforeRun(
      userMessage: string,
      ctx: PluginRunContext,
      input: RunInput
    ): Promise<string> {
      let result = userMessage;
      for (const p of constituents) {
        if (p.onBeforeRun) result = await p.onBeforeRun(result, ctx, input);
      }
      return result;
    },

    async onResolveInstructions(
      instructions: string,
      userMessage: string,
      ctx: PluginRunContext
    ): Promise<string> {
      let result = instructions;
      for (const p of constituents) {
        if (p.onResolveInstructions) result = await p.onResolveInstructions(result, userMessage, ctx);
      }
      return result;
    },

    async wrapTools(
      tools: ToolDefinition[],
      ctx: PluginRunContext,
      pendingEvents: Map<string, AgentEvent>
    ): Promise<ToolDefinition[]> {
      let wrapped = tools;
      for (const p of constituents) {
        if (p.wrapTools) {
          wrapped = await p.wrapTools(wrapped, ctx, pendingEvents);
        }
      }
      return wrapped;
    },

    async onEvent(
      event: AgentEvent,
      ctx: PluginRunContext
    ): Promise<AgentEvent | null> {
      let current: AgentEvent | null = event;
      for (const p of constituents) {
        if (current === null) break;
        if (p.onEvent) {
          current = await p.onEvent(current, ctx);
        }
      }
      return current;
    },

    async onAfterRun(finalOutput: string, ctx: PluginRunContext): Promise<string> {
      let output = finalOutput;
      for (const p of constituents) {
        if (p.onAfterRun) {
          output = await p.onAfterRun(output, ctx);
        }
      }
      return output;
    },

    async onError(error: Error, ctx: PluginRunContext): Promise<void> {
      for (const p of constituents) {
        if (p.onError) {
          await p.onError(error, ctx);
        }
      }
    },

    async onComplete(
      ctx: PluginRunContext,
      result: { finalOutput: string; durationMs: number; error?: Error }
    ): Promise<void> {
      for (const p of constituents) {
        if (p.onComplete) {
          await p.onComplete(ctx, result);
        }
      }
    },
  };
}
