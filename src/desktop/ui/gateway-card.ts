/**
 * Hades desktop gateway card — the renderer-side panel for the platform
 * gateway (`hades gateway`, `src/hades/gateway/process.ts`'s
 * `GatewayProcess`, `src/hades/gateway/pairing.ts`'s `PairingGuard`),
 * surfaced from the sidecar's `gateway.status` / `gateway.paircode` /
 * `gateway.error` events (`../ipc/gateway-contract.ts`, `../core/gateway-service.ts`).
 *
 * Renders inside the Tauri native webview (not a website): pure string-in,
 * string-out render functions plus a pure reducer over the gateway wire
 * events, matching the house pattern set by `learning-card.ts` /
 * `fleet-view.ts` / `skills-view.ts` / `cert-view.ts` — no DOM library, no
 * framework, every interpolated value escaped.
 *
 * WIRE TYPES: sourced directly from `../ipc/gateway-contract` (the single
 * source of truth for the gateway wire format) and re-exported here so this
 * module's own consumers/tests keep working unchanged, mirroring how
 * `learning-card.ts` re-exports `../ipc/learning-contract`'s types.
 *
 * HONEST NUMBERS: a `GatewayProbeView`'s `mode` (`"real" | "offline"`) is
 * always rendered as a visible badge naming both the platform and the mode —
 * an offline platform can never be styled to look live. Traffic counters are
 * rendered verbatim from the wire, never fabricated or zeroed to fill an
 * empty-looking table. A pairing code's remaining TTL is derived from the
 * caller-supplied clock (`opts.nowMs`) against the view's own `expiresAt`;
 * at or past expiry the card renders the literal "expired" state and never
 * prints the code text again, so a stale code can never be copied as live.
 */

// ---------------------------------------------------------------------------
// Wire types — imported from the single source of truth and re-exported for
// this module's consumers/tests.
// ---------------------------------------------------------------------------

import type {
  GatewayCountersView,
  GatewayEvent,
  GatewayPairCodeView,
  GatewayProbeView,
  GatewayStatusView,
} from "../ipc/gateway-contract";

export type {
  GatewayCountersView,
  GatewayEvent,
  GatewayPairCodeView,
  GatewayProbeView,
  GatewayStatusView,
} from "../ipc/gateway-contract";

// ---------------------------------------------------------------------------
// View state + reducer
// ---------------------------------------------------------------------------

export interface GatewayCardState {
  status: GatewayStatusView | null;
  pairCode: GatewayPairCodeView | null;
  error: string | null;
}

export function initialGatewayCardState(): GatewayCardState {
  return { status: null, pairCode: null, error: null };
}

/**
 * Pure reducer over the gateway wire event stream. Never mutates `s` (or
 * anything reachable from it) — always returns a new `GatewayCardState`.
 *
 *   - `gateway.status` replaces `status` wholesale and clears any prior
 *     `error` (a fresh, successful status supersedes it). `pairCode` is left
 *     untouched — a status refresh has nothing to say about pairing.
 *   - `gateway.paircode` replaces `pairCode` wholesale. `status` and `error`
 *     are left untouched.
 *   - `gateway.error` records the error message and keeps the last-known
 *     `status` AND `pairCode` untouched — a failed poll never wipes out the
 *     last good data the card already had.
 */
export function applyGatewayEvent(s: GatewayCardState, e: GatewayEvent): GatewayCardState {
  switch (e.kind) {
    case "gateway.status":
      return { status: e.status, pairCode: s.pairCode, error: null };

    case "gateway.paircode":
      return { ...s, pairCode: e.pair };

    case "gateway.error":
      return { ...s, error: e.message };

    default: {
      // Exhaustiveness guard: a new GatewayEvent kind added upstream without
      // a case here fails to compile.
      const _exhaustive: never = e;
      void _exhaustive;
      return s;
    }
  }
}

