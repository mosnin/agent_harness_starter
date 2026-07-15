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
