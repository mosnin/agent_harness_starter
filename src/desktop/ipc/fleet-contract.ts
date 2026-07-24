/**
 * Hades desktop fleet wire protocol.
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the
 * remote-compute fleet (`hades backends`): backend inventory + measured
 * telemetry, and per-worker lifecycle control (hibernate/wake/terminate).
 * The `FleetCommand` union flows renderer -> sidecar, `FleetEvent` flows
 * sidecar -> renderer, exactly like `Command`/`AppEvent`.
 *
 * This module mirrors `./contract.ts` conventions exactly (same guard
 * shapes, same codec error message style) so it is ready to be merged into
 * the `Command`/`AppEvent` unions there. It is intentionally standalone:
 * pure, deterministic, dependency-free — it does not import from
 * `./contract.ts` (or anywhere else) so the merge can happen without
 * introducing a coupling in either direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/**
 * A worker's lifecycle state as the fleet UI understands it. A superset of
 * the remote-backend `RemoteState` ("provisioning" | "running" |
 * "hibernated" | "stopped" | "failed") that also names the two in-flight
 * transitions ("hibernating", "waking") a richer lifecycle supervisor may
 * report.
 */
export type FleetLifecycleState =
  | "provisioning"
  | "running"
  | "hibernating"
  | "hibernated"
  | "waking"
  | "failed"
  | "stopped";

/**
 * Operator-configured cost rates for a backend. Never a measured price —
 * always tagged `source: "configured"` so the UI can never mistake a
 * configured rate for something benchmarked.
 */
export interface BackendCostView {
  perRunningHourUsd: number;
  perHibernatedHourUsd: number;
  perProvisionUsd: number;
  source: "configured";
}

/** Measured (never fabricated) telemetry for one backend. */
export interface BackendTelemetryView {
  provisions: number;
  failures: number;
  provisionLatencyEmaMs: number | null;
  runningMs: number;
  hibernatedMs: number;
  accruedUsd: number;
}

/** Static description + live availability + measured telemetry for one backend. */
export interface BackendView {
  name: string;
  kind: string;
  capabilities: string[];
  locality: "local" | "remote";
  supportsHibernate: boolean;
  /** `null` when the snapshot was taken without probing (see `fleet.list`). */
  available: boolean | null;
  cost: BackendCostView;
  telemetry: BackendTelemetryView;
}

/** One live worker on the fleet. */
export interface FleetWorkerView {
  workerId: string;
  backend: string;
  nativeId: string;
  state: FleetLifecycleState;
  startedAt: number;
  idleMs: number;
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type FleetCommand =
  | { kind: "fleet.list" }
  | { kind: "fleet.probe" }
  | { kind: "fleet.hibernate"; workerId: string }
  | { kind: "fleet.wake"; workerId: string }
  | { kind: "fleet.terminate"; workerId: string };

export type FleetEvent =
  | { kind: "fleet.snapshot"; backends: BackendView[]; workers: FleetWorkerView[]; at: number }
  | { kind: "fleet.worker.upsert"; worker: FleetWorkerView }
  | { kind: "fleet.error"; message: string; workerId?: string; at: number };

export const FLEET_COMMAND_KINDS = [
  "fleet.list",
  "fleet.probe",
  "fleet.hibernate",
  "fleet.wake",
  "fleet.terminate",
] as const satisfies readonly FleetCommand["kind"][];

export const FLEET_EVENT_KINDS = [
  "fleet.snapshot",
  "fleet.worker.upsert",
  "fleet.error",
] as const satisfies readonly FleetEvent["kind"][];

// Compile-time exhaustiveness: fails to type-check if a kind is added to the
// `FleetCommand`/`FleetEvent` unions without adding it to the tuples above
// (or vice versa) — a mismatch in either direction breaks these assignments.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [
  Union,
] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<FleetCommand["kind"], typeof FLEET_COMMAND_KINDS> = true;
const _eventKindsExact: ExactlyKindsOf<FleetEvent["kind"], typeof FLEET_EVENT_KINDS> = true;
void _commandKindsExact;
void _eventKindsExact;

const FLEET_LIFECYCLE_STATES = [
  "provisioning",
  "running",
  "hibernating",
  "hibernated",
  "waking",
  "failed",
  "stopped",
] as const satisfies readonly FleetLifecycleState[];

