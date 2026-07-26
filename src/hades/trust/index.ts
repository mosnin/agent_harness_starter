/**
 * @module hades/trust
 *
 * The unified trust layer — the one gate every output this agent emits has
 * to pass, and the only place the repo's verification primitives are joined
 * into a single admission decision.
 *
 * The pieces, in dependency order:
 *
 *  1. **`./registry`** — the canonical verification shape every subsystem
 *     speaks (`TrustSubject`, `UniversalVerifier`, `UniversalVerdict`,
 *     `FusedVerification`) plus `VerifierRegistry`, which selects, runs
 *     (timeout- and throw-isolated), normalizes, and fuses verdicts through
 *     the REAL `WeakVerifierEnsemble`. Overclaimed tiers are clamped, the
 *     fused tier is always the WEAKEST contributing one, and every raw
 *     verifier return passes through one adversary-first choke point.
 *  2. **`./action-adapters` / `./emission-adapters`** — every verifier this
 *     build already ships, adapted (never re-implemented) into that shape:
 *     the ten real `toolVerifiers()`, the real `ProvenanceLedger` chain
 *     check, the real `verifyMemoryWrite`, the real `auditUserModel`, plus
 *     two new deterministic verifiers for the domains that had none
 *     (outbound-message certificate binding, procedure-run structure).
 *  3. **`./unified-gate`** — `UnifiedTrustGate`: registry fusion → the
 *     strong-tier-dissent veto → the per-domain split-conformal threshold →
 *     the tier confidence floor → the trust budget → a REAL ed25519
 *     certificate. Its central invariant is
 *     `accepted === (certificate !== undefined)`.
 *  4. **`./budget`** — `TrustBudgetLedger`: a durable, hash-chained,
 *     tamper-evident record of every unit of residual risk ever spent, which
 *     refuses to authorize further spending rather than silently resetting.
 *  5. **`./risk-eval`** — the silent-wrong-rate checkpoint: drives the real
 *     eval corpus through an injected admission port, grades with the tasks'
 *     own graders, and independently re-audits every certificate issued.
 *  6. **`./wiring`** — the central assembly (`openTrustStack`) every surface
 *     uses, so the CLI, the desktop sidecar and anything added later share
 *     one verifier set, one signing identity, one budget chain and one
 *     persisted calibration.
 *
 * Surfaces: `hades trust <status|verifiers|calibrate|admit|budget|riskeval|doctor>`
 * (`../cli/trust-command.ts`) and the desktop `trust.*` IPC lane
 * (`src/desktop/core/trust-service.ts`) — both driven by the same
 * `openTrustStack()` handles, never by re-implementations.
 */

// -- Spine ------------------------------------------------------------------
export {
  VerifierRegistry,
  subjectKey,
  canonicalTrace,
  normalizeVerdict,
} from "./registry";
export type {
  TrustDomain,
  TrustTraceStep,
  TrustSubject,
  UniversalVerdict,
  UniversalVerifier,
  FusedVerification,
  SelectionDiagnostic,
  VerifyOpts,
} from "./registry";

// -- Subsystem adapters -----------------------------------------------------
export {
  ACTION_ADAPTER_VERSION,
  EXEC_PROVENANCE_REASON_CODES,
  toolCallVerifiers,
  execProvenanceVerifier,
  execProvenanceCalibration,
  actionVerifiers,
} from "./action-adapters";
export {
  EMISSION_ADAPTER_VERSION,
  memoryWriteVerifier,
  userModelVerifier,
  outboundMessageVerifier,
  outboundMessageCalibration,
  procedureRunVerifier,
  procedureRunCalibration,
  emissionVerifiers,
} from "./emission-adapters";
export type { ProcedureStepProvenance } from "./emission-adapters";

// -- The gate ---------------------------------------------------------------
export { UnifiedTrustGate, formatTrustGateReport } from "./unified-gate";
export type {
  AbstentionCode,
  TrustBudgetPort,
  UnifiedGateConfig,
  Admission,
  TrustGateReport,
} from "./unified-gate";

// -- The budget -------------------------------------------------------------
export { TrustBudgetLedger, formatTrustBudgetReport, TRUST_BUDGET_GENESIS } from "./budget";
export type {
  TrustBudgetConfig,
  TrustBudgetEntry,
  TrustBudgetReport,
  ChainVerification,
} from "./budget";

// -- The checkpoint ---------------------------------------------------------
export { runRiskEval, formatRiskEvalReport, scriptedSolvers } from "./risk-eval";
export type {
  RiskEvalSubject,
  RiskEvalAdmission,
  AdmitFn,
  ScriptedSolver,
  RiskEvalOptions,
  RiskEvalReport,
} from "./risk-eval";

// -- Central wiring ---------------------------------------------------------
export {
  trustRoot,
  openTrustStack,
  resolveTrustSigningKey,
  TrustCalibrationStore,
  collectEvalCalibration,
  evalCalibrationSubject,
  summarizeDiscrimination,
  trustDomainStatuses,
  domainCertifiability,
  TRUST_DOMAINS,
  TRUST_BUDGET_FILE,
  TRUST_CALIBRATION_FILE,
  TRUST_KEY_FILE,
  DEFAULT_TRUST_EPSILON,
  DEFAULT_TRUST_TOTAL_RISK,
} from "./wiring";
export type {
  TrustStack,
  TrustStackOptions,
  TrustKeyResolution,
  DiscriminationSummary,
  EvalCalibrationResult,
  TrustDomainStatus,
  DomainCertifiability,
} from "./wiring";
