import { describe, it, expect } from "vitest";
import {
  TrajectoryRecorder,
  InMemoryTrajectoryStore,
  toSkillTrajectory,
} from "../research/recorder";
import { SkillForge } from "../learning/skill-forge";
import { SkillRegistry } from "../../swarm-runtime/skills/skill";

function clock() {
  let t = 0;
  return () => ++t;
}

describe("TrajectoryRecorder", () => {
  it("records a goal→task→tool→result trajectory with timestamps", () => {
    const rec = new TrajectoryRecorder(clock());
    rec.beginGoal("g1", "build a widget", "claude-x");
    rec.beginTask("g1", "t1", "research the API", "search");
    rec.recordTool("g1", "t1", { tool: "search", ok: true, summary: "found docs" });
    rec.recordTool("g1", "t1", { tool: "browse", ok: true });
    rec.endTask("g1", "t1", true);
    const goal = rec.endGoal("g1", true);

    expect(goal?.objective).toBe("build a widget");
    expect(goal?.model).toBe("claude-x");
    expect(goal?.success).toBe(true);
    expect(goal?.tasks).toHaveLength(1);
    expect(goal?.tasks[0].tools.map((t) => t.tool)).toEqual(["search", "browse"]);
    expect(goal?.tasks[0].tools[0].at).toBeGreaterThan(0);
    expect(goal?.endedAt).toBeGreaterThan(goal!.startedAt);
    expect(rec.size()).toBe(1);
  });

  it("ignores events for unknown goals/tasks", () => {
    const rec = new TrajectoryRecorder(clock());
    rec.beginTask("ghost", "t", "x"); // no such goal
    rec.recordTool("ghost", "t", { tool: "x", ok: true }); // no-op
    expect(rec.endGoal("ghost", true)).toBeUndefined();
    expect(rec.size()).toBe(0);
  });

  it("distills to a SkillForge trajectory and forges a skill", async () => {
    const rec = new TrajectoryRecorder(clock());
    rec.beginGoal("g1", "summarize a paper");
    rec.beginTask("g1", "t1", "read and summarize", "summarize");
    rec.recordTool("g1", "t1", { tool: "fetch", ok: true });
    rec.recordTool("g1", "t1", { tool: "summarize", ok: true });
    rec.endTask("g1", "t1", true);
    const goal = rec.endGoal("g1", true)!;

    const light = toSkillTrajectory(goal);
    expect(light.objective).toBe("summarize a paper");
    expect(light.success).toBe(true);
    expect(light.steps.map((s) => s.tool)).toEqual(["fetch", "summarize"]);

    const registry = new SkillRegistry();
    const skill = await new SkillForge().forgeAndRegister(light, registry);
    expect(skill).not.toBeNull();
    expect(registry.list().length).toBe(1);
  });
});

describe("TrajectoryStore", () => {
  it("accumulates trajectories for a dataset", () => {
    const rec = new TrajectoryRecorder(clock());
    rec.beginGoal("g1", "a");
    const g1 = rec.endGoal("g1", true)!;
    rec.beginGoal("g2", "b");
    const g2 = rec.endGoal("g2", false)!;

    const store = new InMemoryTrajectoryStore();
    store.addAll([g1, g2]);
    expect(store.size()).toBe(2);
    expect(store.all().map((g) => g.objective)).toEqual(["a", "b"]);
  });
});
