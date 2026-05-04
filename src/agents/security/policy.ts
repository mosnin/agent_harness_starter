/**
 * NHI/IAM Policy engine — default-deny tool access control for agents.
 *
 * Every tool call is checked against an explicit allowlist. If no policy is
 * configured, ALL tool calls are blocked (default-deny). This prevents an
 * agent from gaining capabilities beyond what was explicitly granted for the
 * current task.
 *
 * Policies can be:
 *   - Static: a fixed allow/deny list defined at config time
 *   - Dynamic: a function that receives call context and returns allow/deny
 *   - Scoped: bound to a specific userId, orgId, or runId
 *
 * Usage:
 *   const policy = createPolicy({
 *     allow: ["web_search", "browser_scrape"],
 *     deny: ["shell_exec", "file_write"],
 *   });
 *   const result = policy.check("web_search", { userId: "u1" });
 *   if (!result.allowed) throw new PolicyViolationError(result.reason);
 */

export interface PolicyContext {
  userId?: string;
  orgId?: string;
  runId?: string;
  toolInput?: unknown;
  [key: string]: unknown;
}

export interface PolicyCheckResult {
  allowed: boolean;
  reason: string;
}

export type DynamicRule = (
  toolName: string,
  ctx: PolicyContext
) => boolean | Promise<boolean>;

export interface PolicyConfig {
  /**
   * Explicit tool names allowed to execute.
   * Glob patterns are NOT supported — use exact names for predictability.
   * If omitted and no dynamic rules match, defaults to deny.
   */
  allow?: string[];

  /**
   * Tool names that are never allowed, even if they appear in allow.
   * Deny takes precedence over allow.
   */
  deny?: string[];

  /**
   * Dynamic rules evaluated in order. First match wins.
   * Return true to allow, false to deny.
   */
  rules?: DynamicRule[];

  /**
   * What to do when no rule matches and the tool is not in allow/deny.
   * "deny" (default) or "allow".
   */
  defaultAction?: "allow" | "deny";

  /** Optional label for logging/audit. */
  name?: string;

  /** Optional: called on every check with the result. Use for audit logging. */
  auditSink?: (toolName: string, result: PolicyCheckResult, ctx: PolicyContext) => void;
}

import { SecurityError } from "../errors";
import { AuditLogger, type AuditAdapter } from "./audit";

export class PolicyViolationError extends SecurityError {
  constructor(
    public readonly toolName: string,
    public readonly reason: string,
    public readonly policyName?: string
  ) {
    super(`Policy violation: tool "${toolName}" blocked. ${reason}`);
    this.name = "PolicyViolationError";
  }
}

// ── Policy object ─────────────────────────────────────────────────────────────

export interface AgentPolicy {
  readonly name: string;
  check(toolName: string, ctx?: PolicyContext): Promise<PolicyCheckResult>;
  /** Convenience: throw PolicyViolationError if not allowed. */
  enforce(toolName: string, ctx?: PolicyContext): Promise<void>;
}

export function createPolicy(config: PolicyConfig): AgentPolicy {
  const {
    allow = [],
    deny = [],
    rules = [],
    defaultAction = "deny",
    name = "policy",
  } = config;

  const allowSet = new Set(allow);
  const denySet = new Set(deny);

  return {
    name,

    async check(toolName: string, ctx: PolicyContext = {}): Promise<PolicyCheckResult> {
      let result: PolicyCheckResult;

      // Deny list is absolute
      if (denySet.has(toolName)) {
        result = { allowed: false, reason: `Tool "${toolName}" is on the deny list.` };
      }

      // Explicit allow list
      else if (allowSet.has(toolName)) {
        result = { allowed: true, reason: "Tool is on the allow list." };
      }

      else {
        // Dynamic rules (first match wins)
        let matched: PolicyCheckResult | undefined;
        for (const rule of rules) {
          const ruleResult = await Promise.resolve(rule(toolName, ctx));
          if (ruleResult === true) { matched = { allowed: true, reason: "Matched a dynamic allow rule." }; break; }
          if (ruleResult === false) { matched = { allowed: false, reason: "Matched a dynamic deny rule." }; break; }
        }

        if (matched !== undefined) {
          result = matched;
        } else if (defaultAction === "allow") {
          result = { allowed: true, reason: "Default action is allow." };
        } else {
          result = {
            allowed: false,
            reason: `Tool "${toolName}" is not on the allow list (default-deny).`,
          };
        }
      }

      config.auditSink?.(toolName, result, ctx);
      return result;
    },

    async enforce(toolName: string, ctx: PolicyContext = {}): Promise<void> {
      const result = await this.check(toolName, ctx);
      if (!result.allowed) throw new PolicyViolationError(toolName, result.reason, name);
    },
  };
}

/**
 * Wrap a HarnessPlugin's wrapTools with policy enforcement.
 * Any tool call that isn't allowed by the policy throws PolicyViolationError,
 * which surfaces as an error event to the caller.
 */
export function applyPolicyToTools(
  tools: import("../tools/types").ToolDefinition[],
  policy: AgentPolicy,
  policyCtx: PolicyContext
): import("../tools/types").ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input: unknown, ctx: import("../tools/types").ToolContext) => {
      await policy.enforce(tool.name, { ...policyCtx, toolInput: input });
      return tool.execute(input, ctx);
    },
  }));
}

/** Minimal default-deny policy — blocks everything. Useful as a safe base. */
export const DEFAULT_DENY_POLICY = createPolicy({ defaultAction: "deny", name: "default-deny" });

/**
 * Create a policy pre-wired to the AuditLogger.
 * Every allow/deny decision is logged to the provided adapter.
 */
export function createAuditedPolicy(
  config: PolicyConfig,
  auditAdapter: AuditAdapter
): AgentPolicy {
  const logger = new AuditLogger(auditAdapter);
  return createPolicy({
    ...config,
    auditSink: (toolName, result, ctx) => {
      if (result.allowed) {
        logger.logAllowed({
          runId: ctx.runId ?? "",
          agentName: config.name ?? "policy",
          toolName,
          userId: ctx.userId,
          policyName: config.name,
          reason: result.reason,
        });
      } else {
        logger.logBlocked(
          {
            runId: ctx.runId ?? "",
            agentName: config.name ?? "policy",
            toolName,
            userId: ctx.userId,
          },
          config.name ?? "policy",
          result.reason
        );
      }
    },
  });
}
