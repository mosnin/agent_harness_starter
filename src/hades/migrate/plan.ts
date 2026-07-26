/**
 * The migration conflict engine: turns real {@link MigrationBundle}s (read by
 * `hermes-source.ts` / an OpenClaw-equivalent reader) plus a probe of the
 * live Hades install ({@link TargetProbe}) into a total, explicit
 * {@link MigrationPlan} -- exactly one {@link PlannedAction} (or an
 * `unimportable` entry) for every single discovered artifact, under an
 * explicit {@link ConflictPolicy}.
 *
 * `buildMigrationPlan` is PURE: no filesystem, no clock (`now` arrives via
 * `MigrateOptions.now`), no environment reads. Everything it needs is either
 * already inside the `MigrationBundle`s (built by the pure T1 readers) or
 * inside the caller-supplied `TargetProbe` -- a plain snapshot of "what does
 * the live Hades install currently look like", never fetched by this module
 * itself. This is what makes the whole conflict engine deterministic,
 * fuzzable, and safe to run in a dry-run loop as many times as a user wants
 * before ever touching disk.
 *
 * ## Determinism and "provably lossless"
 *
 * Every physical {@link MigrationItem} (from every bundle) produces EXACTLY
 * ONE outcome: either a {@link PlannedAction} in `actions`, or an entry in
 * `unimportable`. Nothing is ever silently dropped. `unimportable` also
 * carries forward every entry a T1 reader already flagged as unreadable
 * (`bundle.unimportable`), tagged with its vendor -- so for every input
 * bundle, `actions.length + unimportable.length` (restricted to that
 * bundle's contribution) equals `bundle.items.length + bundle.unimportable.length`
 * exactly. Every candidate is processed from a single fully-sorted list
 * (sorted by kind priority, then logical key, then content hash, then
 * origin path -- never by array position), so shuffling the input `bundles`
 * array or the `items` array within a bundle produces the identical
 * `planHash`.
 *
 * ## Kind-specific conflict semantics (see individual `resolve*` functions)
 *
 *  - **memory**: deduped by a *normalized* fact-text hash (not the raw
 *    per-item hash from `ir.ts`, which is exact-text and would treat
 *    "Loves pizza" and "loves pizza." as unrelated). A near-duplicate is
 *    always `merge` -- salience max, tags unioned -- regardless of
 *    `ConflictPolicy`, because merging two memory facts never discards
 *    either side; there is no "side" for `ask`/`overwrite`/`skip` to pick.
 *  - **session**: collide by exact source id. `rename` suffixes
 *    (`<id>__migrated_2`, ...) rather than ever overwriting a transcript.
 *  - **skill**: collide by manifest name. Identical content
 *    (`bodySha256` match) is always `skip`, independent of policy. `newest`
 *    compares an optional `value.mtimeMs` on the source item against the
 *    incumbent's `mtimeMs`; when the source side carries no mtime (most
 *    real readers don't stamp one), the incumbent is conservatively treated
 *    as at least as new rather than fabricating a decision. `rename`
 *    produces a jail-safe (traversal-stripped, charset-restricted) unique
 *    name.
 *  - **config**: collide per dotted field (`config:<path>`), before/after
 *    shown via `PlannedAction.target.field`. `rename` cannot relocate a
 *    single-slot field to "another key" meaningfully, so it stores the
 *    incoming value at `<path>.imported` for manual review instead of
 *    silently discarding it.
 *  - **model**: a model id absent from `target.knownModelIds` is always
 *    `abstain` plus a `model-unknown` blocker -- Hades must never select a
 *    model it cannot run, regardless of `ConflictPolicy`.
 *  - **secret**: value material is NEVER read or stored here (`secrets` is
 *    `SecretDescriptor[]`, metadata only, exactly like a bundle's own
 *    `kind: "secret"` items). An env var already present in
 *    `target.envVarNames` is `skip` unless the policy is literally
 *    `"overwrite"` -- this one rule is intentionally independent of
 *    `rename`/`newest`/`ask`, per the locked contract: there is no safe
 *    "rename" for an environment variable another config file already
 *    references by exact name, and no timestamp to compare for `newest`.
 *  - **context-file / tool-state / unknown**: generic per-key collision
 *    handling (§ `resolveGeneric`), since `TargetProbe` carries no
 *    dedicated incumbent list for the latter two.
 *
 * ## Blockers and the "no destructive action survives a blocker" invariant
 *
 * Every {@link BlockerCode} is independently reachable (`no-sources`,
 * `source-unreadable`, `target-not-writable`, `source-is-target`,
 * `secrets-refused`, `model-unknown`, `item-limit-exceeded`,
 * `policy-requires-confirmation`). As a final, unconditional pass -- after
 * every item has already been resolved -- any action left with
 * `risk: "destructive"` is downgraded to `quarantine` / `risk: "low"`
 * whenever `blockers.length > 0`, regardless of which blocker or which
 * item triggered it. A dry-run plan with ANY unresolved blocker anywhere
 * therefore never proposes doing anything irreversible.
 */

import type { JsonValue } from "../state/record";
import { sha256Hex } from "../styx/certificate";
import { canonicalJson, itemHash as computeItemHash, makeItem } from "./ir";
import type { ArtifactKind, MigrateVendor, MigrationBundle, MigrationItem } from "./ir";
import type { HadesConfig } from "../config/config";
import type { SecretDescriptor } from "./secrets";

// ---------------------------------------------------------------------------
// Locked contract types
// ---------------------------------------------------------------------------

export type ConflictPolicy = "skip" | "overwrite" | "rename" | "newest" | "ask";

export type PlannedActionKind = "import" | "merge" | "rename" | "overwrite" | "skip" | "quarantine" | "abstain";

export interface TargetProbe {
  dataDir: string;
  memoryFacts: Array<{ id: string; fact: string; salience: number; tags: string[]; createdAt: number }>;
  sessions: Array<{ id: string; startedAt: number }>;
  skills: Array<{ name: string; path: string; version?: string; mtimeMs: number; sha256: string }>;
  config: HadesConfig;
  modelSelection?: string;
  knownModelIds: string[];
  contextFiles: Array<{ relPath: string; sha256: string }>;
  envVarNames: string[];
  secretsFilePath: string;
  writable: Record<string, boolean>;
  priorReceipts: Array<{ itemKey: string; itemHash: string; action: PlannedActionKind; at: number }>;
}

