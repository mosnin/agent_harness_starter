/**
 * Slash-command autocomplete for the TUI's compose mode: a deterministic
 * ranked-fuzzy suggestion engine plus a pure popup renderer, driven by a
 * typed spec list (`TUI_COMMAND_SPECS`) that mirrors the TUI's real command
 * surface. Every `SlashIntent` this module can produce maps 1:1 onto an
 * existing `TuiApp`/`TuiController` capability (see `./app.ts`) or one of
 * this cycle's new panes — inventing an intent with no real target is not
 * something this module does.
 *
 * Pure module: no I/O, no clock, no `src/hades/**` imports. `CommandSpec`
 * is declared locally with the shape `{ name, summary, usage? }`-compatible
 * fields (`name`, `summary`, optional `argHint`) so central wiring can later
 * map this list onto `src/hades/repl/commands.ts`'s `SlashCommand` registry
 * (`{ name, description, aliases? }`) without this module importing it.
 *
 * ── Ranking (deterministic, see `classifyTier`) ─────────────────────────
 * Tier 0: exact name match (case-insensitive)
 * Tier 1: exact alias match
 * Tier 2: name is a prefix of the query's match... no — query is a prefix
 *         of the name (typing "sc" suggests "schedule")
 * Tier 3: query is a prefix of an alias
 * Tier 4: word-boundary subsequence — every query character matches, in
 *         order, the first letter of a "word" segment of the name or an
 *         alias (segments split on non-alphanumeric runs), e.g. "su"
 *         against "scale-up" (s of "scale", u of "up")
 * Tier 5: plain subsequence — every query character matches, in order,
 *         somewhere in the name or an alias
 * An empty query (bare "/") is treated as tier 2 for every spec, so a lone
 * "/" opens the full command list. Ties within a tier are broken
 * lexicographically by `spec.name` (plain ordinal comparison, not
 * locale-aware, so the order never depends on the runtime's locale).
 * `matchedIndices` always indexes into `spec.name` (never an alias): it is
 * the best-effort subsequence alignment of the query inside the name,
 * computed independently of which tier actually produced the match, so a
 * match found only via an alias can legitimately report `matchedIndices: []`
 * when the query shares no subsequence with the name itself.
 *
 * ── Buffer parsing ───────────────────────────────────────────────────────
 * Only the buffer's first line is ever considered (a multiline compose
 * buffer is common once someone starts typing a goal with newlines). The
 * engine is active only when that first line starts with "/". Everything
 * after the "/" up to the first whitespace run is the match "token"; the
 * remainder (whitespace-trimmed at the boundary only, so internal spacing
 * is preserved byte-for-byte) is carried as trailing text and re-attached
 * verbatim on accept, so "/go stuff" completing to "/goal" yields
 * "/goal stuff", not "/goal" (dropping what was already typed).
 *
 * ── Key handling precedence (integrator contract) ───────────────────────
 * `acKey` only ever acts when `state.open` is true; when the popup is
 * closed it always returns `{ state, effect: null }` unchanged for every
 * key, Esc included. That is deliberate: the integrator (`TuiApp`'s compose
 * handling) must call `acKey` first, and only fall back to its own default
 * key handling (e.g. Esc -> compose-cancel) when `acKey` reports
 * `effect: null`. When the popup IS open, Esc is consumed here (it closes
 * the popup via `{ kind: "dismiss" }`) and must NOT also cancel compose —
 * that second Esc press is what cancels compose. This mirrors ordinary
 * terminal-UI autocomplete behavior (first Esc closes the suggestions,
 * second Esc backs out of the input).
 */

/** Structurally compatible with `src/hades/repl/commands.ts`'s `SlashCommand`
 *  (`{ name, description, aliases? }`) without importing it — `summary` here
 *  is that command's `description`, and `usage` there maps onto `argHint`
 *  here. Declared locally per this module's no-`src/hades/**`-imports rule. */
