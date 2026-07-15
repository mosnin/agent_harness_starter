import type { RemoteBackend, RemoteHandle, RemoteSpec, RemoteState } from "./backend";

/** Daytona workspace lifecycle state, mapped to a {@link RemoteState}. */
export type DaytonaState = "starting" | "started" | "stopped" | "error" | "deleted";

export interface DaytonaCreateInput {
  image?: string;
  env: Record<string, string>;
  cpus?: number;
  memory?: string;
}

export interface DaytonaWorkspace {
  workspaceId: string;
  /** URL the manager reaches the worker at. */
  url?: string;
}

/**
 * Injectable Daytona client. Production wraps the Daytona API; tests supply an
 * in-memory fake so the persistent-workspace lifecycle is exercised without an
 * account.
 */
export interface DaytonaClient {
  isConfigured(): Promise<boolean>;
  createWorkspace(input: DaytonaCreateInput): Promise<DaytonaWorkspace>;
  /** Resume a *stopped* workspace — disk state is preserved. */
  startWorkspace(workspaceId: string): Promise<DaytonaWorkspace>;
  /** Stop a workspace but keep its persistent volume (scale-to-zero). */
  stopWorkspace(workspaceId: string): Promise<void>;
  /** Destroy a workspace and its volume. */
  deleteWorkspace(workspaceId: string): Promise<void>;
  getState(workspaceId: string): Promise<DaytonaState>;
  logs(workspaceId: string, tailLines?: number): Promise<string>;
}

export interface DaytonaBackendOptions {
  name?: string;
  image?: string;
  now?: () => number;
}

function mapState(s: DaytonaState): RemoteState {
  switch (s) {
    case "starting":
      return "provisioning";
    case "started":
      return "running";
    case "stopped":
      return "hibernated";
    case "deleted":
      return "stopped";
    case "error":
      return "failed";
  }
}

/**
 * Daytona serverless backend. Unlike Modal (a fresh function call per wake),
 * Daytona workspaces have a **persistent volume**, so scale-to-zero preserves
 * on-disk state: `hibernate` stops the workspace (compute → 0, disk kept) and
 * `wake` *resumes the same workspace id* — the worker comes back to its files.
 * `terminate` destroys the volume for good. All Daytona I/O is behind an
 * injectable {@link DaytonaClient}.
 */
export class DaytonaBackend implements RemoteBackend {
  readonly name: string;
  private readonly image?: string;
  private readonly nowFn: () => number;

  constructor(
    private readonly client: DaytonaClient,
    opts: DaytonaBackendOptions = {}
  ) {
    this.name = opts.name ?? "daytona";
    this.image = opts.image;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await this.client.isConfigured();
    } catch {
      return false;
    }
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
    const ws = await this.client.createWorkspace({
      image: this.image,
      env,
      cpus: spec.limits?.cpus,
      memory: spec.limits?.memory,
    });
    return {
      workerId: spec.workerId,
      backend: this.name,
      nativeId: ws.workspaceId,
      endpoint: ws.url,
      state: "running",
      startedAt: this.nowFn(),
      meta: { image: this.image },
    };
  }

  async status(handle: RemoteHandle): Promise<RemoteState> {
    return mapState(await this.client.getState(handle.nativeId));
  }

  async terminate(handle: RemoteHandle): Promise<void> {
    await this.client.deleteWorkspace(handle.nativeId);
  }

  async logs(handle: RemoteHandle, tailLines = 100): Promise<string> {
    if (handle.state === "hibernated") return "";
    return this.client.logs(handle.nativeId, tailLines);
  }

  async hibernate(handle: RemoteHandle): Promise<RemoteHandle> {
    // Compute → 0, persistent volume kept for wake.
    await this.client.stopWorkspace(handle.nativeId);
    return { ...handle, state: "hibernated", endpoint: undefined };
  }

  async wake(handle: RemoteHandle): Promise<RemoteHandle> {
    // Resume the SAME workspace — files and installed deps are still there.
    const ws = await this.client.startWorkspace(handle.nativeId);
    return { ...handle, endpoint: ws.url, state: "running", startedAt: this.nowFn() };
  }
}
