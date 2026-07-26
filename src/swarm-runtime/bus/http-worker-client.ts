import type { WorkerResult, WorkerTask } from "../types";
import type { HeartbeatInfo, WorkerBus, WorkerRegistration } from "./types";

/**
 * Worker-side HTTP client for the {@link HttpControlPlane}. Uses global
 * `fetch` (Node 18+/undici) so it carries no dependencies into the worker
 * container. All calls present the shared bearer token.
 */
export class HttpWorkerClient implements WorkerBus {
  constructor(
    private readonly opts: {
      managerUrl: string;
      authToken: string;
      /** Retries for transient network errors. */
      maxRetries?: number;
    }
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.opts.authToken}`,
    };
  }

  private url(path: string): string {
    return new URL(path, this.opts.managerUrl).toString();
  }

  private async post(path: string, body: unknown): Promise<void> {
    await this.withRetry(async () => {
      const res = await fetch(this.url(path), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} → ${res.status}`);
    });
  }

  async register(reg: WorkerRegistration): Promise<void> {
    await this.post("/register", reg);
  }

  async pullTask(workerId: string, timeoutMs = 25_000): Promise<WorkerTask | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000);
    try {
      const res = await fetch(this.url(`/task?workerId=${encodeURIComponent(workerId)}`), {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
      });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`/task → ${res.status}`);
      return (await res.json()) as WorkerTask;
    } catch {
      return null; // treat poll failures as "no task"; worker loops again
    } finally {
      clearTimeout(timer);
    }
  }

  async reportResult(result: WorkerResult): Promise<void> {
    await this.post("/result", result);
  }
  async heartbeat(hb: HeartbeatInfo): Promise<void> {
    await this.post("/heartbeat", hb);
  }
  async log(workerId: string, line: string): Promise<void> {
    await this.post("/log", { workerId, line });
  }
  async deregister(workerId: string): Promise<void> {
    await this.post("/deregister", { workerId });
  }

  private async withRetry(fn: () => Promise<void>): Promise<void> {
    const max = this.opts.maxRetries ?? 3;
    let lastErr: unknown;
    for (let i = 0; i < max; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200 * 2 ** i));
      }
    }
    throw lastErr;
  }
}
