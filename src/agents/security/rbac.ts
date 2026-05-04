/**
 * Role-Based Access Control (RBAC) for agent tools.
 *
 * Maps user roles to sets of allowed tools. Integrates with the existing
 * AgentPolicy interface so it can be passed to withSecurity({ policy }).
 *
 * Usage:
 *   import { createRbacPolicy } from "@/agents/security/rbac";
 *
 *   const policy = createRbacPolicy({
 *     roles: {
 *       admin:    { allow: ["*"] },
 *       operator: { allow: ["web_search", "browser_scrape", "get_page"] },
 *       viewer:   { allow: ["get_page", "search_pages"] },
 *     },
 *     getUserRole: async (ctx) => ctx.userRole ?? "viewer",
 *     defaultRole: "viewer",
 *   });
 *
 *   // Use with withSecurity:
 *   const harness = createCustomHarness({
 *     plugins: [withSecurity({ policy })],
 *   });
 */

import type { AgentPolicy, PolicyCheckResult, PolicyContext } from "./policy";
import { PolicyViolationError } from "./policy";

export interface RbacRoleConfig {
  /** Allowed tool names. Use ["*"] to allow all tools. */
  allow: string[];
  /** Denied tool names. Deny takes precedence over allow. */
  deny?: string[];
}

export interface RbacConfig {
  /** Map of role name → tool access rules. */
  roles: Record<string, RbacRoleConfig>;
  /**
   * Async function that resolves the caller's role from context.
   * Return a role name from the roles map, or undefined to use defaultRole.
   */
  getUserRole: (ctx: PolicyContext) => string | undefined | Promise<string | undefined>;
  /** Fallback role when getUserRole returns undefined. Default: deny all. */
  defaultRole?: string;
  /** Optional policy name for audit logs. */
  name?: string;
}

/**
 * Create an RBAC policy that grants tool access based on user roles.
 * Implements the AgentPolicy interface — compatible with withSecurity({ policy }).
 */
export function createRbacPolicy(config: RbacConfig): AgentPolicy {
  const { roles, getUserRole, defaultRole, name = "rbac-policy" } = config;

  return {
    name,

    async check(toolName: string, ctx: PolicyContext = {}): Promise<PolicyCheckResult> {
      const resolvedRole = (await Promise.resolve(getUserRole(ctx))) ?? defaultRole;

      if (!resolvedRole || !roles[resolvedRole]) {
        return {
          allowed: false,
          reason: `No role resolved for context (tried defaultRole: "${defaultRole ?? "none"}"). Tool "${toolName}" denied.`,
        };
      }

      const roleConfig = roles[resolvedRole];
      const denySet = new Set(roleConfig.deny ?? []);

      if (denySet.has(toolName)) {
        return { allowed: false, reason: `Tool "${toolName}" is denied for role "${resolvedRole}".` };
      }

      if (roleConfig.allow.includes("*")) {
        return { allowed: true, reason: `Role "${resolvedRole}" has wildcard access.` };
      }

      if (roleConfig.allow.includes(toolName)) {
        return { allowed: true, reason: `Tool "${toolName}" is allowed for role "${resolvedRole}".` };
      }

      return {
        allowed: false,
        reason: `Tool "${toolName}" is not in the allow list for role "${resolvedRole}".`,
      };
    },

    async enforce(toolName: string, ctx: PolicyContext = {}): Promise<void> {
      const result = await this.check(toolName, ctx);
      if (!result.allowed) throw new PolicyViolationError(toolName, result.reason, name);
    },
  };
}
