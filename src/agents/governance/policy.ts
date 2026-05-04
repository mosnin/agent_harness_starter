/**
 * Governance policy — overarching rules, constraints, and safety protocols
 * that enforce consistent and safe agent behavior across the system.
 *
 * A GovernancePolicy is a named collection of GovernanceRules evaluated
 * in priority order. Rules can block actions, escalate them, flag them
 * for review, or let them through.
 *
 * Usage:
 *   import { createGovernancePolicy, evaluate } from "@/agents/governance/policy";
 *
 *   const policy = createGovernancePolicy({
 *     name: "production",
 *     rules: [noShellExec, requireConfirmationForDelete, blockPiiOutput],
 *     defaultOutcome: "allowed",
 *     onViolation: "block",
 *   });
 *
 *   const decision = await evaluate(policy, ctx);
 *   if (decision.outcome === "blocked") throw new PolicyViolationError(decision.reason);
 */

import type {
  GovernanceRule,
  GovernanceContext,
  GovernanceDecision,
  GovernanceOutcome,
  RiskLevel,
} from "./types";
import { GovernanceError } from "../errors";

// ── Policy config ─────────────────────────────────────────────────────────────

export interface GovernancePolicyConfig {
  /** Unique policy name. */
  name: string;
  /** Rules evaluated in order. First blocking match wins. */
  rules: GovernanceRule[];
  /** What happens when no rule fires. Default: "allowed". */
  defaultOutcome?: GovernanceOutcome;
  /** Global override: what to do when any rule is violated. Default: per-rule. */
  onViolation?: "block" | "escalate" | "flag" | "allow";
  /** Risk level to assign when the default outcome applies. Default: "low". */
  defaultRisk?: RiskLevel;
}

export interface GovernancePolicy {
  readonly name: string;
  readonly rules: GovernanceRule[];
  readonly config: Required<GovernancePolicyConfig>;
}

// ── Policy violation error ────────────────────────────────────────────────────

export class GovernancePolicyViolationError extends GovernanceError {
  readonly decision: GovernanceDecision;
  constructor(decision: GovernanceDecision) {
    super(`Governance policy violation [${decision.ruleId ?? "unknown"}]: ${decision.reason}`);
    this.name = "GovernancePolicyViolationError";
    this.decision = decision;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createGovernancePolicy(config: GovernancePolicyConfig): GovernancePolicy {
  return {
    name: config.name,
    rules: config.rules,
    config: {
      name: config.name,
      rules: config.rules,
      defaultOutcome: config.defaultOutcome ?? "allowed",
      onViolation: config.onViolation ?? "block",
      defaultRisk: config.defaultRisk ?? "low",
    },
  };
}

// ── Evaluator ─────────────────────────────────────────────────────────────────

/**
 * Evaluate a governance context against a policy.
 * Runs rules in order and returns the first non-allowed decision,
 * or an "allowed" decision if no rule fires.
 */
export async function evaluate(
  policy: GovernancePolicy,
  ctx: GovernanceContext
): Promise<GovernanceDecision> {
  const now = Date.now();

  for (const rule of policy.rules) {
    const violated = await rule.check(ctx);
    if (!violated) continue;

    const overrideOutcome = policy.config.onViolation;
    let outcome: GovernanceOutcome;

    if (overrideOutcome !== "allow") {
      outcome = overrideOutcome === "block"
        ? "blocked"
        : overrideOutcome === "escalate"
        ? "escalated"
        : "flagged";
    } else {
      outcome = rule.blocking === false ? "flagged" : "blocked";
    }

    return {
      outcome,
      ruleId: rule.id,
      risk: rule.risk,
      reason: rule.description,
      timestamp: now,
    };
  }

  return {
    outcome: policy.config.defaultOutcome,
    risk: policy.config.defaultRisk,
    reason: "No rules triggered.",
    timestamp: now,
  };
}

// ── Rule builders ─────────────────────────────────────────────────────────────

/** Block specific tool names. */
export function blockTools(toolNames: string[]): GovernanceRule {
  const set = new Set(toolNames);
  return {
    id: `block-tools:${toolNames.join(",")}`,
    description: `Tool use blocked: ${toolNames.join(", ")}`,
    risk: "high",
    blocking: true,
    check: (ctx) => ctx.action.startsWith("tool:") && set.has(ctx.action.slice(5)),
  };
}

/** Require a list of patterns to NOT appear in content. */
export function blockContentPatterns(
  id: string,
  patterns: RegExp[],
  risk: RiskLevel = "high"
): GovernanceRule {
  return {
    id,
    description: `Content contains blocked pattern (rule: ${id})`,
    risk,
    blocking: true,
    check: (ctx) => {
      if (!ctx.content) return false;
      return patterns.some((p) => p.test(ctx.content!));
    },
  };
}

/** Flag actions targeting specific agent IDs (e.g. privilege escalation). */
export function restrictAgentTargets(allowedAgentIds: string[]): GovernanceRule {
  const set = new Set(allowedAgentIds);
  return {
    id: "restrict-agent-targets",
    description: `Action targets an unauthorized agent`,
    risk: "high",
    blocking: true,
    check: (ctx) => {
      const target = ctx.metadata?.targetAgentId as string | undefined;
      return !!target && !set.has(target);
    },
  };
}

/** Rate-limit rule: fire if a counter in metadata exceeds threshold. */
export function rateLimit(
  id: string,
  maxCount: number,
  windowLabel: string
): GovernanceRule {
  return {
    id: `rate-limit:${id}`,
    description: `Rate limit exceeded: more than ${maxCount} actions per ${windowLabel}`,
    risk: "medium",
    blocking: false,
    check: (ctx) => {
      const count = ctx.metadata?.actionCount as number | undefined;
      return count !== undefined && count > maxCount;
    },
  };
}

// ── Default system-wide policy ────────────────────────────────────────────────

/** A minimal default policy: only blocks the most dangerous tool classes. */
export const DEFAULT_GOVERNANCE_POLICY = createGovernancePolicy({
  name: "default",
  defaultOutcome: "allowed",
  onViolation: "block",
  rules: [
    blockTools(["rm_rf", "drop_database", "format_disk"]),
    blockContentPatterns("no-secrets-in-output", [
      /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/,
      /sk-[a-zA-Z0-9]{20,}/,      // OpenAI-style API keys
      /AKIA[0-9A-Z]{16}/,          // AWS access key IDs
    ]),
  ],
});