export interface MigrateOptions {
  only?: ArtifactKind[];
  exclude?: ArtifactKind[];
  conflict: ConflictPolicy;
  importSecrets: boolean;
  dryRun: boolean;
  maxItems?: number;
  now: number;
}

export interface PlannedAction {
  itemKey: string;
  kind: ArtifactKind;
  action: PlannedActionKind;
  reason: string;
  vendor: MigrateVendor;
  sourcePath: string;
  target: { path?: string; id?: string; field?: string };
  conflict?: { with: string; policy: ConflictPolicy; incumbentNewer: boolean };
  renamedTo?: string;
  risk: "none" | "low" | "destructive";
  itemHash: string;
}

export type BlockerCode =
  | "no-sources"
  | "source-unreadable"
  | "target-not-writable"
  | "source-is-target"
  | "secrets-refused"
  | "model-unknown"
  | "item-limit-exceeded"
  | "policy-requires-confirmation";

export interface MigrationPlan {
  createdAt: number;
  sources: Array<{ vendor: MigrateVendor; root: string; layout: string; itemCount: number }>;
  actions: PlannedAction[];
  unimportable: Array<{ path: string; kind: ArtifactKind; reason: string; vendor: MigrateVendor }>;
  blockers: Array<{ code: BlockerCode; message: string; path?: string }>;
  warnings: string[];
  summary: {
    byKind: Record<string, number>;
    byAction: Record<PlannedActionKind, number>;
    destructive: number;
    secretsToWrite: number;
    alreadyImported: number;
  };
  dryRun: boolean;
  planHash: string;
}

// ---------------------------------------------------------------------------
// Small deterministic utilities
// ---------------------------------------------------------------------------

const ARTIFACT_KINDS: readonly ArtifactKind[] = Object.freeze([
  "config",
  "model",
  "memory",
  "context-file",
  "session",
  "skill",
  "secret",
  "tool-state",
  "unknown",
]);

/** Processing / presentation order: config+model resolve before memory; skills before anything that could reference them. */
const KIND_ORDER: readonly ArtifactKind[] = Object.freeze([
  "config",
  "model",
  "skill",
  "context-file",
  "memory",
  "session",
  "secret",
  "tool-state",
  "unknown",
]);

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function kindPriority(k: ArtifactKind): number {
  const idx = KIND_ORDER.indexOf(k);
  return idx === -1 ? KIND_ORDER.length : idx;
}

function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

function isJsonObject(v: JsonValue): v is { [k: string]: JsonValue } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function getStringField(v: JsonValue, field: string): string | undefined {
  if (!isJsonObject(v)) return undefined;
  const x = v[field];
  return typeof x === "string" ? x : undefined;
}

function getNumberField(v: JsonValue, field: string): number | undefined {
  if (!isJsonObject(v)) return undefined;
  const x = v[field];
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function getDottedField(root: HadesConfig, dottedPath: string): JsonValue | undefined {
  let cur: unknown = root;
  for (const part of dottedPath.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) return undefined;
  }
  return cur as JsonValue;
}

function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

/** True when both timestamps are known and `existingMs` is at least as recent as `sourceMs` -- the conservative default when either is unknown. */
function incumbentIsAtLeastAsNew(existingMs: number | undefined, sourceMs: number | undefined): boolean {
  if (existingMs === undefined || sourceMs === undefined) return true;
  return existingMs >= sourceMs;
}

const SAFE_NAME_RE = /[^A-Za-z0-9_.-]/g;

/** Strips path-traversal / unsafe characters down to the same charset `ir.ts`'s skill/session key grammar allows. */
function jailSafeName(raw: string): string {
  let s = raw.replace(/\0/g, "").replace(/\.\./g, "_").replace(SAFE_NAME_RE, "_");
  s = s.replace(/^[^A-Za-z0-9]+/, "");
  return s.length > 0 ? s : "item";
}

/** Produces a jail-safe name guaranteed not to satisfy `taken(...)`, suffixing `__migrated_2`, `__migrated_3`, ... deterministically. */
function uniqueSuffixedName(base: string, taken: (name: string) => boolean): string {
  const safeBase = jailSafeName(base);
  if (!taken(safeBase)) return safeBase;
  let n = 2;
  let candidate = `${safeBase}__migrated_${n}`;
  while (taken(candidate)) {
    n++;
    candidate = `${safeBase}__migrated_${n}`;
  }
  return candidate;
}

function normalizeFactText(fact: string): string {
  return fact
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/, "");
}

function normalizedFactHash(fact: string): string {
  return sha256Hex(normalizeFactText(fact)).slice(0, 16);
}

function isIncluded(kind: ArtifactKind, options: MigrateOptions): boolean {
  if (options.only && !options.only.includes(kind)) return false;
  if (options.exclude && options.exclude.includes(kind)) return false;
  return true;
}

/** Best-effort attribution of a path-only descriptor (no vendor of its own) to one of the input bundles' vendor/root. */
function inferVendorAndRoot(
  originPath: string,
  bundles: MigrationBundle[],
): { vendor: MigrateVendor; root: string; inferred: boolean } {
  const match = bundles.find((b) => originPath.startsWith(b.root));
  if (match) return { vendor: match.vendor, root: match.root, inferred: false };
  if (bundles.length === 1) return { vendor: bundles[0].vendor, root: bundles[0].root, inferred: false };
  return { vendor: "hermes", root: "", inferred: true };
}

// ---------------------------------------------------------------------------
// Candidate list: every bundle item + every top-level secret descriptor,
// normalized to one uniform shape and sorted once, deterministically.
// ---------------------------------------------------------------------------

interface Candidate {
  item: MigrationItem;
  vendor: MigrateVendor;
  bundleRoot: string;
  fromBundle: boolean;
}

