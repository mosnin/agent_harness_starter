import { renderTui, type TuiState } from "./render";
import { keyToAction } from "./keymap";

/**
 * The subset of swarm control the interactive TUI needs. A thin adapter over
 * whatever wires the manager/coordinator together — kept minimal so the app
 * (and its tests) never depend on real process/network I/O.
 */
export interface TuiController {
  dispatchGoal(objective: string): void;
  scalePool(delta: number): void;
  cancel(): void;
}

export interface TuiAppOptions {
  width?: number;
  controller?: TuiController;
}

const HELP_LINES = [
  "  g       start a new goal (compose mode)",
  "  +/-     scale worker pool up/down",
  "  c       cancel the active goal",
  "  ↑/↓     navigate the task list",
  "  ?       toggle this help overlay",
  "  q       quit  (also Ctrl-C)",
  "  (compose mode) type to build the objective, Enter to submit, Esc to cancel",
];

/**
 * Interactive, keyboard-driven TUI as a pure state machine: feed it a
 * `TuiState` snapshot via `setState`, feed it raw keys via `handleKey`, read
 * the screen via `frame()`. No direct terminal I/O happens inside this
 * class — a thin main-loop elsewhere is responsible for piping stdin keys in
 * and `frame()` output to stdout. That separation is what makes this fully
 * unit-testable without a real TTY.
 */
export class TuiApp {
  private readonly width: number;
  private readonly controller?: TuiController;

  private state: TuiState = {};
  private currentMode: "view" | "compose" = "view";
  private composeBuffer = "";
  private helpVisible = false;
  private selectedIndex = 0;

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

  /** Advance the state machine one keypress. May invoke the controller. */
  handleKey(key: string): { quit?: boolean } {
    const action = keyToAction(key, this.currentMode);

    switch (action.kind) {
      case "quit":
        return { quit: true };

      case "dispatch":
        // Only produced for "g" in view mode (with an empty objective) —
        // start composing. A real dispatch call is issued on "submit".
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

  /** Render the full screen: dashboard + compose bar + footer/help. */
  frame(): string {
    const dashboard = renderTui(this.state, this.width);
    const lines = dashboard.split("\n");
    this.applySelectionHighlight(lines);

    const out = [...lines];
    out.push(this.renderComposeBar());
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
    return "  [g] new goal  [+/-] scale pool  [c] cancel  [↑/↓] nav  [?] help  [q] quit";
  }

  private renderHelp(): string[] {
    return ["  ── HELP ──────────────────────────────", ...HELP_LINES];
  }
}
