import { describe, it, expect } from "vitest";
import {
  parseAgentSkill,
  toHadesManifest,
  fromHadesManifest,
  type AgentSkillsManifest,
} from "../agentskills-compat";
import type { SkillManifest } from "../skill-file";

// ===========================================================================
// parseAgentSkill — happy paths
// ===========================================================================

describe("parseAgentSkill", () => {
  it("parses a full agentskills.io example: scalars, allowed-tools list, nested metadata", () => {
    const doc = `---
name: pdf-editor
description: "Edit and merge PDF files"
license: MIT
version: 2.1.0
allowed-tools: [Read, Write, Bash]
metadata:
  capabilities: pdf,documents
  author: acme-corp
---
# PDF Editor

Use pdfkit to merge and edit PDF documents.
`;
    const { manifest, body, warnings } = parseAgentSkill(doc);
    expect(manifest.name).toBe("pdf-editor");
    expect(manifest.description).toBe("Edit and merge PDF files");
    expect(manifest.license).toBe("MIT");
    expect(manifest.version).toBe("2.1.0");
    expect(manifest.allowedTools).toEqual(["Read", "Write", "Bash"]);
    expect(manifest.metadata).toEqual({ capabilities: "pdf,documents", author: "acme-corp" });
    expect(body).toBe("# PDF Editor\n\nUse pdfkit to merge and edit PDF documents.\n");
    expect(warnings).toEqual([]);
  });

  it("treats inline and block allowed-tools forms as equivalent", () => {
    const inline = `---\nname: n\ndescription: d\nallowed-tools: [a, b]\n---\nbody`;
    const block = `---\nname: n\ndescription: d\nallowed-tools:\n  - a\n  - b\n---\nbody`;
    expect(parseAgentSkill(inline).manifest).toEqual(parseAgentSkill(block).manifest);
  });

  it("only the FIRST two `---` delimit frontmatter; body may contain more dashes", () => {
    const doc = `---\nname: n\ndescription: d\n---\n# Title\n\n---\n\nmid rule\n\n---\n`;
    const { body } = parseAgentSkill(doc);
    expect(body).toBe("# Title\n\n---\n\nmid rule\n\n---\n");
  });

  it("accepts CRLF line endings", () => {
    const doc = "---\r\nname: n\r\ndescription: d\r\n---\r\nbody line\r\n";
    const { manifest, body } = parseAgentSkill(doc);
    expect(manifest.name).toBe("n");
    expect(body).toBe("body line\n");
  });

  it("strips a leading BOM", () => {
    const doc = "﻿---\nname: n\ndescription: d\n---\nbody";
    const { manifest } = parseAgentSkill(doc);
    expect(manifest.name).toBe("n");
  });

  it("parses quoted scalars with escapes and commas", () => {
    const doc = `---\nname: "a, b"\ndescription: "line1\\nline2"\n---\nbody`;
    const { manifest } = parseAgentSkill(doc);
    expect(manifest.name).toBe("a, b");
    expect(manifest.description).toBe("line1\nline2");
  });

  it("captures unknown top-level scalar keys into extra", () => {
    const doc = `---\nname: n\ndescription: d\nauthor: someone\n---\nbody`;
    const { manifest } = parseAgentSkill(doc);
    expect(manifest.extra).toEqual({ author: "someone" });
  });

  it("captures unknown top-level inline list keys into extra as string[]", () => {
    const doc = `---\nname: n\ndescription: d\ntags: [a, b, c]\n---\nbody`;
    const { manifest } = parseAgentSkill(doc);
    expect(manifest.extra).toEqual({ tags: ["a", "b", "c"] });
  });

  it("captures unknown top-level block list keys into extra as string[]", () => {
    const doc = `---\nname: n\ndescription: d\ntags:\n  - a\n  - b\n---\nbody`;
    const { manifest } = parseAgentSkill(doc);
    expect(manifest.extra).toEqual({ tags: ["a", "b"] });
  });

  it("ignores full-line comments and blank lines in frontmatter", () => {
    const doc = `---\n# a comment\nname: n\n\ndescription: d\n---\nbody`;
    const { manifest } = parseAgentSkill(doc);
    expect(manifest.name).toBe("n");
    expect(manifest.description).toBe("d");
  });
});

