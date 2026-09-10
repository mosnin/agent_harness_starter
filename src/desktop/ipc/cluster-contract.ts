/**
 * Hades desktop cluster wire protocol (`cluster.*`).
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the multi-node
 * layer (`src/swarm-runtime/distributed/**`) — the same fabric `hades cluster`
 * drives from a terminal: real SWIM membership + leader election, real
 * fencing-token leases, real signed federation links between every pair of
 * participants, real inline `SwarmManager`s behind the real verification gate,
 * and real ed25519 certificates binding the exact bytes each node produced.
 *
 *  - `cluster.status` -> `cluster.status` — build a fabric, report its
 *    composition and the coordinator's exactly-once accounting, tear it down.
 *  - `cluster.nodes`  -> `cluster.nodes`  — per-node live snapshots (health,
 *    load, in-flight leases, this node's own view of who leads).
 *  - `cluster.run`    -> `cluster.run`    — actually execute N tasks across N
 *    nodes end to end, with no injected faults.
 *  - `cluster.chaos`  -> `cluster.chaos`  — the same, under a REAL seeded
 *    fault schedule (worker kills, node crashes, link partitions).
 *  - any failure      -> `cluster.error` (never silence, never a fabricated
 *    "ok").
 *
 * ## There is no persistent cluster daemon, and this lane says so
 *
 * Nothing in this product runs a long-lived cluster between invocations. Every
 * command here therefore BUILDS a real in-process fabric, measures it, and
 * tears it down — which is why every reply carries `mode: "measured"` and an
 * `ephemeral: true` flag. A renderer must present these as "a run that just
 * happened on this machine", never as "the state of your cluster". A field
 * that would let a UI imply a standing cluster deliberately does not exist.
 *
 * ## What deliberately never crosses this wire
 *
 * There is no `cluster.bench` command. `runClusterBench` executes three full
 * arms back to back (single-node, multi-node, multi-node-under-faults) and
 * takes tens of seconds of real wall clock; the sidecar speaks over ONE
 * newline-delimited stdio pipe, so a renderer able to start it could stall
 * every other lane (`state.*`, `fleet.*`, `trust.*`) for the duration. It also
 * emits the headline speedup number, which belongs where an operator can see
 * the seed, the full report and re-run it verbatim: `hades cluster bench`.
 *
 * `cluster.run` and `cluster.chaos` really do spend local CPU, so `nodes`,
 * `tasks` and `workersPerNode` are clamped SERVER-SIDE (see
 * `../core/cluster-service.ts`); a renderer cannot ask for a 500-node fabric.
 * No command in this lane can spend money — every node executes on the inline
 * provider, never a paid remote backend.
 *
 * This module mirrors `./route-contract.ts`'s conventions exactly (same guard
 * shapes, same exhaustiveness assertions, same codec error style) and is
 * intentionally standalone — it imports nothing, so merging it into
 * `./contract.ts`'s unions introduces no coupling in either direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/**
 * One cluster node's live snapshot.
 *
 * Structural match for `ClusterNodeSnapshot`
 * (`src/swarm-runtime/distributed/cluster-node.ts`) with `inFlight` reduced to
 * its count, and for `ClusterPaneNodeRow`
 * (`src/swarm-runtime/tui/cluster-pane.ts`) — the desktop and the TUI render
 * the same rows with no adapter in between.
 */
export interface ClusterNodeWire {
  nodeId: string;
  /** `alive` | `draining` | `left` | `crashed`. */
  health: string;
  inFlight: number;
  liveWorkers: number;
  /** In-flight leases as a fraction of this node's own concurrency cap. */
  load: number;
  completed: number;
  handedBack: number;
  abandoned: number;
  epoch: number;
  /**
   * Who THIS node believes leads. `null` means it sees no quorum-backed
   * leader — a renderer must show that explicitly, because a blank cell reads
   * as "fine" when it actually means placement is blocked.
   */
  leaderId: string | null;
}

