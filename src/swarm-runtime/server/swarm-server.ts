import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BuiltSwarm } from "./build-swarm";
import { DASHBOARD_HTML } from "./dashboard";
import type { VerificationReport, WorkerTask } from "../types";
import type { WorkerRecord } from "../manager/manager";
import type { SwarmScheduler } from "../scheduling/scheduler";

interface SseClient {
  res: ServerResponse;
}

/** Self-describing REST surface — served at GET /api/schema. */
const API_SCHEMA = {
  service: "hermes-swarm",
  endpoints: [
    { method: "GET", path: "/", desc: "Live dashboard (HTML)" },
    { method: "GET", path: "/api/schema", desc: "This schema" },
    { method: "GET", path: "/api/state", desc: "Full snapshot: mode, workers, tasks, goals, verifications, provenance, groundingRate" },
    { method: "GET", path: "/api/events", desc: "Server-Sent Events stream of manager activity" },
    { method: "GET", path: "/api/workers", desc: "List worker agents" },
    { method: "POST", path: "/api/goals", desc: "Start a goal: { objective, timeoutMs? } → { goalId }" },
    { method: "GET", path: "/api/goals/:id", desc: "Goal detail" },
    { method: "GET", path: "/api/goals/:id/tasks", desc: "Tasks for a goal" },
    { method: "GET", path: "/api/goals/:id/usage", desc: "Resource accounting for a goal" },
    { method: "GET", path: "/api/goals/:id/provenance", desc: "Evidence provenance for a goal" },
    { method: "POST", path: "/api/goals/:id/cancel", desc: "Cancel a running goal" },
    { method: "GET", path: "/api/schedules", desc: "List recurring schedules (if scheduler enabled)" },
    { method: "POST", path: "/api/schedules", desc: "Create a schedule: { objective, intervalMs?|cron? }" },
    { method: "DELETE", path: "/api/schedules/:id", desc: "Remove a schedule" },
  ],
} as const;

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

  private readonly scheduler?: SwarmScheduler;

  constructor(
    private readonly swarm: BuiltSwarm,
    private readonly opts: { port?: number; host?: string; scheduler?: SwarmScheduler } = {}
  ) {
    this.scheduler = opts.scheduler;
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
      if (req.method === "GET" && path === "/api/schema") {
        return json(res, 200, API_SCHEMA);
      }
      if (req.method === "GET" && path === "/api/workers") {
        return json(res, 200, this.swarm.manager.listWorkers());
      }
      if (req.method === "GET" && path === "/api/logs") {
        return json(res, 200, this.swarm.manager.recentLogs());
      }
      if (req.method === "GET" && path.startsWith("/api/workers/") && path.endsWith("/logs")) {
        const workerId = path.slice("/api/workers/".length, -"/logs".length);
        return json(res, 200, this.swarm.manager.getWorkerLogs(workerId));
      }
      if (req.method === "POST" && path === "/api/goals") {
        const body = (await readJson(req)) as { objective?: string; timeoutMs?: number };
        const objective = (body.objective ?? "").trim();
        if (!objective) return json(res, 400, { error: "objective required" });
        const { goalId, done } = await this.swarm.manager.startGoal(objective, { timeoutMs: body.timeoutMs });
        void done.catch(() => undefined); // progress streams over SSE
        return json(res, 202, { started: true, goalId });
      }

      // ── Schedules (recurring goals) ──────────────────────────────────────────
      if (this.scheduler && path === "/api/schedules") {
        if (req.method === "GET") return json(res, 200, this.scheduler.list());
        if (req.method === "POST") {
          const body = (await readJson(req)) as { objective?: string; intervalMs?: number; cron?: string };
          if (!body.objective) return json(res, 400, { error: "objective required" });
          try {
            const s = this.scheduler.add({ objective: body.objective, intervalMs: body.intervalMs, cron: body.cron });
            return json(res, 201, s);
          } catch (e) {
            return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      if (this.scheduler && req.method === "DELETE" && path.startsWith("/api/schedules/")) {
        const id = path.slice("/api/schedules/".length);
        return json(res, 200, { removed: this.scheduler.remove(id) });
      }

      // ── Goal sub-resources: /api/goals/:id[/provenance|/usage|/cancel] ────────
      if (path.startsWith("/api/goals/")) {
        const rest = path.slice("/api/goals/".length);
        const [id, sub] = rest.split("/");
        const goal = this.swarm.manager.getGoal(id);
        if (!goal) return json(res, 404, { error: "not found" });
        if (req.method === "GET" && !sub) return json(res, 200, goal);
        if (req.method === "GET" && sub === "usage") return json(res, 200, this.swarm.manager.getUsage(id));
        if (req.method === "GET" && sub === "provenance")
          return json(res, 200, this.swarm.manager.listProvenance(id));
        if (req.method === "GET" && sub === "tasks")
          return json(res, 200, this.swarm.manager.listTasks(id));
        if (req.method === "POST" && sub === "cancel") {
          const cancelled = this.swarm.manager.cancelGoal(id);
          return json(res, 200, { cancelled });
        }
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
    provenance: unknown[];
    groundingRate: number;
    logs: Array<{ workerId: string; line: string; at: number }>;
  } {
    return {
      mode: this.swarm.mode,
      workers: this.swarm.manager.listWorkers(),
      tasks: this.swarm.manager.listTasks(),
      goals: this.goalList(),
      verifications: this.swarm.manager.listVerifications().slice(-50),
      provenance: this.swarm.manager.listProvenance().slice(-50),
      groundingRate: this.swarm.manager.groundingRate(),
      logs: this.swarm.manager.recentLogs(100),
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
