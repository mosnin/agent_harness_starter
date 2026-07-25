import { renderTui, type TuiState } from "./render";
import { keyToAction } from "./keymap";
import {
  emptyFleetPaneState,
  renderFleetPane,
  moveFleetSelection,
  fleetKeyToAction,
  type FleetPaneState,
  type FleetPaneBackendRow,
  type FleetPaneWorkerRow,
  type FleetPaneBanditRow,
} from "./fleet-pane";
import {
  initialShowdownPaneState,
  showdownReducer,
  renderShowdownPane,
  type ShowdownPaneState,
  type ShowdownPaneEvent,
} from "./showdown-pane";
import {
  gatewayPaneInit,
  gatewayPaneApplyStatus,
  gatewayPaneAppendTraffic,
  gatewayPaneApplyBadge,
  gatewayPaneKey,
  renderGatewayPane,
  type GatewayPaneState,
  type GatewayPaneProbeRow,
  type GatewayPaneCounters,
  type GatewayPaneEngineRow,
  type GatewayPaneTrafficRow,
} from "./gateway-pane";

/**
 * The subset of swarm control the interactive TUI needs. A thin adapter over
 * whatever wires the manager/coordinator together — kept minimal so the app
 * (and its tests) never depend on real process/network I/O.
 */
export interface TuiController {
  dispatchGoal(objective: string): void;
  scalePool(delta: number): void;
  cancel(): void;
  /** FLEET pane refresh request (`r` while the pane is open, and on open).
   *  Central wiring reads the real BackendManager/route-bandit state and
   *  feeds it back via {@link TuiApp.setFleetData}; absent, the pane keeps
   *  its honest "no fleet attached" empty state. */
  refreshFleet?(): void;
  /** SHOWDOWN pane run request (`r` while the pane is open). Central wiring
   *  starts a real `runShowdown` and streams progress back via
   *  {@link TuiApp.applyShowdownEvent}; absent, `r` is a no-op and the pane
   *  stays honestly idle. */
  runShowdown?(): void;
  /** GATEWAY pane refresh request (`r` while the pane is open, and on open).
   *  Central wiring probes the real gateway env (connector report + engine
   *  probe — variable NAMES only, never credential values) and feeds it back
   *  via {@link TuiApp.applyGatewayStatus}; absent, the pane keeps its honest
   *  "no connectors probed yet" / "engine: not attached" empty state. */
  refreshGateway?(): void;
}

export interface TuiAppOptions {
  width?: number;
  controller?: TuiController;
}

/** Which full-screen surface the TUI is currently showing. */
export type TuiPane = "dashboard" | "fleet" | "showdown" | "gateway";

const HELP_LINES = [
  "  g       start a new goal (compose mode)",
  "  +/-     scale worker pool up/down",
  "  c       cancel the active goal",
  "  ↑/↓     navigate the task list",
  "  f       toggle the FLEET pane (backends / workers / routing bandit)",
  "  s       toggle the SHOWDOWN pane (swarm vs baseline V-TPH$)",
  "  w       toggle the GATEWAY pane (platform probes / engine / traffic / badges)",
  "  ?       toggle this help overlay",
  "  q       quit  (also Ctrl-C)",
  "  (fleet pane) ↑/↓ or j/k select worker, r refresh, esc/q back",
  "  (showdown pane) r run a modeled showdown, esc/q back",
  "  (gateway pane) ↑/↓ scroll traffic, pgup/pgdn/home/end jump, r refresh, esc/q back",
  "  (compose mode) type to build the objective, Enter to submit, Esc to cancel",
];

/** GATEWAY-pane keys: navigation over the TRAFFIC feed, plus refresh/back. */
const GATEWAY_NAV_KEYS: Record<string, "up" | "down" | "pageup" | "pagedown" | "home" | "end"> = {
  "\x1b[A": "up",
  up: "up",
  k: "up",
  "\x1b[B": "down",
  down: "down",
  j: "down",
  "\x1b[5~": "pageup",
  pageup: "pageup",
  "\x1b[6~": "pagedown",
  pagedown: "pagedown",
  "\x1b[H": "home",
  home: "home",
  "\x1b[F": "end",
  end: "end",
};

/**
 * Interactive, keyboard-driven TUI as a pure state machine: feed it a
 * `TuiState` snapshot via `setState`, feed it raw keys via `handleKey`, read
 * the screen via `frame()`. No direct terminal I/O happens inside this
 * class — a thin main-loop elsewhere is responsible for piping stdin keys in
 * and `frame()` output to stdout. That separation is what makes this fully
 * unit-testable without a real TTY.
 *
 * Beyond the main dashboard, two secondary full-screen panes are wired in:
 * the FLEET pane (`./fleet-pane.ts` — backends/workers/routing-bandit, fed
 * via {@link setFleetData}) on `f`, and the SHOWDOWN pane
 * (`./showdown-pane.ts` — live progress + the honest V-TPH$ table, fed via
 * {@link applyShowdownEvent}) on `s`. Both render honest empty/idle states
 * until real data actually arrives — nothing is fabricated to fill a box.
 */
