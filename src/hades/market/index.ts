/**
 * @module hades/market
 *
 * The verified-work market — where a cryptographic verification certificate
 * stops being a badge and starts being money.
 *
 * The pieces, in dependency order:
 *
 *  1. **`./reputation`** — `ReputationLedger`: a hash-chained, tamper-evident
 *     record of (forecast, outcome) events per participant, scored with a
 *     Murphy-decomposed Brier skill score, exponential time decay,
 *     difficulty weighting and population-prior shrinkage. Any adjudged
 *     fabrication forces the score to a hard, unamortizable zero.
 *  2. **`./claims`** — `ClaimAdjudicator`: re-derives, from the REAL ed25519
 *     crypto in `../styx/certificate`, whether a claim of verified work is
 *     actually true. No certificate = honest abstention; a certificate that
 *     fails any binding check = fabrication, scored exactly 0.
 *  3. **`./economy`** — `Economy`: escrow, the REAL `settlementPayment`
 *     Brier rule, slashing, treasury conservation and a hysteresis-guarded
 *     `active -> probation -> demoted -> banned` standing machine.
 *  4. **`./exchange`** — `WorkExchange`: a trust-gated, second-price order
 *     book that ranks offers by REPUTATION-ADJUSTED expected verified value
 *     per dollar, closing the selection-stage bluster gap that
 *     `../styx/market.ts` documents but does not fix.
 *  5. **`./convergence`** — a labelled SIMULATION (never live numbers) that
 *     drives a seeded cohort through the real engine and measures whether
 *     rank order converges on true reliability.
 *  6. **`./wiring`** — `openMarket()`, the central assembly every surface
 *     shares, rooted at `<dataDir>/market` and trusting the SAME ed25519
 *     identity the unified trust gate signs with.
 *
 * Surfaces: `hades market <status|reputation|book|clear|explain|simulate|doctor>`
 * (`../cli/market-command.ts`), the desktop `market.*` IPC lane
 * (`src/desktop/core/market-service.ts`) and the TUI MARKET pane
 * (`src/swarm-runtime/tui/market-pane.ts`) — all three driven by the same
 * `openMarket()` handles, never by re-implementations.
 */

// -- Reputation --------------------------------------------------------------
export {
  ReputationLedger,
  ReputationValidationError,
  REPUTATION_GENESIS,
  REPUTATION_UNCERTAINTY_EPS,
  brierDecomposition,
  reputationScore,
} from "./reputation";
// NOTE: `wilsonLowerBound` is deliberately NOT re-exported here. `../skills`
// already exports a function of that exact name from the top-level `hades`
// barrel, and shadowing it would make `import { wilsonLowerBound } from
// "hades"` silently resolve to a different subsystem's implementation.
// Import it from `./reputation` directly when you want this one.
export type {
  BrierDecomposition,
  CalibrationBin,
  ParticipantId,
  ParticipantKind,
  ReputationEvent,
  ReputationLedgerEntry,
  ReputationLedgerOptions,
  ReputationState,
  Standing,
} from "./reputation";

// -- Claims ------------------------------------------------------------------
export { ClaimAdjudicator, defaultClaimPolicy, ALL_CLAIM_REJECTION_CODES } from "./claims";
export type {
  ClaimAdjudication,
  ClaimPolicy,
  ClaimRejectionCode,
  ClaimStatus,
  VerifiedClaim,
} from "./claims";

// -- Economy -----------------------------------------------------------------
export { Economy, EconomyError, defaultEconomyPolicy } from "./economy";
export type {
  AwardRecord,
  AwardRequest,
  EconomyErrorCode,
  EconomyPolicy,
  ParticipantAccount,
  SettlementRecord,
  TaskPosting,
} from "./economy";

// -- Exchange ----------------------------------------------------------------
export { WorkExchange, shrinkClaim, expectedVerifiedValue } from "./exchange";
export type {
  Capability,
  ExchangeResult,
  Match,
  NoMatchReason,
  OfferRejectionCode,
  ShrinkageOptions,
  TaskOrder,
  WorkOffer,
} from "./exchange";

// -- Convergence (a labelled MODEL, never live numbers) ----------------------
export {
  runMarketConvergence,
  formatMarketConvergenceReport,
  defaultCohort,
  spearmanRho,
  splitmix32,
  MarketConvergenceError,
  MODEL_LABEL,
} from "./convergence";
export type {
  Archetype,
  CohortSpec,
  MarketConvergenceOptions,
  MarketConvergenceReport,
  MarketConvergenceErrorCode,
  ParticipantConvergence,
} from "./convergence";

// -- Central wiring ----------------------------------------------------------
export {
  openMarket,
  marketRoot,
  marketStatus,
  marketTiers,
  resolveMarketIssuer,
  MARKET_ECONOMY_FILE,
  MARKET_REPLAY_FILE,
  MARKET_REPUTATION_FILE,
} from "./wiring";
export type {
  MarketParticipantView,
  MarketStack,
  MarketStackOptions,
  MarketStatusView,
} from "./wiring";
