import type { WorkerResult, WorkerTask } from "../types";
import type {
  HeartbeatInfo,
  ManagerBus,
  WorkerBus,
  WorkerRegistration,
} from "./types";

/**
 * In-process bus implementing both the manager and worker views over a shared
 * task queue. Used for inline mode and tests — no sockets, fully deterministic.
 * The same object is handed to the manager (as {@link ManagerBus}) and to
 * inline workers (as {@link WorkerBus}).
 */
export class InMemoryBus implements ManagerBus, WorkerBus {
  private queue: WorkerTask[] = [];
  private waiters: Array<{
    workerId: string;
    capabilities: string[];
    resolve: (t: WorkerTask | null) => void;
  }> = [];
  private caps = new Map<string, string[]>();

  private registerHandlers: Array<(r: WorkerRegistration) => void> = [];
  private heartbeatHandlers: Array<(h: HeartbeatInfo) => void> = [];
  private resultHandlers: Array<(r: WorkerResult) => void> = [];
  private logHandlers: Array<(w: string, l: string) => void> = [];
  private deregisterHandlers: Array<(w: string) => void> = [];

  // ── Manager view ───────────────────────────────────────────────────────────

  enqueueTask(task: WorkerTask): void {
    // Try to hand it straight to a waiting, capable worker.
    const idx = this.waiters.findIndex((w) => this.canDo(w.capabilities, task));
    if (idx >= 0) {
      const [waiter] = this.waiters.splice(idx, 1);
      waiter.resolve(task);
      return;
    }
    this.queue.push(task);
  }

  onRegister(h: (r: WorkerRegistration) => void): void {
    this.registerHandlers.push(h);
  }
  onHeartbeat(h: (h: HeartbeatInfo) => void): void {
    this.heartbeatHandlers.push(h);
  }
  onResult(h: (r: WorkerResult) => void): void {
    this.resultHandlers.push(h);
  }
  onLog(h: (w: string, l: string) => void): void {
    this.logHandlers.push(h);
  }
  onDeregister(h: (w: string) => void): void {
    this.deregisterHandlers.push(h);
  }

  async close(): Promise<void> {
    for (const w of this.waiters) w.resolve(null);
    this.waiters = [];
  }

  // ── Worker view ────────────────────────────────────────────────────────────

  async register(reg: WorkerRegistration): Promise<void> {
    this.caps.set(reg.workerId, reg.capabilities);
    for (const h of this.registerHandlers) h(reg);
  }

  async pullTask(workerId: string, timeoutMs = 5000): Promise<WorkerTask | null> {
    const capabilities = this.caps.get(workerId) ?? [];
    const idx = this.queue.findIndex((t) => this.canDo(capabilities, t));
    if (idx >= 0) {
      const [task] = this.queue.splice(idx, 1);
      return task;
    }
    return new Promise<WorkerTask | null>((resolve) => {
      const waiter = { workerId, capabilities, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  async reportResult(result: WorkerResult): Promise<void> {
    for (const h of this.resultHandlers) h(result);
  }
  async heartbeat(hb: HeartbeatInfo): Promise<void> {
    for (const h of this.heartbeatHandlers) h(hb);
  }
  async log(workerId: string, line: string): Promise<void> {
    for (const h of this.logHandlers) h(workerId, line);
  }
  async deregister(workerId: string): Promise<void> {
    this.caps.delete(workerId);
    for (const h of this.deregisterHandlers) h(workerId);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private canDo(capabilities: string[], task: WorkerTask): boolean {
    return task.requiredCapabilities.every((c) => capabilities.includes(c));
  }
}
