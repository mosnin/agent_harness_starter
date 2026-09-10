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
import {
  initialSchedulePaneState,
  schedulePaneKey,
  renderSchedulePane,
  type SchedulePaneState,
  type SchedulePaneJobRow,
  type SchedulePaneRunRow,
  type SchedulePaneTally,
} from "./schedule-pane";
import {
  initSkillTrustPane,
  skillTrustPaneKey,
  renderSkillTrustPane,
  type SkillTrustPaneState,
  type SkillTrustPaneRow,
} from "./skill-trust-pane";
import {
  composeInit,
  composeKey,
  composeText,
  renderCompose,
  type ComposeState,
} from "./compose";
import {
  TUI_COMMAND_SPECS,
  acInit,
  acUpdate,
  acKey,
  renderAutocomplete,
  type AcState,
  type SlashIntent,
} from "./autocomplete";
import {
  recallInit,
  recallKey,
  renderRecallBar,
  type RecallState,
  type RecallEffect,
  type RecallEntry,
  type RecallEntryKind,
} from "./recall";
import {
  interruptInit,
  interruptOpen,
  interruptKey,
  renderInterruptOverlay,
  type InterruptState,
  type InterruptIntent,
} from "./interrupt";
import {
  streamInit,
  streamAppend,
  streamKey,
  streamTick,
  renderToolStream,
  type ToolStreamState,
  type ToolStreamEvent,
} from "./tool-stream";
import {
  laneInit,
  laneApply,
  laneKey,
  vtphReadout,
  renderVerifyLane,
  type VerifyLaneState,
  type VerifyEvent,
  type VtphInput,
} from "./verify-lane";
import {
  initReplay,
  replayReduce,
  currentFrame,
  renderHistoryList,
  renderReplayBar,
  type GoalRun,
  type ReplayState,
  type ReplayAction,
} from "./history";

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
  /** SCHEDULE pane refresh request (`r` while the pane is open, and on open).
   *  Central wiring reads the real `JobStore` (`buildSchedulePaneSnapshot`
   *  over `<dataDir>/schedule.json`) and feeds it back via
   *  {@link TuiApp.setScheduleData}; absent, the pane keeps its honest
   *  "no scheduled jobs" / "runner: not attached" empty state. */
  refreshSchedule?(): void;
  /** SKILLS/TRUST pane refresh request (`r` while the pane is open, and on
   *  open). Central wiring reads the real, fail-closed `SkillTrustReader`
   *  (`src/hades/skills/trust-selection.ts` over `<dataDir>/skill-trust.json`
   *  + `<dataDir>/skill-track.json`) and feeds rows back via
   *  {@link TuiApp.setSkillTrustData}; absent, the pane keeps its honest
   *  "no skills tracked" empty state. */
  refreshSkillTrust?(): void;
  /** Abort a specific goal (INTERRUPT overlay "abort" intent). Central wiring
   *  maps this to `handle.cancelGoal(goalId)`. Absent, the overlay falls back
   *  to the plain `cancel()` above (which targets the most recent goal). */
  abortGoal?(goalId: string): void;
  /** Supersede `goalId` with a fresh objective (INTERRUPT overlay "redirect"
   *  intent). Central wiring MUST apply the locked sequence:
   *  `cancelGoal(goalId)` THEN `dispatchGoal(objective)` — cancel the
   *  superseded goal before dispatching its replacement so the two never run
   *  concurrently. Absent, the app falls back to `cancel()` + `dispatchGoal`. */
  redirectGoal?(goalId: string, objective: string): void;
  /** Persist one line of operator input into durable recall history
   *  (`RecallStore` under the real dataDir — central wiring owns the file and
   *  the clock; the app never touches fs or `Date.now`). After appending,
   *  wiring feeds the refreshed entries back via {@link TuiApp.setRecallEntries}. */
  recordRecall?(text: string, kind: RecallEntryKind): void;
}

export interface TuiAppOptions {
  width?: number;
  controller?: TuiController;
}

/** Which full-screen surface the TUI is currently showing. */
export type TuiPane =
  | "dashboard"
  | "fleet"
  | "showdown"
  | "gateway"
  | "schedule"
  | "trust"
  | "history"
  | "verify"
  | "stream";

