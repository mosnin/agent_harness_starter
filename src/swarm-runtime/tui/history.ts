/**
 * Goal-run history + replay for the TUI.
 *
 * Records the sequence of `TuiState` snapshots ("frames") a goal run passes
 * through, so the operator can scrub back and forth through a finished (or
 * in-flight) run and skim a compact list of past runs. This is the terminal
 * counterpart to a "session recording": deterministic, pure, unit-testable.
 *
 * No ambient nondeterminism. Mirroring the certificate.ts convention, there is
 * NO `Date.now()` (nor any clock) inside this library. Every timestamp is
 * supplied by the caller (`at` on beginRun/recordFrame/endRun). That makes
 * durations reproducible and the whole module trivially testable.
 *
 * Memory is bounded on two axes with honest trimming (see the caps below):
 *  - MAX_FRAMES_PER_RUN: a run keeps only its most-recent frames; older
 *    frames are dropped oldest-first and counted in `droppedFrames`, so the
 *    record never silently claims frames it no longer holds.
 *  - MAX_RUNS_RETAINED: the recorder keeps only the most-recent runs; older
 *    runs are evicted oldest-first.
 */

import type { TuiState } from "./render";

// ---------------------------------------------------------------------------
// Caps (bounded memory). Chosen to comfortably cover a long interactive goal
// (a ~1Hz poll for several minutes) while capping worst-case retained state.
// ---------------------------------------------------------------------------

/** Max frames retained per run. Older frames are dropped oldest-first. */
export const MAX_FRAMES_PER_RUN = 500;
/** Max runs retained by a recorder. Older runs are evicted oldest-first. */
export const MAX_RUNS_RETAINED = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GoalRunStatus = "running" | "completed" | "failed" | "aborted";

export interface GoalRun {
  goalId: string;
  objective: string;
  /** caller-provided ms timestamp for when the run began */
  startedAt: number;
  /** caller-provided ms timestamp for when the run ended (unset while running) */
  endedAt?: number;
  status: GoalRunStatus;
  /** the recorded frames, oldest first (bounded to MAX_FRAMES_PER_RUN) */
  frames: TuiState[];
  /**
   * caller-provided ms timestamps, one per retained frame (parallel to
   * `frames`). Kept honest under trimming.
   */
  frameTimestamps: number[];
  /** count of frames dropped by the per-run cap (honest trimming). */
  droppedFrames: number;
}

export interface ReplayState {
  runId: string;
  frameIndex: number;
}

export type ReplayAction = "next" | "prev" | "first" | "last";

// ---------------------------------------------------------------------------
// Deep clone (defensive copy so later mutation of a caller's state object
// cannot retroactively rewrite an already-recorded frame).
// ---------------------------------------------------------------------------

