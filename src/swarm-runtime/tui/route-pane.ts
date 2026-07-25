/**
 * route-pane.ts — pure, deterministic ROUTE pane for the interactive TUI
 * (`hades tui`).
 *
 * Renders the budget-constrained router's live state: every routable arm's
 * measured cost and its PROVENANCE, its Beta posterior on P(verified), its
 * conformal accept threshold, plus the budget, the Lagrangian multiplier the
 * budget is enforced with, and the routing ledger's hash-chain verdict.
 *
 * Every function here is a pure string-in/string-out or state-in/state-out
 * transform: no I/O, no timers, no ANSI escapes, no `Date.now()`, no
 * randomness, and no imports from `src/hades/**` or anywhere outside this
 * file's own declarations. Data arrives as plain JSON-compatible rows the
 * orchestrator populates directly from `routerStatus()`
 * (`src/hades/routing/wiring.ts`) — a STRUCTURAL, not import, match, exactly
 * how `market-pane.ts` and `trust-gate-pane.ts` match their hades-side
 * producers with zero adapter code.
 *
 * Visual conventions match `market-pane.ts` / `render.ts`: `╭─╮ │ ├ ┤ ╰─╯`
 * box drawing, a default width of 72 code points, and a hard clamp — no line
 * this module emits ever exceeds the requested width. Width is measured in
 * Unicode code points (via `[...s].length`) so multi-byte text never
 * desyncs the border.
 *
 * Honesty discipline (this pane reports on the machine that decides where
 * your money goes — it must never make a guess look like a measurement):
 *  - Every number prints verbatim from the row. This module never derives,
 *    sums, or invents a metric of its own.
 *  - `unpriced: true` renders the cost cells as `—` and the note "UNPRICED:
 *    no published price — never routed as free", NEVER `0.0000`. A model the
 *    price table does not know is not a cheap model.
 *  - `costSource` is printed on every row, because `priced-prior` (a list
 *    price) and `measured` (this machine's own observations) are different
 *    kinds of claim and a router that confuses them overspends.
 *  - `thresholdFinite: false` renders as `abstain`, because that stratum has
 *    no evidence to accept anything with — a blank cell would read as "no
 *    limit", the exact opposite.
 *  - `measuredVtphPerDollar` renders as `—` for an arm with zero pulls:
 *    nothing was measured.
 *  - A FAILED ledger chain renders as a full-width alert, because the
 *    persisted ledger is REFUSED in that state and every attribution number
 *    on screen would otherwise be unfounded.
 *  - A budget that is exhausted or overspent renders a full-width alert, not
 *    a quietly negative number.
 *  - Free text (`armId`, `provider`, `costSource`, `riskSource`) is run
 *    through a local `sanitize` that strips C0/C1 control characters and ESC
 *    before it is ever laid into a rendered line, so no upstream data can
 *    inject cursor moves, colour codes, or terminal-clear sequences into the
 *    pane.
 */

// ---------------------------------------------------------------------------
// Row/state shapes (plain, JSON-compatible — no imports from src/hades/**)
// ---------------------------------------------------------------------------

/**
 * One routable arm.
 *
 * Structural match for `RouterArmView` (`src/hades/routing/wiring.ts`) and
 * `RouteArmWire` (`src/desktop/ipc/route-contract.ts`): `armId`, `provider`,
 * `unpriced`, `eligible`, `usdMean`, `usdP90`, `costSource`, `costSamples`,
 * `pulls`, `verified`, `pVerifiedMean`, `measuredVtphPerDollar` and
 * `riskSource` line up field for field.
 */
export interface RoutePaneArmRow {
  armId: string;
  provider: string;
  /** True when this model has NO published price — cost cells render `—`. */
  unpriced: boolean;
  eligible: boolean;
  /** Rejection code when `eligible` is false; null otherwise. */
  rejectionCode: string | null;
  usdMean: number;
  usdP90: number;
  /** `measured` | `priced-prior` | `unpriced`. */
  costSource: string;
  costSamples: number;
  pulls: number;
  verified: number;
  pVerifiedMean: number;
  /** 0 for an arm that has never been pulled — rendered `—`. */
  measuredVtphPerDollar: number;
  /**
   * The conformal accept threshold, or null when this stratum abstains.
   * `Infinity` does not survive JSON, so `thresholdFinite` is authoritative.
   */
  riskThreshold: number | null;
  /** False ⇒ this stratum ABSTAINS: it has no evidence to accept anything. */
  riskThresholdFinite: boolean;
  /** `stratum` | `pooled` | `none`. */
  riskSource: string;
  riskCalibrationSize: number;
}