// ---------------------------------------------------------------------------
// Escaping (same convention as fleet-view.ts / cert-view.ts / skills-view.ts
// / learning-card.ts) — used on every interpolated value in this module,
// strings and numbers alike, so no rendering call site can ever forget it.
// ---------------------------------------------------------------------------

/** Escapes text for safe interpolation into HTML markup or attributes. */
export function escapeHtml(input: string): string {
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

/** `YYYY-MM-DD HH:MM:SS UTC`, matching `fleet-view.ts` / `learning-card.ts`'s `formatTimestamp`. */
function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "unknown time";
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** A wire counter is always a finite, non-negative integer once floored — never a fabricated value. */
function nonNegInt(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(status: GatewayStatusView): string {
  const runningCls = status.running ? "gateway-badge--running" : "gateway-badge--stopped";
  const startedAtNote =
    status.startedAt !== null
      ? `<span class="gateway-card__started-at">started ${escapeHtml(formatTimestamp(status.startedAt))}</span>`
      : '<span class="gateway-card__started-at gateway-card__started-at--never">never started</span>';

  const engineBadge = status.engine
    ? `<span class="gateway-badge ${status.engine.mode === "real" ? "gateway-badge--engine-real" : "gateway-badge--engine-mock"}">engine: ${escapeHtml(status.engine.mode)}</span>`
    : '<span class="gateway-badge gateway-badge--engine-none">engine: none</span>';

  return (
    '<header class="gateway-card__header">' +
    '<h3 class="gateway-card__title">Gateway</h3>' +
    `<span class="gateway-badge ${runningCls}">${escapeHtml(status.running ? "running" : "stopped")}</span>` +
    engineBadge +
    startedAtNote +
    '<span class="gateway-card__at">' +
    escapeHtml(formatTimestamp(status.at)) +
    "</span>" +
    "</header>"
  );
}

// ---------------------------------------------------------------------------
// Platform probe table
// ---------------------------------------------------------------------------

function renderProbeRow(probe: GatewayProbeView): string {
  const platform = escapeHtml(probe.platform);
  const modeCls = probe.mode === "real" ? "gateway-badge--real" : "gateway-badge--offline";
  return (
    `<tr class="gateway-probe-row" data-platform="${platform}">` +
    `<td class="gateway-probe-row__platform">${platform}</td>` +
    `<td><span class="gateway-badge ${modeCls}">${escapeHtml(probe.mode)}</span></td>` +
    `<td class="gateway-probe-row__detail">${escapeHtml(probe.detail)}</td>` +
    "</tr>"
  );
}

/**
 * The platform probe table. No platforms probed renders an explicit empty
 * state, never a blank `<table>`. Each row always carries its true `mode`
 * ("real" | "offline") as a visible badge next to the platform name — an
 * offline platform can never be styled as live.
 */
export function renderProbeRows(probes: GatewayProbeView[]): string {
  if (probes.length === 0) {
    return (
      '<div class="gateway-probes gateway-probes--empty">' +
      '<p class="gateway-empty-message">no platforms probed</p>' +
      "</div>"
    );
  }

  const rows = probes.map(renderProbeRow).join("");
  return (
    '<div class="gateway-probes">' +
    '<table class="gateway-table gateway-probes-table">' +
    "<thead><tr><th>Platform</th><th>Mode</th><th>Detail</th></tr></thead>" +
    `<tbody>${rows}</tbody>` +
    "</table>" +
    "</div>"
  );
}

// ---------------------------------------------------------------------------
// Live counters
// ---------------------------------------------------------------------------

/** Traffic counters, rendered as the exact numbers passed through from the wire. */
export function renderCounters(c: GatewayCountersView): string {
  return (
    '<div class="gateway-counters">' +
    `<span class="gateway-counters__stat">inbound ${escapeHtml(String(nonNegInt(c.inbound)))}</span>` +
    `<span class="gateway-counters__stat">outbound ${escapeHtml(String(nonNegInt(c.outbound)))}</span>` +
    `<span class="gateway-counters__stat">rate-limited ${escapeHtml(String(nonNegInt(c.rateLimited)))}</span>` +
    "</div>"
  );
}

// ---------------------------------------------------------------------------
// Pairing code — TTL-aware
// ---------------------------------------------------------------------------

/**
 * The pairing-code panel. `p === null` renders an explicit "no code issued
 * yet" empty state. Once a code has been issued, its remaining TTL is
 * derived from `p.expiresAt - nowMs`: strictly positive remaining time
 * renders the code text plus a live countdown; at or past expiry
 * (`remainingMs <= 0`) the panel renders the literal "expired" state and
 * NEVER prints `p.code` again, so a stale code can never be copied as live.
 */
export function renderPairCode(p: GatewayPairCodeView | null, nowMs: number): string {
  if (!p) {
    return (
      '<section class="gateway-paircode gateway-paircode--empty">' +
      '<h4 class="gateway-paircode__title">Pairing code</h4>' +
      '<p class="gateway-empty-message">no pairing code issued yet</p>' +
      "</section>"
    );
  }

  const levelCls = p.level === "owner" ? "gateway-badge--owner" : "gateway-badge--trusted";
  const levelBadge = `<span class="gateway-badge ${levelCls}">${escapeHtml(p.level)}</span>`;
  const remainingMs = p.expiresAt - nowMs;

  if (remainingMs <= 0) {
    return (
      '<section class="gateway-paircode gateway-paircode--expired">' +
      '<h4 class="gateway-paircode__title">Pairing code</h4>' +
      levelBadge +
      '<span class="gateway-paircode__status gateway-paircode__status--expired">expired</span>' +
      "</section>"
    );
  }

  const remainingSec = Math.max(0, Math.floor(remainingMs / 1000));
  return (
    '<section class="gateway-paircode gateway-paircode--active">' +
    '<h4 class="gateway-paircode__title">Pairing code</h4>' +
    levelBadge +
    `<code class="gateway-paircode__code">${escapeHtml(p.code)}</code>` +
    `<span class="gateway-paircode__ttl">expires in ${escapeHtml(String(remainingSec))}s</span>` +
    "</section>"
  );
}

// ---------------------------------------------------------------------------
// Error lane + top-level card
// ---------------------------------------------------------------------------

function renderErrorLane(message: string): string {
  return (
    '<div class="gateway-error" role="alert">' +
    `<span class="gateway-error__message">${escapeHtml(message)}</span>` +
    "</div>"
  );
}

/**
 * The full gateway card: header (running/engine badges + timestamps), a
 * distinct error lane when `state.error` is set (rendered ALONGSIDE the
 * last-known status/pairing data, never in place of it), the platform probe
 * table, live counters, and the TTL-aware pairing-code panel. No status
 * received yet (regardless of error/pairCode) renders one explicit honest
 * empty state for the status/counters/probes region — never zeroed counters
 * or an empty-but-real-looking table.
 */
export function renderGatewayCard(state: GatewayCardState, opts: { nowMs: number }): string {
  const errorLane = state.error ? renderErrorLane(state.error) : "";
  const pairSection = renderPairCode(state.pairCode, opts.nowMs);

  if (!state.status) {
    return (
      '<div class="gateway-card gateway-card--empty">' +
      '<header class="gateway-card__header"><h3 class="gateway-card__title">Gateway</h3></header>' +
      errorLane +
      pairSection +
      '<p class="gateway-card__empty-message">no gateway status received yet</p>' +
      "</div>"
    );
  }

  const status = state.status;
  return (
    '<div class="gateway-card">' +
    renderHeader(status) +
    errorLane +
    renderProbeRows(status.platforms) +
    renderCounters(status.counters) +
    pairSection +
    "</div>"
  );
}
