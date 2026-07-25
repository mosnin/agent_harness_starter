/**
 * skill-trust-pane.ts — pure, deterministic SKILLS/TRUST pane for the
 * interactive TUI (`hades tui`).
 *
 * Renders the effective trust state of every skill the agent knows about —
 * which skills it currently trusts, which are on probation or demoted, and
 * why — with a selectable, sortable table and a drill-in "reasons" detail
 * view for the selected row.
 *
 * Every function here is a pure string-in/string-out or state-in/state-out
 * transform: no I/O, no timers, no ANSI escapes, no `Date.now()`, no
 * randomness, and no imports from `src/hades/**` or anywhere outside this
 * file's own declarations. Data arrives as plain JSON-compatible rows the
 * orchestrator can populate directly from `SkillTrustReader.rows()`'s output
 * (a structural, not import, match — see `src/hades/skills/trust-selection.ts`'s
 * `SkillTrustRow`: `skillName`, `status`, `wilsonLower`, `recentBrier`, `n`,
 * `verifiedN`, and `reasons` all line up field-for-field with this module's
 * `SkillTrustPaneRow`), exactly how `schedule-pane.ts` structurally matches
 * `buildSchedulePaneSnapshot()`'s hades-side output with zero adapter code
 * required. `trust-selection.ts`'s `SkillTrustRow` additionally carries
 * `since`/`streak` fields this pane does not display; the fields it does
 * share are a byte-for-byte structural match so the integrator can feed
 * `SkillTrustReader` output straight in.
 *
 * Visual conventions match `schedule-pane.ts` / `gateway-pane.ts` /
 * `fleet-pane.ts` / `render.ts`: `╭─╮ │ ├ ┤ ╰─╯` box drawing, a default width
 * of 72 code points, and a hard clamp — no line this module emits ever
 * exceeds the requested width. Width is measured in Unicode code points (via
 * `[...s].length`) so multi-byte skill names / reasons text never desyncs
 * the border.
 *
 * Honesty discipline:
 *  - No I/O, no timers, no ANSI escapes, no `Date.now()`, no randomness.
 *  - Every number (`wilsonLower`, `recentBrier`, `n`, `verifiedN`) prints
 *    verbatim from the row this module never derives, sums, or invents a
 *    metric of its own. `wilsonLower`/`recentBrier` print fixed to 4
 *    decimals when non-null, or "—" when `null` — never the literal string
 *    "null" or "NaN".
 *  - An empty `rows` list renders an explicit "no skills tracked" line,
 *    never a bare box.
 *  - Free text (`skillName`, each entry of `reasons`) is run through a local
 *    `sanitize` that strips C0/C1 control characters and ESC before it is
 *    ever laid into a rendered line, so no upstream data can inject cursor
 *    moves, color codes, or terminal-clear sequences into the pane.
 *  - A selected row with `showReasons` on but an empty `reasons` array
 *    renders "no reasons recorded" — never a blank section.
 *  - This module never deduplicates `rows` by `skillName`: duplicate names
 *    render verbatim, once per row supplied. Identity is the caller's
 *    concern.
 */

// ---------------------------------------------------------------------------
// Row/state shapes (plain, JSON-compatible — no imports from src/hades/**)
// ---------------------------------------------------------------------------

/**
 * One row of the SKILLS/TRUST pane: a single skill's full effective trust
 * state, ready to render with zero adapter code.
 *
 * This interface is a deliberate STRUCTURAL (not import) match to
 * `src/hades/skills/trust-selection.ts`'s `SkillTrustRow` display fields —
 * `skillName`, `status`, `wilsonLower`, `recentBrier`, `n`, `verifiedN`, and
 * `reasons` all line up field-for-field with that type, exactly the way
 * `schedule-pane.ts`'s row types structurally (not via import) match their
 * hades-side snapshot counterparts. This file has ZERO imports from
 * `src/hades/**`; the pairing is documentation, not a compile-time link, and
 * is enforced instead by this team's structural-compat test.
 */
export interface SkillTrustPaneRow {
  skillName: string;
  status: "active" | "probation" | "demoted" | "unscored" | "integrity-error";
  wilsonLower: number | null;
  recentBrier: number | null;
  n: number;
  verifiedN: number;
  reasons: readonly string[];
}

/**
 * The pane's full pure view-state: the row list plus a selection cursor,
 * the active sort mode, and whether the reasons detail section is expanded
 * for the selected row. Immutable by convention — every helper below
 * returns a fresh object; none of them mutate their inputs.
 */
export interface SkillTrustPaneState {
  rows: readonly SkillTrustPaneRow[];
  /** Index into `rows` (in current sorted display order) of the selected row, clamped to `[0, rows.length - 1]`. */
  selected: number;
  sort: "name" | "trust";
  showReasons: boolean;
}

