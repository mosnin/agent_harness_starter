/**
 * Hades desktop migration wire protocol (`migrate.*`).
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the one-command
 * move off a real Hermes/OpenClaw install (`src/hades/migrate/**`), the same
 * engine `hades migrate` drives from a terminal:
 *
 *  - `migrate.scan` -> `migrate.sources` — real cross-platform discovery plus
 *    a real read of every source found (item counts by kind, read errors,
 *    and the NAMES of any API keys found).
 *  - `migrate.plan` -> `migrate.plan` — the deterministic, hash-stable plan
 *    (`dryRun: true`, i.e. a preview the applier itself refuses to write).
 *  - `migrate.apply` -> `migrate.applied` — the real transactional apply.
 *    It carries `confirm: true` explicitly: a renderer that forgets it gets
 *    a preview, never a surprise write, exactly like `--yes` on the CLI.
 *  - `migrate.receipts` -> `migrate.receipts` — the hash-chained receipt log
 *    with its verification verdict.
 *  - any failure -> `migrate.error` (never silence, never a fabricated "ok").
 *
 * ## What deliberately never crosses this wire
 *
 * Secret MATERIAL. A discovered API key lives only in the process-local
 * `SecretVault` (`src/hades/migrate/secrets.ts`); the wire carries the
 * env-var NAME, the provider guess and a boolean — never the value, never a
 * prefix of it. The same rule applies to plan actions, which are metadata by
 * construction (`PlannedAction` has no value field).
 *
 * This module mirrors `./state-contract.ts`'s conventions exactly (same guard
 * shapes, same exhaustiveness assertions, same codec error style) and is
 * intentionally standalone — it imports nothing, so merging it into
 * `./contract.ts`'s unions introduces no coupling in either direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** One discovered (and read) foreign install, as the desktop UI understands it. */
export interface MigrateSourceView {
  vendor: string;
  layout: string;
  root: string;
  confidence: number;
  version?: string;
  itemCount: number;
  warnings: string[];
  /** False when this row is a duplicate layout match for a root already read once. */
  read: boolean;
}

/** A scan result: what was searched, what was found, what could not be used. */
export interface MigrateScanView {
  sources: MigrateSourceView[];
  searched: string[];
  skipped: Array<{ path: string; reason: string }>;
  readErrors: Array<{ path: string; reason: string }>;
  notes: string[];
  /** Env-var NAMES only — never key material. */
  secretEnvVars: string[];
}

/** One planned action, flattened for display. Metadata only; no item content. */
export interface MigrateActionView {
  itemKey: string;
  kind: string;
  action: string;
  reason: string;
  vendor: string;
  sourcePath: string;
  risk: string;
  itemHash: string;
  renamedTo?: string;
}

/** A full migration plan, as the desktop UI understands it. */
export interface MigratePlanView {
  createdAt: number;
  dryRun: boolean;
  planHash: string;
  sources: Array<{ vendor: string; root: string; layout: string; itemCount: number }>;
  actions: MigrateActionView[];
  blockers: Array<{ code: string; message: string; path?: string }>;
  unimportable: Array<{ path: string; kind: string; reason: string; vendor: string }>;
  warnings: string[];
  byAction: Array<{ action: string; count: number }>;
  byKind: Array<{ kind: string; count: number }>;
  destructive: number;
  secretsToWrite: number;
  alreadyImported: number;
}

/** The result of a real apply (or of a refusal to start one). */
export interface MigrateApplyView {
  applied: number;
  failed: number;
  quarantined: number;
  secretsWritten: number;
  rolledBack: boolean;
  durationMs: number;
  receiptPath: string;
  receiptHead: string;
  /** Set (with nothing applied) when the plan had blockers and was refused. */
  refused?: string;
  outcomes: Array<{ itemKey: string; action: string; ok: boolean; detail: string }>;
}

