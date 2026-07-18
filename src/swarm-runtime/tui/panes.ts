import type { TuiState } from "./render";

/**
 * Split-pane building blocks for the interactive TUI: a scrollable-looking LOG
 * pane, a per-worker DRILL-IN detail pane, and a side-by-side composer. All
 * pure (string-in / string-out, deterministic, no I/O and no ANSI colors that
 * would break assertions) so the integrator can drive them from `app.ts` and
 * every one is unit-testable without a TTY. Width is measured in Unicode code
 * points throughout so box borders stay aligned with multi-byte content.
 */

type Worker = NonNullable<TuiState["workers"]>[number];
type LogEntry = NonNullable<TuiState["logs"]>[number];

/**
 * Pure view-state the integrator threads through key handling. It never mutates:
 * the movement helpers return a fresh object. `app.ts` owns storage/wiring.
 */
export interface PaneViewState {
  /** Worker currently drilled into, by id. Undefined = nothing selected. */
  selectedWorkerId?: string;
  /** How many rows the log pane is scrolled back from the live tail (>= 0). */
  logScrollOffset?: number;
}

export interface LogPaneOptions {
  /** Total box width in code points. */
  width?: number;
  /** Number of visible log rows (the box grows/shrinks by this, not by data). */
  height?: number;
  /** Header label. */
  title?: string;
  /** Rows scrolled back from the most-recent entry; 0 = live tail. Clamped. */
  scrollOffset?: number;
}

export interface WorkerDetailOptions {
  /** Total box width in code points. */
  width?: number;
  /** Header label. */
  title?: string;
}

const DEFAULT_LOG_WIDTH = 48;
const DEFAULT_LOG_HEIGHT = 8;
const DEFAULT_DETAIL_WIDTH = 36;

/* ----------------------------------------------------------------------------
 * Width-safe primitives (code-point counted)
 * ------------------------------------------------------------------------- */

function cpLen(s: string): number {
  return [...s].length;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Pad or truncate (with a trailing "…") so the result is exactly `w` code points. */
function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const cps = [...s];
  if (cps.length === w) return s;
  if (cps.length < w) return s + " ".repeat(w - cps.length);
  return cps.slice(0, w - 1).join("") + "…";
}

/** A boxed block: `╭─ TITLE ─…─╮` header, padded rows, `╰─…─╯` footer. */
function boxify(title: string, rows: string[], width: number): string {
  const inner = Math.max(0, width - 2);
  const label = title ? ` ${title} ` : "";
  const header = fit(`─${label}`, inner).replace(/ +$/g, (m) => "─".repeat(m.length));
  const out: string[] = [];
  out.push(`╭${header}╮`);
  for (const r of rows) out.push(`│${fit(`  ${r}`, inner)}│`);
  out.push(`╰${"─".repeat(inner)}╯`);
  return out.join("\n");
}

function statusIcon(status: string): string {
  switch (status) {
    case "verified":
    case "idle":
      return "●";
    case "busy":
    case "dispatched":
    case "reported":
      return "◐";
    case "failed":
    case "killed":
    case "dead":
      return "✗";
    default:
      return "○";
  }
}

/* ----------------------------------------------------------------------------
 * LOG pane
 * ------------------------------------------------------------------------- */

/** Largest honest scroll offset for `total` entries in a `height`-row window. */
export function logMaxOffset(total: number, height: number): number {
  return Math.max(0, total - Math.max(1, height));
}

/**
 * A fixed-height, scrollable-looking log pane. Shows the most-recent `height`
 * entries (a `scrollOffset > 0` pages back into history), each prefixed with its
 * worker id and truncated to the box width. When older entries are hidden the
 * top row honestly becomes a `…(N more)` marker; the box height never changes.
 */
export function renderLogPane(logs: LogEntry[] = [], opts: LogPaneOptions = {}): string {
  const width = opts.width ?? DEFAULT_LOG_WIDTH;
  const height = Math.max(1, opts.height ?? DEFAULT_LOG_HEIGHT);
  const title = opts.title ?? "LOG";

  const total = logs.length;
  const off = clamp(opts.scrollOffset ?? 0, 0, logMaxOffset(total, height));
  const end = total - off;

  // Window of `height` entries ending at `end`; reserve one row for the marker
  // when anything sits above the window (which also bumps the hidden count).
  let start = Math.max(0, end - height);
  let hidden = start;
  if (hidden > 0) {
    start += 1;
    hidden = start;
  }
  const visible = logs.slice(start, end);

  const rows: string[] = [];
  if (hidden > 0) rows.push(`…(${hidden} more)`);
  for (const l of visible) rows.push(`[${l.workerId}] ${l.line}`);
  if (total === 0) rows.push("(no log output yet)");
  while (rows.length < height) rows.push("");

  return boxify(title, rows, width);
}

