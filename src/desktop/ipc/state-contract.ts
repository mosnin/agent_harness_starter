/**
 * Hades desktop workspace-state wire protocol.
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the shared,
 * hash-chained `WorkspaceStore` every surface (CLI, desktop, TUI) reads and
 * writes (`src/hades/state/**`): `state.status` answered by a
 * `WorkspaceStatusView` snapshot of the store's journal head + per-domain
 * counts, `state.list`/`state.get` answered by `state.records` batches,
 * `state.set`/`state.delete` answered by the resulting `state.records` (or a
 * `state.error`), and `state.sync` answered by a `state.synced` report (or a
 * `state.error`). `state.watch` toggles live delivery; live deltas stream as
 * `state.changed` events pushed out-of-band from a `StateService`
 * subscription — never as a reply to any single command. The `StateCommand`
 * union flows renderer -> sidecar, `StateEvent` flows sidecar -> renderer,
 * exactly like `Command`/`AppEvent`.
 *
 * This module mirrors `./contract.ts` / `./fleet-contract.ts` /
 * `./schedule-contract.ts` conventions exactly (same guard shapes, same
 * codec error-message style) so it is ready to be merged into the
 * `Command`/`AppEvent` unions there. It is intentionally standalone: pure,
 * deterministic, dependency-free — it does not import from `./contract.ts`
 * (or anywhere else) so the merge can happen without introducing a coupling
 * in either direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/**
 * One workspace record, as the desktop UI understands it. Mirrors
 * `WorkspaceRecord` (`../../hades/state/record.ts`) field-for-field except
 * `clock` (the raw vector clock is an implementation detail no view needs)
 * and typing `value` as `unknown` rather than `JsonValue | null` — the
 * renderer treats it as opaque data to render, never to re-serialize.
 */
export interface WorkspaceRecordView {
  domain: string;
  key: string;
  rev: number;
  updatedAt: number;
  actor: string;
  deleted: boolean;
  hash: string;
  value: unknown;
}

/** A full workspace status snapshot for the desktop shell. */
export interface WorkspaceStatusView {
  root: string;
  actor: string;
  journalSeq: number;
  head: string;
  chainOk: boolean;
  perDomain: Array<{ domain: string; records: number; lastUpdatedAt: number }>;
  /** `null` iff no `state.sync` has ever completed against this service. */
  lastSyncAt: number | null;
  conflicts: number;
}

/** One genuinely-concurrent conflict a sync reconciliation resolved (or deferred). Mirrors `SyncConflict` (`../../hades/state/sync.ts`), with `local`/`remote` flattened to their actor identity — the renderer wants "who", not the full competing record. */
export interface WorkspaceConflictView {
  domain: string;
  key: string;
  localActor: string;
  remoteActor: string;
  resolution: "local" | "remote" | "deferred";
  reason: string;
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type StateCommand =
  | { kind: "state.status" }
  | { kind: "state.list"; domain: string; prefix?: string }
  | { kind: "state.get"; domain: string; key: string }
  | { kind: "state.set"; domain: string; key: string; value: unknown }
  | { kind: "state.delete"; domain: string; key: string }
  | { kind: "state.sync"; dryRun?: boolean; policy?: string }
  | { kind: "state.watch"; enabled: boolean };

export type StateEvent =
  | { kind: "state.status"; status: WorkspaceStatusView }
  | { kind: "state.records"; domain: string; records: WorkspaceRecordView[] }
  | { kind: "state.changed"; seq: number; actor: string; records: WorkspaceRecordView[] }
  | { kind: "state.synced"; pulled: number; pushed: number; conflicts: WorkspaceConflictView[]; dryRun: boolean; at: number }
  | { kind: "state.error"; op: string; message: string };

export const STATE_COMMAND_KINDS = [
  "state.status",
  "state.list",
  "state.get",
  "state.set",
  "state.delete",
  "state.sync",
  "state.watch",
] as const satisfies readonly StateCommand["kind"][];

export const STATE_EVENT_KINDS = [
  "state.status",
  "state.records",
  "state.changed",
  "state.synced",
  "state.error",
] as const satisfies readonly StateEvent["kind"][];

// Compile-time exhaustiveness: fails to type-check if a kind is added to the
// `StateCommand`/`StateEvent` unions without adding it to the tuples above
// (or vice versa) — a mismatch in either direction breaks these assignments.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [
  Union,
] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<StateCommand["kind"], typeof STATE_COMMAND_KINDS> = true;
const _eventKindsExact: ExactlyKindsOf<StateEvent["kind"], typeof STATE_EVENT_KINDS> = true;
void _commandKindsExact;
void _eventKindsExact;

