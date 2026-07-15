import { describe, it, expect } from "vitest";
import { defaultRoleRegistry } from "../teams/role";
import { TeamFormer, slugify } from "../teams/former";
import type { Decomposer } from "../teams/former";

describe("TeamFormer heuristic", () => {
  it("maps required capabilities to roles, bracketed by planner + reviewer", async () => {
    const former = new TeamFormer(defaultRoleRegistry());
    const team = await former.form({
      objective: "Research and implement a caching layer",
      requiredCapabilities: ["search", "code"],
    });
    const roles = team.blueprint.requirements.map((r) => r.role);
    expect(roles).toContain("planner");
    expect(roles).toContain("researcher"); // search
    expect(roles).toContain("coder"); // code
    expect(roles).toContain("reviewer");
    expect(team.teamId).toBe("research-and-implement-a-caching-layer");
  });

  it("applies per-role count overrides and sizes the roster", async () => {
    const former = new TeamFormer(defaultRoleRegistry());
    const team = await former.form({
      objective: "Big parallel build",
      requiredCapabilities: ["code"],
      roleCounts: { coder: 4 },
    });
    const coder = team.blueprint.requirements.find((r) => r.role === "coder");
    expect(coder?.count).toBe(4);
    expect(team.roster.filter((s) => s.role === "coder")).toHaveLength(4);
  });

  it("falls back to a coder when no capability maps to a working role", async () => {
    const former = new TeamFormer(defaultRoleRegistry());
    const team = await former.form({ objective: "Do something" });
    const roles = team.blueprint.requirements.map((r) => r.role);
    expect(roles).toContain("coder");
  });

  it("throws when the formed blueprint exceeds maxAgents", async () => {
    const former = new TeamFormer(defaultRoleRegistry());
    await expect(
      former.form({ objective: "huge", requiredCapabilities: ["code"], roleCounts: { coder: 10 }, maxAgents: 3 })
    ).rejects.toThrow(/exceeds maxAgents/);
  });

  it("uses an injectable decomposer when provided", async () => {
    const decompose: Decomposer = () => ({
      name: "custom",
      requirements: [{ role: "researcher", count: 2 }],
    });
    const former = new TeamFormer(defaultRoleRegistry(), { decompose });
    const team = await former.form({ objective: "anything" }, "t9");
    expect(team.blueprint.name).toBe("custom");
    expect(team.roster).toEqual([
      { agentId: "t9.researcher.0", role: "researcher" },
      { agentId: "t9.researcher.1", role: "researcher" },
    ]);
  });

  it("slugify normalizes objectives", () => {
    expect(slugify("Ship the Feature!!")).toBe("ship-the-feature");
    expect(slugify("")).toBe("team");
  });
});