/** The on-disk receipt chain and its verification verdict. */
export interface MigrateReceiptsView {
  receiptPath: string;
  total: number;
  ok: number;
  failed: number;
  chainOk: boolean;
  brokenAt?: number;
  lastAt?: number;
  byAction: Array<{ action: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

/** Options shared by `migrate.plan` and `migrate.apply` (mirrors the CLI flags). */
export interface MigrateRequestOptions {
  from?: string;
  vendor?: "hermes" | "openclaw" | "auto";
  conflict?: "skip" | "overwrite" | "rename" | "newest" | "ask";
  /** Restrict the migration to these artifact kinds (mirrors `--only`). */
  only?: MigrateArtifactKind[];
  /** Drop these artifact kinds from the migration (mirrors `--exclude`). */
  exclude?: MigrateArtifactKind[];
  /** Default true; false is the wire equivalent of `--no-keys`. */
  importSecrets?: boolean;
}

/**
 * The artifact kinds a migration can carry. Declared here (rather than
 * imported from `src/hades/migrate/ir.ts`) to keep this contract module
 * standalone and dependency-free, exactly like its sibling contracts; the
 * engine's own `ArtifactKind` union is the source of truth and
 * `migrate-service.ts` is where the two meet.
 */
export const MIGRATE_ARTIFACT_KINDS = [
  "config",
  "model",
  "memory",
  "context-file",
  "session",
  "skill",
  "secret",
  "tool-state",
  "unknown",
] as const;

export type MigrateArtifactKind = (typeof MIGRATE_ARTIFACT_KINDS)[number];

export type MigrateCommand =
  | ({ kind: "migrate.scan" } & MigrateRequestOptions)
  | ({ kind: "migrate.plan" } & MigrateRequestOptions)
  | ({ kind: "migrate.apply"; confirm: boolean } & MigrateRequestOptions)
  | { kind: "migrate.receipts" };

export type MigrateEvent =
  | { kind: "migrate.sources"; scan: MigrateScanView; at: number }
  | { kind: "migrate.plan"; plan: MigratePlanView; scan: MigrateScanView; at: number }
  | { kind: "migrate.applied"; result: MigrateApplyView; plan: MigratePlanView; at: number }
  | { kind: "migrate.receipts"; receipts: MigrateReceiptsView; at: number }
  | { kind: "migrate.error"; op: string; message: string; at: number };

export const MIGRATE_COMMAND_KINDS = [
  "migrate.scan",
  "migrate.plan",
  "migrate.apply",
  "migrate.receipts",
] as const satisfies readonly MigrateCommand["kind"][];

export const MIGRATE_EVENT_KINDS = [
  "migrate.sources",
  "migrate.plan",
  "migrate.applied",
  "migrate.receipts",
  "migrate.error",
] as const satisfies readonly MigrateEvent["kind"][];

// Compile-time exhaustiveness in BOTH directions: a kind added to a union
// without being added to its tuple (or vice versa) fails to type-check.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [Union] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<MigrateCommand["kind"], typeof MIGRATE_COMMAND_KINDS> = true;
const _eventKindsExact: ExactlyKindsOf<MigrateEvent["kind"], typeof MIGRATE_EVENT_KINDS> = true;
void _commandKindsExact;
void _eventKindsExact;

// ---------------------------------------------------------------------------
// Primitive guards (same shape as ./state-contract.ts, including its
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

function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || typeof x === "string";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNonNegativeInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

function isOptionalNonNegativeInt(x: unknown): x is number | undefined {
  return x === undefined || isNonNegativeInt(x);
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

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(isString);
}

function isPathReasonArray(x: unknown): x is Array<{ path: string; reason: string }> {
  return Array.isArray(x) && x.every((e) => isPlainObject(e) && isString(e.path) && isString(e.reason));
}

function isCountArray(x: unknown, field: string): boolean {
  return Array.isArray(x) && x.every((e) => isPlainObject(e) && isString(e[field]) && isNonNegativeInt(e.count));
}

const VENDOR_FILTERS = ["hermes", "openclaw", "auto"] as const;
const CONFLICT_POLICIES = ["skip", "overwrite", "rename", "newest", "ask"] as const;

function isOptionalKindList(x: unknown): x is MigrateArtifactKind[] | undefined {
  return x === undefined || (Array.isArray(x) && x.every((k) => isOneOf(k, MIGRATE_ARTIFACT_KINDS)));
}

function hasValidRequestOptions(x: Record<string, unknown>): boolean {
  return (
    isOptionalString(x.from) &&
    (x.vendor === undefined || isOneOf(x.vendor, VENDOR_FILTERS)) &&
    (x.conflict === undefined || isOneOf(x.conflict, CONFLICT_POLICIES)) &&
    isOptionalKindList(x.only) &&
    isOptionalKindList(x.exclude) &&
    isOptionalBoolean(x.importSecrets)
  );
}

// ---------------------------------------------------------------------------
// View-model guards
// ---------------------------------------------------------------------------

export function isMigrateSourceView(x: unknown): x is MigrateSourceView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.vendor) &&
    isString(x.layout) &&
    isString(x.root) &&
    isNumber(x.confidence) &&
    isOptionalString(x.version) &&
    isNonNegativeInt(x.itemCount) &&
    isStringArray(x.warnings) &&
    isBoolean(x.read)
  );
}

