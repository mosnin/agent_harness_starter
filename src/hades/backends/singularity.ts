import type { RemoteBackend, RemoteHandle, RemoteSpec, RemoteState } from "./backend";
import type { ExecResult } from "./ssh";

/**
 * Injectable command runner — runs the `apptainer`/`singularity` CLI. Production
 * spawns the local binary; tests supply a fake that simulates the instance table
 * so the backend is exercised without an HPC node or a `.sif` image.
 */
export interface CommandRunner {
  run(bin: string, args: string[]): Promise<ExecResult>;
}

export interface SingularityBackendOptions {
  name?: string;
  /** CLI binary: "apptainer" (default) or "singularity". */
  bin?: string;
  /** Default image (.sif) when a spec doesn't carry one. */
  image?: string;
  now?: () => number;
}

/**
 * Singularity/Apptainer backend for HPC nodes. Runs each worker as a named
 * container **instance** started from a `.sif` image over an injectable
 * {@link CommandRunner}: `provision` runs `instance start` with the worker env,
 * `status` parses `instance list`, `terminate` runs `instance stop`, and `logs`
 * cats the instance's stdout log. Singularity runs on a persistent node rather
 * than a serverless platform, so `hibernate`/`wake` are intentionally absent.
 */
export class SingularityBackend implements RemoteBackend {
  readonly name: string;
  private readonly bin: string;
  private readonly image?: string;
  private readonly nowFn: () => number;

  constructor(
    private readonly runner: CommandRunner,
    opts: SingularityBackendOptions = {}
  ) {
    this.name = opts.name ?? "singularity";
    this.bin = opts.bin ?? "apptainer";
    this.image = opts.image;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await this.runner.run(this.bin, ["--version"]);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  private instanceName(workerId: string): string {
    return `hades-${workerId}`;
  }

  async provision(spec: RemoteSpec): Promise<RemoteHandle> {
    const image = spec.image ?? this.image;
    if (!image) throw new Error(`Singularity provision for ${spec.workerId} requires a .sif image`);
    const env: Record<string, string> = {
      SWARM_WORKER_ID: spec.workerId,
      SWARM_MANAGER_URL: spec.managerUrl,
      SWARM_AUTH_TOKEN: spec.authToken,
      SWARM_CAPABILITIES: spec.capabilities.join(","),
      ...(spec.model ? { SWARM_MODEL: spec.model } : {}),
      ...spec.env,
    };
    const instance = this.instanceName(spec.workerId);
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    const args = ["instance", "start", ...envArgs];
    if (spec.limits?.memory) args.push("--memory", spec.limits.memory);
    args.push(image, instance);

    const r = await this.runner.run(this.bin, args);
    if (r.code !== 0) {
      throw new Error(`Singularity provision failed for ${spec.workerId}: ${r.stderr || r.stdout}`.trim());
    }
    return {
      workerId: spec.workerId,
      backend: this.name,
      nativeId: instance,
      state: "running",
      startedAt: this.nowFn(),
      meta: { image },
    };
  }

  async status(handle: RemoteHandle): Promise<RemoteState> {
    const r = await this.runner.run(this.bin, ["instance", "list"]);
    // `instance list` prints one instance name per line; presence = running.
    const running = r.stdout
      .split(/\r?\n/)
      .some((line) => line.split(/\s+/).includes(handle.nativeId));
    return running ? "running" : "stopped";
  }

  async terminate(handle: RemoteHandle): Promise<void> {
    await this.runner.run(this.bin, ["instance", "stop", handle.nativeId]);
  }

  async logs(handle: RemoteHandle, tailLines = 100): Promise<string> {
    // Apptainer tees instance stdout to ~/.apptainer/instances/logs/.../<name>.out
    const r = await this.runner.run("sh", [
      "-c",
      `tail -n ${tailLines} ~/.apptainer/instances/logs/*/*/${handle.nativeId}.out 2>/dev/null`,
    ]);
    return r.stdout;
  }
}
