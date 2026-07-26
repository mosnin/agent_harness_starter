import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { MemoryStateStore, FileStateStore } from "../persistence/state-store";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";

let swarm: SwarmManager | undefined;
afterEach(async () => {
  await swarm?.shutdown();
  swarm = undefined;
});

describe("FileStateStore", () => {
  it("round-trips a snapshot atomically", async () => {
    const path = join(tmpdir(), `swarm-state-${process.pid}-${Math.floor(performance.now())}.json`);
    const store = new FileStateStore(path);
    try {
      expect(await store.load()).toBeNull();
      await store.save({ version: 1, savedAt: 1, goals: [], tasks: [], usage: {} });
      const loaded = await store.load();
      expect(loaded?.version).toBe(1);
    } finally {
      await rm(path, { force: true });
    }
  });
});

describe("manager persistence", () => {
  it("persists completed goal/task state and can be hydrated into a fresh manager", async () => {
    const store = new MemoryStateStore();
    swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize: 2, stateStore: store });
    const goal = await swarm.runGoal("Analyze the objective", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
    await swarm.shutdown(); // flushes state
    swarm = undefined;

    const snap = await store.load();
    expect(snap).not.toBeNull();
    expect(snap!.goals.length).toBe(1);
    expect(snap!.tasks.length).toBe(3);

    // A brand-new manager can restore and report on the prior run.
    const recovered = await createInlineSwarm({ capabilities: ["research", "code"], stateStore: store });
    try {
      expect(await recovered.loadState()).toBe(true);
      const g = recovered.getGoal(goal.id);
      expect(g?.status).toBe("completed");
      expect(recovered.listTasks(goal.id).length).toBe(3);
    } finally {
      await recovered.shutdown();
    }
  });
});
