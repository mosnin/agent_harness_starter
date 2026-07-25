/**
 * Hades desktop IPC contract.
 *
 * The Tauri renderer talks to a local Node sidecar (which drives the swarm)
 * over stdio using newline-delimited JSON. This module is the single source
 * of truth for that wire format: the `Command` union flows renderer -> sidecar,
 * the `AppEvent` union flows sidecar -> renderer.
 *
 * Each subsystem owns its own standalone, dependency-free contract module —
 * the remote-compute fleet (`fleet.*`) in `./fleet-contract.ts`, the
 * scheduler (`schedule.*`) in `./schedule-contract.ts`, the shared workspace
 * store (`state.*`) in `./state-contract.ts`, migration off Hermes/OpenClaw
 * (`migrate.*`) in `./migrate-contract.ts`, and so on. THIS module is the
 * one that composes them: it merges every kind list, guard and union into
 * the single `Command`/`AppEvent` pair the whole pipe (sidecar entry,
 * bridge, renderer) speaks, with full typing end to end.
 *
 * Pure, deterministic — depends only on `./fleet-contract`.
 */

import {
  FLEET_COMMAND_KINDS,
  FLEET_EVENT_KINDS,
  isFleetCommand,
  isFleetEvent,
} from "./fleet-contract";
import type { FleetCommand, FleetEvent } from "./fleet-contract";
import {
  FLEET_PROVISION_COMMAND_KINDS,
  FLEET_PROVISION_EVENT_KINDS,
  isFleetProvisionCommand,
  isFleetProvisionEvent,
} from "./fleet-provision-contract";
import type { FleetProvisionCommand, FleetProvisionEvent } from "./fleet-provision-contract";
import {
  LEARNING_COMMAND_KINDS,
  LEARNING_EVENT_KINDS,
  isLearningCommand,
  isLearningEvent,
} from "./learning-contract";
import type { LearningCommand, LearningEvent } from "./learning-contract";
import {
  GATEWAY_COMMAND_KINDS,
  GATEWAY_EVENT_KINDS,
  isGatewayCommand,
  isGatewayEvent,
} from "./gateway-contract";
import type { GatewayCommand, GatewayEvent } from "./gateway-contract";
import {
  SCHEDULE_COMMAND_KINDS,
  SCHEDULE_EVENT_KINDS,
  isScheduleCommand,
  isScheduleEvent,
} from "./schedule-contract";
import type { ScheduleCommand, ScheduleEvent } from "./schedule-contract";
import {
  STATE_COMMAND_KINDS,
  STATE_EVENT_KINDS,
  isStateCommand,
  isStateEvent,
} from "./state-contract";
import type { StateCommand, StateEvent } from "./state-contract";
import {
  MIGRATE_COMMAND_KINDS,
  MIGRATE_EVENT_KINDS,
  isMigrateCommand,
  isMigrateEvent,
} from "./migrate-contract";
import type { MigrateCommand, MigrateEvent } from "./migrate-contract";
import {
  TRUST_COMMAND_KINDS,
  TRUST_EVENT_KINDS,
  isTrustCommand,
  isTrustEvent,
} from "./trust-contract";
import type { TrustCommand, TrustEvent } from "./trust-contract";
import {
  MARKET_COMMAND_KINDS,
  MARKET_EVENT_KINDS,
  isMarketCommand,
  isMarketEvent,
} from "./market-contract";
import type { MarketCommand, MarketEvent } from "./market-contract";
import {
  ROUTE_COMMAND_KINDS,
  ROUTE_EVENT_KINDS,
  isRouteCommand,
  isRouteEvent,
} from "./route-contract";
import type { RouteCommand, RouteEvent } from "./route-contract";
import {
  CLUSTER_COMMAND_KINDS,
  CLUSTER_EVENT_KINDS,
  isClusterCommand,
  isClusterEvent,
} from "./cluster-contract";
import type { ClusterCommand, ClusterEvent } from "./cluster-contract";