export class TuiApp {
  private readonly width: number;
  private readonly controller?: TuiController;

  private state: TuiState = {};
  private currentMode: "view" | "compose" = "view";
  private composeBuffer = "";
  private helpVisible = false;
  private selectedIndex = 0;
  private pane: TuiPane = "dashboard";
  private fleetPane: FleetPaneState = emptyFleetPaneState();
  private showdownPane: ShowdownPaneState = initialShowdownPaneState();
  private gatewayPane: GatewayPaneState = gatewayPaneInit();

  constructor(opts: TuiAppOptions = {}) {
    this.width = opts.width ?? 72;
    this.controller = opts.controller;
  }

  /** Feed a fresh snapshot from the swarm. */
  setState(s: TuiState): void {
    this.state = s;
    const taskCount = (s.tasks ?? []).length;
    if (taskCount === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex > taskCount - 1) {
      this.selectedIndex = taskCount - 1;
    }
  }

  mode(): "view" | "compose" {
    return this.currentMode;
  }

  /** Which full-screen surface is currently shown. */
  activePane(): TuiPane {
    return this.pane;
  }

  /**
   * Feed real fleet rows (typically from `BackendManager.descriptors()` /
   * `.telemetry()` / `.list()` and a route-bandit `arms()` snapshot — see
   * `src/hades/cli/tui-command.ts`'s central wiring). Selection/scroll are
   * preserved (clamped to the new list) so a refresh never yanks the cursor.
   */
  setFleetData(data: {
    backends: FleetPaneBackendRow[];
    workers: FleetPaneWorkerRow[];
    bandit: FleetPaneBanditRow[];
  }): void {
    this.fleetPane = moveFleetSelection(
      { ...this.fleetPane, backends: data.backends, workers: data.workers, bandit: data.bandit },
      0
    );
  }

  /** Advance the SHOWDOWN pane's pure reducer (start/progress/done/fail). */
  applyShowdownEvent(ev: ShowdownPaneEvent): void {
    this.showdownPane = showdownReducer(this.showdownPane, ev);
  }

  /** Read-only view of the SHOWDOWN pane's current state (for the main loop / tests). */
  showdownState(): ShowdownPaneState {
    return this.showdownPane;
  }

  /**
   * Feed a real gateway status snapshot (typically `GatewayProcess.status()`'s
   * probes/counters plus an `EngineProbe` — see `src/hades/cli/tui-command.ts`'s
   * central wiring). Passing the snapshot without an `engine` key leaves the
   * pane's current engine row untouched; `engine: null` clears it explicitly.
   */
  applyGatewayStatus(snapshot: {
    probes: GatewayPaneProbeRow[];
    counters: GatewayPaneCounters;
    engine?: GatewayPaneEngineRow | null;
  }): void {
    this.gatewayPane = gatewayPaneApplyStatus(this.gatewayPane, snapshot);
  }

  /** Append one real traffic event (a ConnectorHub `Mirror` callback row) to the GATEWAY pane feed. */
  applyGatewayTraffic(row: GatewayPaneTrafficRow): void {
    this.gatewayPane = gatewayPaneAppendTraffic(this.gatewayPane, row);
  }

  /** Record one real badge assessment (a `BadgeStamper`/`assessReply` verdict) in the GATEWAY pane tally. */
  applyGatewayBadge(badge: "verified" | "abstained" | "unverified"): void {
    this.gatewayPane = gatewayPaneApplyBadge(this.gatewayPane, badge);
  }

  /** Read-only view of the GATEWAY pane's current state (for the main loop / tests). */
  gatewayState(): GatewayPaneState {
    return this.gatewayPane;
  }

