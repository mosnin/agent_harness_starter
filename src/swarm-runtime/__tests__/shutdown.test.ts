import { describe, it, expect, afterEach } from "vitest";
import { installGracefulShutdown } from "../lifecycle/shutdown";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";

describe("installGracefulShutdown", () => {
  const controllers: Array<{ uninstall: () => void }> = [];
  afterEach(() => {
    for (const c of controllers) c.uninstall();
    controllers.length = 0;
  });

  it("runs cleanup exactly once even when triggered repeatedly", async () => {
    let calls = 0;
    const ctrl = installGracefulShutdown(async () => { calls += 1; }, { exit: () => {}, signals: [] });
    controllers.push(ctrl);
    await ctrl.run();
    await ctrl.run();
    await ctrl.run();
    expect(calls).toBe(1);
    expect(ctrl.isDone()).toBe(true);
  });

  it("force-exits if cleanup hangs past the timeout", async () => {
    let exitCode: number | undefined;
    const ctrl = installGracefulShutdown(
      () => new Promise(() => {}), // never resolves
      { exit: (c) => { exitCode = c; }, timeoutMs: 100, signals: [] }
    );
    controllers.push(ctrl);
    void ctrl.run();
    await new Promise((r) => setTimeout(r, 160));
    expect(exitCode).toBe(1); // forced exit
  });

  it("swallows cleanup errors and still completes", async () => {
    const logs: string[] = [];
    const ctrl = installGracefulShutdown(
      async () => { throw new Error("boom"); },
      { exit: () => {}, log: (m) => logs.push(m), signals: [] }
    );
    controllers.push(ctrl);
    await expect(ctrl.run()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
  });
});

describe("manager shutdown idempotency", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    swarm = undefined;
  });

  it("is safe to call shutdown multiple times", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2 });
    await swarm.ensurePool();
    await Promise.all([swarm.shutdown(), swarm.shutdown(), swarm.shutdown()]);
    // no throw, workers drained
    expect(swarm.listWorkers().length).toBe(0);
  });
});
