import { describe, it, expect, afterEach } from "vitest";
import { buildSwarm } from "../server/build-swarm";
import { SwarmServer } from "../server/swarm-server";
import { SwarmScheduler } from "../scheduling/scheduler";
import { SwarmGateway, parseSlack } from "../gateway/gateway";
import { attachStructuredLogging, type StructuredLogRecord } from "../observability/structured-log";

/**
 * Full-stack integration: one test that drives a swarm through REST, a chat
 * gateway, a scheduler, and the observability layer — asserting the whole
 * plan → dispatch → verify → synthesize path holds together with the trust
 * guarantees intact.
 */
describe("Hermes-Swarm end-to-end", () => {
  let server: SwarmServer | undefined;
  const detachers: Array<() => void> = [];
  afterEach(async () => {
    detachers.forEach((d) => d());
    detachers.length = 0;
    await server?.close();
    server = undefined;
  });

  it("runs a goal via REST, gateway, and scheduler with verification + observability", async () => {
    const built = await buildSwarm({ mode: "inline", capabilities: ["research", "code"], poolSize: 3 });

    // Observability: capture structured lifecycle logs.
    const logs: StructuredLogRecord[] = [];
    detachers.push(attachStructuredLogging(built.manager, (r) => logs.push(r)));

    // Scheduler + gateway on the same manager.
    const scheduler = new SwarmScheduler(built.manager);
    const gateway = new SwarmGateway(built.manager, { trigger: "/swarm", timeoutMs: 15_000 });

    const port = 39310;
    server = new SwarmServer(built, { port, scheduler });
    await server.listen();
    const base = `http://127.0.0.1:${port}`;

    // 1) Liveness + Prometheus are open and healthy.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/metrics`)).text()).toContain("swarm_goals_total");

    // 2) Start a goal over REST and poll the DAG + status to completion.
    const started = await (
      await fetch(`${base}/api/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "Investigate the codebase" }),
      })
    ).json();
    expect(started.goalId).toBeTruthy();

    const dag = await (await fetch(`${base}/api/goals/${started.goalId}/dag`)).json();
    expect(dag.nodes.length).toBe(3);

    const start = Date.now();
    let status = "running";
    while (status === "running") {
      if (Date.now() - start > 15_000) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 40));
      status = (await (await fetch(`${base}/api/goals/${started.goalId}`)).json()).status;
    }
    expect(status).toBe("completed");

    // 3) Provenance shows grounded, gate-cleared evidence for every task.
    const prov = await (await fetch(`${base}/api/goals/${started.goalId}/provenance`)).json();
    expect(prov.length).toBe(3);
    expect(prov.every((r: { verdict: string }) => r.verdict === "accept")).toBe(true);

    // 4) The gateway can launch a goal from a (Slack-shaped) message and reply.
    const inbound = parseSlack({ event: { user: "U1", text: "/swarm summarize findings", channel: "C1" } });
    const reply = await gateway.handle(inbound);
    expect(reply.accepted).toBe(true);
    expect(reply.status).toBe("completed");
    expect(reply.text).toContain("✅");

    // 5) The scheduler can register a recurring goal and fire it on demand.
    const sched = scheduler.add({ objective: "nightly audit", cron: "0 3 * * *" });
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.tick(new Date(2026, 0, 1, 3, 0, 0).getTime())).toContain(sched.id);

    // 6) Aggregate metrics reflect the whole run; observability captured events.
    const metrics = await (await fetch(`${base}/api/metrics`)).json();
    expect(metrics.goals.completed).toBeGreaterThanOrEqual(2); // REST + gateway goals
    expect(metrics.verification.groundingRate).toBeGreaterThan(0);
    expect(logs.some((l) => l.event === "goal.completed")).toBe(true);
    expect(logs.some((l) => l.event === "task.verified")).toBe(true);
  });
});
