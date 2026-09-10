/**
 * `hades migrate <sub>` — the terminal surface over the real T1-T5 migration
 * engine: discover a real Hermes/OpenClaw install (`../migrate/discovery`),
 * read it into canonical bundles + a leak-proof secret vault
 * (`../migrate/hermes-source` / `../migrate/openclaw-source`), turn that into
 * a deterministic plan (`../migrate/plan`), and — only with `--yes` — apply
 * it transactionally against the real engine (`../migrate/apply`).
 *
 *   hades migrate scan [--json]
 *   hades migrate plan [--from DIR] [--vendor hermes|openclaw|auto]
 *                       [--only kinds] [--exclude kinds]
 *                       [--conflict skip|overwrite|rename|newest|ask]
 *                       [--no-keys] [--json]
 *   hades migrate apply ...same flags as plan... [--yes] [--json]
 *   hades migrate report [--json]
 *   hades migrate selftest [--keep]
 *   hades migrate help
 *
 * Terminal-free (`{ code, lines }`, no direct stdout/stderr), matching every
 * sibling in `src/hades/cli/*`. `cli.ts` itself is untouched by this module —
 * wiring `migrate` into the `hades` command router is the orchestrator's job.
 *
 * `scan`/`plan`/`apply` share one internal pipeline
 * (discover → read → build a real {@link TargetProbe} → build a plan) so the
 * SAME bundles that produced the plan are what `apply` resolves its actual
 * write content from (see `../migrate/apply.ts`'s module doc for why that
 * matters) — nothing is re-scanned between building the plan and applying
 * it within one `migrate apply` invocation.
 *
 * DEFAULT IS DRY RUN: `apply` without `--yes` behaves exactly like `plan`
 * (prints the plan, writes nothing) plus one explicit
 * `"dry run — pass --yes to apply"` line, and always exits 0.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliResult } from "./cli";
import { discoverSources, nodeFsProbe } from "../migrate/discovery";
import type { DiscoveredSource, FsProbe } from "../migrate/discovery";
import { readHermesSource } from "../migrate/hermes-source";
import { readOpenClawSource } from "../migrate/openclaw-source";
import { openSqlite } from "../migrate/sqlite-read";
import { validateBundle } from "../migrate/ir";
import type { ArtifactKind, MigrateVendor, MigrationBundle } from "../migrate/ir";
import { buildMigrationPlan } from "../migrate/plan";
import type { ConflictPolicy, MigrationPlan, TargetProbe } from "../migrate/plan";
import { renderApplyReport, renderPlanJson, renderPlanText } from "../migrate/report";
import { applyMigrationPlan, defaultApplyFsOps, probeTarget, readReceipts, receiptsPath } from "../migrate/apply";
import type { ApplyDeps, ApplyResult } from "../migrate/apply";
import { SecretVault, classifyProviderKey } from "../migrate/secrets";
import {
  materializeHermesFixture,
  materializeOpenClawFixture,
} from "../migrate/fixtures";

import { FileMemoryStore } from "../memory/store";
import { GuardedMemoryStore } from "../memory/guard";
import { FileSessionStore } from "../memory/session-store";
import { fileConfigAccess } from "../state/wiring";
import { FileModelSelection } from "../models/selection";
import { defaultModelRegistry } from "../models/defaults";

// ---------------------------------------------------------------------------
// Locked contract
// ---------------------------------------------------------------------------

export interface MigrateCommandDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  now?: () => number;
  dataDir?: string;
  probe?: FsProbe;
  apply?: typeof applyMigrationPlan;
  deps?: () => ApplyDeps & { knownModelIds: string[] };
}

/** Env-driven defaults, matching every other `default*Deps` in `src/hades/cli`. */
export function defaultMigrateDeps(env: NodeJS.ProcessEnv = process.env): MigrateCommandDeps {
  return {
    env,
    cwd: process.cwd(),
    home: env.HOME ?? env.USERPROFILE ?? process.cwd(),
    platform: process.platform,
    dataDir: env.HADES_DATA_DIR ?? ".hades",
  };
}

// ---------------------------------------------------------------------------
// Resolved deps / real-engine wiring
// ---------------------------------------------------------------------------

function resolveDataDir(deps: MigrateCommandDeps): string {
  return deps.dataDir ?? deps.env.HADES_DATA_DIR ?? ".hades";
}

/**
 * Builds the REAL `ApplyDeps` (file-backed memory/sessions/config/model
 * selection, the on-disk skill library, a leak-proof secret vault) for
 * `dataDir` — the same shape of wiring `../cli/build.ts` uses for the rest
 * of the CLI, so `hades migrate` reads/writes the SAME live install.
 */
function realApplyDeps(dataDir: string, env: NodeJS.ProcessEnv, now: () => number): ApplyDeps & { knownModelIds: string[] } {
  const memoryPath = join(dataDir, "memory.json");
  const baseMemory = new FileMemoryStore(memoryPath);
  const memory = new GuardedMemoryStore(baseMemory, { now });
  const sessions = new FileSessionStore(join(dataDir, "sessions.json"));
  const config = fileConfigAccess(dataDir, env);
  const modelSelection = new FileModelSelection(join(dataDir, "model.json"), now);
  const skillsDir = env.HADES_SKILLS_DIR ?? join(dataDir, "skills");
  const contextFilesDir = join(dataDir, "context-files");
  const secretsPath = join(dataDir, "secrets.env");
  const knownModelIds = defaultModelRegistry().list().map((m) => m.id);
  return {
    dataDir,
    memory,
    guard: memory,
    sessions,
    config,
    modelSelection,
    skillsDir,
    contextFilesDir,
    secretsPath,
    secrets: new SecretVault(),
    now,
    knownModelIds,
  };
}

