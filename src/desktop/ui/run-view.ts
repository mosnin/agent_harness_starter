/**
 * Hades desktop — Run view.
 *
 * The primary working surface of the desktop app: dispatch a goal, watch the
 * live task DAG resolve level by level, inspect the flat task list, and see
 * the worker pool that is executing it.
 *
 * Framework-light by design: every export here is a pure `render(state) ->
 * HTML string` function (or a small helper), so it is unit-testable without
 * a DOM, a bundler, or the Tauri webview. The native shell (`src-tauri/`)
 * owns wiring `data-cmd` affordances to the sidecar's typed `Command` union
 * (see `../ipc/contract`) via event delegation — this module never touches
 * `window`, IPC, or timers.
 */

import type { AppState } from "../core/app-store";
import { selectors } from "../core/app-store";
import type { TaskView, WorkerView } from "../ipc/contract";

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for safe interpolation into HTML content or attribute values. */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

// ---------------------------------------------------------------------------
// Status -> semantic color token
// ---------------------------------------------------------------------------

// Task statuses: pending, dispatched, reported, verified, rejected, failed.
// Worker statuses: idle, busy, starting, killed, dead.
// Both status spaces are mapped here so a single helper can color either a
// task node/pill or a worker card/pill.
const STATUS_COLOR_VAR: Record<string, string> = {
  // task lifecycle
  pending: "--color-ink-tertiary",
  dispatched: "--color-accent",
  reported: "--color-accent",
  verified: "--color-ok",
  rejected: "--color-bad",
  failed: "--color-bad",
  // worker lifecycle
  idle: "--color-ok",
  busy: "--color-accent",
  starting: "--color-warn",
  killed: "--color-bad",
  dead: "--color-bad",
};

const FALLBACK_STATUS_COLOR_VAR = "--color-ink-tertiary";

/**
 * Maps a task or worker status string to a semantic design token variable
 * name (e.g. `"--color-ok"`), for use as a CSS custom property in an inline
 * `style` attribute. Unknown statuses fall back to a neutral tertiary tone
 * rather than throwing, since the renderer must stay resilient to future
 * status values arriving over the wire.
 */
export function statusColor(status: string): string {
  return STATUS_COLOR_VAR[status] ?? FALLBACK_STATUS_COLOR_VAR;
}

// ---------------------------------------------------------------------------
// Small shared fragments
// ---------------------------------------------------------------------------

function statusPill(status: string): string {
  const colorVar = statusColor(status);
  return (
    `<span class="status-pill" data-status="${escapeHtml(status)}" ` +
    `style="--status-color:var(${colorVar})">${escapeHtml(status)}</span>`
  );
}

function emptyState(message: string): string {
  return `<p class="empty-state">${escapeHtml(message)}</p>`;
}

// ---------------------------------------------------------------------------
// Goal composer
// ---------------------------------------------------------------------------

function renderComposer(): string {
  return `
    <section class="run-composer" aria-label="Goal composer">
      <label class="run-composer-label" for="run-goal-input">New goal</label>
      <textarea
        id="run-goal-input"
        class="run-composer-input"
        placeholder="Describe the goal to dispatch..."
        rows="3"
      ></textarea>
      <div class="run-composer-actions">
        <button
          type="button"
          class="btn btn-primary"
          data-cmd="goal.dispatch"
          data-source="run-goal-input"
        >
          Dispatch
        </button>
      </div>
    </section>
  `.trim();
}

// ---------------------------------------------------------------------------
// Task DAG
// ---------------------------------------------------------------------------

function renderDagNode(task: TaskView): string {
  const colorVar = statusColor(task.status);
  return `
    <li
      class="run-dag-node"
      data-status="${escapeHtml(task.status)}"
      style="--status-color:var(${colorVar})"
      title="${escapeHtml(task.description)}"
    >
      <span class="run-dag-node-status" aria-hidden="true"></span>
      <span class="run-dag-node-id">${escapeHtml(task.id)}</span>
      <span class="run-dag-node-desc">${escapeHtml(task.description)}</span>
    </li>
  `.trim();
}

function renderDagColumn(level: number, tasks: TaskView[]): string {
  const nodes = tasks.map(renderDagNode).join("");
  return `
    <div class="run-dag-column">
      <h3 class="run-dag-column-title">L${level}</h3>
      <ul class="run-dag-column-body">${nodes}</ul>
    </div>
  `.trim();
}

