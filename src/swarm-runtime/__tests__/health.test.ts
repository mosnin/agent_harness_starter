import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { buildSwarm } from "../server/build-swarm";
import { SwarmServer } from "../server/swarm-server";
import { WorkerRuntime } from "../worker/runtime";
import { InMemoryBus } from "../bus/in-memory";

let server: SwarmServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("/healthz liveness probe", () => {
  it("returns 200 without auth even when the API is token-guarded", async () => {
    const built = await buildSwarm({ mode: "inline", capabilities: ["research"], poolSize: 1 });
    const port = 39300;
    server = new SwarmServer(built, { port, authToken: "secret" });
    await server.listen();
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("inline");
    // sanity: the API itself is still guarded
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
  });
});

describe("worker health-heartbeat file", () => {
  it("touches the health file with a fresh timestamp on heartbeat", async () => {
    const healthFile = join(tmpdir(), `swarm-health-${process.pid}-${Math.floor(performance.now())}`);
    const bus = new InMemoryBus();
    const runtime = new WorkerRuntime({
      workerId: "w1",
      capabilities: ["research"],
      bus,
      heartbeatMs: 50,
      pollTimeoutMs: 100,
      maxIdlePolls: 1,
      healthFilePath: healthFile,
    });
    const before = Date.now();
    await runtime.start(); // registers, beats (writes file), idles out, stops
    try {
      expect(existsSync(healthFile)).toBe(true);
      const ts = Number(readFileSync(healthFile, "utf8"));
      expect(ts).toBeGreaterThanOrEqual(before);
    } finally {
      rmSync(healthFile, { force: true });
    }
  });
});
