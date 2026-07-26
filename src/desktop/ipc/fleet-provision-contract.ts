/**
 * Hades desktop fleet PROVISION wire protocol.
 *
 * Sibling of `./fleet-contract.ts` (not an edit of it): the `fleet.list` /
 * `fleet.probe` / `fleet.hibernate` / `fleet.wake` / `fleet.terminate`
 * surface fleet-contract.ts already owns says nothing about how a new
 * worker comes INTO existence, or what happens to workers a previous
 * sidecar process had already provisioned when this one starts up. This
 * module adds exactly that: `fleet.provision` (renderer -> sidecar) and its
 * three possible outcomes `fleet.provisioned` / `fleet.provision.error` /
 * `fleet.restored` (sidecar -> renderer).
 *
 * `FleetWorkerView` is imported from `./fleet-contract` (the single source
 * of truth for that view model) so a provisioned/restored worker renders
 * with the exact same shape the rest of the fleet surface already knows how
 * to draw. Nothing in `./fleet-contract.ts` is edited to make this work —
 * this module is purely additive, exactly like `fleet-contract.ts` was
 * additive to `./contract.ts`.
 *
 * Same house conventions as `fleet-contract.ts`: same guard shapes
 * (`isPlainObject` / `isString` / finite-number checks), same codec error
 * message phrasing ("bad command: missing kind", "bad command: unknown
 * kind ...", "bad command: missing or invalid fields for kind ..." — and
 * the `command`/`event` label swapped in for events), same compile-time
 * exhaustiveness pattern via `ExactlyKindsOf`. The one deliberate naming
 * difference: this module's codecs are named `parse*`/`serialize*` (per the
 * locked contract for this surface) rather than `encode*`/`decode*` —
 * behavior and error phrasing are otherwise identical.
 *
 * Guards here are deliberately paranoid: a non-string `requestId`, an empty
 * `workerId`, a non-array `capabilities`, an unrecognized extra `kind`, or a
 * non-finite number anywhere a number is expected are all rejected. User-
 * supplied string lists (`spec.capabilities`, `requirements.exclude`) are
 * also *bounded* — a multi-megabyte capability array is a hostile or
 * malfunctioning payload, not a real worker spec, and is rejected the same
 * way a malformed one is (never parsed "successfully" into something a
 * downstream consumer would have to defend against a second time).
 */

import type { FleetWorkerView } from "./fleet-contract";

export type { FleetWorkerView } from "./fleet-contract";

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export interface FleetProvisionSpec {
  workerId: string;
  capabilities: string[];
  image?: string;
}

export interface FleetProvisionRequirements {
  capabilities?: string[];
  requireHibernate?: boolean;
  maxRunningHourUsd?: number;
  exclude?: string[];
}

export interface FleetProvisionRouting {
  source: string;
  backend?: string;
  reason?: string;
}

export interface FleetRestoredDrop {
  workerId: string;
  reason: string;
}

export type FleetProvisionCommand = {
  kind: "fleet.provision";
  requestId: string;
  spec: FleetProvisionSpec;
  requirements?: FleetProvisionRequirements;
};

export type FleetProvisionEvent =
  | {
      kind: "fleet.provisioned";
      requestId: string;
      worker: FleetWorkerView;
      backend: string;
      routing?: FleetProvisionRouting;
      at: number;
    }
  | { kind: "fleet.provision.error"; requestId: string; message: string; at: number }
  | {
      kind: "fleet.restored";
      workers: FleetWorkerView[];
      adoptedIds: string[];
      dropped: FleetRestoredDrop[];
      /** Already-live workerId collisions the adoption pass skipped — a
       *  subset of `dropped` (which keeps carrying them for back-compat),
       *  surfaced separately so the renderer's conflicts lane can offer the
       *  rename-and-provision remediation. Optional on the wire: an older
       *  sidecar that doesn't send it simply yields a lane with no
       *  actionable conflict rows, never a parse failure. */
      conflicts?: FleetRestoredDrop[];
      at: number;
    };

export const FLEET_PROVISION_COMMAND_KINDS = [
  "fleet.provision",
] as const satisfies readonly FleetProvisionCommand["kind"][];

export const FLEET_PROVISION_EVENT_KINDS = [
  "fleet.provisioned",
  "fleet.provision.error",
  "fleet.restored",
] as const satisfies readonly FleetProvisionEvent["kind"][];

