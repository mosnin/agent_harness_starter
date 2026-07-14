import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BuiltSwarm } from "./build-swarm";
import { DASHBOARD_HTML } from "./dashboard";
import type { VerificationReport, WorkerTask } from "../types";
import type { WorkerRecord } from "../manager/manager";

interface SseClient {
  res: ServerResponse;
}

/**
 * The GUI/REST server. Wraps a {@link BuiltSwarm} and exposes:
 *
 *   GET  /                → the live dashboard (single-page app)
 *   GET  /api/state       → snapshot { mode, workers, tasks, goals, verifications }
 *   POST /api/goals       → { objective } → starts a goal, returns { goalId }
 *   GET  /api/goals/:id   → goal detail
 *   GET  /api/events      → Server-Sent Events stream of manager activity
 *
 * Binds to localhost by default — like Hermes' dashboard it holds operational
 * control of the swarm and must not be exposed unauthenticated.
 */
export class SwarmServer {
  private server?: Server;
  private sseClients = new Set<SseClient>();

  constructor(
    private readonly swarm: BuiltSwarm,
    private readonly opts: { port?: number; host?: string } = {}
  ) {
    this.wireEvents();
  }

  get port(): number {
    return this.opts.port ?? 8080;
  }

  async listen(): Promise<void> {
    await this.swarm.start();
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, this.opts.host ?? "127.0.0.1", resolve);
    });
  }

  async close(): Promise<void> {
    for (const c of this.sseClients) c.res.end();
    this.sseClients.clear();
    await this.swarm.stop();
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }

  // ── event fan-out to SSE clients ─────────────────────────────────────────────

  private wireEvents(): void {
    const m = this.swarm.manager;
    const push = (event: string, data: unknown) => this.broadcast(event, data);
    m.on("goal:planned", (g, tasks) => push("goal:planned", { goal: g, tasks }));
    m.on("worker:spawned", (r) => push("worker:spawned", r));
    m.on("worker:killed", (r, reason) => push("worker:killed", { worker: r, reason }));
    m.on("task:dispatched", (t) => push("task:dispatched", t));
    m.on("task:verified", (t, rep) => push("task:verified", { task: t, report: rep }));
    m.on("task:rejected", (t, rep) => push("task:rejected", { task: t, report: rep }));
    m.on("task:failed", (t, reason) => push("task:failed", { task: t, reason }));
    m.on("goal:completed", (g) => push("goal:completed", g));
    m.on("goal:failed", (g, reason) => push("goal:failed", { goal: g, reason }));
    m.on("log", (workerId, line) => push("log", { workerId, line }));
  }

  private broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.sseClients) {
      try {
        c.res.write(payload);
      } catch {
        this.sseClients.delete(c);
      }
    }
  }

  // ── request handling ─────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (req.method === "GET" && path === "/api/state") {
        return json(res, 200, this.snapshot());
      }
      if (req.method === "GET" && path === "/api/events") {
        return this.openSse(res);
      }
      if (req.method === "POST" && path === "/api/goals") {
        const body = (await readJson(req)) as { objective?: string; timeoutMs?: number };
        const objective = (body.objective ?? "").trim();
        if (!objective) return json(res, 400, { error: "objective required" });
        // Fire-and-forget; progress streams over SSE.
        void this.swarm.manager.runGoal(objective, { timeoutMs: body.timeoutMs });
        return json(res, 202, { started: true });
      }
      if (req.method === "GET" && path.startsWith("/api/goals/")) {
        const id = path.slice("/api/goals/".length);
        const goal = this.swarm.manager.getGoal(id);
        return goal ? json(res, 200, goal) : json(res, 404, { error: "not found" });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private openSse(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    const client: SseClient = { res };
    this.sseClients.add(client);
    res.on("close", () => this.sseClients.delete(client));
  }

  private snapshot(): {
    mode: string;
    workers: WorkerRecord[];
    tasks: WorkerTask[];
    goals: unknown[];
    verifications: VerificationReport[];
  } {
    return {
      mode: this.swarm.mode,
      workers: this.swarm.manager.listWorkers(),
      tasks: this.swarm.manager.listTasks(),
      goals: this.goalList(),
      verifications: this.swarm.manager.listVerifications().slice(-50),
    };
  }

  private goalList(): unknown[] {
    // getGoal-per-id isn't exposed as a list; derive from tasks' goalIds.
    const ids = new Set(this.swarm.manager.listTasks().map((t) => t.goalId));
    return [...ids].map((id) => this.swarm.manager.getGoal(id)).filter(Boolean);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
