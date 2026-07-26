/* ------------------------------------------------------------------ *
 * showdown-report.ts — honest rendering + durable artifacts for
 * `hades showdown` results.
 *
 * Both renderers refuse to render a tampered audit: they call
 * {@link verifyAuditChain} first and THROW if it fails, rather than ever
 * printing numbers whose provenance can't be independently re-derived.
 *
 * Every figure cell drawn from a `mode: "modeled"` run carries a literal
 * `(modeled)` suffix — there is no code path in this file that prints a
 * number without saying, right next to it, whether it was measured from a
 * real run or produced by the deterministic scripted demo.
 * ------------------------------------------------------------------ */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { verifyAuditChain } from "./showdown";
import type { AuditRecord, ShowdownMode, ShowdownResult } from "./showdown";
import type { VtphReport } from "./vtph";

// ===========================================================================
// Mode-honest figure formatting
// ===========================================================================

function fig(mode: ShowdownMode, text: string): string {
  return mode === "modeled" ? `${text} (modeled)` : text;
}

function num(mode: ShowdownMode, value: number, digits = 2): string {
  return fig(mode, Number.isFinite(value) ? value.toFixed(digits) : String(value));
}

function usd(mode: ShowdownMode, value: number): string {
  return fig(mode, `$${value.toFixed(4)}`);
}

function int(mode: ShowdownMode, value: number): string {
  return fig(mode, String(value));
}

function assertAuditOk(r: ShowdownResult): void {
  const check = verifyAuditChain(r.audit);
  if (!check.ok) {
    throw new Error(
      `showdown-report: refusing to render — audit chain verification failed at record index ` +
        `${check.brokenAt ?? "?"} (${r.audit.length} record(s)). A tampered or corrupted audit ` +
        "log is never rendered as if it were trustworthy."
    );
  }
}

function laneSummary(mode: ShowdownMode, label: string, r: VtphReport): string[] {
  return [
    `${label}:`,
    `  tasks:              ${int(mode, r.tasks)}`,
    `  verified-correct:   ${int(mode, r.verifiedCorrect)}`,
    `  silent-wrong:       ${int(mode, r.silentWrong)}`,
    `  declined:           ${int(mode, r.declined)}`,
    `  correct-unclaimed:  ${int(mode, r.correctButUnclaimed)}`,
    `  wall-clock:         ${num(mode, r.wallClockMs / 1000, 3)}s`,
    `  tokens:             ${int(mode, r.totalTokens)}`,
    `  spend:              ${usd(mode, r.totalUsd)}`,
    `  V-TPH:              ${num(mode, r.vtph)}`,
    `  V-TPH$ (north star): ${Number.isFinite(r.vtphPerDollar) ? num(mode, r.vtphPerDollar) : fig(mode, "n/a (zero spend)")}`,
    `  provenance-complete: ${fig(mode, `${(r.provenanceCompleteRate * 100).toFixed(0)}%`)}`,
  ];
}

// ===========================================================================
// Text renderer (terminal-friendly)
// ===========================================================================

/**
 * Human-readable line-by-line report for the CLI. Throws if the audit chain
 * doesn't independently re-verify — a broken chain is never rendered as if
 * it were a trustworthy result.
 */
export function renderShowdownText(r: ShowdownResult): string[] {
  assertAuditOk(r);

  const lines: string[] = [];
  lines.push(`SHOWDOWN — mode: ${r.mode.toUpperCase()}${r.mode === "modeled" ? " (deterministic scripted demo, not live inference)" : " (real inference)"}`);
  lines.push(`seed=${r.seed}  tasks=${r.taskCount}  audit-records=${r.audit.length} (chain verified OK)`);
  lines.push("");
  lines.push(...laneSummary(r.mode, "Swarm (verification-gated)", r.swarmReport));
  lines.push("");
  lines.push(...laneSummary(r.mode, "Baseline (self-trusting single agent)", r.baselineReport));
  lines.push("");
  lines.push(
    `V-TPH$ spread (best/worst): ${
      Number.isFinite(r.comparison.vtphPerDollarSpeedup) ? num(r.mode, r.comparison.vtphPerDollarSpeedup) + "x" : fig(r.mode, "n/a")
    }`
  );
  lines.push(
    `Trust: baseline silent-wrong = ${int(r.mode, r.baselineReport.silentWrong)}, ` +
      `swarm silent-wrong = ${int(r.mode, r.swarmReport.silentWrong)}.`
  );
  if (r.mode === "modeled") {
    lines.push("");
    lines.push(
      "All figures above are from the deterministic scripted demo (no network, no API key) — " +
        'every number is labeled "(modeled)". Run with --mode real (and a provider key) for a live-inference result.'
    );
  }
  return lines;
}

// ===========================================================================
// Markdown renderer (report.md)
// ===========================================================================

/**
 * Markdown report. A top banner states the mode; the comparison table's
 * numeric cells all carry the mode label ("(modeled)" when scripted).
 * Throws under the same tamper-refusal rule as {@link renderShowdownText}.
 * Robust to empty/all-rejected suites and unicode task ids (no raw `|`
 * pipes from task text ever reach the table — cell content is escaped).
 */