function resolveApplyDeps(mdeps: MigrateCommandDeps, dataDir: string, now: () => number): ApplyDeps & { knownModelIds: string[] } {
  if (!mdeps.deps) return realApplyDeps(dataDir, mdeps.env, now);
  const injected = mdeps.deps();
  // An injected factory carries live engine handles (stores already opened
  // against ITS data directory). Writing a plan built for `dataDir` through
  // handles rooted somewhere else would migrate into the wrong install
  // silently, so a mismatch is a wiring bug and is reported as one.
  if (injected.dataDir !== dataDir) {
    throw new Error(
      `migrate deps mismatch: the injected ApplyDeps is rooted at "${injected.dataDir}" but this command targets "${dataDir}"`,
    );
  }
  return injected;
}

// ---------------------------------------------------------------------------
// Small local flag-parsing helpers (own copies — see ../cli/state-command.ts)
// ---------------------------------------------------------------------------

function extractBoolFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, rest: args };
  return { present: true, rest: [...args.slice(0, idx), ...args.slice(idx + 1)] };
}

function extractValueFlag(args: string[], flag: string): { present: boolean; value: string | undefined; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, value: undefined, rest: args };
  const value = args[idx + 1];
  const rest = value === undefined ? [...args.slice(0, idx), ...args.slice(idx + 1)] : [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { present: true, value, rest };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ALL_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "config",
  "model",
  "memory",
  "context-file",
  "session",
  "skill",
  "secret",
  "tool-state",
  "unknown",
];
const CONFLICT_POLICIES: readonly ConflictPolicy[] = ["skip", "overwrite", "rename", "newest", "ask"];

function parseKindList(raw: string): { kinds?: ArtifactKind[]; error?: string } {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = parts.filter((p) => !ALL_ARTIFACT_KINDS.includes(p as ArtifactKind));
  if (bad.length > 0) {
    return { error: `unknown kind(s): ${bad.join(", ")} (expected one of: ${ALL_ARTIFACT_KINDS.join(", ")})` };
  }
  return { kinds: parts as ArtifactKind[] };
}

// ---------------------------------------------------------------------------
// Shared flags for plan/apply
// ---------------------------------------------------------------------------

interface PlanFlags {
  from?: string;
  vendor: MigrateVendor | "auto";
  only?: ArtifactKind[];
  exclude?: ArtifactKind[];
  conflict: ConflictPolicy;
  importSecrets: boolean;
  json: boolean;
  /** `--verbose`: per-action target/source/hash/conflict detail in the text renderer. */
  verbose: boolean;
}

function parsePlanFlags(args: string[]): { flags: PlanFlags; error?: string } {
  let rest = args;
  const from = extractValueFlag(rest, "--from");
  rest = from.rest;
  const vendor = extractValueFlag(rest, "--vendor");
  rest = vendor.rest;
  const only = extractValueFlag(rest, "--only");
  rest = only.rest;
  const exclude = extractValueFlag(rest, "--exclude");
  rest = exclude.rest;
  const conflict = extractValueFlag(rest, "--conflict");
  rest = conflict.rest;
  const noKeys = extractBoolFlag(rest, "--no-keys");
  rest = noKeys.rest;
  const json = extractBoolFlag(rest, "--json");
  rest = json.rest;
  const verbose = extractBoolFlag(rest, "--verbose");
  rest = verbose.rest;
  const yes = extractBoolFlag(rest, "--yes");
  rest = yes.rest; // consumed here so it's never reported as "unknown" by plan; apply re-detects it itself

  if (from.present && (from.value === undefined || from.value.length === 0)) return { flags: undefined as never, error: "--from requires a directory argument" };
  if (vendor.present && vendor.value === undefined) return { flags: undefined as never, error: "--vendor requires a value (hermes|openclaw|auto)" };
  if (vendor.present && vendor.value !== "hermes" && vendor.value !== "openclaw" && vendor.value !== "auto") {
    return { flags: undefined as never, error: `unknown --vendor "${vendor.value}" (expected one of: hermes, openclaw, auto)` };
  }
  if (conflict.present && conflict.value === undefined) return { flags: undefined as never, error: "--conflict requires a value" };
  if (conflict.present && !CONFLICT_POLICIES.includes(conflict.value as ConflictPolicy)) {
    return { flags: undefined as never, error: `unknown --conflict "${conflict.value}" (expected one of: ${CONFLICT_POLICIES.join(", ")})` };
  }
  let onlyKinds: ArtifactKind[] | undefined;
  if (only.present) {
    if (only.value === undefined) return { flags: undefined as never, error: "--only requires a comma-separated kind list" };
    const r = parseKindList(only.value);
    if (r.error) return { flags: undefined as never, error: r.error };
    onlyKinds = r.kinds;
  }
  let excludeKinds: ArtifactKind[] | undefined;
  if (exclude.present) {
    if (exclude.value === undefined) return { flags: undefined as never, error: "--exclude requires a comma-separated kind list" };
    const r = parseKindList(exclude.value);
    if (r.error) return { flags: undefined as never, error: r.error };
    excludeKinds = r.kinds;
  }
  if (rest.length > 0) return { flags: undefined as never, error: `unexpected argument: ${rest[0]}` };

  return {
    flags: {
      from: from.value,
      vendor: (vendor.value as MigrateVendor | "auto") ?? "auto",
      only: onlyKinds,
      exclude: excludeKinds,
      conflict: (conflict.value as ConflictPolicy) ?? "skip",
      importSecrets: !noKeys.present,
      json: json.present,
      verbose: verbose.present,
    },
  };
}

