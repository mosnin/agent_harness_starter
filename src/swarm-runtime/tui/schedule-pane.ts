/**
 * schedule-pane.ts — pure, deterministic SCHEDULE pane for the interactive
 * TUI (`hades tui`).
 *
 * Renders three sections in one box: JOBS (every scheduled job's cron
 * expression, time zone, enabled state, task kind, delivery target, real
 * next-fire time, last outcome, and honest run/fail/abstain counters), RUNS
 * (a scrollable-by-selection-over-jobs history feed — selection lives on
 * JOBS, RUNS is the full merged run log rendered underneath), and TALLY (the
 * honest, never-fabricated per-outcome count across every recorded run).
 *
 * Every function here is a pure string-in/string-out or state-in/state-out
 * transform: no I/O, no timers, no ANSI escapes, no imports from
 * `src/hades/**` or anywhere outside this file's own declarations. Data
 * arrives as plain JSON-compatible rows the orchestrator can populate
 * directly from `buildSchedulePaneSnapshot()`'s output (a structural, not
 * import, match — see `src/hades/schedule/pane-snapshot.ts`), exactly how
 * `gateway-pane.ts` consumes `GatewayProcess.status()` with zero adapter
 * code required.
 *
 * Visual conventions match `gateway-pane.ts` / `fleet-pane.ts` / `render.ts`:
 * `╭─╮ │ ├ ┤ ╰─╯` box drawing, a default width of 72 code points, and a hard
 * clamp — no line this module emits ever exceeds the requested width. Width
 * is measured in Unicode code points (via `[...s].length`) so multi-byte job
 * names / cron strings / detail text never desyncs the border.
 *
 * Honesty discipline:
 *  - An empty JOBS list never renders as a bare box: it says
 *    "no scheduled jobs" explicitly.
 *  - An empty RUNS feed says "no runs yet" explicitly.
 *  - `tally === null` (nothing has completed a run yet) renders "no
 *    completed runs yet" — this is never conflated with a real, counted
 *    `{ delivered: 0, abstained: 0, withheld: 0, failed: 0, skipped: 0 }`
 *    tally after runs have actually happened. A tally is only ever rendered
 *    with real accumulated counts, never a fabricated placeholder.
 *  - `runnerRunning === null` (nothing attached) renders "runner: not
 *    attached". An attached runner always renders its real boolean state
 *    honestly ("running" / "stopped").
 *  - `nextFireAt === null` on an *enabled* job renders "next: —" (an
 *    unparseable cron or an engine that could not compute a next fire, never
 *    a guessed time). A *disabled* job renders "disabled" in the next-fire
 *    slot regardless of what `nextFireAt` holds.
 *  - Every count (runCount/failCount/abstainCount, the tally fields) prints
 *    verbatim from the row the caller supplied; this module never derives,
 *    sums, or invents a number of its own.
 *  - Free text that flows into the box (job name, cron, time zone, task
 *    kind, delivery target, last outcome, run detail) is run through a local
 *    `sanitize` before display, so C0/C1 control characters and ESC (the
 *    building block of ANSI escape injection) never reach the rendered
 *    frame, regardless of what an upstream job/run record handed us.
 */

// ---------------------------------------------------------------------------
// Row shapes (plain, JSON-compatible — no imports from src/hades/**)
// ---------------------------------------------------------------------------

/** One row of the JOBS section: a single scheduled job's full displayable state. */
export interface SchedulePaneJobRow {
  id: string;
  name: string;
  cron: string;
  timeZone: string;
  enabled: boolean;
  taskKind: string;
  deliveryTarget: string | null;
  nextFireAt: number | null;
  lastOutcome: string | null;
  runCount: number;
  failCount: number;
  abstainCount: number;
}

/** One row of the RUNS section: a single completed (or attempted) job run. */
export interface SchedulePaneRunRow {
  jobId: string;
  jobName: string;
  firedAt: number;
  scheduledFor: number;
  outcome: string;
  detail: string;
  durationMs: number;
}

/**
 * The honest per-outcome tally for the TALLY section. `null` at the
 * `SchedulePaneState` level means "no completed runs yet" and is rendered
 * distinctly from a real, counted all-zero tally.
 */
