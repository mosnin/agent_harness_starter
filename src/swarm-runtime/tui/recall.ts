/**
 * Cross-session input history recall for the interactive TUI.
 *
 * Two layers, deliberately kept in one module:
 *
 *  1. `RecallStore` — durable persistence of everything the operator has
 *     ever typed into compose mode (goals, slash commands, redirects) as a
 *     JSONL file under the TUI's `dataDir`. This is the ONE module in
 *     `swarm-runtime/tui` allowed to touch `node:fs`; every other file in
 *     this directory stays pure. Writes are atomic (temp file + rename in
 *     the same directory, mirroring `hades/repl/history.ts`'s convention),
 *     corrupt lines are skipped and honestly counted rather than silently
 *     dropped or thrown, and the store never reads env/config itself — the
 *     integrator decides the path.
 *
 *  2. A pure recall reducer (`recallInit` / `recallKey` / `filterRecall` /
 *     `renderRecallBar`) that layers Up/Down history cycling and Ctrl-R
 *     incremental reverse search on top of compose mode, the same shape as
 *     `hades/repl/history.ts`'s `CommandHistory.prev`/`next` but exposed as
 *     an explicit state machine (like `compose.ts`'s reducer) so it can be
 *     driven from `app.ts` without any hidden mutable cursor state.
 *
 * No ambient nondeterminism in the reducer half: `at` timestamps for
 * `RecallEntry` are always caller-supplied (mirrors `history.ts`'s
 * convention) — there is no `Date.now()` anywhere in this file.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** The kinds of input recorded into recall history. */
export type RecallEntryKind = "goal" | "slash" | "redirect";

/** One recorded line of input, newest entries appended last on disk. */
export interface RecallEntry {
  text: string;
  /** caller-supplied ms timestamp (no clock inside this module) */
  at: number;
  kind: RecallEntryKind;
}

/** JSONL format version this module reads/writes. */
const FORMAT_VERSION = 1;

interface VersionHeader {
  v: number;
}

const DEFAULT_MAX_ENTRIES = 1000;

export interface RecallStoreOptions {
  filePath: string;
  /** Max entries retained on disk. Default 1000. Oldest dropped first. */
  maxEntries?: number;
}

export interface RecallLoadResult {
  entries: RecallEntry[];
  /** Count of lines that could not be parsed / validated, skipped honestly. */
  skippedCorrupt: number;
}

function isRecallEntryKind(v: unknown): v is RecallEntryKind {
  return v === "goal" || v === "slash" || v === "redirect";
}

/** Structural validation of a parsed JSON value as a `RecallEntry`. */
function isRecallEntry(v: unknown): v is RecallEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.text === "string" && typeof o.at === "number" && Number.isFinite(o.at) && isRecallEntryKind(o.kind);
}

function isVersionHeader(v: unknown): v is VersionHeader {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.v === "number";
}

/**
 * Durable append-only recall history, stored as JSONL: a version header line
 * `{"v":1}` followed by one JSON-encoded `RecallEntry` per line, newest
 * last. Real filesystem I/O (this is the one module in `tui/` allowed to
 * import `node:fs`). Every write is atomic: content is written to a temp
 * file in the same directory as the target, then renamed over it, so a
 * crash mid-write never leaves a half-written file in place of the real one.
 */
export class RecallStore {
  private readonly filePath: string;
  private readonly maxEntries: number;

