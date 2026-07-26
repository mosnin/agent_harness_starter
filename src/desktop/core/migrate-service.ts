/**
 * Desktop `migrate.*` service — the real migration engine behind the desktop
 * app's "Import from Hermes / OpenClaw" surface.
 *
 * This is NOT a second implementation of migration. It drives exactly the
 * pipeline functions `hades migrate` drives (`migrateScan`,
 * `migratePlanPreview`, `migrateApply`, `migrateReceiptSummary` in
 * `src/hades/cli/migrate-command.ts`), so a plan previewed in the desktop app
 * and a plan previewed in a terminal are the same plan, hash for hash, over
 * the same `<dataDir>`.
 *
 * Three rules this service holds:
 *
 *  1. **Applying requires explicit confirmation.** `migrate.apply` without
 *     `confirm: true` returns a PREVIEW (`migrate.plan`, `dryRun: true`) and
 *     writes nothing — the desktop equivalent of `--yes`. Even if a confirmed
 *     apply were somehow built from a preview plan, `applyMigrationPlan`
 *     refuses `dryRun` plans outright.
 *  2. **A blocked plan is never applied.** `migrateApply` refuses and the
 *     refusal is reported verbatim in `MigrateApplyView.refused`, with zero
 *     counts — never a partial success.
 *  3. **Secret material never reaches the wire.** Views carry env-var NAMES
 *     and counts. The vault holding real key material is process-local and is
 *     never serialized (`SecretVault` has no accessor that JSON can reach).
 *
 * Every failure becomes a `migrate.error` event carrying the real error
 * message — never silence, and never an empty scan result that a renderer
 * would legitimately read as "you have nothing to migrate".
 */

import {
  defaultMigrateDeps,
  migrateApply,
  migratePlanPreview,
  migrateReceiptSummary,
  migrateScan,
  type MigrateCommandDeps,
  type MigratePipelineOptions,
  type MigrateReceiptSummary,
  type MigrateScanSummary,
} from "../../hades/cli/migrate-command";
import type { ArtifactKind } from "../../hades/migrate/ir";
import type { MigrationPlan } from "../../hades/migrate/plan";
import type { ApplyResult } from "../../hades/migrate/apply";
import type {
  MigrateApplyView,
  MigrateCommand,
  MigrateEvent,
  MigratePlanView,
  MigrateReceiptsView,
  MigrateScanView,
} from "../ipc/migrate-contract";

export interface MigrateServiceOptions {
  /**
   * Engine deps (data directory, env, platform, home). Defaults to
   * `defaultMigrateDeps(process.env)` — i.e. the SAME `$HADES_DATA_DIR|.hades`
   * install every other Hades surface uses.
   */
  deps?: MigrateCommandDeps;
  /** Clock for event timestamps (defaults to `Date.now`). */
  now?: () => number;
}

function countsToArray<K extends string>(counts: Record<string, number>, field: K): Array<Record<K, string> & { count: number }> {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => ({ [field]: key, count } as Record<K, string> & { count: number }));
}

function toScanView(scan: MigrateScanSummary): MigrateScanView {
  return {
    sources: scan.sources.map((s) => ({
      vendor: s.vendor,
      layout: s.layout,
      root: s.root,
      confidence: s.confidence,
      ...(s.version !== undefined ? { version: s.version } : {}),
      itemCount: s.itemCount,
      warnings: [...s.warnings],
      read: s.read,
    })),
    searched: [...scan.searched],
    skipped: scan.skipped.map((s) => ({ ...s })),
    readErrors: scan.readErrors.map((e) => ({ ...e })),
    notes: [...scan.notes],
    // NAMES only. `MigrateScanSummary.secretEnvVars` is derived from vault
    // descriptors, which by construction never carry material.
    secretEnvVars: [...scan.secretEnvVars],
  };
}

function toPlanView(plan: MigrationPlan): MigratePlanView {
  return {
    createdAt: plan.createdAt,
    dryRun: plan.dryRun,
    planHash: plan.planHash,
    sources: plan.sources.map((s) => ({ vendor: s.vendor, root: s.root, layout: s.layout, itemCount: s.itemCount })),
    actions: plan.actions.map((a) => ({
      itemKey: a.itemKey,
      kind: a.kind,
      action: a.action,
      reason: a.reason,
      vendor: a.vendor,
      sourcePath: a.sourcePath,
      risk: a.risk,
      itemHash: a.itemHash,
      ...(a.renamedTo !== undefined ? { renamedTo: a.renamedTo } : {}),
    })),
    blockers: plan.blockers.map((b) => ({ code: b.code, message: b.message, ...(b.path !== undefined ? { path: b.path } : {}) })),
    unimportable: plan.unimportable.map((u) => ({ path: u.path, kind: u.kind, reason: u.reason, vendor: u.vendor })),
    warnings: [...plan.warnings],
    byAction: countsToArray(plan.summary.byAction, "action"),
    byKind: countsToArray(plan.summary.byKind, "kind"),
    destructive: plan.summary.destructive,
    secretsToWrite: plan.summary.secretsToWrite,
    alreadyImported: plan.summary.alreadyImported,
  };
}

