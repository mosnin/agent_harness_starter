import { describe, it, expect } from "vitest";
import {
  parseSkillFile,
  serializeSkillFile,
  validateSkillManifest,
  toSwarmSkill,
  skillTemplate,
  type SkillManifest,
} from "../skills/skill-file";
import type { SwarmTool } from "../../swarm-runtime/worker/toolbox";

const FULL = `---
name: research
description: "Web research: search and cite sources"
capabilities: [research, web_search]
tools:
  - web_search
  - http_get
whenToUse: When the task needs fresh facts from the open web.
model: claude-opus-4-1
version: 1.2.0
---
# Researcher

Search before answering and cite what you found.
`;

describe("parseSkillFile", () => {
  it("parses a full example including block lists and quoted scalars", () => {
    const { manifest, warnings } = parseSkillFile(FULL);
    expect(manifest.name).toBe("research");
    expect(manifest.description).toBe("Web research: search and cite sources");
    expect(manifest.capabilities).toEqual(["research", "web_search"]);
    expect(manifest.tools).toEqual(["web_search", "http_get"]);
    expect(manifest.whenToUse).toBe("When the task needs fresh facts from the open web.");
    expect(manifest.model).toBe("claude-opus-4-1");
    expect(manifest.version).toBe("1.2.0");
    expect(manifest.instructions).toBe(
      "# Researcher\n\nSearch before answering and cite what you found.\n"
    );
    expect(warnings).toEqual([]);
  });

  it("treats inline and block list forms as equivalent", () => {
    const inline = `---\nname: n\ndescription: d\ncapabilities: [a, b, c]\ntools: [t1]\n---\nbody`;
    const block = `---\nname: n\ndescription: d\ncapabilities:\n  - a\n  - b\n  - c\ntools:\n  - t1\n---\nbody`;
    const a = parseSkillFile(inline).manifest;
    const b = parseSkillFile(block).manifest;
    expect(a.capabilities).toEqual(b.capabilities);
    expect(a.tools).toEqual(b.tools);
    expect(a).toEqual(b);
  });

  it("only the first two `---` delimit frontmatter; body may contain dashes", () => {
    const doc = `---\nname: n\ndescription: d\ncapabilities: []\ntools: []\n---\n# Title\n\n---\n\nmid rule\n\n---\n`;
    const { manifest } = parseSkillFile(doc);
    expect(manifest.instructions).toBe("# Title\n\n---\n\nmid rule\n\n---\n");
  });

  it("accepts CRLF line endings", () => {
    const doc = "---\r\nname: n\r\ndescription: d\r\ncapabilities: [x]\r\ntools: []\r\n---\r\nhello\r\nworld\r\n";
    const { manifest } = parseSkillFile(doc);
    expect(manifest.name).toBe("n");
    expect(manifest.capabilities).toEqual(["x"]);
    expect(manifest.instructions).toBe("hello\nworld\n");
  });

  it("handles empty tools and capabilities", () => {
    const doc = `---\nname: n\ndescription: d\ncapabilities: []\ntools: []\n---\n`;
    const { manifest } = parseSkillFile(doc);
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.tools).toEqual([]);
    expect(manifest.instructions).toBe("");
  });

  it("throws a clear error when name or description is missing", () => {
    expect(() => parseSkillFile(`---\ndescription: d\n---\nbody`)).toThrow(/name/);
    expect(() => parseSkillFile(`---\nname: n\n---\nbody`)).toThrow(/description/);
    expect(() => parseSkillFile(`no frontmatter here`)).toThrow(/frontmatter/);
    expect(() => parseSkillFile(`---\nname: n\ndescription: d\nbody-without-close`)).toThrow(
      /unterminated|malformed/
    );
  });
});

describe("serializeSkillFile round-trip", () => {
  it("round-trips a manifest exactly", () => {
    const m: SkillManifest = {
      name: "research",
      description: "Web research: cite sources",
      capabilities: ["research", "web_search"],
      tools: ["web_search", "http_get"],
      whenToUse: "  needs leading space  ",
      model: "claude-opus-4-1",
      version: "1.2.0",
      instructions: "# Body\n\nLine with --- inside\n",
    };
    const text = serializeSkillFile(m);
    expect(parseSkillFile(text).manifest).toEqual(m);
  });

  it("round-trips minimal manifests and tricky list items", () => {
    const m: SkillManifest = {
      name: "n",
      description: "d",
      capabilities: [],
      tools: ["a, b", "plain", '"quoted"'],
      instructions: "",
    };
    expect(parseSkillFile(serializeSkillFile(m)).manifest).toEqual(m);
  });
});

describe("validateSkillManifest", () => {
  it("passes a well-formed manifest", () => {
    const res = validateSkillManifest({
      name: "n",
      description: "d",
      capabilities: ["a"],
      tools: [],
    });
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("catches missing fields, empties, and duplicates", () => {
    const res = validateSkillManifest({
      name: "",
      description: "  ",
      capabilities: ["a", "a", ""],
      tools: ["x", "x"],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /name/.test(e))).toBe(true);
    expect(res.errors.some((e) => /description/.test(e))).toBe(true);
    expect(res.errors.some((e) => /duplicate capability: a/.test(e))).toBe(true);
    expect(res.errors.some((e) => /empty or non-string/.test(e))).toBe(true);
    expect(res.errors.some((e) => /duplicate tool: x/.test(e))).toBe(true);
  });
});

describe("toSwarmSkill", () => {
  const mkTool = (name: string): SwarmTool => ({
    name,
    description: `${name} tool`,
    async execute() {
      return name;
    },
  });

  it("binds known tools from a registry and reports missing ones", () => {
    const registry = new Map<string, SwarmTool>([
      ["web_search", mkTool("web_search")],
      ["http_get", mkTool("http_get")],
    ]);
    const manifest: SkillManifest = {
      name: "research",
      description: "d",
      capabilities: ["research"],
      tools: ["web_search", "missing_tool"],
      instructions: "do research",
    };

    // Default: unknown tool raises.
    expect(() => toSwarmSkill(manifest, registry)).toThrow(/missing_tool/);

    // Lenient: collect missing, bind the rest, promptFragment = instructions.
    const { skill, missingTools } = toSwarmSkill(manifest, registry, { allowMissingTools: true });
    expect(missingTools).toEqual(["missing_tool"]);
    expect(skill.tools?.map((t) => t.name)).toEqual(["web_search"]);
    expect(skill.promptFragment).toBe("do research");
    expect(skill.capabilities).toEqual(["research"]);
  });
});

describe("skillTemplate", () => {
  it("produces a scaffold that parses back to a valid manifest with the name", () => {
    const text = skillTemplate("my-skill");
    const { manifest } = parseSkillFile(text);
    expect(manifest.name).toBe("my-skill");
    expect(validateSkillManifest(manifest).valid).toBe(true);
    // And the template itself round-trips.
    expect(parseSkillFile(serializeSkillFile(manifest)).manifest).toEqual(manifest);
  });
});
