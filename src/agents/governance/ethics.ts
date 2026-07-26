/**
 * Ethical constraints — fairness, privacy, harm prevention, and ethical
 * guardrails for agent behavior.
 *
 * Ethical constraints are a specific class of GovernanceRule that target:
 *   - Bias and fairness (disparate impact, discriminatory language)
 *   - Privacy (PII exposure in outputs, unauthorized data access)
 *   - Harm prevention (violent/dangerous content, self-harm, CSAM)
 *   - Deception (the agent claiming to be human, fabricating citations)
 *   - Autonomy overreach (the agent making decisions on behalf of humans
 *     without explicit authorization)
 *
 * Usage:
 *   import { createEthicsPolicy, STANDARD_ETHICS_RULES } from "@/agents/governance/ethics";
 *
 *   const ethics = createEthicsPolicy({
 *     rules: [...STANDARD_ETHICS_RULES, myCustomRule],
 *     onViolation: "block",
 *   });
 *
 *   const decision = await ethics.evaluate(ctx);
 */

import type { GovernanceRule, GovernanceContext, GovernanceDecision } from "./types";
import { createGovernancePolicy, evaluate, type GovernancePolicy } from "./policy";

// ── Ethics policy config ──────────────────────────────────────────────────────

export interface EthicsPolicyConfig {
  rules: GovernanceRule[];
  onViolation?: "block" | "escalate" | "flag";
}

export interface EthicsPolicy {
  evaluate(ctx: GovernanceContext): Promise<GovernanceDecision>;
  readonly policy: GovernancePolicy;
}

export function createEthicsPolicy(config: EthicsPolicyConfig): EthicsPolicy {
  const policy = createGovernancePolicy({
    name: "ethics",
    rules: config.rules,
    defaultOutcome: "allowed",
    onViolation: config.onViolation ?? "block",
  });

  return {
    policy,
    evaluate: (ctx) => evaluate(policy, ctx),
  };
}

// ── Built-in ethical guardrails ───────────────────────────────────────────────

/** Block outputs that claim the agent is human. */
export const noIdentityDeception: GovernanceRule = {
  id: "ethics:no-identity-deception",
  description: "Agent must not claim to be human or deny being an AI.",
  risk: "high",
  blocking: true,
  check: (ctx) => {
    if (!ctx.content) return false;
    const lower = ctx.content.toLowerCase();
    return (
      /i am (a|an)? ?(human|person|real person|not an? (ai|bot|machine|assistant))/i.test(lower) ||
      /i['']m not an? (ai|bot|artificial)/i.test(lower)
    );
  },
};

/** Block outputs containing potential PII patterns. */
export const noPiiInOutput: GovernanceRule = {
  id: "ethics:no-pii-in-output",
  description: "Agent must not expose PII in outputs.",
  risk: "high",
  blocking: true,
  check: (ctx) => {
    if (!ctx.content || ctx.action !== "output") return false;
    return (
      /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i.test(ctx.content) ||
      /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(ctx.content) ||
      /\b\d{3}-\d{2}-\d{4}\b/.test(ctx.content)
    );
  },
};

/** Block dangerous or harmful content categories. */
export const noHarmfulContent: GovernanceRule = {
  id: "ethics:no-harmful-content",
  description: "Agent must not produce content that promotes violence, self-harm, or illegal acts.",
  risk: "critical",
  blocking: true,
  check: (ctx) => {
    if (!ctx.content) return false;
    // These are simplified patterns; production implementations should use
    // a dedicated content moderation API or classifier model.
    const harmful = [
      /how to (make|build|create|synthesize) (a |an )?(bomb|weapon|explosive|poison)/i,
      /step.by.step (instructions|guide) (for|to) (harm|kill|attack)/i,
      /child (sexual|nude|naked|explicit)/i,
    ];
    return harmful.some((p) => p.test(ctx.content!));
  },
};

/** Flag (don't block) fabricated citations — strings that look like URLs/DOIs but weren't
 *  retrieved from a tool call. This is a warning; exact detection requires tool context. */
export const flagFabricatedCitations: GovernanceRule = {
  id: "ethics:flag-fabricated-citations",
  description: "Possible fabricated citation detected. Verify with source retrieval tools.",
  risk: "medium",
  blocking: false,
  check: (ctx) => {
    if (!ctx.content || ctx.action !== "output") return false;
    // Heuristic: citation-like patterns without any prior tool calls
    const hasCitation = /\b(doi:|https?:\/\/|arxiv\.org|pubmed)\S+/i.test(ctx.content);
    const noToolUsed = !ctx.metadata?.toolsUsed;
    return hasCitation && noToolUsed;
  },
};

/** Block outputs that make irreversible real-world commitments without explicit authorization. */
export const requireAuthorizationForCommitments: GovernanceRule = {
  id: "ethics:require-authorization-for-commitments",
  description: "Agent must not make irreversible commitments (purchases, contracts, deletions) without authorization.",
  risk: "critical",
  blocking: true,
  check: (ctx) => {
    const commitmentActions = new Set([
      "tool:send_email",
      "tool:submit_form",
      "tool:make_purchase",
      "tool:sign_contract",
      "tool:delete_record",
      "tool:publish_content",
    ]);
    const authorized = ctx.metadata?.humanAuthorized as boolean | undefined;
    return commitmentActions.has(ctx.action) && !authorized;
  },
};

/** Block discriminatory language targeting protected characteristics. */
export const noDiscriminatoryLanguage: GovernanceRule = {
  id: "ethics:no-discriminatory-language",
  description: "Agent must not produce discriminatory language targeting protected characteristics.",
  risk: "high",
  blocking: true,
  check: (ctx) => {
    if (!ctx.content) return false;
    // Simplified pattern — production: use a content-classifier model
    const discriminatory = [
      /\b(all|those|these) (blacks?|whites?|jews?|muslims?|gays?|lesbians?) (are|should|deserve|must)/i,
    ];
    return discriminatory.some((p) => p.test(ctx.content!));
  },
};

// ── Standard ethics rule set ──────────────────────────────────────────────────

/** The default set of ethical rules. Extend with domain-specific rules. */
export const STANDARD_ETHICS_RULES: GovernanceRule[] = [
  noHarmfulContent,
  noIdentityDeception,
  noPiiInOutput,
  noDiscriminatoryLanguage,
  requireAuthorizationForCommitments,
  flagFabricatedCitations,
];

/** Pre-built standard ethics policy using all standard rules. */
export const STANDARD_ETHICS_POLICY = createEthicsPolicy({
  rules: STANDARD_ETHICS_RULES,
  onViolation: "block",
});
