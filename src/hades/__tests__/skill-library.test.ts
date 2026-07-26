import { describe, it, expect } from "vitest";
import { SkillLibrary } from "../skills/library";
import { serializeSkillFile, type SkillManifest } from "../skills/skill-file";

function skillFile(m: Partial<SkillManifest> & { name: string; description: string }): string {
  return serializeSkillFile({
    capabilities: [],
    tools: [],
    instructions: "",
    ...m,
  });
}

const research = skillFile({
  name: "research",
  description: "Search the open web and synthesize findings.",
  capabilities: ["web_search", "summarize"],
  tools: ["web_search"],
  whenToUse: "When the task needs fresh information from the internet.",
  instructions: "# research\nSearch before answering.",
});

const coder = skillFile({
  name: "coder",
  description: "Write and refactor TypeScript.",
  capabilities: ["code", "refactor"],
  tools: ["editor"],
  instructions: "# coder\nWrite clean code.",
});

// A registry that only knows about a subset of tools.
function toolRegistry(names: string[]): { get(name: string): unknown } {
  const set = new Set(names);
  return { get: (name: string) => (set.has(name) ? { name, description: name, execute: async () => null } : undefined) };
}

describe("SkillLibrary", () => {
  it("loads a mix of valid and malformed files without throwing", () => {
    const lib = new SkillLibrary();
    const report = lib.loadFiles([
      { path: "skills/research/SKILL.md", content: research },
      { path: "skills/broken/SKILL.md", content: "no frontmatter here" },
      { path: "skills/coder/SKILL.md", content: coder },
      { path: "skills/empty/SKILL.md", content: "---\nname: \ndescription: x\n---\nbody" },
    ]);
    expect(report.loaded.map((s) => s.manifest.name).sort()).toEqual(["coder", "research"]);
    expect(report.errors.map((e) => e.path).sort()).toEqual([
      "skills/broken/SKILL.md",
      "skills/empty/SKILL.md",
    ]);
    expect(lib.size()).toBe(2);
  });

  it("get returns an indexed skill and list is sorted by name", () => {
    const lib = new SkillLibrary();
    lib.loadFiles([
      { path: "a", content: research },
      { path: "b", content: coder },
    ]);
    expect(lib.get("research")?.path).toBe("a");
    expect(lib.get("missing")).toBeUndefined();
    expect(lib.list().map((s) => s.manifest.name)).toEqual(["coder", "research"]);
  });

  it("search matches name, description, and capability case-insensitively", () => {
    const lib = new SkillLibrary();
    lib.loadFiles([
      { path: "a", content: research },
      { path: "b", content: coder },
    ]);
    // name
    expect(lib.search("RESEARCH").map((s) => s.manifest.name)).toEqual(["research"]);
    // description word ("refactor" appears in coder's description)
    expect(lib.search("typescript").map((s) => s.manifest.name)).toEqual(["coder"]);
    // capability
    expect(lib.search("web_search").map((s) => s.manifest.name)).toEqual(["research"]);
    // whenToUse
    expect(lib.search("internet").map((s) => s.manifest.name)).toEqual(["research"]);
    // no hit
    expect(lib.search("nonexistent-xyz")).toEqual([]);
  });

  it("byCapability returns providers case-insensitively, sorted", () => {
    const lib = new SkillLibrary();
    lib.add({
      name: "b-skill",
      description: "d",
      capabilities: ["Shared"],
      tools: [],
      instructions: "",
    });
    lib.add({
      name: "a-skill",
      description: "d",
      capabilities: ["shared"],
      tools: [],
      instructions: "",
    });
    expect(lib.byCapability("SHARED").map((s) => s.manifest.name)).toEqual(["a-skill", "b-skill"]);
    expect(lib.byCapability("none")).toEqual([]);
  });

  it("resolve merges+dedupes capabilities and reports missing tools", () => {
    const lib = new SkillLibrary();
    lib.add({
      name: "s1",
      description: "d",
      capabilities: ["x", "y"],
      tools: ["known", "gone"],
      instructions: "",
    });
    lib.add({
      name: "s2",
      description: "d",
      capabilities: ["y", "z"],
      tools: ["gone", "alsoGone"],
      instructions: "",
    });
    const res = lib.resolve(["s1", "s2"], toolRegistry(["known"]));
    expect(res.skills.map((s) => s.name)).toEqual(["s1", "s2"]);
    // capabilities merged + deduped, first-seen order
    expect(res.capabilities).toEqual(["x", "y", "z"]);
    // missing tools deduped ("gone" only once)
    expect(res.missingTools).toEqual(["gone", "alsoGone"]);
    expect(res.unknownSkills).toEqual([]);
  });

  it("resolve reports unknown skill names", () => {
    const lib = new SkillLibrary();
    lib.add({ name: "s1", description: "d", capabilities: ["a"], tools: [], instructions: "" });
    const res = lib.resolve(["s1", "ghost", "phantom"], toolRegistry([]));
    expect(res.skills.map((s) => s.name)).toEqual(["s1"]);
    expect(res.unknownSkills).toEqual(["ghost", "phantom"]);
    expect(res.capabilities).toEqual(["a"]);
    expect(res.missingTools).toEqual([]);
  });

  it("name collision keeps the last definition and records a warning", () => {
    const lib = new SkillLibrary();
    const first = skillFile({ name: "dup", description: "first version", capabilities: ["a"] });
    const second = skillFile({ name: "dup", description: "second version", capabilities: ["b"] });
    const report = lib.loadFiles([
      { path: "first", content: first },
      { path: "second", content: second },
    ]);
    expect(lib.size()).toBe(1);
    expect(lib.get("dup")?.manifest.description).toBe("second version");
    expect(lib.get("dup")?.path).toBe("second");
    // the second (last) entry carries the collision warning
    const last = report.loaded[report.loaded.length - 1];
    expect(last.warnings.some((w) => w.includes("collision"))).toBe(true);
  });

  it("carries parse warnings onto the loaded skill", () => {
    const lib = new SkillLibrary();
    const withUnknownKey = "---\nname: w\ndescription: has an unknown key\nbogusKey: 1\n---\nbody";
    const report = lib.loadFiles([{ path: "w", content: withUnknownKey }]);
    expect(report.errors).toEqual([]);
    expect(report.loaded[0].warnings.some((w) => w.includes("bogusKey"))).toBe(true);
  });

  it("empty library behaves", () => {
    const lib = new SkillLibrary();
    expect(lib.size()).toBe(0);
    expect(lib.list()).toEqual([]);
    expect(lib.search("anything")).toEqual([]);
    expect(lib.byCapability("anything")).toEqual([]);
    const res = lib.resolve([], toolRegistry([]));
    expect(res).toEqual({ skills: [], capabilities: [], missingTools: [], unknownSkills: [] });
  });
});
