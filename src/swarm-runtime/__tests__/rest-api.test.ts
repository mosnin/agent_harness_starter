import { describe, it, expect, afterEach } from "vitest";
import { buildSwarm } from "../server/build-swarm";
import { SwarmServer } from "../server/swarm-server";
import { SwarmScheduler } from "../scheduling/scheduler";

let server: SwarmServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("SwarmServer REST API", () => {
  it("exposes schema, runs a goal, and serves its sub-resources", async () => {
    const swarm = await buildSwarm({ mode: "inline", capabilities: ["research", "code"], poolSize: 2 });
    const scheduler = new SwarmScheduler(swarm.manager);
    const port = 39220;
    server = new SwarmServer(swarm, { port, scheduler });
    await server.listen();
    const base = `http://127.0.0.1:${port}`;

    // schema
    const schema = await (await fetch(`${base}/api/schema`)).json();
    expect(schema.service).toBe("hermes-swarm");
    expect(Array.isArray(schema.endpoints)).toBe(true);

    // start a goal
    const started = await (
      await fetch(`${base}/api/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "Analyze the objective" }),
      })
    ).json();
    expect(started.goalId).toBeTruthy();

    await waitFor(async () => {
      const g = await (await fetch(`${base}/api/goals/${started.goalId}`)).json();
      return g.status === "completed" || g.status === "failed";
    });

    const usage = await (await fetch(`${base}/api/goals/${started.goalId}/usage`)).json();
    expect(usage.workerRuns).toBeGreaterThan(0);

    const prov = await (await fetch(`${base}/api/goals/${started.goalId}/provenance`)).json();
    expect(prov.length).toBe(3);

    const workers = await (await fetch(`${base}/api/workers`)).json();
    expect(workers.length).toBeGreaterThan(0);

    const dag = await (await fetch(`${base}/api/goals/${started.goalId}/dag`)).json();
    expect(dag.nodes.length).toBe(3);
    expect(dag.levels.length).toBeGreaterThanOrEqual(2); // investigate levels + synthesis
  });

  it("manages schedules over REST", async () => {
    const swarm = await buildSwarm({ mode: "inline", capabilities: ["research"], poolSize: 1 });
    const scheduler = new SwarmScheduler(swarm.manager);
    const port = 39221;
    server = new SwarmServer(swarm, { port, scheduler });
    await server.listen();
    const base = `http://127.0.0.1:${port}`;

    const created = await (
      await fetch(`${base}/api/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "nightly", cron: "0 3 * * *" }),
      })
    ).json();
    expect(created.id).toBeTruthy();

    const list = await (await fetch(`${base}/api/schedules`)).json();
    expect(list.length).toBe(1);

    const del = await (await fetch(`${base}/api/schedules/${created.id}`, { method: "DELETE" })).json();
    expect(del.removed).toBe(true);
  });
});