// Re-exported so consumers can treat this module as the single import point
// for the whole desktop wire format.
export type {
  FleetCommand,
  FleetEvent,
  FleetLifecycleState,
  BackendCostView,
  BackendTelemetryView,
  BackendView,
  FleetWorkerView,
} from "./fleet-contract";
export { isFleetCommand, isFleetEvent, FLEET_COMMAND_KINDS, FLEET_EVENT_KINDS } from "./fleet-contract";
export type {
  FleetProvisionCommand,
  FleetProvisionEvent,
  FleetProvisionSpec,
  FleetProvisionRequirements,
  FleetProvisionRouting,
  FleetRestoredDrop,
} from "./fleet-provision-contract";
export {
  isFleetProvisionCommand,
  isFleetProvisionEvent,
  FLEET_PROVISION_COMMAND_KINDS,
  FLEET_PROVISION_EVENT_KINDS,
} from "./fleet-provision-contract";
export type {
  LearningCommand,
  LearningEvent,
  LearningArmView,
  LearningCountsView,
  LearningStatusView,
} from "./learning-contract";
export {
  isLearningCommand,
  isLearningEvent,
  isLearningArmView,
  isLearningStatusView,
  LEARNING_COMMAND_KINDS,
  LEARNING_EVENT_KINDS,
} from "./learning-contract";
export type {
  GatewayCommand,
  GatewayEvent,
  GatewayProbeView,
  GatewayCountersView,
  GatewayStatusView,
  GatewayPairCodeView,
} from "./gateway-contract";
export {
  isGatewayCommand,
  isGatewayEvent,
  isGatewayProbeView,
  isGatewayStatusView,
  isGatewayPairCodeView,
  GATEWAY_COMMAND_KINDS,
  GATEWAY_EVENT_KINDS,
} from "./gateway-contract";
export type {
  ScheduleCommand,
  ScheduleEvent,
  ScheduleJobView,
  ScheduleRunView,
  ScheduleStatusView,
} from "./schedule-contract";
export {
  isScheduleCommand,
  isScheduleEvent,
  isScheduleJobView,
  isScheduleRunView,
  isScheduleStatusView,
  SCHEDULE_COMMAND_KINDS,
  SCHEDULE_EVENT_KINDS,
} from "./schedule-contract";
export type {
  StateCommand,
  StateEvent,
  WorkspaceRecordView,
  WorkspaceStatusView,
  WorkspaceConflictView,
} from "./state-contract";
export {
  isStateCommand,
  isStateEvent,
  isWorkspaceRecordView,
  isWorkspaceStatusView,
  STATE_COMMAND_KINDS,
  STATE_EVENT_KINDS,
} from "./state-contract";
export type {
  MigrateCommand,
  MigrateEvent,
  MigrateRequestOptions,
  MigrateScanView,
  MigrateSourceView,
  MigratePlanView,
  MigrateActionView,
  MigrateApplyView,
  MigrateReceiptsView,
  MigrateArtifactKind,
} from "./migrate-contract";
export {
  isMigrateCommand,
  isMigrateEvent,
  isMigrateScanView,
  isMigratePlanView,
  isMigrateApplyView,
  isMigrateReceiptsView,
  MIGRATE_COMMAND_KINDS,
  MIGRATE_EVENT_KINDS,
  MIGRATE_ARTIFACT_KINDS,
} from "./migrate-contract";
export type {
  TrustCommand,
  TrustEvent,
  TrustVerifierView,
  TrustDomainView,
  TrustBudgetView,
  TrustStatusView,
  TrustCalibrationView,
} from "./trust-contract";
export {
  isTrustCommand,
  isTrustEvent,
  isTrustVerifierView,
  isTrustDomainView,
  isTrustBudgetView,
  isTrustStatusView,
  isTrustCalibrationView,
  TRUST_COMMAND_KINDS,
  TRUST_EVENT_KINDS,
} from "./trust-contract";
export type {
  MarketCommand,
  MarketEvent,
  MarketParticipantWire,
  MarketStatusWire,
  MarketReputationWire,
  MarketMatchWire,
  MarketBookWire,
  MarketSimulationWire,
} from "./market-contract";
export {
  isMarketCommand,
  isMarketEvent,
  isMarketParticipantWire,
  isMarketStatusWire,
  isMarketReputationWire,
  isMarketMatchWire,
  isMarketBookWire,
  isMarketSimulationWire,
  MARKET_COMMAND_KINDS,
  MARKET_EVENT_KINDS,
} from "./market-contract";
export type {
  RouteCommand,
  RouteEvent,
  RouteArmWire,
  RouteStatusWire,
  RouteEligibilityWire,
  RouteRankedArmWire,
  RouteExplainWire,
  RouteAttributionWire,
  RouteLedgerEntryWire,
  RouteLedgerWire,
} from "./route-contract";
export {
  isRouteCommand,
  isRouteEvent,
  isRouteArmWire,
  isRouteStatusWire,
  isRouteEligibilityWire,
  isRouteRankedArmWire,
  isRouteExplainWire,
  isRouteAttributionWire,
  isRouteLedgerEntryWire,
  isRouteLedgerWire,
  ROUTE_COMMAND_KINDS,
  ROUTE_EVENT_KINDS,
} from "./route-contract";
export type {
  ClusterCommand,
  ClusterEvent,
  ClusterNodeWire,
  ClusterStatusWire,
  ClusterRunWire,
  ClusterFaultWire,
} from "./cluster-contract";
export {
  isClusterCommand,
  isClusterEvent,
  isClusterNodeWire,
  isClusterStatusWire,
  isClusterRunWire,
  isClusterFaultWire,
  CLUSTER_COMMAND_KINDS,
  CLUSTER_EVENT_KINDS,
} from "./cluster-contract";

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

/**
 * Per-skill trust badge data attached to `skills.list` entries. A deliberate
 * STRUCTURAL match to `SkillTrustBadgeData` (`../core/skill-trust-service.ts`)
 * — duplicated here rather than imported so this module stays the dependency-
 * free single source of truth for the wire format (the service pulls in the
 * hades trust/track engines, which the contract must never do). Every number
 * is real (copied verbatim from the track-record store or the persisted
 * trust state); `null` metrics mean "no track record", never 0.
 */
