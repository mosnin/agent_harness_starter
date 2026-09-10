import { describe, it, expect } from "vitest";
import { HadesCli } from "../cli/cli";
import { defaultRoleRegistry } from "../teams/role";
import { demoTeamParallel } from "../examples/team-parallel";

describe("hades team CLI", () => {
  it("lists roles", async () => {
    const cli = new HadesCli({ roles: defaultRoleRegistry() });
    const res = await cli.run(["team", "roles"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("coder");
    expect(res.lines.join("\n")).toContain("reviewer");
  });

  it("plans a team for an objective", async () => {
    const cli = new HadesCli({ roles: defaultRoleRegistry() });
    const res = await cli.run(["team", "plan", "build", "a", "parser"]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toContain("Team build-a-parser");
    expect(res.lines.join("\n")).toContain("planner");
  });

  it("reports unavailable when no roles configured, and usage without objective", async () => {
    expect((await new HadesCli().run(["team", "roles"])).code).toBe(1);
    const res = await new HadesCli({ roles: defaultRoleRegistry() }).run(["team", "plan"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Usage");
  });
});

describe("demoTeamParallel example", () => {
  it("forms a team, works in parallel over A2A, and aggregates", async () => {
    const summary = await demoTeamParallel();
    expect(summary.teamId).toBe("batch-team");
    // 12 subtasks squared: 1,4,9,...,144.
    expect(summary.results.sort((a, b) => a - b)).toEqual([1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144]);
    // Work spread across the 4 coders.
    expect(Object.keys(summary.byAgent).length).toBeGreaterThan(1);
    // A 4-agent team modeling equal-cost tasks approaches 4x speedup.
    expect(summary.speedup).toBeGreaterThan(1);
  });
});
