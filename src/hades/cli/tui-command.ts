/**
 * `hades tui` — the interactive live terminal dashboard over the real swarm.
 *
 * This is the surface that runs headless today: no Tauri window, no
 * `src/app/**` web scaffolding — just a keyboard-driven view of the swarm
 * rendered straight to the terminal, the Hermes-style "a real terminal
 * interface" counterpart to the desktop app's sidecar bridge.
 *
 * The actual state machine and renderer already exist and are fully
 * unit-tested on their own (`src/swarm-runtime/tui/app.ts`'s `TuiApp` /
 * `TuiController`, `src/swarm-runtime/tui/render.ts`'s `TuiState`). This file
 * is the thin main-loop that:
 *   - builds a real swarm via `realSwarmFactory()` (or an injected factory),
 *   - adapts it to a `TuiController` (`dispatchGoal`/`scalePool`/`cancel`),
 *   - polls `SwarmHandle.snapshot()` and maps it to `TuiState`,
 *   - pipes raw-mode stdin keypresses into `TuiApp.handleKey`, and
 *   - writes `TuiApp.frame()` to stdout whenever it changes.
 *
 * Like the rest of `hades`'s CLI surfaces, the non-interactive entry point
 * (`runTuiCommand`) is terminal-free — `{ code, lines }`, no `console.log`,
 * no `process.exit` — so `hades tui --help` unit-tests without a shell. The
 * real interactive loop (`runTuiInteractive`) does touch stdin/stdout, but
 * every dependency (streams, the swarm factory, the clock, the poll
 * interval) is injectable, and `deps.once` renders exactly one frame from an
 * initial snapshot and returns — deterministic, no timers, no raw mode —
 * which is what makes it testable headless too.
 *
 * Not wired into `cli.ts`/`index.ts` (the main router owns that centrally),
 * but fully self-contained: importing `runTuiCommand`/`runTuiInteractive`
 * from this module is enough to run the command on its own.
 */

import { TuiApp } from "../../swarm-runtime/tui/app";
import type { TuiController } from "../../swarm-runtime/tui/app";
import type { TuiState } from "../../swarm-runtime/tui/render";
import { realSwarmFactory } from "../../desktop/core/sidecar";
import type { SwarmFactory, SwarmHandle } from "../../desktop/core/sidecar";

export interface TuiCommandResult {
  code: number;
  lines: string[];
}

export interface TuiDeps {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Injectable swarm for tests; defaults to {@link realSwarmFactory}. */
  factory?: SwarmFactory;
  now?: () => number;
  /** Render one frame and return (for tests/CI) — no timers, no raw mode. */
  once?: boolean;
  /** Swarm isolation mode passed to the factory. Default "inline". */
  mode?: "inline" | "process" | "docker";
  /** Initial worker pool size requested from the factory. Default 3. */
  poolSize?: number;
  /** Snapshot poll interval in ms. Default 500. */
  pollIntervalMs?: number;
}

const HELP_LINES = [
  "hades tui — interactive live terminal dashboard over the swarm",
  "",
  "Usage: hades tui",
  "",
  "Keybindings:",
  "  g       start a new goal (compose mode)",
  "  +/-     scale worker pool up/down",
  "  c       cancel the active goal",
  "  ↑/↓     navigate the task list",
  "  ?       toggle the help overlay",
  "  q       quit  (also Ctrl-C)",
  "  (compose mode) type to build the objective, Enter to submit, Esc to cancel",
];

/**
 * Non-interactive help/usage path (terminal-free, like the other hades
 * commands) — returns `{ code, lines }`. With no recognized subcommand this
 * hands off to the real interactive loop, so a central router can wire
 * `case "tui": return runTuiCommand(rest)` and get both behaviors for free.
 */