  /** Advance the state machine one keypress. May invoke the controller. */
  handleKey(key: string): { quit?: boolean } {
    // Secondary panes get first claim on keys while open (view mode only) —
    // anything their keymaps don't handle falls through to the main keymap.
    if (this.currentMode === "view" && this.pane === "fleet") {
      const paneAction = fleetKeyToAction(key);
      if (paneAction === "up") {
        this.fleetPane = moveFleetSelection(this.fleetPane, -1);
        return {};
      }
      if (paneAction === "down") {
        this.fleetPane = moveFleetSelection(this.fleetPane, 1);
        return {};
      }
      if (paneAction === "refresh") {
        this.controller?.refreshFleet?.();
        return {};
      }
      if (paneAction === "back") {
        this.pane = "dashboard";
        return {};
      }
    }
    if (this.currentMode === "view" && this.pane === "showdown") {
      if (key === "r") {
        this.controller?.runShowdown?.();
        return {};
      }
      if (key === "\x1b" || key === "escape" || key === "q") {
        this.pane = "dashboard";
        return {};
      }
    }
    if (this.currentMode === "view" && this.pane === "gateway") {
      const nav = GATEWAY_NAV_KEYS[key];
      if (nav) {
        this.gatewayPane = gatewayPaneKey(this.gatewayPane, nav);
        return {};
      }
      if (key === "r") {
        this.controller?.refreshGateway?.();
        return {};
      }
      if (key === "\x1b" || key === "escape" || key === "q") {
        this.pane = "dashboard";
        return {};
      }
    }

    const action = keyToAction(key, this.currentMode);

    switch (action.kind) {
      case "quit":
        return { quit: true };

      case "pane":
        // Toggle: pressing the pane's own key again returns to the dashboard.
        if (this.pane === action.pane) {
          this.pane = "dashboard";
        } else {
          this.pane = action.pane;
          // Opening the fleet/gateway pane asks central wiring for fresh data
          // so the first frame is never stale.
          if (action.pane === "fleet") this.controller?.refreshFleet?.();
          if (action.pane === "gateway") this.controller?.refreshGateway?.();
        }
        return {};

      case "dispatch":
        // Only produced for "g" in view mode (with an empty objective) —
        // start composing. A real dispatch call is issued on "submit".
        this.pane = "dashboard";
        this.currentMode = "compose";
        this.composeBuffer = action.objective ?? "";
        return {};

      case "input":
        if (this.currentMode === "compose") {
          this.composeBuffer += action.char;
        }
        return {};

      case "backspace":
        if (this.currentMode === "compose") {
          this.composeBuffer = this.composeBuffer.slice(0, -1);
        }
        return {};

      case "submit":
        if (this.currentMode === "compose") {
          const objective = this.composeBuffer;
          this.currentMode = "view";
          this.composeBuffer = "";
          this.controller?.dispatchGoal(objective);
        }
        return {};

      case "cancel":
        if (this.currentMode === "compose") {
          this.currentMode = "view";
          this.composeBuffer = "";
        } else {
          this.controller?.cancel();
        }
        return {};

      case "scale":
        this.controller?.scalePool(action.delta);
        return {};

      case "nav": {
        const taskCount = (this.state.tasks ?? []).length;
        if (taskCount > 0) {
          this.selectedIndex = (this.selectedIndex + action.dir + taskCount) % taskCount;
        }
        return {};
      }

      case "toggle-help":
        this.helpVisible = !this.helpVisible;
        return {};

      case "none":
      default:
        return {};
    }
  }

  /** Render the full screen: active pane + compose bar + footer/help. */
  frame(): string {
    const out: string[] = [];

    if (this.currentMode === "view" && this.pane === "fleet") {
      out.push(...renderFleetPane(this.fleetPane, this.width).split("\n"));
    } else if (this.currentMode === "view" && this.pane === "showdown") {
      out.push(...renderShowdownPane(this.showdownPane, this.width).split("\n"));
    } else if (this.currentMode === "view" && this.pane === "gateway") {
      // renderGatewayPane returns string[] (one entry per line) by contract.
      out.push(...renderGatewayPane(this.gatewayPane, this.width));
    } else {
      const dashboard = renderTui(this.state, this.width);
      const lines = dashboard.split("\n");
      this.applySelectionHighlight(lines);
      out.push(...lines);
      out.push(this.renderComposeBar());
    }

    out.push(this.renderFooter());
    if (this.helpVisible) {
      out.push(...this.renderHelp());
    }
    return out.join("\n");
  }

  private applySelectionHighlight(lines: string[]): void {
    const tasks = this.state.tasks ?? [];
    if (tasks.length === 0) return;

    const taskHeaderIdx = lines.findIndex((l) => l.includes("TASKS ("));
    if (taskHeaderIdx === -1) return;

    const targetLine = taskHeaderIdx + 1 + this.selectedIndex;
    if (targetLine >= lines.length) return;

    const line = lines[targetLine];
    // swap in a selection marker just inside the box's left border.
    if (line.startsWith("│")) {
      lines[targetLine] = `│▶${line.slice(2)}`;
    }
  }

  private renderComposeBar(): string {
    if (this.currentMode !== "compose") {
      return "  [view mode]";
    }
    return `  > goal: ${this.composeBuffer}▏`;
  }

  private renderFooter(): string {
    if (this.currentMode === "view" && this.pane === "fleet") {
      return "  [↑/↓ j/k] select  [r] refresh  [esc/q] back  [?] help";
    }
    if (this.currentMode === "view" && this.pane === "showdown") {
      return "  [r] run modeled showdown  [esc/q] back  [?] help";
    }
    if (this.currentMode === "view" && this.pane === "gateway") {
      return "  [↑/↓ j/k] scroll traffic  [pgup/pgdn/home/end] jump  [r] refresh  [esc/q] back  [?] help";
    }
    return "  [g] new goal  [+/-] scale pool  [c] cancel  [↑/↓] nav  [f] fleet  [s] showdown  [w] gateway  [?] help  [q] quit";
  }

  private renderHelp(): string[] {
    return ["  ── HELP ──────────────────────────────", ...HELP_LINES];
  }
}