/** Router-wide totals, structurally matching `RouterStatusView`. */
export interface RoutePaneSummary {
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  /** The Lagrangian multiplier the dollar budget is enforced with. */
  lambda: number;
  epsilon: number;
  /** The tier the per-arm thresholds above were read at. */
  tier: string;
  ledgerEntries: number;
  /** False when the persisted routing chain did not re-verify. */
  chainOk: boolean;
  chainCode: string;
  riskPoints: number;
  unpricedArms: number;
}

export interface RoutePaneState {
  rows: RoutePaneArmRow[];
  summary: RoutePaneSummary | null;
  selected: number;
  showDetail: boolean;
}

export const DEFAULT_WIDTH = 72;

export function initRoutePane(
  rows: readonly RoutePaneArmRow[],
  summary: RoutePaneSummary | null = null,
): RoutePaneState {
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
 * A cost cell. `—` (never `0.0000`) for an arm with no published price —
 * see the honesty discipline in the module header.
 */
export function costCell(row: RoutePaneArmRow, which: "mean" | "p90" = "mean"): string {
  if (row.unpriced) return "—";
  const v = which === "mean" ? row.usdMean : row.usdP90;
  return Number.isFinite(v) ? v.toFixed(4) : "—";
}

/** The conformal accept bar. `abstain` when the stratum accepts nothing. */
export function thresholdCell(row: RoutePaneArmRow): string {
  if (!row.riskThresholdFinite || row.riskThreshold === null || !Number.isFinite(row.riskThreshold)) {
    return "abstain";
  }
  return row.riskThreshold.toFixed(3);
}

/** Measured V-TPH$/$ — `—` when nothing has been measured for this arm. */
export function vtphCell(row: RoutePaneArmRow): string {
  if (row.pulls <= 0 || !Number.isFinite(row.measuredVtphPerDollar)) return "—";
  return row.measuredVtphPerDollar.toFixed(2);
}

/**
 * The one-line consequence for an arm, in the pane's own words. This is the
 * field that must never let an unpriced or uncalibrated arm read as a normal,
 * cheap, trusted row.
 */
export function armNote(row: RoutePaneArmRow): string {
  if (row.unpriced) return "UNPRICED: no published price — never routed as free";
  if (!row.eligible) return `ineligible: ${sanitize(row.rejectionCode ?? "unknown")}`;
  if (!row.riskThresholdFinite) return "gate abstains: no calibration evidence for this stratum";
  if (row.pulls === 0) return "never pulled: cost is a LIST PRICE, not a measurement";
  if (row.costSource !== "measured") {
    return `${row.pulls} pull(s) but cost still ${sanitize(row.costSource)} — too few samples`;
  }
  return `measured over ${row.costSamples} sample(s)`;
}

function clampSelection(state: RoutePaneState, next: number): number {
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
 *  - `j` / `down`  — next arm
 *  - `k` / `up`    — previous arm
 *  - `g` / `home`  — first arm
 *  - `G` / `end`   — last arm
 *  - `enter` / `l` — toggle the detail block for the selected arm
 *  - `escape`      — close the detail block
 */
export function routePaneKey(state: RoutePaneState, key: string): RoutePaneState {
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
export function renderRoutePane(state: RoutePaneState, w = DEFAULT_WIDTH): string[] {
  const paneWidth = Math.max(24, Math.floor(w));
  const lines: string[] = [];
  lines.push(border("top", paneWidth));
  lines.push(row("ROUTE", paneWidth));
  lines.push(border("mid", paneWidth));

  if (state.rows.length === 0) {
    lines.push(row("no routable arms — the model registry is empty", paneWidth));
    if (state.summary !== null) {
      lines.push(border("mid", paneWidth));
      lines.push(...summaryLines(state.summary, paneWidth));
    }
    lines.push(border("bottom", paneWidth));
    return lines;
  }

  const header =
    padTo("ARM", 22) + padTo("$MEAN", 8) + padTo("SRC", 7) + padTo("PULL", 5) + padTo("P(V)", 6) + "THRESH";
  lines.push(row(header, paneWidth));

  const selected = clampSelection(state, state.selected);
  for (let i = 0; i < state.rows.length; i++) {
    const r = state.rows[i];
    const marker = i === selected ? "›" : " ";
    const line =
      padTo(`${marker}${sanitize(r.armId)}`, 22) +
      padTo(costCell(r, "mean"), 8) +
      padTo(sanitize(r.costSource).slice(0, 6), 7) +
      padTo(String(r.pulls), 5) +
      padTo(fixed(r.pVerifiedMean, 2), 6) +
      thresholdCell(r);
    lines.push(row(line, paneWidth));
  }

  lines.push(border("mid", paneWidth));
  for (const r of state.rows) {
    lines.push(row(`${padTo(sanitize(r.armId), 22)} ${armNote(r)}`, paneWidth));
  }

  if (state.showDetail) {
    const r = state.rows[selected];
    lines.push(border("mid", paneWidth));
    lines.push(row(`DETAIL  ${sanitize(r.armId)}`, paneWidth));
    lines.push(row(`  provider              ${sanitize(r.provider)}`, paneWidth));
    lines.push(row(`  eligible              ${r.eligible ? "yes" : `no (${sanitize(r.rejectionCode ?? "?")})`}`, paneWidth));
    lines.push(row(`  cost mean / p90       ${costCell(r, "mean")} / ${costCell(r, "p90")}`, paneWidth));
    lines.push(row(`  cost provenance       ${sanitize(r.costSource)} over ${r.costSamples} sample(s)`, paneWidth));
    lines.push(row(`  pulls / verified      ${r.pulls} / ${r.verified}`, paneWidth));
    lines.push(row(`  P(verified)           ${fixed(r.pVerifiedMean, 4)}`, paneWidth));
    lines.push(row(`  measured V-TPH$/$     ${vtphCell(r)}`, paneWidth));
    lines.push(row(`  accept threshold      ${thresholdCell(r)} (${sanitize(r.riskSource)}, n=${r.riskCalibrationSize})`, paneWidth));
    lines.push(row(`  consequence           ${armNote(r)}`, paneWidth));
  }

  if (state.summary !== null) {
    lines.push(border("mid", paneWidth));
    lines.push(...summaryLines(state.summary, paneWidth));
  }

  lines.push(border("bottom", paneWidth));
  return lines;
}

function summaryLines(s: RoutePaneSummary, paneWidth: number): string[] {
  const out: string[] = [];
  out.push(
    row(
      `BUDGET   $${s.spentUsd.toFixed(4)} of $${s.budgetUsd.toFixed(4)} spent  ` +
        `λ ${s.lambda.toFixed(4)}`,
      paneWidth,
    ),
  );
  out.push(
    row(
      `RISK     ε ${s.epsilon} at ${sanitize(s.tier)}  ${s.riskPoints} labelled point(s)`,
      paneWidth,
    ),
  );
  out.push(
    row(
      s.chainOk
        ? `CHAIN    verified from its own bytes (${s.ledgerEntries} entries)`
        : // Deliberately short enough to survive the DEFAULT_WIDTH clamp
          // intact: a truncated integrity alert is a defeated one.
          "CHAIN    FAILED — persisted ledger REFUSED, numbers unfounded",
      paneWidth,
    ),
  );
  if (s.remainingUsd <= 0) {
    out.push(row("BUDGET   EXHAUSTED — the router is shadow-pricing to the cheapest arm", paneWidth));
  }
  if (s.unpricedArms > 0) {
    out.push(row(`UNPRICED ${s.unpricedArms} arm(s) have no published price — shown as —`, paneWidth));
  }
  return out;
}
