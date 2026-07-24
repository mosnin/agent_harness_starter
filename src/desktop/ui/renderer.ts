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

import { initialState, reduce, selectors } from "../core/app-store";
import type { AppState } from "../core/app-store";
import { renderShell, intentToCommand, esc } from "./shell";
import type { NavKey } from "./shell";
import { renderRunView, renderWorkerGrid } from "./run-view";
import { renderTrustView } from "./trust-view";
import { renderSkillsView } from "./skills-view";
import { renderHeadToHead, runHeadToHeadForApp } from "../core/head-to-head";
import type { AppHeadToHeadResult } from "../core/head-to-head";
import { verifyDropped } from "../core/cert-verify";
import type { CertVerifyResult } from "../core/cert-verify";
import { renderCertVerify } from "./cert-view";
import { renderVtphPanel } from "./vtph-panel";
import type { VtphInput } from "./vtph-panel";
import { initialFleetState, applyFleetEvent, renderFleetView } from "./fleet-view";
import type { FleetViewState } from "./fleet-view";
import type { FleetEvent } from "../ipc/contract";
import {
  initialPaletteState,
  paletteReduce,
  renderPalette,
  DEFAULT_ENTRIES,
  createPaletteEntries,
} from "./command-palette";
import type { PaletteState, PaletteAction, PaletteEntry } from "./command-palette";
import type { Command } from "../ipc/contract";
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
  /** Open/close/drive the command palette overlay. */
  palette(action: PaletteAction): void;
  /** Run the real in-memory head-to-head benchmark and cache the result (Compare view). */
  runCompare(): void;
  /** Verify a pasted certificate with real ed25519 and cache the result (Trust view). */
  verifyCert(input: string): void;
  /** Full app frame (shell + active nav's content + any overlay) for the current state. */
  html(): string;
  destroy(): void;
}

/** Renderer-local (non-engine) view state the async surfaces accumulate. */
interface ViewExt {
  compare: { running: boolean; result: AppHeadToHeadResult | null };
  cert: CertVerifyResult | null;
  /** Pre-rendered V-TPH$ panel HTML (renderVtphPanel is async, so it is cached). */
  vtphHtml: string | null;
  /** Remote-compute fleet state, reduced from `fleet.*` events by the fleet view's own pure reducer. */
  fleet: FleetViewState;
}

