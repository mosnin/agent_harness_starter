/**
 * The run-cost journal — an append-only record of what runs ACTUALLY cost,
 * so `hades cost` can answer "what did that just cost me" in a later process.
 *
 * ## Why a journal and not an in-memory total
 *
 * Every `hades` invocation is a fresh process. A meter that lived only in
 * memory could report the current run and nothing else, which makes the one
 * question users actually ask — "what have I spent today?" — unanswerable.
 * So each run appends one line here and the surface reads them back.
 *
 * ## Why the stored totals are never trusted
 *
 * A record stores the individual {@link MeteredCall}s, not just the rollup.
 * `hades cost` re-derives every aggregate with the SAME `summarizeCalls`
 * that produced it live (`./meter.ts`), so a hand-edited total in the file
 * cannot become a reported number. The stored `report` field is kept only as
 * a redundant copy for debugging; nothing reads it as authority. This mirrors
 * how `showdown live-verify` re-derives a manifest instead of believing it.
 *
 * ## Failure behaviour
 *
 * Writing is best-effort and NEVER fails a run: an agent that completed its
 * work must not exit non-zero because a bookkeeping file was unwritable. But
 * a failed write is not swallowed either — {@link appendRunCost} returns the
 * error text so the caller can print it, and it does not pretend the record
 * landed. Reading is strict-but-tolerant per line: a corrupt line is dropped
 * and COUNTED, so `hades cost` reports "3 unreadable record(s) skipped"
 * instead of quietly under-reporting spend.
 *
 * @module hades/cost/journal
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { summarizeCalls, type CostReport, type MeteredCall } from "./meter";
import type { ModelPrice } from "./prices";

/** One completed run's measured cost. */
export interface RunCostRecord {
  /** Schema version — a future field addition must not silently reinterpret old lines. */
  v: 1;
  /** Unique-per-run id (caller supplied; the CLI uses time+random hex). */
  runId: string;
  /** Which surface produced this run: `"chat"`, `"swarm-run"`, … */
  surface: string;
  /** Epoch ms at run start (caller's clock). */
  startedAt: number;
  /** REAL end-to-end wall clock for the run, in ms. */
  wallClockMs: number;
  /** Model id the run was configured with, for a human reading the log. */
  model?: string;
  /** Logical provider name. Never a key, never a credentialed URL. */
  provider?: string;
  /** Every measured call. THE authority — aggregates are recomputed from here. */
  calls: MeteredCall[];
  /** Redundant copy of the live rollup. Debug aid only; never read as truth. */
  report?: CostReport;
}

/** Default journal path under a data directory. */
export function costJournalPath(dataDir: string): string {
  return join(dataDir, "cost", "runs.jsonl");
}

/**
 * Append one run record as a single JSON line. Best-effort: returns
 * `undefined` on success, or the error text on failure (callers print it —
 * they never fail the run over it).
 */
export function appendRunCost(path: string, record: RunCostRecord): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** What {@link readRunCosts} found, including what it could NOT read. */
export interface RunCostHistory {
  records: RunCostRecord[];
  /** Lines that were present but unparseable/malformed — counted, not hidden. */
  skippedLines: number;
  /** True when the journal file does not exist yet (a fresh install). */
  missing: boolean;
}

/**
 * Read the journal. A missing file is an empty history with `missing: true`
 * (not an error — a fresh install has simply spent nothing yet). Malformed
 * lines are skipped and counted rather than aborting the read, so one bad
 * line cannot make an entire spend history unreportable.
 */
export function readRunCosts(path: string, readFile: (p: string) => string = defaultRead): RunCostHistory {
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return { records: [], skippedLines: 0, missing: true };
  }

  const records: RunCostRecord[] = [];
  let skippedLines = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = coerceRecord(trimmed);
    if (record) records.push(record);
    else skippedLines += 1;
  }
  return { records, skippedLines, missing: false };
}

function defaultRead(p: string): string {
  return readFileSync(p, "utf8");
}

/** Parse + shape-check one line. Returns undefined for anything untrustworthy. */
function coerceRecord(line: string): RunCostRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return undefined;
  if (typeof o.runId !== "string" || typeof o.surface !== "string") return undefined;
  if (typeof o.startedAt !== "number" || typeof o.wallClockMs !== "number") return undefined;
  if (!Array.isArray(o.calls)) return undefined;

  const calls: MeteredCall[] = [];
  for (const raw of o.calls) {
    const call = coerceCall(raw);
    // One bad call inside a record makes the whole record untrustworthy: a
    // partially-read record would UNDER-report that run's spend, which is
    // the exact direction of error this codebase refuses to make.
    if (!call) return undefined;
    calls.push(call);
  }

  return {
    v: 1,
    runId: o.runId,
    surface: o.surface,
    startedAt: o.startedAt,
    wallClockMs: o.wallClockMs,
    ...(typeof o.model === "string" ? { model: o.model } : {}),
    ...(typeof o.provider === "string" ? { provider: o.provider } : {}),
    calls,
  };
}

function coerceCall(value: unknown): MeteredCall | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.model !== "string" || typeof o.provider !== "string") return undefined;
  if (typeof o.latencyMs !== "number" || typeof o.at !== "number") return undefined;
  const tokensIn = nullableNumber(o.tokensIn);
  const tokensOut = nullableNumber(o.tokensOut);
  if (tokensIn === undefined || tokensOut === undefined) return undefined;
  return {
    model: o.model,
    provider: o.provider,
    tokensIn,
    tokensOut,
    latencyMs: o.latencyMs,
    at: o.at,
    ...(typeof o.servedModel === "string" ? { servedModel: o.servedModel } : {}),
  };
}

/** `null` and finite numbers are valid; anything else is a corrupt field. */
function nullableNumber(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

/**
 * Recompute a run's cost report from its STORED CALLS — never from the stored
 * `report` field. This is the function every surface must use.
 */
export function recomputeRunReport(
  record: RunCostRecord,
  prices?: readonly ModelPrice[],
): CostReport {
  return summarizeCalls(record.calls, prices);
}

/** Totals across many runs, recomputed from their stored calls. */
export interface RunCostTotals {
  runs: number;
  report: CostReport;
  /** Summed end-to-end wall clock across runs (they did not overlap: separate processes). */
  wallClockMs: number;
  /** Earliest / latest `startedAt` seen, or `null` with no runs. */
  firstAt: number | null;
  lastAt: number | null;
}

/** Aggregate a set of records by concatenating their calls and re-summarizing. */
export function totalRunCosts(
  records: readonly RunCostRecord[],
  prices?: readonly ModelPrice[],
): RunCostTotals {
  const calls: MeteredCall[] = [];
  let wallClockMs = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  for (const r of records) {
    calls.push(...r.calls);
    wallClockMs += r.wallClockMs;
    if (firstAt === null || r.startedAt < firstAt) firstAt = r.startedAt;
    if (lastAt === null || r.startedAt > lastAt) lastAt = r.startedAt;
  }
  return { runs: records.length, report: summarizeCalls(calls, prices), wallClockMs, firstAt, lastAt };
}