// ---------------------------------------------------------------------------
// Primitive type helpers
// ---------------------------------------------------------------------------

/**
 * Rejects `null`/arrays AND any object whose own-property key list contains
 * `"__proto__"` or `"constructor"` — a hostile payload that survived
 * `JSON.parse` (which sets these as ordinary own properties, never as the
 * real prototype link) must never be treated as a well-formed command/event
 * shape, even if every OTHER field would otherwise validate. This is the
 * one deliberate divergence from `fleet-contract.ts`/`schedule-contract.ts`'s
 * `isPlainObject`, added because this module's `state.set`'s `value: unknown`
 * accepts arbitrary caller-supplied shapes far more permissive than any
 * other command in the desktop IPC surface.
 */
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

function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || typeof x === "string";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNonNegativeInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

function isNullableNumber(x: unknown): x is number | null {
  return x === null || isNumber(x);
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

function isOptionalBoolean(x: unknown): x is boolean | undefined {
  return x === undefined || typeof x === "boolean";
}

function isOneOf<T extends string>(x: unknown, values: readonly T[]): x is T {
  return typeof x === "string" && (values as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// View model guards
// ---------------------------------------------------------------------------

const CONFLICT_RESOLUTIONS = ["local", "remote", "deferred"] as const;

export function isWorkspaceRecordView(x: unknown): x is WorkspaceRecordView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.domain) &&
    isString(x.key) &&
    isNumber(x.rev) &&
    isNumber(x.updatedAt) &&
    isString(x.actor) &&
    isBoolean(x.deleted) &&
    isString(x.hash) &&
    "value" in x
  );
}

function isPerDomainEntry(x: unknown): x is { domain: string; records: number; lastUpdatedAt: number } {
  if (!isPlainObject(x)) return false;
  return isString(x.domain) && isNonNegativeInt(x.records) && isNumber(x.lastUpdatedAt);
}

export function isWorkspaceStatusView(x: unknown): x is WorkspaceStatusView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.root) &&
    isString(x.actor) &&
    isNonNegativeInt(x.journalSeq) &&
    isString(x.head) &&
    isBoolean(x.chainOk) &&
    Array.isArray(x.perDomain) &&
    x.perDomain.every(isPerDomainEntry) &&
    isNullableNumber(x.lastSyncAt) &&
    isNonNegativeInt(x.conflicts)
  );
}

function isWorkspaceConflictView(x: unknown): x is WorkspaceConflictView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.domain) &&
    isString(x.key) &&
    isString(x.localActor) &&
    isString(x.remoteActor) &&
    isOneOf(x.resolution, CONFLICT_RESOLUTIONS) &&
    isString(x.reason)
  );
}

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

export function isStateCommand(x: unknown): x is StateCommand {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "state.status":
      return true;
    case "state.list":
      return isString(x.domain) && isOptionalString(x.prefix);
    case "state.get":
      return isString(x.domain) && isString(x.key);
    case "state.set":
      return isString(x.domain) && isString(x.key) && "value" in x;
    case "state.delete":
      return isString(x.domain) && isString(x.key);
    case "state.sync":
      return isOptionalBoolean(x.dryRun) && isOptionalString(x.policy);
    case "state.watch":
      return isBoolean(x.enabled);
    default:
      return false;
  }
}

export function isStateEvent(x: unknown): x is StateEvent {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "state.status":
      return isWorkspaceStatusView(x.status);
    case "state.records":
      return isString(x.domain) && Array.isArray(x.records) && x.records.every(isWorkspaceRecordView);
    case "state.changed":
      return (
        isNonNegativeInt(x.seq) &&
        isString(x.actor) &&
        Array.isArray(x.records) &&
        x.records.every(isWorkspaceRecordView)
      );
    case "state.synced":
      return (
        isNonNegativeInt(x.pulled) &&
        isNonNegativeInt(x.pushed) &&
        Array.isArray(x.conflicts) &&
        x.conflicts.every(isWorkspaceConflictView) &&
        isBoolean(x.dryRun) &&
        isNumber(x.at)
      );
    case "state.error":
      return isString(x.op) && isString(x.message);
    default:
      return false;
  }
}
