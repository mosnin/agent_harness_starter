/**
 * A live, scrollable tool-output stream lane for the interactive TUI, fed by
 * the REAL manager event surface (`src/swarm-runtime/manager/manager.ts`'s
 * `SwarmManager`, which extends `node:events`' `EventEmitter` and emits the
 * named events below) rather than any simulated feed.
 *
 * Pure reducer + renderer module: no I/O, no `Date.now` (the caller supplies
 * `at` on every normalized event and drives `streamTick`'s spinner frame
 * explicitly), no imports from `src/hades/**` or `../../desktop/core/sidecar`.
 *
 * ── Integration contract (central wiring in `app.ts` implements this; this
 * module only normalizes payloads and renders state) ──
 *   `SwarmHandle.on(event, cb)` (`src/desktop/core/sidecar.ts`) forwards a
 *   manager `EventEmitter` listener's raw arguments as
 *   `cb(args.length <= 1 ? args[0] : args)` — i.e. a single-argument manager
 *   emit (`"task:dispatched"`, `"worker:spawned"`, `"goal:completed"`)
 *   arrives at the callback as the bare payload object, while a
 *   multi-argument emit (`"log"`, `"task:verified"`, `"task:requeued"`, …)
 *   arrives as a 2-element array. The integrator is expected to register one
 *   listener per event name in the table below and call
 *   `normalizeSwarmEvent(eventName, payload, clock.now())`, appending
 *   non-null results with `streamAppend`. This mirrors the same tolerant,
 *   defensive-normalization discipline as `normalizeLogPayload` in
 *   `src/hades/cli/tui-command.ts` (studied as prior art, not imported —
 *   `swarm-runtime` must not depend on `hades`), but is stricter about
 *   returning `null` on anything truly unusable rather than inventing
 *   placeholder text: a hostile or malformed payload must never become a
 *   fabricated row.
 *
 *   Manager event -> raw emit arity (`this.emit(name, ...)` in manager.ts):
 *     "log"             -> (workerId: string, line: string)
 *     "task:dispatched"  -> (task: WorkerTask)
 *     "task:verified"    -> (task: WorkerTask, report: VerificationReport)
 *     "task:rejected"    -> (task: WorkerTask, report: VerificationReport)
 *     "task:requeued"    -> (task: WorkerTask, reason: string)
 *     "task:escalated"   -> (task: WorkerTask, revisions: RevisionEntry[])
 *     "task:failed"      -> (task: WorkerTask, reason: string)
 *     "worker:spawned"   -> (rec: WorkerRecord)
 *     "worker:killed"    -> (rec: WorkerRecord, reason: string)
 *     "worker:dead"      -> (rec: WorkerRecord, reason: string)
 *     "goal:planned"     -> (goal: Goal, tasks: WorkerTask[])
 *     "goal:completed"   -> (goal: Goal)
 *     "goal:failed"      -> (goal: Goal, reason: string)
 *     "goal:aborted"     -> (goal: Goal, reason: string)
 *   Any other event name normalizes to `null` (ignored, not a garbage row).
 */

/** One normalized row ready for the stream lane. */
export interface ToolStreamEvent {
  /** Caller-supplied timestamp (epoch ms or any monotonically-useful clock) — never `Date.now()` internally. */
  at: number;
  /** Attribution: a workerId for worker/log rows, "manager" for goal-level rows. */
  source: string;
  /** Task id, when the event is task-scoped. */
  taskId?: string;
  kind: "log" | "dispatch" | "verify" | "reject" | "requeue" | "escalate" | "fail" | "worker" | "goal";
  line: string;
}

/** The stream lane's full pure view-state. Never mutated in place. */
export interface ToolStreamState {
  events: ToolStreamEvent[];
  /** Count of events evicted from the front of the ring buffer over the state's lifetime. */
  dropped: number;
  /** Rows scrolled back from the live tail (0 = live tail), measured against the currently-filtered view. */
  scroll: number;
  /** `null` = no filter (all sources); otherwise show only events whose `source` equals this. */
  filter: string | null;
  /** 0..3, advanced only by `streamTick`. */
  spinnerPhase: number;
}

/** Ring-buffer capacity: the oldest events are evicted (and counted in `dropped`) past this. */
export const MAX_STREAM_EVENTS = 500;

const PAGE = 10;
const SPINNER_GLYPHS = ["⠋", "⠙", "⠹", "⠸"];

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Fresh, empty stream state: no events, nothing dropped, live tail, no filter. */
export function streamInit(): ToolStreamState {
  return { events: [], dropped: 0, scroll: 0, filter: null, spinnerPhase: 0 };
}