const HELP_LINES = [
  "  g       start a new goal (compose mode)",
  "  +/-     scale worker pool up/down",
  "  c       cancel the active goal",
  "  esc     interrupt the running goal (resume / abort / redirect)",
  "  ↑/↓     navigate the task list",
  "  f       toggle the FLEET pane (backends / workers / routing bandit)",
  "  s       toggle the SHOWDOWN pane (swarm vs baseline V-TPH$)",
  "  w       toggle the GATEWAY pane (platform probes / engine / traffic / badges)",
  "  d       toggle the SCHEDULE pane (cron jobs / runs / outcome tally)",
  "  t       toggle the SKILLS/TRUST pane (per-skill trust status + calibration)",
  "  h       toggle the HISTORY pane (past goal runs + frame replay)",
  "  v       toggle the VERIFY LANE pane (STYX gate rulings + live V-TPH$)",
  "  o       toggle the STREAM pane (live tool-output tail, ring-buffered)",
  "  ?       toggle this help overlay",
  "  q       quit  (also Ctrl-C)",
  "  (fleet pane) ↑/↓ or j/k select worker, r refresh, esc/q back",
  "  (showdown pane) r run a modeled showdown, esc/q back",
  "  (gateway pane) ↑/↓ scroll traffic, pgup/pgdn/home/end jump, r refresh, esc/q back",
  "  (schedule pane) ↑/↓ or j/k select job, home/end jump, r refresh, esc/q back",
  "  (trust pane) ↑/↓ or j/k select skill, s toggle sort, enter reasons, r refresh, esc/q back",
  "  (history pane) ↑/↓ select run, ←/→ scrub frames, home/end jump, esc/q back",
  "  (verify pane) ↑/↓ scroll rows, home/end jump, esc/q back",
  "  (stream pane) ↑/↓ scroll, pgup/pgdn/home/end jump, f cycle source filter, esc/q back",
  "  (compose mode) multi-line editor: Enter submits, Alt-Enter/Ctrl-J newline,",
  "                 trailing \\ continues, Esc cancels, /command autocompletes",
  "                 (Tab/↑↓ cycle, Enter accepts), ↑ recalls history on an empty",
  "                 buffer, Ctrl-R reverse-searches past input",
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

/** SKILLS/TRUST-pane keys: row selection navigation (the pane's own keymap). */
const TRUST_NAV_KEYS: Record<string, "up" | "down"> = {
  "\x1b[A": "up",
  up: "up",
  k: "up",
  "\x1b[B": "down",
  down: "down",
  j: "down",
};

/** SKILLS/TRUST-pane keys that toggle the reasons drill-in. */
const TRUST_ENTER_KEYS = new Set(["\r", "\n", "return", "enter"]);

/** SCHEDULE-pane keys: JOBS selection navigation (the pane's own keymap). */
const SCHEDULE_NAV_KEYS: Record<string, "up" | "down" | "home" | "end"> = {
  "\x1b[A": "up",
  up: "up",
  k: "up",
  "\x1b[B": "down",
  down: "down",
  j: "down",
  "\x1b[H": "home",
  home: "home",
  "\x1b[F": "end",
  end: "end",
};

/** STREAM-pane keys -> `streamKey` actions (raw ANSI sequences + literals). */
const STREAM_NAV_KEYS: Record<string, "up" | "down" | "pgup" | "pgdn" | "home" | "end"> = {
  "\x1b[A": "up",
  up: "up",
  k: "up",
  "\x1b[B": "down",
  down: "down",
  j: "down",
  "\x1b[5~": "pgup",
  pageup: "pgup",
  "\x1b[6~": "pgdn",
  pagedown: "pgdn",
  "\x1b[H": "home",
  home: "home",
  "\x1b[F": "end",
  end: "end",
};

/** VERIFY-pane keys -> `laneKey` actions. */
const VERIFY_NAV_KEYS: Record<string, "up" | "down" | "home" | "end"> = {
  "\x1b[A": "up",
  up: "up",
  k: "up",
  "\x1b[B": "down",
  down: "down",
  j: "down",
  "\x1b[H": "home",
  home: "home",
  "\x1b[F": "end",
  end: "end",
};

/** HISTORY-pane replay scrub keys -> `replayReduce` actions. */
const HISTORY_SCRUB_KEYS: Record<string, ReplayAction> = {
  "\x1b[D": "prev",
  left: "prev",
  "\x1b[C": "next",
  right: "next",
  "\x1b[H": "first",
  home: "first",
  "\x1b[F": "last",
  end: "last",
};

const UP_KEY_SET = new Set(["\x1b[A", "up"]);
const DOWN_KEY_SET = new Set(["\x1b[B", "down"]);
const ESC_KEY_SET = new Set(["\x1b", "escape"]);

/** Rows of the compose editor's visible window (box adds 2 border lines). */
const COMPOSE_ROWS = 5;
/** Rows of the STREAM pane's event window. */
const STREAM_ROWS = 16;
/** Rows of the VERIFY LANE pane's task window. */
const VERIFY_ROWS = 8;

/**
 * Interactive, keyboard-driven TUI as a pure state machine: feed it a
 * `TuiState` snapshot via `setState`, feed it raw keys via `handleKey`, read
 * the screen via `frame()`. No direct terminal I/O happens inside this
 * class — a thin main-loop elsewhere is responsible for piping stdin keys in
 * and `frame()` output to stdout. That separation is what makes this fully
 * unit-testable without a real TTY.
 *
 * Beyond the main dashboard, the secondary full-screen panes are wired in:
 * FLEET (`f`), SHOWDOWN (`s`), GATEWAY (`w`), SCHEDULE (`d`), SKILLS/TRUST
 * (`t`), HISTORY (`h` — past goal runs + frame replay, fed via
 * {@link setHistoryRuns}), VERIFY LANE (`v` — STYX gate rulings + live
 * V-TPH$, fed via {@link applyVerifyEvent}/{@link setVtphInput}), and STREAM
 * (`o` — the live tool-output tail, fed via {@link applyStreamEvent}). All
 * render honest empty/idle states until real data actually arrives — nothing
 * is fabricated to fill a box.
 *
 * Compose mode is a real multi-line editor (`./compose.ts`) with
 * slash-command autocomplete (`./autocomplete.ts`) and durable history
 * recall (`./recall.ts`'s pure reducer — the fs-backed store lives in
 * central wiring). Esc on the dashboard while a goal is running opens the
 * INTERRUPT overlay (`./interrupt.ts`): resume, confirm-abort, or type a
 * redirect that supersedes the goal while preserving completed work.
 */
export class TuiApp {
  private readonly width: number;
  private readonly controller?: TuiController;

  private state: TuiState = {};
  private currentMode: "view" | "compose" = "view";
  private compose: ComposeState = composeInit();
  private ac: AcState = acInit();
  private recall: RecallState = recallInit();
  private recallEntries: RecallEntry[] = [];
  private interrupt: InterruptState = interruptInit();
  private activeGoal: { goalId: string; objective: string } | null = null;
  private helpVisible = false;
  private selectedIndex = 0;
  private pane: TuiPane = "dashboard";
  private fleetPane: FleetPaneState = emptyFleetPaneState();
  private showdownPane: ShowdownPaneState = initialShowdownPaneState();
  private gatewayPane: GatewayPaneState = gatewayPaneInit();
  private schedulePane: SchedulePaneState = initialSchedulePaneState();
  private skillTrustPane: SkillTrustPaneState = initSkillTrustPane([]);
  private stream: ToolStreamState = streamInit();
  private verifyLane: VerifyLaneState = laneInit();
  /** Honest default: an unwired/short run reads "V-TPH$ n/a (run too short)" — never a fabricated figure. */
  private vtph: VtphInput = { verifiedCount: 0, wallMs: 0, costUsd: 0 };
  private historyRuns: GoalRun[] = [];
  private historySelected = 0;
  private replay: ReplayState | null = null;

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

  /**
   * Feed a real schedule snapshot (typically `buildSchedulePaneSnapshot()`
   * over the real `JobStore` — see `src/hades/cli/tui-command.ts`'s central
   * wiring). Selection/scroll are preserved (re-clamped against the new JOBS
   * list by the pane's own windowing on next render/key). `runnerRunning`
   * must be the honest truth: `null` when no `SchedulerRunner` is attached
   * to this process at all (the TUI itself never runs one), never a guess.
   */
  setScheduleData(data: {
    jobs: SchedulePaneJobRow[];
    runs: SchedulePaneRunRow[];
    tally: SchedulePaneTally | null;
    runnerRunning: boolean | null;
  }): void {
    const maxSelected = Math.max(0, data.jobs.length - 1);
    this.schedulePane = {
      ...this.schedulePane,
      jobs: data.jobs,
      runs: data.runs,
      tally: data.tally,
      runnerRunning: data.runnerRunning,
      selected: Math.min(this.schedulePane.selected, maxSelected),
      scroll: Math.min(this.schedulePane.scroll, maxSelected),
    };
  }

  /** Read-only view of the SCHEDULE pane's current state (for the main loop / tests). */
  scheduleState(): SchedulePaneState {
    return this.schedulePane;
  }

  /**
   * Feed real per-skill trust rows (typically `SkillTrustReader.rows()` output
   * from `src/hades/skills/trust-selection.ts`, mapped field-for-field into
   * the pane's structural `SkillTrustPaneRow` — see `hades tui`'s central
   * wiring in `src/hades/cli/tui-command.ts`). Sort mode and the reasons
   * drill-in are preserved; the selection is re-clamped against the new row
   * list so a refresh never points past the end.
   */
  setSkillTrustData(rows: SkillTrustPaneRow[]): void {
    const maxSelected = Math.max(0, rows.length - 1);
    this.skillTrustPane = {
      ...this.skillTrustPane,
      rows,
      selected: Math.min(this.skillTrustPane.selected, maxSelected),
    };
  }

  /** Read-only view of the SKILLS/TRUST pane's current state (for the main loop / tests). */
  skillTrustState(): SkillTrustPaneState {
    return this.skillTrustPane;
  }

  // ── This cycle's feed surface (central wiring calls these; see tui-command.ts) ──

  /**
   * Tell the app which goal is currently running (set on dispatch by central
   * wiring, cleared with `null` on `goal:completed`/`failed`/`aborted`). The
   * INTERRUPT overlay only opens while a goal is actually active — an honest
   * "nothing to interrupt" otherwise — and a goal ending while the overlay is
   * open closes it (a stale overlay over a dead goal could otherwise abort or
   * redirect something that no longer exists).
   */
  setActiveGoal(goal: { goalId: string; objective: string } | null): void {
    this.activeGoal = goal;
    if (goal === null) {
      this.interrupt = interruptInit();
    }
  }

  /** The goal the app currently believes is running (for wiring/tests). */
  activeGoalInfo(): { goalId: string; objective: string } | null {
    return this.activeGoal;
  }

  /** Read-only view of the INTERRUPT overlay's current state (for the main loop / tests). */
  interruptState(): InterruptState {
    return this.interrupt;
  }

  /** Read-only view of the compose editor's current state (for the main loop / tests). */
  composeState(): ComposeState {
    return this.compose;
  }

  /** Read-only view of the autocomplete popup's current state (for the main loop / tests). */
  autocompleteState(): AcState {
    return this.ac;
  }

  /**
   * Feed the loaded recall history (a real `RecallStore.load()` result —
   * oldest-first, exactly as the store returns it). The app never touches the
   * filesystem itself; central wiring owns the store and refreshes this after
   * every `recordRecall` append.
   */
  setRecallEntries(entries: RecallEntry[]): void {
    this.recallEntries = entries;
  }

  /** Append one normalized swarm event to the STREAM pane's ring buffer. */
  applyStreamEvent(ev: ToolStreamEvent): void {
    this.stream = streamAppend(this.stream, ev);
  }

  /** Advance the STREAM pane's spinner one frame (the main loop decides the cadence). */
  tickStream(): void {
    this.stream = streamTick(this.stream);
  }

  /** Read-only view of the STREAM pane's current state (for the main loop / tests). */
  toolStreamState(): ToolStreamState {
    return this.stream;
  }

  /** Advance the VERIFY LANE pane's pure reducer (run-start / task rulings / run-end). */
  applyVerifyEvent(ev: VerifyEvent): void {
    this.verifyLane = laneApply(this.verifyLane, ev);
  }

  /** Read-only view of the VERIFY LANE pane's current state (for the main loop / tests). */
  verifyLaneState(): VerifyLaneState {
    return this.verifyLane;
  }

  /**
   * Feed the real V-TPH$ inputs (`metrics.tasks.verified`,
   * `metrics.usage.costUsd`, and wall-clock ms since the lane's `run-start`)
   * — central wiring derives every figure from the live engine and its own
   * clock; the app never computes or invents one. Until this is called the
   * readout stays the honest "V-TPH$ n/a (run too short)".
   */
  setVtphInput(input: VtphInput): void {
    this.vtph = input;
  }

  /**
   * Feed the recorded goal runs (a real `HistoryRecorder.list()` —
   * most-recent-first). Selection is re-clamped; the replay scrub position is
   * kept only if the selected run still exists at the same index.
   */
  setHistoryRuns(runs: GoalRun[]): void {
    this.historyRuns = runs;
    const maxSelected = Math.max(0, runs.length - 1);
    if (this.historySelected > maxSelected) {
      this.historySelected = maxSelected;
      this.replay = null;
    }
    const run = runs[this.historySelected];
    if (this.replay && (!run || this.replay.runId !== run.goalId)) {
      this.replay = null;
    }
  }

  /** Advance the state machine one keypress. May invoke the controller. */
  handleKey(key: string): { quit?: boolean } {
    // The INTERRUPT overlay claims every key while open, in any pane.
    if (this.interrupt.phase !== "idle") {
      // Integrator-level Esc symmetry: the overlay's own reducer deliberately
      // leaves Esc at the top-level menu unbound (documented no-op), so the
      // integrator decides — here Esc closes the overlay exactly like `r`
      // (resume: the goal was never touched). Esc in the confirm/redirect
      // phases stays with the reducer (it steps back to the menu).
      if (this.interrupt.phase === "menu" && ESC_KEY_SET.has(key)) {
        this.interrupt = interruptInit();
        return {};
      }
      const { state, intent } = interruptKey(this.interrupt, key);
      this.interrupt = state;
      if (intent) this.applyInterruptIntent(intent);
      return {};
    }

    if (this.currentMode === "compose") {
      return this.handleComposeKey(key);
    }

    // Secondary panes get first claim on keys while open (view mode only) —
    // anything their keymaps don't handle falls through to the main keymap.
    if (this.pane === "fleet") {
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
    if (this.pane === "showdown") {
      if (key === "r") {
        this.controller?.runShowdown?.();
        return {};
      }
      if (key === "\x1b" || key === "escape" || key === "q") {
        this.pane = "dashboard";
        return {};
      }
    }
    if (this.pane === "gateway") {
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
    if (this.pane === "schedule") {
      const nav = SCHEDULE_NAV_KEYS[key];
      if (nav) {
        this.schedulePane = schedulePaneKey(this.schedulePane, nav);
        return {};
      }
      if (key === "r") {
        this.controller?.refreshSchedule?.();
        return {};
      }
      if (key === "\x1b" || key === "escape" || key === "q") {
        this.pane = "dashboard";
        return {};
      }
    }
    if (this.pane === "trust") {
      const nav = TRUST_NAV_KEYS[key];
      if (nav) {
        this.skillTrustPane = skillTrustPaneKey(this.skillTrustPane, nav);
        return {};
      }
      if (key === "s") {
        // Sort toggle is claimed by the pane while it is open (the dashboard's
        // own `s` = SHOWDOWN toggle stays reachable from the dashboard).
        this.skillTrustPane = skillTrustPaneKey(this.skillTrustPane, "s");
        return {};
      }
      if (TRUST_ENTER_KEYS.has(key)) {
        this.skillTrustPane = skillTrustPaneKey(this.skillTrustPane, "enter");
        return {};
      }
      if (key === "r") {
        this.controller?.refreshSkillTrust?.();
        return {};
      }
      if (key === "\x1b" || key === "escape" || key === "q") {
        this.pane = "dashboard";
        return {};
      }
    }
    if (this.pane === "history") {
      if (UP_KEY_SET.has(key) || key === "k") {
        this.moveHistorySelection(-1);
        return {};
      }
      if (DOWN_KEY_SET.has(key) || key === "j") {
        this.moveHistorySelection(1);
        return {};
      }
      const scrub = HISTORY_SCRUB_KEYS[key];
      if (scrub) {
        const run = this.historyRuns[this.historySelected];
        if (run) {
          const base = this.replay && this.replay.runId === run.goalId ? this.replay : initReplay(run);
          this.replay = replayReduce(run, base, scrub);
        }
        return {};
      }
      if (key === "\x1b" || key === "escape" || key === "q") {
        this.pane = "dashboard";
        return {};
      }
    }
    if (this.pane === "verify") {
      const nav = VERIFY_NAV_KEYS[key];
      if (nav) {
        this.verifyLane = laneKey(this.verifyLane, nav);
        return {};
      }
      if (key === "\x1b" || key === "escape" || key === "q") {
        this.pane = "dashboard";
        return {};
      }
    }
    if (this.pane === "stream") {
      const nav = STREAM_NAV_KEYS[key];
      if (nav) {
        this.stream = streamKey(this.stream, nav);
        return {};
      }
      if (key === "f") {
        // Source-filter cycle is claimed by the pane while it is open (the
        // dashboard's own `f` = FLEET toggle stays reachable from there).
        this.stream = streamKey(this.stream, "f");
        return {};
      }
      if (key === "\x1b" || key === "escape" || key === "q") {
        this.pane = "dashboard";
        return {};
      }
    }

    // Esc on the dashboard: interrupt the running goal (honest no-op when
    // nothing is running — you cannot interrupt what is not there).
    if (ESC_KEY_SET.has(key) && this.pane === "dashboard") {
      this.interrupt = interruptOpen(this.interrupt, this.activeGoal);
      return {};
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
          this.openPane(action.pane);
        }
        return {};

      case "dispatch":
        // Only produced for "g" in view mode (with an empty objective) —
        // start composing. A real dispatch call is issued on "submit".
        this.pane = "dashboard";
        this.enterCompose(action.objective ?? "");
        return {};

      case "input":
      case "backspace":
      case "submit":
        // Compose-mode-only actions; unreachable here since compose mode is
        // handled by handleComposeKey above. Kept for exhaustiveness.
        return {};

      case "cancel":
        this.controller?.cancel();
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

  // ── Compose mode (multi-line editor + autocomplete + recall) ──────────────

  private enterCompose(seed: string): void {
    this.currentMode = "compose";
    this.compose = composeInit(seed);
    this.ac = seed.length > 0 ? acUpdate(acInit(), TUI_COMMAND_SPECS, seed) : acInit();
    this.recall = recallInit();
  }

  private exitCompose(): void {
    this.currentMode = "view";
    this.compose = composeInit();
    this.ac = acInit();
    this.recall = recallInit();
  }

  private handleComposeKey(key: string): { quit?: boolean } {
    if (key === "\x03" || key === "ctrl-c") {
      return { quit: true };
    }

    // Reverse-i-search owns every key while active (arrows and unrelated
    // control bytes are swallowed by the reducer, never leak into the buffer).
    if (this.recall.mode === "search" || key === "\x12" || key === "ctrl-r") {
      const r = recallKey(this.recall, key === "ctrl-r" ? "\x12" : key, this.recallEntries, composeText(this.compose));
      this.recall = r.state;
      if (r.effect) this.applyRecallEffect(r.effect);
      return {};
    }

    // The autocomplete popup gets the next claim while open: Enter accepts,
    // Tab/Shift-Tab/↑/↓ cycle, Esc dismisses (first Esc closes the popup, a
    // second Esc cancels compose — the documented two-stage precedence).
    if (this.ac.open) {
      const r = acKey(this.ac, key);
      if (r.effect !== null || r.state !== this.ac) {
        this.ac = r.state;
        if (r.effect?.kind === "accept") {
          const current = composeText(this.compose);
          // A fully-typed command keeps its exact-match popup open, so a
          // no-op accept (completion === what's already typed) on Enter must
          // submit-through — otherwise Enter could only ever re-accept and
          // "/fleet⏎" would be unreachable. Tab's accept never submits.
          const isEnter = key === "\r" || key === "\n" || key === "return" || key === "enter";
          if (isEnter && r.effect.completed.trim() === current.trim()) {
            this.compose = composeInit();
            return this.handleComposeSubmit(current.trim());
          }
          this.compose = composeInit(r.effect.completed);
          this.recall = recallInit();
        }
        return {};
      }
      // Unconsumed (a printable, backspace, …): fall through to the editor.
    }

    // ↑ on a fresh (single empty line) buffer starts history recall; ↑/↓
    // while already cycling keep walking it. Otherwise arrows belong to the
    // editor's cursor.
    const isUp = UP_KEY_SET.has(key);
    const isDown = DOWN_KEY_SET.has(key);
    if (
      (this.recall.mode === "cycling" && (isUp || isDown)) ||
      (this.recall.mode === "idle" && isUp && composeText(this.compose) === "")
    ) {
      const raw = isUp ? "\x1b[A" : "\x1b[B";
      const r = recallKey(this.recall, raw, this.recallEntries, composeText(this.compose));
      this.recall = r.state;
      if (r.effect) this.applyRecallEffect(r.effect);
      return {};
    }
    if (this.recall.mode === "cycling") {
      // Any other key ends the recall session; the recalled text stays in the
      // buffer and normal editing takes over from it.
      this.recall = recallInit();
    }

    const before = composeText(this.compose);
    const { state, effect } = composeKey(this.compose, key);
    this.compose = state;

    if (effect?.kind === "cancel") {
      this.exitCompose();
      return {};
    }
    if (effect?.kind === "submit") {
      return this.handleComposeSubmit(effect.text);
    }

    const after = composeText(this.compose);
    if (after !== before) {
      this.ac = acUpdate(this.ac, TUI_COMMAND_SPECS, after);
    }
    return {};
  }

  private handleComposeSubmit(text: string): { quit?: boolean } {
    this.ac = acInit();
    this.recall = recallInit();
    if (text.startsWith("/")) {
      return this.executeSlash(text);
    }
    this.currentMode = "view";
    this.controller?.recordRecall?.(text, "goal");
    this.controller?.dispatchGoal(text);
    return {};
  }

  /**
   * Execute a submitted slash command. The token is matched exactly (name or
   * alias, case-insensitive) against `TUI_COMMAND_SPECS` — an unknown command
   * is an honest no-op that stays in compose with the text intact (and the
   * popup re-offering suggestions) rather than dispatching "/typo" as a goal.
   */
  private executeSlash(text: string): { quit?: boolean } {
    const firstLine = text.split("\n")[0] ?? "";
    const body = firstLine.slice(1);
    const wsIdx = body.search(/\s/);
    const token = (wsIdx === -1 ? body : body.slice(0, wsIdx)).toLowerCase();
    const args = wsIdx === -1 ? "" : body.slice(wsIdx).trim();
    const spec = TUI_COMMAND_SPECS.find(
      (s) => s.name.toLowerCase() === token || (s.aliases ?? []).some((a) => a.toLowerCase() === token)
    );

    if (!spec) {
      this.compose = composeInit(text);
      this.ac = acUpdate(acInit(), TUI_COMMAND_SPECS, text);
      return {};
    }

    this.controller?.recordRecall?.(text, "slash");
    return this.applySlashIntent(spec.intent, args);
  }

  private applySlashIntent(intent: SlashIntent, args: string): { quit?: boolean } {
    switch (intent.kind) {
      case "dispatch-goal":
        if (args.length > 0) {
          this.currentMode = "view";
          this.controller?.dispatchGoal(args);
        } else {
          // "/goal" with no argument: fresh compose buffer, keep composing.
          this.compose = composeInit();
        }
        return {};
      case "scale":
        this.currentMode = "view";
        this.controller?.scalePool(intent.delta);
        return {};
      case "cancel":
        this.currentMode = "view";
        this.controller?.cancel();
        return {};
      case "toggle-help":
        this.currentMode = "view";
        this.helpVisible = !this.helpVisible;
        return {};
      case "quit":
        return { quit: true };
      case "interrupt":
        this.currentMode = "view";
        // Honest: opens only when a goal is actually running.
        this.interrupt = interruptOpen(this.interrupt, this.activeGoal);
        return {};
      case "open-pane": {
        this.currentMode = "view";
        this.openPane(intent.pane);
        return {};
      }
      default: {
        const _exhaustive: never = intent;
        return _exhaustive;
      }
    }
  }

  private applyRecallEffect(effect: RecallEffect): void {
    // Both effects replace the live buffer (restore-draft restores the text
    // stashed when recall began). Cursor lands at the end of the text.
    this.compose = composeInit(effect.text);
    this.ac = acInit();
  }

  private applyInterruptIntent(intent: InterruptIntent): void {
    switch (intent.kind) {
      case "resume":
        return; // overlay already reset itself; the goal was never touched
      case "abort":
        if (this.controller?.abortGoal) {
          this.controller.abortGoal(intent.goalId);
        } else {
          this.controller?.cancel();
        }
        this.activeGoal = null;
        return;
      case "redirect":
        this.controller?.recordRecall?.(intent.objective, "redirect");
        if (this.controller?.redirectGoal) {
          this.controller.redirectGoal(intent.goalId, intent.objective);
        } else if (this.controller) {
          // Fallback preserves the locked sequence: cancel the superseded
          // goal, THEN dispatch its replacement.
          this.controller.cancel();
          this.controller.dispatchGoal(intent.objective);
        }
        this.activeGoal = null;
        return;
      default: {
        const _exhaustive: never = intent;
        void _exhaustive;
      }
    }
  }

  private openPane(pane: Exclude<TuiPane, "dashboard">): void {
    this.pane = pane;
    // Opening a data-backed pane asks central wiring for fresh data so the
    // first frame is never stale.
    if (pane === "fleet") this.controller?.refreshFleet?.();
    if (pane === "gateway") this.controller?.refreshGateway?.();
    if (pane === "schedule") this.controller?.refreshSchedule?.();
    if (pane === "trust") this.controller?.refreshSkillTrust?.();
  }

  private moveHistorySelection(dir: 1 | -1): void {
    const max = Math.max(0, this.historyRuns.length - 1);
    const next = Math.min(max, Math.max(0, this.historySelected + dir));
    if (next !== this.historySelected) {
      this.historySelected = next;
      this.replay = null; // a new run scrubs from its first frame
    }
  }

  /** Render the full screen: active pane + compose editor + footer/help. */
  frame(): string {
    const out: string[] = [];

    if (this.currentMode === "view" && this.pane === "fleet") {
      out.push(...renderFleetPane(this.fleetPane, this.width).split("\n"));
    } else if (this.currentMode === "view" && this.pane === "showdown") {
      out.push(...renderShowdownPane(this.showdownPane, this.width).split("\n"));
    } else if (this.currentMode === "view" && this.pane === "gateway") {
      // renderGatewayPane returns string[] (one entry per line) by contract.
      out.push(...renderGatewayPane(this.gatewayPane, this.width));
    } else if (this.currentMode === "view" && this.pane === "schedule") {
      // renderSchedulePane returns string[] (one entry per line) by contract.
      out.push(...renderSchedulePane(this.schedulePane, this.width));
    } else if (this.currentMode === "view" && this.pane === "trust") {
      // renderSkillTrustPane returns string[] (one entry per line) by contract.
      out.push(...renderSkillTrustPane(this.skillTrustPane, this.width));
    } else if (this.currentMode === "view" && this.pane === "history") {
      out.push(...this.renderHistoryPane());
    } else if (this.currentMode === "view" && this.pane === "verify") {
      out.push(...renderVerifyLane(this.verifyLane, vtphReadout(this.vtph), this.width, VERIFY_ROWS));
    } else if (this.currentMode === "view" && this.pane === "stream") {
      out.push("  ── STREAM ─ live tool output ──");
      out.push(...renderToolStream(this.stream, this.width, STREAM_ROWS, this.activeGoal !== null));
    } else {
      const dashboard = renderTui(this.state, this.width);
      const lines = dashboard.split("\n");
      this.applySelectionHighlight(lines);
      out.push(...lines);
      if (this.currentMode === "compose") {
        out.push(...renderCompose(this.compose, this.width, COMPOSE_ROWS));
        out.push(...renderAutocomplete(this.ac, this.width));
        const bar = renderRecallBar(this.recall, this.recallEntries, this.width);
        if (bar.length > 0) out.push(bar);
        out.push(this.renderComposePreview());
      } else {
        out.push("  [view mode]");
      }
    }

    if (this.interrupt.phase !== "idle") {
      out.push(...renderInterruptOverlay(this.interrupt, this.width));
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

  /** One-line submit preview under the editor (multi-line text joins with ⏎). */
  private renderComposePreview(): string {
    const preview = composeText(this.compose).split("\n").join("⏎");
    return `  > goal: ${preview}`;
  }

  private renderHistoryPane(): string[] {
    const out: string[] = [];
    out.push("  ── HISTORY ─ past goal runs (newest first) ──");
    out.push(...renderHistoryList(this.historyRuns, this.historySelected).split("\n"));
    const run = this.historyRuns[this.historySelected];
    if (run) {
      const rep = this.replay && this.replay.runId === run.goalId ? this.replay : initReplay(run);
      out.push("");
      out.push(`  ${renderReplayBar(run, rep)}`);
      const frame = currentFrame(run, rep);
      if (frame) {
        out.push(...renderTui(frame, this.width).split("\n"));
      } else {
        out.push("  (no frames recorded for this run)");
      }
    }
    return out;
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
    if (this.currentMode === "view" && this.pane === "schedule") {
      return "  [↑/↓ j/k] select job  [home/end] jump  [r] refresh  [esc/q] back  [?] help";
    }
    if (this.currentMode === "view" && this.pane === "trust") {
      return "  [↑/↓ j/k] select skill  [s] sort  [enter] reasons  [r] refresh  [esc/q] back  [?] help";
    }
    if (this.currentMode === "view" && this.pane === "history") {
      return "  [↑/↓ j/k] select run  [←/→] scrub frames  [home/end] jump  [esc/q] back  [?] help";
    }
    if (this.currentMode === "view" && this.pane === "verify") {
      return "  [↑/↓ j/k] scroll  [home/end] jump  [esc/q] back  [?] help";
    }
    if (this.currentMode === "view" && this.pane === "stream") {
      return "  [↑/↓ j/k] scroll  [pgup/pgdn/home/end] jump  [f] filter source  [esc/q] back  [?] help";
    }
    if (this.currentMode === "compose") {
      return "  [enter] submit  [alt-enter] newline  [tab] complete  [↑] recall  [ctrl-r] search  [esc] cancel";
    }
    return "  [g] new goal  [+/-] scale pool  [c] cancel  [esc] interrupt  [↑/↓] nav  [f] fleet  [s] showdown  [w] gateway  [d] schedule  [t] trust  [h] history  [v] verify  [o] stream  [?] help  [q] quit";
  }

  private renderHelp(): string[] {
    return ["  ── HELP ──────────────────────────────", ...HELP_LINES];
  }
}
