/**
 * showdown-pane.ts — pure, deterministic SHOWDOWN pane for the interactive
 * TUI: live progress for a `hades showdown` run, the final V-TPH$
 * comparison table, and audit-chain status.
 *
 * Like `fleet-pane.ts`, this module is pure functions over immutable state
 * records: no I/O, no timers, no ANSI escapes, no imports outside this
 * file's own types (and none from `src/hades/**`, so the TUI package stays
 * dependency-clean — the orchestrator feeds this pane a plain
 * `ShowdownPaneResult` snapshot it derives from the real
 * `hades/bench/showdown.ts` run).
 *
 * Box drawing (`╭─╮ │ ├ ┤ ╰─╯`), a default width of 72 code points, and the
 * hard clamp that no emitted line ever exceeds the requested width all match
 * `render.ts` / `panes.ts` / `fleet-pane.ts`.
 *
 * Honesty contract (identical in spirit to `hades/bench/showdown-report.ts`):
 * every numeric figure in the done-state table is suffixed literally
 * `(modeled)` when `state.mode === "modeled"`; real figures carry no suffix.
 * A `result.auditOk === false` always renders the full-width banner
 * `AUDIT CHAIN FAILED — DO NOT TRUST THESE NUMBERS` verbatim — the numbers
 * are still shown (so an operator can inspect what a tampered chain
 * produced) but never silently as if trustworthy.
 */

// ---------------------------------------------------------------------------
// State shapes
// ---------------------------------------------------------------------------

/** The final comparison figures for one showdown run (swarm vs. baseline). */
export interface ShowdownPaneResult {
  /** Swarm (verification-gated) lane's V-TPH$ (verified tasks/hour/dollar). */
  swarmVtph: number;
  /** Baseline (self-trusting single agent) lane's V-TPH$. */
  baselineVtph: number;
  /** swarmVtph / baselineVtph (or whatever multiple the harness reports). */
  multiple: number;
  /** Swarm lane's verified-correct task count. */
  swarmVerified: number;
  /** Baseline lane's verified-correct task count. */
  baselineVerified: number;
  /** Swarm lane's silent-wrong count (claimed verified, actually wrong). */
  swarmSilentWrong: number;
  /** Baseline lane's silent-wrong count. */
  baselineSilentWrong: number;
  /** Whether the audit hash chain independently re-verified OK. */
  auditOk: boolean;
}

/** The pane's pure view-state across a showdown run's lifecycle. */
export interface ShowdownPaneState {
  phase: "idle" | "running" | "done" | "failed";
  /** Set once a run has started: whether it's a live-inference or scripted-demo run. */
  mode?: "modeled" | "real";
  /** Set once a run has started: how many of `total` tasks have completed so far. */
  progress?: { done: number; total: number };
  /** Set on `"done"`: the final comparison figures. */
  result?: ShowdownPaneResult;
  /** Set on `"failed"`: what went wrong. */
  error?: string;
}

/** Events the reducer accepts, one per showdown-run lifecycle step. */
export type ShowdownPaneEvent =
  | { type: "start"; mode: "modeled" | "real"; total: number }
  | { type: "progress"; done: number }
  | { type: "done"; result: ShowdownPaneResult }
  | { type: "fail"; error: string };

/** The pane's initial state: no run has started yet. */
export function initialShowdownPaneState(): ShowdownPaneState {
  return { phase: "idle" };
}

// ---------------------------------------------------------------------------
// Reducer — pure, total, immutable
// ---------------------------------------------------------------------------

function clampInt(n: number, lo: number, hi: number): number {
  const safe = Number.isFinite(n) ? Math.floor(n) : lo;
  return Math.min(hi, Math.max(lo, safe));
}

/**
 * Pure reducer over the showdown lifecycle: `idle -> running -> (done |
 * failed)`, with `start` also legal from `done`/`failed` to kick off a new
 * run. Total: every `(phase, event)` pair is handled, and any transition
 * that doesn't make sense for the current phase (progress/done/fail with no
 * run in flight, a `start` while already `running`) is a documented no-op
 * that returns the exact same `state` reference unchanged — it never throws
 * and never corrupts the state.
 *
 * - `start`: illegal (no-op) while `phase === "running"` (no double-starts
 *   racing progress on top of an in-flight run). Legal from `idle`, `done`,
 *   or `failed`; resets to a fresh `running` state with `progress` at
 *   `{ done: 0, total }` and clears any prior `result`/`error`.
 * - `progress`: legal only while `phase === "running"`; `done` is clamped to
 *   `[0, total]` (non-finite input is treated as `0`, matching the pane's
 *   "never fabricate a number" discipline elsewhere).
 * - `done`: legal only while `phase === "running"`; sets `result` and forces
 *   `progress` to exactly `{ done: total, total }` (a finished run is always
 *   100%, regardless of the last `progress` event received).
 * - `fail`: legal only while `phase === "running"`; sets `error`, drops any
 *   partial `progress`/`result` framing (the pane no longer knows how far it
 *   got, only that it failed).
 *
 * The input `state` object is never mutated: every returned value is either
 * the same reference (illegal transition) or a brand-new object.
 */