export interface SkillTrustBadgeView {
  name: string;
  status: "active" | "probation" | "demoted" | "unscored" | "integrity-error";
  wilsonLower: number | null;
  recentBrier: number | null;
  n: number;
  verifiedN: number;
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
  | { kind: "skills.save"; name: string; content: string }
  | FleetCommand
  | FleetProvisionCommand
  | LearningCommand
  | GatewayCommand
  | ScheduleCommand
  | StateCommand
  | MigrateCommand
  | TrustCommand
  | MarketCommand
  | RouteCommand
  | ClusterCommand;

export type AppEvent =
  | { kind: "runtime.status"; running: boolean; mode: string; poolSize: number }
  | { kind: "worker.upsert"; worker: WorkerView }
  | { kind: "task.upsert"; task: TaskView }
  | { kind: "run.upsert"; run: RunView }
  | { kind: "verification"; report: VerificationView }
  | { kind: "certificate"; cert: CertificateView }
  | { kind: "metrics"; metrics: MetricsView }
  | {
      kind: "skills.list";
      skills: Array<{ name: string; description: string; trust?: SkillTrustBadgeView }>;
    }
  | { kind: "log"; line: string; at: number }
  | FleetEvent
  | FleetProvisionEvent
  | LearningEvent
  | GatewayEvent
  | ScheduleEvent
  | StateEvent
  | MigrateEvent
  | TrustEvent
  | MarketEvent
  | RouteEvent
  | ClusterEvent;

const COMMAND_KINDS = [
  "runtime.start",
  "runtime.stop",
  "goal.dispatch",
  "goal.cancel",
  "pool.scale",
  "worker.kill",
  "skills.list",
  "skills.save",
  ...FLEET_COMMAND_KINDS,
  ...FLEET_PROVISION_COMMAND_KINDS,
  ...LEARNING_COMMAND_KINDS,
  ...GATEWAY_COMMAND_KINDS,
  ...SCHEDULE_COMMAND_KINDS,
  ...STATE_COMMAND_KINDS,
  ...MIGRATE_COMMAND_KINDS,
  ...TRUST_COMMAND_KINDS,
  ...MARKET_COMMAND_KINDS,
  ...ROUTE_COMMAND_KINDS,
  ...CLUSTER_COMMAND_KINDS,
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
  ...FLEET_EVENT_KINDS,
  ...FLEET_PROVISION_EVENT_KINDS,
  ...LEARNING_EVENT_KINDS,
  ...GATEWAY_EVENT_KINDS,
  ...SCHEDULE_EVENT_KINDS,
  ...STATE_EVENT_KINDS,
  ...MIGRATE_EVENT_KINDS,
  ...TRUST_EVENT_KINDS,
  ...MARKET_EVENT_KINDS,
  ...ROUTE_EVENT_KINDS,
  ...CLUSTER_EVENT_KINDS,
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

const SKILL_TRUST_STATUSES = [
  "active",
  "probation",
  "demoted",
  "unscored",
  "integrity-error",
] as const;

function isNullableNumber(x: unknown): x is number | null {
  return x === null || (typeof x === "number" && Number.isFinite(x));
}

function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

export function isSkillTrustBadgeView(x: unknown): x is SkillTrustBadgeView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.name) &&
    isOneOf(x.status, SKILL_TRUST_STATUSES) &&
    isNullableNumber(x.wilsonLower) &&
    isNullableNumber(x.recentBrier) &&
    isCount(x.n) &&
    isCount(x.verifiedN)
  );
}

function isSkillEntry(
  x: unknown
): x is { name: string; description: string; trust?: SkillTrustBadgeView } {
  return (
    isPlainObject(x) &&
    isString(x.name) &&
    isString(x.description) &&
    (x.trust === undefined || isSkillTrustBadgeView(x.trust))
  );
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
      // Fleet + fleet-provision + learning + gateway + schedule + state +
      // migrate + trust + market + route + cluster commands are validated by
      // their own contract
      // modules' guards; anything none of them recognizes is not a Command.
      return (
        isFleetCommand(x) ||
        isFleetProvisionCommand(x) ||
        isLearningCommand(x) ||
        isGatewayCommand(x) ||
        isScheduleCommand(x) ||
        isStateCommand(x) ||
        isMigrateCommand(x) ||
        isTrustCommand(x) ||
        isMarketCommand(x) ||
        isRouteCommand(x) ||
        isClusterCommand(x)
      );
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
      // Fleet + fleet-provision + learning + gateway + schedule + state +
      // migrate + trust + market + route + cluster events are validated by
      // their own contract
      // modules' guards; anything none of them recognizes is not an AppEvent.
      return (
        isFleetEvent(x) ||
        isFleetProvisionEvent(x) ||
        isLearningEvent(x) ||
        isGatewayEvent(x) ||
        isScheduleEvent(x) ||
        isStateEvent(x) ||
        isMigrateEvent(x) ||
        isTrustEvent(x) ||
        isMarketEvent(x) ||
        isRouteEvent(x) ||
        isClusterEvent(x)
      );
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