function buildCandidates(
  bundles: MigrationBundle[],
  secrets: SecretDescriptor[],
  warnings: string[],
): Candidate[] {
  const out: Candidate[] = [];
  for (const b of bundles) {
    for (const item of b.items) {
      out.push({ item, vendor: b.vendor, bundleRoot: b.root, fromBundle: true });
    }
  }

  let vendorInferredCount = 0;
  for (const d of secrets) {
    const { vendor, root, inferred } = inferVendorAndRoot(d.origin.path, bundles);
    if (inferred) vendorInferredCount++;
    const value: JsonValue = {
      envVar: d.envVar,
      provider: d.provider,
      fingerprint: d.fingerprint,
      length: d.length,
      looksValid: d.looksValid,
      ...(d.note !== undefined ? { note: d.note } : {}),
    };
    const item = makeItem({
      kind: "secret",
      key: `secret:${d.envVar}`,
      value,
      origin: { path: d.origin.path, locator: d.origin.locator },
      confidence: d.confidence,
      notes: d.note ? [d.note] : undefined,
    });
    out.push({ item, vendor, bundleRoot: root, fromBundle: false });
  }
  if (vendorInferredCount > 0) {
    warnings.push(
      `${vendorInferredCount} secret descriptor(s) could not be attributed to a specific discovered source root; defaulted to vendor "hermes" for display purposes`,
    );
  }

  out.sort((a, b) => {
    return (
      kindPriority(a.item.kind) - kindPriority(b.item.kind) ||
      cmp(a.item.key, b.item.key) ||
      cmp(a.item.hash, b.item.hash) ||
      cmp(a.item.origin.path, b.item.origin.path) ||
      cmp(a.vendor, b.vendor)
    );
  });
  return out;
}

// ---------------------------------------------------------------------------
// Mutable resolution state, threaded through the single candidate pass
// ---------------------------------------------------------------------------

interface ResolutionState {
  usedItemKeys: Set<string>;
  memoryGroups: Map<string, { status: "target" | "run"; incumbentId?: string }>;
  claimedSessions: Map<string, { startedAt?: number }>;
  claimedSkills: Map<string, { sha256?: string; mtimeMs?: number }>;
  claimedContextFiles: Map<string, string>;
  claimedEnvVars: Map<string, "target" | "run">;
  effectiveConfig: Map<string, JsonValue>;
  claimedGeneric: Map<string, string>;
  currentModel?: string;
  notWritableKinds: Set<ArtifactKind>;
  unknownModelIds: Set<string>;
  secretsRefusedCount: number;
  askAffectedCount: number;
}

function initState(target: TargetProbe): ResolutionState {
  const memoryGroups = new Map<string, { status: "target" | "run"; incumbentId?: string }>();
  const byHash = new Map<string, string[]>();
  for (const mf of target.memoryFacts) {
    const h = normalizedFactHash(mf.fact);
    const arr = byHash.get(h) ?? [];
    arr.push(mf.id);
    byHash.set(h, arr);
  }
  for (const [h, ids] of byHash) {
    const chosen = [...ids].sort(cmp)[0];
    memoryGroups.set(h, { status: "target", incumbentId: chosen });
  }

  const claimedSessions = new Map<string, { startedAt?: number }>();
  for (const s of target.sessions) claimedSessions.set(s.id, { startedAt: s.startedAt });

  const claimedSkills = new Map<string, { sha256?: string; mtimeMs?: number }>();
  for (const s of target.skills) claimedSkills.set(s.name, { sha256: s.sha256, mtimeMs: s.mtimeMs });

  const claimedContextFiles = new Map<string, string>();
  for (const c of target.contextFiles) claimedContextFiles.set(c.relPath, c.sha256);

  const claimedEnvVars = new Map<string, "target" | "run">();
  for (const e of target.envVarNames) claimedEnvVars.set(e, "target");

  return {
    usedItemKeys: new Set(),
    memoryGroups,
    claimedSessions,
    claimedSkills,
    claimedContextFiles,
    claimedEnvVars,
    effectiveConfig: new Map(),
    claimedGeneric: new Map(),
    currentModel: target.modelSelection,
    notWritableKinds: new Set(),
    unknownModelIds: new Set(),
    secretsRefusedCount: 0,
    askAffectedCount: 0,
  };
}

function uniqueItemKey(baseKey: string, item: MigrationItem, used: Set<string>): string {
  if (!used.has(baseKey)) {
    used.add(baseKey);
    return baseKey;
  }
  const suffixed = `${baseKey}#${item.hash.slice(0, 8)}`;
  if (!used.has(suffixed)) {
    used.add(suffixed);
    return suffixed;
  }
  let n = 2;
  let candidate = `${suffixed}-${n}`;
  while (used.has(candidate)) {
    n++;
    candidate = `${suffixed}-${n}`;
  }
  used.add(candidate);
  return candidate;
}

function writableFor(target: TargetProbe, kind: ArtifactKind): boolean {
  if (target.writable.dataDir === false) return false;
  return target.writable[kind] === true;
}

/** Applied to any action whose kind requires writing (import/merge/overwrite/rename); downgrades to quarantine when the target area isn't writable. */
function gateWritable(
  kind: ArtifactKind,
  action: PlannedAction,
  target: TargetProbe,
  state: ResolutionState,
): PlannedAction {
  const writeKinds: PlannedActionKind[] = ["import", "merge", "overwrite", "rename"];
  if (!writeKinds.includes(action.action)) return action;
  if (writableFor(target, kind)) return action;
  state.notWritableKinds.add(kind);
  return {
    ...action,
    action: "quarantine",
    risk: "none",
    reason: `${action.reason} (held back: target is not writable for kind "${kind}")`,
  };
}

// ---------------------------------------------------------------------------
// Per-kind resolvers
// ---------------------------------------------------------------------------

interface ResolveCtx {
  itemKey: string;
  item: MigrationItem;
  vendor: MigrateVendor;
  policy: ConflictPolicy;
  target: TargetProbe;
  state: ResolutionState;
}

function baseAction(ctx: ResolveCtx, over: Partial<PlannedAction> & Pick<PlannedAction, "action" | "reason" | "risk">): PlannedAction {
  return {
    itemKey: ctx.itemKey,
    kind: ctx.item.kind,
    vendor: ctx.vendor,
    sourcePath: ctx.item.origin.path,
    itemHash: ctx.item.hash,
    target: {},
    ...over,
  };
}

type ResolveResult = { action: PlannedAction } | { unimportable: { path: string; kind: ArtifactKind; reason: string } };

