import { describe, it, expect, afterEach } from "vitest";
import { RuleBasedAdversary } from "../verification/adversarial";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { TaskExecutor, WorkerContext } from "../worker/executor";
import type { WorkerResult, WorkerTask } from "../types";

function res(partial: Partial<WorkerResult>): WorkerResult {
  return {
    taskId: "t", workerId: "w", output: "", claims: [], toolTrace: [],
    startedAt: 0, finishedAt: 1, ...partial,
  };
}

describe("RuleBasedAdversary", () => {
  const adv = new RuleBasedAdversary();

  it("refutes an unfalsifiable absolute claim", async () => {
    const r = await adv.refute(res({ output: "this always works, guaranteed" }));
    expect(r.refuted).toBe(true);
  });

  it("refutes near-certain confidence on thin evidence combined with absolutes", async () => {
    const r = await adv.refute(
      res({
        claims: [{ statement: "it is certainly correct", evidence: ["x"], confidence: 0.99 }],
        toolTrace: [{ tool: "t", args: {}, ok: true, output: "x", at: 0 }],
      })
    );
    expect(r.refuted).toBe(true);
  });

  it("lets a measured, grounded result survive", async () => {
    const r = await adv.refute(
      res({
        output: "the file has 42 lines",
        claims: [{ statement: "file has 42 lines", evidence: ["wc: 42"], confidence: 0.85 }],
        toolTrace: [{ tool: "wc", args: {}, ok: true, output: "42", at: 0 }],
      })
    );
    expect(r.refuted).toBe(false);
  });
});

describe("adversary in the manager", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    await swarm?.shutdown();
    swarm = undefined;
  });

  it("rejects a gate-passing result that the skeptic refutes", async () => {
    // Grounded (passes the gate) but overreaching (absolute) → skeptic refutes.
    const overreach: TaskExecutor = {
      async execute(_t: WorkerTask, _c: WorkerContext) {
        return {
          output: "this approach always works and is guaranteed",
          claims: [{ statement: "it always works", evidence: ["log: ran ok"], confidence: 0.9 }],
          toolTrace: [{ tool: "run", args: {}, ok: true, output: "log: ran ok", at: 0 }],
        };
      },
    };
    swarm = await createInlineSwarm({
      capabilities: ["general"],
      poolSize: 1,
      executor: overreach,
      maxAttempts: 2,
      adversary: new RuleBasedAdversary(),
    });
    const goal = await swarm.runGoal("Overreach test", { timeoutMs: 15_000 });
    expect(goal.status).toBe("failed");
    const reports = swarm.listVerifications();
    expect(reports.some((r) => r.checks.some((c) => c.name === "adversarial-refutation"))).toBe(true);
  });
});
