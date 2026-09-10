import { describe, it, expect, afterEach } from "vitest";
import { HarnessExecutor, type RunnableHarness } from "../worker/harness-executor";
import { VerificationGate } from "../verification/gate";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { WorkerTask } from "../types";

const ctx = { workerId: "w1", log: () => {} };

// A fake harness that "used a tool" and returns a grounded answer.
const fakeHarness: RunnableHarness = {
  async run() {
    return {
      finalOutput: "The repo has 42 TypeScript files.",
      toolCalls: [{ name: "count_files", input: { ext: "ts" }, output: "42 files match *.ts" }],
      usage: { totalTokens: 1200 },
    };
  },
};

function task(): WorkerTask {
  return {
    id: "t1", goalId: "g1", description: "How many TS files?", requiredCapabilities: [], input: {},
    dependsOn: [], priority: 5, status: "dispatched", attempts: 0, maxAttempts: 3, createdAt: 0,
  };
}

describe("HarnessExecutor", () => {
  it("maps harness tool calls into a grounded trace + claims that pass the gate", async () => {
    const exec = new HarnessExecutor(fakeHarness, { costPer1kTokens: 0.005 });
    const out = await exec.execute(task(), ctx);

    expect(out.output).toContain("42");
    expect(out.toolTrace.length).toBe(1);
    expect(out.toolTrace[0].tool).toBe("count_files");
    expect(out.claims.length).toBeGreaterThan(0);

    const gate = new VerificationGate();
    const report = await gate.verify({
      taskId: "t1", workerId: "w1", output: out.output, claims: out.claims,
      toolTrace: out.toolTrace, startedAt: 0, finishedAt: 1,
    });
    expect(report.verdict).toBe("accept");
  });

  it("computes cost from token usage", async () => {
    const out = await new HarnessExecutor(fakeHarness, { costPer1kTokens: 0.01 }).execute(task(), ctx);
    expect(out.costUsd).toBeCloseTo(0.012); // 1200/1000 * 0.01
  });

  it("drives a full swarm run and accounts the cost in the budget", async () => {
    let swarm: SwarmManager | undefined;
    try {
      swarm = await createInlineSwarm({
        capabilities: ["general"],
        poolSize: 2,
        executor: new HarnessExecutor(fakeHarness, { costPer1kTokens: 0.001 }),
      });
      const goal = await swarm.runGoal("Investigate the codebase", { timeoutMs: 15_000 });
      expect(goal.status).toBe("completed");
      expect(swarm.getUsage(goal.id).costUsd).toBeGreaterThan(0);
    } finally {
      await swarm?.shutdown();
    }
  });
});