function resolveMemory(ctx: ResolveCtx): ResolveResult {
  const fact = getStringField(ctx.item.value, "fact");
  if (fact === undefined) {
    return { unimportable: { path: ctx.item.origin.path, kind: "memory", reason: "malformed memory item: value.fact is missing or not a string" } };
  }
  const hash = normalizedFactHash(fact);
  const existing = ctx.state.memoryGroups.get(hash);
  if (!existing) {
    ctx.state.memoryGroups.set(hash, { status: "run" });
    return {
      action: baseAction(ctx, {
        action: "import",
        reason: "new memory fact, no near-duplicate found in target or elsewhere in this run",
        risk: "none",
        target: { id: hash },
      }),
    };
  }
  const withDesc =
    existing.status === "target"
      ? `existing memory fact "${existing.incumbentId}"`
      : "another source memory item already planned for import in this run";
  return {
    action: baseAction(ctx, {
      action: "merge",
      reason: `near-duplicate of ${withDesc} (normalized fact text matches); merged via union of salience (max of both) and tags (set union) -- both sides are kept, nothing is discarded`,
      risk: "low",
      target: { id: existing.incumbentId ?? hash },
      conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
    }),
  };
}

function resolveSession(ctx: ResolveCtx): ResolveResult {
  const sourceId = ctx.item.key.slice("session:".length);
  const sourceStartedAt = getNumberField(ctx.item.value, "startedAt");
  const existing = ctx.state.claimedSessions.get(sourceId);
  if (!existing) {
    ctx.state.claimedSessions.set(sourceId, { startedAt: sourceStartedAt });
    return { action: baseAction(ctx, { action: "import", reason: "session id not present in target", risk: "none", target: { id: sourceId } }) };
  }
  const withDesc = `existing session "${sourceId}"`;
  switch (ctx.policy) {
    case "skip":
      return {
        action: baseAction(ctx, {
          action: "skip",
          reason: `session id "${sourceId}" already exists in target; policy=skip keeps the incumbent transcript`,
          risk: "none",
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: incumbentIsAtLeastAsNew(existing.startedAt, sourceStartedAt) },
        }),
      };
    case "overwrite": {
      ctx.state.claimedSessions.set(sourceId, { startedAt: sourceStartedAt });
      return {
        action: baseAction(ctx, {
          action: "overwrite",
          reason: `session id "${sourceId}" already exists in target; policy=overwrite replaces the incumbent transcript`,
          risk: "destructive",
          target: { id: sourceId },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: incumbentIsAtLeastAsNew(existing.startedAt, sourceStartedAt) },
        }),
      };
    }
    case "rename": {
      const newId = uniqueSuffixedName(sourceId, (n) => ctx.state.claimedSessions.has(n));
      ctx.state.claimedSessions.set(newId, { startedAt: sourceStartedAt });
      return {
        action: baseAction(ctx, {
          action: "rename",
          reason: `session id "${sourceId}" already exists in target; policy=rename imports this session under a new, non-colliding id instead of overwriting`,
          risk: "low",
          renamedTo: newId,
          target: { id: newId },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: incumbentIsAtLeastAsNew(existing.startedAt, sourceStartedAt) },
        }),
      };
    }
    case "newest": {
      if (sourceStartedAt !== undefined && existing.startedAt !== undefined && sourceStartedAt > existing.startedAt) {
        ctx.state.claimedSessions.set(sourceId, { startedAt: sourceStartedAt });
        return {
          action: baseAction(ctx, {
            action: "overwrite",
            reason: `session id "${sourceId}" collides with target; policy=newest and the source session (startedAt=${sourceStartedAt}) is more recent than the incumbent (startedAt=${existing.startedAt})`,
            risk: "destructive",
            target: { id: sourceId },
            conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: false },
          }),
        };
      }
      const reasonSuffix =
        sourceStartedAt === undefined || existing.startedAt === undefined
          ? "the source session carries no comparable timestamp, so the incumbent is conservatively kept"
          : `the incumbent (startedAt=${existing.startedAt}) is at least as recent as the source (startedAt=${sourceStartedAt})`;
      return {
        action: baseAction(ctx, {
          action: "skip",
          reason: `session id "${sourceId}" collides with target; policy=newest and ${reasonSuffix}`,
          risk: "none",
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    }
    case "ask": {
      ctx.state.askAffectedCount++;
      return {
        action: baseAction(ctx, {
          action: "abstain",
          reason: `session id "${sourceId}" already exists in target; policy=ask requires interactive confirmation before either side is chosen`,
          risk: "none",
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: incumbentIsAtLeastAsNew(existing.startedAt, sourceStartedAt) },
        }),
      };
    }
    default: {
      const _exhaustive: never = ctx.policy;
      return _exhaustive;
    }
  }
}

