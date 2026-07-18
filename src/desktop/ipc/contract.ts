/**
 * Hades desktop IPC contract.
 *
 * The Tauri renderer talks to a local Node sidecar (which drives the swarm)
 * over stdio using newline-delimited JSON. This module is the single source
 * of truth for that wire format: the `Command` union flows renderer -> sidecar,
 * the `AppEvent` union flows sidecar -> renderer.
 *
 * Pure, deterministic, dependency-free.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface WorkerView {
  id: string;
  status: "idle" | "busy" | "starting" | "killed" | "dead";
  capabilities: string[];
  killReason?: string;
}

export interface TaskView {
  id: string;
  description: string;
  status:
    | "pending"
    | "dispatched"
    | "reported"
    | "verified"
    | "rejected"
    | "failed";
  requiredCapabilities: string[];
  attempts: number;
  maxAttempts: number;
  dependsOn?: string[];
}

export interface VerificationView {
  taskId: string;
  workerId: string;
  verdict: "accept" | "reject" | "revise";
  score: number;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

export interface CertificateView {
  taskId: string;
  tier: string;
  pCorrect: number;
  epsilon: number;
  signature: string;
  issuedAt: number;
}

export interface MetricsView {
  goalsCompleted: number;
  goalsTotal: number;
  groundingRate: number;
  costUsd: number;
  verifiedTasks: number;
  rejectedTasks: number;
}

export interface RunView {
  goalId: string;
  objective: string;
  status: "running" | "completed" | "failed" | "cancelled";
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type Command =
  | { kind: "runtime.start"; mode: "inline" | "process" | "docker"; poolSize: number }
  | { kind: "runtime.stop" }
  | { kind: "goal.dispatch"; objective: string }
  | { kind: "goal.cancel"; goalId: string }
  | { kind: "pool.scale"; size: number }
  | { kind: "worker.kill"; workerId: string }
  | { kind: "skills.list" }
  | { kind: "skills.save"; name: string; content: string };

export type AppEvent =
  | { kind: "runtime.status"; running: boolean; mode: string; poolSize: number }
  | { kind: "worker.upsert"; worker: WorkerView }
  | { kind: "task.upsert"; task: TaskView }
  | { kind: "run.upsert"; run: RunView }
  | { kind: "verification"; report: VerificationView }
  | { kind: "certificate"; cert: CertificateView }
  | { kind: "metrics"; metrics: MetricsView }
  | { kind: "skills.list"; skills: Array<{ name: string; description: string }> }
  | { kind: "log"; line: string; at: number };

const COMMAND_KINDS = [
  "runtime.start",
  "runtime.stop",
  "goal.dispatch",
  "goal.cancel",
  "pool.scale",
  "worker.kill",
  "skills.list",
  "skills.save",
] as const;

const EVENT_KINDS = [
  "runtime.status",
  "worker.upsert",
  "task.upsert",
  "run.upsert",
  "verification",
  "certificate",
  "metrics",
  "skills.list",
  "log",
] as const;

// ---------------------------------------------------------------------------
// Primitive type helpers
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || typeof x === "string";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

function isOptionalStringArray(x: unknown): x is string[] | undefined {
  return x === undefined || isStringArray(x);
}

function isOneOf<T extends string>(x: unknown, values: readonly T[]): x is T {
  return typeof x === "string" && (values as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// View model guards
// ---------------------------------------------------------------------------

const WORKER_STATUSES = ["idle", "busy", "starting", "killed", "dead"] as const;
const TASK_STATUSES = [
  "pending",
  "dispatched",
  "reported",
  "verified",
  "rejected",
  "failed",
] as const;
const VERDICTS = ["accept", "reject", "revise"] as const;
const RUN_STATUSES = ["running", "completed", "failed", "cancelled"] as const;

export function isWorkerView(x: unknown): x is WorkerView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.id) &&
    isOneOf(x.status, WORKER_STATUSES) &&
    isStringArray(x.capabilities) &&
    isOptionalString(x.killReason)
  );
}

export function isTaskView(x: unknown): x is TaskView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.id) &&
    isString(x.description) &&
    isOneOf(x.status, TASK_STATUSES) &&
    isStringArray(x.requiredCapabilities) &&
    isNumber(x.attempts) &&
    isNumber(x.maxAttempts) &&
    isOptionalStringArray(x.dependsOn)
  );
}

function isCheckEntry(x: unknown): x is { name: string; passed: boolean; detail: string } {
  return (
    isPlainObject(x) && isString(x.name) && isBoolean(x.passed) && isString(x.detail)
  );
}

export function isVerificationView(x: unknown): x is VerificationView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.taskId) &&
    isString(x.workerId) &&
    isOneOf(x.verdict, VERDICTS) &&
    isNumber(x.score) &&
    Array.isArray(x.checks) &&
    x.checks.every(isCheckEntry)
  );
}

export function isCertificateView(x: unknown): x is CertificateView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.taskId) &&
    isString(x.tier) &&
    isNumber(x.pCorrect) &&
    isNumber(x.epsilon) &&
    isString(x.signature) &&
    isNumber(x.issuedAt)
  );
}

export function isMetricsView(x: unknown): x is MetricsView {
  if (!isPlainObject(x)) return false;
  return (
    isNumber(x.goalsCompleted) &&
    isNumber(x.goalsTotal) &&
    isNumber(x.groundingRate) &&
    isNumber(x.costUsd) &&
    isNumber(x.verifiedTasks) &&
    isNumber(x.rejectedTasks)
  );
}

export function isRunView(x: unknown): x is RunView {
  if (!isPlainObject(x)) return false;
  return isString(x.goalId) && isString(x.objective) && isOneOf(x.status, RUN_STATUSES);
}

function isSkillEntry(x: unknown): x is { name: string; description: string } {
  return isPlainObject(x) && isString(x.name) && isString(x.description);
}

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

export function isCommand(x: unknown): x is Command {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "runtime.start":
      return isOneOf(x.mode, ["inline", "process", "docker"]) && isNumber(x.poolSize);
    case "runtime.stop":
      return true;
    case "goal.dispatch":
      return isString(x.objective);
    case "goal.cancel":
      return isString(x.goalId);
    case "pool.scale":
      return isNumber(x.size);
    case "worker.kill":
      return isString(x.workerId);
    case "skills.list":
      return true;
    case "skills.save":
      return isString(x.name) && isString(x.content);
    default:
      return false;
  }
}

export function isAppEvent(x: unknown): x is AppEvent {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "runtime.status":
      return isBoolean(x.running) && isString(x.mode) && isNumber(x.poolSize);
    case "worker.upsert":
      return isWorkerView(x.worker);
    case "task.upsert":
      return isTaskView(x.task);
    case "run.upsert":
      return isRunView(x.run);
    case "verification":
      return isVerificationView(x.report);
    case "certificate":
      return isCertificateView(x.cert);
    case "metrics":
      return isMetricsView(x.metrics);
    case "skills.list":
      return Array.isArray(x.skills) && x.skills.every(isSkillEntry);
    case "log":
      return isString(x.line) && isNumber(x.at);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

function parseLine(line: string, label: "command" | "event"): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error(`bad ${label}: empty line`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`bad ${label}: invalid JSON`);
  }
}

export function encodeCommand(c: Command): string {
  return JSON.stringify(c) + "\n";
}

export function decodeCommand(line: string): Command {
  const parsed = parseLine(line, "command");
  if (!isPlainObject(parsed) || typeof parsed.kind !== "string") {
    throw new Error("bad command: missing kind");
  }
  if (!(COMMAND_KINDS as readonly string[]).includes(parsed.kind)) {
    throw new Error(`bad command: unknown kind "${parsed.kind}"`);
  }
  if (!isCommand(parsed)) {
    throw new Error(`bad command: missing or invalid fields for kind "${parsed.kind}"`);
  }
  return parsed;
}

export function encodeEvent(e: AppEvent): string {
  return JSON.stringify(e) + "\n";
}

export function decodeEvent(line: string): AppEvent {
  const parsed = parseLine(line, "event");
  if (!isPlainObject(parsed) || typeof parsed.kind !== "string") {
    throw new Error("bad event: missing kind");
  }
  if (!(EVENT_KINDS as readonly string[]).includes(parsed.kind)) {
    throw new Error(`bad event: unknown kind "${parsed.kind}"`);
  }
  if (!isAppEvent(parsed)) {
    throw new Error(`bad event: missing or invalid fields for kind "${parsed.kind}"`);
  }
  return parsed;
}