const DEFAULT_WIDTH = 72;

/**
 * A fresh `SkillTrustPaneState` over `rows`: selection pinned to the first
 * row (or `0` when `rows` is empty), sorted by `"name"`, reasons collapsed.
 * `rows` is stored by reference (not cloned) — callers that mutate their
 * source array after calling this should not; treat `rows` as owned by the
 * returned state, matching every other pane in this directory.
 */
export function initSkillTrustPane(rows: readonly SkillTrustPaneRow[]): SkillTrustPaneState {
  return {
    rows,
    selected: 0,
    sort: "name",
    showReasons: false,
  };
}

// ---------------------------------------------------------------------------
// Width-safe primitives (code-point counted, matching schedule-pane.ts's discipline)
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
// Text sanitization — no ANSI injection, no stray control characters
// ---------------------------------------------------------------------------

/** C0 controls (excluding LF/CR, collapsed to "⏎" first), DEL, and C1 controls (0x80-0x9F, which also cover ESC's high-bit cousins). ESC (0x1B) itself falls inside the C0 range below. */
const CONTROL_CHARS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const NEWLINES = /\r\n|\r|\n/g;

/**
 * Sanitize arbitrary upstream text (a skill name or a reasons entry) before
 * it can ever reach a rendered TUI frame:
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
 * `initSkillTrustPane` / `skillTrustPaneKey` / `renderSkillTrustPane` plus
 * the row/state interfaces, so this stays an internal implementation detail
 * exercised indirectly through `renderSkillTrustPane`'s adversarial-input
 * tests.
 */