// Compile-time exhaustiveness: fails to type-check if a kind is added to
// either union above without adding it to the matching tuple (or vice
// versa) — a mismatch in either direction breaks these assignments. Mirrors
// fleet-contract.ts:105-124 exactly.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [
  Union,
] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<
  FleetProvisionCommand["kind"],
  typeof FLEET_PROVISION_COMMAND_KINDS
> = true;
const _eventKindsExact: ExactlyKindsOf<
  FleetProvisionEvent["kind"],
  typeof FLEET_PROVISION_EVENT_KINDS
> = true;
void _commandKindsExact;
void _eventKindsExact;

// ---------------------------------------------------------------------------
// Primitive type helpers (same shapes as fleet-contract.ts)
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || typeof x === "string";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isOptionalNumber(x: unknown): x is number | undefined {
  return x === undefined || isNumber(x);
}

function isOptionalBoolean(x: unknown): x is boolean | undefined {
  return x === undefined || typeof x === "boolean";
}

/**
 * Bounded string-array guard: rejects a non-array, an over-long array, and
 * any element that is not a string or is itself an unreasonably long
 * string. This is the defense that turns a "1MB capabilities array" fuzz
 * payload into a clean rejection instead of a parsed-but-hostile value.
 */
const MAX_USER_LIST_LENGTH = 256;
const MAX_USER_STRING_LENGTH = 1024;

function isBoundedStringArray(x: unknown): x is string[] {
  if (!Array.isArray(x)) return false;
  if (x.length > MAX_USER_LIST_LENGTH) return false;
  return x.every((v) => typeof v === "string" && v.length <= MAX_USER_STRING_LENGTH);
}

function isOptionalBoundedStringArray(x: unknown): x is string[] | undefined {
  return x === undefined || isBoundedStringArray(x);
}

// A restored-fleet snapshot describes real, already-provisioned workers, not
// free-form user input — bounded generously so a genuinely large fleet is
// never rejected, while a multi-megabyte fuzzed payload still is.
const MAX_RESTORED_LIST_LENGTH = 20_000;

function isBoundedArray<T>(x: unknown, guard: (v: unknown) => v is T, maxLength: number): x is T[] {
  if (!Array.isArray(x)) return false;
  if (x.length > maxLength) return false;
  return x.every(guard);
}

// ---------------------------------------------------------------------------
// View model guards
// ---------------------------------------------------------------------------

const FLEET_LIFECYCLE_STATES = [
  "provisioning",
  "running",
  "hibernating",
  "hibernated",
  "waking",
  "failed",
  "stopped",
] as const;

/**
 * Local, structural re-validation of `FleetWorkerView` — deliberately not
 * imported from `./fleet-contract` (that module exports the *type* but not
 * a guard our locked import surface is allowed to widen), so this mirrors
 * `isFleetWorkerView` in `fleet-contract.ts` field-for-field and stays in
 * lockstep with it by construction (both are driven off the same
 * `FleetWorkerView` interface).
 */
function isFleetWorkerView(x: unknown): x is FleetWorkerView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.workerId) &&
    isString(x.backend) &&
    isString(x.nativeId) &&
    typeof x.state === "string" &&
    (FLEET_LIFECYCLE_STATES as readonly string[]).includes(x.state) &&
    isNumber(x.startedAt) &&
    isNumber(x.idleMs)
  );
}

function isFleetProvisionSpec(x: unknown): x is FleetProvisionSpec {
  if (!isPlainObject(x)) return false;
  return (
    isNonEmptyString(x.workerId) &&
    isBoundedStringArray(x.capabilities) &&
    (x.image === undefined || isString(x.image))
  );
}

function isFleetProvisionRequirements(x: unknown): x is FleetProvisionRequirements {
  if (!isPlainObject(x)) return false;
  return (
    isOptionalBoundedStringArray(x.capabilities) &&
    isOptionalBoolean(x.requireHibernate) &&
    isOptionalNumber(x.maxRunningHourUsd) &&
    isOptionalBoundedStringArray(x.exclude)
  );
}

function isFleetProvisionRouting(x: unknown): x is FleetProvisionRouting {
  if (!isPlainObject(x)) return false;
  return isString(x.source) && isOptionalString(x.backend) && isOptionalString(x.reason);
}