export interface CommandSpec {
  name: string;
  summary: string;
  argHint?: string;
  aliases?: string[];
  intent: SlashIntent;
}

/** The locked vocabulary of things a slash command can ask the TUI to do.
 *  Every member maps onto a real `TuiApp`/`TuiController` capability (see
 *  `./app.ts`) or a pane shipped this cycle — never invent a new kind here
 *  without a real target behind it. */
export type SlashIntent =
  | { kind: "dispatch-goal" }
  | { kind: "scale"; delta: 1 | -1 }
  | { kind: "cancel" }
  | {
      kind: "open-pane";
      pane: "fleet" | "showdown" | "gateway" | "schedule" | "trust" | "history" | "verify" | "stream";
    }
  | { kind: "toggle-help" }
  | { kind: "quit" }
  | { kind: "interrupt" };

/** The TUI's real slash-command surface. Exactly the fifteen commands this
 *  cycle's compose-mode autocomplete supports; aliases are chosen so none
 *  collide with each other within this list (collision handling itself is
 *  exercised against synthetic adversarial spec sets in the test suite). */
export const TUI_COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: "goal",
    summary: "Start a new goal (enter compose mode)",
    aliases: ["g"],
    intent: { kind: "dispatch-goal" },
  },
  {
    name: "scale-up",
    summary: "Scale the worker pool up by one",
    aliases: ["su"],
    intent: { kind: "scale", delta: 1 },
  },
  {
    name: "scale-down",
    summary: "Scale the worker pool down by one",
    aliases: ["sdn"],
    intent: { kind: "scale", delta: -1 },
  },
  {
    name: "cancel",
    summary: "Cancel the active goal",
    aliases: ["c"],
    intent: { kind: "cancel" },
  },
  {
    name: "fleet",
    summary: "Open the FLEET pane (backends / workers / routing bandit)",
    aliases: ["f"],
    intent: { kind: "open-pane", pane: "fleet" },
  },
  {
    name: "showdown",
    summary: "Open the SHOWDOWN pane (swarm vs baseline V-TPH$)",
    aliases: ["sh"],
    intent: { kind: "open-pane", pane: "showdown" },
  },
  {
    name: "gateway",
    summary: "Open the GATEWAY pane (probes / engine / traffic / badges)",
    aliases: ["gw"],
    intent: { kind: "open-pane", pane: "gateway" },
  },
  {
    name: "schedule",
    summary: "Open the SCHEDULE pane (cron jobs / runs / outcome tally)",
    aliases: ["sched"],
    intent: { kind: "open-pane", pane: "schedule" },
  },
  {
    name: "trust",
    summary: "Open the SKILLS/TRUST pane (per-skill trust + calibration)",
    aliases: ["tr"],
    intent: { kind: "open-pane", pane: "trust" },
  },
  {
    name: "history",
    summary: "Open the HISTORY pane (past goals and their outcomes)",
    aliases: ["hist"],
    intent: { kind: "open-pane", pane: "history" },
  },
  {
    name: "verify",
    summary: "Open the VERIFY pane (STYX verification swarm detail)",
    aliases: ["v"],
    intent: { kind: "open-pane", pane: "verify" },
  },
  {
    name: "stream",
    summary: "Open the STREAM pane (live worker output tail)",
    aliases: ["st"],
    intent: { kind: "open-pane", pane: "stream" },
  },
  {
    name: "help",
    summary: "Toggle the help overlay",
    aliases: ["?"],
    intent: { kind: "toggle-help" },
  },
  {
    name: "quit",
    summary: "Quit the TUI",
    aliases: ["q"],
    intent: { kind: "quit" },
  },
  {
    name: "interrupt",
    summary: "Interrupt the current worker step",
    aliases: ["int", "i"],
    intent: { kind: "interrupt" },
  },
];

/** One ranked suggestion. `matchedIndices` always indexes into `spec.name`
 *  (see the module docstring for why an alias-only match can report `[]`). */
