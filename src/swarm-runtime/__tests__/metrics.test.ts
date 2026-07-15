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

describe("manager metrics", () => {
  it("aggregates goals, tasks, workers, verification, and usage", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize: 2 });
    await swarm.runGoal("Analyze the objective", { timeoutMs: 15_000 });

    const m = swarm.metrics();
    expect(m.goals.total).toBe(1);
    expect(m.goals.completed).toBe(1);
    expect(m.tasks.verified).toBe(3);
    expect(m.workers.total).toBeGreaterThan(0);
    expect(m.verification.accepted).toBeGreaterThan(0);
    expect(m.verification.groundingRate).toBeGreaterThan(0);
    expect(m.usage.toolCalls).toBeGreaterThan(0);
  });
});

describe("metrics REST", () => {
  it("serves GET /api/metrics", async () => {
    const built = await buildSwarm({ mode: "inline", capabilities: ["research"], poolSize: 1 });
    const port = 39270;
    server = new SwarmServer(built, { port });
    await server.listen();
    const m = await (await fetch(`http://127.0.0.1:${port}/api/metrics`)).json();
    expect(m.goals).toBeDefined();
    expect(m.verification).toBeDefined();
    expect(typeof m.verification.groundingRate).toBe("number");
  });
});
