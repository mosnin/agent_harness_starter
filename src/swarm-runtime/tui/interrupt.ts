/**
 * Interrupt-and-redirect for the interactive TUI: Esc mid-run pauses the
 * operator into a small overlay state machine — resume, abort (with an
 * explicit confirm step, never a single-keystroke kill), or type a redirect
 * that supersedes the running goal while explicitly preserving its
 * completed work in the new objective's text.
 *
 * Pure reducer, no I/O, no clock, no imports from `src/hades/**` or
 * `../../desktop/core/sidecar` — this module never touches a `SwarmHandle`.
 * Key string conventions follow `tui/compose.ts` (itself following
 * `tui/keymap.ts`): Enter as `"\r" | "\n" | "return"`, Backspace as
 * `"\x7f" | "\b"`, Esc as `"\x1b" | "escape"`, single printable code points
 * as themselves. Any other key at any phase is a documented no-op — the
 * reducer returns the same state reference and a null intent rather than
 * guessing at an unspecified binding.
 *
 * ── Integration contract (central wiring in `app.ts` implements this; this
 * module only produces the intent) ──
 *   1. Esc while a goal is running -> `interruptOpen(state, { goalId, objective })`.
 *      Esc with no running goal -> `interruptOpen(state, null)` stays idle;
 *      the integrator is expected to surface a status-line notice ("nothing
 *      to interrupt") instead of rendering an overlay, since
 *      `renderInterruptOverlay` renders nothing for an idle state.
 *   2. Every subsequent keypress while the overlay is open ->
 *      `interruptKey(state, key)`. Render `renderInterruptOverlay(state, width)`
 *      each frame; an idle state renders `[]`, i.e. no overlay.
 *   3. When `interruptKey` returns a non-null `intent`, apply it against the
 *      REAL `SwarmHandle` (`src/desktop/core/sidecar.ts`) as:
 *        - `{ kind: "resume" }`            -> no handle call; just close the overlay.
 *        - `{ kind: "abort", goalId }`     -> `await handle.cancelGoal?.(goalId)`.
 *        - `{ kind: "redirect", goalId, objective }` ->
 *              `await handle.cancelGoal?.(goalId)` THEN
 *              `await handle.dispatchGoal(objective)`
 *          in that exact sequence (cancel the superseded goal before
 *          dispatching its replacement, so the two never run concurrently).
 *      The reducer already resets its own state to idle for `resume`,
 *      `abort`, and `redirect` intents — the integrator does not need to
 *      call anything else on the state machine after applying the intent.
 */

/** The full state of the interrupt overlay. Never mutated in place. */
export interface InterruptState {
  phase: "idle" | "menu" | "redirect" | "confirm-abort";
  /** Goal the overlay is targeting; null only while `phase === "idle"`. */
  goalId: string | null;
  /** The running goal's original objective, captured at `interruptOpen`. */
  objective: string;
  /** In-progress redirect instruction text (single line). */
  instruction: string;
}

/** What the operator decided, for the integrator to apply to the real handle. */
export type InterruptIntent =
  | { kind: "resume" }
  | { kind: "abort"; goalId: string }
  | { kind: "redirect"; goalId: string; objective: string };

const ENTER_KEYS = new Set(["\r", "\n", "return"]);
const BACKSPACE_KEYS = new Set(["\x7f", "\b"]);
const ESC_KEYS = new Set(["\x1b", "escape"]);

function toCps(s: string): string[] {
  return [...s];
}

/** True for exactly one printable Unicode code point (rejects control chars and multi-char garbage). */
function isPrintable(key: string): boolean {
  const cps = toCps(key);
  if (cps.length !== 1) return false;
  const cp = cps[0]!.codePointAt(0)!;
  if (cp < 0x20) return false; // C0 controls (includes bare \x1b, \x07, ...)
  if (cp === 0x7f) return false; // DEL
  if (cp >= 0x80 && cp <= 0x9f) return false; // C1 controls
  return true;
}

/** Fresh, closed overlay state. */
export function interruptInit(): InterruptState {
  return { phase: "idle", goalId: null, objective: "", instruction: "" };
}

/**
 * Open the overlay onto a running goal, or — with `goal === null` — stay
 * idle (honest: you cannot interrupt what is not running). Always starts on
 * the menu phase with a freshly-cleared redirect draft; the prior `state` is
 * intentionally not threaded through beyond that (opening always resets any
 * half-typed redirect from a previous interrupt of a different goal).
 */
export function interruptOpen(
  state: InterruptState,
  goal: { goalId: string; objective: string } | null
): InterruptState {
  void state;
  if (goal === null) {
    return interruptInit();
  }
  return { phase: "menu", goalId: goal.goalId, objective: goal.objective, instruction: "" };
}

/**
 * Apply one raw key to `state`. Never mutates `state`; always returns a
 * fresh object (or the same reference when a key is a documented no-op) plus
 * an `intent` the integrator should apply, or `null` when nothing fired.
 */
