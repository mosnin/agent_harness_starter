import { execFile } from "node:child_process";
import type { RemoteBackend, RemoteHandle, RemoteSpec, RemoteState } from "./backend";
import type { CommandRunner } from "./singularity";
import type { ExecResult } from "./ssh";

export interface DockerBackendOptions {
  /** Backend name in the registry. Default "docker". */
  name?: string;
  /** Injectable command runner; defaults to a real `docker` CLI via `execFile`. */
  runner?: CommandRunner;
  /** Docker CLI binary. Default "docker". */
  binary?: string;
  /** Image used when a spec doesn't carry its own. */
  defaultImage?: string;
  /** Time source (ms). Injectable for deterministic tests. */
  now?: () => number;
  /** How long an `isAvailable()` probe result is cached. Default 30_000ms. */
  probeTtlMs?: number;
}

/** Anything safe to interpolate into a `docker` argv: container names, image refs, env keys/values live here. */
const SAFE_TOKEN = /^[A-Za-z0-9._:/-]+$/;

function assertSafeToken(label: string, value: string): void {
  if (!SAFE_TOKEN.test(value)) {
    throw new Error(`Docker backend: unsafe ${label} ${JSON.stringify(value)} (must match ${SAFE_TOKEN})`);
  }
}

/**
 * Real default runner: shells out to the local `docker` binary via
 * `child_process.execFile` — argv array, never a shell string, so nothing
 * passed through `args` can be interpreted by a shell.
 */
function defaultRunner(): CommandRunner {
  return {
    run(bin: string, args: string[]): Promise<ExecResult> {
      return new Promise((resolve) => {
        execFile(bin, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
          // `error.code` is the process exit code when the binary ran and
          // returned non-zero; it's a string errno (e.g. "ENOENT") when the
          // binary itself couldn't be spawned. Either way, non-zero-number or
          // failed-to-spawn both surface as a non-zero ExecResult code.
          let code = 0;
          if (error) {
            const errCode = (error as NodeJS.ErrnoException).code;
            code = typeof errCode === "number" ? errCode : 1;
          }
          resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
        });
      });
    },
  };
}

/** Docker `inspect` container status strings, mapped to a {@link RemoteState}. */
function mapStatus(status: string): RemoteState {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "hibernated";
    case "created":
      return "provisioning";
    case "exited":
    case "dead":
    case "removing":
      return "stopped";
    default:
      // Unknown docker status strings, and our own "inspect failed" sentinel.
      return "failed";
  }
}

const NOT_FOUND_RE = /no such container/i;

/**
 * Real Docker backend. Runs each worker as a named container over an
 * injectable {@link CommandRunner} — production shells out to the local
 * `docker` binary; tests supply a fake runner that simulates the container
 * table, clearly named as a fake-transport test.
 *
 * `hibernate`/`wake` use `docker pause`/`docker unpause`: this is genuine
 * zero-CPU hibernation — a paused container's process tree is frozen at the
 * cgroup/freezer level and scheduled no CPU time at all, while its filesystem
 * and memory stay intact for `wake` to resume instantly. `terminate` is
 * `docker rm -f`, tolerant of the container already being gone.
 */
export class DockerBackend implements RemoteBackend {
  readonly name: string;
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly defaultImage?: string;
  private readonly nowFn: () => number;
  private readonly probeTtlMs: number;
  private cachedAvailable: { at: number; value: boolean } | undefined;

  constructor(opts: DockerBackendOptions = {}) {
    this.name = opts.name ?? "docker";
    this.runner = opts.runner ?? defaultRunner();
    this.binary = opts.binary ?? "docker";
    this.defaultImage = opts.defaultImage;
    this.nowFn = opts.now ?? (() => Date.now());
    this.probeTtlMs = opts.probeTtlMs ?? 30_000;
  }

  private containerName(workerId: string): string {
    return `hades-${workerId}`;
  }

  async isAvailable(): Promise<boolean> {
    const now = this.nowFn();
    if (this.cachedAvailable && now - this.cachedAvailable.at < this.probeTtlMs) {
      return this.cachedAvailable.value;
    }
    let value: boolean;
    try {
      const r = await this.runner.run(this.binary, ["version", "--format", "{{.Server.Version}}"]);
      value = r.code === 0 && r.stdout.trim().length > 0;
    } catch {
      value = false;
    }
    this.cachedAvailable = { at: now, value };
    return value;
  }

  private envFor(spec: RemoteSpec): Record<string, string> {
    // Same precedence as the other backends: derived SWARM_* keys form the
    // base, spec.env is merged in last and wins on collision.
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
    const image = spec.image ?? this.defaultImage;
    if (!image) throw new Error(`Docker provision for ${spec.workerId} requires an image`);
    assertSafeToken("workerId", spec.workerId);
    assertSafeToken("image", image);

    const name = this.containerName(spec.workerId);
    const env = this.envFor(spec);

    const args = ["run", "-d", "--name", name];
    if (spec.limits?.cpus != null) args.push("--cpus", String(spec.limits.cpus));
    if (spec.limits?.memory) args.push("--memory", spec.limits.memory);
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    args.push(image);

    const r = await this.runner.run(this.binary, args);
    if (r.code !== 0) {
      throw new Error(`Docker provision failed for ${spec.workerId}: ${(r.stderr || r.stdout).trim()}`);
    }
    const nativeId = r.stdout.trim();
    if (!nativeId) {
      throw new Error(`Docker provision for ${spec.workerId} did not return a container id`);
    }
    return {
      workerId: spec.workerId,
      backend: this.name,
      nativeId,
      state: "running",
      startedAt: this.nowFn(),
      meta: { containerName: name, image },
    };
  }

  async status(handle: RemoteHandle): Promise<RemoteState> {
    const r = await this.runner.run(this.binary, ["inspect", "-f", "{{.State.Status}}", handle.nativeId]);
    if (r.code !== 0) return "failed";
    return mapStatus(r.stdout.trim());
  }

  async logs(handle: RemoteHandle, tailLines = 100): Promise<string> {
    const r = await this.runner.run(this.binary, ["logs", "--tail", String(tailLines), handle.nativeId]);
    // `docker logs` interleaves stdout/stderr on the daemon side; the CLI
    // still splits them back into two streams, so merge them here.
    return r.stderr ? `${r.stdout}${r.stderr}` : r.stdout;
  }

  async hibernate(handle: RemoteHandle): Promise<RemoteHandle> {
    const r = await this.runner.run(this.binary, ["pause", handle.nativeId]);
    if (r.code !== 0) {
      throw new Error(`Docker pause failed for ${handle.workerId}: ${(r.stderr || r.stdout).trim()}`);
    }
    return { ...handle, state: "hibernated" };
  }

  async wake(handle: RemoteHandle): Promise<RemoteHandle> {
    const r = await this.runner.run(this.binary, ["unpause", handle.nativeId]);
    if (r.code !== 0) {
      throw new Error(`Docker unpause failed for ${handle.workerId}: ${(r.stderr || r.stdout).trim()}`);
    }
    return { ...handle, state: "running" };
  }

  /** `docker rm -f`, idempotent: a "No such container" stderr counts as success. */
  async terminate(handle: RemoteHandle): Promise<void> {
    const r = await this.runner.run(this.binary, ["rm", "-f", handle.nativeId]);
    if (r.code !== 0 && !NOT_FOUND_RE.test(r.stderr)) {
      throw new Error(`Docker rm failed for ${handle.workerId}: ${(r.stderr || r.stdout).trim()}`);
    }
  }
}
