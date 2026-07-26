/**
 * @module hades/gov
 *
 * The governance layer: who this agent IS (ed25519 identity + a sealed,
 * rotatable keystore), what it is ALLOWED to do (attenuable macaroon-style
 * capability tokens + a signed, fail-closed policy engine), what it DID
 * (a tamper-evident hash-chained audit log with Merkle inclusion/consistency
 * proofs and signed checkpoints), and how to run it with the network
 * genuinely cut (a real air-gap over this process's actual egress seams).
 *
 * Everything here is real cryptography over real bytes on disk. No module in
 * this directory returns a constant "ok" — every verdict is recomputed from
 * the artifact it claims to describe.
 *
 * Explicit named re-exports (not `export *`): several modules in this
 * directory legitimately re-export a sibling's symbol (policy.ts re-exports
 * capability.ts's request/decision types, airgap-run.ts re-exports
 * AirgapViolationError, keystore.ts re-exports agentIdFromPublicKey), so a
 * star barrel would be ambiguous. Each symbol below has exactly one home.
 */

// --- identity ---------------------------------------------------------------
export {
  govCanonicalize,
  govDigest,
  signGov,
  verifyGovSignature,
  agentIdFromPublicKey,
  isSignedIdentityDocShape,
  GovIdentity,
  verifyIdentityChain,
  isSignedRotationRecordShape,
  signRotation,
  verifyRotationHistory,
} from "./identity";
export type {
  AgentIdentityDoc,
  SignedIdentityDoc,
  IdentityFailureCode,
  IdentityFailure,
  IdentityChainVerification,
  RotationRecord,
  SignedRotationRecord,
} from "./identity";

// --- keystore ---------------------------------------------------------------
export { GOV_DIR, govRoot, GovKeystore } from "./keystore";
export type { KeystoreOptions, IdentitySource, LoadedIdentity } from "./keystore";

// --- capability tokens ------------------------------------------------------
export { resourceMatches, isAttenuation, CapabilityIssuer, CapabilityEnforcer, toLegacyCapabilityToken } from "./capability";
export type {
  CapabilityGrant,
  CapabilityCaveat,
  GovCapabilityToken,
  CapabilityRequest,
  CapabilityDenyCode,
  CapabilityDecision,
  CapabilityIssuerOptions,
  CapabilityEnforcerOptions,
} from "./capability";

// --- replay defence ---------------------------------------------------------
export { MemoryReplayGuard, DurableReplayGuard } from "./replay-guard";
export type { ReplayGuard, UseCounter, DurableReplayGuardOptions } from "./replay-guard";

// --- audit chain ------------------------------------------------------------
export { GOV_AUDIT_SCHEMA, GOV_AUDIT_GENESIS, GovAuditChain, fromLegacyAuditEvent } from "./audit-chain";
export type { AuditOutcome, GovAuditEntry, AppendInput, AuditFailureCode, AuditFailure, AuditVerification } from "./audit-chain";

// --- Merkle proofs + signed checkpoints -------------------------------------
export {
  leafHash,
  nodeHash,
  merkleRoot,
  inclusionProof,
  verifyInclusion,
  consistencyProof,
  verifyConsistency,
  signCheckpoint,
  verifyCheckpoint,
} from "./audit-proof";
export type { InclusionProof, ConsistencyProof, SignedCheckpoint } from "./audit-proof";

// --- policy -----------------------------------------------------------------
export { PolicyEngine, parsePolicyDocument, DEFAULT_GOV_POLICY } from "./policy";
export type {
  PolicyEffect,
  PolicyCondition,
  PolicyObligation,
  PolicyRule,
  PolicyDocument,
  PolicyRequest,
  PolicyTraceStep,
  PolicyDecision,
  PolicyAuditSink,
  PolicyLintFinding,
} from "./policy";
export { PolicyStore } from "./policy-store";
export type { SignedPolicyBundle, PolicyLoadStatus, PolicyLoadResult } from "./policy-store";

// --- air-gap ----------------------------------------------------------------
export { ALL_EGRESS_SEAMS, AirgapViolationError, engageAirgap, withAirgap, probeAirgap, activeAirgapSessions } from "./airgap";
export type { EgressSeam, AirgapPolicy, EgressAttempt, SeamStatus, AirgapReport, AirgapSession, AirgapTarget } from "./airgap";
export { runAirgappedTask, formatAirgapRunReport } from "./airgap-run";
export type { AirgappedRunOptions, AirgappedTaskContext, AirgappedRunResult } from "./airgap-run";