export function interruptKey(state: InterruptState, key: string): { state: InterruptState; intent: InterruptIntent | null } {
  const noop = { state, intent: null };

  if (state.phase === "idle") {
    return noop;
  }

  if (state.phase === "menu") {
    if (key === "r") {
      return { state: interruptInit(), intent: { kind: "resume" } };
    }
    if (key === "a") {
      return { state: { ...state, phase: "confirm-abort" }, intent: null };
    }
    if (key === "d" || key === "i") {
      return { state: { ...state, phase: "redirect", instruction: "" }, intent: null };
    }
    return noop;
  }

  if (state.phase === "confirm-abort") {
    if (key === "y" || ENTER_KEYS.has(key)) {
      const goalId = state.goalId;
      if (goalId === null) return noop; // defensive: unreachable via interruptOpen's invariant
      return { state: interruptInit(), intent: { kind: "abort", goalId } };
    }
    if (key === "n" || ESC_KEYS.has(key)) {
      return { state: { ...state, phase: "menu" }, intent: null };
    }
    return noop;
  }

  // state.phase === "redirect"
  if (ESC_KEYS.has(key)) {
    return { state: { ...state, phase: "menu", instruction: "" }, intent: null };
  }
  if (ENTER_KEYS.has(key)) {
    if (state.instruction.length === 0) {
      return noop;
    }
    const goalId = state.goalId;
    if (goalId === null) return noop; // defensive: unreachable via interruptOpen's invariant
    const objective = composeRedirectObjective(state.objective, state.instruction);
    return { state: interruptInit(), intent: { kind: "redirect", goalId, objective } };
  }
  if (BACKSPACE_KEYS.has(key)) {
    if (state.instruction.length === 0) return noop;
    const cps = toCps(state.instruction);
    cps.pop();
    return { state: { ...state, instruction: cps.join("") }, intent: null };
  }
  if (isPrintable(key)) {
    return { state: { ...state, instruction: state.instruction + key }, intent: null };
  }
  return noop;
}

/**
 * Build the redirect's new objective text. LOCKED, deterministic, byte-stable
 * format — the new objective supersedes the original but explicitly instructs
 * the swarm to preserve whatever work the superseded goal already completed.
 */
export function composeRedirectObjective(originalObjective: string, instruction: string): string {
  return `REDIRECT: ${instruction}\n\nOriginal objective (superseded, preserve completed work): ${originalObjective}`;
}

/* ----------------------------------------------------------------------------
 * Rendering (boxed, code-point exact; local fit/boxify reimplemented per the
 * `tui/compose.ts` approach rather than importing from `tui/panes.ts`)
 * ------------------------------------------------------------------------- */

/** Pad or truncate (with a trailing "…") so the result is exactly `w` code points. */
function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const cps = toCps(s);
  if (cps.length === w) return s;
  if (cps.length < w) return s + " ".repeat(w - cps.length);
  return cps.slice(0, w - 1).join("") + "…";
}

/** A boxed block of exactly `rows.length + 2` lines, each exactly `width` code points. */
function boxify(title: string, rows: string[], width: number): string[] {
  const inner = Math.max(0, width - 2);
  const label = title ? ` ${title} ` : "";
  const header = fit(`─${label}`, inner).replace(/ +$/g, (m) => "─".repeat(m.length));
  const out: string[] = [];
  out.push(`╭${header}╮`);
  for (const r of rows) out.push(`│${fit(r, inner)}│`);
  out.push(`╰${"─".repeat(inner)}╯`);
  return out;
}

/** Insert the cursor marker "▏" at the code-point end of `line`. */
function withCursor(line: string): string {
  return `${line}▏`;
}

/**
 * Render the overlay: `[]` while idle (nothing to draw), otherwise a boxed
 * block sized to `width` code points, one shape per phase.
 */
export function renderInterruptOverlay(state: InterruptState, width: number): string[] {
  const W = Math.max(4, Math.floor(width));

  if (state.phase === "idle") {
    return [];
  }

  if (state.phase === "menu") {
    return boxify("INTERRUPT", [
      `Goal ${state.goalId ?? ""}`,
      state.objective,
      "",
      "[r] resume   [a] abort   [d/i] redirect",
    ], W);
  }

  if (state.phase === "confirm-abort") {
    return boxify("INTERRUPT — CONFIRM ABORT", [
      `Abort goal ${state.goalId ?? ""}? This stops it immediately.`,
      "",
      "[y/Enter] confirm abort   [n/Esc] back to menu",
    ], W);
  }

  // state.phase === "redirect"
  return boxify("INTERRUPT — REDIRECT", [
    "New instruction (supersedes the running goal, keeps completed work):",
    withCursor(state.instruction),
    "",
    "[Enter] send redirect   [Esc] back to menu",
  ], W);
}