/* ----------------------------------------------------------------------------
 * WORKER drill-in
 * ------------------------------------------------------------------------- */

/**
 * A drill-in panel for a single worker: id + status icon, then a field table
 * covering `status`, `capabilities`, and any other fields present on the worker
 * shape. Passing `undefined` renders an honest "no worker selected" empty state.
 */
export function renderWorkerDetail(
  worker: Worker | undefined | null,
  opts: WorkerDetailOptions = {},
): string {
  const width = opts.width ?? DEFAULT_DETAIL_WIDTH;
  const title = opts.title ?? "WORKER";

  if (!worker) {
    return boxify(title, ["(no worker selected)", "", "↑/↓ to pick a worker"], width);
  }

  const rows: string[] = [];
  rows.push(`${statusIcon(worker.status)} ${worker.workerId}`);
  rows.push("");

  // Known fields first, in a stable order, then any extra fields present.
  const seen = new Set(["workerId"]);
  const field = (k: string, v: string) => {
    seen.add(k);
    rows.push(`${k.padEnd(14)}${v}`);
  };

  field("status", worker.status);
  field("capabilities", (worker.capabilities ?? []).join(", ") || "—");

  for (const [k, v] of Object.entries(worker as Record<string, unknown>)) {
    if (seen.has(k)) continue;
    rows.push(`${k.padEnd(14)}${formatValue(v)}`);
  }

  return boxify(title, rows, width);
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ") || "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/* ----------------------------------------------------------------------------
 * Side-by-side composer
 * ------------------------------------------------------------------------- */

/**
 * Compose two already-rendered blocks into aligned columns separated by a
 * vertical rule. Shorter columns are padded, overflow is truncated, and every
 * output line is exactly `width` code points wide.
 */
export function renderSplit(left: string, right: string, width = 72): string {
  const sep = " │ ";
  const sepW = cpLen(sep);
  const avail = Math.max(0, width - sepW);
  const leftW = Math.floor(avail / 2);
  const rightW = avail - leftW;

  const l = left.split("\n");
  const r = right.split("\n");
  const rows = Math.max(l.length, r.length);

  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    out.push(fit(l[i] ?? "", leftW) + sep + fit(r[i] ?? "", rightW));
  }
  return out.join("\n");
}

/* ----------------------------------------------------------------------------
 * Pure view-state helpers (clamped, immutable)
 * ------------------------------------------------------------------------- */

/**
 * Move the worker selection by `dir` (typically -1/+1), clamped to the list
 * bounds (no wraparound). With nothing selected, +dir picks the first worker
 * and -dir the last. Returns a fresh `PaneViewState`.
 */
export function moveWorkerSelection(
  view: PaneViewState,
  workers: Worker[] = [],
  dir: number,
): PaneViewState {
  if (workers.length === 0) return { ...view, selectedWorkerId: undefined };
  const ids = workers.map((w) => w.workerId);
  const cur = view.selectedWorkerId ? ids.indexOf(view.selectedWorkerId) : -1;
  const idx = cur === -1 ? (dir >= 0 ? 0 : ids.length - 1) : clamp(cur + dir, 0, ids.length - 1);
  return { ...view, selectedWorkerId: ids[idx] };
}

/** Resolve the currently-selected worker from a state snapshot, if any. */
export function selectedWorker(
  view: PaneViewState,
  workers: Worker[] = [],
): Worker | undefined {
  return workers.find((w) => w.workerId === view.selectedWorkerId);
}

/**
 * Scroll the log pane by `delta` rows (positive = back into history), clamped to
 * `[0, maxOffset]`. Returns a fresh `PaneViewState`.
 */
export function scrollLog(
  view: PaneViewState,
  delta: number,
  maxOffset = Number.POSITIVE_INFINITY,
): PaneViewState {
  const cur = view.logScrollOffset ?? 0;
  return { ...view, logScrollOffset: clamp(cur + delta, 0, Math.max(0, maxOffset)) };
}