  constructor(opts: RecallStoreOptions) {
    this.filePath = opts.filePath;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isFinite(this.maxEntries) || this.maxEntries < 1) {
      throw new Error(`RecallStore: maxEntries must be a positive finite number, got ${String(opts.maxEntries)}`);
    }
  }

  /**
   * Load and parse the file. A missing file yields an empty, non-corrupt
   * result. A missing or mismatched version header (including an entirely
   * empty file, or one whose first line isn't a valid `{"v":N}` header)
   * yields an empty result with every non-blank line counted as corrupt —
   * never a thrown error, never a silent misinterpretation of a foreign
   * format as valid entries.
   */
  load(): RecallLoadResult {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return { entries: [], skippedCorrupt: 0 };
    }

    // Split on "\n"; JSON.stringify never emits a raw newline inside a
    // string (it escapes to \n), so this is a safe, exact line boundary.
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) {
      return { entries: [], skippedCorrupt: 0 };
    }

    const [headerLine, ...rest] = lines;
    let header: unknown;
    try {
      header = JSON.parse(headerLine!);
    } catch {
      // Unparseable header: nothing in this file can be trusted as ours.
      return { entries: [], skippedCorrupt: lines.length };
    }
    if (!isVersionHeader(header) || header.v !== FORMAT_VERSION) {
      // Missing, malformed, or (honestly) unknown version: refuse to guess
      // at a foreign format's shape. Every line, including the header, is
      // counted as skipped so the caller knows data was left unread.
      return { entries: [], skippedCorrupt: lines.length };
    }

    const entries: RecallEntry[] = [];
    let skippedCorrupt = 0;
    for (const line of rest) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedCorrupt++;
        continue;
      }
      if (!isRecallEntry(parsed)) {
        skippedCorrupt++;
        continue;
      }
      entries.push({ text: parsed.text, at: parsed.at, kind: parsed.kind });
    }

    return { entries, skippedCorrupt };
  }

  /**
   * Append one entry, then atomically rewrite the whole file. Adjacent
   * duplicate texts (same `text` as the current newest entry, regardless of
   * `kind`/`at`) are deduped — the incoming entry replaces the prior newest
   * one instead of piling up a repeat. The file is bounded to `maxEntries`
   * by dropping the oldest entries first. A corrupt on-disk file is treated
   * the same as `load()` would (skipped, not thrown into the caller's face)
   * so one bad entry can never wedge future appends.
   */
  append(entry: RecallEntry): void {
    const { entries } = this.load();
    if (entries.length > 0 && entries[entries.length - 1]!.text === entry.text) {
      entries.pop();
    }
    entries.push(entry);
    while (entries.length > this.maxEntries) {
      entries.shift();
    }
    this.writeAll(entries);
  }

  private writeAll(entries: RecallEntry[]): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });

    const header: VersionHeader = { v: FORMAT_VERSION };
    const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))];
    const content = lines.join("\n") + "\n";

    // Atomic write: temp file in the SAME directory as the target (so the
    // rename below is a same-filesystem rename and therefore atomic on
    // POSIX), then rename over the target. A reader of `filePath` can never
    // observe a partially-written file: it either sees the old complete
    // content or the new complete content, never a half-write. If a prior
    // write crashed between the writeFileSync and the rename, the leftover
    // `.tmp` file is simply overwritten by the next writeFileSync below and
    // never affects `filePath` (which `load()` reads exclusively).
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, content, "utf8");
    try {
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure recall UI (Up/Down cycling + Ctrl-R incremental reverse search)
// ---------------------------------------------------------------------------

/** Key string conventions follow `compose.ts` / `keymap.ts`. */
const UP_KEYS = new Set(["\x1b[A"]);
const DOWN_KEYS = new Set(["\x1b[B"]);
const CTRL_R_KEYS = new Set(["\x12", "ctrl-r"]);
const ENTER_KEYS = new Set(["\r", "\n", "return"]);
const BACKSPACE_KEYS = new Set(["\x7f", "\b"]);
const ESC_KEYS = new Set(["\x1b", "escape"]);

export type RecallMode = "idle" | "cycling" | "search";

/** The recall reducer's full state. Never mutated in place. */
export interface RecallState {
  mode: RecallMode;
  /**
   * Index into `entries` (newest-first walk order) while cycling, or the
   * index into the filtered match list while searching. -1 when not
   * pointing at any entry yet (idle, or a search with no matches).
   */
  index: number;
  /** The compose buffer stashed when recall was entered; restored on exit. */
  draft: string | null;
  /** The incremental reverse-search query typed so far. */
  query: string;
  /** Index into the filtered match list currently highlighted while searching. */
  matchIndex: number;
}

export type RecallEffect = { kind: "replace-buffer"; text: string } | { kind: "restore-draft"; text: string };

/** Fresh, idle recall state. */
export function recallInit(): RecallState {
  return { mode: "idle", index: -1, draft: null, query: "", matchIndex: -1 };
}

function toCps(s: string): string[] {
  return [...s];
}

/**
 * Newest-first indices into `entries` whose `text` contains `query`
 * (case-insensitive substring match). `entries` is assumed to be stored
 * oldest-first (matching `RecallStore.load()`'s order); the returned
 * indices walk from the newest entry (`entries.length - 1`) backward to the
 * oldest (`0`), which is the natural reverse-search / Up-arrow order. An
 * empty `query` matches every entry (so entering search with no input yet
 * shows the newest entry, readline-style).
 */
export function filterRecall(entries: readonly RecallEntry[], query: string): number[] {
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (needle.length === 0 || e.text.toLowerCase().includes(needle)) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Replace every control character (C0 controls including \n/\r/\x1b, DEL,
 * and C1 controls) with U+FFFD so hostile stored text — ANSI escapes, a
 * bare \r, an embedded newline that would otherwise break the one-line
 * status bar — can never corrupt the terminal or its layout. Printable
 * Unicode (including box-drawing characters) passes through unchanged: it
 * cannot issue terminal control sequences, it can only be a character.
 */
function sanitizeForDisplay(s: string): string {
  return toCps(s)
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return "�";
      return ch;
    })
    .join("");
}

