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
import { initialLearningState, applyLearningEvent, renderLearningCard } from "./learning-card";
import type { LearningCardState } from "./learning-card";
import { createFleetProvisionView } from "./fleet-provision-view";
import type { FleetProvisionViewHandle, FleetProvisionWire } from "./fleet-provision-view";
import { mountFleetConflictsView } from "./fleet-conflicts-view";
import type { FleetConflictsViewHandle } from "./fleet-conflicts-view";
import { deriveConflictsLaneFromRestored, extractPlaceholderNotice } from "../core/fleet-conflicts";
import type { FleetEvent, FleetProvisionEvent, LearningEvent } from "../ipc/contract";
import {
  initialPaletteState,
  paletteReduce,
  renderPalette,
  DEFAULT_ENTRIES,
  createPaletteEntries,
} from "./command-palette";
import type { PaletteState, PaletteAction, PaletteEntry } from "./command-palette";
import { initialStateSlice, reduceState } from "../core/state-slice";
import type { StateSlice } from "../core/state-slice";
import {
  initialStateViewState,
  isStateViewDomain,
  renderStateView,
  type StateViewState,
} from "./state-view";
import type { StateEvent } from "../ipc/state-contract";
import type { MigrateEvent } from "../ipc/migrate-contract";
import { initialMigrateSlice, migrateBusy, reduceMigrate } from "../core/migrate-slice";
import type { MigrateSlice } from "../core/migrate-slice";
import { renderMigrateCard } from "./migrate-card";
import {
  KeyDispatcher,
  KeymapRegistry,
  defaultBindings,
  type KeyAction,
  type KeyContext,
  type KeyEventLike,
  type Platform,
} from "./keyboard-nav";
import { renderKeyboardHelp } from "./keyboard-help";
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
  /** The reduced shared-workspace slice (`state.*` events). */
  getStateSlice(): StateSlice;
  /** The currently-active nav surface. */
  getNav(): NavKey;
  setNav(key: NavKey): void;
  dispatchIntent(intent: { cmd: string; value?: string }): void;
  /**
   * Feed one keyboard event through the real keymap engine
   * (`./keyboard-nav.ts`) and perform whatever `KeyAction` it resolves to.
   * Returns true when the event was consumed (the caller should
   * `preventDefault`), false when nothing matched and the webview's default
   * behavior must stand.
   */
  handleKey(ev: KeyEventLike): boolean;
  /** Open/close/drive the command palette overlay. */
  palette(action: PaletteAction): void;
  /** Open/close/toggle the keyboard-shortcuts overlay. */
  help(op: "open" | "close" | "toggle"): void;
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
  /** Swarm learning-loop state, reduced from `learning.*` events by the learning card's own pure reducer. */
  learning: LearningCardState;
  /** Shared-workspace state, reduced from `state.*` events by `../core/state-slice.ts`'s pure reducer. */
  state: StateSlice;
  /** Renderer-owned Workspace view state (selected domain + key filter) — never on the wire. */
  stateView: StateViewState;
  /** Migration state, reduced from `migrate.*` events by `../core/migrate-slice.ts`'s pure reducer. */
  migrate: MigrateSlice;
}

/** Narrow an AppEvent to the fleet slice of the union. */
function asFleetEvent(ev: { kind: string }): FleetEvent | null {
  return ev.kind === "fleet.snapshot" || ev.kind === "fleet.worker.upsert" || ev.kind === "fleet.error"
    ? (ev as FleetEvent)
    : null;
}

/** Narrow an AppEvent to the fleet-provision slice of the union (consumed by
 *  the provision panel's own live-DOM view, not by the app-store reducer). */
function asFleetProvisionEvent(ev: { kind: string }): FleetProvisionEvent | null {
  return ev.kind === "fleet.provisioned" || ev.kind === "fleet.provision.error" || ev.kind === "fleet.restored"
    ? (ev as FleetProvisionEvent)
    : null;
}

/** Narrow an AppEvent to the learning slice of the union (consumed by the
 *  learning card's own pure reducer, not by the app-store reducer). */
function asLearningEvent(ev: { kind: string }): LearningEvent | null {
  return ev.kind === "learning.status" || ev.kind === "learning.error" ? (ev as LearningEvent) : null;
}

/** Narrow an AppEvent to the shared-workspace slice of the union (consumed by
 *  `../core/state-slice.ts`'s pure reducer, not by the app-store reducer). */