export interface Match {
  spec: CommandSpec;
  score: number;
  matchedIndices: number[];
}

/** Compose-mode autocomplete popup state. */
export interface AcState {
  open: boolean;
  query: string;
  selected: number;
  matches: Match[];
}

/** What a keypress asked the integrator to do, if anything. */
export type AcEffect =
  | { kind: "accept"; completed: string; spec: CommandSpec }
  | { kind: "dismiss" }
  | null;

const MAX_MATCHES = 8;

/** Score assigned to each tier (0 = best); higher score sorts first. Tiers
 *  are spaced widely apart so tier ordering always dominates any future
 *  within-tier tiebreak, without ties across tiers ever being possible. */
const TIER_SCORE: readonly number[] = [600, 500, 400, 300, 200, 100];

/* ----------------------------------------------------------------------------
 * Buffer parsing
 * ------------------------------------------------------------------------- */

interface ParsedBuffer {
  active: boolean;
  /** Everything after the leading "/" on the first line (token + trailing). */
  queryFull: string;
}

/** Only the first line of the buffer is ever significant. */
function firstLine(buffer: string): string {
  const nl = buffer.indexOf("\n");
  return nl === -1 ? buffer : buffer.slice(0, nl);
}

function parseBuffer(buffer: string): ParsedBuffer {
  const line = firstLine(buffer);
  if (!line.startsWith("/")) return { active: false, queryFull: "" };
  return { active: true, queryFull: line.slice(1) };
}

/** Split the post-"/" text into the match token and preserved trailing text
 *  (leading whitespace between them is dropped; everything after that is
 *  kept exactly as typed). */
function splitQuery(queryFull: string): { token: string; trailing: string } {
  const wsIdx = queryFull.search(/\s/);
  if (wsIdx === -1) return { token: queryFull, trailing: "" };
  const token = queryFull.slice(0, wsIdx);
  const trailing = queryFull.slice(wsIdx).replace(/^\s+/, "");
  return { token, trailing };
}

/* ----------------------------------------------------------------------------
 * Matching primitives
 * ------------------------------------------------------------------------- */

/** Indices (into `haystack`) of a leftmost-greedy subsequence match of
 *  `needle`, or `null` if `needle` isn't a subsequence of `haystack`. An
 *  empty `needle` trivially matches with zero indices. */
function subsequenceIndices(haystack: string, needle: string): number[] | null {
  if (needle.length === 0) return [];
  const indices: number[] = [];
  let ni = 0;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    if (haystack[hi] === needle[ni]) {
      indices.push(hi);
      ni++;
    }
  }
  return ni === needle.length ? indices : null;
}

/** Index of every "word" start in `s` — position 0, and any alphanumeric
 *  character immediately preceded by a non-alphanumeric one (or nothing). */
function wordBoundaryIndices(s: string): number[] {
  const isAlnum = (c: string) => /[a-z0-9]/i.test(c);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (!isAlnum(s[i])) continue;
    if (i === 0 || !isAlnum(s[i - 1])) out.push(i);
  }
  return out;
}

/** Indices of a leftmost-greedy match of `needle` against `haystack`'s word
 *  boundaries only (acronym-style, e.g. "su" -> "scale-up"), or `null`. */
function wordBoundarySubsequenceIndices(haystack: string, needle: string): number[] | null {
  if (needle.length === 0) return [];
  const boundaries = wordBoundaryIndices(haystack);
  const indices: number[] = [];
  let ni = 0;
  for (const bi of boundaries) {
    if (ni >= needle.length) break;
    if (haystack[bi] === needle[ni]) {
      indices.push(bi);
      ni++;
    }
  }
  return ni === needle.length ? indices : null;
}

/** Classify how (if at all) `spec` matches the lowercased `q`. Returns the
 *  tier number (0 best .. 5 worst) or `null` for no match at all. */
