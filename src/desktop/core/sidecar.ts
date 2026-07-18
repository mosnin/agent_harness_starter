/**
 * Sidecar brain — the headless engine behind the Hades native desktop app.
 *
 * The Tauri window never talks to the swarm directly. It spawns this sidecar
 * as a Node process, writes {@link Command}s to it, and reads {@link AppEvent}s
 * back (see `src/desktop/ipc/contract.ts` for the wire format). This module is
 * the process-independent core of that bridge: given a `Command`, drive the
 * real swarm (`src/swarm-runtime`) and translate whatever it reports into the
 * IPC contract's view models.
 *
 * `Sidecar` never talks to `buildSwarm`/`SwarmManager` directly — it depends on
 * the small {@link SwarmHandle} surface, built for the real engine by
 * {@link realSwarmFactory}. That keeps the class fully unit-testable with a
 * scripted fake and keeps this file the only place that knows how to *drive* a
 * swarm; everything else here just maps shapes and guards failures.
 */

import { EventEmitter } from "node:events";
import type {
  AppEvent,
  Command,
  MetricsView,
  RunView,
  TaskView,
  VerificationView,
  WorkerView,
} from "../ipc/contract";
import {
  isMetricsView,
  isRunView,
  isTaskView,
  isVerificationView,
  isWorkerView,
} from "../ipc/contract";
import { buildSwarm } from "../../swarm-runtime/server/build-swarm";

// ---------------------------------------------------------------------------
// The minimal surface the sidecar needs from a swarm.
// ---------------------------------------------------------------------------

export interface SwarmHandle {
  dispatchGoal(objective: string): Promise<{ goalId: string }> | { goalId: string };
  cancelGoal?(goalId: string): void | Promise<void>;
  scalePool?(size: number): void | Promise<void>;
  killWorker?(id: string): void | Promise<void>;
  snapshot(): { workers: unknown[]; tasks: unknown[]; goals?: unknown[]; verifications?: unknown[]; metrics?: unknown };
  /** If the underlying engine emits progress events, subscribe here. */
  on?(event: string, cb: (payload: unknown) => void): void;
  close?(): Promise<void> | void;
}

export type SwarmFactory = (opts: {
  mode: "inline" | "process" | "docker";
  poolSize: number;
}) => Promise<SwarmHandle> | SwarmHandle;

export interface SidecarOptions {
  /** Defaults to {@link realSwarmFactory}. */
  factory?: SwarmFactory;
  emit: (e: AppEvent) => void;
  now?: () => number;
}

/**
 * Manager events that mean "something changed, re-poll the snapshot." These
 * are exactly the event names `SwarmManager` (`src/swarm-runtime/manager/manager.ts`)
 * emits for goal/task/worker lifecycle transitions — see `ManagerEvents` there.
 * `realSwarmFactory` forwards them verbatim through `SwarmHandle.on`, so a fake
 * test handle can simulate the real engine by firing these same names.
 */
const PROGRESS_EVENTS = [
  "goal:planned",
  "worker:spawned",
  "worker:killed",
  "worker:dead",
  "task:dispatched",
  "task:verified",
  "task:rejected",
  "task:failed",
  "task:requeued",
  "task:escalated",
  "goal:completed",
  "goal:failed",
  "goal:aborted",
  "goal:contradiction",
] as const;

export class Sidecar {
  private handleRef?: SwarmHandle;
  private readonly factory: SwarmFactory;
  private readonly emitFn: (e: AppEvent) => void;
  private readonly now: () => number;

  private mode: "inline" | "process" | "docker" = "inline";
  private poolSize = 0;

  // Diff caches so re-polling only emits upserts for state that actually
  // changed, keyed by id -> serialized last-seen view.
  private readonly lastWorkers = new Map<string, string>();
  private readonly lastTasks = new Map<string, string>();
  private readonly lastGoals = new Map<string, string>();
  private seenVerifications = 0;

  constructor(opts: SidecarOptions) {
    this.factory = opts.factory ?? realSwarmFactory();
    this.emitFn = opts.emit;
    this.now = opts.now ?? Date.now;
  }

