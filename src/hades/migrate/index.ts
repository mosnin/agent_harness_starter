/**
 * @module hades/migrate
 *
 * One-command migration off Hermes / OpenClaw and onto Hades.
 *
 * The pipeline is five real stages, each independently testable and each
 * honest about what it could not do:
 *
 *  1. **discover** (`./discovery`) — find real installs across platforms,
 *     env-var overrides, XDG, macOS/Windows app-data and the legacy
 *     pre-rename OpenClaw directories, scoring every (layout, root) pair.
 *  2. **read** (`./hermes-source`, `./openclaw-source`, `./sqlite-read`,
 *     `./secrets`) — parse every artifact shape (JSON/JSONC config, dotenv,
 *     Markdown context files, JSONL sessions, SKILL.md skills, and real
 *     SQLite databases via a dependency-free reader) into the canonical IR.
 *  3. **canonicalize** (`./ir`) — deterministic hashing, key grammar,
 *     validation (including secret-material leak detection) and
 *     order-independent bundle merging.
 *  4. **plan** (`./plan`, `./report`) — a pure, deterministic conflict
 *     engine producing a hash-stable plan plus terminal/JSON renderings.
 *  5. **apply** (`./apply`) — a transactional, hash-chained, resumable
 *     applier against the REAL engine (memory + STYX write-guard, sessions,
 *     config, model selection, the SKILL.md library, context files and a
 *     0600 secrets file), with full rollback on first failure.
 *
 * Surfaces: `hades migrate <scan|plan|apply|report|selftest>`
 * (`../cli/migrate-command.ts`) and the desktop `migrate.*` IPC lane
 * (`src/desktop/core/migrate-service.ts`) — both driven by the same
 * pipeline functions, never by re-implementations.
 *
 * Naming note: four exports collide with unrelated names elsewhere in the
 * Hades barrel (`ApplyResult` in `skills/holdout`, `ConflictPolicy` in
 * `state/sync`, `canonicalJson`/`CanonicalJsonError` in `state/record`). They are re-exported here
 * under unambiguous `Migration*`/`Migrate*` names so the root barrel stays
 * unambiguous; the original names remain importable from their own modules.
 */

// -- Canonical IR -----------------------------------------------------------
export {
  CanonicalJsonError as MigrationCanonicalJsonError,
  CANONICAL_JSON_MAX_DEPTH,
  CANONICAL_JSON_MAX_LENGTH,
  ITEM_KEY_SCHEMES,
  canonicalJson as canonicalMigrationJson,
  itemHash,
  makeItem,
  mergeBundles,
  validateBundle,
} from "./ir";
export type { ArtifactKind, MigrateVendor, MigrationBundle, MigrationItem } from "./ir";

// -- Discovery --------------------------------------------------------------
export { SOURCE_LAYOUTS, discoverSources, nodeFsProbe } from "./discovery";
export type {
  DiscoveredSource,
  DiscoveryOptions,
  FsProbe,
  SourceLayout,
  SourceLayoutArtifactRule,
  SourceLayoutMarker,
  SourceLayoutRootSpec,
  SourceLayoutVersionMarker,
} from "./discovery";

// -- Encoded stores ---------------------------------------------------------
export { PureSqliteReader, isSqliteFile, openSqlite } from "./sqlite-read";
export type { SqliteCell, SqliteColumn, SqliteOpenFailure, SqliteReader } from "./sqlite-read";

// -- Secrets (leak-proof vault + provider classification) -------------------
export {
  SecretVault,
  classifyProviderKey,
  harvestConfigSecrets,
  looksLikeKeyMaterial,
  parseEnvFile,
  redactValue,
  scanShellProfile,
} from "./secrets";
export type { SecretDescriptor } from "./secrets";

// -- Vendor adapters --------------------------------------------------------
export { HERMES_ARTIFACTS, readHermesSource } from "./hermes-source";
export type {
  ArtifactRule,
  SourceReadDeps,
  SecretDescriptor as SourceSecretDescriptor,
  SecretVault as SourceSecretVault,
  SecretVaultEntry as SourceSecretVaultEntry,
} from "./hermes-source";
export { OPENCLAW_ARTIFACTS, OPENCLAW_LEGACY_KEY_RENAME_MAP, parseJsonc, readOpenClawSource } from "./openclaw-source";

// -- Real fixture corpus (drives `hades migrate selftest`) ------------------
export {
  materializeHermesFixture,
  materializeLegacyClawdbotFixture,
  materializeLegacyMoltbotFixture,
  materializeOpenClawFixture,
} from "./fixtures";
export type { CorruptOption, FixtureManifest, FixtureOptions, FixtureVendorLabel } from "./fixtures";

// -- Planner + renderer -----------------------------------------------------
export { buildMigrationPlan } from "./plan";
export type {
  BlockerCode,
  MigrateOptions,
  MigrationPlan,
  PlannedAction,
  PlannedActionKind,
  TargetProbe,
  ConflictPolicy as MigrateConflictPolicy,
} from "./plan";
export { renderApplyReport, renderDiff, renderPlanJson, renderPlanText } from "./report";
export type { ApplyOutcome } from "./report";

// -- Transactional applier --------------------------------------------------
export { applyMigrationPlan, defaultApplyFsOps, probeTarget, readReceipts, receiptsPath } from "./apply";
export type {
  ApplyDeps,
  ApplyFsOps,
  ApplyLockHandle,
  MigrationReceipt,
  ApplyResult as MigrationApplyResult,
} from "./apply";