// ---------------------------------------------------------------------------
// Primitive type helpers
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || typeof x === "string";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNullableNumber(x: unknown): x is number | null {
  return x === null || isNumber(x);
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

function isNullableBoolean(x: unknown): x is boolean | null {
  return x === null || typeof x === "boolean";
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

function isOneOf<T extends string>(x: unknown, values: readonly T[]): x is T {
  return typeof x === "string" && (values as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// View model guards
// ---------------------------------------------------------------------------

const LOCALITIES = ["local", "remote"] as const;

function isBackendCostView(x: unknown): x is BackendCostView {
  if (!isPlainObject(x)) return false;
  return (
    isNumber(x.perRunningHourUsd) &&
    isNumber(x.perHibernatedHourUsd) &&
    isNumber(x.perProvisionUsd) &&
    x.source === "configured"
  );
}

function isBackendTelemetryView(x: unknown): x is BackendTelemetryView {
  if (!isPlainObject(x)) return false;
  return (
    isNumber(x.provisions) &&
    isNumber(x.failures) &&
    isNullableNumber(x.provisionLatencyEmaMs) &&
    isNumber(x.runningMs) &&
    isNumber(x.hibernatedMs) &&
    isNumber(x.accruedUsd)
  );
}

export function isBackendView(x: unknown): x is BackendView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.name) &&
    isString(x.kind) &&
    isStringArray(x.capabilities) &&
    isOneOf(x.locality, LOCALITIES) &&
    isBoolean(x.supportsHibernate) &&
    isNullableBoolean(x.available) &&
    isBackendCostView(x.cost) &&
    isBackendTelemetryView(x.telemetry)
  );
}

export function isFleetWorkerView(x: unknown): x is FleetWorkerView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.workerId) &&
    isString(x.backend) &&
    isString(x.nativeId) &&
    isOneOf(x.state, FLEET_LIFECYCLE_STATES) &&
    isNumber(x.startedAt) &&
    isNumber(x.idleMs)
  );
}

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

export function isFleetCommand(x: unknown): x is FleetCommand {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "fleet.list":
    case "fleet.probe":
      return true;
    case "fleet.hibernate":
    case "fleet.wake":
    case "fleet.terminate":
      return isString(x.workerId);
    default:
      return false;
  }
}

export function isFleetEvent(x: unknown): x is FleetEvent {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "fleet.snapshot":
      return (
        Array.isArray(x.backends) &&
        x.backends.every(isBackendView) &&
        Array.isArray(x.workers) &&
        x.workers.every(isFleetWorkerView) &&
        isNumber(x.at)
      );
    case "fleet.worker.upsert":
      return isFleetWorkerView(x.worker);
    case "fleet.error":
      return isString(x.message) && isOptionalString(x.workerId) && isNumber(x.at);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

function parseLine(line: string, label: "command" | "event"): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error(`bad ${label}: empty line`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`bad ${label}: invalid JSON`);
  }
}

export function encodeFleetCommand(c: FleetCommand): string {
  return JSON.stringify(c) + "\n";
}

export function decodeFleetCommand(line: string): FleetCommand {
  const parsed = parseLine(line, "command");
  if (!isPlainObject(parsed) || typeof parsed.kind !== "string") {
    throw new Error("bad command: missing kind");
  }
  if (!(FLEET_COMMAND_KINDS as readonly string[]).includes(parsed.kind)) {
    throw new Error(`bad command: unknown kind "${parsed.kind}"`);
  }
  if (!isFleetCommand(parsed)) {
    throw new Error(`bad command: missing or invalid fields for kind "${parsed.kind}"`);
  }
  return parsed;
}

export function encodeFleetEvent(e: FleetEvent): string {
  return JSON.stringify(e) + "\n";
}

export function decodeFleetEvent(line: string): FleetEvent {
  const parsed = parseLine(line, "event");
  if (!isPlainObject(parsed) || typeof parsed.kind !== "string") {
    throw new Error("bad event: missing kind");
  }
  if (!(FLEET_EVENT_KINDS as readonly string[]).includes(parsed.kind)) {
    throw new Error(`bad event: unknown kind "${parsed.kind}"`);
  }
  if (!isFleetEvent(parsed)) {
    throw new Error(`bad event: missing or invalid fields for kind "${parsed.kind}"`);
  }
  return parsed;
}
