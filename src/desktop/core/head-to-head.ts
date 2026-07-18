/**
 * Head-to-head (desktop) core module: "prove we beat the flat baseline."
 *
 * This is the desktop app's surface over the REAL swarm-hierarchy head-to-head
 * benchmark in `src/hades/bench/head-to-head.ts`. It runs the actual
 * `runHeadToHead` (never hardcoded win numbers) and maps its `HeadToHeadReport`
 * into an app-facing typed result plus a pure HTML render.
 *
 * HONESTY (this drives every label in the UI):
 * The underlying benchmark is an in-memory, deterministic model. It pits our
 * production `HierarchyOrchestrator` (a tree of coordinators) against the honest
 * `FlatOrchestrator` baseline (one manager, N sibling workers, un-indexed
 * linear-scan routing) over the IDENTICAL workload and reduction. What it
 * measures, per the bench's own documentation:
 *
 *   1. ROUTING COST (the load-bearing architectural win) is a COUNT, not a
 *      clock: flat un-indexed routing costs N*(N+1)/2 scan steps (O(N^2)); the
 *      tree costs `nodes - 1` indexed hops (O(N)). `routingSpeedup =
 *      flatRouteScans / hierarchyRouteScans` and grows ~linearly in N.
 *   2. MAKESPAN is measured wall-clock of each side's in-memory `run()`. It is
 *      reported honestly and can favor the flat side on a single thread, so it
 *      is shown as measured and is NOT the claim we lean on.
 *   3. RESULTS MATCH: both sides reduce the same values to the same aggregate;
 *      every row must be `true` or it is a real bug.
 *
 * This is NOT a live-model comparison. No LLM is called. Every number here comes
 * from the real in-memory run.
 */

import { runHeadToHead } from "../../hades/bench/head-to-head";
import type { HeadToHeadReport, HeadToHeadRow } from "../../hades/bench/head-to-head";

// ---------------------------------------------------------------------------
// App-facing typed result
// ---------------------------------------------------------------------------

/** Which topology won a given metric on a row (derived only from real report fields). */
export type HeadToHeadWinner = "hierarchy" | "flat" | "tie";

/** One measured worker-count row, mapped from a real `HeadToHeadRow`. */
export interface AppHeadToHeadRow {
  /** Worker count N for this row. */
  workers: number;
  /** O(N^2) un-indexed scan steps the flat baseline paid to route N workers. */
  flatRouteScans: number;
  /** O(N) indexed dispatch hops the hierarchy paid (tree nodes - 1). */
  hierarchyRouteScans: number;
  /** flatRouteScans / hierarchyRouteScans (>1 means the hierarchy routes with less work). */
  routingSpeedup: number;
  /**
   * Who routed with less work on this row, derived purely from the two real
   * scan counts. This is the deterministic, load-bearing architectural verdict.
   */
  routingWinner: HeadToHeadWinner;
  /** Measured wall-clock of the flat run (ms). */
  flatMakespanMs: number;
  /** Measured wall-clock of the hierarchy run (ms). */
  hierarchyMakespanMs: number;
  /** flatMakespanMs / hierarchyMakespanMs (>1 means the hierarchy finished sooner). */
  makespanSpeedup: number;
  /** Both topologies reduced to the identical aggregate. Must be true. */
  resultsMatch: boolean;
}

/** Overall summary across all measured rows, derived from the real rows. */
export interface AppHeadToHeadSummary {
  /** The worker counts that were actually measured, in order. */
  workerCounts: number[];
  /** Peak routing speedup across the rows (the headline architectural win). */
  peakRoutingSpeedup: number;
  /** The worker count N at which the peak routing speedup occurred. */
  peakRoutingWorkers: number;
  /** The routing winner across the whole run (hierarchy iff it won every row). */
  routingWinner: HeadToHeadWinner;
  /** True iff every row's aggregates matched (no silent-wrong reduction). */
  allResultsMatch: boolean;
}

export interface AppHeadToHeadResult {
  rows: AppHeadToHeadRow[];
  summary: AppHeadToHeadSummary;
  /**
   * Honest, human-readable statement of what this benchmark is, so the UI can
   * never imply a live-model comparison. This is fixed prose describing the
   * in-memory model, not a measured value.
   */
  methodology: string;
}

/** The one honest label the UI must show so no one mistakes this for a live LLM run. */
export const HEAD_TO_HEAD_METHODOLOGY =
  "Real in-memory deterministic benchmark: routing cost (comparison count) plus " +
  "makespan simulation across N workers, hierarchy vs flat baseline. No live model is called.";

