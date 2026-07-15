import { describe, it, expect, afterEach } from "vitest";
import { detectContradictions } from "../verification/contradiction";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { TaskExecutor, WorkerContext } from "../worker/executor";
import type { WorkerTask } from "../types";

describe("detectContradictions", () => {
  it("flags conflicting values for the same subject", () => {
    const c = detectContradictions([
      { statement: "retries is 5", taskId: "a" },
      { statement: "retries is 999", taskId: "b" },
    ]);
    expect(c.length).toBe(1);
    expect(c[0].subject).toBe("retries");
    expect(c[0].conflicts.length).toBe(2);
  });

  it("detects negation conflicts", () => {
    const c = detectContradictions([
      { statement: "the cache is enabled" },
      { statement: "the cache is not enabled" },
    ]);
    expect(c.length).toBe(1);
  });

  it("does not flag agreeing claims", () => {
    const c = detectContradictions([
      { statement: "retries is 5" },
      { statement: "retries is 5" },
      { statement: "backoff is exponential" },
    ]);
    expect(c.length).toBe(0);
  });

  it("ignores long descriptive clauses (avoids false positives)", () => {
    const c = detectContradictions([
      { statement: "the system is a distributed set of workers coordinated by a manager agent" },
      { statement: "the system is a lightweight harness for running swarms in containers locally" },
    ]);
    expect(c.length).toBe(0);
  });
});

describe("contradiction detection in the manager", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    await swarm?.shutdown();
    swarm = undefined;
  });

  it("fails a goal with contradictory results when failOnContradiction is set", async () => {
    // Two capabilities → two tasks; each angle asserts a different value for the
    // same subject, producing a cross-result contradiction.
    const contradictory: TaskExecutor = {
      async execute(task: WorkerTask, _ctx: WorkerContext) {
        const angle = String((task.input as { angle?: string }).angle ?? "x");
        const value = angle === "alpha" ? "5" : "999";
        return {
          output: `retries is ${value}`,
          claims: [{ statement: `retries is ${value}`, evidence: [`config shows retries ${value}`], confidence: 0.9 }],
          toolTrace: [{ tool: "read", args: {}, ok: true, output: `config shows retries ${value}`, at: 0 }],
        };
      },
    };
    swarm = await createInlineSwarm({
      capabilities: ["alpha", "beta"],
      poolSize: 2,
      executor: contradictory,
      failOnContradiction: true,
    });
    const events: string[] = [];
    swarm.on("goal:contradiction", () => events.push("contradiction"));

    const goal = await swarm.runGoal("How many retries?", { timeoutMs: 15_000 });
    expect(events).toContain("contradiction");
    expect(goal.status).toBe("failed");
    expect(goal.contradictions && goal.contradictions.length).toBeGreaterThan(0);
  });
});