// ---------------------------------------------------------------------------
// scan / plan pipeline (shared by scan, plan, apply, selftest)
// ---------------------------------------------------------------------------

interface ScanOutcome {
  sources: DiscoveredSource[];
  /** The subset of `sources` actually READ — one per distinct (vendor, root); see `dedupeSourcesForReading`. */
  read: DiscoveredSource[];
  searched: string[];
  skipped: Array<{ path: string; reason: string }>;
  bundles: MigrationBundle[];
  vault: SecretVault;
  readErrors: Array<{ path: string; reason: string }>;
  /** Notes about the scan itself (collapsed duplicate layout matches, ...). */
  notes: string[];
}

/**
 * `discoverSources` deliberately scores every (layout, root) pair
 * independently and is NOT first-match-wins — one real directory handed in
 * via `--from` legitimately matches several layouts of the same vendor
 * (env-override, XDG, dotfile, macOS, Windows), and reporting all of them is
 * the discovery contract.
 *
 * Reading is a different question: reading the same tree five times would
 * produce five identical bundles, i.e. five copies of every item in the plan.
 * So exactly one source per distinct (vendor, root) is read — the
 * highest-confidence match, ties broken by layout name so the choice is
 * deterministic — and the collapsed duplicates are reported as a note rather
 * than silently dropped.
 */
function dedupeSourcesForReading(sources: DiscoveredSource[]): { read: DiscoveredSource[]; notes: string[] } {
  const byRoot = new Map<string, DiscoveredSource[]>();
  for (const s of sources) {
    const key = `${s.vendor}\u0000${s.root}`;
    const list = byRoot.get(key);
    if (list) list.push(s);
    else byRoot.set(key, [s]);
  }
  const read: DiscoveredSource[] = [];
  const notes: string[] = [];
  for (const [, group] of byRoot) {
    const sorted = [...group].sort((a, b) => b.confidence - a.confidence || a.layout.localeCompare(b.layout));
    read.push(sorted[0]);
    if (sorted.length > 1) {
      notes.push(
        `${sorted[0].root} (${sorted[0].vendor}) matched ${sorted.length} layouts (${sorted.map((s) => s.layout).join(", ")}); reading it once as "${sorted[0].layout}" (highest confidence)`,
      );
    }
  }
  return { read, notes };
}

async function scanAll(
  mdeps: MigrateCommandDeps,
  opts: { vendor?: MigrateVendor | "auto"; explicitRoots?: Array<{ root: string; vendor?: MigrateVendor }>; now: () => number },
): Promise<ScanOutcome> {
  const probe = mdeps.probe ?? nodeFsProbe();
  const discovered = discoverSources(probe, {
    platform: mdeps.platform,
    home: mdeps.home,
    env: mdeps.env,
    explicitRoots: opts.explicitRoots,
  });

  const vendorFilter = opts.vendor && opts.vendor !== "auto" ? opts.vendor : undefined;
  const sources = vendorFilter ? discovered.sources.filter((s) => s.vendor === vendorFilter) : discovered.sources;
  const { read, notes } = dedupeSourcesForReading(sources);

  const bundles: MigrationBundle[] = [];
  const vault = new SecretVault();
  const readErrors: Array<{ path: string; reason: string }> = [];

  for (const source of read) {
    try {
      const reader = source.vendor === "hermes" ? readHermesSource : readOpenClawSource;
      const { bundle, secrets } = await reader(source, { probe, openSqlite, now: opts.now });
      // Independent re-validation of what the vendor adapter produced:
      // hash integrity, key grammar, and — the reason this gate exists at
      // all — secret MATERIAL that must never appear inside a bundle. A
      // bundle that fails is not planned from; the failure becomes a real
      // read error, which `plan.ts` turns into a `source-unreadable`
      // blocker, which in turn stops `apply` (see cmdApply).
      const validation = validateBundle(bundle);
      if (!validation.ok) {
        readErrors.push({
          path: source.root,
          reason: `bundle failed validation (${validation.errors.length} error(s)): ${validation.errors.slice(0, 3).join("; ")}${validation.errors.length > 3 ? "; ..." : ""}`,
        });
        continue;
      }
      bundles.push(bundle);
      for (const entry of secrets.entries) {
        const classification = classifyProviderKey(entry.envVar, entry.value);
        vault.add(
          {
            envVar: entry.envVar,
            provider: classification.provider,
            origin: entry.origin,
            confidence: classification.looksValid ? 1 : 0.5,
            looksValid: classification.looksValid,
            ...(entry.redactedPreview ? { note: `redacted preview: ${entry.redactedPreview}` } : {}),
          },
          entry.value,
        );
      }
    } catch (err) {
      readErrors.push({ path: source.root, reason: errMsg(err) });
    }
  }

  return { sources, read, searched: discovered.searched, skipped: discovered.skipped, bundles, vault, readErrors, notes };
}

