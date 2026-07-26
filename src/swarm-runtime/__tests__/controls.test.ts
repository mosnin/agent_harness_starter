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

describe("live controls (manager)", () => {
  it("kills a worker and replaces it, keeping the pool at strength", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 3 });
    await swarm.ensurePool();
    const before = swarm.workerCount();
    const victim = swarm.listWorkers()[0].workerId;

    expect(await swarm.killWorker(victim, "test")).toBe(true);
    expect(await swarm.killWorker("nonexistent", "test")).toBe(false);
    // killed worker is torn down and a replacement spawned → live count preserved
    expect(swarm.listWorkers().some((w) => w.workerId === victim && w.status !== "killed")).toBe(false);
    expect(swarm.workerCount()).toBe(before);
  });

  it("scales the pool up and down", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2 });
    await swarm.ensurePool();
    expect(await swarm.scalePool(5)).toBe(5);
    expect(await swarm.scalePool(2)).toBe(2); // retires idle workers
  });
});

describe("live controls (REST)", () => {
  it("exposes kill and scale over HTTP", async () => {
    const built = await buildSwarm({ mode: "inline", capabilities: ["research"], poolSize: 3 });
    const port = 39260;
    server = new SwarmServer(built, { port });
    await server.listen();
    const base = `http://127.0.0.1:${port}`;

    const workers = await (await fetch(`${base}/api/workers`)).json();
    const victim = workers[0].workerId;
    const kill = await (await fetch(`${base}/api/workers/${victim}/kill`, { method: "POST" })).json();
    expect(kill.killed).toBe(true);

    const scale = await (
      await fetch(`${base}/api/pool/scale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ size: 4 }),
      })
    ).json();
    expect(scale.size).toBe(4);
  });
});