/** The coordinator's exactly-once accounting for a fabric. */
export interface ClusterStatusWire {
  /** Always the literal "measured": every field came from code that ran. */
  mode: "measured";
  /**
   * Always true. The fabric was built for this request and torn down before
   * the reply was sent; there is no standing cluster to report on.
   */
  ephemeral: true;
  nodes: number;
  workersPerNode: number;
  total: number;
  pending: number;
  leased: number;
  verified: number;
  failed: number;
  reassignments: number;
  /** Reports refused because their fencing token was stale or never issued. */
  staleReportsRejected: number;
  /** Replicas that disagreed — surfaced, never silently overwritten. */
  conflicts: number;
  /** Per node router: how many federation peers completed a handshake. */
  peersReady: number[];
}

/** The measured outcome of an actually-executed run. */
export interface ClusterRunWire {
  /** Always the literal "measured". */
  mode: "measured";
  /** Always true — see {@link ClusterStatusWire.ephemeral}. */
  ephemeral: true;
  nodes: number;
  tasksSubmitted: number;
  tasksVerified: number;
  tasksFailed: number;
  /** An exactly-once breach. Any value > 0 is a trust failure, not a stat. */
  duplicateVerifications: number;
  reassignments: number;
  conflicts: number;
  certificatesValid: number;
  /** A certificate that did not bind the bytes it claimed to. > 0 is an alert. */
  certificatesInvalid: number;
  /** Real wall-clock span of the run, in ms. */
  makespanMs: number;
  verifiedPerSec: number;
  /**
   * False when `tasksVerified !== tasksSubmitted` or anything failed. A
   * partial distributed run is NOT a result, and this flag is what stops a
   * renderer drawing one as green.
   */
  complete: boolean;
  /** The seeded fault schedule that actually fired (empty for `cluster.run`). */
  faults: ClusterFaultWire[];
  /** Present for `cluster.chaos`: the seed that reproduces `faults` exactly. */
  seed: number | null;
}