interface PlanBuild {
  scan: ScanOutcome;
  plan: MigrationPlan;
  applyDeps: ApplyDeps & { knownModelIds: string[] };
}

async function buildPlan(mdeps: MigrateCommandDeps, flags: PlanFlags, now: () => number, dryRun: boolean): Promise<PlanBuild> {
  const dataDir = resolveDataDir(mdeps);
  const applyDeps = resolveApplyDeps(mdeps, dataDir, now);

  const explicitRoots = flags.from ? [{ root: flags.from, ...(flags.vendor !== "auto" ? { vendor: flags.vendor } : {}) }] : undefined;
  const scan = await scanAll(mdeps, { vendor: flags.vendor, explicitRoots, now });

  // The scan's freshly-built vault (real material) becomes the vault apply
  // reads material back out of — `deps.secrets` is created empty by
  // `resolveApplyDeps`/`realApplyDeps`, so a caller-supplied `deps()` factory
  // that wants apply to actually write secrets must return a `secrets` field
  // that this same scan can populate; the default wiring does this by using
  // the scan's own vault as the plan/apply secrets vault below.
  applyDeps.secrets = scan.vault;

  const target: TargetProbe = probeTarget(applyDeps);

  const plan = buildMigrationPlan({
    bundles: scan.bundles,
    secrets: scan.vault.list(),
    target,
    options: {
      only: flags.only,
      exclude: flags.exclude,
      conflict: flags.conflict,
      importSecrets: flags.importSecrets,
      // A plan built for PREVIEW is marked dryRun, and `applyMigrationPlan`
      // refuses to write such a plan (see ../migrate/apply.ts). Only
      // `migrate apply --yes` builds a plan with dryRun:false.
      dryRun,
      now: now(),
    },
  });

  return { scan, plan, applyDeps };
}

// ---------------------------------------------------------------------------
// Structured pipeline API (surface-independent)
//
// `runMigrateCommand` renders `{code, lines}` for a terminal. Other surfaces
// (the desktop `migrate.*` IPC lane in `src/desktop/core/migrate-service.ts`,
// and anything else that wants data rather than text) need the SAME pipeline
// without the rendering — so it lives here, once, and the `cmd*` functions
// below are thin renderers over it. Nothing in this section touches stdout.
//
// Secret MATERIAL never crosses this boundary: `MigrateScanSummary` carries
// only counts and env-var NAMES, and a `MigrationPlan`'s secret actions are
// metadata-only by construction (see ../migrate/plan.ts).
// ---------------------------------------------------------------------------

export interface MigratePipelineOptions {
  /** Explicit source root (`--from`); when absent, real discovery runs. */
  from?: string;
  vendor?: MigrateVendor | "auto";
  only?: ArtifactKind[];
  exclude?: ArtifactKind[];
  conflict?: ConflictPolicy;
  /** Default true, mirroring the CLI (`--no-keys` turns it off). */
  importSecrets?: boolean;
}

export interface MigrateSourceSummary {
  vendor: MigrateVendor;
  layout: string;
  root: string;
  confidence: number;
  version?: string;
  evidence: string[];
  itemCount: number;
  warnings: string[];
  /** False for a duplicate layout match of a root that was read once already. */
  read: boolean;
}

export interface MigrateScanSummary {
  sources: MigrateSourceSummary[];
  searched: string[];
  skipped: Array<{ path: string; reason: string }>;
  readErrors: Array<{ path: string; reason: string }>;
  /** Scan-level notes (e.g. duplicate layout matches collapsed to one read). */
  notes: string[];
  /** Env-var NAMES of the secrets discovered by this scan — never material. */
  secretEnvVars: string[];
}

export interface MigrateReceiptSummary {
  receiptPath: string;
  total: number;
  ok: number;
  failed: number;
  byAction: Record<string, number>;
  chainOk: boolean;
  brokenAt?: number;
  lastAt?: number;
}

function toPipelineFlags(opts: MigratePipelineOptions): PlanFlags {
  return {
    from: opts.from,
    vendor: opts.vendor ?? "auto",
    only: opts.only,
    exclude: opts.exclude,
    conflict: opts.conflict ?? "skip",
    importSecrets: opts.importSecrets ?? true,
    json: false,
    verbose: false,
  };
}

function summarizeScan(scan: ScanOutcome): MigrateScanSummary {
  return {
    sources: scan.sources.map((s) => ({
      vendor: s.vendor,
      layout: s.layout,
      root: s.root,
      confidence: s.confidence,
      ...(s.version !== undefined ? { version: s.version } : {}),
      evidence: [...s.evidence],
      itemCount: s.inventory.length,
      warnings: [...s.warnings],
      read: scan.read.includes(s),
    })),
    searched: [...scan.searched],
    skipped: scan.skipped.map((s) => ({ ...s })),
    readErrors: scan.readErrors.map((e) => ({ ...e })),
    notes: [...scan.notes],
    secretEnvVars: scan.vault
      .list()
      .map((d) => d.envVar)
      .sort(),
  };
}