// ---------------------------------------------------------------------------
// normalizeSwarmEvent — defensive normalizer over the real manager emit surface
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function pickNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Single-argument emits arrive as the bare payload; tolerate a defensive `[payload]` wrap too. */
function unwrapSingle(payload: unknown): unknown {
  return Array.isArray(payload) ? payload[0] : payload;
}

/** Multi-argument emits arrive as `[a, b]`; tolerate a bare `a` (no second arg forwarded) too. */
function unwrapPair(payload: unknown): [unknown, unknown] {
  return Array.isArray(payload) ? [payload[0], payload[1]] : [payload, undefined];
}

function extractTaskId(task: Record<string, unknown> | null, report?: Record<string, unknown> | null): string | undefined {
  return pickString(task?.id, task?.taskId, report?.taskId);
}

function normalizeLog(payload: unknown, at: number): ToolStreamEvent | null {
  if (typeof payload === "string") {
    return { at, source: "swarm", kind: "log", line: payload };
  }
  if (Array.isArray(payload)) {
    const [a, b] = payload;
    if (typeof a === "string" && typeof b === "string") {
      return { at, source: a, kind: "log", line: b };
    }
    if (typeof a === "string" && b === undefined) {
      return { at, source: "swarm", kind: "log", line: a };
    }
    return null;
  }
  const r = asRecord(payload);
  if (r && typeof r.line === "string") {
    return { at, source: pickString(r.workerId) ?? "swarm", kind: "log", line: r.line };
  }
  return null;
}

function normalizeTaskDispatched(payload: unknown, at: number): ToolStreamEvent | null {
  const task = asRecord(unwrapSingle(payload));
  const id = extractTaskId(task);
  if (!id) return null;
  const description = pickString(task?.description);
  const source = pickString(task?.assignedTo) ?? "manager";
  return {
    at,
    source,
    taskId: id,
    kind: "dispatch",
    line: description ? `dispatched ${id}: ${description}` : `dispatched ${id}`,
  };
}

function normalizeTaskVerdict(payload: unknown, at: number, kind: "verify" | "reject", label: string): ToolStreamEvent | null {
  const [taskRaw, reportRaw] = unwrapPair(payload);
  const task = asRecord(taskRaw);
  const report = asRecord(reportRaw);
  const id = extractTaskId(task, report);
  if (!id) return null;
  const verdict = pickString(report?.verdict);
  const score = pickNumber(report?.score);
  const feedback = pickString(report?.feedback);
  const source = pickString(report?.workerId, task?.assignedTo) ?? "manager";
  const parts = [`${label} ${id}`];
  if (verdict) parts.push(`verdict=${verdict}`);
  if (score !== undefined) parts.push(`score=${score.toFixed(2)}`);
  if (feedback) parts.push(`feedback=${feedback}`);
  return { at, source, taskId: id, kind, line: parts.join(" ") };
}

function normalizeTaskReason(payload: unknown, at: number, kind: "requeue" | "fail", label: string): ToolStreamEvent | null {
  const [taskRaw, reasonRaw] = unwrapPair(payload);
  const task = asRecord(taskRaw);
  const id = extractTaskId(task);
  if (!id) return null;
  const reason = pickString(reasonRaw);
  const source = pickString(task?.assignedTo) ?? "manager";
  return { at, source, taskId: id, kind, line: reason ? `${label} ${id}: ${reason}` : `${label} ${id}` };
}

function normalizeTaskEscalated(payload: unknown, at: number): ToolStreamEvent | null {
  const [taskRaw, revisionsRaw] = unwrapPair(payload);
  const task = asRecord(taskRaw);
  const id = extractTaskId(task);
  if (!id) return null;
  const count = Array.isArray(revisionsRaw) ? revisionsRaw.length : undefined;
  const source = pickString(task?.assignedTo) ?? "manager";
  const line = count !== undefined ? `escalated ${id} after ${count} revision${count === 1 ? "" : "s"}` : `escalated ${id}`;
  return { at, source, taskId: id, kind: "escalate", line };
}

function normalizeWorkerSpawned(payload: unknown, at: number): ToolStreamEvent | null {
  const rec = asRecord(unwrapSingle(payload));
  const id = pickString(rec?.workerId, rec?.id);
  if (!id) return null;
  return { at, source: id, kind: "worker", line: `spawned ${id}` };
}

function normalizeWorkerReason(payload: unknown, at: number, label: "killed" | "dead"): ToolStreamEvent | null {
  const [recRaw, reasonRaw] = unwrapPair(payload);
  const rec = asRecord(recRaw);
  const id = pickString(rec?.workerId, rec?.id);
  if (!id) return null;
  const reason = pickString(reasonRaw);
  return { at, source: id, kind: "worker", line: reason ? `${label} ${id}: ${reason}` : `${label} ${id}` };
}

