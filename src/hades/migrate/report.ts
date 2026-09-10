/**
 * Honest, terminal-grade rendering of a {@link MigrationPlan}: a dry-run
 * preview (`renderPlanText` / `renderPlanJson`), a post-apply reconciliation
 * report (`renderApplyReport`), and a small per-action diff view
 * (`renderDiff`). Pure string/JSON transforms over data `plan.ts` already
 * computed -- no I/O, no clock, no fs.
 *
 * Rendering discipline this module holds itself to:
 *
 *  - **No ANSI unless asked.** Every color escape is applied to a whole
 *    already-wrapped line, never a fragment -- wrapping happens on plain
 *    text first, so an escape sequence can never be split across a wrap
 *    boundary.
 *  - **Hard-wrapped to `width`.** Every line respects the caller's `width`
 *    (default 100, floor 20); long "words" (hashes, paths) are hard-broken
 *    rather than left to overflow.
 *  - **A `[dry run]` banner that cannot be omitted** when `plan.dryRun` is
 *    true -- it is always the first line `renderPlanText` emits in that
 *    case, unconditionally.
 *  - **An explicit "NOT IMPORTED" section.** Every entry in
 *    `plan.unimportable` is listed by path and reason -- never summarized
 *    as a bare count and never truncated.
 *  - **Counts a caller can independently verify.** The header line's
 *    action-kind counts are recomputed directly from `plan.actions` here
 *    (not merely copied from `plan.summary`), so a rendering bug in one
 *    place can't silently mismatch the other.
 *  - **`renderApplyReport` never claims success for silence.** Any planned
 *    action with no corresponding {@link ApplyOutcome} is reported as
 *    missing (`reconciled: false`, listed in `missing`), never folded into
 *    an implicit "ok".
 */

import type { JsonValue } from "../state/record";
import type { BlockerCode, MigrationPlan, PlannedAction, PlannedActionKind } from "./plan";

// ---------------------------------------------------------------------------
// ANSI (only ever applied to whole, already-wrapped lines)
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

function colorize(text: string, color: boolean, code: string | undefined): string {
  if (!color || !code || text.length === 0) return text;
  return `${code}${text}${RESET}`;
}

// ---------------------------------------------------------------------------
// Wrapping / width
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 100;
const MIN_WIDTH = 20;

function clampWidth(w?: number): number {
  if (w === undefined || !Number.isFinite(w)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.floor(w));
}

/** Word-wraps plain text to `width`, hard-breaking any single "word" that alone exceeds `width`. Never touches ANSI escapes (none are present at this stage). */
function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= width) {
      out.push(rawLine);
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > width) {
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      out.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).replace(/^ +/, "");
    }
    out.push(remaining);
  }
  return out.length ? out : [""];
}

