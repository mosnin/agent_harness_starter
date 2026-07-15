import { describe, it, expect, afterEach } from "vitest";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { TaskExecutor, WorkerContext } from "../worker/executor";
import type { RevisionEntry, WorkerTask } from "../types";

let swarm: SwarmManager | undefined;
afterEach(async () => {
  await swarm?.shutdown();
  swarm = undefined;
});

describe("revision loop hardening", () => {
  it("records revision history and escalates a persistently-failing task", async () => {
    // Always ungrounded → always rejected → exhausts attempts.
    const bad: TaskExecutor = {
      async execute(_t: WorkerTask, _c: WorkerContext) {
        return { output: "no", claims: [], toolTrace: [] };
      },
    };
    swarm = await createInlineSwarm({
      capabilities: ["general"],
      poolSize: 1,
      executor: bad,
      maxAttempts: 3,
      escalateAfter: 2,
    });

    const escalations: RevisionEntry[][] = [];
    swarm.on("task:escalated", (_t, revs) => escalations.push(revs));

    const goal = await swarm.runGoal("Do the impossible", { timeoutMs: 15_000 });
    expect(goal.status).toBe("failed");

    // The first task should have accumulated a revision history.
    const failed = swarm.listTasks(goal.id).find((t) => t.status === "failed")!;
    expect(failed.revisions && failed.revisions.length).toBeGreaterThanOrEqual(3);
    expect(failed.revisions![0].failedChecks.length).toBeGreaterThan(0);

    // Escalation fired (at escalateAfter and again at terminal failure).
    expect(escalations.length).toBeGreaterThanOrEqual(1);
  });

  it("passes structured failed-checks feedback into the next attempt input", async () => {
    const seen: Array<{ attempt?: number; failedChecks?: string[] }> = [];
    let call = 0;
    const executor: TaskExecutor = {
      async execute(task: WorkerTask, _c: WorkerContext) {
        const rev = (task.input as { _revision?: { attempt: number; failedChecks: string[] } })._revision;
        if (rev) seen.push(rev);
        // First attempt ungrounded (rejected), later attempts grounded (accepted).
        if (++call <= 1) return { output: "x", claims: [], toolTrace: [] };
        return {
          output: "grounded now",
          claims: [{ statement: "value observed", evidence: ["obs=1"], confidence: 0.9 }],
          toolTrace: [{ tool: "obs", args: {}, ok: true, output: "obs=1", at: 0 }],
        };
      },
    };
    swarm = await createInlineSwarm({ capabilities: ["general"], poolSize: 1, executor, maxAttempts: 4 });
    await swarm.runGoal("Recover after feedback", { timeoutMs: 15_000 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].failedChecks && seen[0].failedChecks.length).toBeGreaterThan(0);
  });
});
