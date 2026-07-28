/**
 * `hades cost` — what runs on this machine ACTUALLY cost.
 *
 * This is the surface that answers the one question the whole
 * correct-work-per-dollar thesis rests on: *what did that just cost me?*
 * Everything it prints is MEASURED — provider-reported token counts from real
 * responses, multiplied by a cited list price, over a real clock — or it is
 * explicitly UNKNOWN. There is no modeled lane here at all, which is why no
 * line carries the `(modeled)` label used by `../bench/showdown.ts`: a figure
 * on this surface is either measured or absent.
 *
 *   hades cost                 the most recent recorded run
 *   hades cost last            (same)
 *   hades cost session         totals across every recorded run
 *   hades cost runs [--limit N]  one line per run, newest first
 *   hades cost prices [model]  the price table, its sources, and its staleness
 *   hades cost help
 *
 * ## Nothing here is trusted; everything is recomputed
 *
 * The journal stores each run's individual calls. Every aggregate this
 * command prints is re-derived from those calls with the same `summarizeCalls`
 * that produced them live — the `report` field a record also carries is never
 * read. A hand-edited total in `runs.jsonl` therefore cannot become a
 * reported number, the same way `showdown live-verify` re-derives a manifest
 * rather than believing it.
 *
 * ## What it refuses to do
 *
 * - It will not estimate a run that was never recorded. An empty journal
 *   reports "no runs recorded" and says how to produce one.
 * - It will not price a model the table does not know. Those calls are
 *   counted, named, and their spend reported UNKNOWN — never folded in at $0,
 *   which would understate the bill and inflate every per-dollar metric.
 * - It will not hide unreadable lines. A corrupt record is skipped AND
 *   counted, so an under-report is visible instead of silent.
 *
 * Terminal-free and deps-injected (same pattern as the rest of `./`), so it
 * unit-tests with no filesystem and no clock.
 *
 * @module hades/cli/cost-command
 */

import { readFileSync } from "node:fs";
import {
  describeModelSpend,
  describeModelTokens,
  describeSpend,
  describeTokens,
  formatCostReport,
  formatMs,
  type CostReport,
} from "../cost/meter";
import {
  costJournalPath,
  readRunCosts,
  recomputeRunReport,
  totalRunCosts,
  type RunCostRecord,
} from "../cost/journal";
import {
  PRICES_FILE_VAR,
  PRICE_TABLE_CAVEAT,
  loadPriceTableFromEnv,
  type ModelPrice,
} from "../cost/prices";
import type { CliResult } from "./cli";

export interface CostCommandDeps {
  /** Path to the run journal. Defaults to `<HADES_DATA_DIR|.hades>/cost/runs.jsonl`. */
  journalPath?: string;
  /** Environment (read for `HADES_DATA_DIR` and `HADES_PRICES_FILE`). */
  env: Record<string, string | undefined>;
  /** File reader for both the journal and any price override. Injectable for tests. */
  readFile?: (path: string) => string;
}

const USAGE = [
  "Usage: hades cost [command]",
  "",
  "Commands:",
  "  (no args) | last     The most recent recorded run: measured tokens,",
  "                       measured dollars, measured wall clock.",
  "  session              Totals across every recorded run in the journal.",
  "  runs [--limit N]     One line per recorded run, newest first (default 10).",
  "  prices [model]       The per-model price table with, for each entry, the",
  "                       page it was transcribed from and the date that line",
  "                       was last edited in this repo.",
  "  help                 Show this help",
  "",
  "Every figure is MEASURED (provider-reported tokens x a cited list price, over",
  "a real clock) or explicitly UNKNOWN. A model with no published price is named",
  "and its spend reported UNKNOWN — never counted as $0, which would understate",
  `the bill. Override the price table with ${PRICES_FILE_VAR}=<path-to-json>.`,
];

/** Resolve the journal path the same way every other surface resolves data. */
function resolveJournalPath(deps: CostCommandDeps): string {
  if (deps.journalPath) return deps.journalPath;
  return costJournalPath(deps.env.HADES_DATA_DIR ?? ".hades");
}

/** ISO-8601 for a display timestamp; `"n/a"` for a missing one. */
function iso(at: number | null): string {
  if (at === null || !Number.isFinite(at)) return "n/a";
  return new Date(at).toISOString();
}

