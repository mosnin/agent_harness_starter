/**
 * fleet-pane.ts — pure, deterministic FLEET pane for the interactive TUI.
 *
 * Renders three sections in one box: BACKENDS (provisioned compute backends
 * and their accrued spend/latency telemetry), WORKERS (live worker pool and
 * lifecycle, selectable), and ROUTING (the multi-armed-bandit arms driving
 * backend selection, e.g. `SwarmLearningStatus`). Every function here is a
 * pure string-in/string-out or state-in/state-out transform: no I/O, no
 * timers, no ANSI escapes, no imports outside this file's own types. Data
 * arrives as plain JSON-compatible snapshots the orchestrator can populate
 * directly from `BackendManager.list()` / `BackendManager.telemetry()` and a
 * swarm's learning status, with no adapter layer required.
 *
 * Visual conventions match `render.ts` / `panes.ts`: `╭─╮ │ ├ ┤ ╰─╯` box
 * drawing, a default width of 72 code points, and a hard clamp — no line this
 * module emits ever exceeds the requested width. Width is measured in
 * Unicode code points (via `[...s].length`) so multi-byte backend/worker
 * names never desync the border.
 *
 * Honesty discipline: a backend/worker/bandit collection that is entirely
 * empty never renders as a bare, silent box — it says so explicitly. A
 * bandit arm that has never been pulled (`pulls === 0`) renders "never
 * pulled" rather than a fabricated `0.00` mean reward, since a zero-pull arm
 * has no measured reward at all.
 */

// ---------------------------------------------------------------------------
// Snapshot shapes (plain, JSON-compatible — no imports from src/hades/**)
// ---------------------------------------------------------------------------

/** One row of the BACKENDS section: a provisioned compute backend + its telemetry. */
export interface FleetPaneBackendRow {
  /** Human-readable backend name/id. */
  name: string;
  /** Backend kind/provider label (e.g. "vast", "runpod", "local"). */
  kind: string;
  /** Lifecycle/health state (e.g. "ready", "provisioning", "draining", "dead"). */
  state: string;
  /** Number of provisions performed against this backend so far. */
  provisions: number;
  /** Total accrued spend against this backend, in USD. */
  accruedUsd: number;
  /** Exponential moving average provision latency, in milliseconds. `null` = no samples yet. */
  provisionLatencyEmaMs: number | null;
}

/** One row of the WORKERS section: a live worker and its lifecycle state. */
export interface FleetPaneWorkerRow {
  /** Worker id. */
  workerId: string;
  /** Backend this worker is running on, if assigned. */
  backend?: string;
  /** Lifecycle state (e.g. "spawning", "idle", "busy", "draining", "dead"). */
  lifecycle: string;
  /** Milliseconds the worker has been idle, if applicable. */
  idleMs?: number;
}

/** One row of the ROUTING section: a bandit arm driving backend selection. */
export interface FleetPaneBanditRow {
  /** Arm name (typically a backend kind or route label). */
  name: string;
  /** Total pulls (selections) of this arm so far. */
  pulls: number;
  /** Count of pulls that were independently verified. */
  verified: number;
  /** Mean observed reward. Meaningless (and not rendered as a number) when `pulls === 0`. */
  meanReward: number;
  /** Upper-confidence-bound score used for arm selection. `null` when not computed yet. */
  ucb: number | null;
}

/**
 * The pane's full pure view-state: the three data sections plus selection and
 * scroll cursors over the WORKERS section, and the visible window height.
 * Immutable by convention — every helper below returns a fresh object.
 */
export interface FleetPaneState {
  backends: FleetPaneBackendRow[];
  workers: FleetPaneWorkerRow[];
  bandit: FleetPaneBanditRow[];
  /** Index into `workers` of the selected row, clamped to `[0, workers.length - 1]`. */
  selection: number;
  /** Rows scrolled down from the top of the WORKERS window (>= 0). */
  scroll: number;
  /** Visible row count of the WORKERS window. */
  height: number;
}

