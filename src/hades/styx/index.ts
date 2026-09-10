/**
 * @module hades/styx
 *
 * STYX — a provenance-carrying, abstention-by-default, verifier-guided
 * speculative swarm. See docs/STYX_ARCHITECTURE.md.
 *
 * S1 (trust kernel), all keyless and adversarially verified:
 *  - gate: conformal abstention — a distribution-free P(silent-wrong) <= epsilon.
 *  - certificate: ed25519 proof-carrying agent output.
 *  - tiers: verifier-tier router + label-free (Dawid-Skene) weak-verifier ensemble.
 */
export { ConformalGate, conformalThreshold } from "./gate";
export type { CalibrationPoint, GateConfig, GateDecision, GateStats } from "./gate";
export {
  CertificateAuthority,
  verifyCertificate,
  certifiesOutput,
  sha256Hex,
  canonicalize,
  generatePrivateKeyHex,
} from "./certificate";
export type { CertificatePayload, VerificationCertificate } from "./certificate";
export { routeTier, tierConfidenceFloor, WeakVerifierEnsemble } from "./tiers";
export type { TierId, TaskSignals, VerifierVote, EnsembleResult } from "./tiers";
export { BranchTree } from "./branches";
export type { BranchState, BranchNode, BranchTreeStats } from "./branches";
export { BanditController } from "./controller";
export type { WorkerOracle, ControllerOptions, ControllerReport } from "./controller";
export {
  checkRobustness,
  whitespaceJitter,
  caseFlip,
  synonymSwap,
  numberRename,
  verifierRotation,
} from "./perturb";
export type { Perturbation, Solver, RobustnessReport, RotationReport } from "./perturb";
export { StyxOrchestrator } from "./orchestrator";
export type {
  StyxTask,
  Speculator,
  Worker,
  VerifierPanel,
  StyxConfig,
  StyxOutcome,
} from "./orchestrator";
export { styxRunner } from "./runner";
export type { StyxRunnerOptions } from "./runner";
export { settlementPayment, VerifiedWorkMarket } from "./market";
export type { WorkBid, SettlementRule, LedgerEntry, MarketStats, WorkResult, WorkExecutor } from "./market";
