/**
 * verify-lane.ts — pure, deterministic VERIFY LANE pane for the interactive
 * TUI (`hades tui`): the beyond-Hermes moat surface. It shows every task's
 * verification gate ruling — accept / abstain / reject — live as the STYX
 * gate rules on real work, with a running tally and an inline V-TPH$ (verified
 * tasks / hour / dollar) readout computed ONLY from real run figures.
 *
 * Every function here is a pure string-in/string-out or state-in/state-out
 * transform: no I/O, no timers, no `Date.now()`, no randomness, and no
 * imports outside this file's own declarations except the three REAL locked
 * types (`Verdict`, `VerificationReport`, `SwarmMetrics`) from `../types`,
 * imported type-only so this module never pulls in runtime code from the
 * rest of the engine. The integrator feeds this module timestamps (`at`) and
 * figures (`verifiedCount`, `wallMs`, `costUsd`) it derives from the real
 * engine; this module never invents a clock tick or a number of its own.
 *
 * Visual conventions match `schedule-pane.ts` / `fleet-pane.ts` / `render.ts`:
 * `╭─╮ │ ├ ┤ ╰─╯` box drawing, a default width of 72 code points, and a hard
 * clamp — no line this module emits ever exceeds the requested width. Width
 * is measured in Unicode code points (via `[...s].length`) so multi-byte
 * task descriptions never desync the border.
 *
 * ── The ruling mapping (the moat — LOCKED) ──────────────────────────────
 *
 * `LaneRuling` is `"pending" | "accept" | "abstain" | "reject"`. The mapping
 * from the real task/verification lifecycle to a `LaneRuling` is fixed:
 *
 *   - `task:dispatched`                        -> `pending`
 *   - `task:verified`                          -> `accept`  (score = report.score)
 *   - `task:rejected`                          -> `reject`  (score = report.score)
 *   - `task:escalated`, or any `report.verdict === "revise"` -> `abstain`
 *   - `task:failed`                            -> `reject`  (terminal)
 *
 * `abstain` is rendered with the honest legend
 * **"abstain = escalated for revision, not yet trusted"** — an abstain is
 * never presented as an accept, and a task that later clears verification
 * after revision transitions cleanly `abstain -> accept` with its attempt
 * count preserved (a revision is the *same* attempt gaining a verdict, not a
 * new one).
 *
 * `laneApply` accepts a raw `(task, report)` pair as `{ ruling, report }`:
 * when `report` is present, its `verdict` OVERRIDES `ruling` via this exact
 * mapping (`accept -> accept`, `reject -> reject`, `revise -> abstain`), so
 * central wiring can forward verification-gate output raw without
 * pre-computing a `LaneRuling` itself. `ruling` alone (no `report`) is used
 * for lifecycle events the gate never scores, i.e. dispatch (`pending`) and
 * a hard worker failure (`reject`, terminal — `task:failed` never carries a
 * `VerificationReport` since the worker never produced a gate-checkable
 * result).
 *
 * A task is only ever "re-attempted" by a fresh `pending` ruling arriving
 * for a `taskId` whose current row is *not* already `pending` (e.g. the
 * classic case: a `reject` gets re-dispatched). That transition increments
 * `attempts` and clears the row's `score` back to `null` (a task that has
 * just been re-dispatched has no score yet, regardless of what the previous
 * attempt scored). Every other ruling transition for a known `taskId`
 * (`pending -> accept`, `abstain -> accept`, `abstain -> reject`, a
 * duplicate `accept -> accept`, …) updates the row in place without
 * touching `attempts`. An event for an unseen `taskId` — including a
 * "verify arrived before dispatch" race — always creates the row honestly
 * (`attempts = 1`) rather than dropping the ruling on the floor.
 *
 * `tally` is never incrementally drifted: `laneApply` recomputes it from a
 * full pass over `rows` on every call, so it can never desync from the rows
 * it summarizes no matter what sequence of out-of-order/duplicate events
 * arrives.
 *
 * ── V-TPH$ (live, never modeled) ─────────────────────────────────────────
 *
 * `vtphReadout` computes verified-tasks-per-hour-per-dollar from real
 * figures only: `verifiedCount / (wallMs / 3600000) / costUsd`, and ONLY
 * when `wallMs >= 1000`, `costUsd > 0`, and `verifiedCount >= 0` (all three
 * finite). The integrator feeds `verifiedCount`/`costUsd` straight from the
 * real `SwarmMetrics` (`metrics.tasks.verified`, `metrics.usage.costUsd`)
 * and `wallMs` from `run-start`/now — this module invents nothing. This
 * readout is always `live`: unlike the SHOWDOWN pane (`showdown-pane.ts`),
 * which renders a `(modeled)` figure for a scripted-demo run, this pane has
 * no modeled mode at all — every number it shows either came from a real run
 * or is an honest `n/a`. A zero-cost or too-short run never renders
 * `Infinity` or a fabricated figure; it renders one of exactly two `n/a`
 * labels instead.
 */