const DEFAULT_WIDTH = 72;
const DEFAULT_HEIGHT = 6;

/** A fresh, empty `FleetPaneState` — no backends, workers, or bandit arms attached yet. */
export function emptyFleetPaneState(height = DEFAULT_HEIGHT): FleetPaneState {
  return {
    backends: [],
    workers: [],
    bandit: [],
    selection: 0,
    scroll: 0,
    height: Math.max(1, Math.floor(height)),
  };
}

// ---------------------------------------------------------------------------
// Width-safe primitives (code-point counted, matching panes.ts's discipline)
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Pad or truncate (with a trailing "…") so the result is exactly `w` code points. */
function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const cps = [...s];
  if (cps.length === w) return s;
  if (cps.length < w) return s + " ".repeat(w - cps.length);
  return cps.slice(0, w - 1).join("") + "…";
}

/** A boxed block: `╭─ TITLE ─…─╮` header, padded rows, `╰─…─╯` footer, `├─…─┤` dividers. */
function boxify(title: string, sections: string[][], width: number): string {
  const inner = Math.max(0, width - 2);
  const label = title ? ` ${title} ` : "";
  const header = fit(`─${label}`, inner).replace(/ +$/g, (m) => "─".repeat(m.length));
  const out: string[] = [];
  out.push(`╭${header}╮`);
  sections.forEach((rows, i) => {
    if (i > 0) out.push(`├${"─".repeat(inner)}┤`);
    for (const r of rows) out.push(`│${fit(r, inner)}│`);
  });
  out.push(`╰${"─".repeat(inner)}╯`);
  return out.join("\n");
}

/**
 * Greedy word-wrap `text` into lines of at most `w` code points, so a fixed
 * required sentence (like the empty-fleet message) can render verbatim —
 * across as many lines as it takes — instead of being silently truncated by
 * `boxify`'s single-line `fit`. A single word longer than `w` is hard-broken
 * (still never exceeding `w`) rather than left to overflow.
 */