// ===========================================================================
// parseAgentSkill — adversarial frontmatter (survives, warns, never mis-parses)
// ===========================================================================

describe("parseAgentSkill — adversarial input", () => {
  it("throws on missing frontmatter", () => {
    expect(() => parseAgentSkill("no frontmatter here")).toThrow(/missing frontmatter/);
  });

  it("throws on unterminated frontmatter fence", () => {
    const doc = "---\nname: n\ndescription: d\nbody with no closing fence";
    expect(() => parseAgentSkill(doc)).toThrow(/unterminated frontmatter/);
  });

  it("throws on missing name", () => {
    const doc = `---\ndescription: d\n---\nbody`;
    expect(() => parseAgentSkill(doc)).toThrow(/missing required frontmatter field `name`/);
  });

  it("throws on blank name", () => {
    const doc = `---\nname: "  "\ndescription: d\n---\nbody`;
    expect(() => parseAgentSkill(doc)).toThrow(/missing required frontmatter field `name`/);
  });

  it("throws on missing description", () => {
    const doc = `---\nname: n\n---\nbody`;
    expect(() => parseAgentSkill(doc)).toThrow(/missing required frontmatter field `description`/);
  });

  it("throws on a malformed key/value line with no colon", () => {
    const doc = `---\nname: n\ndescription: d\nnot-a-valid-line\n---\nbody`;
    expect(() => parseAgentSkill(doc)).toThrow(/malformed frontmatter line/);
  });

  it("warns and overwrites (last wins) on duplicate top-level keys", () => {
    const doc = `---\nname: first\nname: second\ndescription: d\n---\nbody`;
    const { manifest, warnings } = parseAgentSkill(doc);
    expect(manifest.name).toBe("second");
    expect(warnings.some((w) => /duplicate frontmatter key "name"/.test(w))).toBe(true);
  });

  it("rejects (with a warning) nested mapping under an unsupported top-level key instead of mis-parsing it", () => {
    const doc = `---\nname: n\ndescription: d\nauthor:\n  first: Bob\n  last: Smith\n---\nbody`;
    const { manifest, warnings } = parseAgentSkill(doc);
    expect(manifest.extra?.author).toBeUndefined();
    expect(warnings.some((w) => /unsupported nested mapping under frontmatter key "author"/.test(w))).toBe(true);
  });

  it("rejects (with a warning) two-level-deep nesting even under metadata", () => {
    const doc = `---\nname: n\ndescription: d\nmetadata:\n  category:\n    sub: x\n  other: ok\n---\nbody`;
    const { manifest, warnings } = parseAgentSkill(doc);
    expect(manifest.metadata?.category).toBe("");
    expect(manifest.metadata?.other).toBe("ok");
    expect(warnings.some((w) => /unsupported nested mapping under "metadata\.category"/.test(w))).toBe(true);
  });

  it("warns and ignores an inline value on `metadata:` instead of mis-parsing it as a mapping", () => {
    const doc = `---\nname: n\ndescription: d\nmetadata: not-a-mapping\n---\nbody`;
    const { manifest, warnings } = parseAgentSkill(doc);
    expect(manifest.metadata).toBeUndefined();
    expect(warnings.some((w) => /"metadata" must be a nested mapping/.test(w))).toBe(true);
  });

  it("warns on a list item inside metadata (metadata values must be scalar)", () => {
    const doc = `---\nname: n\ndescription: d\nmetadata:\n  - not.valid\n  ok: yes\n---\nbody`;
    const { manifest, warnings } = parseAgentSkill(doc);
    expect(manifest.metadata).toEqual({ ok: "yes" });
    expect(warnings.some((w) => /"metadata" values must be scalar/.test(w))).toBe(true);
  });

  it("warns and ignores stray indented junk that isn't part of any list or metadata block", () => {
    const doc = `---\nname: n\n  stray indented line\ndescription: d\n---\nbody`;
    const { manifest, warnings } = parseAgentSkill(doc);
    expect(manifest.name).toBe("n");
    expect(warnings.some((w) => /ignoring unexpected indented frontmatter line/.test(w))).toBe(true);
  });

  it("handles tabs as indentation inside a metadata block without crashing", () => {
    const doc = "---\nname: n\ndescription: d\nmetadata:\n\tcapabilities: a,b\n---\nbody";
    const { manifest } = parseAgentSkill(doc);
    expect(manifest.metadata).toEqual({ capabilities: "a,b" });
  });

  it("survives a 10MB body without crashing or truncating it", () => {
    const bigBody = "x".repeat(10 * 1024 * 1024);
    const doc = `---\nname: n\ndescription: d\n---\n${bigBody}`;
    const { body } = parseAgentSkill(doc);
    expect(body.length).toBe(bigBody.length);
  });

  it("duplicate metadata sub-keys: warns and last wins", () => {
    const doc = `---\nname: n\ndescription: d\nmetadata:\n  a: one\n  a: two\n---\nbody`;
    const { manifest, warnings } = parseAgentSkill(doc);
    expect(manifest.metadata).toEqual({ a: "two" });
    expect(warnings.some((w) => /duplicate metadata key "a"/.test(w))).toBe(true);
  });
});

