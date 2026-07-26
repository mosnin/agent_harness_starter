import { describe, it, expect } from "vitest";
import { RoleRegistry, defaultRoleRegistry } from "../teams/role";
import { blueprintSize, validateBlueprint, expandRoster } from "../teams/blueprint";
import type { TeamBlueprint } from "../teams/blueprint";

const bp: TeamBlueprint = {
  name: "ship-feature",
  requirements: [
    { role: "planner", count: 1 },
    { role: "coder", count: 3 },
    { role: "reviewer", count: 1 },
  ],
  maxAgents: 8,
};

describe("RoleRegistry", () => {
  it("seeds a default role vocabulary and finds roles by capability", () => {
    const reg = defaultRoleRegistry();
    expect(reg.has("coder")).toBe(true);
    expect(reg.get("researcher")?.capabilities).toContain("search");
    expect(reg.withCapability("verify").map((r) => r.name).sort()).toEqual(["reviewer", "tester"]);
  });
});

describe("blueprint", () => {
  it("computes the nominal team size", () => {
    expect(blueprintSize(bp)).toBe(5);
  });

  it("validates against the role registry", () => {
    const reg = defaultRoleRegistry();
    expect(validateBlueprint(bp, reg)).toEqual({ ok: true, errors: [] });
  });

  it("rejects unknown roles, bad counts, and oversize teams", () => {
    const reg = defaultRoleRegistry();
    const bad: TeamBlueprint = {
      name: "bad",
      requirements: [
        { role: "wizard", count: 1 },
        { role: "coder", count: 0 },
        { role: "reviewer", count: 5, max: 2 },
      ],
      maxAgents: 3,
    };
    const res = validateBlueprint(bad, reg);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("unknown role: wizard"))).toBe(true);
    expect(res.errors.some((e) => e.includes("at least 1"))).toBe(true);
    expect(res.errors.some((e) => e.includes("above max 2"))).toBe(true);
    expect(res.errors.some((e) => e.includes("exceeds maxAgents"))).toBe(true);
  });

  it("flags an empty blueprint", () => {
    expect(validateBlueprint({ name: "empty", requirements: [] }, new RoleRegistry()).ok).toBe(false);
  });

  it("expands into a concrete namespaced roster", () => {
    const roster = expandRoster(bp, "team1");
    expect(roster).toHaveLength(5);
    expect(roster[0]).toEqual({ agentId: "team1.planner.0", role: "planner" });
    expect(roster.filter((s) => s.role === "coder").map((s) => s.agentId)).toEqual([
      "team1.coder.0",
      "team1.coder.1",
      "team1.coder.2",
    ]);
  });
});