export interface SchedulePaneTally {
  delivered: number;
  abstained: number;
  withheld: number;
  failed: number;
  skipped: number;
}

/**
 * The pane's full pure view-state: the three data sections plus a selection
 * cursor over `jobs` and a scroll offset following it into the visible
 * window. Immutable by convention — every helper below returns a fresh
 * object; none of them mutate their inputs.
 */
export interface SchedulePaneState {
  jobs: SchedulePaneJobRow[];
  runs: SchedulePaneRunRow[];
  tally: SchedulePaneTally | null;
  runnerRunning: boolean | null;
  /** Index into `jobs` of the selected row, clamped to `[0, jobs.length - 1]`. */
  selected: number;
  /** Rows scrolled down from the top of the JOBS window (>= 0). */
  scroll: number;
  /** Visible row count of the JOBS window. */
  viewHeight: number;
}

const DEFAULT_WIDTH = 72;
const DEFAULT_VIEW_HEIGHT = 8;
const DEFAULT_RUN_CAP = 200;

/** A fresh, empty `SchedulePaneState` — no jobs, no runs, no tally, no runner attached. */
export function initialSchedulePaneState(viewHeight = DEFAULT_VIEW_HEIGHT): SchedulePaneState {
  return {
    jobs: [],
    runs: [],
    tally: null,
    runnerRunning: null,
    selected: 0,
    scroll: 0,
    viewHeight: Math.max(1, Math.floor(viewHeight)),
  };
}

// ---------------------------------------------------------------------------
// Width-safe primitives (code-point counted, matching gateway-pane.ts's discipline)
// ---------------------------------------------------------------------------

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

/** A boxed block: `╭─ TITLE ─…─╮` header, padded rows, `╰─…─╯` footer, `├─…─┤` dividers. */
function boxifyLines(title: string, sections: string[][], width: number): string[] {
  const inner = Math.max(0, width - 2);
  const label = title ? ` ${title} ` : "";
  const header = fit(`─${label}`, inner).replace(/ +$/g, (m) => "─".repeat(m.length));
  const out: string[] = [];
  out.push(`╭${header}╮`);
  sections.forEach((rows, i) => {
    if (i > 0) out.push(`├${"─".repeat(inner)}┤`);
    for (const r of rows) out.push(`│${fit(r, inner)}│`);
  });
  out.push(`╰${"─".repeat(inner)}╯`);
  return out;
}

// ---------------------------------------------------------------------------
// Preview/text sanitization — no ANSI injection, no stray control characters
// ---------------------------------------------------------------------------

/** C0 controls (excluding LF/CR, collapsed to "⏎" first), DEL, and C1 controls (0x80-0x9F, which also cover ESC's high-bit cousins). ESC (0x1B) itself falls inside the C0 range below. */
const CONTROL_CHARS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const NEWLINES = /\r\n|\r|\n/g;

/**
 * Sanitize arbitrary upstream text (a job name, cron string, time zone, task
 * kind, delivery target, outcome label, run detail, …) before it can ever
 * reach a rendered TUI frame:
 *  1. Collapse every newline variant (`\n`, `\r`, `\r\n`) to a single `⏎`, so
 *     a multi-line payload never breaks the box's one-row-per-line grid.
 *  2. Strip every remaining C0/C1 control character, including ESC — the
 *     byte that begins every ANSI escape sequence — so no upstream text can
 *     inject cursor moves, color codes, or terminal-clear sequences into the
 *     pane.
 *  3. Truncate by Unicode code point (never by UTF-16 code unit, so
 *     surrogate pairs are never split) to at most `max` code points, adding
 *     a trailing "…" when truncation actually occurred.
 *
 * Not exported: the pane's locked export surface is exactly
 * `initialSchedulePaneState` / `schedulePaneKey` / `pushRun` /
 * `renderSchedulePane` plus the row/state interfaces, so this stays an
 * internal implementation detail exercised indirectly through
 * `renderSchedulePane`'s adversarial-input tests.
 */