// ---------------------------------------------------------------------------
// runHeadToHeadForApp — run the REAL benchmark, map to the app result
// ---------------------------------------------------------------------------

/** Winner on routing for one row: fewer scan steps wins (derived from real counts). */
function routingWinnerFor(row: HeadToHeadRow): HeadToHeadWinner {
  if (row.hierarchyRouteScans < row.flatRouteScans) return "hierarchy";
  if (row.flatRouteScans < row.hierarchyRouteScans) return "flat";
  return "tie";
}

function mapRow(row: HeadToHeadRow): AppHeadToHeadRow {
  return {
    workers: row.workers,
    flatRouteScans: row.flatRouteScans,
    hierarchyRouteScans: row.hierarchyRouteScans,
    routingSpeedup: row.routingSpeedup,
    routingWinner: routingWinnerFor(row),
    flatMakespanMs: row.flatMakespanMs,
    hierarchyMakespanMs: row.hierarchyMakespanMs,
    makespanSpeedup: row.makespanSpeedup,
    resultsMatch: row.resultsMatch,
  };
}

function summarize(rows: AppHeadToHeadRow[]): AppHeadToHeadSummary {
  let peakRoutingSpeedup = 0;
  let peakRoutingWorkers = 0;
  for (const r of rows) {
    if (r.routingSpeedup > peakRoutingSpeedup) {
      peakRoutingSpeedup = r.routingSpeedup;
      peakRoutingWorkers = r.workers;
    }
  }
  const routingWinner: HeadToHeadWinner =
    rows.length === 0
      ? "tie"
      : rows.every((r) => r.routingWinner === "hierarchy")
        ? "hierarchy"
        : rows.every((r) => r.routingWinner === "flat")
          ? "flat"
          : "tie";
  return {
    workerCounts: rows.map((r) => r.workers),
    peakRoutingSpeedup,
    peakRoutingWorkers,
    routingWinner,
    allResultsMatch: rows.every((r) => r.resultsMatch),
  };
}

/**
 * Run the REAL `runHeadToHead` benchmark and return an app-facing typed result.
 * `opts` is forwarded verbatim to the underlying benchmark, so callers (and
 * tests) can pass small, fast worker counts. Nothing here is hardcoded: every
 * numeric field is read from the report, and winner/speedup are derived from
 * the report's own counts.
 */
export async function runHeadToHeadForApp(
  opts?: Parameters<typeof runHeadToHead>[0],
): Promise<AppHeadToHeadResult> {
  const report: HeadToHeadReport = await runHeadToHead(opts);
  const rows = report.rows.map(mapRow);
  return {
    rows,
    summary: summarize(rows),
    methodology: HEAD_TO_HEAD_METHODOLOGY,
  };
}

// ---------------------------------------------------------------------------
// renderHeadToHead — pure HTML (theme tokens, no em-dashes)
// ---------------------------------------------------------------------------

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** Integer with thousands separators, honest about non-finite values. */
function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return Math.round(n).toLocaleString("en-US");
}

/** Fixed-precision milliseconds, honest about non-finite values. */
function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(3)} ms`;
}

/** A speedup like "16.00x", honest about non-finite values (e.g. divide by zero). */
function fmtSpeedup(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(2)}x`;
}

const WINNER_LABEL: Record<HeadToHeadWinner, string> = {
  hierarchy: "Hades",
  flat: "Flat",
  tie: "Tie",
};

const WINNER_TONE_VAR: Record<HeadToHeadWinner, string> = {
  hierarchy: "--color-ok",
  flat: "--color-bad",
  tie: "--color-ink-tertiary",
};

function winnerPill(winner: HeadToHeadWinner): string {
  return (
    `<span class="h2h-winner" data-winner="${escapeHtml(winner)}" ` +
    `style="--h2h-winner-color:var(${WINNER_TONE_VAR[winner]})">` +
    `${escapeHtml(WINNER_LABEL[winner])}</span>`
  );
}

function renderRow(row: AppHeadToHeadRow): string {
  const matchTone = row.resultsMatch ? "--color-ok" : "--color-bad";
  const matchLabel = row.resultsMatch ? "yes" : "NO";
  return `
    <tr class="h2h-row" data-workers="${row.workers}">
      <td class="h2h-cell h2h-cell--num">${fmtInt(row.workers)}</td>
      <td class="h2h-cell h2h-cell--num">${fmtInt(row.flatRouteScans)}</td>
      <td class="h2h-cell h2h-cell--num">${fmtInt(row.hierarchyRouteScans)}</td>
      <td class="h2h-cell h2h-cell--num h2h-cell--speedup">${fmtSpeedup(row.routingSpeedup)}</td>
      <td class="h2h-cell h2h-cell--num">${fmtMs(row.flatMakespanMs)}</td>
      <td class="h2h-cell h2h-cell--num">${fmtMs(row.hierarchyMakespanMs)}</td>
      <td class="h2h-cell h2h-cell--num">${fmtSpeedup(row.makespanSpeedup)}</td>
      <td class="h2h-cell h2h-cell--winner">${winnerPill(row.routingWinner)}</td>
      <td class="h2h-cell h2h-cell--match" style="--h2h-match-color:var(${matchTone})">${matchLabel}</td>
    </tr>`;
}