export function renderShowdownMarkdown(r: ShowdownResult): string {
  assertAuditOk(r);

  const lines: string[] = [];
  lines.push(`# Showdown — mode: **${r.mode.toUpperCase()}**`);
  lines.push("");
  if (r.mode === "modeled") {
    lines.push(
      "> Deterministic scripted demo (no network, no API key). Every figure below is labeled " +
        '`(modeled)`. Run `hades showdown run --mode real` with a provider key for a live-inference result.'
    );
  } else {
    lines.push("> Real-inference run — figures below were measured against a live provider.");
  }
  lines.push("");
  lines.push(`- seed: \`${r.seed}\``);
  lines.push(`- tasks: \`${r.taskCount}\``);
  lines.push(`- audit records: \`${r.audit.length}\` (hash chain independently re-verified OK)`);
  lines.push("");

  lines.push("| Lane | Tasks | Verified✓ | Silent✗ | Declined | V-TPH | Spend | V-TPH$/$ |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [label, rep] of [
    ["swarm", r.swarmReport],
    ["baseline", r.baselineReport],
  ] as const) {
    lines.push(
      `| ${escapeCell(label)} | ${int(r.mode, rep.tasks)} | ${int(r.mode, rep.verifiedCorrect)} | ` +
        `${int(r.mode, rep.silentWrong)} | ${int(r.mode, rep.declined)} | ${num(r.mode, rep.vtph)} | ` +
        `${usd(r.mode, rep.totalUsd)} | ${Number.isFinite(rep.vtphPerDollar) ? num(r.mode, rep.vtphPerDollar) : fig(r.mode, "n/a")} |`
    );
  }
  lines.push("");
  lines.push(
    `**V-TPH$ spread (best/worst): ${
      Number.isFinite(r.comparison.vtphPerDollarSpeedup) ? num(r.mode, r.comparison.vtphPerDollarSpeedup) + "x" : fig(r.mode, "n/a")
    }**`
  );
  lines.push("");
  lines.push(
    `Trust: baseline silent-wrong = ${int(r.mode, r.baselineReport.silentWrong)}, ` +
      `swarm silent-wrong = ${int(r.mode, r.swarmReport.silentWrong)}.`
  );

  lines.push("");
  lines.push(...renderAuditSample(r.audit));

  return lines.join("\n") + "\n";
}

/** A capped sample of the audit trail (first/last few records) so `report.md`
 *  stays a bounded size even for a 200-task (400-record) run, while still
 *  showing real per-task audit entries. Every cell is escaped so task ids —
 *  which may contain `|`, newlines, or unicode — can never corrupt the table
 *  structure. Handles an empty audit trail gracefully (no table at all). */
function renderAuditSample(audit: AuditRecord[]): string[] {
  if (audit.length === 0) return ["_Audit trail is empty (0 records)._"];

  const cap = 5;
  const head = audit.slice(0, cap);
  const tail = audit.length > cap * 2 ? audit.slice(-cap) : audit.slice(cap);
  const shown = [...head, ...tail];
  const omitted = audit.length - shown.length;

  const lines = ["### Audit sample", "", "| Seq | Lane | Verdict | Task |", "| ---: | --- | --- | --- |"];
  for (const rec of shown) {
    lines.push(`| ${rec.seq} | ${escapeCell(rec.lane)} | ${escapeCell(rec.verdict)} | ${escapeCell(rec.taskId)} |`);
  }
  if (omitted > 0) lines.push(`| … | … | … | *(${omitted} more record(s) omitted — see audit.jsonl)* |`);
  return lines;
}

/** Escape a cell so task text (including unicode, `|`, and newlines) can
 *  never break the markdown table's column structure. */
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// ===========================================================================
// Durable artifacts — atomic tmp-then-rename writes (house pattern, see
// src/swarm-runtime/persistence/state-store.ts's FileStateStore)
// ===========================================================================

/** Minimal, hand-written fs surface (not `typeof mkdir` etc.) so tests can
 *  inject a trivial in-memory fake without fighting node:fs/promises'
 *  overloaded signatures; the real node functions satisfy this structurally. */
export interface ShowdownFsDeps {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, data: string, encoding?: BufferEncoding): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

const defaultFs: ShowdownFsDeps = { mkdir, writeFile, rename };

async function writeAtomic(fs: ShowdownFsDeps, path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, path);
}

/**
 * Write `report.md`, `audit.jsonl` (one {@link AuditRecord} per line), and
 * `result.json` (the full {@link ShowdownResult}) into `dir`. Every file is
 * written to a `.tmp` sibling then renamed into place, so a crash mid-write
 * can never leave a corrupted artifact on disk. Throws (writes nothing) if
 * the audit chain doesn't verify — same tamper-refusal as the renderers.
 */
export async function writeShowdownArtifacts(
  r: ShowdownResult,
  dir: string,
  fs: ShowdownFsDeps = defaultFs
): Promise<{ files: string[] }> {
  const markdown = renderShowdownMarkdown(r); // throws first, before any I/O, on a broken chain

  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);

  const reportPath = join(dir, "report.md");
  const auditPath = join(dir, "audit.jsonl");
  const resultPath = join(dir, "result.json");

  const auditJsonl = r.audit.map((rec: AuditRecord) => JSON.stringify(rec)).join("\n") + (r.audit.length ? "\n" : "");
  const resultJson = JSON.stringify(r, null, 2) + "\n";

  await fs.mkdir(dirname(reportPath), { recursive: true }).catch(() => undefined);
  await writeAtomic(fs, reportPath, markdown);
  await writeAtomic(fs, auditPath, auditJsonl);
  await writeAtomic(fs, resultPath, resultJson);

  return { files: [reportPath, auditPath, resultPath] };
}
