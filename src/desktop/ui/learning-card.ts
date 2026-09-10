/**
 * Hades desktop learning card — the renderer-side panel for the swarm
 * learning loop (`hades learning`, `src/hades/backends/swarm-learning.ts`),
 * surfaced inside the fleet view.
 *
 * Renders inside the Tauri native webview (not a website): pure string-in,
 * string-out render functions plus a pure reducer over the learning wire
 * events, matching the house pattern set by `fleet-view.ts` / `skills-view.ts`
 * / `cert-view.ts` — no DOM library, no framework, every interpolated string
 * escaped.
 *
 * WIRE TYPES: sourced directly from `../ipc/learning-contract` (the single
 * source of truth for the learning wire format) and re-exported here so this
 * module's own consumers/tests keep working unchanged, mirroring how
 * `fleet-view.ts` re-exports `../ipc/fleet-contract`'s types.
 *
 * HONEST NUMBERS: a `LearningStatusView` is always tagged `source: "live"`
 * or `source: "snapshot"` and rendered with a matching visible badge, so a
 * persisted-to-disk snapshot can never be mistaken for a live read. An arm
 * that has never been pulled (`pulls === 0`, `meanReward`/`ucb` both `null`
 * on the wire — see `../ipc/learning-contract.ts` / `../core/learning-service.ts`)
 * renders the literal text "never pulled", never a fabricated `0.00`.
 */

// ---------------------------------------------------------------------------
// Wire types — imported from the single source of truth and re-exported for
// this module's consumers/tests.
// ---------------------------------------------------------------------------

import type {
  LearningArmView,
  LearningCountsView,
  LearningEvent,
  LearningStatusView,
} from "../ipc/learning-contract";

export type {
  LearningArmView,
  LearningCountsView,
  LearningEvent,
  LearningStatusView,
} from "../ipc/learning-contract";

// ---------------------------------------------------------------------------
// View state + reducer
// ---------------------------------------------------------------------------

export interface LearningCardState {
  status: LearningStatusView | null;
  error: string | null;
}

export function initialLearningState(): LearningCardState {
  return { status: null, error: null };
}

/**
 * Pure reducer over the learning wire event stream. Never mutates `s` (or
 * anything reachable from it) — always returns a new `LearningCardState`.
 *
 *   - `learning.status` replaces `status` wholesale and clears any prior
 *     `error` (a fresh, successful status supersedes it).
 *   - `learning.error` records the error message and keeps the last-known
 *     `status` untouched — a failed `learning.get` never wipes out the last
 *     good status the panel already had.
 */
export function applyLearningEvent(s: LearningCardState, e: LearningEvent): LearningCardState {
  switch (e.kind) {
    case "learning.status":
      return { status: e.status, error: null };

    case "learning.error":
      return { ...s, error: e.message };

    default: {
      // Exhaustiveness guard: a new LearningEvent kind added upstream
      // without a case here fails to compile.
      const _exhaustive: never = e;
      void _exhaustive;
      return s;
    }
  }
}

// ---------------------------------------------------------------------------
// Escaping (same convention as fleet-view.ts / cert-view.ts / skills-view.ts)
// ---------------------------------------------------------------------------

/** Escapes text for safe interpolation into HTML markup or attributes. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** The em-dash "no data" marker for a `null` measured value — never a fabricated `0`. */
const NO_DATA = "—";

/** `v.toFixed(2)`, or the no-data marker for `null`/non-finite — never a fabricated reward. */
export function formatReward(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return NO_DATA;
  return v.toFixed(2);
}

