import type { RemoteBackend, RemoteHandle, RemoteSpec, RemoteState } from "./backend";

export interface FakeBackendOptions {
  name?: string;
  available?: boolean;
  supportsHibernate?: boolean;
  now?: () => number;
}

/**
 * In-process fake remote backend for tests and the in-process demo path. It
 * mimics a serverless backend's lifecycle (provision → running → hibernated →
 * running → stopped) without any remote calls, and records everything it did.
 * When `supportsHibernate` is false, the optional `hibernate`/`wake` methods are
 * genuinely absent, so registry capability checks behave like a real
 * non-serverless backend (e.g. plain SSH).
 */
export class FakeBackend implements RemoteBackend {
  readonly name: string;
  private available: boolean;
  private nowFn: () => number;
  private counter = 0;
  private states = new Map<string, RemoteState>();
  private logLines = new Map<string, string[]>();
  readonly events: string[] = [];

  hibernate?: (handle: RemoteHandle) => Promise<RemoteHandle>;
  wake?: (handle: RemoteHandle) => Promise<RemoteHandle>;

  constructor(opts: FakeBackendOptions = {}) {
    this.name = opts.name ?? "fake";
    this.available = opts.available ?? true;
    this.nowFn = opts.now ?? (() => Date.now());
    if (opts.supportsHibernate ?? true) {
      this.hibernate = async (handle) => {
        this.states.set(handle.nativeId, "hibernated");
        this.events.push(`hibernate:${handle.workerId}`);
        return { ...handle, state: "hibernated", endpoint: undefined };
      };
      this.wake = async (handle) => {
        this.states.set(handle.nativeId, "running");
        this.events.push(`wake:${handle.workerId}`);
        return { ...handle, state: "running", endpoint: `https://${handle.nativeId}.fake.local` };
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async provision(spec: RemoteSpec): Promise<RemoteHandle> {
    const nativeId = `${this.name}-${++this.counter}`;
    this.states.set(nativeId, "running");
    this.logLines.set(nativeId, [`provisioned ${spec.workerId} caps=${spec.capabilities.join(",")}`]);
    this.events.push(`provision:${spec.workerId}`);
    return {
      workerId: spec.workerId,
      backend: this.name,
      nativeId,
      endpoint: `https://${nativeId}.fake.local`,
      state: "running",
      startedAt: this.nowFn(),
    };
  }

  async terminate(handle: RemoteHandle): Promise<void> {
    this.states.set(handle.nativeId, "stopped");
    this.events.push(`terminate:${handle.workerId}`);
  }

  async status(handle: RemoteHandle): Promise<RemoteState> {
    return this.states.get(handle.nativeId) ?? "failed";
  }

  async logs(handle: RemoteHandle, tailLines = 100): Promise<string> {
    return (this.logLines.get(handle.nativeId) ?? []).slice(-tailLines).join("\n");
  }
}
