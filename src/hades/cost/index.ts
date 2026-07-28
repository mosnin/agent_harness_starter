/**
 * Measured cost accounting: what a run ACTUALLY cost, in tokens, dollars and
 * wall clock — and an explicit UNKNOWN wherever it cannot be known.
 *
 * - `./prices.ts`  — the per-model list-price table, its citations, and the
 *   discriminated `PricedCall` that makes an unpriced model impossible to add
 *   into a total as `$0`.
 * - `./meter.ts`   — `CostMeter`: token counts read off real provider `usage`
 *   blocks (absent usage is `null`, never 0), rolled into a `CostReport` that
 *   reports `complete: false` whenever any call contributed an unknown.
 * - `./journal.ts` — the append-only run journal `hades cost` reads back, with
 *   every aggregate RECOMPUTED from stored calls rather than trusted.
 *
 * @module hades/cost
 */

export {
  MODEL_PRICES,
  PRICE_TABLE_CAVEAT,
  PRICES_FILE_VAR,
  lookupPrice,
  priceCall,
  toPriceEntries,
  loadPriceTableFromEnv,
  type ModelPrice,
  type PriceLookup,
  type PricedCall,
  type LegacyPriceEntry,
  type PriceTableResolution,
} from "./prices";

export {
  CostMeter,
  summarizeCalls,
  emptyCostReport,
  formatCostReport,
  formatCostLine,
  formatUsd,
  formatMs,
  describeTokens,
  describeSpend,
  describeModelTokens,
  describeModelSpend,
  type MeteredCall,
  type CostReport,
  type ModelCostBreakdown,
} from "./meter";

export {
  appendRunCost,
  readRunCosts,
  recomputeRunReport,
  totalRunCosts,
  costJournalPath,
  type RunCostRecord,
  type RunCostHistory,
  type RunCostTotals,
} from "./journal";
