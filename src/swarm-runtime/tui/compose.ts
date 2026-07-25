/**
 * Cursor-addressable multi-line compose editor for the interactive TUI.
 *
 * This replaces the append-only `composeBuffer: string` that `app.ts` uses
 * today with a real editable buffer: multiple lines, a movable cursor,
 * word/line kill operations, bracketed-paste support, and a boxed renderer.
 * Everything here is a pure reducer — no I/O, no `Date.now`, no imports from
 * `src/hades/**`. The REPL's `MultilineBuffer` (src/hades/repl/multiline.ts)
 * was studied as prior art for the "trailing backslash continues the line"
 * convention, but is not imported: swarm-runtime must not depend on hades.
 *
 * Key string conventions follow `tui/keymap.ts`: printable characters arrive
 * as themselves, Enter as "\r" | "\n" | "return", Backspace as "\x7f" | "\b",
 * Esc as "\x1b" | "escape", arrows as their ANSI sequences, Home/End as
 * "\x1b[H" / "\x1b[F", Delete as "\x1b[3~", and ctrl-arrows as
 * "\x1b[1;5C" / "\x1b[1;5D".
 *
 * One deliberate, documented resolution of an ambiguity in that convention:
 * the locked contract lists both "\n" as an Enter alias *and* says "Ctrl-J
 * injects a newline" — but Ctrl-J's raw byte *is* "\n" (0x0A), the same byte
 * as the Enter alias. Those two requirements cannot both hold for the same
 * raw byte in a deterministic keymap. We keep "\n" classified as Enter (the
 * contract is explicit about that set) and expose Ctrl-J only via the
 * descriptive literal alias `"ctrl-j"` — consistent with how `keymap.ts`
 * itself accepts literal words ("ctrl-c", "escape", "return", "backspace")
 * alongside raw bytes. `app.ts` / the raw-mode reader is expected to emit
 * that literal for the Ctrl-J chord, the same way it already special-cases
 * other control chords.
 */

/** The full state of the compose editor. Never mutated in place. */
export interface ComposeState {
  /** One entry per line; always has at least one entry (possibly ""). */
  lines: string[];
  /** Cursor line, 0-based. Always `0 <= row < lines.length`. */
  row: number;
  /** Cursor column in Unicode code points. Always `0 <= col <= codePointLength(lines[row])`. */
  col: number;
  /** Preferred top row for the visible window; `renderCompose` clamps this to keep the cursor visible. */
  scrollTop: number;
  /** Whether a bracketed-paste sequence is currently open. */
  pasting: boolean;
  /** Raw fragments accumulated so far while `pasting`, in arrival order (joins to the pending paste payload). */
  pasteBuffer: string[];
}

/** Effect produced by a keypress: submit the composed text, cancel compose mode, or nothing. */
export type ComposeEffect = { kind: "submit"; text: string } | { kind: "cancel" } | null;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const ENTER_KEYS = new Set(["\r", "\n", "return"]);
const ALT_ENTER_KEY = "\x1b\r";
const CTRL_J_KEYS = new Set(["ctrl-j"]);
const BACKSPACE_KEYS = new Set(["\x7f", "\b"]);
const ESC_KEYS = new Set(["\x1b", "escape"]);
const DELETE_FWD_KEY = "\x1b[3~";
const HOME_KEY = "\x1b[H";
const END_KEY = "\x1b[F";
const CTRL_LEFT_KEY = "\x1b[1;5D";
const CTRL_RIGHT_KEY = "\x1b[1;5C";
const LEFT_KEY = "\x1b[D";
const RIGHT_KEY = "\x1b[C";
const UP_KEY = "\x1b[A";
const DOWN_KEY = "\x1b[B";
const CTRL_U_KEYS = new Set(["\x15", "ctrl-u"]);
const CTRL_K_KEYS = new Set(["\x0b", "ctrl-k"]);
const CTRL_W_KEYS = new Set(["\x17", "ctrl-w"]);

/* ----------------------------------------------------------------------------
 * Code-point-safe primitives
 * ------------------------------------------------------------------------- */

