/**
 * @module hades/routing
 *
 * The budget-constrained, risk-controlled router — the layer that decides
 * WHICH model on WHICH provider does a given piece of work, learns which
 * choice actually produces verified output per dollar, and refuses to hand
 * back an answer whose silent-wrong risk it cannot bound.
 *
 * The pieces, in dependency order:
 *
 *  1. **`./arms`** — `ArmCatalog` / `ArmCostModel`: the routable arm space
 *     (provider x model x execution target) built from the REAL model
 *     registry and REAL published prices, plus a measured cost/latency
 *     predictor that is explicit about its own provenance (`measured` /
 *     `priced-prior` / `unpriced`). A model with no published price is
 *     reported `unpriced` — never as a free arm a cost-sensitive bandit
 *     would route everything to.
 *  2. **`./bandit`** — `BudgetedRouterBandit`: contextual Thompson sampling
 *     over a Beta posterior on P(verified), with a Lagrangian dual on a hard
 *     dollar budget. Fully seeded — no `Math.random`, no `Date.now`.
 *  3. **`./calibration`** — `PerVerifierCalibrator`: turns a raw verifier
 *     score into a calibrated P(correct) SPECIFIC to the (verifier, arm)
 *     pair, via real isotonic (PAVA) regression, and demotes a verifier that
 *     is degenerate or anti-correlated to its tier prior instead of
 *     laundering it into a confident-looking number.
 *  4. **`./risk`** — `ConformalRouteRisk`: a Mondrian split-conformal
 *     selective-risk gate over the shipped STYX `ConformalGate`, with an
 *     escalation ladder and a correlation-aware fan-out aggregator.
 *  5. **`./ledger`** — `RoutingLedger`: a SHA-256 hash-chained,
 *     tamper-evident record of every routing decision, reducible to honest
 *     per-arm V-TPH$ attribution (including `silentWrong`).
 *  6. **`./route-bench`** — `runRouteBench`: the phase checkpoint, driving
 *     the router and every fixed-provider baseline through the IDENTICAL
 *     REAL `runVtph`/`compareVtph` harness.
 *  7. **`./wiring`** — `openRouter()`, the central assembly every surface
 *     shares, rooted at `<dataDir>/routing`, plus `createRoutedRunner()`,
 *     the actual routed agent.
 *
 * Surfaces: `hades route <status|arms|explain|record|ledger|bench|doctor>`
 * (`../cli/route-command.ts`), the desktop `route.*` IPC lane
 * (`src/desktop/core/route-service.ts`) and the TUI ROUTE pane
 * (`src/swarm-runtime/tui/route-pane.ts`) — all three driven by the same
 * `openRouter()` handles, never by re-implementations.
 */

// -- Arm space & measured cost ----------------------------------------------
export { ArmCatalog, ArmCostModel, RoutingArmError, encodeArmId, parseArmId } from "./arms";
export type {
  ArmCatalogOptions,
  ArmCostModelOptions,
  ArmCostSnapshot,
  ArmRequirements,
  CostEstimate,
  EligibilityResult,
  RejectionCode,
  RoutingArm,
  TaskCostContext,
  UsageSample,
} from "./arms";

// -- Budgeted contextual bandit ---------------------------------------------
export { BudgetedRouterBandit, BanditStateError } from "./bandit";
export type {
  ArmPosterior,
  BanditOptions,
  BanditOutcome,
  BanditSnapshot,
  RoutingContext,
  Selection,
  SelectionReason,
} from "./bandit";

// -- Per-(verifier, arm) calibration ----------------------------------------
export { PerVerifierCalibrator, CalibrationError, isotonicFit } from "./calibration";
export type {
  CalibratedScore,
  CalibrationSource,
  CalibratorOptions,
  CalibratorSnapshot,
  EnsembleProbability,
  IsotonicFit,
  ScoredVote,
  SnapshotFitEntry,
  SnapshotObservation,
  VerifierObservation,
  VerifierQuality,
} from "./calibration";

// -- Conformal route risk & fan-out -----------------------------------------
export { ConformalRouteRisk, RouteRiskError } from "./risk";
export type {
  AbstainReason,
  ArmRiskProfile,
  EscalateReason,
  RiskCalibrationPoint,
  RouteDecisionInput,
  RouteRiskConfig,
  RouteVerdict,
  Stratum,
} from "./risk";
// NOTE: `FanOutResult` / `FanOutVerdict` are re-exported here under
// route-scoped aliases. `../parallel` already exports a *different*
// `FanOutResult` (a generic parallel-dispatch result) from the top-level
// `hades` barrel, and two `export *` sources providing the same name make
// that name AMBIGUOUS and silently dropped from the barrel — which would
// quietly break `import { FanOutResult } from "hades"` for the parallel
// subsystem. Import the unaliased names from `./risk` directly.
export type { FanOutResult as RouteFanOutResult, FanOutVerdict as RouteFanOutVerdict } from "./risk";

// -- Tamper-evident routing ledger ------------------------------------------
export { RoutingLedger, RoutingLedgerError, ROUTING_LEDGER_GENESIS, canonicalizeDecision } from "./ledger";
export type { ArmAttribution, ChainCheck, RoutingDecision, RoutingLedgerEntry } from "./ledger";

// -- Route bench (the phase checkpoint) -------------------------------------
export { runRouteBench, mixedEvalBatch } from "./route-bench";
export type {
  BenchProvenance,
  FixedBaseline,
  RouteBenchOptions,
  RouteBenchResult,
  RoutedRun,
  RouterLike,
} from "./route-bench";

// -- Central wiring ----------------------------------------------------------
export {
  openRouter,
  routerRoot,
  routerStatus,
  routerAttribution,
  recordRouteOutcome,
  createRoutedRunner,
  parseRiskPoints,
  DEFAULT_STATUS_CTX,
  ROUTER_BANDIT_FILE,
  ROUTER_CALIBRATION_FILE,
  ROUTER_COST_FILE,
  ROUTER_LEDGER_FILE,
  ROUTER_RISK_FILE,
} from "./wiring";
export type {
  RouteOutcomeRecord,
  RoutedRunnerOptions,
  RouterArmView,
  RouterStack,
  RouterStackOptions,
  RouterStatusOptions,
  RouterStatusView,
} from "./wiring";
