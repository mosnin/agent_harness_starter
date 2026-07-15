/**
 * Remote execution backends — Phase C.
 *
 * The swarm core's `ContainerProvider` covers *local* isolation (docker /
 * process / inline). A {@link RemoteBackend} is the broader seam for running a
 * worker on *remote* compute: an SSH host, a Modal serverless function, a
 * Daytona workspace, a Singularity/Apptainer node. Beyond spawn/stop it adds a
 * lifecycle state machine and optional hibernate/wake so serverless backends can
 * scale to zero between goals. Every backend takes an INJECTABLE client/exec, so
 * the whole set tests without real remote credentials.
 */

/** Everything a remote backend needs to bring one worker online. */
export interface RemoteSpec {
  workerId: string;
  capabilities: string[];
  /** Control-plane URL the worker calls home to. */
  managerUrl: string;
  authToken: string;
  model?: string;
  env?: Record<string, string>;
  /** Image / runtime reference (backend-specific: docker image, .sif, etc). */
  image?: string;
  limits?: { cpus?: number; memory?: string; timeoutMs?: number };
}

export type RemoteState = "provisioning" | "running" | "hibernated" | "stopped" | "failed";

/** Handle to a worker running on a remote backend. */
export interface RemoteHandle {
  workerId: string;
  /** Name of the backend that owns this handle. */
  backend: string;
  /** Remote instance / job / container id. */
  nativeId: string;
  /** URL the manager reaches the worker at, when it exposes one. */
  endpoint?: string;
  state: RemoteState;
  startedAt: number;
  /** Backend-private data needed to reconnect (host, function id, workspace…). */
  meta?: Record<string, unknown>;
}

export interface RemoteBackend {
  readonly name: string;
  /** Best-effort check that the backend is usable (client configured, reachable). */
  isAvailable(): Promise<boolean>;
  /** Bring a worker online; resolves once it is running (or throws). */
  provision(spec: RemoteSpec): Promise<RemoteHandle>;
  /** Tear the worker down for good. */
  terminate(handle: RemoteHandle): Promise<void>;
  /** Current lifecycle state (liveness probe). */
  status(handle: RemoteHandle): Promise<RemoteState>;
  /** Recent logs for debugging / the GUI. */
  logs(handle: RemoteHandle, tailLines?: number): Promise<string>;
  /** Serverless-only: suspend to zero cost, keeping enough to wake later. */
  hibernate?(handle: RemoteHandle): Promise<RemoteHandle>;
  /** Serverless-only: resume a hibernated worker. */
  wake?(handle: RemoteHandle): Promise<RemoteHandle>;
}

export interface ProvisionResult {
  backend: string;
  handle: RemoteHandle;
}

/**
 * Registry of remote backends. The manager registers whichever backends the
 * deployment has (SSH host, Modal account, …); `provision` picks the requested
 * backend (or the first available one), brings a worker up, and tracks the
 * handle so it can be listed, hibernated, or torn down later.
 */
export class RemoteBackendRegistry {
  private backends = new Map<string, RemoteBackend>();
  private handles = new Map<string, RemoteHandle>();

  register(backend: RemoteBackend): void {
    this.backends.set(backend.name, backend);
  }
  get(name: string): RemoteBackend | undefined {
    return this.backends.get(name);
  }
  names(): string[] {
    return [...this.backends.keys()];
  }

  /** First backend (in registration order) that reports itself available. */
  async firstAvailable(): Promise<RemoteBackend | undefined> {
    for (const b of this.backends.values()) {
      if (await b.isAvailable()) return b;
    }
    return undefined;
  }

  /**
   * Provision a worker. Pass `backend` to target one by name; omit to use the
   * first available backend. Tracks the resulting handle by workerId.
   */
  async provision(spec: RemoteSpec, backend?: string): Promise<ProvisionResult> {
    const b = backend ? this.backends.get(backend) : await this.firstAvailable();
    if (!b) throw new Error(backend ? `Unknown backend: ${backend}` : "No available remote backend");
    if (backend && !(await b.isAvailable())) throw new Error(`Backend not available: ${backend}`);
    const handle = await b.provision(spec);
    this.handles.set(handle.workerId, handle);
    return { backend: b.name, handle };
  }

  handle(workerId: string): RemoteHandle | undefined {
    return this.handles.get(workerId);
  }
  list(): RemoteHandle[] {
    return [...this.handles.values()];
  }

  private backendFor(handle: RemoteHandle): RemoteBackend {
    const b = this.backends.get(handle.backend);
    if (!b) throw new Error(`Backend gone: ${handle.backend}`);
    return b;
  }

  async status(workerId: string): Promise<RemoteState | undefined> {
    const h = this.handles.get(workerId);
    if (!h) return undefined;
    const state = await this.backendFor(h).status(h);
    h.state = state;
    return state;
  }

  async hibernate(workerId: string): Promise<RemoteHandle | undefined> {
    const h = this.handles.get(workerId);
    if (!h) return undefined;
    const b = this.backendFor(h);
    if (!b.hibernate) throw new Error(`Backend ${b.name} does not support hibernate`);
    const next = await b.hibernate(h);
    this.handles.set(workerId, next);
    return next;
  }

  async wake(workerId: string): Promise<RemoteHandle | undefined> {
    const h = this.handles.get(workerId);
    if (!h) return undefined;
    const b = this.backendFor(h);
    if (!b.wake) throw new Error(`Backend ${b.name} does not support wake`);
    const next = await b.wake(h);
    this.handles.set(workerId, next);
    return next;
  }

  /** Terminate one worker and stop tracking it. */
  async terminate(workerId: string): Promise<void> {
    const h = this.handles.get(workerId);
    if (!h) return;
    await this.backendFor(h).terminate(h);
    this.handles.delete(workerId);
  }

  /** Terminate everything (deployment shutdown). */
  async terminateAll(): Promise<void> {
    await Promise.all(this.list().map((h) => this.terminate(h.workerId)));
  }
}
