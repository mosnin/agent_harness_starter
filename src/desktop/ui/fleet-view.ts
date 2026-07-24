/**
 * Hades desktop fleet view — the renderer-side panel for `hades backends`
 * (the remote-compute fleet: `hades backends list/probe/hibernate/wake/
 * terminate`, `src/hades/backends/*`).
 *
 * Renders inside the Tauri native webview (not a website): pure string-in,
 * string-out render functions plus a pure reducer over the fleet wire
 * events, matching the house pattern set by `skills-view.ts` / `cert-view.ts`
 * / `trust-view.ts` — no DOM library, no framework, every interpolated
 * string escaped, every user affordance a `data-cmd` attribute the shell's
 * command dispatcher (`shell.ts`) picks up.
 *
 * WIRE TYPES: sourced directly from `../ipc/fleet-contract` (the single
 * source of truth for the fleet wire format) and re-exported here so this
 * module's own consumers/tests keep working unchanged. (During the team
 * cycle these were pinned local copies; central integration swapped them
 * for the real imports, exactly as the pinning note promised.)
 *
 * HONEST NUMBERS: a backend's `cost` is always operator-configured — it is
 * rendered with a visible "configured" tag so it can never be mistaken for
 * something measured. A backend's `telemetry` is always real runtime
 * measurement — rendered with a visible "measured" tag. A `null`
 * `provisionLatencyEmaMs` (no samples yet) renders as an explicit "no data"
 * marker, never a fabricated `0`.
 */

// ---------------------------------------------------------------------------
// Wire types — imported from the single source of truth and re-exported for
// this module's consumers/tests.
// ---------------------------------------------------------------------------

import type {
  FleetLifecycleState,
  BackendCostView,
  BackendTelemetryView,
  BackendView,
  FleetWorkerView,
  FleetEvent,
} from "../ipc/fleet-contract";

export type {
  FleetLifecycleState,
  BackendCostView,
  BackendTelemetryView,
  BackendView,
  FleetWorkerView,
  FleetEvent,
} from "../ipc/fleet-contract";

// ---------------------------------------------------------------------------
// View state + reducer
// ---------------------------------------------------------------------------

export interface FleetViewState {
  backends: BackendView[];
  workers: FleetWorkerView[];
  lastSnapshotAt: number | null;
  error: { message: string; workerId?: string; at: number } | null;
}

export function initialFleetState(): FleetViewState {
  return {
    backends: [],
    workers: [],
    lastSnapshotAt: null,
    error: null,
  };
}

/** Inserts/updates `worker` in `workers`, keeping the list sorted by `workerId`. Never mutates `workers`. */
function upsertWorkerSorted(workers: FleetWorkerView[], worker: FleetWorkerView): FleetWorkerView[] {
  const existingIndex = workers.findIndex((w) => w.workerId === worker.workerId);
  if (existingIndex !== -1) {
    const next = workers.slice();
    next[existingIndex] = worker;
    return next;
  }
  const insertAt = workers.findIndex((w) => w.workerId > worker.workerId);
  const next = workers.slice();
  if (insertAt === -1) {
    next.push(worker);
  } else {
    next.splice(insertAt, 0, worker);
  }
  return next;
}

/**
 * Pure reducer over the fleet wire event stream. Never mutates `state` (or
 * anything reachable from it) — always returns a new `FleetViewState`.
 *
 *   - `fleet.snapshot` replaces `backends` + `workers` wholesale and clears
 *     any prior `error` (a fresh, successful snapshot supersedes it).
 *   - `fleet.worker.upsert` inserts-or-updates one worker, keeping `workers`
 *     sorted by `workerId`; `backends`, `lastSnapshotAt` and `error` pass
 *     through untouched.
 *   - `fleet.error` records the error and keeps every existing `backends`/
 *     `workers`/`lastSnapshotAt` value — a failed command never wipes out
 *     the last-known-good fleet view.
 */
