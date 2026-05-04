/**
 * Workflow state management.
 *
 * WorkflowState tracks the lifecycle of a running workflow: its current step,
 * overall status, elapsed time, and a snapshot of the WorkflowContext. This
 * is what you'd persist to a DB or Redis for durable/resumable workflows.
 *
 * StateStore adapters:
 *   InMemoryStateStore  — dev / testing
 *   (bring your own)   — implement StateStore for Postgres, Redis, DynamoDB, etc.
 *
 * Usage:
 *   const store = new InMemoryStateStore();
 *   const workflow = createWorkflow("pipeline", { stateStore: store }).add(...).build();
 *   const { runId } = await workflow.run(message);
 *   const state = await store.get(runId);
 */

import type { WorkflowContext, StepLogEntry } from "./types";

export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowState {
  runId: string;
  workflowName: string;
  status: WorkflowStatus;
  currentStep: string | null;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  /** Serializable snapshot of the context (stepOutputs + currentMessage). */
  contextSnapshot: {
    currentMessage: string;
    stepOutputs: WorkflowContext["stepOutputs"];
    log: StepLogEntry[];
  };
  error?: string;
  /** Custom metadata attached by the caller. */
  metadata?: Record<string, unknown>;
}

// ── StateStore interface ──────────────────────────────────────────────────────

export interface StateStore {
  save(state: WorkflowState): Promise<void>;
  get(runId: string): Promise<WorkflowState | null>;
  list(workflowName?: string): Promise<WorkflowState[]>;
  delete(runId: string): Promise<void>;
}

// ── In-memory state store ─────────────────────────────────────────────────────

export class InMemoryStateStore implements StateStore {
  private readonly store = new Map<string, WorkflowState>();

  async save(state: WorkflowState): Promise<void> {
    this.store.set(state.runId, { ...state });
  }

  async get(runId: string): Promise<WorkflowState | null> {
    return this.store.get(runId) ?? null;
  }

  async list(workflowName?: string): Promise<WorkflowState[]> {
    const all = [...this.store.values()];
    return workflowName ? all.filter((s) => s.workflowName === workflowName) : all;
  }

  async delete(runId: string): Promise<void> {
    this.store.delete(runId);
  }

  get size(): number { return this.store.size; }
}

// ── WorkflowLogger ────────────────────────────────────────────────────────────

export interface WorkflowLogEntry {
  runId: string;
  workflowName: string;
  level: "info" | "warn" | "error";
  step?: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface WorkflowLogger {
  info(runId: string, workflow: string, message: string, step?: string, meta?: Record<string, unknown>): void;
  warn(runId: string, workflow: string, message: string, step?: string, meta?: Record<string, unknown>): void;
  error(runId: string, workflow: string, message: string, step?: string, meta?: Record<string, unknown>): void;
}

export class ConsoleWorkflowLogger implements WorkflowLogger {
  private write(entry: WorkflowLogEntry): void {
    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  info(runId: string, workflow: string, message: string, step?: string, meta?: Record<string, unknown>): void {
    this.write({ runId, workflowName: workflow, level: "info", step, message, timestamp: Date.now(), metadata: meta });
  }
  warn(runId: string, workflow: string, message: string, step?: string, meta?: Record<string, unknown>): void {
    this.write({ runId, workflowName: workflow, level: "warn", step, message, timestamp: Date.now(), metadata: meta });
  }
  error(runId: string, workflow: string, message: string, step?: string, meta?: Record<string, unknown>): void {
    this.write({ runId, workflowName: workflow, level: "error", step, message, timestamp: Date.now(), metadata: meta });
  }
}

export class NoopWorkflowLogger implements WorkflowLogger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

export class InMemoryWorkflowLogger implements WorkflowLogger {
  readonly entries: WorkflowLogEntry[] = [];
  private push(entry: WorkflowLogEntry): void { this.entries.push(entry); }

  info(runId: string, workflow: string, message: string, step?: string, meta?: Record<string, unknown>): void {
    this.push({ runId, workflowName: workflow, level: "info", step, message, timestamp: Date.now(), metadata: meta });
  }
  warn(runId: string, workflow: string, message: string, step?: string, meta?: Record<string, unknown>): void {
    this.push({ runId, workflowName: workflow, level: "warn", step, message, timestamp: Date.now(), metadata: meta });
  }
  error(runId: string, workflow: string, message: string, step?: string, meta?: Record<string, unknown>): void {
    this.push({ runId, workflowName: workflow, level: "error", step, message, timestamp: Date.now(), metadata: meta });
  }
}
