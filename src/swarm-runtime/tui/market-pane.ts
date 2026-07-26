/**
 * market-pane.ts — pure, deterministic MARKET pane for the interactive TUI
 * (`hades tui`).
 *
 * Renders the verified-work economy's live state: every participant's
 * standing, balance, escrow and MEASURED reputation, plus the market-wide
 * treasury, settlement count, fabrication count and the reputation ledger's
 * hash-chain verdict.
 *
 * Every function here is a pure string-in/string-out or state-in/state-out
 * transform: no I/O, no timers, no ANSI escapes, no `Date.now()`, no
 * randomness, and no imports from `src/hades/**` or anywhere outside this
 * file's own declarations. Data arrives as plain JSON-compatible rows the
 * orchestrator populates directly from `marketStatus()`
 * (`src/hades/market/wiring.ts`) — a STRUCTURAL, not import, match, exactly
 * how `trust-gate-pane.ts` and `skill-trust-pane.ts` match their hades-side
 * producers with zero adapter code.
 *
 * Visual conventions match `trust-gate-pane.ts` / `render.ts`: `╭─╮ │ ├ ┤ ╰─╯`
 * box drawing, a default width of 72 code points, and a hard clamp — no line
 * this module emits ever exceeds the requested width. Width is measured in
 * Unicode code points (via `[...s].length`) so multi-byte text never
 * desyncs the border.
 *
 * Honesty discipline (this pane reports on a market whose whole point is
 * catching liars — it must never let a lie render as a clean row):
 *  - Every number prints verbatim from the row. This module never derives,
 *    sums, or invents a metric of its own.
 *  - `scoreDefined: false` renders the score cell as `—` and the note
 *    "not scoreable yet: no outcome variance", NEVER `0.000`. A Brier SKILL
 *    score is mathematically undefined until a participant has both a pass
 *    and a fail on record, and printing a zero there would read as "scored
 *    terribly" when the truth is "no measurement exists".
 *  - Any participant with `fabricatedN > 0` renders a full-width `FABRICATED`
 *    alert line regardless of how good every other cell looks — a proven
 *    fabrication is not something a good balance gets to average away.
 *  - A FAILED reputation chain renders as a full-width alert, because the
 *    persisted ledger is REFUSED in that state and every number on screen
 *    would otherwise be unfounded.
 *  - An install with no trusted issuer renders "NO TRUSTED ISSUER", because
 *    every certificate would be rejected and an empty fabrication count
 *    would otherwise read as "nobody has ever cheated".
 *  - Free text (`id`, `kind`, `standing`) is run through a local `sanitize`
 *    that strips C0/C1 control characters and ESC before it is ever laid
 *    into a rendered line, so no upstream data can inject cursor moves,
 *    colour codes, or terminal-clear sequences into the pane.
 */

// ---------------------------------------------------------------------------
// Row/state shapes (plain, JSON-compatible — no imports from src/hades/**)
// ---------------------------------------------------------------------------

/**
 * One market participant.
 *
 * Structural match for `MarketParticipantView` (`src/hades/market/wiring.ts`)
 * and `MarketParticipantWire` (`src/desktop/ipc/market-contract.ts`): `id`,
 * `kind`, `standing`, `balance`, `escrowed`, `score`, `scoreDefined`, `n`,
 * `passRate`, `brier`, `settledN` and `fabricatedN` line up field for field.
 */
export interface MarketPaneParticipantRow {
  id: string;
  kind: string;
  /** `active` | `probation` | `demoted` | `banned`. */
  standing: string;
  balance: number;
  escrowed: number;
  /** Null when the participant has no recorded reputation events at all. */
  score: number | null;
  /** False when the Brier SKILL score is mathematically undefined. */
  scoreDefined: boolean;
  n: number;
  passRate: number | null;
  brier: number | null;
  settledN: number;
  fabricatedN: number;
}

/** Market-wide totals, structurally matching `MarketStatusView`. */
export interface MarketPaneSummary {
  treasury: number;
  totalTokens: number;
  openAwards: number;
  settlements: number;
  fabrications: number;
  certificatesSpent: number;
  /** False when the persisted reputation chain did not re-verify. */
  chainOk: boolean;
  /** Empty string when this install has no trust-gate identity yet. */
  issuerPublicKeyHex: string;
}

