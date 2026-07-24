import { spawn as nodeSpawn } from "node:child_process";
import type { RemoteBackend, RemoteHandle, RemoteSpec, RemoteState } from "./backend";

/**
 * A running local child process, abstracted just enough that tests can supply
 * an in-memory fake instead of a real OS process. The shape mirrors the
 * `ChildProcess` surface {@link defaultSpawn} actually needs.
 */
export interface LocalChild {
  pid: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): void;
}

/** Injectable process launcher. Production wraps `node:child_process.spawn`. */
export type SpawnFn = (command: string, args: string[], opts: { env: Record<string, string> }) => LocalChild;

export interface LocalBackendOptions {
  /** Backend name in the registry. Default "local". */
  name?: string;
  /** Injectable process launcher; defaults to a real `child_process.spawn` wrapper. */
  spawn?: SpawnFn;
  /** Time source (ms). Injectable for deterministic tests. */
  now?: () => number;
  /** Byte cap on the in-memory stdout+stderr ring buffer per worker. Default 64KiB. */
  logBufferBytes?: number;
  /** Grace period between SIGTERM and SIGKILL on terminate(). Default 2000ms. */
  graceMs?: number;
  /** Injectable sleep, used only to time the SIGTERM→SIGKILL grace window. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ENTRYPOINT = [process.execPath, "-e", "setInterval(()=>{},1<<30)"];

/**
 * Real default spawn: wraps `node:child_process.spawn`. Kept as a lazily
 * resolved wrapper (not a top-level `spawn` import binding) so tests can fully
 * replace process creation via the injected {@link SpawnFn} without ever
 * touching a real OS process.
 */
function defaultSpawn(command: string, args: string[], opts: { env: Record<string, string> }): LocalChild {
  const child = nodeSpawn(command, args, { env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  return {
    pid: child.pid ?? -1,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    on: (event, cb) => {
      child.on(event, cb);
    },
  };
}

interface Tracked {
  child: LocalChild;
  handle: RemoteHandle;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  logBuf: Buffer;
  logTruncated: boolean;
}

/**
 * Real local-process backend. Runs a worker as a plain child process on this
 * machine (no container, no remote host) over an injectable {@link SpawnFn} —
 * production spawns a genuine OS process; tests inject a fake `LocalChild` so
 * the full lifecycle (provision → hibernate → wake → terminate) runs without
 * ever forking anything real.
 *
 * `hibernate`/`wake` use POSIX `SIGSTOP`/`SIGCONT`: this **pauses CPU
 * scheduling** for the process (it consumes zero CPU while stopped and any
 * in-flight work simply freezes), but the process's memory stays resident —
 * unlike Modal/Daytona this is *not* scale-to-zero on memory or disk, only on
 * CPU. Callers that need memory reclaimed should `terminate()` instead.
 */
export class LocalProcessBackend implements RemoteBackend {
  readonly name: string;
  private readonly spawnFn: SpawnFn;
  private readonly nowFn: () => number;
  private readonly logBufferBytes: number;
  private readonly graceMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly tracked = new Map<string, Tracked>();

  constructor(opts: LocalBackendOptions = {}) {
    this.name = opts.name ?? "local";
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.nowFn = opts.now ?? (() => Date.now());
    this.logBufferBytes = opts.logBufferBytes ?? 64 * 1024;
    this.graceMs = opts.graceMs ?? 2000;
    this.sleepFn = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Local processes always run somewhere — this backend has no external dependency. */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  private envFor(spec: RemoteSpec): Record<string, string> {
    // Documented precedence: derived SWARM_* keys are the base, `spec.env`
    // (caller-supplied) is applied last and wins on key collision — this
    // matches modal.ts/ssh.ts/singularity.ts/daytona.ts, so a caller can
    // override e.g. SWARM_CAPABILITIES if it genuinely needs to.
    return {
      SWARM_WORKER_ID: spec.workerId,
      SWARM_MANAGER_URL: spec.managerUrl,
      SWARM_AUTH_TOKEN: spec.authToken,
      SWARM_CAPABILITIES: spec.capabilities.join(","),
      ...(spec.model ? { SWARM_MODEL: spec.model } : {}),
      ...spec.env,
    };
  }

  async provision(spec: RemoteSpec): Promise<RemoteHandle> {
    const argv = spec.image && spec.image.trim().length > 0 ? spec.image.trim().split(/\s+/) : DEFAULT_ENTRYPOINT;
    const [command, ...args] = argv;
    const env = this.envFor(spec);
    const child = this.spawnFn(command, args, { env });

    const record: Tracked = {
      child,
      exited: false,
      exitCode: null,
      exitSignal: null,
      logBuf: Buffer.alloc(0),
      logTruncated: false,
      handle: {
        workerId: spec.workerId,
        backend: this.name,
        nativeId: String(child.pid),
        state: "running",
        startedAt: this.nowFn(),
      },
    };
    this.tracked.set(spec.workerId, record);

    const append = (chunk: Buffer) => this.appendLog(record, chunk);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code, signal) => {
      record.exited = true;
      record.exitCode = code;
      record.exitSignal = signal;
      if (record.handle.state !== "hibernated") record.handle.state = code === 0 || code === null ? "stopped" : "failed";
    });

    return { ...record.handle };
  }

  private appendLog(record: Tracked, chunk: Buffer): void {
    const combined = Buffer.concat([record.logBuf, chunk]);
    if (combined.length > this.logBufferBytes) {
      record.logBuf = combined.subarray(combined.length - this.logBufferBytes);
      record.logTruncated = true;
    } else {
      record.logBuf = combined;
    }
  }

  private track(handle: RemoteHandle): Tracked {
    const record = this.tracked.get(handle.workerId);
    if (!record) throw new Error(`local backend: unknown worker ${handle.workerId}`);
    return record;
  }

  /** Liveness probe via `kill(pid, 0)` — throws ESRCH if the pid is gone. */
  private probeAlive(pid: number): boolean {
    try {
      process.kill(pid, 0 as never);
      return true;
    } catch {
      return false;
    }
  }

  async status(handle: RemoteHandle): Promise<RemoteState> {
    const record = this.tracked.get(handle.workerId);
    if (!record) {
      // Cross-process honesty: this backend instance never tracked the worker
      // (e.g. its handle was reconciled from a persisted fleet after a
      // restart), but the handle carries the real OS pid — probe it instead
      // of unconditionally claiming "stopped" for a process that may well
      // still be alive. Limits, stated plainly: kill(pid, 0) cannot
      // distinguish a SIGSTOP'd (hibernated) process from a running one, and
      // a recycled pid belonging to some other program would also probe
      // alive — this is the most truth POSIX gives us without /proc parsing.
      const pid = Number(handle.nativeId);
      if (!Number.isInteger(pid) || pid <= 0) return "stopped";
      return this.probeAlive(pid) ? "running" : "stopped";
    }
    if (record.handle.state === "hibernated") return "hibernated";
    if (record.exited) return record.exitCode === 0 || record.exitCode === null ? "stopped" : "failed";
    return this.probeAlive(record.child.pid) ? "running" : "stopped";
  }

  async logs(handle: RemoteHandle, _tailLines = 100): Promise<string> {
    const record = this.track(handle);
    const text = record.logBuf.toString("utf8");
    return record.logTruncated ? `…[truncated to last ${this.logBufferBytes} bytes]…\n${text}` : text;
  }

  /**
   * Pause the worker's CPU scheduling with SIGSTOP. Idempotent: hibernating an
   * already-hibernated (or already-exited) worker is a no-op that just returns
   * its current handle rather than erroring.
   */
  async hibernate(handle: RemoteHandle): Promise<RemoteHandle> {
    const record = this.track(handle);
    if (record.handle.state === "hibernated") return { ...record.handle };
    if (record.exited) return { ...record.handle };
    record.child.kill("SIGSTOP");
    record.handle = { ...record.handle, state: "hibernated" };
    return { ...record.handle };
  }

  /** Resume a hibernated worker with SIGCONT. Idempotent: waking a running worker is a no-op. */
  async wake(handle: RemoteHandle): Promise<RemoteHandle> {
    const record = this.track(handle);
    if (record.handle.state !== "hibernated") return { ...record.handle };
    if (record.exited) {
      // Process died while stopped — nothing to resume; reflect reality.
      record.handle = { ...record.handle, state: record.exitCode === 0 ? "stopped" : "failed" };
      return { ...record.handle };
    }
    record.child.kill("SIGCONT");
    record.handle = { ...record.handle, state: "running" };
    return { ...record.handle };
  }

  /**
   * SIGTERM, then SIGKILL after `graceMs` if the process hasn't exited.
   * Terminating an already-dead pid (or an unknown worker) is a safe no-op.
   */
  async terminate(handle: RemoteHandle): Promise<void> {
    const record = this.tracked.get(handle.workerId);
    if (!record) {
      // Cross-process orphan teardown: an untracked handle (reconciled from a
      // persisted fleet after a restart) may still point at a live pid.
      // Really kill it — SIGCONT first (a SIGSTOP'd process would otherwise
      // swallow SIGTERM), then the same SIGTERM -> grace -> SIGKILL
      // escalation as the tracked path — instead of silently no-oping and
      // leaking the process forever.
      const pid = Number(handle.nativeId);
      if (!Number.isInteger(pid) || pid <= 0 || !this.probeAlive(pid)) return;
      try {
        process.kill(pid, "SIGCONT");
        process.kill(pid, "SIGTERM");
      } catch {
        return; // died between probe and signal — already gone
      }
      await this.sleepFn(this.graceMs);
      if (this.probeAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* exited during the grace window */
        }
      }
      return;
    }
    if (record.exited) {
      this.tracked.delete(handle.workerId);
      return;
    }
    // A stopped (SIGSTOP'd) process would swallow SIGTERM without acting on it
    // until resumed, so make sure it's running before asking it to exit.
    if (record.handle.state === "hibernated") record.child.kill("SIGCONT");
    const termSent = record.child.kill("SIGTERM");
    if (termSent && !record.exited) {
      await this.sleepFn(this.graceMs);
      if (!record.exited) record.child.kill("SIGKILL");
    }
    this.tracked.delete(handle.workerId);
  }
}