/** One injected fault that genuinely fired during a run. */
export interface ClusterFaultWire {
  /** ms after run start. */
  at: number;
  /** `kill-worker` | `crash-node` | `partition-link` | `heal-link` | … */
  kind: string;
  target: string;
  peer: string | null;
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Commands / events
// ---------------------------------------------------------------------------

export type ClusterCommand =
  | { kind: "cluster.status"; nodes?: number; workersPerNode?: number }
  | { kind: "cluster.nodes"; nodes?: number; workersPerNode?: number }
  | { kind: "cluster.run"; nodes?: number; tasks?: number; workersPerNode?: number }
  | { kind: "cluster.chaos"; nodes?: number; tasks?: number; workersPerNode?: number; seed?: number; density?: number };

export type ClusterEvent =
  | { kind: "cluster.status"; status: ClusterStatusWire; at: number }
  | { kind: "cluster.nodes"; nodes: ClusterNodeWire[]; at: number }
  | { kind: "cluster.run"; run: ClusterRunWire; at: number }
  | { kind: "cluster.chaos"; run: ClusterRunWire; at: number }
  | { kind: "cluster.error"; op: string; message: string; at: number };

export const CLUSTER_COMMAND_KINDS = [
  "cluster.status",
  "cluster.nodes",
  "cluster.run",
  "cluster.chaos",
] as const satisfies readonly ClusterCommand["kind"][];

export const CLUSTER_EVENT_KINDS = [
  "cluster.status",
  "cluster.nodes",
  "cluster.run",
  "cluster.chaos",
  "cluster.error",
] as const satisfies readonly ClusterEvent["kind"][];

// Compile-time exhaustiveness in BOTH directions: a kind added to a union
// without being added to its tuple (or vice versa) fails to type-check.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [Union] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<ClusterCommand["kind"], typeof CLUSTER_COMMAND_KINDS> = true;
const _eventKindsExact: ExactlyKindsOf<ClusterEvent["kind"], typeof CLUSTER_EVENT_KINDS> = true;
void _commandKindsExact;
void _eventKindsExact;

// ---------------------------------------------------------------------------
// Primitive guards (same shape as ./route-contract.ts, including its
// prototype-pollution rejection — these payloads cross a process boundary)
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  for (const k of Object.keys(x as object)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return false;
  }
  return true;
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

/** Finite only — a NaN/Infinity would survive JSON round-tripping as `null`
 *  and read as "absent" rather than "broken". */
function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNullableNumber(x: unknown): x is number | null {
  return x === null || isNumber(x);
}

function isNullableString(x: unknown): x is string | null {
  return x === null || isString(x);
}

function isOptionalNumber(x: unknown): x is number | undefined {
  return x === undefined || isNumber(x);
}

function isArrayOf<T>(x: unknown, guard: (v: unknown) => v is T): x is T[] {
  return Array.isArray(x) && x.every(guard);
}

// ---------------------------------------------------------------------------
// View-model guards
// ---------------------------------------------------------------------------

export function isClusterNodeWire(x: unknown): x is ClusterNodeWire {
  return (
    isPlainObject(x) &&
    isString(x.nodeId) &&
    isString(x.health) &&
    isNumber(x.inFlight) &&
    isNumber(x.liveWorkers) &&
    isNumber(x.load) &&
    isNumber(x.completed) &&
    isNumber(x.handedBack) &&
    isNumber(x.abandoned) &&
    isNumber(x.epoch) &&
    isNullableString(x.leaderId)
  );
}

export function isClusterStatusWire(x: unknown): x is ClusterStatusWire {
  return (
    isPlainObject(x) &&
    // `mode` and `ephemeral` are REQUIRED literals: they are what stops a
    // renderer presenting this as a standing cluster's live state.
    x.mode === "measured" &&
    x.ephemeral === true &&
    isNumber(x.nodes) &&
    isNumber(x.workersPerNode) &&
    isNumber(x.total) &&
    isNumber(x.pending) &&
    isNumber(x.leased) &&
    isNumber(x.verified) &&
    isNumber(x.failed) &&
    isNumber(x.reassignments) &&
    isNumber(x.staleReportsRejected) &&
    isNumber(x.conflicts) &&
    isArrayOf(x.peersReady, isNumber)
  );
}

export function isClusterFaultWire(x: unknown): x is ClusterFaultWire {
  return (
    isPlainObject(x) &&
    isNumber(x.at) &&
    isString(x.kind) &&
    isString(x.target) &&
    isNullableString(x.peer) &&
    isNullableString(x.detail)
  );
}

export function isClusterRunWire(x: unknown): x is ClusterRunWire {
  return (
    isPlainObject(x) &&
    x.mode === "measured" &&
    x.ephemeral === true &&
    isNumber(x.nodes) &&
    isNumber(x.tasksSubmitted) &&
    isNumber(x.tasksVerified) &&
    isNumber(x.tasksFailed) &&
    isNumber(x.duplicateVerifications) &&
    isNumber(x.reassignments) &&
    isNumber(x.conflicts) &&
    isNumber(x.certificatesValid) &&
    isNumber(x.certificatesInvalid) &&
    isNumber(x.makespanMs) &&
    isNumber(x.verifiedPerSec) &&
    // Required, not optional: `complete` is the field that stops a partial run
    // being drawn as a finished one.
    isBoolean(x.complete) &&
    isArrayOf(x.faults, isClusterFaultWire) &&
    isNullableNumber(x.seed)
  );
}

// ---------------------------------------------------------------------------
// Command / event guards
// ---------------------------------------------------------------------------

export function isClusterCommand(x: unknown): x is ClusterCommand {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "cluster.status":
    case "cluster.nodes":
      return isOptionalNumber(x.nodes) && isOptionalNumber(x.workersPerNode);
    case "cluster.run":
      return isOptionalNumber(x.nodes) && isOptionalNumber(x.tasks) && isOptionalNumber(x.workersPerNode);
    case "cluster.chaos":
      return (
        isOptionalNumber(x.nodes) &&
        isOptionalNumber(x.tasks) &&
        isOptionalNumber(x.workersPerNode) &&
        isOptionalNumber(x.seed) &&
        isOptionalNumber(x.density)
      );
    default:
      return false;
  }
}

export function isClusterEvent(x: unknown): x is ClusterEvent {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "cluster.status":
      return isClusterStatusWire(x.status) && isNumber(x.at);
    case "cluster.nodes":
      return isArrayOf(x.nodes, isClusterNodeWire) && isNumber(x.at);
    case "cluster.run":
    case "cluster.chaos":
      return isClusterRunWire(x.run) && isNumber(x.at);
    case "cluster.error":
      return isString(x.op) && isString(x.message) && isNumber(x.at);
    default:
      return false;
  }
}