function resolveSkill(ctx: ResolveCtx): ResolveResult {
  const name = ctx.item.key.slice("skill:".length);
  const bodySha256 = getStringField(ctx.item.value, "bodySha256");
  const sourceMtimeMs = getNumberField(ctx.item.value, "mtimeMs");
  const existing = ctx.state.claimedSkills.get(name);
  if (!existing) {
    ctx.state.claimedSkills.set(name, { sha256: bodySha256, mtimeMs: sourceMtimeMs });
    return { action: baseAction(ctx, { action: "import", reason: `skill "${name}" not present in target`, risk: "none", target: { id: name } }) };
  }
  if (bodySha256 !== undefined && existing.sha256 !== undefined && bodySha256 === existing.sha256) {
    return {
      action: baseAction(ctx, {
        action: "skip",
        reason: `skill "${name}" already installed with identical content (sha256 match)`,
        risk: "none",
        target: { id: name },
      }),
    };
  }
  const withDesc = `existing skill "${name}"`;
  switch (ctx.policy) {
    case "skip":
      return {
        action: baseAction(ctx, {
          action: "skip",
          reason: `skill "${name}" already exists in target with different content; policy=skip keeps the incumbent`,
          risk: "none",
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: incumbentIsAtLeastAsNew(existing.mtimeMs, sourceMtimeMs) },
        }),
      };
    case "overwrite": {
      ctx.state.claimedSkills.set(name, { sha256: bodySha256, mtimeMs: sourceMtimeMs });
      return {
        action: baseAction(ctx, {
          action: "overwrite",
          reason: `skill "${name}" already exists in target with different content; policy=overwrite replaces it`,
          risk: "destructive",
          target: { id: name },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: incumbentIsAtLeastAsNew(existing.mtimeMs, sourceMtimeMs) },
        }),
      };
    }
    case "rename": {
      const newName = uniqueSuffixedName(name, (n) => ctx.state.claimedSkills.has(n));
      ctx.state.claimedSkills.set(newName, { sha256: bodySha256, mtimeMs: sourceMtimeMs });
      return {
        action: baseAction(ctx, {
          action: "rename",
          reason: `skill "${name}" already exists in target with different content; policy=rename installs this skill under a new, jail-safe unique name instead of overwriting`,
          risk: "low",
          renamedTo: newName,
          target: { id: newName },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: incumbentIsAtLeastAsNew(existing.mtimeMs, sourceMtimeMs) },
        }),
      };
    }
    case "newest": {
      if (sourceMtimeMs !== undefined && existing.mtimeMs !== undefined && sourceMtimeMs > existing.mtimeMs) {
        ctx.state.claimedSkills.set(name, { sha256: bodySha256, mtimeMs: sourceMtimeMs });
        return {
          action: baseAction(ctx, {
            action: "overwrite",
            reason: `skill "${name}" collides with target; policy=newest and the source skill (mtimeMs=${sourceMtimeMs}) is newer than the incumbent (mtimeMs=${existing.mtimeMs})`,
            risk: "destructive",
            target: { id: name },
            conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: false },
          }),
        };
      }
      const reasonSuffix =
        sourceMtimeMs === undefined
          ? "the source skill carries no mtime, so the incumbent is conservatively kept"
          : `the incumbent (mtimeMs=${existing.mtimeMs}) is at least as new as the source (mtimeMs=${sourceMtimeMs})`;
      return {
        action: baseAction(ctx, {
          action: "skip",
          reason: `skill "${name}" collides with target; policy=newest and ${reasonSuffix}`,
          risk: "none",
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    }
    case "ask": {
      ctx.state.askAffectedCount++;
      return {
        action: baseAction(ctx, {
          action: "abstain",
          reason: `skill "${name}" already exists in target with different content; policy=ask requires interactive confirmation`,
          risk: "none",
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: incumbentIsAtLeastAsNew(existing.mtimeMs, sourceMtimeMs) },
        }),
      };
    }
    default: {
      const _exhaustive: never = ctx.policy;
      return _exhaustive;
    }
  }
}

