/**
 * trust-gate-pane.ts — pure, deterministic TRUST GATE pane for the
 * interactive TUI (`hades tui`).
 *
 * Renders the unified trust gate's live state: which domains are calibrated,
 * on how many REAL labeled observations, at what conformal threshold, with
 * what correct-vs-wrong separation — plus the hash-chained trust budget's
 * remaining risk mass and its independent chain verdict.
 *
 * Every function here is a pure string-in/string-out or state-in/state-out
 * transform: no I/O, no timers, no ANSI escapes, no `Date.now()`, no
 * randomness, and no imports from `src/hades/**` or anywhere outside this
 * file's own declarations. Data arrives as plain JSON-compatible rows the
 * orchestrator populates directly from `trustDomainStatuses()` +
 * `TrustBudgetLedger.report()`/`.verifyChain()` output — a STRUCTURAL, not
 * import, match, exactly how `schedule-pane.ts` and `skill-trust-pane.ts`
 * match their hades-side producers with zero adapter code.
 *
 * Visual conventions match `schedule-pane.ts` / `skill-trust-pane.ts` /
 * `render.ts`: `╭─╮ │ ├ ┤ ╰─╯` box drawing, a default width of 72 code
 * points, and a hard clamp — no line this module emits ever exceeds the
 * requested width. Width is measured in Unicode code points (via
 * `[...s].length`) so multi-byte text never desyncs the border.
 *
 * Honesty discipline (this pane exists to report a gate that often, and
 * correctly, refuses to certify anything — it must never make that look like
 * success):
 *  - Every number prints verbatim from the row. This module never derives,
 *    sums, or invents a metric of its own.
 *  - An UNCALIBRATED domain renders "uncalibrated" and the explicit
 *    consequence "abstains", never a blank cell a reader could skim past.
 *  - A calibrated domain whose threshold admits nothing renders `+Inf` and
 *    "abstains: nothing clears", never a tidy number implying it works.
 *  - A calibrated domain whose `auc` is at or below 0.55 is flagged
 *    "NO SEPARATION" regardless of how confident the threshold looks: a
 *    threshold fitted on scores that do not separate correct from wrong is a
 *    threshold that means nothing, and the pane says so.
 *  - `auc` prints to 4 decimals when non-null, or "—" when `null` — never
 *    the literal string "null" or "NaN".
 *  - A FAILED budget chain renders as a full-width alert line, because the
 *    ledger refuses to authorize further spending in that state.
 *  - Free text (`domain`, `note`) is run through a local `sanitize` that
 *    strips C0/C1 control characters and ESC before it is ever laid into a
 *    rendered line, so no upstream data can inject cursor moves, color
 *    codes, or terminal-clear sequences into the pane.
 */

// ---------------------------------------------------------------------------
// Row/state shapes (plain, JSON-compatible — no imports from src/hades/**)
// ---------------------------------------------------------------------------

/**
 * One trust domain's calibration state.
 *
 * Structural match for `TrustDomainStatus` (`src/hades/trust/wiring.ts`)
 * flattened with the domain's verifier count and the rank AUC from
 * `summarizeDiscrimination()`: `domain`, `verifiers`, `calibrated`,
 * `points`, `threshold`, `epsilon`, `auc` line up field for field.
 */
export interface TrustGatePaneDomainRow {
  domain: string;
  verifiers: number;
  calibrated: boolean;
  /** Number of REAL labeled (score, correct) observations backing the fit. */
  points: number;
  /** `null` when uncalibrated; use `Infinity` for an admit-nothing threshold. */
  threshold: number | null;
  epsilon: number | null;
  /** Rank AUC of correct-vs-wrong, or `null` when one class is empty. */
  auc: number | null;
  /** Admissions and abstentions recorded by the gate this session. */
  admitted: number;
  abstained: number;
}

/** The hash-chained trust budget's live accounting. */
export interface TrustGatePaneBudget {
  totalRisk: number;
  spentRisk: number;
  remainingRisk: number;
  exhausted: boolean;
  entries: number;
  chainOk: boolean;
  /** Real reason from `ChainVerification` when `chainOk` is false. */
  chainReason?: string;
}

export interface TrustGatePaneState {
  rows: readonly TrustGatePaneDomainRow[];
  budget: TrustGatePaneBudget | null;
  /** Index of the highlighted row; clamped into range on every transition. */
  selected: number;
  /** When true, the selected domain's detail block is shown. */
  showDetail: boolean;
}

export const DEFAULT_WIDTH = 72;

/**
 * At or below this AUC the pane declares NO SEPARATION. 0.5 is chance; the
 * small margin above it keeps sampling noise on a handful of points from
 * reading as real signal.
 */
export const SEPARATION_FLOOR = 0.55;

