/**
 * Hades desktop app shell — the native window frame (titlebar + sidebar +
 * content slot) and the "next-level" sidebar renderer.
 *
 * Framework-light: every export here is a pure function returning an HTML
 * string, or a typed mapping from a plain DOM intent to a wire `Command`.
 * No DOM, no event wiring, no globals — this module is rendered into the
 * Tauri webview by a thin renderer elsewhere, and is fully unit-testable
 * with no browser.
 */

import type { AppState } from "../core/app-store";
import { selectors } from "../core/app-store";
import type { Command } from "../ipc/contract";

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

export type NavKey =
  | "run"
  | "trust"
  | "skills"
  | "workers"
  | "fleet"
  | "compare"
  | "metrics"
  | "state"
  | "settings";

export interface ShellProps {
  state: AppState;
  active: NavKey;
}

export const NAV: Array<{ key: NavKey; label: string; hint: string }> = [
  { key: "run", label: "Run", hint: "Goal, DAG and live workers" },
  { key: "trust", label: "Trust", hint: "STYX verification gate and certificates" },
  { key: "skills", label: "Skills", hint: "SKILL.md library" },
  { key: "workers", label: "Workers", hint: "Pool status and capabilities" },
  { key: "fleet", label: "Fleet", hint: "Remote-compute backends: inventory, telemetry, lifecycle" },
  { key: "compare", label: "Compare", hint: "Head to head vs the flat baseline" },
  { key: "metrics", label: "Metrics", hint: "Live V-TPH$ (verified tasks per hour per dollar)" },
  { key: "state", label: "Workspace", hint: "Shared workspace store: sessions, memory, config, skills — live across CLI, TUI and desktop" },
  { key: "settings", label: "Settings", hint: "Runtime mode and pool size" },
];

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * TEXT-context escaping (between tags). Deliberately does not touch quotes.
 * For anything landing inside an attribute value use {@link escAttr}.
 */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * ATTRIBUTE-context escaping: everything {@link esc} does, plus both quote
 * characters, so a value carrying a `"` cannot terminate the attribute and
 * inject markup or an event handler.
 *
 * This matters because several surfaces put FOREIGN data into attributes —
 * a workspace record key (`state-view.ts`), a worker id — and a workspace
 * key is only forbidden from containing `/`, `\`, NUL, control characters
 * and the `.`/`..` names (see `validateKey` in `src/hades/state/record.ts`).
 * Quotes are perfectly legal in one, so `esc` alone is not sufficient there.
 */
export function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Icons — inline single-stroke SVGs, no external assets.
// ---------------------------------------------------------------------------

const ICONS: Record<NavKey, string> = {
  run: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3l13 7-13 7V3z"/></svg>`,
  trust: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l7 3v5c0 4.5-3 7.5-7 8-4-.5-7-3.5-7-8V5l7-3z"/><path d="M7 10l2 2 4-4"/></svg>`,
  skills: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5A2.5 2.5 0 015.5 3H10v14H5.5A2.5 2.5 0 013 14.5v-9z"/><path d="M17 5.5A2.5 2.5 0 0014.5 3H10v14h4.5a2.5 2.5 0 002.5-2.5v-9z"/></svg>`,
  workers: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="2.6"/><circle cx="14" cy="8.5" r="2"/><path d="M2.5 16c.6-3 2.3-4.6 4.5-4.6s3.9 1.6 4.5 4.6"/><path d="M11.8 12.2c1.7.1 3 1.4 3.5 3.8"/></svg>`,
  fleet: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="15" height="5.5" rx="1.2"/><rect x="2.5" y="11.5" width="15" height="5.5" rx="1.2"/><path d="M5.5 5.75h.01M5.5 14.25h.01"/><path d="M9 5.75h5.5M9 14.25h5.5"/></svg>`,
  compare: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v14"/><path d="M4 7l3-3 3 3"/><path d="M16 13l-3 3-3-3"/></svg>`,
  metrics: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h14"/><path d="M6 17V9"/><path d="M10 17V4"/><path d="M14 17v-6"/></svg>`,
  state: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="10" cy="5" rx="6.5" ry="2.5"/><path d="M3.5 5v10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5"/><path d="M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5"/></svg>`,
  settings: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3L4.9 4.9"/></svg>`,
};