function emptyState(message: string): string {
  return `<p class="h2h-empty">${escapeHtml(message)}</p>`;
}

/**
 * Pure render of an {@link AppHeadToHeadResult}. Passing `null` renders an
 * honest idle/loading prompt (nothing has been run yet). The table always
 * carries the methodology label so the surface cannot be misread as a live
 * model head-to-head. Routing (a deterministic count) is the load-bearing
 * verdict; makespan is shown as measured wall-clock and is not a claim.
 */
export function renderHeadToHead(result: AppHeadToHeadResult | null): string {
  if (result === null) {
    return `
      <section class="h2h" aria-label="Head to head">
        <header class="h2h-head">
          <h2 class="h2h-title">Hades vs flat baseline</h2>
          <p class="h2h-method">${escapeHtml(HEAD_TO_HEAD_METHODOLOGY)}</p>
        </header>
        <div class="h2h-body h2h-body--empty">
          ${emptyState("No benchmark run yet. Run the head to head to prove the routing win.")}
        </div>
      </section>`.trim();
  }

  if (result.rows.length === 0) {
    return `
      <section class="h2h" aria-label="Head to head">
        <header class="h2h-head">
          <h2 class="h2h-title">Hades vs flat baseline</h2>
          <p class="h2h-method">${escapeHtml(result.methodology)}</p>
        </header>
        <div class="h2h-body h2h-body--empty">
          ${emptyState("The benchmark ran but produced no rows. Nothing to compare.")}
        </div>
      </section>`.trim();
  }

  const { summary } = result;
  const rowsHtml = result.rows.map(renderRow).join("");

  const verdict =
    summary.routingWinner === "hierarchy"
      ? `Hades routes with up to ${fmtSpeedup(summary.peakRoutingSpeedup)} less work ` +
        `(peak at ${fmtInt(summary.peakRoutingWorkers)} workers).`
      : summary.routingWinner === "flat"
        ? "Flat baseline routed with less work on every row."
        : "Routing was mixed across the measured worker counts.";

  const matchNote = summary.allResultsMatch
    ? "All rows reduced to the identical aggregate (no silent-wrong)."
    : "WARNING: a row disagreed on the aggregate. This is a real bug, not a win.";

  const matchToneVar = summary.allResultsMatch ? "--color-ok" : "--color-bad";

  return `
    <section class="h2h" aria-label="Head to head">
      <header class="h2h-head">
        <h2 class="h2h-title">Hades vs flat baseline</h2>
        <p class="h2h-method">${escapeHtml(result.methodology)}</p>
      </header>
      <p class="h2h-verdict" style="--h2h-verdict-color:var(${WINNER_TONE_VAR[summary.routingWinner]})">
        ${escapeHtml(verdict)}
      </p>
      <div class="h2h-table-wrap">
        <table class="h2h-table">
          <caption class="h2h-caption">
            Routing cost is a deterministic comparison count (the load-bearing win).
            Makespan is measured wall-clock and can favor the flat side on a single thread.
          </caption>
          <thead>
            <tr>
              <th scope="col" class="h2h-th h2h-th--num">Workers</th>
              <th scope="col" class="h2h-th h2h-th--num">Route scans (flat)</th>
              <th scope="col" class="h2h-th h2h-th--num">Route scans (Hades)</th>
              <th scope="col" class="h2h-th h2h-th--num">Routing speedup</th>
              <th scope="col" class="h2h-th h2h-th--num">Makespan (flat)</th>
              <th scope="col" class="h2h-th h2h-th--num">Makespan (Hades)</th>
              <th scope="col" class="h2h-th h2h-th--num">Makespan speedup</th>
              <th scope="col" class="h2h-th h2h-th--winner">Routing winner</th>
              <th scope="col" class="h2h-th h2h-th--match">Results match</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="h2h-match-note" style="--h2h-match-color:var(${matchToneVar})">${escapeHtml(matchNote)}</p>
    </section>`.trim();
}