export async function runTuiCommand(args: string[], deps: TuiDeps = {}): Promise<TuiCommandResult> {
  const [sub] = args;
  if (sub === "--help" || sub === "-h" || sub === "help") {
    return { code: 0, lines: HELP_LINES };
  }
  if (sub !== undefined) {
    return { code: 1, lines: [`Unknown tui argument: ${sub}`, "Run `hades tui --help` for usage."] };
  }
  const code = await runTuiInteractive(deps);
  return { code, lines: [] };
}

// ---------------------------------------------------------------------------
// Swarm snapshot -> TuiState mapping
// ---------------------------------------------------------------------------

type WorkerRow = NonNullable<TuiState["workers"]>[number];
type TaskRow = NonNullable<TuiState["tasks"]>[number];
type LogRow = NonNullable<TuiState["logs"]>[number];

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function toWorkerRow(raw: unknown): WorkerRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const workerId = pickString(r.workerId, r.id);
  const status = typeof r.status === "string" ? r.status : undefined;
  if (!workerId || !status) return null;
  const capabilities = Array.isArray(r.capabilities)
    ? r.capabilities.filter((c): c is string => typeof c === "string")
    : undefined;
  return { workerId, status, capabilities };
}

function toTaskRow(raw: unknown): TaskRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const description = typeof r.description === "string" ? r.description : undefined;
  const status = typeof r.status === "string" ? r.status : undefined;
  if (description === undefined || !status) return null;
  return { description, status };
}

/**
 * Map a raw {@link SwarmHandle} snapshot to the `TuiState` the render layer
 * understands. Defensive like `sidecar.ts`'s view mappers: an entry missing
 * required fields is dropped rather than rendered as garbage; a malformed
 * `metrics` blob is simply omitted (the dashboard renders fine without it).
 */
export function snapshotToTuiState(
  snapshot: ReturnType<SwarmHandle["snapshot"]>,
  mode: string,
  logs: LogRow[] = []
): TuiState {
  const workers = (Array.isArray(snapshot.workers) ? snapshot.workers : [])
    .map(toWorkerRow)
    .filter((w): w is WorkerRow => w !== null);
  const tasks = (Array.isArray(snapshot.tasks) ? snapshot.tasks : [])
    .map(toTaskRow)
    .filter((t): t is TaskRow => t !== null);
  const metrics =
    snapshot.metrics && typeof snapshot.metrics === "object"
      ? (snapshot.metrics as TuiState["metrics"])
      : undefined;

  return {
    mode,
    metrics,
    workers,
    tasks,
    logs,
    groundingRate: metrics?.verification.groundingRate,
  };
}

/**
 * `SwarmManager`'s `log` event fires as `(workerId, line)`; `realSwarmFactory`
 * forwards that through `SwarmHandle.on` as `[workerId, line]`. Normalize
 * whatever shape arrives (including a fake test handle emitting a plain
 * string or `{ workerId, line }`) into the `TuiState.logs` row shape.
 */
function normalizeLogPayload(payload: unknown): LogRow {
  if (Array.isArray(payload)) {
    const [a, b] = payload;
    if (typeof a === "string" && typeof b === "string") return { workerId: a, line: b };
    if (typeof a === "string") return { workerId: "swarm", line: a };
  }
  if (typeof payload === "string") return { workerId: "swarm", line: payload };
  if (payload && typeof payload === "object") {
    const r = payload as Record<string, unknown>;
    if (typeof r.line === "string") {
      return { workerId: typeof r.workerId === "string" ? r.workerId : "swarm", line: r.line };
    }
  }
  return { workerId: "swarm", line: "log" };
}

// ---------------------------------------------------------------------------
// TuiController wiring
// ---------------------------------------------------------------------------

/**
 * Adapt a {@link SwarmHandle} to the `TuiController` surface `TuiApp` drives
 * key presses through. Kept as a standalone factory (rather than inlined in
 * `runTuiInteractive`) so it is directly unit-testable against a scripted
 * fake handle with no terminal, timers, or raw-mode stdin involved.
 *
 * `scalePool` on the controller is relative (+/-1 per keypress); the swarm's
 * `scalePool` is absolute, so this tracks the last-known pool size and turns
 * deltas into an absolute size, clamped at 0. `cancel` targets whichever goal
 * was most recently dispatched (the TUI only ever has one goal in flight at a
 * time from the operator's perspective); it's a no-op until a goal exists.
 */