// ===========================================================================
// toHadesManifest
// ===========================================================================

describe("toHadesManifest", () => {
  it("maps allowedTools -> tools, body -> instructions", () => {
    const a: AgentSkillsManifest = { name: "n", description: "d", allowedTools: ["Read", "Write"] };
    const { manifest, warnings } = toHadesManifest(a, "instructions body");
    expect(manifest.tools).toEqual(["Read", "Write"]);
    expect(manifest.instructions).toBe("instructions body");
    expect(manifest.name).toBe("n");
    expect(manifest.description).toBe("d");
    expect(warnings).toEqual([]);
  });

  it("defaults tools to [] when allowedTools is absent", () => {
    const a: AgentSkillsManifest = { name: "n", description: "d" };
    const { manifest } = toHadesManifest(a, "body");
    expect(manifest.tools).toEqual([]);
  });

  it("parses capabilities from metadata.capabilities as a trimmed CSV", () => {
    const a: AgentSkillsManifest = { name: "n", description: "d", metadata: { capabilities: " research, web_search ,, docs" } };
    const { manifest } = toHadesManifest(a, "body");
    expect(manifest.capabilities).toEqual(["research", "web_search", "docs"]);
  });

  it("defaults capabilities to [] when metadata or metadata.capabilities is absent", () => {
    expect(toHadesManifest({ name: "n", description: "d" }, "body").manifest.capabilities).toEqual([]);
    expect(
      toHadesManifest({ name: "n", description: "d", metadata: { author: "x" } }, "body").manifest.capabilities
    ).toEqual([]);
  });

  it("maps version straight through", () => {
    const a: AgentSkillsManifest = { name: "n", description: "d", version: "9.9.9" };
    expect(toHadesManifest(a, "body").manifest.version).toBe("9.9.9");
  });

  it("produces a named warning for license (unmapped) rather than silently dropping it", () => {
    const a: AgentSkillsManifest = { name: "n", description: "d", license: "Apache-2.0" };
    const { warnings } = toHadesManifest(a, "body");
    expect(warnings.some((w) => w.includes('"license"') && w.includes("Apache-2.0"))).toBe(true);
  });

  it("produces a named warning for every unmapped metadata key (other than capabilities)", () => {
    const a: AgentSkillsManifest = { name: "n", description: "d", metadata: { author: "x", team: "y" } };
    const { warnings } = toHadesManifest(a, "body");
    expect(warnings.some((w) => w.includes('metadata key "author"'))).toBe(true);
    expect(warnings.some((w) => w.includes('metadata key "team"'))).toBe(true);
  });

  it("produces a named warning for every extra frontmatter key", () => {
    const a: AgentSkillsManifest = { name: "n", description: "d", extra: { homepage: "https://x", tags: ["a", "b"] } };
    const { warnings } = toHadesManifest(a, "body");
    expect(warnings.some((w) => w.includes('"homepage"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"tags"'))).toBe(true);
  });

  it("surfaces a validation warning when the converted manifest is structurally invalid (duplicate capability)", () => {
    const a: AgentSkillsManifest = { name: "n", description: "d", metadata: { capabilities: "x,x" } };
    const { warnings } = toHadesManifest(a, "body");
    expect(warnings.some((w) => /failed validation/.test(w) && /duplicate capability: x/.test(w))).toBe(true);
  });
});