const BRAND_MARK = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l16 8-16 8V4z"/></svg>`;

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function renderSidebar(state: AppState, active: NavKey): string {
  const liveWorkers = selectors.liveWorkerCount(state);
  const statusDotClass = state.running ? "status-dot status-dot--on" : "status-dot status-dot--off";
  const modeLabel = state.mode ? esc(state.mode) : "stopped";
  const latestRun = state.runs[0];

  const navItems = NAV.map((item) => {
    const isActive = item.key === active;
    return `<button type="button" class="nav-item${isActive ? " nav-item--active" : ""}" data-nav="${escAttr(item.key)}" aria-current="${isActive ? "page" : "false"}" title="${escAttr(item.hint)}">
      <span class="nav-item__icon">${ICONS[item.key]}</span>
      <span class="nav-item__label">${esc(item.label)}</span>
    </button>`;
  }).join("");

  const runLine = latestRun
    ? `<div class="sidebar-status__run">${esc(latestRun.objective)}</div>`
    : `<div class="sidebar-status__run sidebar-status__run--empty">No active run</div>`;

  return `<aside class="sidebar">
    <div class="sidebar-brand">
      <span class="sidebar-brand__mark">${BRAND_MARK}</span>
      <span class="sidebar-brand__name">Hades</span>
    </div>

    <nav class="sidebar-nav">${navItems}</nav>

    <div class="sidebar-status">
      <div class="sidebar-status__row">
        <span class="${statusDotClass}"></span>
        <span class="sidebar-status__mode">${modeLabel}</span>
        <span class="pill">${liveWorkers}/${state.poolSize}</span>
      </div>
      ${runLine}
      <div class="sidebar-status__pool">
        <button type="button" class="btn btn-ghost btn-sm" data-cmd="pool.scale.down" data-value="${state.poolSize}" aria-label="Scale pool down">&minus;</button>
        <span class="sidebar-status__pool-size">${state.poolSize} workers</span>
        <button type="button" class="btn btn-ghost btn-sm" data-cmd="pool.scale.up" data-value="${state.poolSize}" aria-label="Scale pool up">+</button>
      </div>
      <button type="button" class="btn btn-block" data-cmd="${state.running ? "runtime.stop" : "runtime.start"}">
        ${state.running ? "Stop runtime" : "Start runtime"}
      </button>
    </div>

    <div class="sidebar-dispatch">
      <input type="text" class="sidebar-dispatch__input" id="sidebar-goal-input" placeholder="Describe a goal to dispatch&hellip;" />
      <button type="button" class="btn btn-primary btn-block" data-cmd="goal.dispatch" data-input="sidebar-goal-input">
        Dispatch goal
      </button>
    </div>
  </aside>`;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function renderShell(props: ShellProps, contentHtml: string, overlayHtml = ""): string {
  const { state, active } = props;
  return `<div class="app-shell">
    <header class="titlebar" data-tauri-drag-region>
      <div class="titlebar__traffic-light-space"></div>
      <div class="titlebar__title">Hades</div>
      <div class="titlebar__spacer">
        <button type="button" class="titlebar__palette-hint" data-palette="open" title="Command palette (Ctrl/Cmd+K)">
          <span class="titlebar__palette-key">&#8984;K</span>
        </button>
      </div>
    </header>
    <div class="app-shell__body">
      ${renderSidebar(state, active)}
      <main class="app-shell__content" data-active="${escAttr(active)}">${contentHtml}</main>
    </div>
    ${overlayHtml}
  </div>`;
}

// ---------------------------------------------------------------------------
// Intent -> Command mapping (renderer event delegation)
// ---------------------------------------------------------------------------

/**
 * Maps a DOM `data-cmd` click payload — `{cmd, value?}`, read off the clicked
 * element's `data-cmd`/`data-value` (or an associated input's value) by the
 * renderer's single delegated click handler — to a typed wire `Command`.
 * Returns null for anything not recognized so the caller can no-op safely.
 */
export function intentToCommand(intent: { cmd: string; value?: string }): Command | null {
  switch (intent.cmd) {
    case "runtime.start":
      return { kind: "runtime.start", mode: "inline", poolSize: 3 };
    case "runtime.stop":
      return { kind: "runtime.stop" };
    case "pool.scale.up": {
      const current = intent.value !== undefined ? Number.parseInt(intent.value, 10) : NaN;
      const base = Number.isFinite(current) ? current : 0;
      return { kind: "pool.scale", size: base + 1 };
    }
    case "pool.scale.down": {
      const current = intent.value !== undefined ? Number.parseInt(intent.value, 10) : NaN;
      const base = Number.isFinite(current) ? current : 0;
      return { kind: "pool.scale", size: Math.max(0, base - 1) };
    }
    case "goal.dispatch":
      if (!intent.value) return null;
      return { kind: "goal.dispatch", objective: intent.value };
    // Fleet surface (`fleet-view.ts`): refresh/probe are top-level; the
    // per-worker actions carry the workerId via `data-worker-id`, which the
    // renderer's delegated click handler passes through as `value`.
    case "fleet.refresh":
      return { kind: "fleet.list" };
    case "fleet.probe":
      return { kind: "fleet.probe" };
    case "fleet.hibernate":
      if (!intent.value) return null;
      return { kind: "fleet.hibernate", workerId: intent.value };
    case "fleet.wake":
      if (!intent.value) return null;
      return { kind: "fleet.wake", workerId: intent.value };
    case "fleet.terminate":
      if (!intent.value) return null;
      return { kind: "fleet.terminate", workerId: intent.value };
    default:
      return null;
  }
}