function sanitizeTrustText(text: string, max: number): string {
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
  return sanitizeTrustText(text, max);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<SkillTrustPaneRow["status"], number> = {
  active: 0,
  unscored: 1,
  probation: 2,
  demoted: 3,
  "integrity-error": 4,
};

/**
 * Return `rows` sorted per `sort` mode. Never mutates the input array.
 *
 *  - `"name"`: plain ascending by `skillName`.
 *  - `"trust"`: grouped by status in the fixed order active -> unscored ->
 *    probation -> demoted -> integrity-error; within the `active` group,
 *    ordered by `wilsonLower` descending (a `null` wilsonLower — which
 *    should not occur for a genuinely active/scored skill, but is handled
 *    honestly if it does — sorts as if it were `-Infinity`, i.e. below every
 *    row that has a real wilson value, never as `0`); every other group
 *    (including ties within `active`) breaks ties by `skillName` ascending.
 */
function sortRows(
  rows: readonly SkillTrustPaneRow[],
  sort: SkillTrustPaneState["sort"]
): SkillTrustPaneRow[] {
  const copy = rows.slice();
  if (sort === "name") {
    copy.sort((a, b) => (a.skillName < b.skillName ? -1 : a.skillName > b.skillName ? 1 : 0));
    return copy;
  }
  copy.sort((a, b) => {
    const ga = STATUS_ORDER[a.status];
    const gb = STATUS_ORDER[b.status];
    if (ga !== gb) return ga - gb;
    if (a.status === "active") {
      const wa = a.wilsonLower === null ? -Infinity : a.wilsonLower;
      const wb = b.wilsonLower === null ? -Infinity : b.wilsonLower;
      if (wa !== wb) return wb - wa;
    }
    return a.skillName < b.skillName ? -1 : a.skillName > b.skillName ? 1 : 0;
  });
  return copy;
}

// ---------------------------------------------------------------------------
// Keyboard state machine
// ---------------------------------------------------------------------------

/**
 * Apply one SKILLS/TRUST-pane key action, purely:
 *
 *  - `"up"` / `"down"` move the selection by one row (in the *current sort
 *    order*), clamped to `[0, rows.length - 1]`.
 *  - `"s"` toggles `sort` between `"name"` and `"trust"`. Selection follows
 *    the selected SKILL, not its index: after re-sorting, the row that was
 *    selected before the toggle is re-located in the new order and its new
 *    index becomes `selected` (falling back to index `0` — or the clamped
 *    prior index if the skill can no longer be found, e.g. duplicate names
 *    resolve to the first match — never throwing).
 *  - `"enter"` toggles `showReasons` for the currently selected row.
 *  - Any other key is a no-op that returns the exact same `state` reference
 *    (`===`), so callers can cheaply detect "nothing changed".
 *
 * An empty `rows` list pins `selected` to `0` regardless of the key
 * pressed. Never mutates `state` or any row inside it; always returns a
 * fresh object on an actionable key.
 */
export function skillTrustPaneKey(state: SkillTrustPaneState, key: string): SkillTrustPaneState {
  const length = state.rows.length;

  if (key === "up" || key === "down") {
    if (length === 0) {
      return state.selected === 0 ? state : { ...state, selected: 0 };
    }
    // `selected` is always interpreted against the pane's *current* sort
    // order (see `renderSkillTrustPane`); moving it up/down therefore only
    // needs `length`, not the sorted array itself.
    const current = clamp(Math.floor(state.selected), 0, length - 1);
    let target = current;
    if (key === "up") target -= 1;
    else target += 1;
    target = clamp(target, 0, length - 1);
    if (target === state.selected) return state;
    return { ...state, selected: target };
  }

  if (key === "s") {
    const nextSort: SkillTrustPaneState["sort"] = state.sort === "name" ? "trust" : "name";
    if (length === 0) {
      return state.sort === nextSort ? state : { ...state, sort: nextSort };
    }
    const before = sortRows(state.rows, state.sort);
    const selectedIdx = clamp(Math.floor(state.selected), 0, length - 1);
    const selectedRow = before[selectedIdx];
    const after = sortRows(state.rows, nextSort);
    let newIndex = after.indexOf(selectedRow);
    if (newIndex === -1) {
      // Fallback: locate by skillName (handles the case where `selectedRow`
      // is a distinct object with the same identity semantics as another
      // row); if still not found (should not happen since `after` is a
      // permutation of the same row objects), clamp the prior index.
      newIndex = after.findIndex((r) => r.skillName === selectedRow.skillName);
      if (newIndex === -1) newIndex = clamp(selectedIdx, 0, after.length - 1);
    }
    return { ...state, sort: nextSort, selected: newIndex };
  }

  if (key === "enter") {
    // Toggling is honest and unconditional, even with zero rows: the render
    // side handles "showReasons true but nothing to select" explicitly
    // rather than this function silently refusing the toggle.
    return { ...state, showReasons: !state.showReasons };
  }

  return state;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<SkillTrustPaneRow["status"], string> = {
  active: "✓",
  probation: "~",
  demoted: "✗",
  unscored: "?",
  "integrity-error": "!",
};

const STATUS_LABEL: Record<SkillTrustPaneRow["status"], string> = {
  active: "active",
  probation: "probation",
  demoted: "demoted",
  unscored: "unscored",
  "integrity-error": "integrity-error",
};

/** Fixed 4-decimal formatting for a metric that may be `null`; never prints "null"/"NaN". */
function fmtMetric(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  return v.toFixed(4);
}

/**
 * Render the SKILLS/TRUST pane: a status glyph + label + metrics table (one
 * row per skill, in the state's current sort order, with the selected row
 * visibly marked), plus a REASONS detail section under the table when
 * `state.showReasons` is on. One line array entry per rendered line (no
 * embedded newlines). Every emitted line is exactly `width` Unicode code
 * points wide (hard clamp): no line this function returns ever exceeds
 * `width`, and all free text (`skillName`, each `reasons` entry) is passed
 * through `sanitizeTrustText` before being laid into a row, so no control
 * character or ANSI escape byte from upstream data can ever survive into
 * the rendered frame.
 */
export function renderSkillTrustPane(state: SkillTrustPaneState, width = DEFAULT_WIDTH): string[] {
  const sorted = sortRows(state.rows, state.sort);
  const sortLabel = state.sort === "name" ? "name" : "trust";

  const tableRows: string[] = [`SKILLS (${sorted.length}) sort=${sortLabel}`];
  if (sorted.length === 0) {
    tableRows.push("  no skills tracked");
  } else {
    const selected = clamp(Math.floor(state.selected), 0, sorted.length - 1);
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      const marker = i === selected ? "▸" : " ";
      const glyph = STATUS_GLYPH[row.status];
      const label = STATUS_LABEL[row.status];
      tableRows.push(
        `${marker} ${glyph} ${sane(row.skillName, 28)}  ${label}`
      );
      tableRows.push(
        `    wilson=${fmtMetric(row.wilsonLower)}  brier=${fmtMetric(row.recentBrier)}  n=${row.n}  verified=${row.verifiedN}`
      );
    }
  }

  const sections: string[][] = [tableRows];

  if (state.showReasons) {
    const reasonRows: string[] = ["REASONS"];
    if (sorted.length === 0) {
      reasonRows.push("  no skills tracked");
    } else {
      const selected = clamp(Math.floor(state.selected), 0, sorted.length - 1);
      const row = sorted[selected];
      reasonRows.push(`  ${sane(row.skillName, 60)}`);
      if (row.reasons.length === 0) {
        reasonRows.push("  no reasons recorded");
      } else {
        for (const reason of row.reasons) {
          reasonRows.push(`  - ${sane(reason, 200)}`);
        }
      }
    }
    sections.push(reasonRows);
  }

  return boxifyLines("SKILLS/TRUST", sections, width);
}