function normalizeGoalPlanned(payload: unknown, at: number): ToolStreamEvent | null {
  const [goalRaw, tasksRaw] = unwrapPair(payload);
  const goal = asRecord(goalRaw);
  const id = pickString(goal?.id, goal?.goalId);
  if (!id) return null;
  const count = Array.isArray(tasksRaw) ? tasksRaw.length : undefined;
  const line = count !== undefined ? `planned ${id} (${count} task${count === 1 ? "" : "s"})` : `planned ${id}`;
  return { at, source: "manager", kind: "goal", line };
}

function normalizeGoalCompleted(payload: unknown, at: number): ToolStreamEvent | null {
  const goal = asRecord(unwrapSingle(payload));
  const id = pickString(goal?.id, goal?.goalId);
  if (!id) return null;
  return { at, source: "manager", kind: "goal", line: `completed ${id}` };
}

function normalizeGoalReason(payload: unknown, at: number, label: "failed" | "aborted"): ToolStreamEvent | null {
  const [goalRaw, reasonRaw] = unwrapPair(payload);
  const goal = asRecord(goalRaw);
  const id = pickString(goal?.id, goal?.goalId);
  if (!id) return null;
  const reason = pickString(reasonRaw);
  return { at, source: "manager", kind: "goal", line: reason ? `${label} ${id}: ${reason}` : `${label} ${id}` };
}

/**
 * Normalize one raw manager event into a `ToolStreamEvent`, or `null` when
 * the event name is unrecognized or the payload is too malformed to trust
 * (missing the field the row's identity depends on, or the wrong runtime
 * type). Never fabricates a placeholder row — see the module docstring's
 * emit-arity table for the exact shapes this tolerates.
 */