/**
 * Load the price table for this process, and the lines that must accompany it.
 * A broken `HADES_PRICES_FILE` never silently downgrades to the builtin table:
 * the problem is returned as a printable line.
 */
function resolvePrices(deps: CostCommandDeps): { table: readonly ModelPrice[]; notes: string[] } {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const resolution = loadPriceTableFromEnv(deps.env, read);
  const notes: string[] = [];
  if (resolution.problem) notes.push(`! ${resolution.problem}`);
  else if (resolution.source !== "builtin") notes.push(`price table: ${resolution.source} (operator override)`);
  return { table: resolution.table, notes };
}

/** Read + shape-check the journal, returning printable notes about what failed. */
function loadHistory(deps: CostCommandDeps): {
  path: string;
  records: RunCostRecord[];
  notes: string[];
  missing: boolean;
} {
  const path = resolveJournalPath(deps);
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const history = readRunCosts(path, read);
  const notes: string[] = [];
  if (history.skippedLines > 0) {
    // "above", not "below": every caller appends these notes AFTER the figures
    // (costLast / costSession / costRuns all end with `...notes`), and in
    // `cost runs` there are no totals at all — only per-run rows. A caveat that
    // points at nothing is a caveat an operator will not connect to the number
    // it qualifies.
    notes.push(
      `! ${history.skippedLines} unreadable record(s) in ${path} were SKIPPED — ` +
        "every figure above is therefore a lower bound",
    );
  }
  return { path, records: history.records, notes, missing: history.missing };
}

/** The line printed when there is nothing measured to report. */
function emptyLines(path: string): string[] {
  return [
    `No runs recorded yet (${path} does not exist).`,
    "",
    "A record is written by a run that actually reached a provider — e.g.",
    "  hades chat --once \"hello\"    (with ANTHROPIC_API_KEY or OPENAI_API_KEY set)",
    "",
    "The [mock] brain writes nothing on purpose: it makes no provider call, so it",
    "has no cost, and a $0 row would be indistinguishable from a real free run.",
  ];
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function costLast(deps: CostCommandDeps): CliResult {
  const { path, records, notes, missing } = loadHistory(deps);
  if (missing || records.length === 0) {
    return { code: 0, lines: missing ? emptyLines(path) : [`No runs recorded yet (${path} is empty).`, ...notes] };
  }
  const { table, notes: priceNotes } = resolvePrices(deps);

  // "Last" = latest by START time, not file order: a long run started before
  // a short one can be appended after it.
  const last = [...records].sort((a, b) => a.startedAt - b.startedAt)[records.length - 1];
  const report = recomputeRunReport(last, table);

  const lines = [
    `last run — ${last.surface} (${last.runId})`,
    `  started            ${iso(last.startedAt)}`,
    ...(last.model ? [`  model              ${last.model}${last.provider ? ` via ${last.provider}` : ""}`] : []),
    ...formatCostReport(report, { wallClockMs: last.wallClockMs }),
    ...perModelLines(report),
    ...priceNotes.map((n) => `  ${n}`),
    ...notes.map((n) => `  ${n}`),
  ];
  return { code: 0, lines };
}

function costSession(deps: CostCommandDeps): CliResult {
  const { path, records, notes, missing } = loadHistory(deps);
  if (missing || records.length === 0) {
    return { code: 0, lines: missing ? emptyLines(path) : [`No runs recorded yet (${path} is empty).`, ...notes] };
  }
  const { table, notes: priceNotes } = resolvePrices(deps);
  const totals = totalRunCosts(records, table);

  const lines = [
    `session totals — ${totals.runs} recorded run(s) from ${path}`,
    `  first / last run   ${iso(totals.firstAt)} .. ${iso(totals.lastAt)}`,
    ...formatCostReport(totals.report),
    // Summed, not elapsed: these runs were separate processes, so they did
    // not overlap and there is no single interval to quote.
    `  run wall clock     ${formatMs(totals.wallClockMs)} summed across runs (measured)`,
    ...perModelLines(totals.report),
    ...priceNotes.map((n) => `  ${n}`),
    ...notes.map((n) => `  ${n}`),
  ];
  return { code: 0, lines };
}

/** Per-model rollup. `UNKNOWN` where the model has no published price. */
function perModelLines(report: CostReport): string[] {
  if (report.byModel.length === 0) return [];
  const lines = ["  by model:"];
  for (const m of report.byModel) {
    const missing = m.usageMissingCalls > 0 ? `, ${m.usageMissingCalls} without usage` : "";
    lines.push(
      `    ${m.model}  ${m.calls} call(s)${missing}  ${describeModelTokens(m)}  ${describeModelSpend(m)}`,
    );
  }
  return lines;
}

function costRuns(args: string[], deps: CostCommandDeps): CliResult {
  const limitIdx = args.indexOf("--limit");
  let limit = 10;
  if (limitIdx !== -1) {
    const raw = args[limitIdx + 1];
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return { code: 1, lines: [`Invalid --limit value: "${raw ?? ""}" — expected a positive integer.`] };
    }
    limit = n;
  }

  const { path, records, notes, missing } = loadHistory(deps);
  if (missing || records.length === 0) {
    return { code: 0, lines: missing ? emptyLines(path) : [`No runs recorded yet (${path} is empty).`, ...notes] };
  }
  const { table, notes: priceNotes } = resolvePrices(deps);

  const newest = [...records].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  // NOT "all figures measured". Rows below can legitimately read `UNKNOWN — no
  // call reported usage, so nothing can be priced`; a header asserting
  // completeness over rows that contradict it is the overclaim, even though
  // each row self-labels correctly. What is true of every row is that nothing
  // here was estimated: it is either measured or named UNKNOWN.
  const lines = [
    `${newest.length} of ${records.length} recorded run(s), newest first — every figure is measured or UNKNOWN, never estimated`,
  ];
  for (const r of newest) {
    const report = recomputeRunReport(r, table);
    lines.push(
      `  ${iso(r.startedAt)}  ${r.surface.padEnd(10)}  ${String(report.calls).padStart(3)} call(s)  ` +
        `${describeTokens(report)} tokens  ${describeSpend(report)}  ${formatMs(r.wallClockMs)}`,
    );
  }
  lines.push(...priceNotes.map((n) => `  ${n}`), ...notes.map((n) => `  ${n}`));
  return { code: 0, lines };
}

