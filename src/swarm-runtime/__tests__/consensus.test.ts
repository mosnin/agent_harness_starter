import { describe, it, expect, afterEach } from "vitest";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { TaskExecutor, WorkerContext } from "../worker/executor";
import type { WorkerTask } from "../types";

let swarm: SwarmManager | undefined;
afterEach(async () => {
  await swarm?.shutdown();
  swarm = undefined;
});

describe("Redundant-worker consensus (anti-hallucination)", () => {
  it("verifies a task when a quorum of independent workers agree", async () => {
    // DemoExecutor is deterministic → all replicas produce the same grounded
    // output → they agree → consensus passes.
    swarm = await createInlineSwarm({
      capabilities: ["general"],
      poolSize: 3,
      defaultConsensus: { replicas: 3, quorum: 0.5 },
    });

    const goal = await swarm.runGoal("Analyze the objective", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");

    // Each task ran on 3 replicas → far more verification reports than tasks.
    const reports = swarm.listVerifications();
    const tasks = swarm.listTasks(goal.id);
    expect(reports.length).toBeGreaterThanOrEqual(tasks.length * 2);
  });

  it("fails the goal when workers cannot agree (no single worker can force 'done')", async () => {
    // Every call returns a *different* grounded answer. Each passes the gate on
    // its own, but no two agree → quorum is never reached → the task fails.
    let n = 0;
    const disagreeing: TaskExecutor = {
      async execute(_task: WorkerTask, _ctx: WorkerContext) {
        const id = ++n;
        return {
          output: `answer variant ${id}`,
          claims: [{ statement: `variant ${id}`, evidence: [`observed variant ${id}`], confidence: 0.9 }],
          toolTrace: [{ tool: "observe", args: {}, ok: true, output: `observed variant ${id}`, at: 0 }],
        };
      },
    };

    swarm = await createInlineSwarm({
      capabilities: ["general"],
      poolSize: 3,
      executor: disagreeing,
      maxAttempts: 2,
      defaultConsensus: { replicas: 3, quorum: 0.5 },
    });

    const goal = await swarm.runGoal("Produce a contested answer", { timeoutMs: 15_000 });
    expect(goal.status).toBe("failed");
  });

  it("single-worker (no consensus) path still works unchanged", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2 });
    const goal = await swarm.runGoal("Analyze the objective", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
  });
});
