import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type {
  ContainerHandle,
  ContainerProvider,
  IsolationKind,
  SpawnSpec,
} from "../types";

/**
 * Runs each worker as an isolated OS **child process**. No Docker required —
 * this is the default for local dev, CI, and tests where container isolation
 * is unavailable but real process isolation (separate memory, separate
 * lifecycle, independent crash domain) is still valuable.
 *
 * The worker entrypoint is `dist-swarm/worker/entrypoint.js` (built from
 * `src/swarm-runtime/worker/entrypoint.ts`). For tests you can point
 * `workerEntry` at any script.
 */
export class LocalProcessProvider implements ContainerProvider {
  readonly kind: IsolationKind = "process";
  private procs = new Map<string, ChildProcess>();
  private logBuffers = new Map<string, string[]>();

  constructor(
    private readonly opts: {
      /** Command to launch (default: current node binary). */
      command?: string;
      /** Args inserted before the entry (e.g. ["tsx"] when command is npx). */
      commandArgs?: string[];
      /** Path to the worker entrypoint script. */
      workerEntry: string;
      /** Max log lines retained per worker. */
      logRingSize?: number;
    }
  ) {}

  async isAvailable(): Promise<boolean> {
    return typeof this.opts.workerEntry === "string" && this.opts.workerEntry.length > 0;
  }

  async spawn(spec: SpawnSpec): Promise<ContainerHandle> {
    const command = this.opts.command ?? process.execPath;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SWARM_WORKER_ID: spec.workerId,
      SWARM_MANAGER_URL: spec.managerUrl,
      SWARM_AUTH_TOKEN: spec.authToken,
      SWARM_CAPABILITIES: spec.capabilities.join(","),
      ...(spec.model ? { SWARM_MODEL: spec.model } : {}),
      ...spec.env,
    };

    const args = [...(this.opts.commandArgs ?? []), this.opts.workerEntry];
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const ring = this.opts.logRingSize ?? 500;
    const buf: string[] = [];
    this.logBuffers.set(spec.workerId, buf);
    const capture = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line) continue;
        buf.push(line);
        if (buf.length > ring) buf.shift();
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    this.procs.set(spec.workerId, child);

    // Surface immediate spawn errors (ENOENT etc.) rather than hanging.
    const err = await Promise.race([
      once(child, "error").then(([e]) => e as Error),
      new Promise<null>((r) => setTimeout(() => r(null), 50)),
    ]);
    if (err) {
      this.procs.delete(spec.workerId);
      throw new Error(`Failed to spawn worker ${spec.workerId}: ${err.message}`);
    }

    // Enforce a hard lifetime ceiling if requested.
    if (spec.limits?.timeoutMs) {
      const t = setTimeout(() => child.kill("SIGKILL"), spec.limits.timeoutMs);
      t.unref?.();
    }

    return {
      workerId: spec.workerId,
      nativeId: String(child.pid ?? -1),
      kind: this.kind,
      startedAt: Date.now(),
    };
  }

  async stop(handle: ContainerHandle, graceMs = 3000): Promise<void> {
    const child = this.procs.get(handle.workerId);
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.procs.delete(handle.workerId);
      return;
    }
    child.kill("SIGTERM");
    const exited = await Promise.race([
      once(child, "exit").then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), graceMs)),
    ]);
    if (!exited) child.kill("SIGKILL");
    this.procs.delete(handle.workerId);
  }

  async isAlive(handle: ContainerHandle): Promise<boolean> {
    const child = this.procs.get(handle.workerId);
    if (!child) return false;
    return child.exitCode === null && child.signalCode === null;
  }

  async logs(handle: ContainerHandle, tailLines = 100): Promise<string> {
    const buf = this.logBuffers.get(handle.workerId) ?? [];
    return buf.slice(-tailLines).join("\n");
  }
}
