import type { WorkerResult, WorkerTask } from "../types";

export interface WorkerRegistration {
  workerId: string;
  capabilities: string[];
  model?: string;
}

export interface HeartbeatInfo {
  workerId: string;
  /** 0..1 current load. */
  load: number;
  /** Optional free-text status ("running task X", "idle"). */
  status?: string;
}

/**
 * Manager-side view of the bus. The manager enqueues tasks and consumes worker
 * lifecycle events. Implementations: InMemoryBus (inline/tests) and
 * HttpControlPlane (real, cross-process/cross-container).
 */
export interface ManagerBus {
  /** Make a task available for a capable worker to pull. */
  enqueueTask(task: WorkerTask): void;
  /** Called by the transport when a worker registers. */
  onRegister(handler: (reg: WorkerRegistration) => void): void;
  onHeartbeat(handler: (hb: HeartbeatInfo) => void): void;
  onResult(handler: (result: WorkerResult) => void): void;
  onLog(handler: (workerId: string, line: string) => void): void;
  onDeregister(handler: (workerId: string) => void): void;
  /** Stop serving. */
  close(): Promise<void>;
}

/**
 * Worker-side view of the bus. The worker registers, pulls tasks, and reports
 * results/heartbeats/logs.
 */
export interface WorkerBus {
  register(reg: WorkerRegistration): Promise<void>;
  /** Long-poll for the next task assigned to this worker; null on timeout. */
  pullTask(workerId: string, timeoutMs?: number): Promise<WorkerTask | null>;
  reportResult(result: WorkerResult): Promise<void>;
  heartbeat(hb: HeartbeatInfo): Promise<void>;
  log(workerId: string, line: string): Promise<void>;
  deregister(workerId: string): Promise<void>;
}