function sanitizeScheduleText(text: string, max: number): string {
  const source = typeof text === "string" ? text : String(text ?? "");
  const collapsed = source.replace(NEWLINES, "⏎");
  const stripped = collapsed.replace(CONTROL_CHARS, "");
  const limit = Math.max(0, Math.floor(max));
  if (limit === 0) return "";
  const cps = [...stripped];
  if (cps.length <= limit) return stripped;
  if (limit === 1) return "…";
  return cps.slice(0, limit - 1).join("") + "…";
}

/** Internal shorthand: sanitize a free-text field for display with a generous default cap. */
function sane(text: string, max = 200): string {
  return sanitizeScheduleText(text, max);
}

// ---------------------------------------------------------------------------
// Pure selection/scroll windowing over the JOBS list
// ---------------------------------------------------------------------------

/**
 * Given a list `length`, a visible `height`, and a desired `selected`
 * index + `scroll` offset, return the clamped pair that (a) keeps
 * `selected` inside `[0, length - 1]` and (b) keeps `scroll` positioned so
 * `selected` is visible inside the `height`-row window. An empty list pins
 * both to 0.
 */
function windowSelectionScroll(
  length: number,
  height: number,
  selected: number,
  scroll: number
): { selected: number; scroll: number } {
  if (length <= 0) return { selected: 0, scroll: 0 };
  const h = Math.max(1, Math.floor(height));
  const sel = clamp(Math.floor(selected), 0, length - 1);
  let sc = clamp(Math.floor(scroll), 0, Math.max(0, length - h));
  if (sel < sc) {
    sc = sel;
  } else if (sel >= sc + h) {
    sc = sel - h + 1;
  }
  sc = clamp(sc, 0, Math.max(0, length - h));
  return { selected: sel, scroll: sc };
}

/**
 * Apply a SCHEDULE-pane key action against the JOBS list: `"up"`/`"down"`
 * move the selection by one row (clamped to `[0, jobs.length - 1]`),
 * `"home"`/`"end"` jump exactly to the first / last row with the scroll
 * pinned to that edge, and the scroll offset always follows the selection
 * into the visible `viewHeight`-row window. An empty `jobs` list pins both
 * `selected` and `scroll` to 0 regardless of the key pressed. Any key not in
 * `{"up","down","home","end"}` is a no-op that returns the exact same
 * `state` reference (`===`), so callers can cheaply detect "nothing
 * changed". Returns a fresh `SchedulePaneState` on every actionable key; the
 * input is never mutated.
 */
export function schedulePaneKey(state: SchedulePaneState, key: string): SchedulePaneState {
  const length = state.jobs.length;
  const height = Math.max(1, Math.floor(state.viewHeight));

  if (key !== "up" && key !== "down" && key !== "home" && key !== "end") {
    return state;
  }

  if (length === 0) {
    if (state.selected === 0 && state.scroll === 0) return state;
    return { ...state, selected: 0, scroll: 0 };
  }

  if (key === "home") {
    if (state.selected === 0 && state.scroll === 0) return state;
    return { ...state, selected: 0, scroll: 0 };
  }
  if (key === "end") {
    const scroll = Math.max(0, length - height);
    if (state.selected === length - 1 && state.scroll === scroll) return state;
    return { ...state, selected: length - 1, scroll };
  }

  let target = state.selected;
  if (key === "up") target -= 1;
  else if (key === "down") target += 1;

  const { selected, scroll } = windowSelectionScroll(length, height, target, state.scroll);
  if (selected === state.selected && scroll === state.scroll) return state;
  return { ...state, selected, scroll };
}

// ---------------------------------------------------------------------------
// Run feed mutation (pure, never mutates input)
// ---------------------------------------------------------------------------

/**
 * Prepend one run record to the newest-first `runs` feed. When the result
 * would exceed `cap` (default 200), the oldest rows (the tail of the
 * newest-first array) are evicted until the feed is exactly `cap` long.
 * Returns a fresh `SchedulePaneState`; neither `state` nor `row` is
 * mutated — `row` is shallow-cloned into the new array.
 */
