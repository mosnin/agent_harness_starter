/**
 * The Phase 6 ecosystem exit: exposes "run a verified swarm task" as a real
 * {@link McpServerTool} (`swarm_run_verified`) so an external MCP client —
 * Claude Desktop, another agent, Hermes itself — can submit an objective and
 * get back a certified, ledger-backed, HONESTLY-statused result from the real
 * swarm engine (`src/swarm-runtime`) plus its verification gate.
 *
 * This module never talks to `SwarmManager` / `createInlineSwarm` /
 * `buildSwarm` directly. It depends on the small {@link SwarmSessionPort}
 * surface, built for the real engine by whatever {@link SwarmSessionFactory}
 * the caller injects (see the test file for the real-engine adapter, modeled
 * on `src/desktop/core/sidecar.ts`'s `realSwarmFactory`, which performs the
 * exact same `manager.startGoal` -> `dispatchGoal` adaptation). That keeps
 * this module fully unit-testable with a scripted fake and keeps the pinned
 * event names (verified against `src/swarm-runtime/manager/manager.ts`'s
 * `ManagerEvents`) the only contract between this tool and the engine.
 *
 * Pinned real event names this module listens for (see `ManagerEvents` in
 * `src/swarm-runtime/manager/manager.ts` — do not invent others):
 *   - `goal:planned`   (goal, tasks: WorkerTask[])
 *   - `task:dispatched` (task: WorkerTask)
 *   - `task:verified`  (task: WorkerTask, report: VerificationReport)
 *   - `task:rejected`  (task: WorkerTask, report: VerificationReport)
 *   - `task:failed`    (task: WorkerTask, reason: string)
 *   - `goal:completed` (goal: Goal)
 *   - `goal:failed`    (goal: Goal, reason: string)
 *   - `goal:aborted`   (goal: Goal, reason: string)
 *
 * The engine has no event literally named "certificate" — `task:verified`
 * and `task:rejected` carry the `VerificationReport` the gate produced for
 * that attempt, which *is* the certification artifact (grounding score,
 * per-check breakdown, verdict). This module treats those report payloads,
 * pushed through **verbatim**, as the `certificates` ledger; `verifications`
 * is a compact `{taskId, verdict, score}` projection of the same events for
 * quick scanning. Neither array is ever synthesized from anything the engine
 * did not actually emit.
 */

import type { McpServerTool } from "./server";

// ---------------------------------------------------------------------------
// Request shape + hand-rolled JSON Schema
// ---------------------------------------------------------------------------

export interface SwarmTaskRequest {
  objective: string;
  poolSize?: number;
  capabilities?: string[];
  maxAttempts?: number;
  timeoutMs?: number;
}

/**
 * Full JSON Schema for {@link SwarmTaskRequest}, advertised verbatim via
 * `tools/list`. Validation itself is performed BY HAND in {@link validateRequest}
 * (no schema-validator dependency) so the tool has zero new deps; this object
 * exists so external MCP clients can introspect the contract.
 */