  /** Process one command. Never throws — a failure becomes a `log` event. */
  async handle(cmd: Command): Promise<void> {
    try {
      switch (cmd.kind) {
        case "runtime.start":
          await this.onStart(cmd);
          return;
        case "runtime.stop":
          await this.onStop();
          return;
        case "goal.dispatch":
          await this.onDispatch(cmd);
          return;
        case "goal.cancel":
          await this.onCancel(cmd);
          return;
        case "pool.scale":
          await this.onScale(cmd);
          return;
        case "worker.kill":
          await this.onKill(cmd);
          return;
        case "skills.list":
        case "skills.save":
          // Owned by a different workstream (the skills view / SKILL.md
          // library) — not this sidecar's concern. Acknowledge harmlessly
          // rather than error, so a caller waiting on a reply never hangs.
          return;
        default: {
          const exhaustive: never = cmd;
          return exhaustive;
        }
      }
    } catch (err) {
      this.safeEmit({ kind: "log", line: `sidecar error: ${errMsg(err)}`, at: this.now() });
    }
  }

  /** Tear down the current swarm handle, if any. Best-effort, never throws. */
  async close(): Promise<void> {
    const h = this.handleRef;
    this.handleRef = undefined;
    if (!h) return;
    try {
      await h.close?.();
    } catch {
      /* best-effort teardown */
    }
  }

  // ── Command handlers ───────────────────────────────────────────────────

  private async onStart(cmd: Extract<Command, { kind: "runtime.start" }>): Promise<void> {
    if (this.handleRef) await this.close();

    const built = await this.factory({ mode: cmd.mode, poolSize: cmd.poolSize });
    this.handleRef = built;
    this.mode = cmd.mode;
    this.poolSize = cmd.poolSize;

    this.lastWorkers.clear();
    this.lastTasks.clear();
    this.lastGoals.clear();
    this.seenVerifications = 0;

    this.subscribe(built);
    this.safeEmit({ kind: "runtime.status", running: true, mode: cmd.mode, poolSize: cmd.poolSize });
    this.poll();
  }

  private async onStop(): Promise<void> {
    await this.close();
    this.safeEmit({ kind: "runtime.status", running: false, mode: this.mode, poolSize: this.poolSize });
  }

  private async onDispatch(cmd: Extract<Command, { kind: "goal.dispatch" }>): Promise<void> {
    const h = this.requireHandle();
    const { goalId } = await h.dispatchGoal(cmd.objective);
    const run: RunView = { goalId, objective: cmd.objective, status: "running" };
    this.lastGoals.set(goalId, JSON.stringify(run));
    this.safeEmit({ kind: "run.upsert", run });
    this.poll();
  }

  private async onCancel(cmd: Extract<Command, { kind: "goal.cancel" }>): Promise<void> {
    const h = this.requireHandle();
    await h.cancelGoal?.(cmd.goalId);
    this.poll();
  }

  private async onScale(cmd: Extract<Command, { kind: "pool.scale" }>): Promise<void> {
    const h = this.requireHandle();
    await h.scalePool?.(cmd.size);
    this.poolSize = cmd.size;
    this.poll();
  }

  private async onKill(cmd: Extract<Command, { kind: "worker.kill" }>): Promise<void> {
    const h = this.requireHandle();
    await h.killWorker?.(cmd.workerId);
    this.poll();
  }

  private requireHandle(): SwarmHandle {
    if (!this.handleRef) throw new Error("sidecar: runtime not started — send runtime.start first");
    return this.handleRef;
  }

  // ── Event-driven + polled streaming ────────────────────────────────────

  /**
   * Bridge the engine's own progress events (if the handle exposes `on`) to a
   * snapshot re-poll, so real swarm activity streams out without a timer.
   * `realSwarmFactory` forwards `SwarmManager`'s events under these exact
   * names; a fake test handle can fire the same names to simulate them.
   */
  private subscribe(h: SwarmHandle): void {
    if (!h.on) return;
    for (const name of PROGRESS_EVENTS) h.on(name, () => this.poll());
    h.on("log", (payload: unknown) => {
      this.safeEmit({ kind: "log", line: normalizeLogPayload(payload), at: this.now() });
    });
  }