/**
 * Renders the live task DAG: one column per dependency level, computed via
 * `selectors.tasksByLevel`, each node colored by `statusColor`. Verified
 * tasks read as "ok", rejected/failed as "bad", dispatched/reported as the
 * accent (in-flight), pending as neutral.
 */
export function renderTaskDag(state: AppState): string {
  const levels = selectors.tasksByLevel(state);
  if (levels.length === 0) {
    return `
      <div class="run-dag run-dag--empty">
        ${emptyState("Dispatch a goal to begin.")}
      </div>
    `.trim();
  }
  const columns = levels.map((tasks, level) => renderDagColumn(level, tasks)).join("");
  return `<div class="run-dag">${columns}</div>`;
}

// ---------------------------------------------------------------------------
// Task list
// ---------------------------------------------------------------------------

function renderTaskRow(task: TaskView): string {
  const deps =
    task.dependsOn && task.dependsOn.length > 0
      ? `<span class="run-task-row-deps">depends on ${task.dependsOn
          .map((id) => escapeHtml(id))
          .join(", ")}</span>`
      : "";
  return `
    <li class="run-task-row" data-status="${escapeHtml(task.status)}">
      <div class="run-task-row-main">
        <span class="run-task-row-desc">${escapeHtml(task.description)}</span>
        ${statusPill(task.status)}
      </div>
      <div class="run-task-row-meta">
        <span class="run-task-row-attempts">${task.attempts}/${task.maxAttempts} attempts</span>
        ${deps}
      </div>
    </li>
  `.trim();
}

function renderTaskList(state: AppState): string {
  if (state.tasks.length === 0) {
    return `<div class="run-task-list run-task-list--empty">${emptyState(
      "Dispatch a goal to begin."
    )}</div>`;
  }
  const rows = state.tasks.map(renderTaskRow).join("");
  return `<ul class="run-task-list">${rows}</ul>`;
}

// ---------------------------------------------------------------------------
// Worker grid
// ---------------------------------------------------------------------------

function renderWorkerCapabilities(worker: WorkerView): string {
  if (worker.capabilities.length === 0) {
    return `<li class="run-worker-card-cap run-worker-card-cap--empty">No declared capabilities</li>`;
  }
  return worker.capabilities
    .map((cap) => `<li class="run-worker-card-cap">${escapeHtml(cap)}</li>`)
    .join("");
}

function renderWorkerCard(worker: WorkerView): string {
  const killReason = worker.killReason
    ? `<p class="run-worker-card-kill-reason">${escapeHtml(worker.killReason)}</p>`
    : "";
  return `
    <div class="run-worker-card" data-status="${escapeHtml(worker.status)}">
      <div class="run-worker-card-head">
        <span class="run-worker-card-id">${escapeHtml(worker.id)}</span>
        ${statusPill(worker.status)}
      </div>
      <ul class="run-worker-card-caps">${renderWorkerCapabilities(worker)}</ul>
      ${killReason}
    </div>
  `.trim();
}

/**
 * Renders the worker pool as a card grid: one card per worker, an elevated
 * surface (shadow, not border) that lifts on hover, a status pill, and its
 * declared capabilities.
 */
export function renderWorkerGrid(state: AppState): string {
  if (state.workers.length === 0) {
    return `<div class="run-worker-grid run-worker-grid--empty">${emptyState(
      "No workers online yet."
    )}</div>`;
  }
  const cards = state.workers.map(renderWorkerCard).join("");
  return `<div class="run-worker-grid">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Full run view
// ---------------------------------------------------------------------------

/**
 * Renders the full Run view: goal composer, live task DAG, task list, and
 * worker grid. This is the desktop app's primary working surface — the
 * native shell mounts the returned HTML string and wires `data-cmd`
 * affordances to sidecar commands via event delegation.
 */
export function renderRunView(state: AppState): string {
  return `
    <div class="run-view">
      ${renderComposer()}
      <section class="run-section" aria-label="Task graph">
        <h2 class="run-section-title">Task graph</h2>
        ${renderTaskDag(state)}
      </section>
      <section class="run-section" aria-label="Tasks">
        <h2 class="run-section-title">Tasks</h2>
        ${renderTaskList(state)}
      </section>
      <section class="run-section" aria-label="Workers">
        <h2 class="run-section-title">Workers</h2>
        ${renderWorkerGrid(state)}
      </section>
    </div>
  `.trim();
}