function costPrices(args: string[], deps: CostCommandDeps): CliResult {
  const { table, notes } = resolvePrices(deps);
  const filter = args.find((a) => !a.startsWith("--"));
  const rows = filter ? table.filter((p) => p.model === filter) : table;

  if (rows.length === 0) {
    return {
      code: 0,
      lines: [
        `${filter} is NOT in the price table — its cost is UNKNOWN, not $0.`,
        "",
        `Priced models: ${table.map((p) => p.model).join(", ") || "(none)"}`,
        `Add it by pointing ${PRICES_FILE_VAR} at a JSON array of`,
        "  { model, inputUsdPerMTok, outputUsdPerMTok, source }",
        ...notes,
      ],
    };
  }

  const lines = [`${rows.length} priced model(s) — USD per 1e6 tokens`, ...notes];
  for (const p of rows) {
    lines.push(
      `  ${p.model}`,
      `    in $${p.inputUsdPerMTok} / out $${p.outputUsdPerMTok} per Mtok`,
      `    source: ${p.source}`,
      `    line last edited in this repo: ${p.lastEditedInRepo} (NOT a re-check of the vendor's page)`,
    );
  }
  lines.push("", PRICE_TABLE_CAVEAT);
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** `hades cost <sub>`. Exit 0 for every successful report; 1 for bad usage. */
export function runCostCommand(args: string[], deps: CostCommandDeps): CliResult {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "last":
      return costLast(deps);
    case "session":
      return costSession(deps);
    case "runs":
      return costRuns(rest, deps);
    case "prices":
      return costPrices(rest, deps);
    case "help":
    case "--help":
    case "-h":
      return { code: 0, lines: USAGE };
    default:
      return { code: 1, lines: [`Unknown cost command: ${sub}`, "", ...USAGE] };
  }
}

/**
 * Real deps over this process's environment and filesystem, resolving the
 * journal from `$HADES_DATA_DIR|.hades` — the same data directory every other
 * durable surface uses.
 */
export function defaultCostDeps(env: Record<string, string | undefined> = process.env): CostCommandDeps {
  return { env, journalPath: costJournalPath(env.HADES_DATA_DIR ?? ".hades") };
}