function wordWrap(text: string, w: number): string[] {
  if (w <= 0) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    let rest = word;
    while ([...rest].length > w) {
      // A single word longer than the box: hard-break it so no line ever exceeds w.
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      const cps = [...rest];
      lines.push(cps.slice(0, w).join(""));
      rest = cps.slice(w).join("");
    }
    const candidate = cur ? `${cur} ${rest}` : rest;
    if ([...candidate].length > w) {
      if (cur) lines.push(cur);
      cur = rest;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function usd4(v: number): string {
  return Number.isFinite(v) ? `$${v.toFixed(4)}` : "$0.0000";
}

function msFmt(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the FLEET pane: BACKENDS / WORKERS / ROUTING sections, each headed
 * by its real row count. When every section is empty, renders a single
 * explicit line instead of a silently empty box. The currently-selected
 * worker row (per `state.selection`) is marked with a leading `▸`.
 *
 * Every emitted line is exactly `width` code points wide (hard clamp): no
 * line this function returns ever exceeds `width`.
 */
export function renderFleetPane(state: FleetPaneState, width = DEFAULT_WIDTH): string {
  const { backends, workers, bandit } = state;

  if (backends.length === 0 && workers.length === 0 && bandit.length === 0) {
    const inner = Math.max(1, width - 2);
    const message = "no fleet attached — start a swarm with fleet wiring to populate this pane";
    return boxify("FLEET", [wordWrap(message, inner)], width);
  }

  const backendRows: string[] = [`BACKENDS (${backends.length})`];
  if (backends.length === 0) {
    backendRows.push("  (none provisioned)");
  } else {
    for (const b of backends) {
      backendRows.push(
        `  ${b.name}  ${b.kind}  ${b.state}  prov=${b.provisions}  ${usd4(b.accruedUsd)}  lat=${msFmt(
          b.provisionLatencyEmaMs
        )}`
      );
    }
  }

  const workerRows: string[] = [`WORKERS (${workers.length})`];
  if (workers.length === 0) {
    workerRows.push("  (no workers)");
  } else {
    const height = Math.max(1, state.height);
    const sel = clamp(Math.floor(state.selection), 0, workers.length - 1);
    const scroll = clamp(Math.floor(state.scroll), 0, Math.max(0, workers.length - height));
    const visible = workers.slice(scroll, scroll + height);
    for (let i = 0; i < visible.length; i++) {
      const w = visible[i];
      const idx = scroll + i;
      const marker = idx === sel ? "▸" : " ";
      const backend = w.backend ? ` @${w.backend}` : "";
      const idle = w.idleMs !== undefined ? `  idle=${msFmt(w.idleMs)}` : "";
      workerRows.push(`${marker} ${w.workerId}${backend}  ${w.lifecycle}${idle}`);
    }
    if (scroll > 0 || scroll + height < workers.length) {
      workerRows.push(`  (${scroll + 1}-${Math.min(workers.length, scroll + height)} of ${workers.length})`);
    }
  }

  const banditRows: string[] = [`ROUTING (${bandit.length})`];
  if (bandit.length === 0) {
    banditRows.push("  (no bandit arms)");
  } else {
    for (const a of bandit) {
      if (a.pulls === 0) {
        banditRows.push(`  ${a.name}  never pulled`);
      } else {
        const ucb = a.ucb === null || a.ucb === undefined || !Number.isFinite(a.ucb) ? "—" : a.ucb.toFixed(4);
        banditRows.push(
          `  ${a.name}  pulls=${a.pulls}  verified=${a.verified}  reward=${a.meanReward.toFixed(4)}  ucb=${ucb}`
        );
      }
    }
  }

  return boxify("FLEET", [backendRows, workerRows, banditRows], width);
}

// ---------------------------------------------------------------------------
// Pure selection/scroll state machine (windowing discipline matches
// panes.ts's moveWorkerSelection)
// ---------------------------------------------------------------------------

/**
 * Move the WORKERS selection by `delta` (typically -1/+1), clamped to
 * `[0, workers.length - 1]` (no wraparound). Scroll is adjusted so the new
 * selection stays inside the `height`-row visible window. Returns a fresh
 * `FleetPaneState`; the input is never mutated. An empty worker list clamps
 * selection to 0 and leaves scroll at 0.
 */
export function moveFleetSelection(state: FleetPaneState, delta: number): FleetPaneState {
  const n = state.workers.length;
  const height = Math.max(1, state.height);

  if (n === 0) {
    return { ...state, selection: 0, scroll: 0 };
  }

  const selection = clamp(Math.floor(state.selection) + Math.floor(delta), 0, n - 1);

  let scroll = clamp(Math.floor(state.scroll), 0, Math.max(0, n - height));
  if (selection < scroll) {
    scroll = selection;
  } else if (selection >= scroll + height) {
    scroll = selection - height + 1;
  }
  scroll = clamp(scroll, 0, Math.max(0, n - height));

  return { ...state, selection, scroll };
}

// ---------------------------------------------------------------------------
// Pure keypress -> action mapping (central app.ts merges this into its keymap)
// ---------------------------------------------------------------------------

const UP_KEYS = new Set(["\x1b[A", "up", "k"]);
const DOWN_KEYS = new Set(["\x1b[B", "down", "j"]);
const BACK_KEYS = new Set(["\x1b", "escape", "q"]);

/**
 * Map a raw key string to a FLEET-pane action: arrows/jk move the WORKERS
 * selection, `r` requests a refresh, escape/q go back. Anything else maps to
 * `null` (not handled by this pane) so `app.ts` can fall through to its own
 * keymap.
 */
export function fleetKeyToAction(key: string): "up" | "down" | "refresh" | "back" | null {
  if (UP_KEYS.has(key)) return "up";
  if (DOWN_KEYS.has(key)) return "down";
  if (key === "r") return "refresh";
  if (BACK_KEYS.has(key)) return "back";
  return null;
}