  /**
   * Re-read the handle's snapshot and emit upserts for anything that changed
   * since the last poll. Called synchronously after every command that can
   * change swarm state, and reactively whenever a subscribed progress event
   * fires. No internal timers — callers (or the engine's own events) drive
   * when this runs, which is what keeps it deterministic under test.
   */
  private poll(): void {
    const h = this.handleRef;
    if (!h) return;

    let snap: ReturnType<SwarmHandle["snapshot"]>;
    try {
      snap = h.snapshot();
    } catch (err) {
      this.safeEmit({ kind: "log", line: `snapshot failed: ${errMsg(err)}`, at: this.now() });
      return;
    }

    for (const raw of snap.workers ?? []) {
      const view = toWorkerView(raw);
      if (!view) continue;
      const key = JSON.stringify(view);
      if (this.lastWorkers.get(view.id) === key) continue;
      this.lastWorkers.set(view.id, key);
      this.safeEmit({ kind: "worker.upsert", worker: view });
    }

    for (const raw of snap.tasks ?? []) {
      const view = toTaskView(raw);
      if (!view) continue;
      const key = JSON.stringify(view);
      if (this.lastTasks.get(view.id) === key) continue;
      this.lastTasks.set(view.id, key);
      this.safeEmit({ kind: "task.upsert", task: view });
    }

    for (const raw of snap.goals ?? []) {
      const view = toRunView(raw);
      if (!view) continue;
      const key = JSON.stringify(view);
      if (this.lastGoals.get(view.goalId) === key) continue;
      this.lastGoals.set(view.goalId, key);
      this.safeEmit({ kind: "run.upsert", run: view });
    }

    // Verification reports are append-only in the engine (SwarmManager never
    // mutates a past report), so only the tail beyond what we've already
    // emitted is new.
    const verifs = snap.verifications ?? [];
    for (let i = this.seenVerifications; i < verifs.length; i++) {
      const view = toVerificationView(verifs[i]);
      if (view) this.safeEmit({ kind: "verification", report: view });
    }
    this.seenVerifications = verifs.length;

    if (snap.metrics !== undefined) {
      const view = toMetricsView(snap.metrics);
      if (view) this.safeEmit({ kind: "metrics", metrics: view });
    }
  }

  private safeEmit(e: AppEvent): void {
    try {
      this.emitFn(e);
    } catch {
      /* a bad sink must never break the sidecar */
    }
  }
}

// ---------------------------------------------------------------------------
// Real engine wiring
// ---------------------------------------------------------------------------

/**
 * Build a {@link SwarmFactory} backed by the real engine: `buildSwarm` from
 * `src/swarm-runtime/server/build-swarm.ts` assembles a `SwarmManager` (plus
 * its provider/bus for the requested isolation mode) and starts its worker
 * pool; this wraps that manager in the minimal `SwarmHandle` surface the
 * sidecar depends on.
 *
 * - `dispatchGoal` -> `manager.startGoal` (fire-and-track; the manager runs
 *   the goal to completion in the background, exactly as it does for the
 *   REST/MCP surfaces).
 * - `cancelGoal`/`scalePool`/`killWorker` -> `manager.cancelGoal` /
 *   `manager.scalePool` / `manager.killWorker` directly.
 * - `snapshot` -> `manager.listWorkers()` / `listTasks()` / `listGoals()` /
 *   `listVerifications()` / `metrics()` — the same accessors the swarm's own
 *   REST dashboard uses.
 * - `on` -> forwards to the manager's `EventEmitter` (`SwarmManager` extends
 *   `EventEmitter` and emits the `ManagerEvents` named events), so the
 *   sidecar's `PROGRESS_EVENTS` subscription drives real-time re-polling.
 * - `close` -> `built.stop()`, which calls `manager.shutdown()`.
 */
export function realSwarmFactory(): SwarmFactory {
  return async ({ mode, poolSize }) => {
    const built = await buildSwarm({ mode, poolSize });
    await built.start();
    const manager = built.manager;
    const emitter = manager as unknown as EventEmitter;

    const handle: SwarmHandle = {
      async dispatchGoal(objective: string) {
        const { goalId } = await manager.startGoal(objective);
        return { goalId };
      },
      async cancelGoal(goalId: string) {
        manager.cancelGoal(goalId);
      },
      async scalePool(size: number) {
        await manager.scalePool(size);
      },
      async killWorker(id: string) {
        await manager.killWorker(id, "operator request");
      },
      snapshot() {
        return {
          workers: manager.listWorkers(),
          tasks: manager.listTasks(),
          goals: manager.listGoals(),
          verifications: manager.listVerifications(),
          metrics: manager.metrics(),
        };
      },
      on(event: string, cb: (payload: unknown) => void) {
        emitter.on(event, (...args: unknown[]) => cb(args.length <= 1 ? args[0] : args));
      },
      async close() {
        await built.stop();
      },
    };

    return handle;
  };
}

// ---------------------------------------------------------------------------
// Engine shape -> IPC view mapping
// ---------------------------------------------------------------------------
//
// Each mapper accepts the real engine's raw shape (`WorkerRecord` /
// `WorkerTask` / `Goal` / `VerificationReport` / `SwarmMetrics` from
// `src/swarm-runtime/types.ts`) and always rebuilds a fresh object with
// exactly the contract's fields — deliberately never short-circuits by
// returning `raw` even when it already structurally satisfies `isXView`,
// because the engine's real shapes carry extra fields (e.g. a
// `VerificationReport` has `feedback`/`at`, and each check has a `weight`)
// that the `isXView` guards don't reject (they only check that the required
// fields are present and well-typed, not that there's nothing extra). The
// `isXView` guards from `../ipc/contract` still do the final validation on
// the rebuilt candidate, so a malformed snapshot entry is dropped rather than
// emitted.