function wrapAndColor(text: string, width: number, color: boolean, code?: string): string[] {
  return wrapPlain(text, width).map((l) => colorize(l, color, code));
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

const KIND_COL = 13; // longest ArtifactKind is "context-file" (12)
const ACTION_COL = 11; // longest PlannedActionKind is "quarantine" (10)

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function riskColor(risk: PlannedAction["risk"]): string | undefined {
  if (risk === "destructive") return RED;
  if (risk === "low") return YELLOW;
  return undefined;
}

function actionRow(a: PlannedAction, width: number, color: boolean, verbose: boolean): string[] {
  const prefix = `${pad(a.kind, KIND_COL)} ${pad(a.action, ACTION_COL)} `;
  let rest = `${a.itemKey} :: ${a.reason}`;
  if (verbose) {
    const targetBits: string[] = [];
    if (a.target.path !== undefined) targetBits.push(`path=${a.target.path}`);
    if (a.target.id !== undefined) targetBits.push(`id=${a.target.id}`);
    if (a.target.field !== undefined) targetBits.push(`field=${a.target.field}`);
    const extra: string[] = [`vendor=${a.vendor}`, `source=${a.sourcePath}`, `risk=${a.risk}`, `hash=${a.itemHash.slice(0, 12)}`];
    if (targetBits.length) extra.push(`target(${targetBits.join(",")})`);
    if (a.conflict) extra.push(`conflict(with=${a.conflict.with}; policy=${a.conflict.policy}; incumbentNewer=${a.conflict.incumbentNewer})`);
    if (a.renamedTo !== undefined) extra.push(`renamedTo=${a.renamedTo}`);
    rest += ` [${extra.join(" ")}]`;
  }
  const contWidth = Math.max(10, width - prefix.length);
  const wrapped = wrapPlain(rest, contWidth);
  const code = riskColor(a.risk);
  return wrapped.map((line, i) => {
    const full = i === 0 ? prefix + line : " ".repeat(prefix.length) + line;
    return colorize(full, color, code);
  });
}

// ---------------------------------------------------------------------------
// renderPlanText
// ---------------------------------------------------------------------------

function recomputeByAction(actions: PlannedAction[]): Record<PlannedActionKind, number> {
  const counts: Record<PlannedActionKind, number> = {
    import: 0,
    merge: 0,
    rename: 0,
    overwrite: 0,
    skip: 0,
    quarantine: 0,
    abstain: 0,
  };
  for (const a of actions) counts[a.action] += 1;
  return counts;
}

export function renderPlanText(plan: MigrationPlan, opts?: { color?: boolean; width?: number; verbose?: boolean }): string[] {
  const color = opts?.color ?? false;
  const width = clampWidth(opts?.width);
  const verbose = opts?.verbose ?? false;
  const lines: string[] = [];

  if (plan.dryRun) {
    lines.push(...wrapAndColor("[dry run] no changes will be applied -- this is a preview only", width, color, RED + BOLD));
  }

  lines.push(...wrapAndColor(`Migration plan created ${new Date(plan.createdAt).toISOString()} (planHash ${plan.planHash.slice(0, 16)})`, width, color, DIM));

  const byAction = recomputeByAction(plan.actions);
  const destructive = plan.actions.filter((a) => a.risk === "destructive").length;
  const summaryLine =
    `${plan.actions.length} action(s) planned across ${plan.sources.length} source(s): ` +
    `import=${byAction.import} merge=${byAction.merge} rename=${byAction.rename} overwrite=${byAction.overwrite} ` +
    `skip=${byAction.skip} quarantine=${byAction.quarantine} abstain=${byAction.abstain}`;
  lines.push(...wrapAndColor(summaryLine, width, color, CYAN));

  if (destructive > 0) {
    lines.push(...wrapAndColor(`WARNING: ${destructive} destructive action(s) planned -- review before applying`, width, color, RED + BOLD));
  }

  lines.push("");
  lines.push(...wrapAndColor(`SOURCES (${plan.sources.length}):`, width, color, BOLD));
  if (plan.sources.length === 0) {
    lines.push(...wrapAndColor("  (none)", width, color));
  } else {
    for (const s of plan.sources) {
      lines.push(...wrapAndColor(`  - ${s.vendor} / ${s.layout} :: ${s.root} (${s.itemCount} item(s))`, width, color));
    }
  }

  lines.push("");
  lines.push(...wrapAndColor(`BLOCKERS (${plan.blockers.length}):`, width, color, plan.blockers.length > 0 ? RED + BOLD : BOLD));
  if (plan.blockers.length === 0) {
    lines.push(...wrapAndColor("  (none)", width, color));
  } else {
    for (const b of plan.blockers) {
      const pathBit = b.path !== undefined ? ` (${b.path})` : "";
      lines.push(...wrapAndColor(`  - [${b.code}] ${b.message}${pathBit}`, width, color, RED));
    }
  }

  lines.push("");
  lines.push(...wrapAndColor(`ACTIONS (${plan.actions.length}):`, width, color, BOLD));
  if (plan.actions.length === 0) {
    lines.push(...wrapAndColor("  (none)", width, color));
  } else {
    for (const a of plan.actions) {
      lines.push(...actionRow(a, width, color, verbose));
    }
  }

  lines.push("");
  lines.push(...wrapAndColor(`NOT IMPORTED (${plan.unimportable.length}):`, width, color, plan.unimportable.length > 0 ? YELLOW + BOLD : BOLD));
  if (plan.unimportable.length === 0) {
    lines.push(...wrapAndColor("  (none)", width, color));
  } else {
    for (const u of plan.unimportable) {
      lines.push(...wrapAndColor(`  - ${u.path} [${u.kind}] (${u.vendor}): ${u.reason}`, width, color, YELLOW));
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push(...wrapAndColor(`NOTES (${plan.warnings.length}):`, width, color, BOLD));
    for (const w of plan.warnings) {
      lines.push(...wrapAndColor(`  - ${w}`, width, color, DIM));
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// renderPlanJson
// ---------------------------------------------------------------------------

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

export function renderPlanJson(plan: MigrationPlan): JsonValue {
  return {
    createdAt: plan.createdAt,
    dryRun: plan.dryRun,
    planHash: plan.planHash,
    sources: plan.sources.map((s) => ({ vendor: s.vendor, root: s.root, layout: s.layout, itemCount: s.itemCount })),
    actions: plan.actions.map(actionToJson),
    unimportable: plan.unimportable.map((u) => ({ path: u.path, kind: u.kind, reason: u.reason, vendor: u.vendor })),
    blockers: plan.blockers.map((b) => ({ code: b.code, message: b.message, ...(b.path !== undefined ? { path: b.path } : {}) })),
    warnings: [...plan.warnings],
    summary: {
      byKind: { ...plan.summary.byKind },
      byAction: { ...plan.summary.byAction },
      destructive: plan.summary.destructive,
      secretsToWrite: plan.summary.secretsToWrite,
      alreadyImported: plan.summary.alreadyImported,
    },
  };
}

// ---------------------------------------------------------------------------
// renderApplyReport
// ---------------------------------------------------------------------------

export interface ApplyOutcome {
  itemKey: string;
  action: PlannedActionKind;
  ok: boolean;
  detail: string;
  target?: string;
}

export function renderApplyReport(
  plan: MigrationPlan,
  outcomes: ApplyOutcome[],
  opts?: { width?: number; json?: boolean },
): { lines: string[]; json: JsonValue; reconciled: boolean; missing: string[] } {
  const width = clampWidth(opts?.width);
  const outcomesByKey = new Map<string, ApplyOutcome>();
  for (const o of outcomes) {
    // Last one wins if a caller reported the same itemKey twice -- still deterministic.
    outcomesByKey.set(o.itemKey, o);
  }

  const missing: string[] = [];
  const rows: Array<{ itemKey: string; kind: string; plannedAction: PlannedActionKind; outcome?: ApplyOutcome }> = [];
  for (const a of plan.actions) {
    const outcome = outcomesByKey.get(a.itemKey);
    if (!outcome) missing.push(a.itemKey);
    rows.push({ itemKey: a.itemKey, kind: a.kind, plannedAction: a.action, outcome });
  }

  const extraOutcomeKeys = outcomes
    .map((o) => o.itemKey)
    .filter((k) => !plan.actions.some((a) => a.itemKey === k));

  const reconciled = missing.length === 0;

  const succeeded = rows.filter((r) => r.outcome?.ok === true).length;
  const failed = rows.filter((r) => r.outcome !== undefined && r.outcome.ok === false).length;

  const json: JsonValue = {
    reconciled,
    missing: [...missing],
    total: plan.actions.length,
    succeeded,
    failed,
    extraOutcomes: [...extraOutcomeKeys],
    rows: rows.map((r) => ({
      itemKey: r.itemKey,
      kind: r.kind,
      plannedAction: r.plannedAction,
      ...(r.outcome !== undefined
        ? {
            reported: true,
            ok: r.outcome.ok,
            detail: r.outcome.detail,
            actualAction: r.outcome.action,
            ...(r.outcome.target !== undefined ? { target: r.outcome.target } : {}),
          }
        : { reported: false }),
    })),
  };

  if (opts?.json) {
    return { lines: JSON.stringify(json, null, 2).split("\n"), json, reconciled, missing };
  }

  const lines: string[] = [];
  lines.push(...wrapPlain(`Apply report: ${succeeded}/${plan.actions.length} succeeded, ${failed} failed, ${missing.length} missing`, width));
  lines.push(...wrapPlain(`reconciled: ${reconciled}`, width));
  if (extraOutcomeKeys.length > 0) {
    lines.push(...wrapPlain(`NOTE: ${extraOutcomeKeys.length} outcome(s) reported for item key(s) not present in the plan and were ignored for reconciliation: ${extraOutcomeKeys.join(", ")}`, width));
  }
  lines.push("");
  for (const r of rows) {
    const prefix = `${pad(r.kind, KIND_COL)} ${pad(r.plannedAction, ACTION_COL)} `;
    let status: string;
    if (!r.outcome) {
      status = `${r.itemKey} :: MISSING -- no outcome was reported for this planned action`;
    } else {
      const mismatch = r.outcome.action !== r.plannedAction ? ` (reported action "${r.outcome.action}" differs from planned "${r.plannedAction}")` : "";
      status = `${r.itemKey} :: ${r.outcome.ok ? "OK" : "FAILED"}: ${r.outcome.detail}${mismatch}`;
    }
    const contWidth = Math.max(10, width - prefix.length);
    const wrapped = wrapPlain(status, contWidth);
    wrapped.forEach((line, i) => lines.push(i === 0 ? prefix + line : " ".repeat(prefix.length) + line));
  }

  return { lines, json, reconciled, missing };
}

// ---------------------------------------------------------------------------
// renderDiff
// ---------------------------------------------------------------------------

function previewJson(v: JsonValue): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = "undefined";
  const MAX = 200;
  return s.length > MAX ? `${s.slice(0, MAX)}...` : s;
}

export function renderDiff(action: PlannedAction, incumbent?: JsonValue): string[] {
  const lines: string[] = [];
  lines.push(`${action.kind}:${action.itemKey} -> ${action.action} (risk=${action.risk})`);
  if (action.conflict) {
    lines.push(`  conflict with: ${action.conflict.with} (policy=${action.conflict.policy}, incumbentNewer=${action.conflict.incumbentNewer})`);
  }
  if (incumbent !== undefined) {
    lines.push(`  before: ${previewJson(incumbent)}`);
  }
  const targetBits: string[] = [];
  if (action.target.field !== undefined) targetBits.push(`field=${action.target.field}`);
  if (action.target.path !== undefined) targetBits.push(`path=${action.target.path}`);
  if (action.target.id !== undefined) targetBits.push(`id=${action.target.id}`);
  if (targetBits.length > 0) lines.push(`  target: ${targetBits.join(", ")}`);
  if (action.renamedTo !== undefined) lines.push(`  renamed to: ${action.renamedTo}`);
  lines.push(`  reason: ${action.reason}`);
  return lines;
}

// Re-exported purely so callers of report.ts don't need a second import from ./plan for this common type.
export type { BlockerCode };
