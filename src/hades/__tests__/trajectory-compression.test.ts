import { describe, it, expect } from "vitest";
import { compressTrajectory, toTrainingExample, toJsonl } from "../research/compression";
import type { GoalTrajectory, TaskTrajectory, ToolEvent } from "../research/recorder";

function tool(t: string, ok = true, summary?: string): ToolEvent {
  return { tool: t, ok, summary, at: 1 };
}
function task(id: string, tools: ToolEvent[], success = true): TaskTrajectory {
  return { taskId: id, description: id, tools, success, startedAt: 1, endedAt: 2 };
}
function goal(objective: string, tasks: TaskTrajectory[], success = true): GoalTrajectory {
  return { goalId: "g", objective, tasks, success, startedAt: 1, endedAt: 2 };
}

describe("compressTrajectory", () => {
  it("collapses consecutive duplicate tool calls with a repeat count", () => {
    const g = goal("scrape", [task("t1", [tool("fetch"), tool("fetch"), tool("fetch"), tool("parse")])]);
    const c = compressTrajectory(g);
    expect(c.steps.map((s) => `${s.tool}x${s.repeat}`)).toEqual(["fetchx3", "parsex1"]);
    expect(c.toolCounts).toEqual({ fetch: 3, parse: 1 });
    expect(c.taskCount).toBe(1);
  });

  it("drops failed steps when asked", () => {
    const g = goal("x", [task("t1", [tool("a", true), tool("b", false), tool("c", true)])]);
    const kept = compressTrajectory(g, { dropFailed: true });
    expect(kept.steps.map((s) => s.tool)).toEqual(["a", "c"]);
    // toolCounts also reflects the drop.
    expect(kept.toolCounts).toEqual({ a: 1, c: 1 });
  });

  it("caps length with head+tail and marks truncated", () => {
    const tools = ["a", "b", "c", "d", "e", "f"].map((t) => tool(t));
    const c = compressTrajectory(goal("long", [task("t1", tools)]), { maxSteps: 4, collapseDuplicates: false });
    expect(c.truncated).toBe(true);
    expect(c.steps).toHaveLength(4);
    expect(c.steps.map((s) => s.tool)).toEqual(["a", "b", "e", "f"]); // head 2 + tail 2
  });

  it("flattens across multiple tasks", () => {
    const g = goal("multi", [task("t1", [tool("a")]), task("t2", [tool("b"), tool("c")])]);
    const c = compressTrajectory(g);
    expect(c.steps.map((s) => s.tool)).toEqual(["a", "b", "c"]);
    expect(c.taskCount).toBe(2);
  });

  it("renders a training example and JSONL", () => {
    const g = goal("build", [task("t1", [tool("plan", true, "made a plan"), tool("code"), tool("code"), tool("test", false)])], true);
    const c = compressTrajectory(g);
    const ex = toTrainingExample(c);
    expect(ex.prompt).toBe("build");
    expect(ex.success).toBe(true);
    expect(ex.completion).toContain("1. plan — made a plan");
    expect(ex.completion).toContain("code (x2)");
    expect(ex.completion).toContain("test [failed]");

    const jsonl = toJsonl([ex, ex]);
    expect(jsonl.split("\n")).toHaveLength(2);
    expect(JSON.parse(jsonl.split("\n")[0]).prompt).toBe("build");
  });
});