export const SWARM_TASK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    objective: {
      type: "string",
      minLength: 1,
      description: "The objective to hand the swarm. Required, non-empty.",
    },
    poolSize: {
      type: "integer",
      minimum: 1,
      description: "How many worker containers to run in parallel. Defaults to 3.",
    },
    capabilities: {
      type: "array",
      items: { type: "string" },
      description: "Capabilities the swarm's workers should collectively provide. Defaults to ['general'].",
    },
    maxAttempts: {
      type: "integer",
      minimum: 1,
      description: "Max attempts per task before it is failed. Defaults to 3.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      description: "Wall-clock ceiling for the whole run, in milliseconds. Defaults to 120000.",
    },
  },
  required: ["objective"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Engine port — the minimal surface this module needs from a swarm session
// ---------------------------------------------------------------------------

/**
 * The minimal surface this tool needs from a running swarm session.
 * Structurally compatible with `BuiltSwarm` (`src/swarm-runtime/server/build-swarm.ts`,
 * which already exposes `manager`/`start()`/`stop()`) and with a thin adapter
 * over `createInlineSwarm`'s returned `SwarmManager` — in both cases,
 * `manager.dispatchGoal` is a wrapper around the real `manager.startGoal`,
 * exactly the pattern `src/desktop/core/sidecar.ts`'s `realSwarmFactory`
 * already uses (`dispatchGoal` -> `manager.startGoal`).
 */
export interface SwarmSessionPort {
  manager: {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    dispatchGoal(objective: string): unknown | Promise<unknown>;
  } & Record<string, unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type SwarmSessionFactory = (
  req: Required<Pick<SwarmTaskRequest, "poolSize" | "capabilities" | "maxAttempts">>,
) => Promise<SwarmSessionPort>;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface VerifiedSwarmResult {
  status: "verified" | "partially-verified" | "rejected" | "failed" | "timeout";
  goalId: string;
  objective: string;
  elapsedMs: number;
  tasks: Array<{ id: string; description: string; status: string; attempts: number }>;
  verifications: Array<{ taskId: string; verdict: string; score: number }>;
  certificates: Array<Record<string, unknown>>;
  note?: string;
}

// ---------------------------------------------------------------------------
// Defaults — mirror `src/swarm-runtime/factory.ts` / `manager/manager.ts`
// ---------------------------------------------------------------------------

const DEFAULT_POOL_SIZE = 3;
const DEFAULT_CAPABILITIES: readonly string[] = ["general"];
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OBJECTIVE_LENGTH = 10_000;

const ALLOWED_KEYS = new Set(["objective", "poolSize", "capabilities", "maxAttempts", "timeoutMs"]);

// ---------------------------------------------------------------------------
// Hand-rolled validation
// ---------------------------------------------------------------------------

type ValidationResult =
  | { ok: true; value: SwarmTaskRequest }
  | { ok: false; message: string };

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function validateRequest(args: unknown, maxObjectiveLength: number): ValidationResult {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, message: "swarm_run_verified: invalid input — arguments must be an object" };
  }
  const a = args as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of Object.keys(a)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push(`unexpected property '${key}' is not allowed (additionalProperties: false)`);
    }
  }

  let objective = "";
  if (!("objective" in a) || a.objective === undefined) {
    errors.push("'objective' is required");
  } else if (typeof a.objective !== "string") {
    errors.push(`'objective' must be a string, got ${describeType(a.objective)}`);
  } else if (a.objective.length < 1) {
    errors.push("'objective' must satisfy minLength 1 (got an empty string)");
  } else if (a.objective.length > maxObjectiveLength) {
    errors.push(
      `'objective' exceeds the maximum length of ${maxObjectiveLength} characters (got ${a.objective.length})`,
    );
  } else {
    objective = a.objective;
  }

  let poolSize: number | undefined;
  if (a.poolSize !== undefined) {
    if (typeof a.poolSize !== "number" || !Number.isFinite(a.poolSize)) {
      errors.push(`'poolSize' must be a number, got ${describeType(a.poolSize)}`);
    } else if (!Number.isInteger(a.poolSize)) {
      errors.push(`'poolSize' must be an integer, got ${a.poolSize}`);
    } else if (a.poolSize < 1) {
      errors.push(`'poolSize' must be >= 1, got ${a.poolSize}`);
    } else {
      poolSize = a.poolSize;
    }
  }

  let capabilities: string[] | undefined;
  if (a.capabilities !== undefined) {
    if (!Array.isArray(a.capabilities)) {
      errors.push(`'capabilities' must be an array of strings, got ${describeType(a.capabilities)}`);
    } else if (!a.capabilities.every((c) => typeof c === "string")) {
      errors.push("'capabilities' must be an array of strings; found a non-string element");
    } else {
      capabilities = a.capabilities as string[];
    }
  }

  let maxAttempts: number | undefined;
  if (a.maxAttempts !== undefined) {
    if (typeof a.maxAttempts !== "number" || !Number.isFinite(a.maxAttempts)) {
      errors.push(`'maxAttempts' must be a number, got ${describeType(a.maxAttempts)}`);
    } else if (!Number.isInteger(a.maxAttempts)) {
      errors.push(`'maxAttempts' must be an integer, got ${a.maxAttempts}`);
    } else if (a.maxAttempts < 1) {
      errors.push(`'maxAttempts' must be >= 1, got ${a.maxAttempts}`);
    } else {
      maxAttempts = a.maxAttempts;
    }
  }

  let timeoutMs: number | undefined;
  if (a.timeoutMs !== undefined) {
    if (typeof a.timeoutMs !== "number" || !Number.isFinite(a.timeoutMs)) {
      errors.push(`'timeoutMs' must be a number, got ${describeType(a.timeoutMs)}`);
    } else if (!Number.isInteger(a.timeoutMs)) {
      errors.push(`'timeoutMs' must be an integer, got ${a.timeoutMs}`);
    } else if (a.timeoutMs < 1) {
      errors.push(`'timeoutMs' must be >= 1, got ${a.timeoutMs}`);
    } else {
      timeoutMs = a.timeoutMs;
    }
  }

  if (errors.length > 0) {
    return { ok: false, message: `swarm_run_verified: invalid input — ${errors.join("; ")}` };
  }

  return { ok: true, value: { objective, poolSize, capabilities, maxAttempts, timeoutMs } };
}

