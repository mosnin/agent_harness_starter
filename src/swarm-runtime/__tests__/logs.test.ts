import { describe, it, expect, afterEach } from "vitest";
import { buildSwarm } from "../server/build-swarm";
import { SwarmServer } from "../server/swarm-server";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";

let swarm: SwarmManager | undefined;
let server: SwarmServer | undefined;
afterEach(async () => {
  await server?.close();
  await swarm?.shutdown();
  swarm = undefined;
  server = undefined;
});

describe("live worker log streaming", () => {
  it("buffers worker logs and exposes them per-worker and globally", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2 });
    await swarm.runGoal("Analyze the objective", { timeoutMs: 15_000 });

    const recent = swarm.recentLogs();
    expect(recent.length).toBeGreaterThan(0);
    const someWorker = recent[0].workerId;
    const perWorker = swarm.getWorkerLogs(someWorker);
    expect(perWorker.length).toBeGreaterThan(0);
    expect(perWorker.every((l) => typeof l.line === "string")).toBe(true);
  });

  it("serves logs over REST and includes them in the snapshot", async () => {
    const built = await buildSwarm({ mode: "inline", capabilities: ["research"], poolSize: 2 });
    const port = 39230;
    server = new SwarmServer(built, { port });
    await server.listen();
    const base = `http://127.0.0.1:${port}`;

    await (
      await fetch(`${base}/api/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "Analyze the objective" }),
      })
    ).json();

    // let the goal produce some logs
    await new Promise((r) => setTimeout(r, 800));

    const logs = await (await fetch(`${base}/api/logs`)).json();
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);

    const state = await (await fetch(`${base}/api/state`)).json();
    expect(Array.isArray(state.logs)).toBe(true);
  });
});
