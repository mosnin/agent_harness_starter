import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WorkerResult } from "../types";
import { InMemoryBus } from "./in-memory";
import type { HeartbeatInfo, ManagerBus, WorkerRegistration } from "./types";

/**
 * HTTP control plane: the manager's inbound API that containerized workers call
 * home to. Pull-based by design — workers long-poll `GET /task`, so they never
 * need an inbound port and can run with `--network none`-adjacent policies
 * while still receiving work over a single egress connection to the manager.
 *
 * Wraps an {@link InMemoryBus} for the queue/dispatch logic and layers a small
 * authenticated HTTP surface on top. Every request must carry
 * `Authorization: Bearer <token>`.
 */
export class HttpControlPlane implements ManagerBus {
  private server?: Server;
  private readonly bus = new InMemoryBus();
  /** Currently-valid tokens. Rotation temporarily keeps the old one too. */
  private validTokens: Set<string>;
  private rotationTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly opts: {
      port: number;
      host?: string;
      authToken: string;
      /** Max long-poll wait for GET /task. */
      pollTimeoutMs?: number;
    }
  ) {
    this.validTokens = new Set([opts.authToken]);
  }

  /**
   * Rotate the bus auth token. The new token takes effect immediately; the old
   * token stays valid for `graceMs` so in-flight workers can re-authenticate
   * with the new one before it's revoked (no dropped workers on rotation).
   */
  rotateToken(newToken: string, graceMs = 30_000): void {
    const old = [...this.validTokens];
    this.validTokens = new Set([newToken, ...old]);
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    this.rotationTimer = setTimeout(() => {
      this.validTokens = new Set([newToken]);
    }, graceMs);
    this.rotationTimer.unref?.();
  }

  /** Tokens currently accepted (for tests/inspection). */
  activeTokens(): string[] {
    return [...this.validTokens];
  }

  get port(): number {
    return this.opts.port;
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host ?? "127.0.0.1", resolve);
    });
  }

  // ── ManagerBus delegation ──────────────────────────────────────────────────
  enqueueTask = (task: Parameters<ManagerBus["enqueueTask"]>[0]) => this.bus.enqueueTask(task);
  onRegister = (h: (r: WorkerRegistration) => void) => this.bus.onRegister(h);
  onHeartbeat = (h: (h: HeartbeatInfo) => void) => this.bus.onHeartbeat(h);
  onResult = (h: (r: WorkerResult) => void) => this.bus.onResult(h);
  onLog = (h: (w: string, l: string) => void) => this.bus.onLog(h);
  onDeregister = (h: (w: string) => void) => this.bus.onDeregister(h);

  async close(): Promise<void> {
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    await this.bus.close();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
  }

  // ── HTTP handling ──────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.authorized(req)) return json(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });

      if (req.method === "GET" && path === "/task") {
        const workerId = url.searchParams.get("workerId") ?? "";
        const task = await this.bus.pullTask(workerId, this.opts.pollTimeoutMs ?? 25_000);
        return task ? json(res, 200, task) : json(res, 204, {});
      }

      if (req.method === "POST") {
        const body = await readJson(req);
        switch (path) {
          case "/register":
            await this.bus.register(body as WorkerRegistration);
            return json(res, 200, { ok: true });
          case "/heartbeat":
            await this.bus.heartbeat(body as HeartbeatInfo);
            return json(res, 200, { ok: true });
          case "/result":
            await this.bus.reportResult(body as WorkerResult);
            return json(res, 200, { ok: true });
          case "/log":
            await this.bus.log((body as { workerId: string }).workerId, (body as { line: string }).line);
            return json(res, 200, { ok: true });
          case "/deregister":
            await this.bus.deregister((body as { workerId: string }).workerId);
            return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const auth = req.headers["authorization"];
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return false;
    return this.validTokens.has(auth.slice("Bearer ".length));
  }
}

// ── shared helpers (also used by the worker client) ──────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = status === 204 ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