/** Real discovery + read of every source, summarized (no secret material). */
export async function migrateScan(
  deps: MigrateCommandDeps = defaultMigrateDeps(),
  opts: MigratePipelineOptions = {},
): Promise<MigrateScanSummary> {
  const now = deps.now ?? (() => Date.now());
  const flags = toPipelineFlags(opts);
  const explicitRoots = flags.from ? [{ root: flags.from, ...(flags.vendor !== "auto" ? { vendor: flags.vendor } : {}) }] : undefined;
  const scan = await scanAll(deps, { vendor: flags.vendor, explicitRoots, now });
  return summarizeScan(scan);
}

/** Real scan + a deterministic PREVIEW plan (`dryRun: true` — never applicable as-is). */
export async function migratePlanPreview(
  deps: MigrateCommandDeps = defaultMigrateDeps(),
  opts: MigratePipelineOptions = {},
): Promise<{ plan: MigrationPlan; scan: MigrateScanSummary }> {
  const now = deps.now ?? (() => Date.now());
  const built = await buildPlan(deps, toPipelineFlags(opts), now, true);
  return { plan: built.plan, scan: summarizeScan(built.scan) };
}

/**
 * Real scan + an APPLICABLE plan (`dryRun: false`) + a real transactional
 * apply against the live data directory. Refuses (without writing anything)
 * when the plan has unresolved blockers — the same rule `migrate apply --yes`
 * enforces, held here so every surface inherits it rather than re-deriving it.
 */
export async function migrateApply(
  deps: MigrateCommandDeps = defaultMigrateDeps(),
  opts: MigratePipelineOptions = {},
): Promise<{ plan: MigrationPlan; scan: MigrateScanSummary; result?: ApplyResult; refused?: string }> {
  const now = deps.now ?? (() => Date.now());
  const built = await buildPlan(deps, toPipelineFlags(opts), now, false);
  const scan = summarizeScan(built.scan);
  if (built.plan.blockers.length > 0) {
    return { plan: built.plan, scan, refused: "the plan has unresolved blocker(s); nothing was applied" };
  }
  const applyDeps: ApplyDeps = {
    ...built.applyDeps,
    fsOps: { ...defaultApplyFsOps(), resolveItem: buildItemResolver(built.scan.bundles) },
  };
  const applyFn = deps.apply ?? applyMigrationPlan;
  const result = await applyFn(built.plan, applyDeps);
  return { plan: built.plan, scan, result };
}

/** Read + verify the on-disk receipt chain for this data directory. */
export function migrateReceiptSummary(deps: MigrateCommandDeps = defaultMigrateDeps()): MigrateReceiptSummary {
  const path = receiptsPath(resolveDataDir(deps));
  const { entries, chainOk, brokenAt } = readReceipts(path);
  const byAction: Record<string, number> = {};
  let ok = 0;
  let failed = 0;
  for (const e of entries) {
    byAction[e.action] = (byAction[e.action] ?? 0) + 1;
    if (e.ok) ok++;
    else failed++;
  }
  return {
    receiptPath: path,
    total: entries.length,
    ok,
    failed,
    byAction,
    chainOk,
    ...(brokenAt !== undefined ? { brokenAt } : {}),
    ...(entries.at(-1)?.at !== undefined ? { lastAt: entries.at(-1)!.at } : {}),
  };
}

// ---------------------------------------------------------------------------
// Item resolver — wires apply.ts's `fsOps.resolveItem` hook to the SAME
// bundles the plan was built from (see ../migrate/apply.ts's module doc).
// ---------------------------------------------------------------------------

