/**
 * Hades desktop renderer — the top-level app controller wiring the
 * Tauri-side `Bridge` (sidecar stdio transport) to the pure `app-store`
 * reducer and the pure view renderers (`shell`, `run-view`, `trust-view`,
 * `skills-view`).
 *
 * This module is the only place that owns mutable app state and the only
 * place that touches the DOM (and only inside `mountApp`). `createApp` is
 * pure-ish and DOM-free: it is fully unit-testable by pushing events through
 * a fake `Bridge` and inspecting `html()` / `getState()`, with no jsdom
 * required. `mountApp` is a thin browser entry point that wires a single
 * delegated click listener into a real DOM root and re-renders `innerHTML`
 * on every state change.
 *
 * Runs inside the Tauri webview — this is not a website. It never fetches,
 * never navigates, and talks to the local sidecar only through the injected
 * `Bridge`.
 */

import { initialState, reduce } from "../core/app-store";
import type { AppState } from "../core/app-store";
import { renderShell, intentToCommand, esc } from "./shell";
import type { NavKey } from "./shell";
import { renderRunView, renderWorkerGrid } from "./run-view";
import { renderTrustView } from "./trust-view";
import { renderSkillsView } from "./skills-view";
import type { Bridge } from "./bridge";

// Re-exported so callers of this module (e.g. `mountApp`'s wiring code, or
// tests) can name the type without also importing from `./bridge` directly.
export type { Bridge } from "./bridge";

// ---------------------------------------------------------------------------
// AppController
// ---------------------------------------------------------------------------

export interface AppController {
  getState(): AppState;
  setNav(key: NavKey): void;
  dispatchIntent(intent: { cmd: string; value?: string }): void;
  /** Full app frame (shell + active nav's content) for the current state. */
  html(): string;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Nav content
// ---------------------------------------------------------------------------

function renderWorkersView(state: AppState): string {
  return `<div class="workers-view">
    <section class="run-section" aria-label="Workers">
      <h2 class="run-section-title">Worker pool</h2>
      ${renderWorkerGrid(state)}
    </section>
  </div>`;
}

function renderSettingsView(state: AppState): string {
  const modeLabel = state.mode ? esc(state.mode) : "stopped";
  return `<div class="settings-view">
    <section class="run-section" aria-label="Runtime settings">
      <h2 class="run-section-title">Runtime</h2>
      <p class="settings-row">Mode: <strong>${modeLabel}</strong></p>
      <p class="settings-row">Pool size: <strong>${state.poolSize}</strong></p>
      <div class="settings-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-cmd="pool.scale.down" data-value="${state.poolSize}">&minus; Scale down</button>
        <button type="button" class="btn btn-ghost btn-sm" data-cmd="pool.scale.up" data-value="${state.poolSize}">+ Scale up</button>
        <button type="button" class="btn ${state.running ? "" : "btn-primary"}" data-cmd="${state.running ? "runtime.stop" : "runtime.start"}">
          ${state.running ? "Stop runtime" : "Start runtime"}
        </button>
      </div>
    </section>
  </div>`;
}

function contentFor(nav: NavKey, state: AppState): string {
  switch (nav) {
    case "run":
      return renderRunView(state);
    case "trust":
      return renderTrustView(state);
    case "skills":
      return renderSkillsView(state);
    case "workers":
      return renderWorkersView(state);
    case "settings":
      return renderSettingsView(state);
    default:
      // Guard against a future NavKey landing here unhandled: fall back to
      // the primary working surface rather than throwing.
      return renderRunView(state);
  }
}

// ---------------------------------------------------------------------------
// createApp — DOM-free controller
// ---------------------------------------------------------------------------

/**
 * Wires a `Bridge` to the `app-store` reducer and (optionally) a render
 * callback. Pure-ish: `html()` is fully testable without a DOM by pushing
 * events through a fake `Bridge` and reading `html()` / `getState()`.
 */
export function createApp(
  bridge: Bridge,
  opts?: { initialNav?: NavKey; onRender?: (html: string) => void }
): AppController {
  let state: AppState = initialState();
  let nav: NavKey = opts?.initialNav ?? "run";

  function html(): string {
    return renderShell({ state, active: nav }, contentFor(nav, state));
  }

  function emit(): void {
    if (!opts?.onRender) return;
    try {
      opts.onRender(html());
    } catch {
      // Never let a render callback's failure break the controller.
    }
  }

  let unsubscribe: () => void = () => {};
  try {
    unsubscribe =
      bridge.onEvent((ev) => {
        try {
          state = reduce(state, ev);
        } catch {
          // Malformed or unrecognized event: leave state untouched.
          return;
        }
        emit();
      }) ?? (() => {});
  } catch {
    // A bridge that throws on subscribe still yields a usable, static controller.
    unsubscribe = () => {};
  }

  const controller: AppController = {
    getState() {
      return state;
    },
    setNav(key: NavKey) {
      nav = key;
      emit();
    },
    dispatchIntent(intent: { cmd: string; value?: string }) {
      try {
        const cmd = intentToCommand(intent);
        if (!cmd) return;
        bridge.send(cmd);
      } catch {
        // Guard: a bad intent or a throwing bridge must never crash the UI.
      }
    },
    html,
    destroy() {
      try {
        unsubscribe();
      } catch {
        // no-op
      }
    },
  };

  return controller;
}

// ---------------------------------------------------------------------------
// mountApp — browser entry point
// ---------------------------------------------------------------------------

function readIntentValue(root: ParentNode, el: Element): string | undefined {
  const explicit = el.getAttribute("data-value");
  if (explicit !== null) return explicit;

  const inputId = el.getAttribute("data-input") ?? el.getAttribute("data-source");
  if (!inputId) return undefined;

  try {
    const input = root.querySelector(`#${inputId}`) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    return input ? input.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Browser entry point: mounts a `createApp` controller into a real DOM
 * element, delegating clicks on `[data-cmd]` / `[data-nav]` and re-rendering
 * `root.innerHTML` on every state change. Guards every DOM interaction so a
 * non-standard or missing DOM (e.g. under a test runner without jsdom) never
 * throws.
 */
export function mountApp(root: HTMLElement, bridge: Bridge): AppController {
  const app = createApp(bridge, {
    onRender(nextHtml) {
      try {
        root.innerHTML = nextHtml;
      } catch {
        // no-op if root isn't a real DOM node
      }
    },
  });

  function onClick(evt: Event): void {
    try {
      const target = evt.target as Element | null;
      if (!target || typeof target.closest !== "function") return;

      const cmdEl = target.closest("[data-cmd]");
      if (cmdEl) {
        const cmd = cmdEl.getAttribute("data-cmd");
        if (cmd) {
          const value = readIntentValue(root, cmdEl);
          app.dispatchIntent({ cmd, value });
        }
        return;
      }

      const navEl = target.closest("[data-nav]");
      if (navEl) {
        const key = navEl.getAttribute("data-nav");
        if (key) app.setNav(key as NavKey);
      }
    } catch {
      // A delegated click handler must never throw back into the webview.
    }
  }

  try {
    root.addEventListener("click", onClick);
  } catch {
    // no-op in a non-DOM environment
  }

  try {
    const maybeStart = bridge.start?.();
    if (maybeStart && typeof maybeStart.then === "function") {
      maybeStart.catch(() => {
        // Startup failures surface via the event/log stream, not here.
      });
    }
  } catch {
    // no-op
  }

  return {
    ...app,
    destroy() {
      try {
        root.removeEventListener("click", onClick);
      } catch {
        // no-op
      }
      app.destroy();
    },
  };
}
