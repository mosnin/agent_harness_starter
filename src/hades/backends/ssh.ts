import type { RemoteBackend, RemoteHandle, RemoteSpec, RemoteState } from "./backend";

/** Result of running one command on the remote host. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Injectable transport that runs a shell command on the remote host. Production
 * shells out to the local `ssh` binary; tests supply a fake that simulates a
 * remote process table — so the backend is exercised without a real host.
 */
export interface SshTransport {
  exec(remoteCommand: string): Promise<ExecResult>;
}

export interface SshBackendOptions {
  name?: string;
  /** Directory on the remote host to run workers from. Default "~/.hades-workers". */
  workDir?: string;
  /**
   * How to launch the worker on the remote host. Receives the resolved env and
   * must print the worker's PID on stdout. Default: node on `workerEntry`.
   */
  workerEntry?: string;
  /** Node binary / launcher on the remote host. Default "node". */
  nodeBin?: string;
  now?: () => number;
}

function shEnvExports(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
}

/**
 * SSH backend — runs each worker as a background process on a remote host over
 * an injectable {@link SshTransport}. `provision` launches the worker with
 * `nohup`, captures its PID as the native id, and tees output to a per-worker
 * log; `status` probes with `kill -0`; `terminate` kills the PID; `logs` tails
 * the file. A plain SSH host is not serverless, so `hibernate`/`wake` are
 * intentionally absent.
 */
export class SshBackend implements RemoteBackend {
  readonly name: string;
  private readonly workDir: string;
  private readonly workerEntry: string;
  private readonly nodeBin: string;
  private readonly nowFn: () => number;

  constructor(
    private readonly transport: SshTransport,
    opts: SshBackendOptions = {}
  ) {
    this.name = opts.name ?? "ssh";
    this.workDir = opts.workDir ?? "~/.hades-workers";
    this.workerEntry = opts.workerEntry ?? "dist-swarm/worker/entrypoint.js";
    this.nodeBin = opts.nodeBin ?? "node";
    this.nowFn = opts.now ?? (() => Date.now());
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await this.transport.exec("echo hades-ok");
      return r.code === 0 && r.stdout.includes("hades-ok");
    } catch {
      return false;
    }
  }

  private logPath(workerId: string): string {
    return `${this.workDir}/worker-${workerId}.log`;
  }

  async provision(spec: RemoteSpec): Promise<RemoteHandle> {
    const env: Record<string, string> = {
      SWARM_WORKER_ID: spec.workerId,
      SWARM_MANAGER_URL: spec.managerUrl,
      SWARM_AUTH_TOKEN: spec.authToken,
      SWARM_CAPABILITIES: spec.capabilities.join(","),
      ...(spec.model ? { SWARM_MODEL: spec.model } : {}),
      ...spec.env,
    };
    const log = this.logPath(spec.workerId);
    const launch =
      `mkdir -p ${this.workDir} && ` +
      `${shEnvExports(env)} nohup ${this.nodeBin} ${this.workerEntry} > ${log} 2>&1 & echo $!`;

    const r = await this.transport.exec(launch);
    const pid = r.stdout.trim().split(/\s+/).pop() ?? "";
    if (r.code !== 0 || !/^\d+$/.test(pid)) {
      throw new Error(`SSH provision failed for ${spec.workerId}: code=${r.code} ${r.stderr || r.stdout}`.trim());
    }
    return {
      workerId: spec.workerId,
      backend: this.name,
      nativeId: pid,
      state: "running",
      startedAt: this.nowFn(),
      meta: { logPath: log },
    };
  }

  async status(handle: RemoteHandle): Promise<RemoteState> {
    const r = await this.transport.exec(`kill -0 ${handle.nativeId} 2>/dev/null && echo alive || echo dead`);
    return r.stdout.includes("alive") ? "running" : "stopped";
  }

  async terminate(handle: RemoteHandle): Promise<void> {
    await this.transport.exec(`kill ${handle.nativeId} 2>/dev/null; exit 0`);
  }

  async logs(handle: RemoteHandle, tailLines = 100): Promise<string> {
    const log = (handle.meta?.logPath as string | undefined) ?? this.logPath(handle.workerId);
    const r = await this.transport.exec(`tail -n ${tailLines} ${log} 2>/dev/null`);
    return r.stdout;
  }
}

/**
 * Real SSH transport: shells out to the local `ssh` binary. Injectable `runLocal`
 * keeps even this factory unit-testable; production leaves it as the default
 * child_process spawner.
 */
export function createSshCliTransport(
  target: string,
  opts: {
    port?: number;
    identityFile?: string;
    runLocal?: (bin: string, argv: string[]) => Promise<ExecResult>;
  } = {}
): SshTransport {
  const runLocal = opts.runLocal ?? defaultRunLocal;
  const baseArgs: string[] = [];
  if (opts.port) baseArgs.push("-p", String(opts.port));
  if (opts.identityFile) baseArgs.push("-i", opts.identityFile);
  baseArgs.push("-o", "BatchMode=yes", target);
  return {
    async exec(remoteCommand: string): Promise<ExecResult> {
      return runLocal("ssh", [...baseArgs, remoteCommand]);
    },
  };
}

async function defaultRunLocal(bin: string, argv: string[]): Promise<ExecResult> {
  const { spawn } = await import("node:child_process");
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (e) => resolve({ stdout, stderr: stderr + String(e), code: 127 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}