function cloneFrame(state: TuiState): TuiState {
  if (typeof structuredClone === "function") return structuredClone(state);
  // Fallback: all TuiState fields are JSON-serializable.
  return JSON.parse(JSON.stringify(state)) as TuiState;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * Records goal runs and their frame sequences. Pure with respect to time:
 * every mutating method takes an explicit `at` timestamp. Insertion order is
 * preserved internally; `list()` returns most-recent-first.
 */
export class HistoryRecorder {
  private readonly runs: GoalRun[] = [];
  private activeId?: string;

  constructor(
    private readonly maxFramesPerRun = MAX_FRAMES_PER_RUN,
    private readonly maxRunsRetained = MAX_RUNS_RETAINED,
  ) {}

  /**
   * Begin a new run. Marks it active so subsequent `recordFrame` calls attach
   * to it. Throws on a duplicate goalId (history must be unambiguous).
   * Evicts the oldest run(s) when over the retention cap.
   */
  beginRun(goalId: string, objective: string, at: number): GoalRun {
    if (this.runs.some((r) => r.goalId === goalId)) {
      throw new Error(`HistoryRecorder: duplicate goalId "${goalId}"`);
    }
    const run: GoalRun = {
      goalId,
      objective,
      startedAt: at,
      status: "running",
      frames: [],
      frameTimestamps: [],
      droppedFrames: 0,
    };
    this.runs.push(run);
    this.activeId = goalId;
    // Evict oldest runs beyond the retention cap.
    while (this.runs.length > this.maxRunsRetained) {
      const evicted = this.runs.shift();
      if (evicted && evicted.goalId === this.activeId) this.activeId = undefined;
    }
    return run;
  }

  /**
   * Append a frame to the active run. `at` is caller-provided (no clock here).
   * Enforces the per-run frame cap by dropping the oldest frame(s) and
   * counting them in `droppedFrames`. Throws if there is no active run.
   */
  recordFrame(state: TuiState, at: number): void {
    const run = this.activeId ? this.find(this.activeId) : undefined;
    if (!run) throw new Error("HistoryRecorder: no active run to record into");
    run.frames.push(cloneFrame(state));
    run.frameTimestamps.push(at);
    while (run.frames.length > this.maxFramesPerRun) {
      run.frames.shift();
      run.frameTimestamps.shift();
      run.droppedFrames += 1;
    }
  }

  /**
   * End the active run with a final status and `at` timestamp. Clears the
   * active pointer. Throws if there is no active run.
   */
  endRun(status: Exclude<GoalRunStatus, "running">, at: number): GoalRun {
    const run = this.activeId ? this.find(this.activeId) : undefined;
    if (!run) throw new Error("HistoryRecorder: no active run to end");
    run.status = status;
    run.endedAt = at;
    this.activeId = undefined;
    return run;
  }

  /** All runs, most-recent-first (by insertion order). */
  list(): GoalRun[] {
    return [...this.runs].reverse();
  }

  /** Look up a run by goalId, or undefined. */
  get(goalId: string): GoalRun | undefined {
    return this.find(goalId);
  }

  private find(goalId: string): GoalRun | undefined {
    return this.runs.find((r) => r.goalId === goalId);
  }
}

// ---------------------------------------------------------------------------
// Replay (pure)
// ---------------------------------------------------------------------------

/** Initial replay position for a run: the first frame. */
export function initReplay(run: GoalRun): ReplayState {
  return { runId: run.goalId, frameIndex: 0 };
}

function clampIndex(run: GoalRun, index: number): number {
  const max = run.frames.length - 1;
  if (max < 0) return 0;
  if (index < 0) return 0;
  if (index > max) return max;
  return index;
}

/** Pure reducer: advance a replay position by an action, clamped to bounds. */
export function replayReduce(run: GoalRun, state: ReplayState, action: ReplayAction): ReplayState {
  switch (action) {
    case "next":
      return { ...state, frameIndex: clampIndex(run, state.frameIndex + 1) };
    case "prev":
      return { ...state, frameIndex: clampIndex(run, state.frameIndex - 1) };
    case "first":
      return { ...state, frameIndex: 0 };
    case "last":
      return { ...state, frameIndex: run.frames.length > 0 ? run.frames.length - 1 : 0 };
    default:
      return state;
  }
}

export const replayNext = (run: GoalRun, s: ReplayState): ReplayState => replayReduce(run, s, "next");
export const replayPrev = (run: GoalRun, s: ReplayState): ReplayState => replayReduce(run, s, "prev");
export const replayFirst = (run: GoalRun, s: ReplayState): ReplayState => replayReduce(run, s, "first");
export const replayLast = (run: GoalRun, s: ReplayState): ReplayState => replayReduce(run, s, "last");

/**
 * The frame the replay position currently points at, or null when the run has
 * no frames, the position refers to a different run, or the index is somehow
 * out of range.
 */
export function currentFrame(run: GoalRun, state: ReplayState): TuiState | null {
  if (state.runId !== run.goalId) return null;
  if (run.frames.length === 0) return null;
  if (state.frameIndex < 0 || state.frameIndex >= run.frames.length) return null;
  return run.frames[state.frameIndex];
}

// ---------------------------------------------------------------------------
// Renderers (plain text, deterministic, no em-dashes)
// ---------------------------------------------------------------------------

/** Human-readable duration for a run, or "running" when not yet ended. */
export function formatDuration(run: GoalRun): string {
  if (run.endedAt === undefined) return "running";
  const ms = Math.max(0, run.endedAt - run.startedAt);
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) {
    const secs = ms / 1000;
    return `${secs.toFixed(1)}s`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m${secs.toString().padStart(2, "0")}s`;
}

function statusMark(status: GoalRunStatus): string {
  switch (status) {
    case "completed":
      return "OK ";
    case "failed":
      return "ERR";
    case "aborted":
      return "ABT";
    case "running":
    default:
      return "...";
  }
}

function truncate(s: string, n: number): string {
  if (n <= 0) return "";
  return [...s].length > n ? `${[...s].slice(0, Math.max(0, n - 1)).join("")}…` : s;
}

/**
 * A compact, most-recent-first list of runs. Each line shows a selection
 * marker, status, frame count, duration, and the (truncated) objective.
 * Pass `runs` already ordered as you want them displayed (e.g. recorder.list()).
 */
export function renderHistoryList(runs: GoalRun[], selectedIndex?: number): string {
  if (runs.length === 0) return "  (no goal runs recorded)";
  const lines: string[] = [];
  runs.forEach((run, i) => {
    const marker = i === selectedIndex ? ">" : " ";
    const status = statusMark(run.status);
    const frameCount = run.frames.length + (run.droppedFrames > 0 ? `+${run.droppedFrames}` : "");
    const frames = `${frameCount}f`.padStart(6);
    const dur = formatDuration(run).padStart(8);
    const objective = truncate(run.objective, 40);
    lines.push(`${marker} ${status} ${frames} ${dur}  ${objective}`);
  });
  return lines.join("\n");
}

/**
 * A one-line scrubber for the currently replayed run, e.g.
 *   [frame 3/12] ◀ ▶  goal: "Analyze the objective"
 * Frame numbers are 1-based for display; an empty run shows 0/0.
 */
export function renderReplayBar(run: GoalRun, state: ReplayState): string {
  const total = run.frames.length;
  const shown = total === 0 ? 0 : Math.min(state.frameIndex + 1, total);
  const objective = truncate(run.objective, 48);
  return `[frame ${shown}/${total}] ◀ ▶  goal: "${objective}"`;
}
