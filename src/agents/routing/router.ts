/**
 * Model router — selects the cheapest model that can handle a given request.
 *
 * Routes 90% of calls through a small cheap model; escalates to a larger model
 * only on hard signals: low retrieval coverage, short context, novel entities,
 * or explicit budget override.
 *
 * Cost-impact order (per the playbook):
 *   1. Routing + tiny-context  →  30–60% cost reduction
 *   2. Semantic caching        →  10–40%
 *   3. Cheaper draft + re-rank →  15–35%
 *
 * Usage:
 *   const plan = selectModel({ message, retrievalCoverage: 0.8 });
 *   const harness = createCoreHarness({ ...agentConfig, model: plan.model });
 */

export type ContextTier = "small" | "medium" | "large";

export interface ModelPlan {
  /** Resolved model ID to pass to the harness. */
  model: string;
  /** Context window budget in tokens. */
  contextBudget: number;
  /** Context tier label for logging. */
  tier: ContextTier;
  /** Retrieval k to use. */
  retrievalK: number;
  /** Which summary embedding size to prefer for retrieval. */
  summarySizePreference: 128 | 512;
  /** Escalation rules for this plan. */
  escalateRules: EscalateRules;
}

export interface EscalateRules {
  minRetrievalCoverage: number;
  minSelfScore: number;
  maxRetryWithinSeconds: number;
}

export interface RouterSignals {
  /** The user's message (used for length-based routing). */
  message: string;
  /** Retrieval coverage score 0–1 from the vector store. Default: 1.0. */
  retrievalCoverage?: number;
  /** Self-score from a previous draft pass. Default: 1.0. */
  selfScore?: number;
  /** Whether the message contains entities not seen before. Default: false. */
  novelEntities?: boolean;
  /** Hard override: skip cheap model and go straight to large. Default: false. */
  forceLarge?: boolean;
  /** Remaining latency budget in ms (if set, may downgrade model). */
  latencyBudgetMs?: number;
}

export interface RouterConfig {
  /** Model ID for the cheap / small tier. Default: ROUTER_SMALL_MODEL or "claude-haiku-4-5-20251001". */
  smallModel?: string;
  /** Model ID for the medium tier. Default: ROUTER_MEDIUM_MODEL or "claude-sonnet-4-6". */
  mediumModel?: string;
  /** Model ID for the large / best tier. Default: ROUTER_LARGE_MODEL or "claude-opus-4-7". */
  largeModel?: string;
  /** Minimum retrieval coverage before escalating to medium. Default: 0.6. */
  coverageThreshold?: number;
  /** Minimum self-score before escalating. Default: 0.75. */
  selfScoreThreshold?: number;
  /** Message character length above which medium is preferred. Default: 2000. */
  mediumLengthThreshold?: number;
  /** Message character length above which large is preferred. Default: 6000. */
  largeLengthThreshold?: number;
}

const DEFAULT_ESCALATE: EscalateRules = {
  minRetrievalCoverage: 0.6,
  minSelfScore: 0.75,
  maxRetryWithinSeconds: 60,
};

const CONTEXT_BUDGETS: Record<ContextTier, number> = {
  small: 1024,
  medium: 4096,
  large: 16384,
};

const RETRIEVAL_K: Record<ContextTier, number> = {
  small: 3,
  medium: 4,
  large: 6,
};

export function createRouter(config: RouterConfig = {}) {
  const {
    smallModel = process.env.ROUTER_SMALL_MODEL ?? "claude-haiku-4-5-20251001",
    mediumModel = process.env.ROUTER_MEDIUM_MODEL ?? "claude-sonnet-4-6",
    largeModel = process.env.ROUTER_LARGE_MODEL ?? "claude-opus-4-7",
    coverageThreshold = 0.6,
    selfScoreThreshold = 0.75,
    mediumLengthThreshold = 2000,
    largeLengthThreshold = 6000,
  } = config;

  function selectTier(signals: RouterSignals): ContextTier {
    if (signals.forceLarge) return "large";

    const coverage = signals.retrievalCoverage ?? 1.0;
    const selfScore = signals.selfScore ?? 1.0;
    const msgLen = signals.message.length;

    // Hard escalation signals
    if (
      coverage < coverageThreshold ||
      selfScore < selfScoreThreshold ||
      signals.novelEntities === true ||
      msgLen > largeLengthThreshold
    ) {
      return "large";
    }

    if (msgLen > mediumLengthThreshold) return "medium";

    return "small";
  }

  function tierToModel(tier: ContextTier): string {
    switch (tier) {
      case "large": return largeModel;
      case "medium": return mediumModel;
      default: return smallModel;
    }
  }

  return {
    /**
     * Select a ModelPlan for the given signals.
     * Returns a plan with the chosen model, context budget, k, and escalation rules.
     */
    select(signals: RouterSignals): ModelPlan {
      const tier = selectTier(signals);
      return {
        model: tierToModel(tier),
        contextBudget: CONTEXT_BUDGETS[tier],
        tier,
        retrievalK: RETRIEVAL_K[tier],
        summarySizePreference: tier === "small" ? 128 : 512,
        escalateRules: {
          minRetrievalCoverage: coverageThreshold,
          minSelfScore: selfScoreThreshold,
          maxRetryWithinSeconds: 60,
        },
      };
    },

    /** Upgrade a plan to the next tier. Returns null if already at large. */
    escalate(plan: ModelPlan): ModelPlan | null {
      const next: Record<ContextTier, ContextTier | null> = {
        small: "medium",
        medium: "large",
        large: null,
      };
      const nextTier = next[plan.tier];
      if (!nextTier) return null;
      return {
        model: tierToModel(nextTier),
        contextBudget: CONTEXT_BUDGETS[nextTier],
        tier: nextTier,
        retrievalK: RETRIEVAL_K[nextTier],
        summarySizePreference: 512,
        escalateRules: DEFAULT_ESCALATE,
      };
    },

    smallModel,
    mediumModel,
    largeModel,
  };
}

/** Default router using environment-configured models. */
export const defaultRouter = createRouter();