function asStateEvent(ev: { kind: string }): StateEvent | null {
  return ev.kind === "state.status" ||
    ev.kind === "state.records" ||
    ev.kind === "state.changed" ||
    ev.kind === "state.synced" ||
    ev.kind === "state.error"
    ? (ev as StateEvent)
    : null;
}

/** Narrow an AppEvent to the migration slice of the union (consumed by
 *  `../core/migrate-slice.ts`'s pure reducer, not by the app-store reducer). */
function asMigrateEvent(ev: { kind: string }): MigrateEvent | null {
  return ev.kind === "migrate.sources" ||
    ev.kind === "migrate.plan" ||
    ev.kind === "migrate.applied" ||
    ev.kind === "migrate.receipts" ||
    ev.kind === "migrate.error"
    ? (ev as MigrateEvent)
    : null;
}

/**
 * Which modifier means "mod" on this machine. Read from the real
 * `navigator.platform`/`userAgent` when there is one, defaulting to
 * `"other"` (Ctrl) outside a browser — never guessed from anything else.
 */
function detectPlatform(): Platform {
  try {
    const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
    const hint = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
    return /mac|iphone|ipad|ipod/i.test(hint) ? "mac" : "other";
  } catch {
    return "other";
  }
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
      // The provision panel is a persistent live-DOM view (it owns typed
      // form state), so the string renderer only emits a stable host node;
      // mountApp re-parents the panel's real DOM into it after each render.
      return `${renderFleetView(ext.fleet)}
      ${renderLearningCard(ext.learning)}
      <div id="fleet-provision-host" class="fleet-provision-host" data-testid="fleet-provision-host"></div>
      <div id="fleet-conflicts-host" class="fleet-conflicts-host" data-testid="fleet-conflicts-host"></div>`;
    case "compare":
      return renderCompareView(ext);
    case "metrics":
      return renderMetricsView(ext);
    case "state":
      return renderStateView(ext.state, ext.stateView);
    case "settings":
      // The migration card lives in Settings deliberately: it is a one-time
      // onboarding action, not a daily surface, so it does not earn its own
      // nav entry (and cannot silently shift the positional `mod+<n>` nav
      // bindings by adding one).
      return `${renderSettingsView(state)}
      ${renderMigrateCard(ext.migrate)}`;
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
  opts?: {
    initialNav?: NavKey;
    onRender?: (html: string) => void;
    now?: () => number;
    /** Override the detected keyboard platform (mac = Cmd is `mod`). */
    platform?: Platform;
  }
): AppController {
  const now = opts?.now ?? Date.now;
  let state: AppState = initialState();
  let nav: NavKey = opts?.initialNav ?? "run";
  let paletteState: PaletteState = initialPaletteState();
  let helpOpen = false;

  const ext: ViewExt = {
    compare: { running: false, result: null },
    cert: null,
    vtphHtml: null,
    fleet: initialFleetState(),
    learning: initialLearningState(),
    state: initialStateSlice(),
    stateView: initialStateViewState(),
    migrate: initialMigrateSlice(),
  };

  // The REAL keymap engine (`./keyboard-nav.ts`) replaces what used to be a
  // four-key inline handler: every NavKey is reachable by `g <letter>` and
  // `mod+<n>`, the palette and the help sheet have their own bindings, and
  // Escape unwinds overlay -> palette -> pending chord in a fixed order.
  const platform: Platform = opts?.platform ?? detectPlatform();
  const registry = new KeymapRegistry(defaultBindings());
  const dispatcher = new KeyDispatcher({ registry, platform, now });
  // Renderer-owned clock/history for the honest V-TPH$ input (the pure engine
  // store carries no wall clock). runStartedAt is stamped when the runtime
  // first comes up and cleared when it stops.
  let runStartedAt: number | null = null;
  let vtphHistory: number[] = [];

  function paletteEntries(): PaletteEntry[] {
    return createPaletteEntries({ poolSize: state.poolSize });
  }

  /** The live `KeyContext` the dispatcher scopes bindings against. */
  function keyContext(): KeyContext {
    return {
      nav,
      overlayOpen: helpOpen,
      paletteOpen: paletteState.open,
      // The dispatcher's own text-entry guard also reads `ev.targetEditable`
      // / `ev.targetTag`; this flag covers the case the DOM cannot answer —
      // the palette's query field is focused whenever it is open.
      editing: paletteState.open,
      running: state.running,
      listSize: 0,
      listIndex: 0,
      platform,
    };
  }

  function html(): string {
    // Only one overlay is ever mounted: the help sheet traps the keyboard,
    // so it wins over the palette when both would be open.
    const overlay = helpOpen
      ? renderKeyboardHelp(registry, keyContext())
      : paletteState.open
        ? renderPalette(paletteState, paletteEntries())
        : "";
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
        // Learning events feed the learning card's own pure reducer, same
        // isolation contract as the fleet slice above.
        const learningEv = asLearningEvent(ev);
        if (learningEv) {
          try {
            ext.learning = applyLearningEvent(ext.learning, learningEv);
          } catch {
            // Malformed learning event: leave learning state untouched.
          }
        }
        // Workspace-state events feed `../core/state-slice.ts`'s pure
        // reducer, same isolation contract as the two slices above. The
        // clock is injected so the reducer stays a pure function.
        const stateEv = asStateEvent(ev);
        if (stateEv) {
          try {
            ext.state = reduceState(ext.state, stateEv, now);
          } catch {
            // Malformed state event: leave the workspace slice untouched.
          }
        }
        // Migration events feed `../core/migrate-slice.ts`'s pure reducer,
        // same isolation contract as the slices above.
        const migrateEv = asMigrateEvent(ev);
        if (migrateEv) {
          try {
            ext.migrate = reduceMigrate(ext.migrate, migrateEv);
          } catch {
            // Malformed migrate event: leave the migration slice untouched.
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
  // Same for the Workspace surface: opening straight onto it must load real
  // data and arm the live feed, exactly as navigating to it does — otherwise
  // it would sit on "the sidecar has not answered" forever.
  if (nav === "state") {
    send({ kind: "state.watch", enabled: true });
    refreshWorkspace();
  }

  /** Ask the sidecar for a fresh status + record page for the selected domain. */
  function refreshWorkspace(): void {
    send({ kind: "state.status" });
    send({ kind: "state.list", domain: ext.stateView.domain });
  }

  /**
   * Local (non-wire) Workspace actions plus the wire ones that need the
   * renderer's own selected domain. Returns true when the command was
   * consumed here. Every wire command it sends is a REAL `state.*` command
   * the sidecar's `StateService` answers — nothing is faked locally.
   */
  function handleStateCmd(cmd: string, value?: string): boolean {
    switch (cmd) {
      case "state.domain": {
        if (value && isStateViewDomain(value)) {
          ext.stateView = { ...ext.stateView, domain: value };
          send({ kind: "state.list", domain: value });
          emit();
        }
        return true;
      }
      case "state.filter": {
        ext.stateView = { ...ext.stateView, filter: value ?? "" };
        emit();
        return true;
      }
      case "state.refresh":
        refreshWorkspace();
        return true;
      case "state.sync":
        send({ kind: "state.sync" });
        refreshWorkspace();
        return true;
      case "state.sync.plan":
        send({ kind: "state.sync", dryRun: true });
        return true;
      case "state.delete": {
        if (!value) return true;
        send({ kind: "state.delete", domain: ext.stateView.domain, key: value });
        send({ kind: "state.list", domain: ext.stateView.domain });
        send({ kind: "state.status" });
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Migration intents (Settings' Import card). Every one of them sends a
   * REAL `migrate.*` wire command answered by the sidecar's `MigrateService`
   * — nothing is simulated in the renderer. `migrate.apply` carries
   * `confirm: true` ONLY from the explicit Import button, and the button is
   * disabled while a plan is missing or blocked. Returns true when the
   * intent was consumed here.
   */
  function handleMigrateCmd(cmd: string): boolean {
    switch (cmd) {
      case "migrate.scan":
        ext.migrate = migrateBusy(ext.migrate);
        send({ kind: "migrate.scan" });
        emit();
        return true;
      case "migrate.plan":
        ext.migrate = migrateBusy(ext.migrate);
        send({ kind: "migrate.plan" });
        emit();
        return true;
      case "migrate.apply": {
        // Refuse locally too: a blocked (or absent) plan must never produce
        // a confirmed apply, even if the disabled button were bypassed.
        if (!ext.migrate.plan || ext.migrate.plan.blockers.length > 0) return true;
        ext.migrate = migrateBusy(ext.migrate);
        send({ kind: "migrate.apply", confirm: true });
        send({ kind: "migrate.receipts" });
        emit();
        return true;
      }
      case "migrate.receipts":
        ext.migrate = migrateBusy(ext.migrate);
        send({ kind: "migrate.receipts" });
        emit();
        return true;
      default:
        return false;
    }
  }

  /**
   * Perform one resolved `KeyAction`. Returns whether the shell actually
   * DID something — a key the shell cannot act on must be handed back to the
   * webview rather than silently swallowed (that is what would break Space
   * to scroll, or Enter on a focused button).
   */
  function runKeyAction(action: KeyAction): boolean {
    switch (action.type) {
      case "nav":
        controller.setNav(action.to);
        return true;
      case "command":
        send(action.command);
        return true;
      case "palette":
        controller.palette({ type: action.op === "open" ? "open" : "close" });
        return true;
      case "help":
        controller.help(action.op);
        return true;
      case "focus":
        // `focus.escape` is the dispatcher's terminal unwind step: nothing
        // was open and no chord was pending, so there is nothing to close.
        // List motion only reaches here when a view has published a focus
        // ring (`KeyContext.listSize > 0`); no shell view does yet, so this
        // reports "not handled" rather than faking a selection.
        return false;
      case "view": {
        // The generic per-view verbs, mapped to each surface's REAL refresh
        // path — never a fabricated no-op that still eats the keystroke.
        if (action.op === "refresh") {
          switch (nav) {
            case "state":
              refreshWorkspace();
              return true;
            case "fleet":
              send({ kind: "fleet.list" });
              send({ kind: "learning.get" });
              return true;
            case "skills":
              send({ kind: "skills.list" });
              return true;
            case "compare":
              controller.runCompare();
              return true;
            case "metrics":
              refreshVtph();
              return true;
            default:
              return false;
          }
        }
        if (action.op === "compose") {
          // "Start something new" — the palette is the app's real entry point
          // for that, and it carries the goal-dispatch action.
          controller.palette({ type: "open" });
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  const controller: AppController = {
    getState() {
      return state;
    },
    getStateSlice() {
      return ext.state;
    },
    getNav() {
      return nav;
    },
    setNav(key: NavKey) {
      const previous = nav;
      nav = key;
      // Entering the metrics surface kicks an async compute of the panel.
      if (key === "metrics") refreshVtph();
      // Entering the Workspace surface pulls a fresh status + record page and
      // turns the sidecar's live feed ON, so a `hades state set` typed into a
      // terminal streams in as a `state.changed` while the view is open.
      // Leaving it turns the feed back off — no background timer or fs.watch
      // is left running for a surface nobody is looking at.
      if (key === "state") {
        send({ kind: "state.watch", enabled: true });
        refreshWorkspace();
      } else if (previous === "state") {
        send({ kind: "state.watch", enabled: false });
      }
      // Entering the fleet surface refreshes the (probe-free) snapshot so
      // the view is never stale; the reply streams back as a fleet.snapshot.
      // The learning card refreshes alongside it — the reply streams back as
      // a learning.status (or an honest learning.error).
      if (key === "fleet") {
        send({ kind: "fleet.list" });
        send({ kind: "learning.get" });
      }
      emit();
    },
    dispatchIntent(intent: { cmd: string; value?: string }) {
      try {
        // Workspace intents need the renderer's own selected domain, so they
        // are resolved here rather than by the stateless `intentToCommand`.
        if (handleStateCmd(intent.cmd, intent.value)) return;
        if (handleMigrateCmd(intent.cmd)) return;
        const cmd = intentToCommand(intent);
        if (!cmd) return;
        bridge.send(cmd);
      } catch {
        // Guard: a bad intent or a throwing bridge must never crash the UI.
      }
    },
    handleKey(ev: KeyEventLike): boolean {
      try {
        const hadPending = dispatcher.pending().length > 0;
        const result = dispatcher.handle(ev, keyContext());
        const handled = result.action ? runKeyAction(result.action) : false;
        // Consume the event when: the shell actually performed the action;
        // a chord is now pending (`g` awaiting its second key, which must
        // not reach the webview as a bare keystroke); or a pending chord was
        // just cancelled (Escape mid-sequence — that IS work, even though
        // the resulting `focus.escape` action is a no-op for the shell).
        // Anything else is handed back to the webview rather than swallowed.
        return handled || result.pending.length > 0 || (hadPending && result.pending.length === 0);
      } catch {
        // A key handler must never throw back into the webview.
        return false;
      }
    },
    palette(action: PaletteAction) {
      try {
        const { state: next, command } = paletteReduce(paletteState, action, paletteEntries());
        paletteState = next;
        // Two modal overlays must never be mounted at once: opening the
        // palette closes the help sheet.
        if (paletteState.open) helpOpen = false;
        if (command) send(command);
        emit();
      } catch {
        // A palette action must never crash the UI.
      }
    },
    help(op: "open" | "close" | "toggle") {
      try {
        const next = op === "toggle" ? !helpOpen : op === "open";
        if (next === helpOpen) return;
        helpOpen = next;
        // Same mutual exclusion as above, from the other direction.
        if (helpOpen && paletteState.open) {
          paletteState = paletteReduce(paletteState, { type: "close" }, paletteEntries()).state;
        }
        emit();
      } catch {
        // A help toggle must never crash the UI.
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
  // Same problem, same fix, for the Workspace view's key filter: it re-renders
  // on every keystroke, so focus + caret must be restored after each frame.
  let restoreStateFilterFocus = false;

  // The fleet-provision panel is a persistent live-DOM view
  // (`./fleet-provision-view.ts`): it owns typed form state (worker id,
  // capability chips, ...) that a full-innerHTML re-render would destroy, so
  // it is built ONCE into a detached element and re-parented into the fleet
  // view's `#fleet-provision-host` after every render — moving an existing
  // DOM node preserves its input state.
  let provisionPanel: HTMLElement | null = null;
  let provisionHandle: FleetProvisionViewHandle | null = null;
  function ensureProvisionPanel(): HTMLElement | null {
    if (provisionPanel) return provisionPanel;
    try {
      const panel = document.createElement("div");
      const wire: FleetProvisionWire = {
        send(cmd) {
          try {
            bridge.send(cmd);
          } catch {
            // A throwing bridge must never crash the provision panel.
          }
        },
        onEvent(cb) {
          return bridge.onEvent((ev) => {
            const provisionEv = asFleetProvisionEvent(ev);
            if (provisionEv) cb(provisionEv);
          });
        },
      };
      provisionHandle = createFleetProvisionView(panel, wire);
      provisionPanel = panel;
    } catch {
      // A non-DOM environment (or a view bug) must never break the shell;
      // the fleet view simply renders without the provision panel.
      provisionPanel = null;
      provisionHandle = null;
    }
    return provisionPanel;
  }

  function reparentProvisionPanel(): void {
    try {
      const host = root.querySelector("#fleet-provision-host");
      if (!host) return;
      const panel = ensureProvisionPanel();
      if (panel) host.appendChild(panel);
    } catch {
      // no-op if root isn't a real DOM node
    }
  }

  // The conflicts lane (`./fleet-conflicts-view.ts`) is the same kind of
  // persistent live-DOM view: built once, fed from the real `fleet.restored`
  // / `fleet.provisioned` event stream, and re-parented into the fleet view's
  // `#fleet-conflicts-host` after every render. Its two actions send REAL
  // wire commands: rename-and-provision issues a `fleet.provision` for the
  // suggested free id, terminate-live-first issues a `fleet.terminate`.
  let conflictsPanel: HTMLElement | null = null;
  let conflictsHandle: FleetConflictsViewHandle | null = null;
  let conflictsUnsub: (() => void) | null = null;
  let lastRestored: Extract<FleetProvisionEvent, { kind: "fleet.restored" }> | null = null;
  let credentialNotice: string | undefined;
  let renameSeq = 0;

  function updateConflictsPanel(): void {
    if (!conflictsHandle) return;
    try {
      const model = deriveConflictsLaneFromRestored(
        lastRestored ?? { workers: [], dropped: [] },
        app.getState().workers.map((w) => w.id)
      );
      conflictsHandle.update(model, credentialNotice);
    } catch {
      // A malformed event must never crash the fleet surface.
    }
  }

  function ensureConflictsPanel(): HTMLElement | null {
    if (conflictsPanel) return conflictsPanel;
    try {
      const panel = document.createElement("div");
      conflictsHandle = mountFleetConflictsView(panel, {
        onRename(_workerId, suggested) {
          if (!suggested) return;
          renameSeq += 1;
          try {
            bridge.send({
              kind: "fleet.provision",
              requestId: `conflict-rename-${renameSeq}-${suggested}`,
              spec: { workerId: suggested, capabilities: [] },
            });
          } catch {
            // A throwing bridge must never crash the conflicts panel.
          }
        },
        onTerminate(workerId) {
          try {
            bridge.send({ kind: "fleet.terminate", workerId });
          } catch {
            // A throwing bridge must never crash the conflicts panel.
          }
        },
      });
      conflictsUnsub =
        bridge.onEvent((ev) => {
          if (ev.kind === "fleet.restored") {
            lastRestored = ev;
            updateConflictsPanel();
          } else if (ev.kind === "fleet.provisioned") {
            credentialNotice = extractPlaceholderNotice(ev.routing).notice;
            updateConflictsPanel();
          }
        }) ?? null;
      conflictsPanel = panel;
      updateConflictsPanel();
    } catch {
      // A non-DOM environment (or a view bug) must never break the shell.
      conflictsPanel = null;
      conflictsHandle = null;
    }
    return conflictsPanel;
  }

  function reparentConflictsPanel(): void {
    try {
      const host = root.querySelector("#fleet-conflicts-host");
      if (!host) return;
      const panel = ensureConflictsPanel();
      if (panel) host.appendChild(panel);
    } catch {
      // no-op if root isn't a real DOM node
    }
  }

  const app = createApp(bridge, {
    onRender(nextHtml) {
      try {
        root.innerHTML = nextHtml;
        reparentProvisionPanel();
        reparentConflictsPanel();
        const focusSelector = restorePaletteFocus
          ? '[data-palette-field="query"]'
          : restoreStateFilterFocus
            ? '[data-state-field="filter"]'
            : null;
        if (focusSelector) {
          const field = root.querySelector(focusSelector) as HTMLInputElement | null;
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

      const helpEl = target.closest("[data-help]");
      if (helpEl) {
        if (helpEl.getAttribute("data-help") === "close") app.help("close");
        return;
      }

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
          restoreStateFilterFocus = false;
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

  /** True when the event's target is a real text-entry control. */
  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as (Element & { isContentEditable?: boolean }) | null;
    if (!el || typeof el.tagName !== "string") return false;
    const tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  }

  function targetTagOf(target: EventTarget | null): string | undefined {
    const el = target as Element | null;
    return el && typeof el.tagName === "string" ? el.tagName.toLowerCase() : undefined;
  }

  /**
   * The single keydown entry point.
   *
   * The palette's OWN list interaction (ArrowUp/ArrowDown/Enter over its
   * results) stays here, because it is driven by `paletteReduce`'s query
   * state rather than by the keymap — `KeyDispatcher` deliberately narrows
   * to `"global"` scope while the palette is open, leaving that lane clear.
   * Everything else — `mod+K`, `?`, `g <letter>`, `mod+<n>`, Escape's fixed
   * unwind order — goes through the REAL `KeyDispatcher`.
   */
  function onKeydown(evt: KeyboardEvent): void {
    try {
      const paletteOpen = !!root.querySelector('[data-palette-open="true"]');
      if (paletteOpen) {
        const key = evt.key;
        if (key === "ArrowDown") {
          restorePaletteFocus = true;
          app.palette({ type: "next" });
          evt.preventDefault();
          return;
        }
        if (key === "ArrowUp") {
          restorePaletteFocus = true;
          app.palette({ type: "prev" });
          evt.preventDefault();
          return;
        }
        if (key === "Enter") {
          restorePaletteFocus = false;
          app.palette({ type: "execute" });
          evt.preventDefault();
          return;
        }
        if (key === "Escape") {
          restorePaletteFocus = false;
          app.palette({ type: "close" });
          evt.preventDefault();
          return;
        }
      }

      const consumed = app.handleKey({
        key: evt.key,
        code: evt.code,
        ctrlKey: evt.ctrlKey,
        metaKey: evt.metaKey,
        shiftKey: evt.shiftKey,
        altKey: evt.altKey,
        repeat: evt.repeat,
        targetTag: targetTagOf(evt.target),
        targetEditable: isEditableTarget(evt.target),
      });
      if (consumed) {
        // Opening the palette from the keymap must also restore focus into
        // its query field across the full-innerHTML re-render.
        restorePaletteFocus = !!root.querySelector('[data-palette-open="true"]');
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

      // Workspace key filter — renderer-local view state, never a wire
      // command, so typing in it never touches the store.
      const stateField = target.getAttribute("data-state-field");
      if (stateField === "filter") {
        restoreStateFilterFocus = true;
        app.dispatchIntent({ cmd: "state.filter", value: (target as HTMLInputElement).value ?? "" });
        return;
      }

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
      try {
        provisionHandle?.destroy();
      } catch {
        // no-op
      }
      provisionHandle = null;
      provisionPanel = null;
      try {
        conflictsUnsub?.();
      } catch {
        // no-op
      }
      try {
        conflictsHandle?.destroy();
      } catch {
        // no-op
      }
      conflictsUnsub = null;
      conflictsHandle = null;
      conflictsPanel = null;
      app.destroy();
    },
  };
}