function isFleetRestoredDrop(x: unknown): x is FleetRestoredDrop {
  if (!isPlainObject(x)) return false;
  return isNonEmptyString(x.workerId) && isString(x.reason);
}

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

export function isFleetProvisionCommand(x: unknown): x is FleetProvisionCommand {
  if (!isPlainObject(x)) return false;
  if (x.kind !== "fleet.provision") return false;
  if (!isNonEmptyString(x.requestId)) return false;
  if (!isFleetProvisionSpec(x.spec)) return false;
  if (x.requirements !== undefined && !isFleetProvisionRequirements(x.requirements)) return false;
  return true;
}

export function isFleetProvisionEvent(x: unknown): x is FleetProvisionEvent {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "fleet.provisioned":
      return (
        isNonEmptyString(x.requestId) &&
        isFleetWorkerView(x.worker) &&
        isString(x.backend) &&
        (x.routing === undefined || isFleetProvisionRouting(x.routing)) &&
        isNumber(x.at)
      );
    case "fleet.provision.error":
      return isNonEmptyString(x.requestId) && isString(x.message) && isNumber(x.at);
    case "fleet.restored":
      return (
        isBoundedArray(x.workers, isFleetWorkerView, MAX_RESTORED_LIST_LENGTH) &&
        isBoundedArray(x.adoptedIds, isString, MAX_RESTORED_LIST_LENGTH) &&
        isBoundedArray(x.dropped, isFleetRestoredDrop, MAX_RESTORED_LIST_LENGTH) &&
        (x.conflicts === undefined ||
          isBoundedArray(x.conflicts, isFleetRestoredDrop, MAX_RESTORED_LIST_LENGTH)) &&
        isNumber(x.at)
      );
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

export function parseFleetProvisionCommand(line: string): FleetProvisionCommand {
  const parsed = parseLine(line, "command");
  if (!isPlainObject(parsed) || typeof parsed.kind !== "string") {
    throw new Error("bad command: missing kind");
  }
  if (!(FLEET_PROVISION_COMMAND_KINDS as readonly string[]).includes(parsed.kind)) {
    throw new Error(`bad command: unknown kind "${parsed.kind}"`);
  }
  if (!isFleetProvisionCommand(parsed)) {
    throw new Error(`bad command: missing or invalid fields for kind "${parsed.kind}"`);
  }
  return parsed;
}

export function parseFleetProvisionEvent(line: string): FleetProvisionEvent {
  const parsed = parseLine(line, "event");
  if (!isPlainObject(parsed) || typeof parsed.kind !== "string") {
    throw new Error("bad event: missing kind");
  }
  if (!(FLEET_PROVISION_EVENT_KINDS as readonly string[]).includes(parsed.kind)) {
    throw new Error(`bad event: unknown kind "${parsed.kind}"`);
  }
  if (!isFleetProvisionEvent(parsed)) {
    throw new Error(`bad event: missing or invalid fields for kind "${parsed.kind}"`);
  }
  return parsed;
}

/** Validates before serializing — a caller can never write a malformed line to the wire. */
export function serializeFleetProvisionCommand(c: FleetProvisionCommand): string {
  const x: unknown = c;
  if (!isPlainObject(x) || typeof x.kind !== "string") {
    throw new Error("bad command: missing kind");
  }
  if (!(FLEET_PROVISION_COMMAND_KINDS as readonly string[]).includes(x.kind)) {
    throw new Error(`bad command: unknown kind "${x.kind}"`);
  }
  if (!isFleetProvisionCommand(x)) {
    throw new Error(`bad command: missing or invalid fields for kind "${x.kind}"`);
  }
  return JSON.stringify(x) + "\n";
}

/** Validates before serializing — a caller can never write a malformed line to the wire. */
export function serializeFleetProvisionEvent(e: FleetProvisionEvent): string {
  const x: unknown = e;
  if (!isPlainObject(x) || typeof x.kind !== "string") {
    throw new Error("bad event: missing kind");
  }
  if (!(FLEET_PROVISION_EVENT_KINDS as readonly string[]).includes(x.kind)) {
    throw new Error(`bad event: unknown kind "${x.kind}"`);
  }
  if (!isFleetProvisionEvent(x)) {
    throw new Error(`bad event: missing or invalid fields for kind "${x.kind}"`);
  }
  return JSON.stringify(x) + "\n";
}