export function normalizeSwarmEvent(eventName: string, payload: unknown, at: number): ToolStreamEvent | null {
  switch (eventName) {
    case "log":
      return normalizeLog(payload, at);
    case "task:dispatched":
      return normalizeTaskDispatched(payload, at);
    case "task:verified":
      return normalizeTaskVerdict(payload, at, "verify", "verified");
    case "task:rejected":
      return normalizeTaskVerdict(payload, at, "reject", "rejected");
    case "task:requeued":
      return normalizeTaskReason(payload, at, "requeue", "requeued");
    case "task:escalated":
      return normalizeTaskEscalated(payload, at);
    case "task:failed":
      return normalizeTaskReason(payload, at, "fail", "failed");
    case "worker:spawned":
      return normalizeWorkerSpawned(payload, at);
    case "worker:killed":
      return normalizeWorkerReason(payload, at, "killed");
    case "worker:dead":
      return normalizeWorkerReason(payload, at, "dead");
    case "goal:planned":
      return normalizeGoalPlanned(payload, at);
    case "goal:completed":
      return normalizeGoalCompleted(payload, at);
    case "goal:failed":
      return normalizeGoalReason(payload, at, "failed");
    case "goal:aborted":
      return normalizeGoalReason(payload, at, "aborted");
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/**
 * Append one normalized event. Ring-buffered at `MAX_STREAM_EVENTS`: past
 * that, the oldest events are evicted from the front and counted in
 * `dropped` (never silently forgotten). Pin semantics: when `scroll > 0`
 * (the operator has scrolled back from the live tail), the append bumps
 * `scroll` by exactly 1 so the same absolute events stay on screen — the
 * visible window does not slide out from under a scrolled-back operator just
 * because new output arrived.
 */
export function streamAppend(state: ToolStreamState, ev: ToolStreamEvent): ToolStreamState {
  const combined = [...state.events, ev];
  const excess = Math.max(0, combined.length - MAX_STREAM_EVENTS);
  const events = excess > 0 ? combined.slice(excess) : combined;
  const dropped = state.dropped + excess;
  const scroll = state.scroll > 0 ? state.scroll + 1 : state.scroll;
  return { ...state, events, dropped, scroll };
}

function currentFiltered(state: ToolStreamState): ToolStreamEvent[] {
  return state.filter === null ? state.events : state.events.filter((e) => e.source === state.filter);
}

/** Sources actually present in `events`, deduped and sorted for a deterministic cycle order. */
function presentSources(events: ToolStreamEvent[]): string[] {
  return Array.from(new Set(events.map((e) => e.source))).sort();
}

/**
 * Apply one navigation/filter key. `up`/`down` move one row, `pgup`/`pgdn`
 * move a page, `home` jumps to the oldest event, `end` jumps back to the
 * live tail; all scroll changes are clamped to `[0, filteredLength - 1]`.
 * `f` cycles `filter` through `null` (all sources) then each source actually
 * present in `events` (sorted, so the cycle never offers a source that has
 * since scrolled out of the ring buffer) and resets `scroll` to the new
 * filter's live tail. Any other key is a no-op returning the same reference.
 */
export function streamKey(state: ToolStreamState, key: string): ToolStreamState {
  if (key === "f") {
    const sources = presentSources(state.events);
    const cycle: Array<string | null> = [null, ...sources];
    const idx = cycle.indexOf(state.filter);
    const next = cycle[(idx + 1) % cycle.length] ?? null;
    return { ...state, filter: next, scroll: 0 };
  }

  const filteredLen = currentFiltered(state).length;
  const maxScroll = Math.max(0, filteredLen - 1);

  if (key === "up") return { ...state, scroll: clamp(state.scroll + 1, 0, maxScroll) };
  if (key === "down") return { ...state, scroll: clamp(state.scroll - 1, 0, maxScroll) };
  if (key === "pgup") return { ...state, scroll: clamp(state.scroll + PAGE, 0, maxScroll) };
  if (key === "pgdn") return { ...state, scroll: clamp(state.scroll - PAGE, 0, maxScroll) };
  if (key === "home") return { ...state, scroll: maxScroll };
  if (key === "end") return { ...state, scroll: 0 };
  return state;
}

/** Advance the spinner one frame (0..3, wrapping). No clock involved — the caller decides the cadence. */
export function streamTick(state: ToolStreamState): ToolStreamState {
  return { ...state, spinnerPhase: (state.spinnerPhase + 1) % 4 };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Replace every control character -- the C0 range U+0000-U+001F (which
 * includes the ESC byte U+001B that begins every ANSI escape/CSI sequence,
 * and BEL U+0007), DEL U+007F, and the C1 range U+0080-U+009F -- with
 * U+FFFD, one-for-one. A hostile tool output line can therefore never move
 * the cursor, restyle the terminal, or otherwise escape its row: the ESC
 * byte that would start any such sequence is neutralized, leaving only
 * inert printable remainder text.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function sanitizeLine(text: string): string {
  return text.replace(CONTROL_CHARS, "\uFFFD");
}

/** Pad or truncate (with a trailing "…") so the result is exactly `w` code points. */
function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const cps = [...s];
  if (cps.length === w) return s;
  if (cps.length < w) return s + " ".repeat(w - cps.length);
  return cps.slice(0, w - 1).join("") + "…";
}

function composeRowText(ev: ToolStreamEvent, spinner: string): string {
  const taskPart = ev.taskId ? ` #${ev.taskId}` : "";
  return `${spinner}[${ev.kind.toUpperCase()}] ${ev.source}${taskPart} ${ev.line}`;
}

/**
 * Render the stream lane as exactly `height` rows, each exactly `width`
 * Unicode code points wide (hard clamp; correct under CJK/emoji since width
 * is measured in code points, not UTF-16 units). Live-tail by default
 * (`state.scroll === 0` shows the newest events at the bottom); an honest
 * `"…(N more, M dropped)"` header occupies the top row whenever there is
 * more history than currently fits (`N`) or the ring buffer has ever evicted
 * anything (`M`) — never both hidden silently. The newest row carries a
 * spinner glyph (driven by `state.spinnerPhase`) only when `active` is true
 * and the view is at the live tail (a scrolled-back view never shows a
 * spinner on a non-newest row). `state.filter` restricts which events are
 * considered before windowing. Every rendered line is passed through
 * `sanitizeLine` before being fit to `width`.
 */
export function renderToolStream(state: ToolStreamState, width: number, height: number, active: boolean): string[] {
  const W = Math.max(1, Math.floor(width));
  const H = Math.max(0, Math.floor(height));
  if (H === 0) return [];

  const filtered = currentFiltered(state);
  const total = filtered.length;

  const headerNeeded = total > H || state.dropped > 0;
  const contentRows = headerNeeded ? Math.max(0, H - 1) : H;

  const clampedScroll = total > 0 ? clamp(Math.floor(state.scroll), 0, Math.max(0, total - 1)) : 0;
  const bottom = total > 0 ? total - 1 - clampedScroll : -1;
  const start = total > 0 ? Math.max(0, bottom - contentRows + 1) : 0;
  const end = total > 0 ? bottom + 1 : 0;
  const visible = filtered.slice(start, end);
  const hidden = Math.max(0, total - visible.length);

  const rows: string[] = [];
  if (headerNeeded) {
    rows.push(fit(sanitizeLine(`…(${hidden} more, ${state.dropped} dropped)`), W));
  }
  for (let i = 0; i < visible.length; i++) {
    const ev = visible[i]!;
    const isNewest = active && start + i === total - 1;
    const spinner = isNewest ? `${SPINNER_GLYPHS[state.spinnerPhase % SPINNER_GLYPHS.length]} ` : "";
    rows.push(fit(sanitizeLine(composeRowText(ev, spinner)), W));
  }
  while (rows.length < H) rows.push(fit("", W));
  return rows.slice(0, H);
}