export function createSwarmController(handle: SwarmHandle, opts: { poolSize?: number } = {}): TuiController {
  let poolSize = Math.max(0, opts.poolSize ?? 0);
  let activeGoalId: string | undefined;

  return {
    dispatchGoal(objective: string): void {
      void Promise.resolve(handle.dispatchGoal(objective))
        .then((res) => {
          activeGoalId = res?.goalId;
        })
        .catch(() => {
          /* failures surface via the swarm's own log/event stream, if any */
        });
    },
    scalePool(delta: number): void {
      poolSize = Math.max(0, poolSize + delta);
      void Promise.resolve(handle.scalePool?.(poolSize)).catch(() => {});
    },
    cancel(): void {
      if (!activeGoalId) return;
      void Promise.resolve(handle.cancelGoal?.(activeGoalId)).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// The real interactive loop
// ---------------------------------------------------------------------------

type RawStdin = NodeJS.ReadStream & { setRawMode?: (mode: boolean) => unknown };

/**
 * The real interactive loop: raw-mode stdin keypresses -> `TuiApp.handleKey`;
 * poll the swarm snapshot -> `TuiState` -> `app.setState`; render
 * `app.frame()` to stdout on change; quit on q/Ctrl-C, restoring the
 * terminal. Resolves with the process exit code.
 *
 * `deps.once` short-circuits all of that: build the handle, read exactly one
 * snapshot, render exactly one frame, close the handle, and return 0 — no
 * stdin is touched at all (so raw mode is never entered), no timers are
 * started. That's the path tests drive.
 */
export async function runTuiInteractive(deps: TuiDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const now = deps.now ?? Date.now;
  const mode = deps.mode ?? "inline";
  const poolSize = deps.poolSize ?? 3;
  const pollIntervalMs = deps.pollIntervalMs ?? 500;

  const factory = deps.factory ?? realSwarmFactory();
  const handle = await factory({ mode, poolSize });

  const logs: LogRow[] = [];
  handle.on?.("log", (payload: unknown) => {
    logs.push(normalizeLogPayload(payload));
    if (logs.length > 50) logs.splice(0, logs.length - 50);
  });

  const controller = createSwarmController(handle, { poolSize });
  const app = new TuiApp({ controller });

  const readState = (): TuiState => snapshotToTuiState(handle.snapshot(), mode, logs.slice(-5));

  if (deps.once) {
    app.setState(readState());
    stdout.write(app.frame());
    await Promise.resolve(handle.close?.()).catch(() => {});
    return 0;
  }

  void now; // reserved clock hook (kept for parity with the rest of the desktop/sidecar deps)

  const stdin = (deps.stdin ?? process.stdin) as RawStdin;

  return new Promise<number>((resolveExit) => {
    let lastFrame = "";
    let finished = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const render = (): void => {
      try {
        app.setState(readState());
      } catch (err) {
        stdout.write(`\n[tui] snapshot failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return;
      }
      const frame = app.frame();
      if (frame !== lastFrame) {
        lastFrame = frame;
        stdout.write(`\x1b[2J\x1b[H${frame}\n`);
      }
    };

    const onData = (chunk: string | Buffer): void => {
      const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const result = app.handleKey(key);
      if (result.quit) {
        void finish(0);
        return;
      }
      render();
    };

    const finish = async (code: number): Promise<void> => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      stdin.removeListener?.("data", onData);
      if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      stdin.pause?.();
      await Promise.resolve(handle.close?.()).catch(() => {});
      resolveExit(code);
    };

    if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.setEncoding?.("utf8");
    stdin.resume?.();
    stdin.on?.("data", onData);

    timer = setInterval(render, pollIntervalMs);
    render();
  });
}