function buildItemResolver(bundles: MigrationBundle[]) {
  const byHash = new Map<string, MigrationBundle["items"][number]>();
  for (const b of bundles) for (const item of b.items) byHash.set(item.hash, item);
  return (action: { itemHash: string }) => byHash.get(action.itemHash);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function jsonLines(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split("\n");
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

async function cmdScan(mdeps: MigrateCommandDeps, args: string[]): Promise<CliResult> {
  const json = extractBoolFlag(args, "--json");
  if (json.rest.length > 0) return { code: 2, lines: [`Unexpected argument: ${json.rest[0]}`, "Usage: hades migrate scan [--json]"] };

  const now = mdeps.now ?? (() => Date.now());
  const scan = await scanAll(mdeps, { now });

  if (json.present) {
    return {
      code: 0,
      lines: jsonLines({
        searched: scan.searched,
        skipped: scan.skipped,
        readErrors: scan.readErrors,
        notes: scan.notes,
        secretEnvVars: scan.vault.list().map((d) => d.envVar).sort(),
        sources: scan.sources.map((s) => ({
          vendor: s.vendor,
          layout: s.layout,
          root: s.root,
          confidence: s.confidence,
          version: s.version,
          evidence: s.evidence,
          itemCount: s.inventory.length,
          warnings: s.warnings,
          read: scan.read.includes(s),
        })),
      }),
    };
  }

  const lines: string[] = [];
  if (scan.sources.length === 0) {
    lines.push("No Hermes/OpenClaw installation found; searched:");
    for (const p of scan.searched) lines.push(`  - ${p}`);
    if (scan.skipped.length > 0) {
      lines.push("", "Some candidate paths existed but were not usable:");
      for (const s of scan.skipped) lines.push(`  - ${s.path}: ${s.reason}`);
    }
    return { code: 0, lines };
  }

  lines.push(`Found ${scan.sources.length} source(s):`);
  for (const s of scan.sources) {
    const readMark = scan.read.includes(s) ? "" : " [duplicate layout match — not read separately]";
    lines.push(`  - ${s.vendor} / ${s.layout} :: ${s.root} (confidence ${s.confidence.toFixed(2)}, ${s.inventory.length} item(s)${s.version ? `, version ${s.version}` : ""})${readMark}`);
    for (const w of s.warnings) lines.push(`      warning: ${w}`);
  }
  // Secrets are reported by NAME and count only — material never reaches a
  // terminal, a log, or a JSON dump from this command.
  const secretNames = scan.vault.list().map((d) => d.envVar).sort();
  if (secretNames.length > 0) {
    lines.push("", `API keys found (names only, never printed): ${secretNames.join(", ")}`);
  }
  if (scan.notes.length > 0) {
    lines.push("", "Notes:");
    for (const n of scan.notes) lines.push(`  - ${n}`);
  }
  if (scan.readErrors.length > 0) {
    lines.push("", "Read errors:");
    for (const e of scan.readErrors) lines.push(`  - ${e.path}: ${e.reason}`);
  }
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

async function cmdPlan(mdeps: MigrateCommandDeps, args: string[]): Promise<CliResult> {
  const parsed = parsePlanFlags(args);
  if (parsed.error) return { code: 2, lines: [parsed.error, "Usage: hades migrate plan [--from DIR] [--vendor hermes|openclaw|auto] [--only kinds] [--exclude kinds] [--conflict skip|overwrite|rename|newest|ask] [--no-keys] [--json]"] };

  const now = mdeps.now ?? (() => Date.now());
  const { plan } = await buildPlan(mdeps, parsed.flags, now, true);

  if (parsed.flags.json) return { code: plan.blockers.length > 0 ? 1 : 0, lines: jsonLines(renderPlanJson(plan)) };
  return { code: plan.blockers.length > 0 ? 1 : 0, lines: renderPlanText(plan, { color: false, verbose: parsed.flags.verbose }) };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

async function cmdApply(mdeps: MigrateCommandDeps, args: string[]): Promise<CliResult> {
  const yes = extractBoolFlag(args, "--yes");
  const parsed = parsePlanFlags(yes.rest);
  if (parsed.error) {
    return {
      code: 2,
      lines: [
        parsed.error,
        "Usage: hades migrate apply [--from DIR] [--vendor hermes|openclaw|auto] [--only kinds] [--exclude kinds] [--conflict skip|overwrite|rename|newest|ask] [--no-keys] --yes [--json]",
      ],
    };
  }

  const now = mdeps.now ?? (() => Date.now());
  // Without `--yes` this is a preview: the plan is built (and rendered) as a
  // real dry-run plan, which `applyMigrationPlan` would refuse to write even
  // if it were handed one by mistake.
  const { scan, plan, applyDeps } = await buildPlan(mdeps, parsed.flags, now, !yes.present);

  if (!yes.present) {
    const lines = parsed.flags.json
      ? jsonLines({ dryRun: true, plan: renderPlanJson(plan) })
      : [...renderPlanText(plan, { color: false, verbose: parsed.flags.verbose }), "", "dry run — pass --yes to apply"];
    return { code: 0, lines };
  }

  if (plan.blockers.length > 0) {
    const lines = parsed.flags.json
      ? jsonLines({ applied: false, reason: "plan has unresolved blocker(s)", plan: renderPlanJson(plan) })
      : [...renderPlanText(plan, { color: false, verbose: parsed.flags.verbose }), "", "refusing to apply: the plan has unresolved blocker(s) (see BLOCKERS above)"];
    return { code: 1, lines };
  }

  const resolver = buildItemResolver(scan.bundles);
  const deps: ApplyDeps = {
    ...applyDeps,
    fsOps: { ...defaultApplyFsOps(), resolveItem: resolver },
  };

  const applyFn = mdeps.apply ?? applyMigrationPlan;
  const result = await applyFn(plan, deps);

  const outcomeReport = renderApplyReport(plan, result.outcomes, { json: parsed.flags.json });
  const code = result.failed > 0 || result.rolledBack ? 1 : 0;

  if (parsed.flags.json) {
    return {
      code,
      lines: jsonLines({
        applied: result.applied,
        failed: result.failed,
        rolledBack: result.rolledBack,
        quarantined: result.quarantined,
        secretsWritten: result.secretsWritten,
        durationMs: result.durationMs,
        receiptPath: result.receiptPath,
        receiptHead: result.receiptHead,
        report: outcomeReport.json,
      }),
    };
  }

  const lines = [
    `Applied ${result.applied} action(s), ${result.failed} failed, ${result.quarantined} quarantined by the write-guard, ${result.secretsWritten} secret(s) written (${result.durationMs}ms).`,
    result.rolledBack ? "The transaction FAILED and was rolled back — the data directory is unchanged." : "Transaction committed.",
    `Receipts: ${result.receiptPath} (head ${result.receiptHead.slice(0, 16)})`,
    "",
    ...outcomeReport.lines,
  ];
  return { code, lines };
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

async function cmdReport(mdeps: MigrateCommandDeps, args: string[]): Promise<CliResult> {
  const json = extractBoolFlag(args, "--json");
  if (json.rest.length > 0) return { code: 2, lines: [`Unexpected argument: ${json.rest[0]}`, "Usage: hades migrate report [--json]"] };

  // Shared with the desktop `migrate.receipts` lane — one implementation.
  const summary = migrateReceiptSummary(mdeps);
  const { receiptPath: path, total, ok: okCount, failed: failCount, byAction, chainOk, brokenAt, lastAt } = summary;

  if (json.present) {
    return { code: chainOk ? 0 : 1, lines: jsonLines(summary) };
  }

  const lines = [
    `Migration receipts: ${path}`,
    `${total} entr(y/ies) — ${okCount} ok, ${failCount} failed`,
    `chain: ${chainOk ? "OK" : `BROKEN at seq ${brokenAt}`}`,
    ...(lastAt !== undefined ? [`last activity: ${new Date(lastAt).toISOString()}`] : []),
    "",
    "by action:",
    ...Object.entries(byAction).map(([k, v]) => `  ${k}: ${v}`),
  ];
  return { code: chainOk ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

async function cmdSelftest(mdeps: MigrateCommandDeps, args: string[]): Promise<CliResult> {
  const keep = extractBoolFlag(args, "--keep");
  if (keep.rest.length > 0) return { code: 2, lines: [`Unexpected argument: ${keep.rest[0]}`, "Usage: hades migrate selftest [--keep]"] };

  const now = mdeps.now ?? (() => Date.now());
  const lines: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "hades-migrate-selftest-"));
  const hermesRoot = join(root, "hermes-src");
  const openclawRoot = join(root, "openclaw-src");
  const dataDir = join(root, "dataDir");
  mkdirSync(dataDir, { recursive: true });

  let ok = true;
  const fail = (msg: string): void => {
    ok = false;
    lines.push(`FAIL: ${msg}`);
  };

  try {
    const hermesManifest = materializeHermesFixture(hermesRoot, { variant: "home", withSqlite: true, withSecrets: true, memories: 3, sessions: 2, skills: 2, seed: 7 });
    const openclawManifest = materializeOpenClawFixture(openclawRoot, { variant: "home", withSecrets: true, memories: 3, sessions: 2, skills: 2, seed: 11 });
    lines.push(`materialized Hermes fixture at ${hermesRoot} (${hermesManifest.files.length} file(s), sqlite: ${hermesManifest.sqlite.present})`);
    lines.push(`materialized OpenClaw fixture at ${openclawRoot} (${openclawManifest.files.length} file(s))`);

    const selftestDeps: MigrateCommandDeps = { ...mdeps, dataDir, now };
    const explicitRoots = [
      { root: hermesRoot, vendor: "hermes" as MigrateVendor },
      { root: openclawRoot, vendor: "openclaw" as MigrateVendor },
    ];

    const flags: PlanFlags = { vendor: "auto", conflict: "skip", importSecrets: true, json: false, verbose: false };
    // SANDBOX (deliberately NOT `resolveApplyDeps`): the selftest is a
    // rehearsal, so it always builds its own engine handles rooted in this
    // temp directory. Honoring an injected `deps` factory here would point
    // the memory/session/skill stores at the caller's LIVE install and the
    // "selftest" would quietly migrate fixture data into it. `$HADES_SKILLS_DIR`
    // is dropped for the same reason — it would otherwise redirect skill
    // writes out of the sandbox and into the user's real skill library.
    const applyDeps = realApplyDeps(dataDir, { ...mdeps.env, HADES_SKILLS_DIR: undefined }, now);
    const scan = await scanAll(selftestDeps, { explicitRoots, now });
    applyDeps.secrets = scan.vault;
    const target = probeTarget(applyDeps);

    // Pass 1 — the FULL plan, model items included. The fixtures name models
    // this install genuinely cannot run (they are another agent's model ids),
    // so the honest, expected outcome is a `model-unknown` blocker per model
    // id plus an `abstain` action for each: the selftest asserts exactly that
    // rather than pretending a fictional model is runnable. Any OTHER blocker
    // is a real failure.
    const fullPlan = buildMigrationPlan({
      bundles: scan.bundles,
      secrets: scan.vault.list(),
      target,
      options: { conflict: flags.conflict, importSecrets: flags.importSecrets, dryRun: true, now: now() },
    });
    const modelActions = fullPlan.actions.filter((a) => a.kind === "model");
    const modelUnknown = fullPlan.blockers.filter((b) => b.code === "model-unknown");
    const unexpected = fullPlan.blockers.filter((b) => b.code !== "model-unknown");
    lines.push(
      `full plan: ${fullPlan.actions.length} action(s), ${fullPlan.blockers.length} blocker(s) ` +
        `(${modelUnknown.length} model-unknown), ${modelActions.length} model action(s)`,
    );
    for (const b of unexpected) fail(`unexpected blocker [${b.code}] ${b.message}`);
    if (modelActions.length === 0) fail("the fixtures declare model selections but the plan produced no model action");
    // A model id this install cannot run must never be selected. When the
    // running registry genuinely knows a fixture's model id (possible if the
    // catalog ever ships one), importing it is correct — so the assertion is
    // the IMPLICATION, not a fixed expectation: blockers <=> abstention.
    if (modelUnknown.length > 0) {
      for (const a of modelActions) {
        if (a.action !== "abstain" && a.action !== "quarantine") {
          fail(`plan reported a model-unknown blocker but model action "${a.itemKey}" still resolved to "${a.action}"`);
        }
      }
    }

    // Pass 2 — the applicable plan. `model` is excluded (pass 1 already
    // proved that path abstains honestly), leaving a plan that must have zero
    // blockers, so it can actually be applied end to end.
    const plan = buildMigrationPlan({
      bundles: scan.bundles,
      secrets: scan.vault.list(),
      target,
      options: { conflict: flags.conflict, exclude: ["model"], importSecrets: flags.importSecrets, dryRun: false, now: now() },
    });
    lines.push(`applicable plan (model excluded): ${plan.actions.length} action(s) across ${plan.sources.length} source(s), ${plan.blockers.length} blocker(s)`);
    if (plan.blockers.length > 0) {
      for (const b of plan.blockers) fail(`unexpected blocker [${b.code}] ${b.message}`);
    }

    const deps: ApplyDeps = { ...applyDeps, fsOps: { ...defaultApplyFsOps(), resolveItem: buildItemResolver(scan.bundles) } };
    const applyFn = mdeps.apply ?? applyMigrationPlan;
    const first = await applyFn(plan, deps);
    lines.push(`apply #1: applied=${first.applied} failed=${first.failed} quarantined=${first.quarantined} secretsWritten=${first.secretsWritten} rolledBack=${first.rolledBack} (${first.durationMs}ms)`);
    if (first.failed > 0 || first.rolledBack) fail(`first apply did not succeed cleanly`);

    const chain1 = readReceipts(first.receiptPath);
    if (!chain1.chainOk) fail(`receipt chain broken after first apply (brokenAt=${chain1.brokenAt})`);

    // Idempotency: re-scan + re-plan + re-apply must produce zero new receipt
    // entries (proven by an unchanged receipt head).
    const scan2 = await scanAll(selftestDeps, { explicitRoots, now });
    const applyDeps2 = realApplyDeps(dataDir, { ...mdeps.env, HADES_SKILLS_DIR: undefined }, now);
    applyDeps2.secrets = scan2.vault;
    const target2 = probeTarget(applyDeps2);
    const plan2 = buildMigrationPlan({
      bundles: scan2.bundles,
      secrets: scan2.vault.list(),
      target: target2,
      options: { conflict: flags.conflict, exclude: ["model"], importSecrets: flags.importSecrets, dryRun: false, now: now() },
    });
    const deps2: ApplyDeps = { ...applyDeps2, fsOps: { ...defaultApplyFsOps(), resolveItem: buildItemResolver(scan2.bundles) } };
    const second = await applyFn(plan2, deps2);
    lines.push(`apply #2 (idempotency re-run): applied=${second.applied} failed=${second.failed} receiptHead unchanged=${second.receiptHead === first.receiptHead}`);
    if (second.failed > 0 || second.rolledBack) fail("second apply did not succeed cleanly");
    if (second.receiptHead !== first.receiptHead) fail("re-running apply produced new receipt entries (not idempotent)");

    lines.push(ok ? "selftest: PASS" : "selftest: FAIL");
  } catch (err) {
    fail(`unexpected error: ${errMsg(err)}`);
  } finally {
    if (!keep.present) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    } else {
      lines.push(`--keep: fixture + data directory retained at ${root}`);
    }
  }

  return { code: ok ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

export const MIGRATE_USAGE: string[] = [
  "Usage: hades migrate <command>",
  "",
  "Commands:",
  "  scan [--json]                                       Discover real Hermes/OpenClaw installs",
  "  plan [--from DIR] [--vendor hermes|openclaw|auto]    Build (and print) a migration plan",
  "       [--only kinds] [--exclude kinds]",
  "       [--conflict skip|overwrite|rename|newest|ask]",
  "       [--no-keys] [--verbose] [--json]",
  "  apply ...same flags as plan... [--yes] [--json]      Apply the plan (dry run without --yes)",
  "  report [--json]                                      Summarize the receipt chain",
  "  selftest [--keep]                                    Real scan->plan->apply against fixtures",
  "  help                                                  Show this help",
];

function helpResult(): CliResult {
  return { code: 0, lines: MIGRATE_USAGE };
}

// ---------------------------------------------------------------------------
// runMigrateCommand
// ---------------------------------------------------------------------------

export async function runMigrateCommand(args: string[], deps: MigrateCommandDeps = defaultMigrateDeps()): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return helpResult();
    case "scan":
      return cmdScan(deps, rest);
    case "plan":
      return cmdPlan(deps, rest);
    case "apply":
      return cmdApply(deps, rest);
    case "report":
      return cmdReport(deps, rest);
    case "selftest":
      return cmdSelftest(deps, rest);
    default:
      return { code: 2, lines: [`Unknown migrate command: ${sub}`, ...MIGRATE_USAGE] };
  }
}