export function isMigrateScanView(x: unknown): x is MigrateScanView {
  if (!isPlainObject(x)) return false;
  return (
    Array.isArray(x.sources) &&
    x.sources.every(isMigrateSourceView) &&
    isStringArray(x.searched) &&
    isPathReasonArray(x.skipped) &&
    isPathReasonArray(x.readErrors) &&
    isStringArray(x.notes) &&
    isStringArray(x.secretEnvVars)
  );
}

function isMigrateActionView(x: unknown): x is MigrateActionView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.itemKey) &&
    isString(x.kind) &&
    isString(x.action) &&
    isString(x.reason) &&
    isString(x.vendor) &&
    isString(x.sourcePath) &&
    isString(x.risk) &&
    isString(x.itemHash) &&
    isOptionalString(x.renamedTo)
  );
}

export function isMigratePlanView(x: unknown): x is MigratePlanView {
  if (!isPlainObject(x)) return false;
  return (
    isNumber(x.createdAt) &&
    isBoolean(x.dryRun) &&
    isString(x.planHash) &&
    Array.isArray(x.sources) &&
    x.sources.every(
      (s: unknown) =>
        isPlainObject(s) && isString(s.vendor) && isString(s.root) && isString(s.layout) && isNonNegativeInt(s.itemCount),
    ) &&
    Array.isArray(x.actions) &&
    x.actions.every(isMigrateActionView) &&
    Array.isArray(x.blockers) &&
    x.blockers.every((b: unknown) => isPlainObject(b) && isString(b.code) && isString(b.message) && isOptionalString(b.path)) &&
    Array.isArray(x.unimportable) &&
    x.unimportable.every(
      (u: unknown) => isPlainObject(u) && isString(u.path) && isString(u.kind) && isString(u.reason) && isString(u.vendor),
    ) &&
    isStringArray(x.warnings) &&
    isCountArray(x.byAction, "action") &&
    isCountArray(x.byKind, "kind") &&
    isNonNegativeInt(x.destructive) &&
    isNonNegativeInt(x.secretsToWrite) &&
    isNonNegativeInt(x.alreadyImported)
  );
}

export function isMigrateApplyView(x: unknown): x is MigrateApplyView {
  if (!isPlainObject(x)) return false;
  return (
    isNonNegativeInt(x.applied) &&
    isNonNegativeInt(x.failed) &&
    isNonNegativeInt(x.quarantined) &&
    isNonNegativeInt(x.secretsWritten) &&
    isBoolean(x.rolledBack) &&
    isNumber(x.durationMs) &&
    isString(x.receiptPath) &&
    isString(x.receiptHead) &&
    isOptionalString(x.refused) &&
    Array.isArray(x.outcomes) &&
    x.outcomes.every(
      (o: unknown) =>
        isPlainObject(o) && isString(o.itemKey) && isString(o.action) && isBoolean(o.ok) && isString(o.detail),
    )
  );
}

export function isMigrateReceiptsView(x: unknown): x is MigrateReceiptsView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.receiptPath) &&
    isNonNegativeInt(x.total) &&
    isNonNegativeInt(x.ok) &&
    isNonNegativeInt(x.failed) &&
    isBoolean(x.chainOk) &&
    isOptionalNonNegativeInt(x.brokenAt) &&
    (x.lastAt === undefined || isNumber(x.lastAt)) &&
    isCountArray(x.byAction, "action")
  );
}

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

export function isMigrateCommand(x: unknown): x is MigrateCommand {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "migrate.scan":
    case "migrate.plan":
      return hasValidRequestOptions(x);
    case "migrate.apply":
      // `confirm` is REQUIRED (and must be a real boolean): applying is the
      // one command here that writes, so it can never be reached by a
      // payload that merely forgot a field.
      return isBoolean(x.confirm) && hasValidRequestOptions(x);
    case "migrate.receipts":
      return true;
    default:
      return false;
  }
}

export function isMigrateEvent(x: unknown): x is MigrateEvent {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "migrate.sources":
      return isMigrateScanView(x.scan) && isNumber(x.at);
    case "migrate.plan":
      return isMigratePlanView(x.plan) && isMigrateScanView(x.scan) && isNumber(x.at);
    case "migrate.applied":
      return isMigrateApplyView(x.result) && isMigratePlanView(x.plan) && isNumber(x.at);
    case "migrate.receipts":
      return isMigrateReceiptsView(x.receipts) && isNumber(x.at);
    case "migrate.error":
      return isString(x.op) && isString(x.message) && isNumber(x.at);
    default:
      return false;
  }
}