function classifyTier(spec: CommandSpec, q: string): number | null {
  if (q.length === 0) return 2;

  const name = spec.name.toLowerCase();
  const aliases = (spec.aliases ?? []).map((a) => a.toLowerCase());

  if (name === q) return 0;
  if (aliases.includes(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (aliases.some((a) => a.startsWith(q))) return 3;

  const candidates = [name, ...aliases];
  if (candidates.some((c) => wordBoundarySubsequenceIndices(c, q) !== null)) return 4;
  if (candidates.some((c) => subsequenceIndices(c, q) !== null)) return 5;

  return null;
}

function compareMatches(a: Match, b: Match): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.spec.name < b.spec.name) return -1;
  if (a.spec.name > b.spec.name) return 1;
  return 0;
}

function rankMatches(specs: readonly CommandSpec[], token: string): Match[] {
  const q = token.toLowerCase();
  const matches: Match[] = [];
  for (const spec of specs) {
    const tier = classifyTier(spec, q);
    if (tier === null) continue;
    const name = spec.name.toLowerCase();
    const matchedIndices = q.length === 0 ? [] : subsequenceIndices(name, q) ?? [];
    matches.push({ spec, score: TIER_SCORE[tier], matchedIndices });
  }
  matches.sort(compareMatches);
  return matches.slice(0, MAX_MATCHES);
}

/**
 * Rank `specs` against `buffer`. Active (non-empty result possible) only
 * when the buffer's first line starts with "/" — otherwise always `[]`.
 * Deterministic and total: identical inputs always produce an
 * array-identical (deep-equal) result, never more than 8 entries, sorted
 * per the tier scheme documented at the top of this module.
 */
export function suggest(specs: readonly CommandSpec[], buffer: string): Match[] {
  const parsed = parseBuffer(buffer);
  if (!parsed.active) return [];
  const { token } = splitQuery(parsed.queryFull);
  return rankMatches(specs, token);
}

/* ----------------------------------------------------------------------------
 * Popup state machine
 * ------------------------------------------------------------------------- */

export function acInit(): AcState {
  return { open: false, query: "", selected: 0, matches: [] };
}

function clampIndex(i: number, length: number): number {
  if (length <= 0) return 0;
  if (i < 0) return 0;
  if (i > length - 1) return length - 1;
  return i;
}

/**
 * Recompute matches for the current buffer. Closes (honest empty state,
 * `matches: []`) whenever the buffer no longer has a leading "/" on its
 * first line, or when nothing matches. The selection resets to 0 whenever
 * the query text actually changed since the last state (a fresh keystroke
 * narrowing/widening the list); it is preserved (clamped to the new match
 * count) when the query is unchanged, e.g. a re-render with the same buffer.
 */
export function acUpdate(state: AcState, specs: readonly CommandSpec[], buffer: string): AcState {
  const parsed = parseBuffer(buffer);
  if (!parsed.active) return acInit();

  const matches = suggest(specs, buffer);
  if (matches.length === 0) {
    return { open: false, query: parsed.queryFull, selected: 0, matches: [] };
  }

  const selected =
    state.open && state.query === parsed.queryFull
      ? clampIndex(state.selected, matches.length)
      : 0;

  return { open: true, query: parsed.queryFull, selected, matches };
}

const TAB_KEYS = new Set(["\t", "tab"]);
const SHIFT_TAB_KEYS = new Set(["\x1b[Z", "shift-tab"]);
const UP_KEYS = new Set(["\x1b[A", "up"]);
const DOWN_KEYS = new Set(["\x1b[B", "down"]);
const ENTER_KEYS = new Set(["\r", "\n", "return", "enter"]);
const ESC_KEYS = new Set(["\x1b", "escape"]);

function cycle(state: AcState, dir: 1 | -1): AcState {
  const n = state.matches.length;
  if (n === 0) return state;
  const selected = (state.selected + dir + n) % n;
  return { ...state, selected };
}

