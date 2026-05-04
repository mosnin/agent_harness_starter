export { createRouter, defaultRouter } from "./router";
export type { RouterConfig, RouterSignals, ModelPlan, EscalateRules, ContextTier } from "./router";

export {
  exactCacheKey,
  semanticCacheKey,
  toolCacheKey,
  TTL,
  InMemoryCache,
  RedisCache,
  createCacheManager,
  defaultCache,
} from "./cache";
export type { CacheAdapter, CacheSetOptions, CacheManager, RedisClient } from "./cache";

export {
  CONTEXT_BUDGETS,
  estimateTokens,
  trimChunks,
  truncateHistory,
  trimSystemPrompt,
  buildContext,
} from "./context-budget";
export type { ContextBudgetConfig, RetrievalChunk, Message, BuiltContext } from "./context-budget";
