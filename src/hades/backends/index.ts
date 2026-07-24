export { RemoteBackendRegistry } from "./backend";
export type {
  RemoteBackend,
  RemoteSpec,
  RemoteHandle,
  RemoteState,
  ProvisionResult,
} from "./backend";
export { FakeBackend } from "./fake-backend";
export type { FakeBackendOptions } from "./fake-backend";
export { SshBackend, createSshCliTransport } from "./ssh";
export type { SshTransport, SshBackendOptions, ExecResult } from "./ssh";
export { ModalBackend } from "./modal";
export type {
  ModalClient,
  ModalCall,
  ModalCallStatus,
  ModalSpawnInput,
  ModalBackendOptions,
} from "./modal";
export { DaytonaBackend } from "./daytona";
export type {
  DaytonaClient,
  DaytonaWorkspace,
  DaytonaState,
  DaytonaCreateInput,
  DaytonaBackendOptions,
} from "./daytona";
export { SingularityBackend } from "./singularity";
export type { CommandRunner, SingularityBackendOptions } from "./singularity";
export { ScaleToZeroManager } from "./scale-to-zero";
export type { ScaleToZeroOptions, ScaleEvent } from "./scale-to-zero";
export { LocalProcessBackend } from "./local";
export type { LocalChild, SpawnFn, LocalBackendOptions } from "./local";
export { DockerBackend } from "./docker";
export type { DockerBackendOptions } from "./docker";
export { ZERO_TELEMETRY, matchesRequirements, scoreBackend, compareCandidates } from "./descriptor";
export type {
  BackendKind,
  BackendCostModel,
  BackendDescriptor,
  BackendRequirements,
  BackendTelemetrySnapshot,
} from "./descriptor";
export { BackendManager } from "./manager";
export type { BackendManagerOptions, BackendManagerEvent } from "./manager";
export {
  LIFECYCLE_TRANSITIONS,
  ALL_LIFECYCLE_STATES,
  canTransition,
  TransitionError,
  WakeExhaustedError,
  LifecycleMachine,
} from "./lifecycle";
export type { LifecycleState, LifecycleEvent, LifecycleMachineOptions } from "./lifecycle";
export { HANDLE_STORE_VERSION, HandleStore } from "./handle-store";
export type { HandleStoreFs, PersistedFleet, HandleStoreOptions, ReconcileReport } from "./handle-store";
export {
  BACKEND_TRACE_ROOT_PREIMAGE,
  canonicalRecordBytes,
  BackendProvenanceLedger,
  ledgerEventSink,
} from "./provenance";
export type {
  BackendEventType,
  BackendLifecycleRecord,
  BackendChainVerifyResult,
  BackendCertificateFields,
} from "./provenance";
export { backendsFleetVerifier, backendsFleetCalibration } from "./verifier";
export type { BackendFleetReport } from "./verifier";
export { runParityBench, runParityBenchDetailed } from "./parity-bench";
export type {
  ParityBenchOptions,
  ParityBenchBackendResult,
  ParityBenchReport,
  ParityBenchDetailedResult,
} from "./parity-bench";