export interface MarketPaneState {
  rows: MarketPaneParticipantRow[];
  summary: MarketPaneSummary | null;
  selected: number;
  showDetail: boolean;
}

export const DEFAULT_WIDTH = 72;

export function initMarketPane(
  rows: readonly MarketPaneParticipantRow[],
  summary: MarketPaneSummary | null = null,
): MarketPaneState {
  return { rows: [...rows], summary, selected: 0, showDetail: false };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Strip C0/C1 control characters and ESC so upstream text cannot inject
 *  cursor moves, colour codes or terminal-clear sequences into the pane. */
function sanitize(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

function width(s: string): number {
  return [...s].length;
}

function clamp(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join("");
  return chars.slice(0, max - 1).join("") + "…";
}

function padTo(s: string, w: number): string {
  const len = width(s);
  return len >= w ? clamp(s, w) : s + " ".repeat(w - len);
}

function fixed(n: number | null, digits: number): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

/**
 * The score cell. `—` (never `0.000`) whenever the skill score is undefined
 * — see the honesty discipline in the module header.
 */
export function scoreCell(row: MarketPaneParticipantRow): string {
  if (!row.scoreDefined || row.score === null || !Number.isFinite(row.score)) return "—";
  return row.score.toFixed(3);
}

/**
 * The one-line consequence for a participant, in the pane's own words. This
 * is the field that must never let a proven fabricator read as a normal row.
 */
export function participantNote(row: MarketPaneParticipantRow): string {
  if (row.fabricatedN > 0) {
    return `FABRICATED x${row.fabricatedN}: banned, stake slashed, score forced to 0`;
  }
  if (row.standing === "banned") return "banned: cannot be awarded work";
  if (row.standing === "demoted") return "demoted: reduced ceiling, multiplied stake";
  if (row.standing === "probation") return "probation: earning back standing";
  if (row.n === 0) return "no settled work yet";
  if (!row.scoreDefined) return "not scoreable yet: no outcome variance";
  if (row.score !== null && row.score >= 0.5) return "active: measured skill above the pool";
  return "active: measured, low skill score";
}

function clampSelection(state: MarketPaneState, next: number): number {
  if (state.rows.length === 0) return 0;
  if (next < 0) return 0;
  if (next >= state.rows.length) return state.rows.length - 1;
  return next;
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

/**
 * Advance pane state for one key. Unknown keys return the SAME state object
 * (referential equality), so a caller can cheaply skip a re-render.
 *
 *  - `j` / `down`  — next participant
 *  - `k` / `up`    — previous participant
 *  - `g` / `home`  — first participant
 *  - `G` / `end`   — last participant
 *  - `enter` / `l` — toggle the detail block for the selected participant
 *  - `escape`      — close the detail block
 */
export function marketPaneKey(state: MarketPaneState, key: string): MarketPaneState {
  switch (key) {
    case "j":
    case "down": {
      const selected = clampSelection(state, state.selected + 1);
      return selected === state.selected ? state : { ...state, selected };
    }
    case "k":
    case "up": {
      const selected = clampSelection(state, state.selected - 1);
      return selected === state.selected ? state : { ...state, selected };
    }
    case "g":
    case "home": {
      const selected = clampSelection(state, 0);
      return selected === state.selected ? state : { ...state, selected };
    }
    case "G":
    case "end": {
      const selected = clampSelection(state, state.rows.length - 1);
      return selected === state.selected ? state : { ...state, selected };
    }
    case "enter":
    case "l":
      return { ...state, showDetail: !state.showDetail };
    case "escape":
      return state.showDetail ? { ...state, showDetail: false } : state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function border(kind: "top" | "mid" | "bottom", w: number): string {
  const inner = "─".repeat(Math.max(0, w - 2));
  if (kind === "top") return `╭${inner}╮`;
  if (kind === "bottom") return `╰${inner}╯`;
  return `├${inner}┤`;
}

function row(content: string, w: number): string {
  const inner = Math.max(0, w - 4);
  return `│ ${padTo(clamp(sanitize(content), inner), inner)} │`;
}

/**
 * Render the pane. Never exceeds `width` code points on any line, and always
 * renders an explicit line for the empty case rather than a bare box.
 */
export function renderMarketPane(state: MarketPaneState, w = DEFAULT_WIDTH): string[] {
  const paneWidth = Math.max(24, Math.floor(w));
  const lines: string[] = [];
  lines.push(border("top", paneWidth));
  lines.push(row("MARKET", paneWidth));
  lines.push(border("mid", paneWidth));

  if (state.rows.length === 0) {
    lines.push(row("no market participants registered", paneWidth));
    if (state.summary !== null) {
      lines.push(border("mid", paneWidth));
      lines.push(...summaryLines(state.summary, paneWidth));
    }
    lines.push(border("bottom", paneWidth));
    return lines;
  }

  const header =
    padTo("PARTICIPANT", 16) +
    padTo("STANDING", 10) +
    padTo("BAL", 9) +
    padTo("ESC", 8) +
    padTo("N", 4) +
    padTo("SCORE", 7) +
    "FAB";
  lines.push(row(header, paneWidth));

  const selected = clampSelection(state, state.selected);
  for (let i = 0; i < state.rows.length; i++) {
    const r = state.rows[i];
    const marker = i === selected ? "›" : " ";
    const line =
      padTo(`${marker}${sanitize(r.id)}`, 16) +
      padTo(sanitize(r.standing), 10) +
      padTo(r.balance.toFixed(2), 9) +
      padTo(r.escrowed.toFixed(2), 8) +
      padTo(String(r.n), 4) +
      padTo(scoreCell(r), 7) +
      String(r.fabricatedN);
    lines.push(row(line, paneWidth));
  }

  lines.push(border("mid", paneWidth));
  for (const r of state.rows) {
    lines.push(row(`${padTo(sanitize(r.id), 16)} ${participantNote(r)}`, paneWidth));
  }

  if (state.showDetail) {
    const r = state.rows[selected];
    lines.push(border("mid", paneWidth));
    lines.push(row(`DETAIL  ${sanitize(r.id)}`, paneWidth));
    lines.push(row(`  kind                  ${sanitize(r.kind)}`, paneWidth));
    lines.push(row(`  standing              ${sanitize(r.standing)}`, paneWidth));
    lines.push(row(`  balance / escrow      ${r.balance.toFixed(4)} / ${r.escrowed.toFixed(4)}`, paneWidth));
    lines.push(row(`  reputation events     ${r.n}`, paneWidth));
    lines.push(row(`  settled / fabricated  ${r.settledN} / ${r.fabricatedN}`, paneWidth));
    lines.push(row(`  brier                 ${fixed(r.brier, 4)}`, paneWidth));
    lines.push(row(`  pass rate             ${fixed(r.passRate, 4)}`, paneWidth));
    lines.push(row(`  skill score           ${scoreCell(r)}`, paneWidth));
    lines.push(row(`  consequence           ${participantNote(r)}`, paneWidth));
  }

  if (state.summary !== null) {
    lines.push(border("mid", paneWidth));
    lines.push(...summaryLines(state.summary, paneWidth));
  }

  lines.push(border("bottom", paneWidth));
  return lines;
}

function summaryLines(s: MarketPaneSummary, paneWidth: number): string[] {
  const out: string[] = [];
  out.push(
    row(
      `TREASURY ${s.treasury.toFixed(2)} / ${s.totalTokens.toFixed(2)} tokens  ` +
        `${s.openAwards} open award${s.openAwards === 1 ? "" : "s"}`,
      paneWidth,
    ),
  );
  out.push(
    row(
      `SETTLED  ${s.settlements}  fabrications ${s.fabrications}  ` +
        `certificates spent ${s.certificatesSpent}`,
      paneWidth,
    ),
  );
  out.push(
    row(
      s.chainOk
        ? "CHAIN    verified from its own bytes"
        : // Deliberately short enough to survive the DEFAULT_WIDTH clamp
          // intact: a truncated integrity alert is a defeated one.
          "CHAIN    FAILED — persisted ledger REFUSED, numbers unfounded",
      paneWidth,
    ),
  );
  if (s.issuerPublicKeyHex.length === 0) {
    out.push(row("ISSUER   NO TRUSTED ISSUER — every certificate would be rejected", paneWidth));
  }
  return out;
}
