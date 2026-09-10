import { describe, it, expect } from "vitest";
import { SkillForge, slugifyObjective } from "../learning/skill-forge";
import { SkillRegistry } from "../../swarm-runtime/skills/skill";
import type { Trajectory } from "../learning/skill-forge";

const successful: Trajectory = {
  objective: "Research competitor pricing and summarize",
  steps: [
    { tool: "web_search", ok: true, summary: "found pricing pages" },
    { tool: "http_get", ok: true, summary: "fetched details" },
    { tool: "web_search", ok: true },
    { tool: "flaky_tool", ok: false },
  ],
  success: true,
};

describe("slugifyObjective", () => {
  it("produces a stable kebab-case skill name", () => {
    expect(slugifyObjective("Research competitor pricing and summarize")).toBe("learned-research-competitor-pricing-summarize");
    expect(slugifyObjective("!!!")).toBe("learned-skill");
  });
});

describe("SkillForge — offline", () => {
  it("forges a playbook skill from a successful trajectory", async () => {
    const skill = await new SkillForge().forge(successful);
    expect(skill).not.toBeNull();
    expect(skill!.capabilities).toContain("web_search");
    expect(skill!.capabilities).toContain("http_get");
    expect(skill!.capabilities).not.toContain("flaky_tool"); // failed step excluded
    expect(skill!.promptFragment).toContain("web_search");
  });

  it("returns null for a failed trajectory", async () => {
    const skill = await new SkillForge().forge({ ...successful, success: false });
    expect(skill).toBeNull();
  });

  it("returns null when no successful tools meet the minimum", async () => {
    const skill = await new SkillForge({ minTools: 2 }).forge({
      objective: "trivial", steps: [{ tool: "one", ok: true }], success: true,
    });
    expect(skill).toBeNull();
  });

  it("forges and registers into a SkillRegistry", async () => {
    const registry = new SkillRegistry();
    const skill = await new SkillForge().forgeAndRegister(successful, registry);
    expect(skill).not.toBeNull();
    expect(registry.get(skill!.name)).toBeDefined();
  });

  it("uses an injected LLM synthesizer when provided", async () => {
    const forge = new SkillForge({
      synthesizer: async () => ({ name: "custom", description: "d", capabilities: ["x"] }),
    });
    const skill = await forge.forge(successful);
    expect(skill!.name).toBe("custom");
  });
});
