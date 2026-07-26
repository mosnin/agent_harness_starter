/**
 * withSecurity plugin — wires policy enforcement and audit logging into any agent.
 *
 * Usage (pre-built policy):
 *   plugins: [
 *     withSecurity({
 *       policy: createPolicy({ allow: ["web_search"], deny: ["shell_exec"] }),
 *     }),
 *   ]
 *
 * Usage (policy config + audit adapter, fully wired):
 *   plugins: [
 *     withSecurity({
 *       policyConfig: { allow: ["web_search"], deny: ["shell_exec"], name: "my-policy" },
 *       auditAdapter: new InMemoryAuditAdapter(),
 *     }),
 *   ]
 *
 * Every tool call is:
 *   1. Checked against the policy (throws PolicyViolationError if blocked).
 *   2. Logged to the audit logger (blocked, allowed, or error).
 */

import type { HarnessPlugin, PluginRunContext } from "../types";
import type { ToolDefinition } from "../tools/types";
import {
  createPolicy,
  createAuditedPolicy,
  type AgentPolicy,
  type PolicyConfig,
  PolicyViolationError,
} from "./policy";
import { audit as globalAudit, type AuditAdapter, type AuditLogger } from "./audit";

export interface SecurityPluginOptions {
  /**
   * Pre-built policy to enforce on every tool call.
   * If omitted (and no policyConfig is given), audit logging still runs but all tools are allowed.
   */
  policy?: AgentPolicy;

  /**
   * Policy config to build the policy from. When provided together with
   * `auditAdapter`, the policy is automatically wired to the audit adapter via
   * `createAuditedPolicy` so every policy decision is logged in addition to the
   * plugin-level execution log. Takes precedence over `policy` if both are set.
   */
  policyConfig?: PolicyConfig;

  /**
   * AuditLogger to write records to. Defaults to the global singleton.
   * Override for per-tenant loggers or in tests.
   */
  auditLogger?: AuditLogger;

  /**
   * AuditAdapter to wire directly into the policy via createAuditedPolicy.
   * Used only when `policyConfig` is also provided — connects governance
   * decisions to the same audit trail as execution events.
   */
  auditAdapter?: AuditAdapter;

  /**
   * If true, policy violations are logged but not thrown — the tool runs anyway.
   * Useful during migration to warn before enforcing. Default: false.
   */
  auditOnly?: boolean;
}

export function withSecurity(opts: SecurityPluginOptions = {}): HarnessPlugin {
  const { auditLogger = globalAudit, auditOnly = false } = opts;

  // Resolve the effective policy:
  // 1. policyConfig + auditAdapter → createAuditedPolicy (fully wired)
  // 2. policyConfig alone → createPolicy (no per-decision audit sink)
  // 3. policy (pre-built AgentPolicy) → used as-is
  // 4. neither → undefined (no policy enforcement, only execution logging)
  let policy: AgentPolicy | undefined;
  if (opts.policyConfig) {
    policy =
      opts.auditAdapter
        ? createAuditedPolicy(opts.policyConfig, opts.auditAdapter)
        : createPolicy(opts.policyConfig);
  } else {
    policy = opts.policy;
  }

  return {
    name: "security",

    wrapTools(
      tools: ToolDefinition[],
      ctx: PluginRunContext
    ): ToolDefinition[] {
      return tools.map((tool) => ({
        ...tool,
        execute: async (input: unknown, toolCtx: import("../tools/types").ToolContext) => {
          const start = Date.now();

          if (policy) {
            const result = await policy.check(tool.name, {
              userId: ctx.userId,
              runId: ctx.runId,
              toolInput: input,
            });

            if (!result.allowed) {
              auditLogger.log({
                runId: ctx.runId,
                userId: ctx.userId,
                agentName: ctx.agentName,
                toolName: tool.name,
                input,
                outcome: "blocked",
                policyName: policy.name,
                reason: result.reason,
              });

              if (!auditOnly) {
                throw new PolicyViolationError(tool.name, result.reason, policy.name);
              }
            }
          }

          // Execute and log
          try {
            const output = await tool.execute(input, toolCtx);
            auditLogger.log({
              runId: ctx.runId,
              userId: ctx.userId,
              agentName: ctx.agentName,
              toolName: tool.name,
              input,
              outcome: "allowed",
              durationMs: Date.now() - start,
            });
            return output;
          } catch (err) {
            auditLogger.log({
              runId: ctx.runId,
              userId: ctx.userId,
              agentName: ctx.agentName,
              toolName: tool.name,
              input,
              outcome: "error",
              durationMs: Date.now() - start,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        },
      }));
    },
  };
}
