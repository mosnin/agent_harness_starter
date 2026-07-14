import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ContainerHandle,
  ContainerProvider,
  IsolationKind,
  SpawnSpec,
} from "../types";

const pExecFile = promisify(execFile);

/**
 * Runs each worker as an isolated **Docker container**. This is the production
 * isolation boundary: separate kernel namespaces, cgroup resource limits,
 * optional no-network / read-only-rootfs / all-caps-dropped hardening — so a
 * worker that goes rogue or gets prompt-injected cannot touch the host, the
 * manager, or its sibling workers.
 *
 * Talks to the Docker daemon through the `docker` CLI (no native addon), which
 * keeps the dependency footprint light and works anywhere the daemon is
 * reachable (local socket or DOCKER_HOST).
 */
export class DockerProvider implements ContainerProvider {
  readonly kind: IsolationKind = "docker";
  private handles = new Map<string, string>(); // workerId -> container name

  constructor(
    private readonly opts: {
      /** Default image if a spec doesn't override. */
      image: string;
      /** Docker network to attach workers to (default: bridge, or "none"). */
      network?: string;
      /** Label applied to every container so we can list/clean the swarm. */
      swarmLabel?: string;
      /** Path to the docker binary. */
      dockerBin?: string;
    }
  ) {}

  private get bin(): string {
    return this.opts.dockerBin ?? "docker";
  }

  private containerName(workerId: string): string {
    return `hermes-swarm-worker-${workerId}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await pExecFile(this.bin, ["version", "--format", "{{.Server.Version}}"]);
      return true;
    } catch {
      return false;
    }
  }

  async spawn(spec: SpawnSpec): Promise<ContainerHandle> {
    const name = this.containerName(spec.workerId);
    const image = spec.image ?? this.opts.image;
    const limits = spec.limits ?? {};
    const label = this.opts.swarmLabel ?? "hermes-swarm";

    const args: string[] = [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--label",
      `${label}=worker`,
      "--label",
      `hermes-swarm-worker-id=${spec.workerId}`,
    ];

    // ── Isolation & hardening ────────────────────────────────────────────────
    if (limits.noNetwork) {
      args.push("--network", "none");
    } else if (this.opts.network) {
      args.push("--network", this.opts.network);
    }
    if (limits.readOnlyRootFs) args.push("--read-only", "--tmpfs", "/tmp");
    if (limits.dropAllCapabilities) args.push("--cap-drop", "ALL");
    // Never allow privilege escalation regardless of caller config.
    args.push("--security-opt", "no-new-privileges");
    if (limits.cpus) args.push("--cpus", String(limits.cpus));
    if (limits.memory) args.push("--memory", limits.memory);
    // Bound PIDs to blunt fork-bombs from a misbehaving worker.
    args.push("--pids-limit", "512");

    // ── Environment ──────────────────────────────────────────────────────────
    const env: Record<string, string> = {
      SWARM_WORKER_ID: spec.workerId,
      SWARM_MANAGER_URL: spec.managerUrl,
      SWARM_AUTH_TOKEN: spec.authToken,
      SWARM_CAPABILITIES: spec.capabilities.join(","),
      ...(spec.model ? { SWARM_MODEL: spec.model } : {}),
      ...spec.env,
    };
    for (const [k, v] of Object.entries(env)) {
      args.push("-e", `${k}=${v}`);
    }

    args.push(image);

    const { stdout } = await pExecFile(this.bin, args, { timeout: 60_000 });
    const containerId = stdout.trim();
    this.handles.set(spec.workerId, name);

    return {
      workerId: spec.workerId,
      nativeId: containerId,
      kind: this.kind,
      startedAt: Date.now(),
    };
  }

  async stop(handle: ContainerHandle, graceMs = 5000): Promise<void> {
    const name = this.handles.get(handle.workerId) ?? this.containerName(handle.workerId);
    const graceSecs = Math.max(1, Math.ceil(graceMs / 1000));
    try {
      await pExecFile(this.bin, ["stop", "-t", String(graceSecs), name], {
        timeout: (graceSecs + 5) * 1000,
      });
    } catch {
      // Already gone or unstoppable — force remove.
      try {
        await pExecFile(this.bin, ["rm", "-f", name]);
      } catch {
        /* container already reaped */
      }
    }
    this.handles.delete(handle.workerId);
  }

  async isAlive(handle: ContainerHandle): Promise<boolean> {
    const name = this.handles.get(handle.workerId) ?? this.containerName(handle.workerId);
    try {
      const { stdout } = await pExecFile(this.bin, [
        "inspect",
        "-f",
        "{{.State.Running}}",
        name,
      ]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async logs(handle: ContainerHandle, tailLines = 100): Promise<string> {
    const name = this.handles.get(handle.workerId) ?? this.containerName(handle.workerId);
    try {
      const { stdout, stderr } = await pExecFile(this.bin, [
        "logs",
        "--tail",
        String(tailLines),
        name,
      ]);
      return `${stdout}${stderr}`.trim();
    } catch {
      return "";
    }
  }

  /** Force-remove every container this swarm labelled — used for cleanup. */
  async reapAll(): Promise<void> {
    const label = this.opts.swarmLabel ?? "hermes-swarm";
    try {
      const { stdout } = await pExecFile(this.bin, [
        "ps",
        "-aq",
        "--filter",
        `label=${label}=worker`,
      ]);
      const ids = stdout.split(/\s+/).filter(Boolean);
      if (ids.length) await pExecFile(this.bin, ["rm", "-f", ...ids]);
    } catch {
      /* nothing to reap */
    }
  }
}