export function initTrustGatePane(
  rows: readonly TrustGatePaneDomainRow[],
  budget: TrustGatePaneBudget | null = null,
): TrustGatePaneState {
  return { rows: [...rows], budget, selected: 0, showDetail: false };
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

/** `+Inf` for a threshold that admits nothing; `—` when uncalibrated. */
function thresholdCell(threshold: number | null): string {
  if (threshold === null) return "—";
  if (!Number.isFinite(threshold)) return "+Inf";
  return threshold.toFixed(4);
}

/**
 * The one-line consequence for a domain, in the pane's own words. This is
 * the field that must never let an abstaining gate read as a working one.
 */
export function domainNote(row: TrustGatePaneDomainRow): string {
  if (!row.calibrated) return "uncalibrated: abstains";
  if (row.threshold === null || !Number.isFinite(row.threshold)) return "abstains: nothing clears";
  if (row.auc === null) return "one-class sample: bound untested";
  if (row.auc <= SEPARATION_FLOOR) return "NO SEPARATION: threshold is meaningless";
  if (row.auc >= 0.9) return "strong separation";
  if (row.auc >= 0.7) return "usable separation";
  return "weak separation";
}

function clampSelection(state: TrustGatePaneState, next: number): number {
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
 *  - `j` / `down`  — next domain
 *  - `k` / `up`    — previous domain
 *  - `g` / `home`  — first domain
 *  - `G` / `end`   — last domain
 *  - `enter` / `l` — toggle the detail block for the selected domain
 *  - `escape`      — close the detail block
 */
export function trustGatePaneKey(state: TrustGatePaneState, key: string): TrustGatePaneState {
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
    case "home":
      return state.selected === 0 ? state : { ...state, selected: 0 };
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
export function renderTrustGatePane(state: TrustGatePaneState, w = DEFAULT_WIDTH): string[] {
  const paneWidth = Math.max(24, Math.floor(w));
  const lines: string[] = [];
  lines.push(border("top", paneWidth));
  lines.push(row("TRUST GATE", paneWidth));
  lines.push(border("mid", paneWidth));

  if (state.rows.length === 0) {
    lines.push(row("no trust domains reported", paneWidth));
    lines.push(border("bottom", paneWidth));
    return lines;
  }

  const header =
    padTo("DOMAIN", 10) +
    padTo("VER", 4) +
    padTo("PTS", 5) +
    padTo("THRESH", 8) +
    padTo("AUC", 7) +
    padTo("ADM", 5) +
    "ABST";
  lines.push(row(header, paneWidth));

  const selected = clampSelection(state, state.selected);
  for (let i = 0; i < state.rows.length; i++) {
    const r = state.rows[i];
    const marker = i === selected ? "›" : " ";
    const line =
      padTo(`${marker}${sanitize(r.domain)}`, 10) +
      padTo(String(r.verifiers), 4) +
      padTo(String(r.points), 5) +
      padTo(thresholdCell(r.threshold), 8) +
      padTo(fixed(r.auc, 4), 7) +
      padTo(String(r.admitted), 5) +
      String(r.abstained);
    lines.push(row(line, paneWidth));
  }

  lines.push(border("mid", paneWidth));
  for (const r of state.rows) {
    lines.push(row(`${padTo(sanitize(r.domain), 10)} ${domainNote(r)}`, paneWidth));
  }

  if (state.showDetail) {
    const r = state.rows[selected];
    lines.push(border("mid", paneWidth));
    lines.push(row(`DETAIL  ${sanitize(r.domain)}`, paneWidth));
    lines.push(row(`  verifiers registered  ${r.verifiers}`, paneWidth));
    lines.push(row(`  labeled observations  ${r.points}`, paneWidth));
    lines.push(row(`  conformal threshold   ${thresholdCell(r.threshold)}`, paneWidth));
    lines.push(row(`  epsilon               ${fixed(r.epsilon, 4)}`, paneWidth));
    lines.push(row(`  separation (AUC)      ${fixed(r.auc, 4)}`, paneWidth));
    lines.push(row(`  consequence           ${domainNote(r)}`, paneWidth));
    lines.push(row(`  this session          ${r.admitted} admitted / ${r.abstained} abstained`, paneWidth));
  }

  if (state.budget !== null) {
    const b = state.budget;
    lines.push(border("mid", paneWidth));
    lines.push(
      row(
        `BUDGET  ${b.remainingRisk.toFixed(4)} / ${b.totalRisk.toFixed(4)} risk left  ` +
          `(${b.entries} entr${b.entries === 1 ? "y" : "ies"})${b.exhausted ? "  EXHAUSTED" : ""}`,
        paneWidth,
      ),
    );
    lines.push(
      row(
        b.chainOk
          ? `CHAIN   verified from its own bytes`
          : `CHAIN   FAILED (${sanitize(b.chainReason ?? "unknown")}) — spending refused`,
        paneWidth,
      ),
    );
  }

  lines.push(border("bottom", paneWidth));
  return lines;
}