function truncateCps(s: string, n: number): string {
  if (n <= 0) return "";
  const cps = toCps(s);
  return cps.length > n ? `${cps.slice(0, Math.max(0, n - 1)).join("")}…` : s;
}

/**
 * Apply one raw key while recall is (potentially) active. `entries` is the
 * caller's loaded history (oldest-first, as `RecallStore.load()` returns
 * it); `currentBuffer` is the live compose text, used both to stash a draft
 * on entry and to detect a not-yet-recalling idle state. Returns the next
 * state plus an optional effect the caller applies to the real compose
 * buffer (recall itself never touches compose state directly — it only
 * describes the intended replacement).
 *
 * Unhandled keys while idle are a no-op (recall doesn't intercept normal
 * typing) so the caller can always try `recallKey` first and fall through
 * to `composeKey` when the state is unchanged and no effect fired.
 */
export function recallKey(
  state: RecallState,
  key: string,
  entries: readonly RecallEntry[],
  currentBuffer: string
): { state: RecallState; effect: RecallEffect | null } {
  if (state.mode === "search") {
    return searchKey(state, key, entries);
  }

  // idle | cycling
  if (UP_KEYS.has(key)) {
    return cycleUp(state, entries, currentBuffer);
  }
  if (DOWN_KEYS.has(key)) {
    if (state.mode !== "cycling") return { state, effect: null };
    return cycleDown(state, entries);
  }
  if (CTRL_R_KEYS.has(key)) {
    const draft = state.mode === "cycling" ? state.draft! : currentBuffer;
    const next: RecallState = { mode: "search", index: -1, draft, query: "", matchIndex: -1 };
    return applySearchMatch(next, entries);
  }

  // Any other key while merely cycling (not searching) ends the recall
  // session without touching the buffer — the caller's normal key handling
  // (composeKey) takes over from whatever text is currently shown.
  if (state.mode === "cycling") {
    return { state: recallInit(), effect: null };
  }
  return { state, effect: null };
}

function cycleUp(
  state: RecallState,
  entries: readonly RecallEntry[],
  currentBuffer: string
): { state: RecallState; effect: RecallEffect | null } {
  if (entries.length === 0) {
    return { state, effect: null }; // honest no-op: nothing to recall
  }
  const draft = state.mode === "cycling" ? state.draft! : currentBuffer;
  const nextIndex = state.mode === "cycling" ? Math.max(0, state.index - 1) : entries.length - 1;
  const next: RecallState = { mode: "cycling", index: nextIndex, draft, query: "", matchIndex: -1 };
  return { state: next, effect: { kind: "replace-buffer", text: entries[nextIndex]!.text } };
}

function cycleDown(
  state: RecallState,
  entries: readonly RecallEntry[]
): { state: RecallState; effect: RecallEffect | null } {
  const nextIndex = state.index + 1;
  if (nextIndex >= entries.length) {
    const draft = state.draft ?? "";
    return { state: recallInit(), effect: { kind: "restore-draft", text: draft } };
  }
  const next: RecallState = { ...state, index: nextIndex };
  return { state: next, effect: { kind: "replace-buffer", text: entries[nextIndex]!.text } };
}