// ===========================================================================
// fromHadesManifest
// ===========================================================================

describe("fromHadesManifest", () => {
  function skill(overrides: Partial<SkillManifest> = {}): SkillManifest {
    return {
      name: "n",
      description: "d",
      capabilities: [],
      tools: [],
      instructions: "body text",
      ...overrides,
    };
  }

  it("emits name/description/allowed-tools/instructions", () => {
    const { content } = fromHadesManifest(skill({ tools: ["Read", "Write"] }));
    expect(content).toContain("name: n");
    expect(content).toContain("description: d");
    expect(content).toContain("allowed-tools: [Read, Write]");
    expect(content.endsWith("body text")).toBe(true);
  });

  it("emits capabilities as a metadata.capabilities CSV when present", () => {
    const { content } = fromHadesManifest(skill({ capabilities: ["a", "b"] }));
    expect(content).toMatch(/metadata:\n\s+capabilities: a,b/);
  });

  it("omits the metadata block entirely when capabilities is empty", () => {
    const { content } = fromHadesManifest(skill({ capabilities: [] }));
    expect(content).not.toContain("metadata:");
  });

  it("encodes whenToUse/model as extension keys and warns about each", () => {
    const { content, warnings } = fromHadesManifest(skill({ whenToUse: "when needed", model: "some-model" }));
    expect(content).toContain("when-to-use: when needed");
    expect(content).toContain("model: some-model");
    expect(warnings.some((w) => w.includes("whenToUse"))).toBe(true);
    expect(warnings.some((w) => w.includes('"model"'))).toBe(true);
  });

  it("preserves instructions byte-for-byte, including embedded `---` lines", () => {
    const instructions = "para one\n\n---\n\npara two with a --- dash inline\n";
    const { content } = fromHadesManifest(skill({ instructions }));
    expect(content.endsWith(instructions)).toBe(true);
  });
});

// ===========================================================================
// Round-trip law: toHadesManifest(parseAgentSkill(fromHadesManifest(m).content))
// preserves name/description/tools/instructions byte-exactly.
// ===========================================================================

describe("round-trip law: fromHadesManifest -> parseAgentSkill -> toHadesManifest", () => {
  function roundTrip(m: SkillManifest): SkillManifest {
    const { content } = fromHadesManifest(m);
    const { manifest: agentManifest, body } = parseAgentSkill(content);
    return toHadesManifest(agentManifest, body).manifest;
  }

  const cases: Array<[string, SkillManifest]> = [
    [
      "simple",
      { name: "researcher", description: "Web research skill", capabilities: [], tools: ["web_search"], instructions: "Do research.\n" },
    ],
    [
      "empty tools/capabilities",
      { name: "bare", description: "Nothing bound", capabilities: [], tools: [], instructions: "" },
    ],
    [
      "many tools + capabilities",
      {
        name: "swiss-army",
        description: "Does many things",
        capabilities: ["research", "web_search", "docs"],
        tools: ["Read", "Write", "Bash", "http_get"],
        instructions: "# Multi-step\n\n1. Read\n2. Write\n3. Report\n",
      },
    ],
    [
      "special characters in name/description",
      {
        name: 'quirky "name", with: punctuation',
        description: "Multi-line\ndescription with a colon: like this",
        capabilities: [],
        tools: [],
        instructions: "instructions with\nnewlines\nand   spacing",
      },
    ],
    [
      "instructions containing frontmatter-looking dashes",
      {
        name: "dash-body",
        description: "d",
        capabilities: [],
        tools: [],
        instructions: "before\n---\nname: not-a-real-header\n---\nafter\n",
      },
    ],
  ];

  it.each(cases)("preserves name/description/tools/instructions byte-exactly: %s", (_label, m) => {
    const result = roundTrip(m);
    expect(result.name).toBe(m.name);
    expect(result.description).toBe(m.description);
    expect(result.tools).toEqual(m.tools);
    expect(result.instructions).toBe(m.instructions);
  });

  it("also preserves capabilities via the metadata.capabilities channel", () => {
    const m = cases[2][1];
    const result = roundTrip(m);
    expect(result.capabilities).toEqual(m.capabilities);
  });
});
