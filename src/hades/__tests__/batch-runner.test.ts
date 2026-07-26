import { describe, it, expect } from "vitest";
import { BatchTrajectoryRunner } from "../research/batch-runner";
import { TrajectoryRecorder, InMemoryTrajectoryStore } from "../research/recorder";
import type { GoalTrajectory } from "../research/recorder";

function recordGoal(objective: string, success: boolean): GoalTrajectory {
  const rec = new TrajectoryRecorder(() => 1);
  const id = objective.replace(/\s+/g, "-");
  rec.beginGoal(id, objective);
  rec.beginTask(id, `${id}-t1`, "do it");
  rec.recordTool(id, `${id}-t1`, { tool: "act", ok: success });
  rec.endTask(id, `${id}-t1`, success);
  return rec.endGoal(id, success)!;
}

describe("BatchTrajectoryRunner", () => {
  it("drives N goals into a dataset in input order", async () => {
    const store = new InMemoryTrajectoryStore();
    const runner = new BatchTrajectoryRunner(async (obj) => recordGoal(obj, true), { concurrency: 2, store });

    const summary = await runner.run(["a", "b", "c", "d"]);
    expect(summary.total).toBe(4);
    expect(summary.succeeded).toBe(4);
    expect(summary.failed).toBe(0);
    expect(summary.trajectories.map((t) => t.objective)).toEqual(["a", "b", "c", "d"]);
    expect(store.size()).toBe(4);
  });

  it("isolates a failing goal without aborting the batch", async () => {
    const runner = new BatchTrajectoryRunner(
      async (obj, i) => {
        if (i === 1) throw new Error("goal blew up");
        return recordGoal(obj, true);
      },
      { concurrency: 1 }
    );

    const summary = await runner.run(["ok1", "boom", "ok2"]);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]).toMatchObject({ objective: "boom", index: 1, error: "goal blew up" });
    expect(summary.trajectories.map((t) => t.objective)).toEqual(["ok1", "ok2"]);
  });

  it("reports progress and respects the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const progress: number[] = [];
    const runner = new BatchTrajectoryRunner(
      async (obj) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return recordGoal(obj, true);
      },
      { concurrency: 2, onProgress: (done) => progress.push(done) }
    );

    await runner.run(["a", "b", "c", "d", "e"]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(progress[progress.length - 1]).toBe(5);
  });

  it("handles an empty objective list", async () => {
    const runner = new BatchTrajectoryRunner(async (obj) => recordGoal(obj, true));
    const summary = await runner.run([]);
    expect(summary).toMatchObject({ total: 0, succeeded: 0, failed: 0 });
  });
});