/** Recompute `matchIndex`/the shown text for the current `query`, clamped honestly to the match list. */
function applySearchMatch(
  state: RecallState,
  entries: readonly RecallEntry[]
): { state: RecallState; effect: RecallEffect | null } {
  const matches = filterRecall(entries, state.query);
  if (matches.length === 0) {
    return { state: { ...state, index: -1, matchIndex: -1 }, effect: null };
  }
  const matchIndex = clamp(state.matchIndex < 0 ? 0 : state.matchIndex, 0, matches.length - 1);
  const entryIndex = matches[matchIndex]!;
  return { state: { ...state, index: entryIndex, matchIndex }, effect: { kind: "replace-buffer", text: entries[entryIndex]!.text } };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function searchKey(
  state: RecallState,
  key: string,
  entries: readonly RecallEntry[]
): { state: RecallState; effect: RecallEffect | null } {
  if (CTRL_R_KEYS.has(key)) {
    // Repeated Ctrl-R: jump to the next OLDER match (clamped at the oldest).
    const matches = filterRecall(entries, state.query);
    if (matches.length === 0) {
      return { state, effect: null };
    }
    const nextMatchIndex = clamp(state.matchIndex + 1, 0, matches.length - 1);
    const entryIndex = matches[nextMatchIndex]!;
    const next: RecallState = { ...state, matchIndex: nextMatchIndex, index: entryIndex };
    return { state: next, effect: { kind: "replace-buffer", text: entries[entryIndex]!.text } };
  }

  if (ENTER_KEYS.has(key)) {
    const matches = filterRecall(entries, state.query);
    if (matches.length === 0 || state.matchIndex < 0) {
      // Nothing matched: accepting is meaningless, restore the draft.
      const draft = state.draft ?? "";
      return { state: recallInit(), effect: { kind: "restore-draft", text: draft } };
    }
    const entryIndex = matches[clamp(state.matchIndex, 0, matches.length - 1)]!;
    return { state: recallInit(), effect: { kind: "replace-buffer", text: entries[entryIndex]!.text } };
  }

  if (ESC_KEYS.has(key)) {
    const draft = state.draft ?? "";
    return { state: recallInit(), effect: { kind: "restore-draft", text: draft } };
  }

  if (BACKSPACE_KEYS.has(key)) {
    if (state.query.length === 0) {
      return { state, effect: null };
    }
    const cps = toCps(state.query);
    const query = cps.slice(0, -1).join("");
    // Widening the query starts the search over from the newest match again
    // (readline convention: shrinking the query resets which occurrence is shown).
    return applySearchMatch({ ...state, query, matchIndex: 0 }, entries);
  }

  if (isSearchPrintable(key)) {
    const query = state.query + key;
    return applySearchMatch({ ...state, query, matchIndex: 0 }, entries);
  }

  // Anything else (arrows, unrelated control bytes, ...) is swallowed while
  // searching rather than leaking into the compose buffer — only effects
  // ever reach the buffer, per the locked contract.
  return { state, effect: null };
}

/** True for exactly one printable Unicode code point (mirrors `compose.ts#isPrintable`). */
function isSearchPrintable(key: string): boolean {
  const cps = toCps(key);
  if (cps.length !== 1) return false;
  const cp = cps[0]!.codePointAt(0)!;
  if (cp < 0x20) return false;
  if (cp === 0x7f) return false;
  if (cp >= 0x80 && cp <= 0x9f) return false;
  return true;
}

/**
 * A one-line status bar for the current recall state. Empty string when
 * idle (the integrator hides the row entirely in that case). While
 * cycling, shows a compact `(history N/M)` indicator. While searching,
 * mirrors the familiar `(reverse-i-search)`query': matched-text` shape, or
 * an honest `(failed reverse-i-search)`query': ` when nothing matches.
 * Stored text is sanitized (control chars / ANSI / CR replaced with
 * U+FFFD) before display so a hostile past entry cannot corrupt the
 * terminal, and the whole line is truncated to `width` code points.
 */
export function renderRecallBar(state: RecallState, entries: readonly RecallEntry[], width: number): string {
  if (state.mode === "idle") return "";

  if (state.mode === "cycling") {
    const total = entries.length;
    const position = total === 0 ? 0 : entries.length - state.index;
    const text = state.index >= 0 && state.index < entries.length ? sanitizeForDisplay(entries[state.index]!.text) : "";
    return truncateCps(`(history ${position}/${total}) ${text}`, width);
  }

  // search
  const query = sanitizeForDisplay(state.query);
  if (state.matchIndex < 0 || state.index < 0 || state.index >= entries.length) {
    return truncateCps(`(failed reverse-i-search)\`${query}': `, width);
  }
  const matched = sanitizeForDisplay(entries[state.index]!.text);
  return truncateCps(`(reverse-i-search)\`${query}': ${matched}`, width);
}