function acceptCurrent(state: AcState): { state: AcState; effect: AcEffect } {
  const match = state.matches[state.selected];
  const { trailing } = splitQuery(state.query);
  const completed = `/${match.spec.name} ${trailing}`;
  return { state: acInit(), effect: { kind: "accept", completed, spec: match.spec } };
}

/**
 * Advance the popup one keypress. See the module docstring for the Esc
 * fallthrough precedence contract — this function is a no-op (`effect:
 * null`, state unchanged) whenever the popup is closed, for every key
 * including Esc, so the integrator's own default key handling can take
 * over. When open:
 *  - Enter always accepts the currently-selected match.
 *  - Tab cycles forward, except when there is exactly one match, where it
 *    accepts directly (cycling forward through a single match would
 *    otherwise be an inert no-op key press).
 *  - Shift-Tab ("\x1b[Z") and Up/Down cycle backward/forward, wrapping.
 *  - Esc dismisses (closes the popup) without accepting anything.
 */
export function acKey(state: AcState, key: string): { state: AcState; effect: AcEffect } {
  if (!state.open || state.matches.length === 0) {
    return { state, effect: null };
  }

  if (ESC_KEYS.has(key)) {
    return { state: acInit(), effect: { kind: "dismiss" } };
  }
  if (ENTER_KEYS.has(key)) {
    return acceptCurrent(state);
  }
  if (TAB_KEYS.has(key)) {
    if (state.matches.length === 1) return acceptCurrent(state);
    return { state: cycle(state, 1), effect: null };
  }
  if (SHIFT_TAB_KEYS.has(key)) {
    return { state: cycle(state, -1), effect: null };
  }
  if (DOWN_KEYS.has(key)) {
    return { state: cycle(state, 1), effect: null };
  }
  if (UP_KEYS.has(key)) {
    return { state: cycle(state, -1), effect: null };
  }

  return { state, effect: null };
}

/* ----------------------------------------------------------------------------
 * Popup rendering
 * ------------------------------------------------------------------------- */

/** Pad or truncate (with a trailing "…") so the result is exactly `w` code
 *  points (astral-safe). Mirrors `panes.ts`'s `fit` — duplicated locally so
 *  this module stays a self-contained, dependency-free unit. */
function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const cps = [...s];
  if (cps.length === w) return s;
  if (cps.length < w) return s + " ".repeat(w - cps.length);
  if (w === 1) return "…";
  return cps.slice(0, w - 1).join("") + "…";
}

/** Wrap each contiguous run of `indices` within `name` in `*`, e.g.
 *  `markMatches("showdown", [0, 1])` -> `"*sh*owdown"`. Plain ASCII marking
 *  (no ANSI escapes) so it stays assertable as ordinary text. */
function markMatches(name: string, indices: number[]): string {
  if (indices.length === 0) return name;
  const marked = new Set(indices);
  let out = "";
  let inRun = false;
  for (let i = 0; i < name.length; i++) {
    const hit = marked.has(i);
    if (hit && !inRun) {
      out += "*";
      inRun = true;
    } else if (!hit && inRun) {
      out += "*";
      inRun = false;
    }
    out += name[i];
  }
  if (inRun) out += "*";
  return out;
}

/**
 * Render the popup as an array of plain-text rows, each exactly `width`
 * code points wide (padded or ellipsis-truncated — never longer, never
 * shorter). Returns `[]` when the popup is closed or has no matches: an
 * honestly absent popup, not an empty box. Each row is one match: a
 * selection marker, the command name with matched characters wrapped in
 * `*asterisks*`, its `argHint` if any, and its summary.
 */
export function renderAutocomplete(state: AcState, width: number): string[] {
  if (!state.open || state.matches.length === 0) return [];

  return state.matches.map((m, i) => {
    const marker = i === state.selected ? "▶" : " ";
    const label = markMatches(m.spec.name, m.matchedIndices);
    let text = `${marker} /${label}`;
    if (m.spec.argHint) text += ` ${m.spec.argHint}`;
    text += `  — ${m.spec.summary}`;
    return fit(text, width);
  });
}
