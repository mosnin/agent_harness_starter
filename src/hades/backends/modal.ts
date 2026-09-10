import type { RemoteBackend, RemoteHandle, RemoteSpec, RemoteState } from "./backend";

/** Modal function-call status, mapped to a {@link RemoteState}. */
export type ModalCallStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface ModalSpawnInput {
  app: string;
  function: string;
  env: Record<string, string>;
  cpus?: number;
  memory?: string;
  timeoutMs?: number;
}

export interface ModalCall {
  callId: string;
  /** URL the manager reaches the worker at (Modal web endpoint / tunnel). */
  url?: string;
}

/**
 * Injectable Modal client. Production wraps Modal's REST/gRPC API; tests supply
 * an in-memory fake so the serverless lifecycle is exercised without an account.
 */
export interface ModalClient {
  isConfigured(): Promise<boolean>;
  spawn(input: ModalSpawnInput): Promise<ModalCall>;
  poll(callId: string): Promise<ModalCallStatus>;
  cancel(callId: string): Promise<void>;
  logs(callId: string, tailLines?: number): Promise<string>;
}

export interface ModalBackendOptions {
  name?: string;
  app?: string;
  function?: string;
  now?: () => number;
}

function mapStatus(s: ModalCallStatus): RemoteState {
  switch (s) {
    case "pending":
      return "provisioning";
    case "running":
      return "running";
    case "cancelled":
      return "stopped";
    case "done":
      return "stopped";
    case "failed":
      return "failed";
  }
}

/**
 * Modal serverless backend. `provision` spawns a Modal function call that hosts
 * the worker and returns its web endpoint. Because Modal bills per running
 * container, this backend implements true scale-to-zero: `hibernate` cancels the
 * live call (cost → 0) while preserving the app + env in `meta`, and `wake`
 * re-spawns a fresh call from that saved spec. All Modal I/O is behind an
 * injectable {@link ModalClient}.
 */
export class ModalBackend implements RemoteBackend {
  readonly name: string;
  private readonly app: string;
  private readonly fn: string;
  private readonly nowFn: () => number;

  constructor(
    private readonly client: ModalClient,
    opts: ModalBackendOptions = {}
  ) {
    this.name = opts.name ?? "modal";
    this.app = opts.app ?? "hades-worker";
    this.fn = opts.function ?? "run_worker";
    this.nowFn = opts.now ?? (() => Date.now());
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await this.client.isConfigured();
    } catch {
      return false;
    }
  }

  private envFor(spec: RemoteSpec): Record<string, string> {
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
    const env = this.envFor(spec);
    const call = await this.client.spawn({
      app: this.app,
      function: this.fn,
      env,
      cpus: spec.limits?.cpus,
      memory: spec.limits?.memory,
      timeoutMs: spec.limits?.timeoutMs,
    });
    return {
      workerId: spec.workerId,
      backend: this.name,
      nativeId: call.callId,
      endpoint: call.url,
      state: "running",
      startedAt: this.nowFn(),
      // Saved so hibernate→wake can re-spawn an identical call.
      meta: { app: this.app, function: this.fn, env, limits: spec.limits },
    };
  }

  async status(handle: RemoteHandle): Promise<RemoteState> {
    if (handle.state === "hibernated") return "hibernated";
    return mapStatus(await this.client.poll(handle.nativeId));
  }

  async terminate(handle: RemoteHandle): Promise<void> {
    if (handle.state !== "hibernated") await this.client.cancel(handle.nativeId);
  }

  async logs(handle: RemoteHandle, tailLines = 100): Promise<string> {
    if (handle.state === "hibernated") return "";
    return this.client.logs(handle.nativeId, tailLines);
  }

  async hibernate(handle: RemoteHandle): Promise<RemoteHandle> {
    // Scale to zero: cancel the running call, keep the spec to wake from.
    await this.client.cancel(handle.nativeId);
    return { ...handle, state: "hibernated", endpoint: undefined };
  }

  async wake(handle: RemoteHandle): Promise<RemoteHandle> {
    const meta = handle.meta as
      | { app: string; function: string; env: Record<string, string>; limits?: RemoteSpec["limits"] }
      | undefined;
    if (!meta) throw new Error(`Cannot wake ${handle.workerId}: missing saved spec`);
    const call = await this.client.spawn({
      app: meta.app,
      function: meta.function,
      env: meta.env,
      cpus: meta.limits?.cpus,
      memory: meta.limits?.memory,
      timeoutMs: meta.limits?.timeoutMs,
    });
    return { ...handle, nativeId: call.callId, endpoint: call.url, state: "running", startedAt: this.nowFn() };
  }
}