export function applyFleetEvent(state: FleetViewState, event: FleetEvent): FleetViewState {
  switch (event.kind) {
    case "fleet.snapshot": {
      return {
        backends: event.backends.slice(),
        workers: event.workers.slice(),
        lastSnapshotAt: event.at,
        error: null,
      };
    }

    case "fleet.worker.upsert": {
      return {
        ...state,
        workers: upsertWorkerSorted(state.workers, event.worker),
      };
    }

    case "fleet.error": {
      const error =
        event.workerId === undefined
          ? { message: event.message, at: event.at }
          : { message: event.message, workerId: event.workerId, at: event.at };
      return { ...state, error };
    }

    default: {
      // Exhaustiveness guard: a new FleetEvent kind added upstream without a
      // case here fails to compile.
      const _exhaustive: never = event;
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// Escaping (same convention as cert-view.ts / skills-view.ts)
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

/**
 * `$0.0000`-style USD formatting: fixed 4 decimals so sub-cent accrual
 * (fractions of a cent per second) never rounds away to `$0.00`. A
 * non-finite input renders the explicit no-data marker — never a fabricated
 * dollar figure (the wire guards reject non-finite values, so this is a
 * defense-in-depth path, but if it ever fires it must not invent `$0`).
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return NO_DATA;
  return `$${n.toFixed(4)}`;
}

/**
 * Renders a millisecond duration as the single largest whole unit it spans
 * (ms below 1s, s below 1m, m below 1h, h at/above 1h), using floor
 * arithmetic so unit boundaries (999ms/1000ms, 59999ms/60000ms,
 * 3599999ms/3600000ms) land unambiguously on one side.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return NO_DATA; // never render NaN/Infinity as a fabricated duration
  if (ms < 0) return "0ms"; // clock-skew clamp: a real (if anomalous) measurement, floored
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  return `${totalHours}h`;
}

/** `YYYY-MM-DD HH:MM:SS UTC`, matching `cert-view.ts`'s `formatIssuedAt`. */
function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "unknown time";
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** The em-dash "no data yet" marker for a `null` measured value — never a fabricated `0`. */
const NO_DATA = "—";

/** CSS badge class for one lifecycle state. Every branch has a matching selector in `fleet-view.css`. */
export function lifecycleBadgeClass(state: FleetLifecycleState): string {
  switch (state) {
    case "provisioning":
      return "fleet-badge--provisioning";
    case "running":
      return "fleet-badge--running";
    case "hibernating":
      return "fleet-badge--hibernating";
    case "hibernated":
      return "fleet-badge--hibernated";
    case "waking":
      return "fleet-badge--waking";
    case "failed":
      return "fleet-badge--failed";
    case "stopped":
      return "fleet-badge--stopped";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** `hibernating` / `waking` are in-flight transitions: no action can be taken on a worker mid-transition. */
function isTransientState(state: FleetLifecycleState): boolean {
  return state === "hibernating" || state === "waking";
}

// ---------------------------------------------------------------------------
// Backend table
// ---------------------------------------------------------------------------

function availabilityLabel(available: boolean | null): { text: string; cls: string } {
  if (available === null) return { text: "unprobed", cls: "fleet-available--unknown" };
  return available ? { text: "available", cls: "fleet-available--yes" } : { text: "unavailable", cls: "fleet-available--no" };
}

function renderCostCell(cost: BackendCostView): string {
  return (
    '<div class="fleet-cost">' +
    `<span class="fleet-cost__rate">${formatUsd(cost.perRunningHourUsd)}/h running</span>` +
    `<span class="fleet-cost__rate">${formatUsd(cost.perHibernatedHourUsd)}/h hibernated</span>` +
    `<span class="fleet-cost__rate">${formatUsd(cost.perProvisionUsd)} per provision</span>` +
    '<span class="fleet-tag fleet-tag--configured">configured</span>' +
    "</div>"
  );
}

function renderTelemetryCell(telemetry: BackendTelemetryView): string {
  const latency = telemetry.provisionLatencyEmaMs === null ? NO_DATA : formatDurationMs(telemetry.provisionLatencyEmaMs);
  return (
    '<div class="fleet-telemetry">' +
    `<span class="fleet-telemetry__stat">provisions ${Math.max(0, Math.floor(telemetry.provisions))}</span>` +
    `<span class="fleet-telemetry__stat">failures ${Math.max(0, Math.floor(telemetry.failures))}</span>` +
    `<span class="fleet-telemetry__stat">latency EMA ${escapeHtml(latency)}</span>` +
    `<span class="fleet-telemetry__stat">running ${formatDurationMs(telemetry.runningMs)}</span>` +
    `<span class="fleet-telemetry__stat">hibernated ${formatDurationMs(telemetry.hibernatedMs)}</span>` +
    `<span class="fleet-telemetry__stat">accrued ${formatUsd(telemetry.accruedUsd)}</span>` +
    '<span class="fleet-tag fleet-tag--measured">measured</span>' +
    "</div>"
  );
}

function renderBackendRow(backend: BackendView): string {
  const name = escapeHtml(backend.name);
  const availability = availabilityLabel(backend.available);
  const capabilities = backend.capabilities.length > 0 ? backend.capabilities.map(escapeHtml).join(", ") : NO_DATA;
  return (
    `<tr class="fleet-backend-row" data-backend-name="${name}">` +
    `<td class="fleet-backend-row__name">${name}</td>` +
    `<td>${escapeHtml(backend.kind)}</td>` +
    `<td>${escapeHtml(backend.locality)}</td>` +
    `<td><span class="fleet-available ${availability.cls}">${availability.text}</span></td>` +
    `<td>${backend.supportsHibernate ? "yes" : "no"}</td>` +
    `<td>${capabilities}</td>` +
    `<td>${renderCostCell(backend.cost)}</td>` +
    `<td>${renderTelemetryCell(backend.telemetry)}</td>` +
    "</tr>"
  );
}

/** The backend inventory table. An empty fleet renders an explicit empty state, never a blank/empty `<table>`. */
export function renderBackendTable(backends: BackendView[]): string {
  if (backends.length === 0) {
    return (
      '<div class="fleet-backends fleet-backends--empty">' +
      '<p class="fleet-empty-message">No backends registered. Run `hades backends list` to check the configured build.</p>' +
      "</div>"
    );
  }

  const rows = backends.map(renderBackendRow).join("");
  return (
    '<div class="fleet-backends">' +
    '<table class="fleet-table fleet-backends-table">' +
    "<thead><tr>" +
    "<th>Backend</th><th>Kind</th><th>Locality</th><th>Available</th><th>Hibernate</th>" +
    "<th>Capabilities</th><th>Cost</th><th>Telemetry</th>" +
    "</tr></thead>" +
    `<tbody>${rows}</tbody>` +
    "</table>" +
    "</div>"
  );
}

// ---------------------------------------------------------------------------
// Worker rows + lifecycle affordances
// ---------------------------------------------------------------------------

/**
 * Hibernate/wake/terminate buttons for one worker, gated by lifecycle state
 * (and, for hibernate, by whether the worker's backend supports it):
 *
 *   - Hibernate: only when `state === "running"` AND the backend supports it.
 *   - Wake: only when `state === "hibernated"`.
 *   - Terminate: any non-transient state except `"stopped"` (nothing left to
 *     tear down on an already-stopped worker).
 *   - Transient states (`"hibernating"` / `"waking"`) render no buttons at
 *     all — the caller (`renderWorkerRow`) never invokes this for them, but
 *     the guard is kept here too so this function is safe standalone.
 */
function renderWorkerActions(worker: FleetWorkerView, backendSupportsHibernate: boolean): string {
  if (isTransientState(worker.state)) return "";

  const workerId = escapeHtml(worker.workerId);
  const buttons: string[] = [];

  if (worker.state === "running" && backendSupportsHibernate) {
    buttons.push(
      `<button type="button" class="btn btn-sm" data-cmd="fleet.hibernate" data-worker-id="${workerId}">Hibernate</button>`,
    );
  }

  if (worker.state === "hibernated") {
    buttons.push(
      `<button type="button" class="btn btn-sm" data-cmd="fleet.wake" data-worker-id="${workerId}">Wake</button>`,
    );
  }

  if (worker.state !== "stopped") {
    buttons.push(
      `<button type="button" class="btn btn-sm btn-ghost" data-cmd="fleet.terminate" data-worker-id="${workerId}">Terminate</button>`,
    );
  }

  return buttons.join("");
}

/**
 * One worker row. `backendSupportsHibernate` is threaded in by the caller
 * (looked up from the matching `BackendView.supportsHibernate` — worker
 * views carry no capability data of their own); it defaults to `false` so
 * calling this with just a worker (the locked single-argument call shape)
 * always renders the conservative "no hibernate button" case rather than
 * guessing a capability it was not told about.
 */
export function renderWorkerRow(worker: FleetWorkerView, backendSupportsHibernate = false): string {
  const workerId = escapeHtml(worker.workerId);
  const transient = isTransientState(worker.state);
  const badgeClass = lifecycleBadgeClass(worker.state);
  const badge =
    `<span class="fleet-badge ${badgeClass}${transient ? " fleet-badge--transient" : ""}">` +
    escapeHtml(worker.state) +
    "</span>";

  return (
    `<tr class="fleet-worker-row" data-worker-id="${workerId}">` +
    `<td class="fleet-worker-row__id"><code>${workerId}</code></td>` +
    `<td>${escapeHtml(worker.backend)}</td>` +
    `<td><code>${escapeHtml(worker.nativeId)}</code></td>` +
    `<td>${badge}</td>` +
    `<td>${escapeHtml(formatTimestamp(worker.startedAt))}</td>` +
    `<td>${escapeHtml(formatDurationMs(worker.idleMs))}</td>` +
    `<td class="fleet-worker-row__actions">${transient ? "" : renderWorkerActions(worker, backendSupportsHibernate)}</td>` +
    "</tr>"
  );
}

function renderWorkerSection(workers: FleetWorkerView[], backends: BackendView[]): string {
  const supportsHibernateByBackend = new Map(backends.map((b) => [b.name, b.supportsHibernate]));

  const body =
    workers.length === 0
      ? '<div class="fleet-workers fleet-workers--empty"><p class="fleet-empty-message">No live workers.</p></div>'
      : '<div class="fleet-workers"><table class="fleet-table fleet-workers-table">' +
        "<thead><tr>" +
        "<th>Worker</th><th>Backend</th><th>Native ID</th><th>State</th><th>Started</th><th>Idle</th><th>Actions</th>" +
        "</tr></thead>" +
        `<tbody>${workers
          .map((w) => renderWorkerRow(w, supportsHibernateByBackend.get(w.backend) ?? false))
          .join("")}</tbody>` +
        "</table></div>";

  return `<section class="fleet-view__section"><h3 class="fleet-view__section-title">Workers</h3>${body}</section>`;
}

// ---------------------------------------------------------------------------
// Error banner + header + top-level view
// ---------------------------------------------------------------------------

function renderErrorBanner(error: { message: string; workerId?: string; at: number }): string {
  const workerNote =
    error.workerId !== undefined
      ? `<span class="fleet-error__worker">worker: <code>${escapeHtml(error.workerId)}</code></span>`
      : "";
  return (
    '<div class="fleet-error" role="alert">' +
    `<span class="fleet-error__message">${escapeHtml(error.message)}</span>` +
    workerNote +
    `<span class="fleet-error__at">${escapeHtml(formatTimestamp(error.at))}</span>` +
    "</div>"
  );
}

function renderHeader(state: FleetViewState): string {
  const snapshotLabel =
    state.lastSnapshotAt === null ? "Not loaded yet" : `Updated ${formatTimestamp(state.lastSnapshotAt)}`;
  return (
    '<header class="fleet-view__header">' +
    '<h2 class="fleet-view__title">Fleet</h2>' +
    `<span class="fleet-view__snapshot-at">${escapeHtml(snapshotLabel)}</span>` +
    '<div class="fleet-view__actions">' +
    '<button type="button" class="btn btn-sm" data-cmd="fleet.refresh">Refresh</button>' +
    '<button type="button" class="btn btn-sm" data-cmd="fleet.probe">Probe availability</button>' +
    "</div>" +
    "</header>"
  );
}

/**
 * The full fleet panel: header (refresh/probe affordances + last snapshot
 * time), an error banner when `state.error` is set, the backend inventory
 * table, and the live worker table. A fleet with no backends and no workers
 * at all (nothing loaded yet) renders one explicit empty state instead of
 * two blank tables.
 */
export function renderFleetView(state: FleetViewState): string {
  const header = renderHeader(state);
  const errorBanner = state.error ? renderErrorBanner(state.error) : "";

  if (state.backends.length === 0 && state.workers.length === 0) {
    return (
      '<div class="fleet-view">' +
      header +
      errorBanner +
      '<div class="fleet-view__empty">' +
      '<p class="fleet-empty-message">No fleet data yet. Probe or refresh to load backends and workers.</p>' +
      "</div>" +
      "</div>"
    );
  }

  return (
    '<div class="fleet-view">' +
    header +
    errorBanner +
    '<section class="fleet-view__section"><h3 class="fleet-view__section-title">Backends</h3>' +
    renderBackendTable(state.backends) +
    "</section>" +
    renderWorkerSection(state.workers, state.backends) +
    "</div>"
  );
}
