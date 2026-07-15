/**
 * @module swarm-runtime
 *
 * Real OS-level swarm orchestration: a **manager agent** decomposes a goal into
 * tasks and spawns **worker agents**, each in its own isolated unit (a Docker
 * container in production, a child process in dev/test). Workers report results
 * back through a message bus; every result passes an **anti-hallucination
 * verification gate** and **anti-rogue guardrails** before the manager accepts
 * it.
 *
 * This layer sits on top of the in-process `SwarmCoordinator`
 * (`src/agents/swarm`) — the coordinator remains the logical bookkeeper
 * (registry, load-balancing, stats) while this runtime provides the physical
 * isolation, lifecycle, and trust enforcement Hermes-style swarms need.
 */

// ── Isolation units ──────────────────────────────────────────────────────────

export type IsolationKind = "docker" | "process" | "inline";

/** Handle to a running isolation unit (container / process). */
export interface ContainerHandle {
  /** Stable worker id used across the bus and coordinator. */
  workerId: string;
  /** Underlying container id / PID / synthetic id. */
  nativeId: string;
  kind: IsolationKind;
  /** URL the manager reaches this worker at, when the worker exposes one. */
  endpoint?: string;
  startedAt: number;
}

/** Everything a provider needs to launch one worker. */
export interface SpawnSpec {
  workerId: string;
  /** Capabilities/skills this worker advertises to the coordinator. */
  capabilities: string[];
  /** Base URL of the manager's control plane the worker calls home to. */
  managerUrl: string;
  /** Shared secret the worker presents on every bus call. */
  authToken: string;
  /** Model the worker should use (overridable per-worker). */
  model?: string;
  /** Extra environment variables for the worker. */
  env?: Record<string, string>;
  /** Hard resource ceilings (enforced by docker; advisory for process). */
  limits?: ResourceLimits;
  /** Container image (docker provider only). */
  image?: string;
}

export interface ResourceLimits {
  /** CPU cores, e.g. 0.5, 1, 2. */
  cpus?: number;
  /** Memory limit, e.g. "512m", "1g". */
  memory?: string;
  /** Wall-clock ceiling for the whole worker lifetime (ms). */
  timeoutMs?: number;
  /** Disable outbound network for the worker (docker: --network none). */
  noNetwork?: boolean;
  /** Mount the root filesystem read-only (docker: --read-only). */
  readOnlyRootFs?: boolean;
  /** Drop all Linux capabilities (docker: --cap-drop ALL). */
  dropAllCapabilities?: boolean;
}

/**
 * A provider knows how to create/destroy isolation units. Implementations:
 * DockerProvider (real containers), LocalProcessProvider (child_process),
 * InlineProvider (same-process, for tests).
 */
export interface ContainerProvider {
  readonly kind: IsolationKind;
  /** Best-effort check that the backend is usable (docker installed, etc). */
  isAvailable(): Promise<boolean>;
  spawn(spec: SpawnSpec): Promise<ContainerHandle>;
  /** Graceful stop then force-kill after `graceMs`. */
  stop(handle: ContainerHandle, graceMs?: number): Promise<void>;
  /** Liveness probe — false means the unit died. */
  isAlive(handle: ContainerHandle): Promise<boolean>;
  /** Recent stdout/stderr for debugging / the GUI. */
  logs(handle: ContainerHandle, tailLines?: number): Promise<string>;
}

// ── Tasks & results ──────────────────────────────────────────────────────────

export type WorkerTaskStatus =
  | "pending"
  | "dispatched"
  | "running"
  | "reported"
  | "verified"
  | "rejected"
  | "failed";

/**
 * Redundant-execution policy for a task. When set, the manager dispatches the
 * task to `replicas` independent workers and accepts the result only if at
 * least `ceil(replicas * quorum)` of them both clear the verification gate and
 * agree on the same canonical output. This makes a single hallucinating (or
 * compromised) worker unable to move a task to "done" on its own.
 */
export interface ConsensusSpec {
  /** Number of independent workers to run this task. */
  replicas: number;
  /** Fraction of replicas that must agree (0..1). Default 0.5 (majority). */
  quorum: number;
  /** Max wait for all replicas before evaluating with whatever arrived (ms). */
  roundTimeoutMs?: number;
}

export interface WorkerTask {
  id: string;
  /** Goal this task belongs to. */
  goalId: string;
  description: string;
  /** Capabilities a worker must have to take this task. */
  requiredCapabilities: string[];
  /** Task-specific input payload. */
  input: Record<string, unknown>;
  /** Task ids that must be `verified` before this one is dispatchable. */
  dependsOn: string[];
  priority: number;
  status: WorkerTaskStatus;
  assignedTo?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  result?: WorkerResult;
  /** If set, run this task redundantly and require quorum agreement. */
  consensus?: ConsensusSpec;
  /** History of rejected attempts — why each prior try was sent back. */
  revisions?: RevisionEntry[];
}

export interface RevisionEntry {
  attempt: number;
  verdict?: Verdict;
  score?: number;
  /** Names of the grounding checks that failed this attempt. */
  failedChecks: string[];
  feedback: string;
  at: number;
}

/** A single grounded assertion a worker makes about its output. */
export interface Claim {
  /** Human-readable statement the worker asserts is true. */
  statement: string;
  /** Evidence the worker cites — tool outputs, file paths, URLs, quotes. */
  evidence: string[];
  /** Worker's own confidence 0..1. */
  confidence: number;
}

export interface WorkerResult {
  taskId: string;
  workerId: string;
  /** The worker's final answer / artifact. */
  output: unknown;
  /** Grounded claims backing the output — the substrate the gate verifies. */
  claims: Claim[];
  /** Tool calls the worker made (for audit + grounding checks). */
  toolTrace: ToolCallRecord[];
  startedAt: number;
  finishedAt: number;
  /** Set when the worker itself errored. */
  error?: string;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Truncated stringified output. */
  output: string;
  at: number;
}

// ── Verification (anti-hallucination) ────────────────────────────────────────

export type Verdict = "accept" | "revise" | "reject";

export interface VerificationReport {
  taskId: string;
  workerId: string;
  verdict: Verdict;
  /** Overall grounding score 0..1. */
  score: number;
  /** Per-check breakdown. */
  checks: VerificationCheck[];
  /** Guidance handed back to the worker when verdict is `revise`. */
  feedback: string;
  at: number;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  weight: number;
  detail: string;
}

// ── Goals ────────────────────────────────────────────────────────────────────

export type GoalStatus = "planning" | "running" | "completed" | "failed" | "aborted";

export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  completedAt?: number;
  taskIds: string[];
  /** Final synthesized answer once all tasks verify. */
  synthesis?: unknown;
  /** Cross-claim contradictions found across the goal's verified results. */
  contradictions?: import("./verification/contradiction").Contradiction[];
}

// ── Bus messages ─────────────────────────────────────────────────────────────

export type BusMessageType =
  | "register"
  | "heartbeat"
  | "task"
  | "result"
  | "log"
  | "deregister";

export interface BusEnvelope<T = unknown> {
  type: BusMessageType;
  workerId: string;
  payload: T;
  at: number;
}