function resolveConfig(ctx: ResolveCtx): ResolveResult {
  const dottedPath = ctx.item.key.slice("config:".length);
  const after = ctx.item.value;
  const before = ctx.state.effectiveConfig.has(dottedPath)
    ? ctx.state.effectiveConfig.get(dottedPath)
    : getDottedField(ctx.target.config, dottedPath);

  if (before === undefined) {
    ctx.state.effectiveConfig.set(dottedPath, after);
    return {
      action: baseAction(ctx, {
        action: "import",
        reason: `config field "${dottedPath}" is not currently set in target`,
        risk: "low",
        target: { field: dottedPath },
      }),
    };
  }
  if (jsonEquals(before, after)) {
    return {
      action: baseAction(ctx, {
        action: "skip",
        reason: `config field "${dottedPath}" already set to this value`,
        risk: "none",
        target: { field: dottedPath },
      }),
    };
  }
  const withDesc = `current config value at "${dottedPath}"`;
  const beforeAfter = `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
  switch (ctx.policy) {
    case "skip":
      return {
        action: baseAction(ctx, {
          action: "skip",
          reason: `config field "${dottedPath}" has a different value in target; policy=skip keeps the incumbent (${beforeAfter})`,
          risk: "none",
          target: { field: dottedPath },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    case "overwrite":
      ctx.state.effectiveConfig.set(dottedPath, after);
      return {
        action: baseAction(ctx, {
          action: "overwrite",
          reason: `config field "${dottedPath}" has a different value in target; policy=overwrite replaces it (${beforeAfter})`,
          risk: "destructive",
          target: { field: dottedPath },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    case "rename": {
      const altPath = `${dottedPath}.imported`;
      return {
        action: baseAction(ctx, {
          action: "rename",
          reason: `config field "${dottedPath}" has a different value in target; policy=rename has no destination to relocate to, so the incoming value is instead recorded at "${altPath}" for manual review (${beforeAfter})`,
          risk: "low",
          renamedTo: altPath,
          target: { field: altPath },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    }
    case "newest":
      return {
        action: baseAction(ctx, {
          action: "skip",
          reason: `config field "${dottedPath}" has a different value in target; policy=newest cannot compare recency (config fields carry no per-field timestamp), so the incumbent is conservatively kept (${beforeAfter})`,
          risk: "none",
          target: { field: dottedPath },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    case "ask": {
      ctx.state.askAffectedCount++;
      return {
        action: baseAction(ctx, {
          action: "abstain",
          reason: `config field "${dottedPath}" has a different value in target; policy=ask requires interactive confirmation (${beforeAfter})`,
          risk: "none",
          target: { field: dottedPath },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    }
    default: {
      const _exhaustive: never = ctx.policy;
      return _exhaustive;
    }
  }
}

function resolveModel(ctx: ResolveCtx): ResolveResult {
  const modelId = getStringField(ctx.item.value, "modelId");
  if (modelId === undefined) {
    return { unimportable: { path: ctx.item.origin.path, kind: "model", reason: "malformed model item: value.modelId is missing or not a string" } };
  }
  if (!ctx.target.knownModelIds.includes(modelId)) {
    ctx.state.unknownModelIds.add(modelId);
    return {
      action: baseAction(ctx, {
        action: "abstain",
        reason: `model id "${modelId}" is not in target.knownModelIds; refusing to select a model Hades cannot run`,
        risk: "none",
        target: { field: "model", id: modelId },
      }),
    };
  }
  const incumbent = ctx.state.currentModel;
  if (incumbent === undefined) {
    ctx.state.currentModel = modelId;
    return { action: baseAction(ctx, { action: "import", reason: "no model currently selected in target", risk: "low", target: { field: "model", id: modelId } }) };
  }
  if (incumbent === modelId) {
    return { action: baseAction(ctx, { action: "skip", reason: "target model selection already matches this id", risk: "none", target: { field: "model", id: modelId } }) };
  }
  const withDesc = `current model selection "${incumbent}"`;
  switch (ctx.policy) {
    case "skip":
      return {
        action: baseAction(ctx, {
          action: "skip",
          reason: `target has a different model selected ("${incumbent}"); policy=skip keeps it`,
          risk: "none",
          target: { field: "model", id: modelId },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    case "overwrite":
      ctx.state.currentModel = modelId;
      return {
        action: baseAction(ctx, {
          action: "overwrite",
          reason: `target has a different model selected ("${incumbent}"); policy=overwrite replaces it with "${modelId}"`,
          risk: "destructive",
          target: { field: "model", id: modelId },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    case "rename":
      return {
        action: baseAction(ctx, {
          action: "rename",
          reason: `target has a different model selected ("${incumbent}"); policy=rename has no second "model" slot, so "${modelId}" is instead recorded as an alternate candidate rather than applied`,
          risk: "low",
          renamedTo: modelId,
          target: { field: "model.candidates", id: modelId },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    case "newest":
      return {
        action: baseAction(ctx, {
          action: "skip",
          reason: `target has a different model selected ("${incumbent}"); policy=newest cannot compare recency for a model selection (no timestamp), so the incumbent is kept`,
          risk: "none",
          target: { field: "model", id: modelId },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    case "ask": {
      ctx.state.askAffectedCount++;
      return {
        action: baseAction(ctx, {
          action: "abstain",
          reason: `target has a different model selected ("${incumbent}"); policy=ask requires interactive confirmation`,
          risk: "none",
          target: { field: "model", id: modelId },
          conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    }
    default: {
      const _exhaustive: never = ctx.policy;
      return _exhaustive;
    }
  }
}

function resolveSecret(ctx: ResolveCtx, importSecrets: boolean): ResolveResult {
  const envVar = ctx.item.key.slice("secret:".length);
  const existing = ctx.state.claimedEnvVars.get(envVar);

  if (existing === "run") {
    return {
      action: baseAction(ctx, {
        action: "skip",
        reason: `duplicate secret observation for env var "${envVar}"; already planned from another source earlier in this run`,
        risk: "none",
        target: { path: ctx.target.secretsFilePath, field: envVar },
      }),
    };
  }
  if (existing === "target") {
    if (ctx.policy === "overwrite") {
      ctx.state.claimedEnvVars.set(envVar, "run");
      return {
        action: baseAction(ctx, {
          action: "overwrite",
          reason: `env var "${envVar}" already exists in target; policy=overwrite replaces it`,
          risk: "destructive",
          target: { path: ctx.target.secretsFilePath, field: envVar },
          conflict: { with: `existing env var "${envVar}"`, policy: ctx.policy, incumbentNewer: true },
        }),
      };
    }
    return {
      action: baseAction(ctx, {
        action: "skip",
        reason: `env var "${envVar}" already exists in target; policy=${ctx.policy} keeps it (only policy=overwrite replaces an existing secret)`,
        risk: "none",
        target: { path: ctx.target.secretsFilePath, field: envVar },
        conflict: { with: `existing env var "${envVar}"`, policy: ctx.policy, incumbentNewer: true },
      }),
    };
  }
  if (!importSecrets) {
    ctx.state.secretsRefusedCount++;
    return {
      action: baseAction(ctx, {
        action: "skip",
        reason: `secret import is disabled (options.importSecrets=false); env var "${envVar}" was not written`,
        risk: "none",
        target: { path: ctx.target.secretsFilePath, field: envVar },
      }),
    };
  }
  ctx.state.claimedEnvVars.set(envVar, "run");
  return {
    action: baseAction(ctx, {
      action: "import",
      reason: `env var "${envVar}" not present in target`,
      risk: "low",
      target: { path: ctx.target.secretsFilePath, field: envVar },
    }),
  };
}

function resolveContextFile(ctx: ResolveCtx): ResolveResult {
  const relPath = ctx.item.key.slice("context:".length);
  const content = getStringField(ctx.item.value, "content");
  if (content === undefined) {
    return { unimportable: { path: ctx.item.origin.path, kind: "context-file", reason: "malformed context-file item: value.content is missing or not a string" } };
  }
  const sourceSha = sha256Hex(content);
  const existing = ctx.state.claimedContextFiles.get(relPath);
  if (existing === undefined) {
    ctx.state.claimedContextFiles.set(relPath, sourceSha);
    return { action: baseAction(ctx, { action: "import", reason: `context file "${relPath}" not present in target`, risk: "none", target: { path: relPath } }) };
  }
  if (existing === sourceSha) {
    return { action: baseAction(ctx, { action: "skip", reason: `context file "${relPath}" already present with identical content (sha256 match)`, risk: "none", target: { path: relPath } }) };
  }
  const withDesc = `existing context file "${relPath}"`;
  switch (ctx.policy) {
    case "skip":
      return { action: baseAction(ctx, { action: "skip", reason: `context file "${relPath}" differs from target; policy=skip keeps the incumbent`, risk: "none", target: { path: relPath }, conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true } }) };
    case "overwrite":
      ctx.state.claimedContextFiles.set(relPath, sourceSha);
      return { action: baseAction(ctx, { action: "overwrite", reason: `context file "${relPath}" differs from target; policy=overwrite replaces it`, risk: "destructive", target: { path: relPath }, conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true } }) };
    case "rename": {
      const newPath = uniqueSuffixedName(relPath.replace(/\.[^./]+$/, ""), (n) => ctx.state.claimedContextFiles.has(n)) + (relPath.match(/\.[^./]+$/)?.[0] ?? "");
      ctx.state.claimedContextFiles.set(newPath, sourceSha);
      return { action: baseAction(ctx, { action: "rename", reason: `context file "${relPath}" differs from target; policy=rename writes it under a new path instead of overwriting`, risk: "low", renamedTo: newPath, target: { path: newPath }, conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true } }) };
    }
    case "newest":
      return { action: baseAction(ctx, { action: "skip", reason: `context file "${relPath}" differs from target; policy=newest cannot compare recency (no timestamp available), so the incumbent is kept`, risk: "none", target: { path: relPath }, conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true } }) };
    case "ask": {
      ctx.state.askAffectedCount++;
      return { action: baseAction(ctx, { action: "abstain", reason: `context file "${relPath}" differs from target; policy=ask requires interactive confirmation`, risk: "none", target: { path: relPath }, conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true } }) };
    }
    default: {
      const _exhaustive: never = ctx.policy;
      return _exhaustive;
    }
  }
}

/** Generic per-logical-key collision handling for kinds with no dedicated `TargetProbe` incumbent list (`tool-state`, `unknown`). */
function resolveGeneric(ctx: ResolveCtx): ResolveResult {
  const existingHash = ctx.state.claimedGeneric.get(ctx.item.key);
  if (existingHash === undefined) {
    ctx.state.claimedGeneric.set(ctx.item.key, ctx.item.hash);
    return { action: baseAction(ctx, { action: "import", reason: `no prior observation of "${ctx.item.key}" in this run`, risk: "none", target: { id: ctx.item.key } }) };
  }
  if (existingHash === ctx.item.hash) {
    return { action: baseAction(ctx, { action: "skip", reason: `duplicate observation of "${ctx.item.key}" with identical content`, risk: "none", target: { id: ctx.item.key } }) };
  }
  const withDesc = `another source item observed earlier in this run for "${ctx.item.key}"`;
  switch (ctx.policy) {
    case "skip":
      return { action: baseAction(ctx, { action: "skip", reason: `"${ctx.item.key}" was already observed with different content earlier in this run; policy=skip keeps the first observation`, risk: "none", conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true } }) };
    case "overwrite":
      ctx.state.claimedGeneric.set(ctx.item.key, ctx.item.hash);
      return { action: baseAction(ctx, { action: "overwrite", reason: `"${ctx.item.key}" was already observed with different content earlier in this run; policy=overwrite replaces it`, risk: "destructive", target: { id: ctx.item.key }, conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true } }) };
    case "rename": {
      const newKey = uniqueSuffixedName(ctx.item.key, (n) => ctx.state.claimedGeneric.has(n));
      ctx.state.claimedGeneric.set(newKey, ctx.item.hash);
      return { action: baseAction(ctx, { action: "rename", reason: `"${ctx.item.key}" was already observed with different content earlier in this run; policy=rename stores this observation under a new key`, risk: "low", renamedTo: newKey, target: { id: newKey }, conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true } }) };
    }
    case "newest":
      return { action: baseAction(ctx, { action: "skip", reason: `"${ctx.item.key}" was already observed with different content earlier in this run; policy=newest cannot compare recency (no timestamp), so the first observation is kept`, risk: "none", conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true } }) };
    case "ask": {
      ctx.state.askAffectedCount++;
      return { action: baseAction(ctx, { action: "abstain", reason: `"${ctx.item.key}" was already observed with different content earlier in this run; policy=ask requires interactive confirmation`, risk: "none", conflict: { with: withDesc, policy: ctx.policy, incumbentNewer: true } }) };
    }
    default: {
      const _exhaustive: never = ctx.policy;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// buildMigrationPlan
// ---------------------------------------------------------------------------

/**
 * Builds a total, deterministic {@link MigrationPlan} from real bundles plus
 * a snapshot of the live install. See the module doc comment for the full
 * conflict-semantics contract. Pure: no I/O, no clock read (`options.now`
 * supplies `createdAt`).
 */
export function buildMigrationPlan(input: {
  bundles: MigrationBundle[];
  secrets: SecretDescriptor[];
  target: TargetProbe;
  options: MigrateOptions;
}): MigrationPlan {
  const { bundles, secrets, target, options } = input;
  const warnings: string[] = [];
  const blockers: Array<{ code: BlockerCode; message: string; path?: string }> = [];

  // -- Pre-scan blockers, independent of any single item ------------------
  if (bundles.length === 0 && secrets.length === 0) {
    blockers.push({ code: "no-sources", message: "no migration sources were provided (bundles and secrets are both empty)" });
  }
  for (const b of bundles) {
    if (b.readErrors.length > 0) {
      const preview = b.readErrors.slice(0, 3).map((e) => e.reason).join("; ");
      blockers.push({
        code: "source-unreadable",
        message: `source at "${b.root}" (${b.vendor}) had ${b.readErrors.length} read error(s): ${preview}${b.readErrors.length > 3 ? "; ..." : ""}`,
        path: b.root,
      });
    }
  }
  const normalizedDataDir = normalizePath(target.dataDir);
  const abstainRoots = new Set<string>();
  for (const b of bundles) {
    if (b.root.length > 0 && normalizePath(b.root) === normalizedDataDir) {
      abstainRoots.add(b.root);
      blockers.push({
        code: "source-is-target",
        message: `source at "${b.root}" is Hades' own live dataDir; refusing to use it as a migration source`,
        path: b.root,
      });
    }
  }

  const candidates = buildCandidates(bundles, secrets, warnings);
  const state = initState(target);

  const actions: PlannedAction[] = [];
  const newUnimportable: Array<{ path: string; kind: ArtifactKind; reason: string; vendor: MigrateVendor }> = [];

  let itemLimitHit = false;

  candidates.forEach((candidate, index) => {
    const { item, vendor, bundleRoot } = candidate;
    const itemKey = uniqueItemKey(item.key, item, state.usedItemKeys);

    // Gate 0: hard cap on total candidates processed.
    if (options.maxItems !== undefined && index >= options.maxItems) {
      itemLimitHit = true;
      actions.push({
        itemKey,
        kind: item.kind,
        action: "quarantine",
        reason: `item limit (maxItems=${options.maxItems}) exceeded; this item was not planned`,
        vendor,
        sourcePath: item.origin.path,
        target: {},
        risk: "none",
        itemHash: item.hash,
      });
      return;
    }

    // Gate 1: only/exclude filter.
    if (!isIncluded(item.kind, options)) {
      actions.push({
        itemKey,
        kind: item.kind,
        action: "skip",
        reason: `kind "${item.kind}" is excluded by migration options (only/exclude filter)`,
        vendor,
        sourcePath: item.origin.path,
        target: {},
        risk: "none",
        itemHash: item.hash,
      });
      return;
    }

    // Gate 2: refuse migrating from Hades' own live dataDir outright.
    if (abstainRoots.has(bundleRoot)) {
      actions.push({
        itemKey,
        kind: item.kind,
        action: "abstain",
        reason: "source-is-target: refusing to migrate from Hades' own live dataDir",
        vendor,
        sourcePath: item.origin.path,
        target: {},
        risk: "none",
        itemHash: item.hash,
      });
      return;
    }

    // Gate 3: idempotency -- already applied in a prior run.
    const priorReceipt = target.priorReceipts.find((r) => r.itemKey === item.key && r.itemHash === item.hash);
    if (priorReceipt) {
      actions.push({
        itemKey,
        kind: item.kind,
        action: "skip",
        reason: "already-imported",
        vendor,
        sourcePath: item.origin.path,
        target: {},
        risk: "none",
        itemHash: item.hash,
      });
      return;
    }

    // Gate 4: kind-specific resolution.
    const ctx: ResolveCtx = { itemKey, item, vendor, policy: options.conflict, target, state };
    let result: ResolveResult;
    switch (item.kind) {
      case "memory":
        result = resolveMemory(ctx);
        break;
      case "session":
        result = resolveSession(ctx);
        break;
      case "skill":
        result = resolveSkill(ctx);
        break;
      case "config":
        result = resolveConfig(ctx);
        break;
      case "model":
        result = resolveModel(ctx);
        break;
      case "secret":
        result = resolveSecret(ctx, options.importSecrets);
        break;
      case "context-file":
        result = resolveContextFile(ctx);
        break;
      case "tool-state":
      case "unknown":
        result = resolveGeneric(ctx);
        break;
      default: {
        const _exhaustive: never = item.kind;
        result = _exhaustive;
      }
    }

    if ("unimportable" in result) {
      newUnimportable.push({ ...result.unimportable, vendor });
      return;
    }
    actions.push(gateWritable(item.kind, result.action, target, state));
  });

  // -- Blockers discovered while walking the candidate list ---------------
  if (state.secretsRefusedCount > 0) {
    blockers.push({
      code: "secrets-refused",
      message: `${state.secretsRefusedCount} secret(s) discovered but not imported because options.importSecrets=false`,
    });
  }
  for (const modelId of [...state.unknownModelIds].sort(cmp)) {
    blockers.push({
      code: "model-unknown",
      message: `model id "${modelId}" is not present in target.knownModelIds; refusing to select an unrunnable model`,
    });
  }
  for (const kind of [...state.notWritableKinds].sort(cmp)) {
    blockers.push({
      code: "target-not-writable",
      message: `target is not writable for kind "${kind}" (target.writable["${kind}"] is not true); matching items were quarantined instead of written`,
      path: target.dataDir,
    });
  }
  if (itemLimitHit && options.maxItems !== undefined) {
    blockers.push({
      code: "item-limit-exceeded",
      message: `options.maxItems=${options.maxItems} was exceeded by ${Math.max(0, candidates.length - options.maxItems)} item(s); the excess were quarantined and not planned`,
    });
  }
  if (state.askAffectedCount > 0) {
    blockers.push({
      code: "policy-requires-confirmation",
      message: `conflict policy is "ask"; ${state.askAffectedCount} conflicting item(s) require interactive resolution and were left unresolved (action=abstain)`,
    });
  }

  blockers.sort((a, b) => cmp(a.code, b.code) || cmp(a.path ?? "", b.path ?? "") || cmp(a.message, b.message));

  // -- Global invariant: no blocker-having plan proposes a destructive action.
  if (blockers.length > 0) {
    for (const a of actions) {
      if (a.risk === "destructive") {
        a.action = "quarantine";
        a.risk = "low";
        a.reason = `${a.reason} (held back: plan has unresolved blocker(s); resolve blockers before applying)`;
      }
    }
  }

  const carriedUnimportable = bundles.flatMap((b) => b.unimportable.map((u) => ({ ...u, vendor: b.vendor })));
  const unimportable = [...carriedUnimportable, ...newUnimportable].sort(
    (a, b) => cmp(a.path, b.path) || cmp(a.kind, b.kind) || cmp(a.reason, b.reason),
  );

  const sources = bundles
    .map((b) => ({ vendor: b.vendor, root: b.root, layout: b.layout, itemCount: b.items.length }))
    .sort((a, b) => cmp(a.vendor, b.vendor) || cmp(a.layout, b.layout) || cmp(a.root, b.root));

  const byKind: Record<string, number> = {};
  for (const k of ARTIFACT_KINDS) byKind[k] = 0;
  const byAction: Record<PlannedActionKind, number> = {
    import: 0,
    merge: 0,
    rename: 0,
    overwrite: 0,
    skip: 0,
    quarantine: 0,
    abstain: 0,
  };
  let destructive = 0;
  let secretsToWrite = 0;
  let alreadyImported = 0;
  for (const a of actions) {
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    byAction[a.action] += 1;
    if (a.risk === "destructive") destructive++;
    if (a.kind === "secret" && (a.action === "import" || a.action === "overwrite")) secretsToWrite++;
    if (a.action === "skip" && a.reason === "already-imported") alreadyImported++;
  }

  const actionsCanonical: JsonValue[] = actions.map(actionToJson);
  const planHash = sha256Hex(canonicalJson(actionsCanonical));

  return {
    createdAt: options.now,
    sources,
    actions,
    unimportable,
    blockers,
    warnings: [...new Set(warnings)].sort(cmp),
    summary: { byKind, byAction, destructive, secretsToWrite, alreadyImported },
    dryRun: options.dryRun,
    planHash,
  };
}

function actionToJson(a: PlannedAction): JsonValue {
  const target: JsonValue = {
    ...(a.target.path !== undefined ? { path: a.target.path } : {}),
    ...(a.target.id !== undefined ? { id: a.target.id } : {}),
    ...(a.target.field !== undefined ? { field: a.target.field } : {}),
  };
  return {
    itemKey: a.itemKey,
    kind: a.kind,
    action: a.action,
    reason: a.reason,
    vendor: a.vendor,
    sourcePath: a.sourcePath,
    target,
    ...(a.conflict !== undefined
      ? { conflict: { with: a.conflict.with, policy: a.conflict.policy, incumbentNewer: a.conflict.incumbentNewer } }
      : {}),
    ...(a.renamedTo !== undefined ? { renamedTo: a.renamedTo } : {}),
    risk: a.risk,
    itemHash: a.itemHash,
  };
}

// Re-exported for report.ts and tests that need to recompute the same hash a plan reports.
export { computeItemHash };