import type { Verdict, VerificationReport, SwarmMetrics } from "../types";

// Re-exported only for documentation/traceability — this module does not
// consume `SwarmMetrics` directly (the integrator reads
// `metrics.tasks.verified` / `metrics.usage.costUsd` and passes plain
// numbers into `VtphInput`), but the locked contract names it as the real
// source of truth for those figures, so it is imported here to keep that
// link type-checked even though unused at the value level.
export type { SwarmMetrics };

// ---------------------------------------------------------------------------
// Row / state / event shapes
// ---------------------------------------------------------------------------

/** A task's current verification-gate ruling in the lane. */
export type LaneRuling = "pending" | "accept" | "abstain" | "reject";

/** One row of the VERIFY LANE: a single task's current ruling and history. */
export interface VerifyLaneRow {
  taskId: string;
  description: string;
  ruling: LaneRuling;
  /** Grounding score 0..1 from the last `VerificationReport`, or `null` when not yet scored (always `null` while `ruling === "pending"`). */
  score: number | null;
  /** Attempt count for this task — incremented only when a re-dispatch returns a non-pending row to `pending`. */
  attempts: number;
  /** Timestamp of the event that produced this row's current state (from the event's own `at`, never a clock read here). */
  updatedAt: number;
}

/** The pane's full pure view-state. Immutable by convention — every helper below returns a fresh object. */
export interface VerifyLaneState {
  rows: VerifyLaneRow[];
  tally: { accept: number; abstain: number; reject: number; pending: number };
  /** Rows scrolled down from the top of the row window (>= 0). Clamped against the actual window height at render time, since this state does not carry a height. */
  scroll: number;
  /** Set by a `"run-start"` event's `at`; `null` until the first run starts. */
  startedAt: number | null;
}

/**
 * Events the reducer accepts. The `"task"` variant carries a `ruling`
 * (used verbatim for lifecycle events the gate never scores) and an optional
 * `report` (when present, OVERRIDES `ruling` via the locked verdict mapping
 * — see the module docstring). `ruling`'s type is written exactly as the
 * locked contract specifies it.
 */
export type VerifyEvent =
  | { type: "run-start"; at: number }
  | {
      type: "task";
      at: number;
      taskId: string;
      description: string;
      ruling: Exclude<LaneRuling, "pending"> | "pending";
      score?: number | null;
      report?: Pick<VerificationReport, "verdict" | "score">;
    }
  | { type: "run-end"; at: number };

