import { describe, it, expect, afterEach } from "vitest";
import { isReady, orderByPriority, scheduleReady } from "../manager/scheduler";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { WorkerTask } from "../types";

function task(id: string, p: number, deps: string[] = [], status: WorkerTask["status"] = "pending"): WorkerTask {
  return {
    id, goalId: "g", description: id, requiredCapabilities: [], input: {},
    dependsOn: deps, priority: p, status, attempts: 0, maxAttempts: 3, createdAt: Number(id.replace(/\D/g, "")) || 0,
  };
}

describe("scheduler", () => {
  it("orders by priority desc, then FIFO", () => {
    const ordered = orderByPriority([task("1", 5), task("2", 9), task("3", 9)]);
    expect(ordered.map((t) => t.id)).toEqual(["2", "3", "1"]);
  });

  it("marks a task ready only when all deps are verified", () => {
    const verified = new Set(["a"]);
    expect(isReady(task("x", 5, ["a"]), (id) => verified.has(id))).toBe(true);
    expect(isReady(task("y", 5, ["a", "b"]), (id) => verified.has(id))).toBe(false);
  });

  it("respects the in-flight capacity", () => {
    const candidates = [task("1", 1), task("2", 9), task("3", 5)];
    const picked = scheduleReady({ candidates, inFlight: 1, maxInFlight: 2 });
    // capacity = 1 → only the highest-priority candidate.
    expect(picked.map((t) => t.id)).toEqual(["2"]);
  });

  it("returns nothing when at capacity", () => {
    expect(scheduleReady({ candidates: [task("1", 5)], inFlight: 3, maxInFlight: 3 })).toEqual([]);
  });
});

describe("backpressure in the manager", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    await swarm?.shutdown();
    swarm = undefined;
  });

  it("still completes a goal under a tight in-flight cap", async () => {
    swarm = await createInlineSwarm({
      capabilities: ["research", "code", "analysis"],
      poolSize: 3,
      maxInFlight: 1, // force near-sequential dispatch
    });
    const goal = await swarm.runGoal("Analyze under backpressure", { timeoutMs: 20_000 });
    expect(goal.status).toBe("completed");
  });
});