// ---------------------------------------------------------------------------
// Event -> snapshot helpers (defensive: never trust the payload shape blindly)
// ---------------------------------------------------------------------------

interface TaskSnapshot {
  id: string;
  description: string;
  status: string;
  attempts: number;
}

function toTaskSnapshot(raw: unknown): TaskSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  return {
    id: r.id,
    description: typeof r.description === "string" ? r.description : "",
    status: typeof r.status === "string" ? r.status : "unknown",
    attempts: typeof r.attempts === "number" && Number.isFinite(r.attempts) ? r.attempts : 0,
  };
}

/** Extract a goal id from either a `dispatchGoal` return value (`{goalId}`) or a `Goal` event payload (`{id}`). */
function extractGoalId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.goalId === "string" && r.goalId.length > 0) return r.goalId;
  if (typeof r.id === "string" && r.id.length > 0) return r.id;
  return undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

// ---------------------------------------------------------------------------
// Event waiter — accumulates the ledger from the manager's real events
// ---------------------------------------------------------------------------

type TerminalOutcome =
  | { kind: "completed"; goalId?: string }
  | { kind: "failed"; reason?: string; goalId?: string }
  | { kind: "aborted"; reason?: string; goalId?: string };

interface Waiter {
  /** Resolves once one of goal:completed/failed/aborted fires. Never rejects. */
  terminal: Promise<TerminalOutcome>;
  tasks: Map<string, TaskSnapshot>;
  verifications: Array<{ taskId: string; verdict: string; score: number }>;
  certificates: Array<Record<string, unknown>>;
  /** Stop accumulating (used once a race winner — including timeout — is known). */
  freeze(): void;
}