export function pushRun(state: SchedulePaneState, row: SchedulePaneRunRow, cap = DEFAULT_RUN_CAP): SchedulePaneState {
  const capped = Math.max(1, Math.floor(cap));
  const combined = [{ ...row }, ...state.runs];
  const runs = combined.length > capped ? combined.slice(0, capped) : combined;
  return { ...state, runs };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtNextFire(job: SchedulePaneJobRow): string {
  if (!job.enabled) return "disabled";
  if (job.nextFireAt === null) return "next: —";
  return `next: ${job.nextFireAt}`;
}

function fmtOutcome(job: SchedulePaneJobRow): string {
  return job.lastOutcome === null ? "last: —" : `last: ${sane(job.lastOutcome, 40)}`;
}

function fmtDelivery(job: SchedulePaneJobRow): string {
  return job.deliveryTarget === null ? "→ —" : `→ ${sane(job.deliveryTarget, 60)}`;
}

/**
 * Render the SCHEDULE pane: JOBS / RUNS / TALLY sections, one line array
 * entry per rendered line (no embedded newlines). Every emitted line is
 * exactly `width` Unicode code points wide (hard clamp): no line this
 * function returns ever exceeds `width`, and all free text (job name, cron,
 * time zone, task kind, delivery target, last/run outcome, run detail) is
 * passed through `sanitizeScheduleText` before being laid into a row, so no
 * control character or ANSI escape byte from upstream data can ever survive
 * into the rendered frame.
 */
export function renderSchedulePane(state: SchedulePaneState, width = DEFAULT_WIDTH): string[] {
  const jobsRows: string[] = [`JOBS (${state.jobs.length})`];
  if (state.jobs.length === 0) {
    jobsRows.push("  no scheduled jobs");
  } else {
    const height = Math.max(1, Math.floor(state.viewHeight));
    const { selected, scroll } = windowSelectionScroll(state.jobs.length, height, state.selected, state.scroll);
    const visible = state.jobs.slice(scroll, scroll + height);
    for (let i = 0; i < visible.length; i++) {
      const job = visible[i];
      const idx = scroll + i;
      const marker = idx === selected ? "▸" : " ";
      const en = job.enabled ? "on " : "off";
      jobsRows.push(
        `${marker} ${en} ${sane(job.name, 40)}  ${sane(job.cron, 24)}  ${sane(job.timeZone, 30)}`
      );
      jobsRows.push(
        `    ${sane(job.taskKind, 30)}  ${fmtDelivery(job)}  ${fmtNextFire(job)}`
      );
      jobsRows.push(
        `    ${fmtOutcome(job)}  runs=${job.runCount}  fails=${job.failCount}  abstains=${job.abstainCount}`
      );
    }
    if (scroll > 0 || scroll + height < state.jobs.length) {
      jobsRows.push(`  (${scroll + 1}-${Math.min(state.jobs.length, scroll + height)} of ${state.jobs.length})`);
    }
  }

  const runnerRows: string[] = ["RUNNER"];
  if (state.runnerRunning === null) {
    runnerRows.push("  runner: not attached");
  } else {
    runnerRows.push(`  runner: ${state.runnerRunning ? "running" : "stopped"}`);
  }

  const runsRows: string[] = [`RUNS (${state.runs.length})`];
  if (state.runs.length === 0) {
    runsRows.push("  no runs yet");
  } else {
    for (const run of state.runs) {
      runsRows.push(
        `  ${sane(run.jobName, 30)}  ${sane(run.outcome, 20)}  fired=${run.firedAt}  sched=${run.scheduledFor}  ${run.durationMs}ms`
      );
      if (run.detail) {
        runsRows.push(`    ${sane(run.detail, 200)}`);
      }
    }
  }

  const tallyRows: string[] = ["TALLY"];
  if (state.tally === null) {
    tallyRows.push("  no completed runs yet");
  } else {
    const t = state.tally;
    tallyRows.push(
      `  delivered=${t.delivered}  abstained=${t.abstained}  withheld=${t.withheld}  failed=${t.failed}  skipped=${t.skipped}`
    );
  }

  return boxifyLines("SCHEDULE", [jobsRows, runnerRows, runsRows, tallyRows], width);
}
