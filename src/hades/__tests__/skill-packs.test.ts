import { describe, it, expect } from "vitest";
import { SkillPackLoader, SkillPackCatalog } from "../skill-packs/pack";
import { builtinSkillPackCatalog, devopsPack, BUILTIN_PACKS } from "../skill-packs/builtin";
import { SkillRegistry } from "../../swarm-runtime/skills/skill";

describe("SkillPackLoader", () => {
  it("installs all skills in a pack and tracks it", () => {
    const registry = new SkillRegistry();
    const loader = new SkillPackLoader(registry);
    const res = loader.load(devopsPack);

    expect(res.installed).toEqual(["deploy", "ci-pipeline", "observability"]);
    expect(res.skipped).toEqual([]);
    expect(registry.get("deploy")?.capabilities).toEqual(["deploy", "rollback"]);
    expect(loader.loadedPacks()).toEqual(["devops"]);
    expect(loader.isLoaded("devops")).toBe(true);
    expect(loader.skillsOf("devops")).toContain("observability");
  });

  it("skips a conflicting skill unless overwrite is set", () => {
    const registry = new SkillRegistry();
    registry.register({ name: "deploy", description: "mine", capabilities: ["custom"] });
    const loader = new SkillPackLoader(registry);

    const res = loader.load(devopsPack);
    expect(res.skipped).toContain("deploy");
    expect(registry.get("deploy")?.description).toBe("mine"); // untouched

    const forced = loader.load(devopsPack, { overwrite: true });
    expect(forced.installed).toContain("deploy");
    expect(registry.get("deploy")?.description).toBe("Plan and execute a safe deployment");
  });

  it("resolves capabilities across an installed pack via the registry", () => {
    const registry = new SkillRegistry();
    new SkillPackLoader(registry).load(devopsPack);
    const resolved = registry.resolve(["deploy", "observability"]);
    expect(resolved.capabilities).toEqual(expect.arrayContaining(["deploy", "rollback", "monitoring", "alerting"]));
  });
});

describe("SkillPackCatalog", () => {
  it("lists built-in packs with their skill names", () => {
    const catalog = builtinSkillPackCatalog();
    const names = catalog.list().map((p) => p.name).sort();
    expect(names).toEqual(["devops", "finance", "research"]);
    const research = catalog.list().find((p) => p.name === "research");
    expect(research?.skills).toContain("citation");
  });

  it("installs a catalog pack by name", () => {
    const registry = new SkillRegistry();
    const loader = new SkillPackLoader(registry);
    const catalog = builtinSkillPackCatalog();
    const res = catalog.install("finance", loader);
    expect(res.installed).toContain("forecasting");
    expect(registry.get("risk")).toBeDefined();
  });

  it("throws installing an unknown pack", () => {
    const loader = new SkillPackLoader(new SkillRegistry());
    expect(() => new SkillPackCatalog().install("ghost", loader)).toThrow(/Unknown skill pack/);
  });

  it("every built-in skill carries a prompt fragment and capabilities", () => {
    for (const pack of BUILTIN_PACKS) {
      for (const skill of pack.skills) {
        expect(skill.capabilities.length).toBeGreaterThan(0);
        expect(skill.promptFragment && skill.promptFragment.length).toBeGreaterThan(0);
      }
    }
  });
});