function toApplyView(result: ApplyResult): MigrateApplyView {
  return {
    applied: result.applied,
    failed: result.failed,
    quarantined: result.quarantined,
    secretsWritten: result.secretsWritten,
    rolledBack: result.rolledBack,
    durationMs: result.durationMs,
    receiptPath: result.receiptPath,
    receiptHead: result.receiptHead,
    outcomes: result.outcomes.map((o) => ({ itemKey: o.itemKey, action: o.action, ok: o.ok, detail: o.detail })),
  };
}

function toReceiptsView(summary: MigrateReceiptSummary): MigrateReceiptsView {
  return {
    receiptPath: summary.receiptPath,
    total: summary.total,
    ok: summary.ok,
    failed: summary.failed,
    chainOk: summary.chainOk,
    ...(summary.brokenAt !== undefined ? { brokenAt: summary.brokenAt } : {}),
    ...(summary.lastAt !== undefined ? { lastAt: summary.lastAt } : {}),
    byAction: countsToArray(summary.byAction, "action"),
  };
}

function toOptions(cmd: MigrateCommand): MigratePipelineOptions {
  if (cmd.kind === "migrate.receipts") return {};
  return {
    ...(cmd.from !== undefined ? { from: cmd.from } : {}),
    ...(cmd.vendor !== undefined ? { vendor: cmd.vendor } : {}),
    ...(cmd.conflict !== undefined ? { conflict: cmd.conflict } : {}),
    // The wire's kind strings and the engine's `ArtifactKind` union are the
    // same set — `MIGRATE_ARTIFACT_KINDS` mirrors it and the guard rejects
    // anything else, so this is a narrowing, not a trust-the-caller cast.
    ...(cmd.only !== undefined ? { only: cmd.only as ArtifactKind[] } : {}),
    ...(cmd.exclude !== undefined ? { exclude: cmd.exclude as ArtifactKind[] } : {}),
    ...(cmd.importSecrets !== undefined ? { importSecrets: cmd.importSecrets } : {}),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MigrateService {
  private readonly deps: MigrateCommandDeps;
  private readonly now: () => number;

  constructor(opts: MigrateServiceOptions = {}) {
    this.deps = opts.deps ?? defaultMigrateDeps(process.env);
    this.now = opts.now ?? (() => Date.now());
  }

  async handle(cmd: MigrateCommand): Promise<MigrateEvent> {
    const at = this.now();
    try {
      switch (cmd.kind) {
        case "migrate.scan": {
          const scan = await migrateScan(this.deps, toOptions(cmd));
          return { kind: "migrate.sources", scan: toScanView(scan), at };
        }
        case "migrate.plan": {
          const { plan, scan } = await migratePlanPreview(this.deps, toOptions(cmd));
          return { kind: "migrate.plan", plan: toPlanView(plan), scan: toScanView(scan), at };
        }
        case "migrate.apply": {
          if (!cmd.confirm) {
            // Unconfirmed apply === preview. Nothing is written, and the plan
            // is returned marked `dryRun` so the UI cannot present it as a
            // completed migration.
            const { plan, scan } = await migratePlanPreview(this.deps, toOptions(cmd));
            return { kind: "migrate.plan", plan: toPlanView(plan), scan: toScanView(scan), at };
          }
          const { plan, result, refused } = await migrateApply(this.deps, toOptions(cmd));
          const planView = toPlanView(plan);
          if (!result) {
            return {
              kind: "migrate.applied",
              plan: planView,
              result: {
                applied: 0,
                failed: 0,
                quarantined: 0,
                secretsWritten: 0,
                rolledBack: false,
                durationMs: 0,
                receiptPath: "",
                receiptHead: "",
                refused: refused ?? "the migration was refused",
                outcomes: [],
              },
              at,
            };
          }
          return { kind: "migrate.applied", plan: planView, result: toApplyView(result), at };
        }
        case "migrate.receipts":
          return { kind: "migrate.receipts", receipts: toReceiptsView(migrateReceiptSummary(this.deps)), at };
        default: {
          const exhaustive: never = cmd;
          return { kind: "migrate.error", op: String((exhaustive as { kind?: string }).kind), message: "unknown migrate command", at };
        }
      }
    } catch (err) {
      return { kind: "migrate.error", op: cmd.kind, message: errMsg(err), at };
    }
  }
}