function toWorkerView(raw: unknown): WorkerView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const candidate: WorkerView = {
    id: str(r.id ?? r.workerId),
    status: r.status as WorkerView["status"],
    capabilities: Array.isArray(r.capabilities)
      ? (r.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
      : [],
    killReason: typeof r.killReason === "string" ? r.killReason : undefined,
  };
  return isWorkerView(candidate) ? candidate : null;
}

function toTaskView(raw: unknown): TaskView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const dependsOn = Array.isArray(r.dependsOn)
    ? (r.dependsOn as unknown[]).filter((c): c is string => typeof c === "string")
    : undefined;
  const candidate: TaskView = {
    id: str(r.id ?? r.taskId),
    description: str(r.description),
    status: r.status as TaskView["status"],
    requiredCapabilities: Array.isArray(r.requiredCapabilities)
      ? (r.requiredCapabilities as unknown[]).filter((c): c is string => typeof c === "string")
      : [],
    attempts: num(r.attempts),
    maxAttempts: num(r.maxAttempts),
    dependsOn,
  };
  return isTaskView(candidate) ? candidate : null;
}

function toVerificationView(raw: unknown): VerificationView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const checksSrc = Array.isArray(r.checks) ? (r.checks as unknown[]) : [];
  const candidate: VerificationView = {
    taskId: str(r.taskId),
    workerId: str(r.workerId),
    verdict: r.verdict as VerificationView["verdict"],
    score: num(r.score),
    // Engine checks also carry a `weight` (used for gate scoring); the view
    // only surfaces name/passed/detail.
    checks: checksSrc.map((c) => {
      const cc = (c ?? {}) as Record<string, unknown>;
      return { name: str(cc.name), passed: !!cc.passed, detail: str(cc.detail) };
    }),
  };
  return isVerificationView(candidate) ? candidate : null;
}

function toRunView(raw: unknown): RunView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Engine `GoalStatus` is "planning"|"running"|"completed"|"failed"|"aborted";
  // the view has no "planning" (still in-flight, so treat as running) and
  // calls the manager's "aborted" (budget breach / cancelGoal) "cancelled".
  const rawStatus = r.status;
  const status = rawStatus === "aborted" ? "cancelled" : rawStatus === "planning" ? "running" : rawStatus;
  const candidate: RunView = {
    goalId: str(r.goalId ?? r.id),
    objective: str(r.objective),
    status: status as RunView["status"],
  };
  return isRunView(candidate) ? candidate : null;
}

function toMetricsView(raw: unknown): MetricsView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const goals = (r.goals ?? {}) as Record<string, unknown>;
  const tasks = (r.tasks ?? {}) as Record<string, unknown>;
  const verification = (r.verification ?? {}) as Record<string, unknown>;
  const usage = (r.usage ?? {}) as Record<string, unknown>;
  const candidate: MetricsView = {
    goalsCompleted: num(goals.completed),
    goalsTotal: num(goals.total),
    groundingRate: num(verification.groundingRate),
    costUsd: num(usage.costUsd),
    verifiedTasks: num(tasks.verified),
    // SwarmMetrics.tasks tracks verified/failed/pending/dispatched but not a
    // "rejected" bucket (a task's "rejected" status is transient — it either
    // gets retried or becomes "failed"); verification.rejected is the
    // meaningful count of rejected *attempts* and is what the dashboard wants.
    rejectedTasks: num(verification.rejected),
  };
  return isMetricsView(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

/**
 * `SwarmManager`'s `log` event fires as `(workerId, line)` — two positional
 * args, which `realSwarmFactory`'s generic `on` forwarding hands to us as
 * `[workerId, line]`. Normalize that (and a couple of other reasonable
 * shapes a fake test handle might use) into a single line of text.
 */
function normalizeLogPayload(payload: unknown): string {
  if (Array.isArray(payload)) {
    const [a, b] = payload;
    if (typeof b === "string") return typeof a === "string" ? `${a}: ${b}` : b;
    if (typeof a === "string") return a;
  }
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).line === "string") {
    return (payload as Record<string, unknown>).line as string;
  }
  return "log";
}
