/**
 * withSecurity plugin — wires policy enforcement and audit logging into any agent.
 *
 * Usage:
 *   plugins: [
 *     withSecurity({
 *       policy: createPolicy({ allow: ["web_search"], deny: ["shell_exec"] }),
 *     }),
 *   ]
 *
 * Every tool call is:
 *   1. Checked against the policy (throws PolicyViolationError if blocked).
 *   2. Logged to the audit logger (blocked, allowed, or error).
 */

import type { HarnessPlugin, PluginRunContext } from "../types";
import type { ToolDefinition } from "../tools/types";
import { applyPolicyToTools, type AgentPolicy, PolicyViolationError } from "./policy";
import { audit as globalAudit, type AuditLogger } from "./audit";

export interface SecurityPluginOptions {
  /**
   * Policy to enforce on every tool call.
   * If omitted, audit logging still runs but all tools are allowed.
   */
  policy?: AgentPolicy;

  /**
   * AuditLogger to write records to. Defaults to the global singleton.
   * Override for per-tenant loggers or in tests.
   */
  auditLogger?: AuditLogger;

  /**
   * If true, policy violations are logged but not thrown — the tool runs anyway.
   * Useful during migration to warn before enforcing. Default: false.
   */
  auditOnly?: boolean;
}

export function withSecurity(opts: SecurityPluginOptions = {}): HarnessPlugin {
  const { policy, auditLogger = globalAudit, auditOnly = false } = opts;

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
                timestamp: Date.now(),
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
              timestamp: Date.now(),
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
              timestamp: Date.now(),
            });
            throw err;
          }
        },
      }));
    },
  };
}
