import { describe, it, expect, afterEach } from "vitest";
import { createInlineSwarm } from "../factory";
import { DemoExecutor, type TaskExecutor, type WorkerContext } from "../worker/executor";
import type { SwarmManager } from "../manager/manager";
import type { WorkerTask } from "../types";

let swarm: SwarmManager | undefined;
afterEach(async () => {
  await swarm?.shutdown();
  swarm = undefined;
});

describe("Inline swarm end-to-end", () => {
  it("plans, dispatches to isolated workers, verifies, and synthesizes", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize: 3 });

    const verified: string[] = [];
    swarm.on("task:verified", (t) => verified.push(t.id));

    const goal = await swarm.runGoal("Describe the module architecture", { timeoutMs: 15_000 });

    expect(goal.status).toBe("completed");
    expect(goal.synthesis).toBeTruthy();
    // research + code + synthesis = 3 tasks, all verified.
    expect(verified.length).toBe(3);

    const tasks = swarm.listTasks(goal.id);
    expect(tasks.every((t) => t.status === "verified")).toBe(true);
  });

  it("spawns the configured worker pool as isolated units", async () => {
    swarm = await createInlineSwarm({ capabilities: ["general"], poolSize: 4 });
    await swarm.ensurePool();
    expect(swarm.listWorkers().length).toBe(4);
  });

  it("fails a goal when a worker cannot produce grounded output", async () => {
    // An executor that returns confident but totally unbacked claims.
    const liar: TaskExecutor = {
      async execute(task: WorkerTask, _ctx: WorkerContext) {
        return {
          output: "definitely true",
          claims: [{ statement: "I assume this is correct.", evidence: [], confidence: 0.99 }],
          toolTrace: [],
        };
      },
    };
    swarm = await createInlineSwarm({
      capabilities: ["general"],
      poolSize: 2,
      executor: liar,
      maxAttempts: 2,
    });

    const goal = await swarm.runGoal("Produce something ungrounded", { timeoutMs: 15_000 });
    expect(goal.status).toBe("failed");
  });

  it("records verification reports for every accepted task", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2, executor: new DemoExecutor() });
    const goal = await swarm.runGoal("Analyze the objective", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
    const reports = swarm.listVerifications();
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((r) => r.checks.length > 0)).toBe(true);
  });
});