function buildWaiter(manager: SwarmSessionPort["manager"]): Waiter {
  const tasks = new Map<string, TaskSnapshot>();
  const verifications: Array<{ taskId: string; verdict: string; score: number }> = [];
  const certificates: Array<Record<string, unknown>> = [];
  let frozen = false;

  const recordTask = (raw: unknown) => {
    if (frozen) return;
    const snap = toTaskSnapshot(raw);
    if (snap) tasks.set(snap.id, snap);
  };

  const recordReport = (raw: unknown) => {
    if (frozen) return;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const r = raw as Record<string, unknown>;
    // Verbatim pass-through — the certificate is exactly what the gate emitted.
    certificates.push({ ...r });
    verifications.push({
      taskId: typeof r.taskId === "string" ? r.taskId : "",
      verdict: typeof r.verdict === "string" ? r.verdict : "unknown",
      score: typeof r.score === "number" && Number.isFinite(r.score) ? r.score : 0,
    });
  };

  let resolveTerminal!: (o: TerminalOutcome) => void;
  const terminal = new Promise<TerminalOutcome>((resolve) => {
    resolveTerminal = resolve;
  });

  manager.on("goal:planned", (...args: unknown[]) => {
    const planTasks = args[1];
    if (Array.isArray(planTasks)) for (const t of planTasks) recordTask(t);
  });
  manager.on("task:dispatched", (...args: unknown[]) => recordTask(args[0]));
  manager.on("task:verified", (...args: unknown[]) => {
    recordTask(args[0]);
    recordReport(args[1]);
  });
  manager.on("task:rejected", (...args: unknown[]) => {
    recordTask(args[0]);
    recordReport(args[1]);
  });
  manager.on("task:failed", (...args: unknown[]) => recordTask(args[0]));
  manager.on("goal:completed", (...args: unknown[]) => {
    if (frozen) return;
    resolveTerminal({ kind: "completed", goalId: extractGoalId(args[0]) });
  });
  manager.on("goal:failed", (...args: unknown[]) => {
    if (frozen) return;
    resolveTerminal({
      kind: "failed",
      reason: typeof args[1] === "string" ? args[1] : undefined,
      goalId: extractGoalId(args[0]),
    });
  });
  manager.on("goal:aborted", (...args: unknown[]) => {
    if (frozen) return;
    resolveTerminal({
      kind: "aborted",
      reason: typeof args[1] === "string" ? args[1] : undefined,
      goalId: extractGoalId(args[0]),
    });
  });

  return {
    terminal,
    tasks,
    verifications,
    certificates,
    freeze() {
      frozen = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Status derivation — honest, never claims "verified" when a verdict was reject
// ---------------------------------------------------------------------------

function deriveOutcome(
  outcome: TerminalOutcome | { kind: "timeout" },
  verifications: Array<{ taskId: string; verdict: string; score: number }>,
  timeoutMs: number,
): { status: VerifiedSwarmResult["status"]; isError: boolean; note?: string } {
  if (outcome.kind === "timeout") {
    return {
      status: "timeout",
      isError: true,
      note: `swarm_run_verified: deadline of ${timeoutMs}ms exceeded before the goal reached a terminal state`,
    };
  }
  if (outcome.kind === "completed") {
    // A completed goal only ever contains tasks in their final "verified" state,
    // but the ledger may still hold earlier reject/revise attempts for a task
    // that eventually succeeded — that history is what separates a clean
    // "verified" run from one that got there only after a correction.
    const hasNonAccept = verifications.some((v) => v.verdict !== "accept");
    return { status: hasNonAccept ? "partially-verified" : "verified", isError: false };
  }
  // "failed" or "aborted": an honest negative outcome from the engine, never an
  // infrastructure error, so isError stays false. Distinguish a goal that failed
  // because the gate actually rejected a result (status "rejected") from one
  // that failed for another reason (budget abort, cancellation, contradiction,
  // a worker that never reported) — status "failed".
  const hasReject = verifications.some((v) => v.verdict === "reject");
  return { status: hasReject ? "rejected" : "failed", isError: false, note: outcome.reason };
}

// ---------------------------------------------------------------------------
// Core run()
// ---------------------------------------------------------------------------

interface RunOpts {
  now: () => number;
  defaultTimeoutMs: number;
  maxObjectiveLength: number;
}

function infraResult(
  objective: string,
  start: number,
  now: () => number,
  note: string,
): { result: VerifiedSwarmResult; isError: boolean } {
  return {
    result: {
      status: "failed",
      goalId: "",
      objective,
      elapsedMs: Math.max(0, now() - start),
      tasks: [],
      verifications: [],
      certificates: [],
      note,
    },
    isError: true,
  };
}

async function runSession(
  session: SwarmSessionPort,
  req: SwarmTaskRequest,
  timeoutMs: number,
  start: number,
  now: () => number,
): Promise<{ result: VerifiedSwarmResult; isError: boolean }> {
  await session.start();

  const waiter = buildWaiter(session.manager);

  const dispatched = await Promise.resolve(session.manager.dispatchGoal(req.objective));
  const dispatchGoalId = extractGoalId(dispatched);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });

  const outcome = await Promise.race([waiter.terminal, timeoutPromise]);
  if (timer) clearTimeout(timer);
  // Freeze the ledger the instant a winner is known — late engine events (or a
  // never-settling scripted port on the timeout path) must not keep mutating
  // state we're about to serialize.
  waiter.freeze();

  const derived = deriveOutcome(outcome, waiter.verifications, timeoutMs);
  const goalId = (outcome.kind !== "timeout" ? outcome.goalId : undefined) ?? dispatchGoalId ?? "";

  const result: VerifiedSwarmResult = {
    status: derived.status,
    goalId,
    objective: req.objective,
    elapsedMs: Math.max(0, now() - start),
    tasks: [...waiter.tasks.values()],
    verifications: waiter.verifications,
    certificates: waiter.certificates,
    note: derived.note,
  };
  return { result, isError: derived.isError };
}

async function runSwarmTask(
  factory: SwarmSessionFactory,
  rawArgs: Record<string, unknown>,
  opts: RunOpts,
): Promise<{ text: string; isError?: boolean }> {
  const validation = validateRequest(rawArgs, opts.maxObjectiveLength);
  if (!validation.ok) {
    return { text: validation.message, isError: true };
  }
  const req = validation.value;
  const start = opts.now();
  const timeoutMs = req.timeoutMs ?? opts.defaultTimeoutMs;
  const factoryArgs: Required<Pick<SwarmTaskRequest, "poolSize" | "capabilities" | "maxAttempts">> = {
    poolSize: req.poolSize ?? DEFAULT_POOL_SIZE,
    capabilities: req.capabilities ? [...req.capabilities] : [...DEFAULT_CAPABILITIES],
    maxAttempts: req.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  };

  let session: SwarmSessionPort;
  try {
    session = await factory(factoryArgs);
  } catch (err) {
    const { result, isError } = infraResult(req.objective, start, opts.now, `factory failed: ${messageOf(err)}`);
    return { text: JSON.stringify(result), isError };
  }

  let outcome: { result: VerifiedSwarmResult; isError: boolean } | undefined;
  try {
    outcome = await runSession(session, req, timeoutMs, start, opts.now);
  } catch (err) {
    outcome = infraResult(req.objective, start, opts.now, `swarm session failed: ${messageOf(err)}`);
  } finally {
    // ALWAYS awaited, even on throw/timeout above — never leak a live session.
    try {
      await session.stop();
    } catch (err) {
      const cleanupNote = `cleanup warning: stop() failed: ${messageOf(err)}`;
      if (!outcome) {
        outcome = infraResult(req.objective, start, opts.now, cleanupNote);
      } else {
        outcome = {
          ...outcome,
          result: {
            ...outcome.result,
            note: outcome.result.note ? `${outcome.result.note}; ${cleanupNote}` : cleanupNote,
          },
        };
      }
    }
  }

  const final = outcome!;
  return { text: JSON.stringify(final.result), isError: final.isError };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createSwarmTaskTool(
  factory: SwarmSessionFactory,
  opts: { now?: () => number; defaultTimeoutMs?: number; maxObjectiveLength?: number } = {},
): McpServerTool {
  const runOpts: RunOpts = {
    now: opts.now ?? Date.now,
    defaultTimeoutMs: opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxObjectiveLength: opts.maxObjectiveLength ?? DEFAULT_MAX_OBJECTIVE_LENGTH,
  };

  return {
    name: "swarm_run_verified",
    description:
      "Dispatch an objective to the real swarm and wait for a gate-verified, ledger-backed result. " +
      "Results are honestly statused: a rejected, partially-verified, failed, or timed-out outcome is " +
      "reported as such — a negative verdict from the verification gate is never upgraded to 'verified'.",
    inputSchema: SWARM_TASK_INPUT_SCHEMA,
    run: (args) => runSwarmTask(factory, args, runOpts),
  };
}
