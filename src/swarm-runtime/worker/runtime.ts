import type { WorkerBus } from "../bus/types";
import type { WorkerResult, WorkerTask } from "../types";
import { DemoExecutor, type TaskExecutor, type WorkerContext } from "./executor";

export interface WorkerRuntimeConfig {
  workerId: string;
  capabilities: string[];
  bus: WorkerBus;
  executor?: TaskExecutor;
  model?: string;
  /** Heartbeat cadence. Default 3s. */
  heartbeatMs?: number;
  /** Long-poll timeout per pull. Default 25s. */
  pollTimeoutMs?: number;
  /** Stop after this many idle polls (no task). 0 = run forever. Default 0. */
  maxIdlePolls?: number;
}

/**
 * The loop that runs *inside* a worker container. It is intentionally minimal
 * and powerless: register, pull one task at a time, execute it, report the
 * result, repeat. It never decides whether its own work is acceptable — that
 * authority belongs solely to the manager's verification gate. A worker cannot
 * mark its own task "done", cannot spawn other workers, and cannot reach the
 * manager's internals; its only channel is the authenticated bus.
 */
export class WorkerRuntime {
  private readonly executor: TaskExecutor;
  private running = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private currentLoad = 0;

  constructor(private readonly config: WorkerRuntimeConfig) {
    this.executor = config.executor ?? new DemoExecutor();
  }

  async start(signal?: AbortSignal): Promise<void> {
    const { bus, workerId, capabilities, model } = this.config;
    await bus.register({ workerId, capabilities, model });
    this.running = true;
    this.startHeartbeat();

    const log = (line: string) => void bus.log(workerId, line).catch(() => undefined);
    const ctx: WorkerContext = { workerId, model, log };

    let idlePolls = 0;
    const maxIdle = this.config.maxIdlePolls ?? 0;

    try {
      while (this.running && !signal?.aborted) {
        const task = await bus.pullTask(workerId, this.config.pollTimeoutMs ?? 25_000);
        if (!task) {
          idlePolls += 1;
          if (maxIdle > 0 && idlePolls >= maxIdle) break;
          continue;
        }
        idlePolls = 0;
        await this.runTask(task, ctx);
      }
    } finally {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.config.bus.deregister(this.config.workerId).catch(() => undefined);
  }

  private async runTask(task: WorkerTask, ctx: WorkerContext): Promise<void> {
    const startedAt = Date.now();
    this.currentLoad = 1;
    let result: WorkerResult;
    try {
      const out = await this.executor.execute(task, ctx);
      result = {
        taskId: task.id,
        workerId: this.config.workerId,
        output: out.output,
        claims: out.claims,
        toolTrace: out.toolTrace,
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (e) {
      result = {
        taskId: task.id,
        workerId: this.config.workerId,
        output: null,
        claims: [],
        toolTrace: [],
        startedAt,
        finishedAt: Date.now(),
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      this.currentLoad = 0;
    }
    await this.config.bus.reportResult(result);
  }

  private startHeartbeat(): void {
    const { bus, workerId } = this.config;
    const beat = () =>
      void bus
        .heartbeat({ workerId, load: this.currentLoad, status: this.currentLoad > 0 ? "busy" : "idle" })
        .catch(() => undefined);
    beat();
    this.heartbeatTimer = setInterval(beat, this.config.heartbeatMs ?? 3000);
    this.heartbeatTimer.unref?.();
  }
}
