import { describe, it, expect } from "vitest";
import { computeDagLayout } from "../server/dag";
import type { WorkerTask } from "../types";

function t(id: string, deps: string[] = [], replicas?: number): WorkerTask {
  return {
    id, goalId: "g", description: `task ${id}`, requiredCapabilities: [], input: {},
    dependsOn: deps, priority: 5, status: "pending", attempts: 0, maxAttempts: 3, createdAt: 0,
    ...(replicas ? { consensus: { replicas, quorum: 0.5 } } : {}),
  };
}

describe("computeDagLayout", () => {
  it("assigns topological levels and edges", () => {
    // a, b are roots; c depends on a,b; d depends on c.
    const layout = computeDagLayout([t("a"), t("b"), t("c", ["a", "b"]), t("d", ["c"])]);
    const level = Object.fromEntries(layout.nodes.map((n) => [n.id, n.level]));
    expect(level.a).toBe(0);
    expect(level.b).toBe(0);
    expect(level.c).toBe(1);
    expect(level.d).toBe(2);
    expect(layout.edges).toContainEqual({ from: "a", to: "c" });
    expect(layout.edges).toContainEqual({ from: "c", to: "d" });
    expect(layout.levels[0].sort()).toEqual(["a", "b"]);
    expect(layout.levels[2]).toEqual(["d"]);
  });

  it("carries consensus replica counts and is cycle-safe", () => {
    const layout = computeDagLayout([t("x", ["y"], 3), t("y", ["x"])]); // cycle
    expect(layout.nodes.find((n) => n.id === "x")?.consensus).toBe(3);
    expect(layout.nodes.every((n) => n.level >= 0)).toBe(true); // didn't infinite-loop
  });

  it("ignores edges to unknown deps", () => {
    const layout = computeDagLayout([t("a", ["ghost"])]);
    expect(layout.edges.length).toBe(0);
    expect(layout.nodes[0].level).toBe(0);
  });
});
