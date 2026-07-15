import { describe, it, expect, afterEach } from "vitest";
import { buildSwarm } from "../server/build-swarm";
import { SwarmServer } from "../server/swarm-server";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";

let server: SwarmServer | undefined;
let swarm: SwarmManager | undefined;
afterEach(async () => {
  await server?.close();
  await swarm?.shutdown();
  server = undefined;
  swarm = undefined;
});

describe("goal history + replay (manager)", () => {
  it("lists goals newest-first and replays a prior objective", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2 });
    const g1 = await swarm.runGoal("First analysis", { timeoutMs: 15_000 });
    const g2 = await swarm.runGoal("Second analysis", { timeoutMs: 15_000 });

    const goals = swarm.listGoals();
    expect(goals.length).toBe(2);
    expect(goals[0].id).toBe(g2.id); // newest first

    const replayId = await swarm.replayGoal(g1.id);
    expect(replayId).toBeTruthy();
    expect(replayId).not.toBe(g1.id);
    expect(swarm.getGoal(replayId!)?.objective).toBe("First analysis");

    expect(await swarm.replayGoal("nonexistent")).toBeUndefined();
  });
});

describe("goal history + replay (REST)", () => {
  it("serves the goal list and replays over HTTP", async () => {
    const built = await buildSwarm({ mode: "inline", capabilities: ["research"], poolSize: 2 });
    const port = 39250;
    server = new SwarmServer(built, { port });
    await server.listen();
    const base = `http://127.0.0.1:${port}`;

    const started = await (
      await fetch(`${base}/api/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "Analyze the objective" }),
      })
    ).json();

    const goals = await (await fetch(`${base}/api/goals`)).json();
    expect(Array.isArray(goals)).toBe(true);
    expect(goals.length).toBeGreaterThanOrEqual(1);

    const replay = await (await fetch(`${base}/api/goals/${started.goalId}/replay`, { method: "POST" })).json();
    expect(replay.goalId).toBeTruthy();
  });
});