function toCps(s: string): string[] {
  return [...s];
}

function cpLen(s: string): number {
  return toCps(s).length;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** True for exactly one printable Unicode code point (rejects control chars and multi-char garbage). */
function isPrintable(key: string): boolean {
  const cps = toCps(key);
  if (cps.length !== 1) return false;
  const cp = cps[0]!.codePointAt(0)!;
  if (cp < 0x20) return false; // C0 controls (includes bare \x1b, \x07, ...)
  if (cp === 0x7f) return false; // DEL
  if (cp >= 0x80 && cp <= 0x9f) return false; // C1 controls
  return true;
}

/* ----------------------------------------------------------------------------
 * Construction / text extraction
 * ------------------------------------------------------------------------- */

/** Fresh compose state, optionally pre-seeded with `\n`-joined text (cursor placed at its end). */
export function composeInit(seed = ""): ComposeState {
  const lines = seed.split("\n");
  const row = lines.length - 1;
  return {
    lines,
    row,
    col: cpLen(lines[row] ?? ""),
    scrollTop: 0,
    pasting: false,
    pasteBuffer: [],
  };
}

/** The full buffered text, lines joined with "\n". */
export function composeText(state: ComposeState): string {
  return state.lines.join("\n");
}

/* ----------------------------------------------------------------------------
 * Shared line-splice helpers (all pure: read from `state`, return a new state)
 * ------------------------------------------------------------------------- */

/** Split the current line at the cursor and insert `segments` there (segments.length >= 1). */
function insertSegments(state: ComposeState, segments: string[]): ComposeState {
  const lines = state.lines.slice();
  const cps = toCps(lines[state.row] ?? "");
  const col = clamp(state.col, 0, cps.length);
  const before = cps.slice(0, col).join("");
  const after = cps.slice(col).join("");

  if (segments.length === 1) {
    lines[state.row] = before + segments[0] + after;
    return { ...state, lines, col: col + cpLen(segments[0]!) };
  }

  const middle = segments.slice(1, -1);
  const last = segments[segments.length - 1]!;
  const newRows = [before + segments[0], ...middle, last + after];
  lines.splice(state.row, 1, ...newRows);
  return { ...state, lines, row: state.row + segments.length - 1, col: cpLen(last) };
}

/** Insert a single literal newline at the cursor (used by Alt-Enter, Ctrl-J, backslash-continuation). */
function insertNewline(state: ComposeState): ComposeState {
  return insertSegments(state, ["", ""]);
}

/* ----------------------------------------------------------------------------
 * Bracketed paste
 * ------------------------------------------------------------------------- */

/**
 * Consume `chunk` while a paste is open. Accumulates raw text in
 * `state.pasteBuffer` (joined, so the terminator search always runs over the
 * fully reassembled payload) so a terminator split across several `composeKey`
 * calls is still found once the pieces are concatenated. Newlines in the
 * pasted payload are inserted literally as new lines; nothing pasted is ever
 * interpreted as a command (no submit, no control-key handling) — only the
 * exact terminator ends the paste.
 */
function consumePaste(state: ComposeState, chunk: string): { state: ComposeState; effect: ComposeEffect } {
  const combined = state.pasteBuffer.join("") + chunk;
  const endIdx = combined.indexOf(PASTE_END);
  if (endIdx === -1) {
    return { state: { ...state, pasteBuffer: [combined] }, effect: null };
  }

  const payload = combined.slice(0, endIdx).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const inserted = payload.length === 0 ? state : insertSegments(state, payload.split("\n"));
  let next: ComposeState = { ...inserted, pasting: false, pasteBuffer: [] };

  // In practice the terminator is the tail of its chunk, so there's nothing
  // left over. If a producer ever bundles trailing bytes after it anyway,
  // treat them as literal pasted text rather than dropping or reinterpreting
  // them as commands (paste content is never a command source).
  const leftover = combined.slice(endIdx + PASTE_END.length);
  if (leftover.length > 0) {
    next = insertSegments(next, leftover.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"));
  }
  return { state: next, effect: null };
}

/* ----------------------------------------------------------------------------
 * Word-wise helpers (whitespace-delimited, mirrors common readline behavior)
 * ------------------------------------------------------------------------- */

function wordLeftIndex(cps: string[], col: number): number {
  let i = col;
  while (i > 0 && isSpace(cps[i - 1])) i--;
  while (i > 0 && !isSpace(cps[i - 1])) i--;
  return i;
}

/** Start of the next word: past any word chars at the cursor, then past whitespace. */
function wordRightIndex(cps: string[], col: number): number {
  const len = cps.length;
  let i = col;
  while (i < len && !isSpace(cps[i])) i++;
  while (i < len && isSpace(cps[i])) i++;
  return i;
}

/* ----------------------------------------------------------------------------
 * The reducer
 * ------------------------------------------------------------------------- */

/**
 * Apply one raw key to `state`. Never mutates `state`; always returns a fresh
 * object (or the same reference when a key is a documented no-op).
 */
export function composeKey(state: ComposeState, key: string): { state: ComposeState; effect: ComposeEffect } {
  // Bracketed paste takes priority over everything else once open, and a key
  // carrying the start marker (even with payload bundled in the same chunk,
  // which real terminals commonly do for short pastes) opens it.
  if (state.pasting) {
    return consumePaste(state, key);
  }
  const startIdx = key.indexOf(PASTE_START);
  if (startIdx !== -1) {
    // Bytes preceding the marker in the same chunk are not a realistic case
    // (terminals write the marker as its own atomic sequence) and are
    // intentionally dropped rather than guessed at.
    const rest = key.slice(startIdx + PASTE_START.length);
    return consumePaste({ ...state, pasting: true, pasteBuffer: [] }, rest);
  }

  if (ENTER_KEYS.has(key)) {
    const line = state.lines[state.row] ?? "";
    if (line.endsWith("\\") && !line.endsWith("\\\\")) {
      const stripped = line.slice(0, -1);
      const lines = state.lines.slice();
      lines[state.row] = stripped;
      const col = clamp(state.col, 0, cpLen(stripped));
      return { state: insertNewline({ ...state, lines, col }), effect: null };
    }
    const text = composeText(state).trim();
    if (text.length === 0) {
      return { state, effect: null };
    }
    return { state: composeInit(), effect: { kind: "submit", text } };
  }

  if (key === ALT_ENTER_KEY || CTRL_J_KEYS.has(key)) {
    return { state: insertNewline(state), effect: null };
  }

  if (BACKSPACE_KEYS.has(key)) {
    if (state.col > 0) {
      const lines = state.lines.slice();
      const cps = toCps(lines[state.row] ?? "");
      cps.splice(state.col - 1, 1);
      lines[state.row] = cps.join("");
      return { state: { ...state, lines, col: state.col - 1 }, effect: null };
    }
    if (state.row === 0) {
      return { state, effect: null };
    }
    const lines = state.lines.slice();
    const prevLen = cpLen(lines[state.row - 1] ?? "");
    lines[state.row - 1] = (lines[state.row - 1] ?? "") + (lines[state.row] ?? "");
    lines.splice(state.row, 1);
    return { state: { ...state, lines, row: state.row - 1, col: prevLen }, effect: null };
  }

  if (ESC_KEYS.has(key)) {
    return { state, effect: { kind: "cancel" } };
  }

  if (key === DELETE_FWD_KEY) {
    const cps = toCps(state.lines[state.row] ?? "");
    if (state.col < cps.length) {
      const lines = state.lines.slice();
      const next = cps.slice();
      next.splice(state.col, 1);
      lines[state.row] = next.join("");
      return { state: { ...state, lines }, effect: null };
    }
    if (state.row >= state.lines.length - 1) {
      return { state, effect: null };
    }
    const lines = state.lines.slice();
    lines[state.row] = (lines[state.row] ?? "") + (lines[state.row + 1] ?? "");
    lines.splice(state.row + 1, 1);
    return { state: { ...state, lines }, effect: null };
  }

  if (key === HOME_KEY) {
    return { state: { ...state, col: 0 }, effect: null };
  }
  if (key === END_KEY) {
    return { state: { ...state, col: cpLen(state.lines[state.row] ?? "") }, effect: null };
  }

  if (key === CTRL_LEFT_KEY) {
    if (state.col === 0) {
      if (state.row === 0) return { state, effect: null };
      const row = state.row - 1;
      return { state: { ...state, row, col: cpLen(state.lines[row] ?? "") }, effect: null };
    }
    const cps = toCps(state.lines[state.row] ?? "");
    return { state: { ...state, col: wordLeftIndex(cps, state.col) }, effect: null };
  }
  if (key === CTRL_RIGHT_KEY) {
    const cps = toCps(state.lines[state.row] ?? "");
    if (state.col >= cps.length) {
      if (state.row >= state.lines.length - 1) return { state, effect: null };
      return { state: { ...state, row: state.row + 1, col: 0 }, effect: null };
    }
    return { state: { ...state, col: wordRightIndex(cps, state.col) }, effect: null };
  }

  if (key === LEFT_KEY) {
    if (state.col > 0) return { state: { ...state, col: state.col - 1 }, effect: null };
    if (state.row === 0) return { state, effect: null };
    const row = state.row - 1;
    return { state: { ...state, row, col: cpLen(state.lines[row] ?? "") }, effect: null };
  }
  if (key === RIGHT_KEY) {
    const len = cpLen(state.lines[state.row] ?? "");
    if (state.col < len) return { state: { ...state, col: state.col + 1 }, effect: null };
    if (state.row >= state.lines.length - 1) return { state, effect: null };
    return { state: { ...state, row: state.row + 1, col: 0 }, effect: null };
  }
  if (key === UP_KEY) {
    if (state.row === 0) return { state, effect: null };
    const row = state.row - 1;
    return { state: { ...state, row, col: Math.min(state.col, cpLen(state.lines[row] ?? "")) }, effect: null };
  }
  if (key === DOWN_KEY) {
    if (state.row >= state.lines.length - 1) return { state, effect: null };
    const row = state.row + 1;
    return { state: { ...state, row, col: Math.min(state.col, cpLen(state.lines[row] ?? "")) }, effect: null };
  }

  if (CTRL_U_KEYS.has(key)) {
    const cps = toCps(state.lines[state.row] ?? "");
    const lines = state.lines.slice();
    lines[state.row] = cps.slice(state.col).join("");
    return { state: { ...state, lines, col: 0 }, effect: null };
  }
  if (CTRL_K_KEYS.has(key)) {
    const cps = toCps(state.lines[state.row] ?? "");
    const lines = state.lines.slice();
    lines[state.row] = cps.slice(0, state.col).join("");
    return { state: { ...state, lines }, effect: null };
  }
  if (CTRL_W_KEYS.has(key)) {
    if (state.col === 0) {
      if (state.row === 0) return { state, effect: null };
      const lines = state.lines.slice();
      const prevLen = cpLen(lines[state.row - 1] ?? "");
      lines[state.row - 1] = (lines[state.row - 1] ?? "") + (lines[state.row] ?? "");
      lines.splice(state.row, 1);
      return { state: { ...state, lines, row: state.row - 1, col: prevLen }, effect: null };
    }
    const cps = toCps(state.lines[state.row] ?? "");
    const start = wordLeftIndex(cps, state.col);
    const lines = state.lines.slice();
    lines[state.row] = cps.slice(0, start).concat(cps.slice(state.col)).join("");
    return { state: { ...state, lines, col: start }, effect: null };
  }

  if (isPrintable(key)) {
    return { state: insertSegments(state, [key]), effect: null };
  }

  // Anything else (stray control bytes, unrecognized escape fragments,
  // multi-char garbage) is rejected outright: never appended to the buffer.
  return { state, effect: null };
}

/* ----------------------------------------------------------------------------
 * Rendering (boxed, code-point exact; fit/boxify reimplemented locally per
 * the panes.ts approach — panes.ts itself is not imported/touched)
 * ------------------------------------------------------------------------- */

/** Pad or truncate (with a trailing "…") so the result is exactly `w` code points. */
function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const cps = toCps(s);
  if (cps.length === w) return s;
  if (cps.length < w) return s + " ".repeat(w - cps.length);
  return cps.slice(0, w - 1).join("") + "…";
}

/** A boxed block of exactly `rows.length + 2` lines, each exactly `width` code points. */
function boxify(title: string, rows: string[], width: number): string[] {
  const inner = Math.max(0, width - 2);
  const label = title ? ` ${title} ` : "";
  const header = fit(`─${label}`, inner).replace(/ +$/g, (m) => "─".repeat(m.length));
  const out: string[] = [];
  out.push(`╭${header}╮`);
  for (const r of rows) out.push(`│${fit(r, inner)}│`);
  out.push(`╰${"─".repeat(inner)}╯`);
  return out;
}

/** Insert the cursor marker "▏" at code-point column `col` of `line`. */
function withCursor(line: string, col: number): string {
  const cps = toCps(line);
  const c = clamp(col, 0, cps.length);
  return `${cps.slice(0, c).join("")}▏${cps.slice(c).join("")}`;
}

interface Window {
  top: number;
  contentRows: number;
  above: number;
  below: number;
}

/**
 * Pick the visible line window: starts from `hint` (state.scrollTop) and
 * nudges just enough to keep `row` inside it, then reserves a row for a
 * "…more above/below" marker whenever content is actually hidden on that
 * side (shrinking the window and re-checking, since reserving a row can
 * itself push the boundary and change what's hidden).
 */
function computeWindow(row: number, total: number, hint: number, maxRows: number): Window {
  let contentRows = Math.max(1, maxRows);
  for (let iter = 0; iter < 4; iter++) {
    const maxTop = Math.max(0, total - contentRows);
    let top = clamp(hint, 0, maxTop);
    if (row < top) top = row;
    if (row > top + contentRows - 1) top = row - contentRows + 1;
    top = clamp(top, 0, maxTop);
    const above = top;
    const below = Math.max(0, total - (top + contentRows));
    const reserved = (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0);
    const next = Math.max(1, maxRows - reserved);
    if (next === contentRows) {
      return { top, contentRows, above, below };
    }
    contentRows = next;
  }
  const maxTop = Math.max(0, total - contentRows);
  const top = clamp(hint, 0, maxTop);
  return { top, contentRows, above: top, below: Math.max(0, total - (top + contentRows)) };
}

/**
 * Render the editor as a box exactly `maxRows` visible content rows tall
 * (`maxRows + 2` lines total with borders), each exactly `width` code points.
 * Hidden lines above/below the window get an honest "…(N more lines
 * above/below)" marker (never a lie about how many are hidden).
 */
export function renderCompose(state: ComposeState, width: number, maxRows: number): string[] {
  const W = Math.max(4, Math.floor(width));
  const rowsBudget = Math.max(1, Math.floor(maxRows));
  const total = state.lines.length;
  const win = computeWindow(state.row, total, state.scrollTop, rowsBudget);

  const rows: string[] = [];
  if (win.above > 0) {
    rows.push(`…(${win.above} more line${win.above === 1 ? "" : "s"} above)`);
  }
  const sliceEnd = Math.min(total, win.top + win.contentRows);
  for (let i = win.top; i < sliceEnd; i++) {
    const raw = state.lines[i] ?? "";
    rows.push(i === state.row ? withCursor(raw, state.col) : raw);
  }
  const beforeMarkerBudget = rowsBudget - (win.below > 0 ? 1 : 0);
  while (rows.length < beforeMarkerBudget) rows.push("");
  if (win.below > 0) {
    rows.push(`…(${win.below} more line${win.below === 1 ? "" : "s"} below)`);
  }
  while (rows.length < rowsBudget) rows.push("");

  return boxify("COMPOSE", rows.slice(0, rowsBudget), W);
}
