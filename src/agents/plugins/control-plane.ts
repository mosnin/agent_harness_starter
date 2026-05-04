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

import type { HarnessPlugin } from "../types";
import { withSecurity } from "../security/plugin";
import { withGovernance } from "../governance/plugin";
import { withObservability } from "./observability";
import { composePlugins } from "./compose";

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

  return composePlugins("control-plane", constituents);
}
