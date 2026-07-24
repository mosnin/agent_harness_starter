/**
 * Pure keypress -> action mapping for the interactive TUI. No I/O, no
 * process.stdin here — `TuiApp` feeds raw key strings in (as they'd arrive
 * from a readline "keypress" handler or a raw-mode stdin reader) and this
 * module decides what they mean given the current input mode.
 *
 * Key strings follow common terminal conventions:
 *  - printable characters arrive as themselves, e.g. "g", "+", "a"
 *  - Enter arrives as "\r" or "\n" (or the literal "return")
 *  - Backspace arrives as "\x7f" or "\b" (or the literal "backspace")
 *  - Ctrl-C arrives as "\x03" (or the literal "ctrl-c")
 *  - Arrow keys arrive as their ANSI escape sequences (or "up"/"down"/
 *    "left"/"right")
 */

export type TuiAction =
  | { kind: "dispatch"; objective: string }
  | { kind: "scale"; delta: number }
  | { kind: "cancel" }
  | { kind: "nav"; dir: 1 | -1 }
  | { kind: "toggle-help" }
  | { kind: "quit" }
  | { kind: "input"; char: string }
  | { kind: "submit" }
  | { kind: "backspace" }
  /** Switch the dashboard to a secondary pane (FLEET / SHOWDOWN — see
   *  `./fleet-pane.ts` / `./showdown-pane.ts`). Only produced in view mode. */
  | { kind: "pane"; pane: "fleet" | "showdown" }
  | { kind: "none" };

const ENTER_KEYS = new Set(["\r", "\n", "return", "enter"]);
const BACKSPACE_KEYS = new Set(["\x7f", "\b", "backspace", "delete"]);
const QUIT_KEYS = new Set(["\x03", "ctrl-c", "q"]);
const DOWN_KEYS = new Set(["\x1b[B", "down"]);
const UP_KEYS = new Set(["\x1b[A", "up"]);

/**
 * Map a raw key to a `TuiAction` given the current mode.
 *
 * - "view" mode: single-key commands drive the dashboard (navigate, scale
 *   the pool, cancel the active goal, toggle help, start composing a new
 *   goal, quit).
 * - "compose" mode: keys build up an objective string; only Enter (submit),
 *   Backspace, and quit keys are special-cased, everything else printable
 *   is appended to the input buffer.
 */
export function keyToAction(key: string, mode: "view" | "compose"): TuiAction {
  if (mode === "compose") {
    if (ENTER_KEYS.has(key)) return { kind: "submit" };
    if (BACKSPACE_KEYS.has(key)) return { kind: "backspace" };
    if (key === "\x03" || key === "ctrl-c") return { kind: "quit" };
    if (key === "\x1b" || key === "escape") return { kind: "cancel" };
    if (isPrintable(key)) return { kind: "input", char: key };
    return { kind: "none" };
  }

  // view mode
  if (QUIT_KEYS.has(key)) return { kind: "quit" };
  if (key === "g") return { kind: "dispatch", objective: "" };
  if (key === "+" || key === "=") return { kind: "scale", delta: 1 };
  if (key === "-" || key === "_") return { kind: "scale", delta: -1 };
  if (key === "c") return { kind: "cancel" };
  if (key === "f") return { kind: "pane", pane: "fleet" };
  if (key === "s") return { kind: "pane", pane: "showdown" };
  if (key === "?") return { kind: "toggle-help" };
  if (DOWN_KEYS.has(key)) return { kind: "nav", dir: 1 };
  if (UP_KEYS.has(key)) return { kind: "nav", dir: -1 };
  return { kind: "none" };
}

function isPrintable(key: string): boolean {
  return key.length === 1 && key >= " " && key !== "\x7f";
}