/** `YYYY-MM-DD HH:MM:SS UTC`, matching `fleet-view.ts`'s `formatTimestamp`. */
function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "unknown time";
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function nonNegInt(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(status: LearningStatusView): string {
  const sourceCls = status.source === "live" ? "learning-badge--live" : "learning-badge--snapshot";
  const attachedCls = status.attached ? "learning-badge--attached" : "learning-badge--detached";
  const savedAtNote =
    status.source === "snapshot" && status.savedAt !== null
      ? `<span class="learning-card__saved-at">saved ${escapeHtml(formatTimestamp(status.savedAt))}</span>`
      : "";

  return (
    '<header class="learning-card__header">' +
    '<h3 class="learning-card__title">Learning</h3>' +
    `<span class="learning-badge ${sourceCls}">${status.source}</span>` +
    `<span class="learning-badge ${attachedCls}">${status.attached ? "attached" : "detached"}</span>` +
    savedAtNote +
    '<span class="learning-card__at">' +
    escapeHtml(formatTimestamp(status.at)) +
    "</span>" +
    "</header>"
  );
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

function renderCounts(counts: LearningCountsView): string {
  return (
    '<div class="learning-counts">' +
    `<span class="learning-counts__stat">recorded ${nonNegInt(counts.recorded)}</span>` +
    `<span class="learning-counts__stat">skipped ${nonNegInt(counts.skipped)}</span>` +
    `<span class="learning-counts__stat">duplicate ${nonNegInt(counts.duplicate)}</span>` +
    "</div>"
  );
}

// ---------------------------------------------------------------------------
// Arms table
// ---------------------------------------------------------------------------

function renderArmRow(arm: LearningArmView): string {
  const name = escapeHtml(arm.name);
  const neverPulled = arm.pulls === 0;
  const meanCell = neverPulled
    ? '<span class="learning-arm-row__never">never pulled</span>'
    : escapeHtml(formatReward(arm.meanReward));
  const ucbCell = neverPulled
    ? '<span class="learning-arm-row__never">never pulled</span>'
    : escapeHtml(formatReward(arm.ucb));

  return (
    `<tr class="learning-arm-row" data-arm-name="${name}">` +
    `<td class="learning-arm-row__name">${name}</td>` +
    `<td>${nonNegInt(arm.pulls)}</td>` +
    `<td>${nonNegInt(arm.verified)}</td>` +
    `<td>${meanCell}</td>` +
    `<td>${ucbCell}</td>` +
    "</tr>"
  );
}

/** The routing-arm table. No tracked arms renders an explicit empty state, never a blank `<table>`. */
export function renderArmsTable(arms: LearningArmView[]): string {
  if (arms.length === 0) {
    return (
      '<div class="learning-arms learning-arms--empty">' +
      '<p class="learning-empty-message">No routing arms tracked yet.</p>' +
      "</div>"
    );
  }

  const rows = arms.map(renderArmRow).join("");
  return (
    '<div class="learning-arms">' +
    '<table class="learning-table learning-arms-table">' +
    "<thead><tr>" +
    "<th>Arm</th><th>Pulls</th><th>Verified</th><th>Mean reward</th><th>UCB</th>" +
    "</tr></thead>" +
    `<tbody>${rows}</tbody>` +
    "</table>" +
    "</div>"
  );
}

// ---------------------------------------------------------------------------
// Recent notes
// ---------------------------------------------------------------------------

/** Recent outcome-feed honesty notes, newest last. No notes renders an explicit empty state. */
export function renderNotes(notes: string[]): string {
  if (notes.length === 0) {
    return (
      '<div class="learning-notes learning-notes--empty">' +
      '<p class="learning-empty-message">No recent notes.</p>' +
      "</div>"
    );
  }

  const items = notes.map((n) => `<li class="learning-notes__item">${escapeHtml(n)}</li>`).join("");
  return (
    '<section class="learning-notes">' +
    '<h4 class="learning-notes__title">Recent notes</h4>' +
    `<ul class="learning-notes__list">${items}</ul>` +
    "</section>"
  );
}

// ---------------------------------------------------------------------------
// Error banner + top-level card
// ---------------------------------------------------------------------------

function renderErrorBanner(message: string): string {
  return (
    '<div class="learning-error" role="alert">' +
    `<span class="learning-error__message">${escapeHtml(message)}</span>` +
    "</div>"
  );
}

/**
 * The full learning card: header (source/attached badges + timestamp), an
 * error banner when `state.error` is set, the counts summary, the routing
 * arm table, and recent notes. No status loaded yet (and no error) renders
 * one explicit honest empty state — never a blank card pretending there is
 * simply nothing to report.
 */
export function renderLearningCard(state: LearningCardState): string {
  const errorBanner = state.error ? renderErrorBanner(state.error) : "";

  if (!state.status) {
    if (state.error) {
      return (
        '<div class="learning-card">' +
        '<header class="learning-card__header"><h3 class="learning-card__title">Learning</h3></header>' +
        errorBanner +
        "</div>"
      );
    }
    return (
      '<div class="learning-card learning-card--empty">' +
      '<header class="learning-card__header"><h3 class="learning-card__title">Learning</h3></header>' +
      '<p class="learning-card__empty-message">No learning data yet</p>' +
      "</div>"
    );
  }

  const status = state.status;
  return (
    '<div class="learning-card">' +
    renderHeader(status) +
    errorBanner +
    renderCounts(status.counts) +
    renderArmsTable(status.arms) +
    renderNotes(status.recentNotes) +
    "</div>"
  );
}