/** Narrow an AppEvent to the fleet slice of the union. */
function asFleetEvent(ev: { kind: string }): FleetEvent | null {
  return ev.kind === "fleet.snapshot" || ev.kind === "fleet.worker.upsert" || ev.kind === "fleet.error"
    ? (ev as FleetEvent)
    : null;
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

function renderTrustAndCert(state: AppState, cert: CertVerifyResult | null): string {
  return `${renderTrustView(state)}
  <section class="run-section" aria-label="Verify a certificate">
    <h2 class="run-section-title">Verify a certificate</h2>
    <p class="settings-row">Paste a STYX certificate JSON to check its ed25519 signature and trace.</p>
    <textarea class="cert-input" id="cert-input" rows="4" placeholder="Paste certificate JSON here"></textarea>
    <div class="settings-actions">
      <button type="button" class="btn btn-primary btn-sm" data-cmd="cert.verify" data-input="cert-input">Verify certificate</button>
    </div>
    ${renderCertVerify(cert)}
  </section>`;
}

function renderCompareView(ext: ViewExt): string {
  const runningNote = ext.compare.running
    ? `<p class="settings-row">Running the in-memory benchmark&hellip;</p>`
    : "";
  return `<div class="compare-view">
    <section class="run-section" aria-label="Head to head">
      <h2 class="run-section-title">Head to head vs the flat baseline</h2>
      <div class="settings-actions">
        <button type="button" class="btn btn-primary btn-sm" data-cmd="compare.run"${ext.compare.running ? " disabled" : ""}>Run benchmark</button>
      </div>
      ${runningNote}
      ${renderHeadToHead(ext.compare.result)}
    </section>
  </div>`;
}

function renderMetricsView(ext: ViewExt): string {
  const panel = ext.vtphHtml ?? `<p class="settings-row">Computing V-TPH$&hellip;</p>`;
  return `<div class="metrics-view">
    <section class="run-section" aria-label="V-TPH dollar">
      ${panel}
    </section>
  </div>`;
}

function contentFor(nav: NavKey, state: AppState, ext: ViewExt): string {
  switch (nav) {
    case "run":
      return renderRunView(state);
    case "trust":
      return renderTrustAndCert(state, ext.cert);
    case "skills":
      return renderSkillsView(state);
    case "workers":
      return renderWorkersView(state);
    case "fleet":
      return renderFleetView(ext.fleet);
    case "compare":
      return renderCompareView(ext);
    case "metrics":
      return renderMetricsView(ext);
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
  opts?: { initialNav?: NavKey; onRender?: (html: string) => void; now?: () => number }
): AppController {
  const now = opts?.now ?? Date.now;
  let state: AppState = initialState();
  let nav: NavKey = opts?.initialNav ?? "run";
  let paletteState: PaletteState = initialPaletteState();

  const ext: ViewExt = {
    compare: { running: false, result: null },
    cert: null,
    vtphHtml: null,
    fleet: initialFleetState(),
  };
  // Renderer-owned clock/history for the honest V-TPH$ input (the pure engine
  // store carries no wall clock). runStartedAt is stamped when the runtime
  // first comes up and cleared when it stops.
  let runStartedAt: number | null = null;
  let vtphHistory: number[] = [];

  function paletteEntries(): PaletteEntry[] {
    return createPaletteEntries({ poolSize: state.poolSize });
  }

  function html(): string {
    const overlay = paletteState.open ? renderPalette(paletteState, paletteEntries()) : "";
    return renderShell({ state, active: nav }, contentFor(nav, state, ext), overlay);
  }

  function emit(): void {
    if (!opts?.onRender) return;
    try {
      opts.onRender(html());
    } catch {
      // Never let a render callback's failure break the controller.
    }
  }

  function vtphInput(): VtphInput {
    const m = state.metrics;
    const verifiedTasks = m ? m.verifiedTasks : selectors.verifiedCount(state);
    const costUsd = m ? m.costUsd : 0;
    const elapsedMs = runStartedAt !== null ? Math.max(0, now() - runStartedAt) : 0;
    return { verifiedTasks, costUsd, elapsedMs, history: vtphHistory.slice(-32) };
  }

  // renderVtphPanel is async; compute it off the current state and cache the
  // HTML, then re-render. Never throws into the caller.
  function refreshVtph(): void {
    const input = vtphInput();
    void renderVtphPanel(input)
      .then((panelHtml) => {
        ext.vtphHtml = panelHtml;
        if (nav === "metrics") emit();
      })
      .catch(() => {
        /* leave the last cached panel in place */
      });
  }

  let unsubscribe: () => void = () => {};
  try {
    unsubscribe =
      bridge.onEvent((ev) => {
        // Fleet events feed the fleet view's own pure reducer; they are
        // handled before (and independently of) the app-store reduce so a
        // reducer failure on either side never starves the other.
        const fleetEv = asFleetEvent(ev);
        if (fleetEv) {
          try {
            ext.fleet = applyFleetEvent(ext.fleet, fleetEv);
          } catch {
            // Malformed fleet event: leave fleet state untouched.
          }
        }
        try {
          state = reduce(state, ev);
        } catch {
          // Malformed or unrecognized event: leave state untouched.
          return;
        }
        // Track the run clock honestly off real runtime.status transitions.
        if (ev.kind === "runtime.status") {
          if (ev.running && runStartedAt === null) runStartedAt = now();
          if (!ev.running) runStartedAt = null;
        }
        // Keep the V-TPH$ panel fresh whenever the metrics surface is visible.
        if (nav === "metrics") refreshVtph();
        emit();
      }) ?? (() => {});
  } catch {
    // A bridge that throws on subscribe still yields a usable, static controller.
    unsubscribe = () => {};
  }

  function send(cmd: Command | null): void {
    if (!cmd) return;
    try {
      bridge.send(cmd);
    } catch {
      // A throwing bridge must never crash the UI.
    }
  }

  // If the app opens directly on the metrics surface, kick the async compute
  // once so the panel resolves instead of sitting on the "Computing…" state.
  if (nav === "metrics") refreshVtph();

  const controller: AppController = {
    getState() {
      return state;
    },
    setNav(key: NavKey) {
      nav = key;
      // Entering the metrics surface kicks an async compute of the panel.
      if (key === "metrics") refreshVtph();
      // Entering the fleet surface refreshes the (probe-free) snapshot so
      // the view is never stale; the reply streams back as a fleet.snapshot.
      if (key === "fleet") send({ kind: "fleet.list" });
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
    palette(action: PaletteAction) {
      try {
        const { state: next, command } = paletteReduce(paletteState, action, paletteEntries());
        paletteState = next;
        if (command) send(command);
        emit();
      } catch {
        // A palette action must never crash the UI.
      }
    },
    runCompare() {
      if (ext.compare.running) return;
      ext.compare.running = true;
      emit();
      void runHeadToHeadForApp()
        .then((result) => {
          ext.compare.result = result;
        })
        .catch(() => {
          /* keep the previous result; running flag is cleared below */
        })
        .finally(() => {
          ext.compare.running = false;
          if (nav === "compare") emit();
        });
    },
    verifyCert(input: string) {
      void verifyDropped(input)
        .then((result) => {
          ext.cert = result;
          if (nav === "trust") emit();
        })
        .catch(() => {
          /* verifyDropped is itself throw-safe; ignore defensively */
        });
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

  // Fleet worker actions (`fleet-view.ts`) carry their target as
  // `data-worker-id`; surface it as the intent value.
  const workerId = el.getAttribute("data-worker-id");
  if (workerId !== null) return workerId;

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
  // Tracks whether the palette query field held focus before the last render,
  // so focus + caret can be restored across the full-innerHTML re-render.
  let restorePaletteFocus = false;

  const app = createApp(bridge, {
    onRender(nextHtml) {
      try {
        root.innerHTML = nextHtml;
        if (restorePaletteFocus) {
          const field = root.querySelector('[data-palette-field="query"]') as
            | HTMLInputElement
            | null;
          if (field) {
            field.focus();
            const end = field.value.length;
            try {
              field.setSelectionRange(end, end);
            } catch {
              // some input types disallow setSelectionRange; ignore
            }
          }
        }
      } catch {
        // no-op if root isn't a real DOM node
      }
    },
  });

  // Actions handled locally by the controller (not wire Commands). Returns true
  // if it consumed the data-cmd.
  function handleLocalCmd(cmd: string, el: Element): boolean {
    if (cmd === "compare.run") {
      app.runCompare();
      return true;
    }
    if (cmd === "cert.verify") {
      const value = readIntentValue(root, el) ?? "";
      app.verifyCert(value);
      return true;
    }
    return false;
  }

  function onClick(evt: Event): void {
    try {
      const target = evt.target as Element | null;
      if (!target || typeof target.closest !== "function") return;

      const palEl = target.closest("[data-palette]");
      if (palEl) {
        const kind = palEl.getAttribute("data-palette");
        if (kind === "open") app.palette({ type: "open" });
        else if (kind === "close") app.palette({ type: "close" });
        else if (kind === "cancelInput") app.palette({ type: "cancelInput" });
        return;
      }

      const cmdEl = target.closest("[data-cmd]");
      if (cmdEl) {
        const cmd = cmdEl.getAttribute("data-cmd");
        if (cmd) {
          restorePaletteFocus = false;
          if (!handleLocalCmd(cmd, cmdEl)) {
            const value = readIntentValue(root, cmdEl);
            app.dispatchIntent({ cmd, value });
          }
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

  function onKeydown(evt: KeyboardEvent): void {
    try {
      const key = evt.key;
      const mod = evt.metaKey || evt.ctrlKey;
      if (mod && (key === "k" || key === "K")) {
        evt.preventDefault();
        restorePaletteFocus = true;
        app.palette({ type: "open" });
        return;
      }
      // Everything below only applies while the palette is open.
      if (!app.getState) return;
      const paletteOpen = root.querySelector('[data-palette-open="true"]');
      if (!paletteOpen) return;

      if (key === "Escape") {
        restorePaletteFocus = false;
        app.palette({ type: "close" });
        evt.preventDefault();
      } else if (key === "ArrowDown") {
        restorePaletteFocus = true;
        app.palette({ type: "next" });
        evt.preventDefault();
      } else if (key === "ArrowUp") {
        restorePaletteFocus = true;
        app.palette({ type: "prev" });
        evt.preventDefault();
      } else if (key === "Enter") {
        restorePaletteFocus = false;
        app.palette({ type: "execute" });
        evt.preventDefault();
      }
    } catch {
      // A key handler must never throw back into the webview.
    }
  }

  function onInput(evt: Event): void {
    try {
      const target = evt.target as Element | null;
      if (!target || typeof target.getAttribute !== "function") return;
      const field = target.getAttribute("data-palette-field");
      if (!field) return;
      const value = (target as HTMLInputElement).value ?? "";
      restorePaletteFocus = field === "query";
      if (field === "query") app.palette({ type: "setQuery", query: value });
      else if (field === "input") app.palette({ type: "setInput", value });
    } catch {
      // no-op
    }
  }

  try {
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeydown as EventListener);
    root.addEventListener("input", onInput);
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