/** A fresh, empty `VerifyLaneState` — no rows, an all-zero tally, no run started. */
export function laneInit(): VerifyLaneState {
  return {
    rows: [],
    tally: { accept: 0, abstain: 0, reject: 0, pending: 0 },
    scroll: 0,
    startedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Verdict -> ruling mapping (the locked moat mapping)
// ---------------------------------------------------------------------------

/** `accept -> accept`, `reject -> reject`, `revise -> abstain`. The one place this mapping is implemented. */
function mapVerdictToRuling(verdict: Verdict): Exclude<LaneRuling, "pending"> {
  switch (verdict) {
    case "accept":
      return "accept";
    case "reject":
      return "reject";
    case "revise":
      return "abstain";
    default: {
      const _exhaustive: never = verdict;
      return _exhaustive;
    }
  }
}

/** `null`/`undefined`/non-finite collapse to `null` — never a fabricated or `NaN` score reaches a row. */
function safeScore(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Number.isFinite(v) ? v : null;
}

function recomputeTally(rows: readonly VerifyLaneRow[]): VerifyLaneState["tally"] {
  const tally = { accept: 0, abstain: 0, reject: 0, pending: 0 };
  for (const r of rows) tally[r.ruling] += 1;
  return tally;
}

function buildRow(
  taskId: string,
  description: string,
  ruling: LaneRuling,
  score: number | null,
  attempts: number,
  at: number
): VerifyLaneRow {
  return {
    taskId,
    description,
    ruling,
    // A pending task has no real score yet, regardless of what stray data
    // arrived alongside the event — never fabricate one.
    score: ruling === "pending" ? null : score,
    attempts,
    updatedAt: at,
  };
}

// ---------------------------------------------------------------------------
// Reducer — pure, total, immutable
// ---------------------------------------------------------------------------

/**
 * Apply one `VerifyEvent` to `state`, purely.
 *
 *  - `"run-start"`: records `startedAt = ev.at`. Rows/tally/scroll are left
 *    untouched — a restart marker does not implicitly discard the rows of
 *    whatever run was already in progress; callers that want a clean slate
 *    for a new run call `laneInit()` themselves.
 *  - `"run-end"`: a no-op that returns the exact same `state` reference
 *    (`===`) — this state shape carries no "ended" flag; the integrator uses
 *    the event's own `at` alongside `startedAt` to compute `wallMs` for
 *    `vtphReadout` externally.
 *  - `"task"`: upserts `rows` by `taskId` (see the module docstring for the
 *    exact ruling/attempts/score rules), then recomputes `tally` from a full
 *    pass over the new `rows` — never incrementally drifted.
 *
 * Never mutates `state`, any row inside it, or the incoming event; always
 * returns a fresh object for `"run-start"`/`"task"`.
 */
export function laneApply(state: VerifyLaneState, ev: VerifyEvent): VerifyLaneState {
  switch (ev.type) {
    case "run-start": {
      return { ...state, startedAt: ev.at };
    }

    case "run-end": {
      return state;
    }

    case "task": {
      const ruling: LaneRuling = ev.report ? mapVerdictToRuling(ev.report.verdict) : ev.ruling;
      const rawScore = ev.report ? safeScore(ev.report.score) : safeScore(ev.score ?? null);

      const idx = state.rows.findIndex((r) => r.taskId === ev.taskId);
      let rows: VerifyLaneRow[];

      if (idx === -1) {
        // Unseen taskId (fresh dispatch, or an out-of-order verify arriving
        // before its dispatch) — create the row honestly rather than drop
        // the ruling on the floor.
        rows = [...state.rows, buildRow(ev.taskId, ev.description, ruling, rawScore, 1, ev.at)];
      } else {
        const prev = state.rows[idx];
        const isRedispatch = ruling === "pending" && prev.ruling !== "pending";
        const attempts = isRedispatch ? prev.attempts + 1 : prev.attempts;
        const updated = buildRow(ev.taskId, ev.description, ruling, rawScore, attempts, ev.at);
        rows = state.rows.slice();
        rows[idx] = updated;
      }

      return { ...state, rows, tally: recomputeTally(rows) };
    }

    default: {
      const _exhaustive: never = ev;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Scroll navigation (pure, immutable — no height in state; render clamps
// further against the actual window height)
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Apply one VERIFY-LANE scroll key: `"up"`/`"down"` move the scroll offset
 * by one row, `"home"`/`"end"` jump to the first / last row, all clamped to
 * `[0, max(0, rows.length - 1)]`. Any other key is a no-op that returns the
 * exact same `state` reference (`===`). Never mutates `state`; always
 * returns a fresh object on an actionable key.
 */
export function laneKey(state: VerifyLaneState, key: string): VerifyLaneState {
  if (key !== "up" && key !== "down" && key !== "home" && key !== "end") {
    return state;
  }

  const maxScroll = Math.max(0, state.rows.length - 1);
  let target = state.scroll;
  if (key === "up") target -= 1;
  else if (key === "down") target += 1;
  else if (key === "home") target = 0;
  else if (key === "end") target = maxScroll;

  target = clamp(Math.floor(Number.isFinite(target) ? target : 0), 0, maxScroll);
  if (target === state.scroll) return state;
  return { ...state, scroll: target };
}

// ---------------------------------------------------------------------------
// V-TPH$ — verified tasks / hour / dollar, live figures only
// ---------------------------------------------------------------------------

/** Real, run-shaped inputs for `vtphReadout` — the integrator derives every field from the real engine; nothing here is invented. */
export interface VtphInput {
  /** `metrics.tasks.verified` — count of tasks that cleared the gate. */
  verifiedCount: number;
  /** Elapsed wall-clock milliseconds since `run-start`. */
  wallMs: number;
  /** `metrics.usage.costUsd` — real accrued USD cost. */
  costUsd: number;
}

const MS_PER_HOUR = 3600000;

/**
 * Round `value` to `sig` significant figures and format it as a fixed-point
 * decimal string (never scientific notation, never `Infinity`/`NaN`). Zero
 * renders as the bare digit `"0"` — a real, honest zero (verifiedCount = 0
 * over a valid run/cost) reads distinctly from a padded `"0.00"` that might
 * look like a rounding artifact.
 */
function formatSignificant(value: number, sig: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const magnitude = Math.floor(Math.log10(abs));
  const scale = Math.pow(10, sig - 1 - magnitude);
  let rounded = Math.round(abs * scale) / scale;
  if (!Number.isFinite(rounded)) rounded = abs;
  const decimals = Math.min(20, Math.max(0, sig - 1 - magnitude));
  return sign + rounded.toFixed(decimals);
}

/**
 * The lane's live V-TPH$ (verified tasks / hour / dollar) readout:
 * `verifiedCount / (wallMs / 3600000) / costUsd`, computed ONLY when
 * `wallMs >= 1000`, `costUsd > 0`, and `verifiedCount >= 0` — all three
 * finite numbers (NaN/Infinity/negative inputs are all rejected the same as
 * an out-of-range value). Otherwise `value` is `null` and `label` is exactly
 * one of:
 *
 *   - `"V-TPH$ n/a (run too short)"` — `wallMs` is invalid (non-finite or
 *     `< 1000`). A non-finite/negative `verifiedCount` also folds into this
 *     bucket: the readout represents one measured *run*, and a corrupt
 *     verified-task count is a run-measurement problem, not a cost problem,
 *     so it is bucketed here rather than under the cost label.
 *   - `"V-TPH$ n/a (no cost recorded)"` — `wallMs` is valid but `costUsd` is
 *     invalid (non-finite or `<= 0`).
 *   - `"V-TPH$ <n>"` — the formula's result, formatted to 2 significant
 *     figures. `verifiedCount = 0` over an otherwise-valid run renders
 *     `"V-TPH$ 0"` — a real, honest zero, never conflated with `n/a`.
 *
 * `value` is the raw computed number (unrounded) so callers that want full
 * precision for further math can use it; `label` is the display string.
 */
export function vtphReadout(input: VtphInput): { value: number | null; label: string } {
  const { verifiedCount, wallMs, costUsd } = input;

  const wallValid = Number.isFinite(wallMs) && wallMs >= 1000;
  if (!wallValid) {
    return { value: null, label: "V-TPH$ n/a (run too short)" };
  }

  const costValid = Number.isFinite(costUsd) && costUsd > 0;
  if (!costValid) {
    return { value: null, label: "V-TPH$ n/a (no cost recorded)" };
  }

  const countValid = Number.isFinite(verifiedCount) && verifiedCount >= 0;
  if (!countValid) {
    return { value: null, label: "V-TPH$ n/a (run too short)" };
  }

  const hours = wallMs / MS_PER_HOUR;
  const value = verifiedCount / hours / costUsd;
  if (!Number.isFinite(value)) {
    // Defensive: the guards above should make this unreachable, but the
    // honesty discipline holds regardless of how it's reached.
    return { value: null, label: "V-TPH$ n/a (no cost recorded)" };
  }

  return { value, label: `V-TPH$ ${formatSignificant(value, 2)}` };
}

// ---------------------------------------------------------------------------
// Width-safe rendering primitives (code-point counted, matching the rest of tui/)
// ---------------------------------------------------------------------------

function cpLen(s: string): number {
  return [...s].length;
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
// Text sanitization — control chars -> U+FFFD (this pane's locked discipline,
// distinct from other tui/ panes' strip-and-collapse-to-⏎ scheme)
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Sanitize a task id/description before it can ever reach a rendered VERIFY
 * LANE frame: every C0/C1 control character (including ESC, the byte that
 * begins every ANSI escape sequence, and every newline variant) is replaced
 * one-for-one with U+FFFD (the Unicode replacement character) — per this
 * pane's locked contract, distinct from the strip/collapse-to-⏎ scheme other
 * `tui/` panes use. Code-point truncation to fit the row happens separately
 * via `fit`.
 */
function sanitizeLaneText(text: string): string {
  const source = typeof text === "string" ? text : String(text ?? "");
  return source.replace(CONTROL_CHARS, "�");
}

// ---------------------------------------------------------------------------
// Header tally meter (accept █ / abstain ▒ / reject ✗, proportional to width)
// ---------------------------------------------------------------------------

const BAR_WIDTH = 20;
const SEGMENT_ORDER: Record<"accept" | "abstain" | "reject", number> = { accept: 0, abstain: 1, reject: 2 };

/**
 * Split `width` glyph slots among accept/abstain/reject proportionally to
 * their counts, using the largest-remainder method so the three segment
 * counts always sum to exactly `width` (never over/under by a rounding
 * error) whenever `total > 0`. Ties in the remainder break in a fixed,
 * deterministic accept -> abstain -> reject order.
 */
function meterSegments(
  tally: Pick<VerifyLaneState["tally"], "accept" | "abstain" | "reject">,
  width: number
): { accept: number; abstain: number; reject: number } {
  const total = tally.accept + tally.abstain + tally.reject;
  if (total <= 0 || width <= 0) return { accept: 0, abstain: 0, reject: 0 };

  const raw = {
    accept: (tally.accept / total) * width,
    abstain: (tally.abstain / total) * width,
    reject: (tally.reject / total) * width,
  };
  const floors = {
    accept: Math.floor(raw.accept),
    abstain: Math.floor(raw.abstain),
    reject: Math.floor(raw.reject),
  };
  const used = floors.accept + floors.abstain + floors.reject;
  let remainder = Math.max(0, width - used);

  type Segment = { key: "accept" | "abstain" | "reject"; frac: number };
  const fracs: Segment[] = [
    { key: "accept", frac: raw.accept - floors.accept },
    { key: "abstain", frac: raw.abstain - floors.abstain },
    { key: "reject", frac: raw.reject - floors.reject },
  ];
  fracs.sort((a, b) => b.frac - a.frac || SEGMENT_ORDER[a.key] - SEGMENT_ORDER[b.key]);

  const result = { ...floors };
  let i = 0;
  while (remainder > 0) {
    result[fracs[i % fracs.length].key] += 1;
    remainder -= 1;
    i += 1;
  }
  return result;
}

function meterBar(tally: VerifyLaneState["tally"]): string {
  const total = tally.accept + tally.abstain + tally.reject;
  if (total <= 0) return "░".repeat(BAR_WIDTH);
  const seg = meterSegments(tally, BAR_WIDTH);
  return "█".repeat(seg.accept) + "▒".repeat(seg.abstain) + "✗".repeat(seg.reject);
}

// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------

const RULING_GLYPH: Record<LaneRuling, string> = {
  accept: "●",
  abstain: "◌",
  reject: "✗",
  pending: "○",
};

const ABSTAIN_LEGEND = "abstain = escalated for revision, not yet trusted";
const EMPTY_STATE_LINE = "(no tasks yet — dispatch a goal with g)";

function fmtScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "—";
  const pct = Math.round(clamp(score, 0, 1) * 100);
  return `${pct}%`;
}

function formatRow(row: VerifyLaneRow, innerWidth: number): string {
  const glyph = RULING_GLYPH[row.ruling];
  const scoreStr = fmtScore(row.score).padStart(4);
  const attemptsStr = row.attempts > 1 ? `×${row.attempts}` : "";
  const taskId = fit(sanitizeLaneText(row.taskId), 10);
  const prefix = `${glyph} ${scoreStr} ${attemptsStr.padEnd(3)}${taskId} `;
  const prefixWidth = cpLen(prefix);
  const descWidth = Math.max(0, innerWidth - prefixWidth);
  const desc = fit(sanitizeLaneText(row.description), descWidth);
  return fit(`${prefix}${desc}`, innerWidth);
}

/**
 * Build the fixed-`height`-row window of the VERIFY LANE row section: an
 * honest empty state when `rows` is empty (padded with blank lines to
 * `height`), otherwise the `height` rows visible at `scroll` (clamped to
 * `[0, max(0, rows.length - height)]`), padded with trailing blank lines
 * when fewer than `height` rows exist. Always returns exactly `height`
 * lines regardless of `rows`/`scroll`.
 */
function rowWindow(rows: readonly VerifyLaneRow[], scroll: number, height: number, innerWidth: number): string[] {
  const h = Math.max(1, Math.floor(height));

  if (rows.length === 0) {
    const out = [EMPTY_STATE_LINE];
    while (out.length < h) out.push("");
    return out;
  }

  const maxScroll = Math.max(0, rows.length - h);
  const sc = clamp(Math.floor(Number.isFinite(scroll) ? scroll : 0), 0, maxScroll);
  const visible = rows.slice(sc, sc + h);
  const out = visible.map((r) => formatRow(r, innerWidth));
  while (out.length < h) out.push("");
  return out;
}

// ---------------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 72;
const DEFAULT_HEIGHT = 8;

/**
 * Render the VERIFY LANE pane: a header section (real accept/abstain/reject/
 * pending counts, a proportional accept `█` / abstain `▒` / reject `✗` tally
 * meter whose three segment widths always sum to `BAR_WIDTH`, and the honest
 * abstain legend), a fixed-`height`-row window of tasks (ruling glyph
 * `●`=accept `◌`=abstain `✗`=reject `○`=pending, score as a `%` or `—` when
 * `null`, `×N` for `attempts > 1`, task id + sanitized/fitted description),
 * and the V-TPH$ readout line rendered verbatim from `metricsVtph.label`.
 *
 * An empty `rows` list renders the honest
 * `"(no tasks yet — dispatch a goal with g)"` line rather than a bare
 * window. Every emitted line is exactly `width` Unicode code points wide
 * (hard clamp), and the returned array's length is always exactly
 * `height + 8` (1 top border + 3 header lines + 1 divider + `height` row
 * lines + 1 divider + 1 vtph line + 1 bottom border) regardless of `state`,
 * so callers can rely on fixed-height layout.
 */
export function renderVerifyLane(
  state: VerifyLaneState,
  metricsVtph: ReturnType<typeof vtphReadout>,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT
): string[] {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const inner = Math.max(0, w - 2);

  const tally = state.tally;
  const headerRows = [
    `accept=${tally.accept} abstain=${tally.abstain} reject=${tally.reject} pending=${tally.pending}`,
    `[${meterBar(tally)}]`,
    ABSTAIN_LEGEND,
  ];

  const taskRows = rowWindow(state.rows, state.scroll, h, inner);

  const vtphRows = [metricsVtph.label];

  return boxifyLines("VERIFY LANE", [headerRows, taskRows, vtphRows], w);
}