export function showdownReducer(state: ShowdownPaneState, ev: ShowdownPaneEvent): ShowdownPaneState {
  switch (ev.type) {
    case "start": {
      if (state.phase === "running") return state; // double-start guard
      const total = Number.isFinite(ev.total) ? Math.max(0, Math.floor(ev.total)) : 0;
      return {
        phase: "running",
        mode: ev.mode,
        progress: { done: 0, total },
        result: undefined,
        error: undefined,
      };
    }

    case "progress": {
      if (state.phase !== "running" || !state.progress) return state;
      const total = state.progress.total;
      const done = clampInt(ev.done, 0, total);
      if (done === state.progress.done) return state;
      return { ...state, progress: { done, total } };
    }

    case "done": {
      if (state.phase !== "running") return state;
      const total = state.progress ? state.progress.total : 0;
      return {
        ...state,
        phase: "done",
        progress: { done: total, total },
        result: ev.result,
        error: undefined,
      };
    }

    case "fail": {
      if (state.phase !== "running") return state;
      return {
        ...state,
        phase: "failed",
        error: ev.error,
        result: undefined,
      };
    }

    default: {
      // Exhaustiveness guard: if a new event variant is ever added without a
      // case above, this fails to compile rather than silently swallowing it.
      const _exhaustive: never = ev;
      return _exhaustive;
    }
  }
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

/** A boxed block: `╭─ TITLE ─…─╮` header, padded rows, `╰─…─╯` footer. */
function boxify(title: string, rows: string[], width: number): string {
  const inner = Math.max(0, width - 2);
  const label = title ? ` ${title} ` : "";
  const header = fit(`─${label}`, inner).replace(/ +$/g, (m) => "─".repeat(m.length));
  const out: string[] = [];
  out.push(`╭${header}╮`);
  for (const r of rows) out.push(`│${fit(r, inner)}│`);
  out.push(`╰${"─".repeat(inner)}╯`);
  return out.join("\n");
}

const DEFAULT_WIDTH = 72;
const METER_BLOCKS = 20;

/** A `[████░░░░] done/total` progress meter, clamped so a zero `total` never divides by zero. */
function meter(done: number, total: number): string {
  const t = Math.max(0, total);
  const d = clamp(done, 0, t);
  const filled = t > 0 ? Math.round((d / t) * METER_BLOCKS) : 0;
  return `[${"█".repeat(filled)}${"░".repeat(METER_BLOCKS - filled)}] ${d}/${t}`;
}

/** Suffix `text` with the mode-honesty label — `(modeled)` for a scripted-demo run, unchanged for real. */
function fig(mode: "modeled" | "real" | undefined, text: string): string {
  return mode === "modeled" ? `${text} (modeled)` : text;
}

function num(mode: "modeled" | "real" | undefined, v: number, digits = 2): string {
  return fig(mode, Number.isFinite(v) ? v.toFixed(digits) : String(v));
}

function int(mode: "modeled" | "real" | undefined, v: number): string {
  return fig(mode, Number.isFinite(v) ? String(Math.trunc(v)) : String(v));
}

const AUDIT_FAILED_BANNER = "AUDIT CHAIN FAILED — DO NOT TRUST THESE NUMBERS";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the SHOWDOWN pane for the current lifecycle phase:
 *
 * - `idle`: explains how a run is started (no run is in flight yet).
 * - `running`: a live progress meter (`done/total`) plus the run's mode.
 * - `done`: the V-TPH$ comparison table. Every numeric cell carries the
 *   `(modeled)` suffix when `state.mode === "modeled"`, and none do for a
 *   real run. When `result.auditOk === false`, a full-width
 *   `AUDIT CHAIN FAILED — DO NOT TRUST THESE NUMBERS` banner is rendered
 *   verbatim above the table.
 * - `failed`: the error message, truncated to fit the pane width.
 *
 * Every returned line is exactly `width` code points wide (hard clamp): no
 * line this function returns ever exceeds `width`.
 */
export function renderShowdownPane(state: ShowdownPaneState, width = DEFAULT_WIDTH): string {
  switch (state.phase) {
    case "idle":
      return boxify(
        "SHOWDOWN",
        [
          "no run in progress",
          "",
          "start a showdown run (swarm vs. baseline) to populate this pane",
          "with live progress and a final V-TPH$ comparison.",
        ],
        width
      );

    case "running": {
      const total = state.progress?.total ?? 0;
      const done = state.progress?.done ?? 0;
      const rows = [
        `mode: ${state.mode ?? "?"}`,
        "",
        meter(done, total),
      ];
      return boxify("SHOWDOWN — running", rows, width);
    }

    case "done": {
      const r = state.result;
      if (!r) {
        // Defensive: the reducer never produces "done" without a result, but
        // this renderer must still be total over the full state-shape space.
        return boxify("SHOWDOWN — done", ["(no result recorded)"], width);
      }
      const mode = state.mode;
      const rows: string[] = [];
      if (!r.auditOk) {
        rows.push(AUDIT_FAILED_BANNER);
        rows.push("");
      }
      rows.push("V-TPH$ (verified tasks / hour / dollar)");
      rows.push(`  swarm:      ${num(mode, r.swarmVtph)}`);
      rows.push(`  baseline:   ${num(mode, r.baselineVtph)}`);
      rows.push(`  multiple:   ${fig(mode, `${r.multiple.toFixed(2)}x`)}`);
      rows.push("");
      rows.push(`  swarm    verified=${int(mode, r.swarmVerified)}  silent-wrong=${int(mode, r.swarmSilentWrong)}`);
      rows.push(`  baseline verified=${int(mode, r.baselineVerified)}  silent-wrong=${int(mode, r.baselineSilentWrong)}`);
      rows.push("");
      rows.push(`  audit chain: ${r.auditOk ? "verified OK" : "FAILED"}`);
      return boxify("SHOWDOWN — done", rows, width);
    }

    case "failed": {
      const message = state.error ?? "(unknown error)";
      // `boxify` pads/truncates every row to the box's interior width via
      // `fit`, so the error is guaranteed to be truncated (with a trailing
      // "…") rather than ever overflowing the box — no manual fitting needed.
      return boxify("SHOWDOWN — failed", ["run failed:", "", message], width);
    }

    default: {
      const _exhaustive: never = state.phase;
      return _exhaustive;
    }
  }
}
