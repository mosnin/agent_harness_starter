/**
 * ADVERSARIAL verification of the "easily create + plug into skills" system:
 *
 *   - src/hades/skills/skill-file.ts  (SKILL.md authoring: parse/serialize/validate/bind/template)
 *   - src/hades/skills/library.ts     (SkillLibrary: load a folder, search, resolve)
 *   - src/hades/mcp/server.ts         (McpServer + loopbackTransportPair)
 *
 * driven against the REAL builtinRegistry() (agent/tools.ts) and the REAL
 * McpClient (mcp/client.ts). Nothing here is mocked away: SKILL.md documents are
 * authored by hand, the calc tool is the real recursive-descent evaluator, and
 * the MCP round-trip runs the actual client -> loopback -> server -> tool path.
 *
 * These tests assert CORRECT behaviour. If the implementation is wrong, the
 * assertion fails (it is not weakened to pass).
 */

import { describe, it, expect } from "vitest";

import {
  parseSkillFile,
  serializeSkillFile,
  validateSkillManifest,
  toSwarmSkill,
  skillTemplate,
  type SkillManifest,
} from "../skills/skill-file";
import { SkillLibrary } from "../skills/library";
import { McpServer, loopbackTransportPair } from "../mcp/server";
import { McpClient, McpProtocolError } from "../mcp/client";
import { builtinRegistry } from "../agent/tools";

/* ------------------------------------------------------------------ *
 * Hand-authored SKILL.md documents (as a non-programmer would write).
 * ------------------------------------------------------------------ */

// (a) A realistic research skill — inline lists, all optional fields.
const RESEARCH_SKILL = `---
name: research
description: "Investigate a question across sources: gather, reconcile, cite."
capabilities: [research, synthesis, web]
tools: [extract_emails, extract_numbers]
whenToUse: When the task needs gathering and reconciling facts from many sources.
model: claude-opus-4
version: 1.2.0
---
# Research skill

You are a careful research analyst.

1. Break the question into sub-questions.
2. Gather evidence and note contradictions.
3. Synthesize a single cited answer.
`;

// (b) A code skill that declares the real \`calc\` tool. Block-style list too.
const CODE_SKILL = `---
name: code
description: Write and check small programs; do arithmetic with the calc tool.
capabilities:
  - coding
  - math
tools:
  - calc
whenToUse: When the task involves writing code or evaluating numeric expressions.
---
# Code skill

Use the \`calc\` tool for any arithmetic. Never guess a sum — compute it.
`;

// (c) A writer skill whose BODY contains a \`---\` horizontal rule, authored with
//     CRLF (\\r\\n) line endings, as a Windows editor would produce.
const WRITER_SKILL_CRLF = [
  "---",
  "name: writer",
  "description: Draft structured documents with clear section breaks.",
  "capabilities: [writing]",
  "tools: []",
  "---",
  "# Writer skill",
  "",
  "Section one.",
  "",
  "---",
  "",
  "Section two, after a horizontal rule.",
  "",
].join("\r\n");

/* ================================================================== *
 * ATTACK 1 — AUTHORING IS REAL & LOSSLESS
 * ================================================================== */

describe("ATTACK 1: SKILL.md authoring is real and lossless", () => {
  it("extracts frontmatter + instructions from the research skill", () => {
    const { manifest, warnings } = parseSkillFile(RESEARCH_SKILL);
    expect(warnings).toEqual([]);
    expect(manifest.name).toBe("research");
    expect(manifest.description).toBe(
      "Investigate a question across sources: gather, reconcile, cite.",
    );
    expect(manifest.capabilities).toEqual(["research", "synthesis", "web"]);
    expect(manifest.tools).toEqual(["extract_emails", "extract_numbers"]);
    expect(manifest.whenToUse).toContain("gathering and reconciling");
    expect(manifest.model).toBe("claude-opus-4");
    expect(manifest.version).toBe("1.2.0");
    // Body is the instructions verbatim (trailing newline preserved).
    expect(manifest.instructions.startsWith("# Research skill")).toBe(true);
    expect(manifest.instructions).toContain("Synthesize a single cited answer.");
  });

  it("parses a block-style list and the calc tool declaration", () => {
    const { manifest } = parseSkillFile(CODE_SKILL);
    expect(manifest.name).toBe("code");
    expect(manifest.capabilities).toEqual(["coding", "math"]);
    expect(manifest.tools).toEqual(["calc"]);
  });

  it("keeps a `---` inside the body and normalizes CRLF", () => {
    const { manifest } = parseSkillFile(WRITER_SKILL_CRLF);
    expect(manifest.name).toBe("writer");
    expect(manifest.tools).toEqual([]);
    // The horizontal-rule `---` must survive as body content, not be treated as
    // a frontmatter delimiter.
    expect(manifest.instructions).toContain("\n---\n");
    expect(manifest.instructions).toContain("Section two, after a horizontal rule.");
    // CRLF must be normalized away — no stray carriage returns leak through.
    expect(manifest.instructions.includes("\r")).toBe(false);
  });

  it("round-trips every authored skill: parse(serialize(parse(x))) deep-equals the manifest", () => {
    for (const doc of [RESEARCH_SKILL, CODE_SKILL, WRITER_SKILL_CRLF]) {
      const m1 = parseSkillFile(doc).manifest;
      const reparsed = parseSkillFile(serializeSkillFile(m1)).manifest;
      expect(reparsed).toEqual(m1);
    }
  });

  it("skillTemplate produces a document that parses to a valid manifest of that name", () => {
    const text = skillTemplate("my-skill");
    const { manifest } = parseSkillFile(text);
    expect(manifest.name).toBe("my-skill");
    expect(validateSkillManifest(manifest).valid).toBe(true);
    // And the template itself round-trips.
    expect(parseSkillFile(serializeSkillFile(manifest)).manifest).toEqual(manifest);
  });
});

/* ================================================================== *
 * ATTACK 2 — DECLARED TOOLS PLUG IN
 * ================================================================== */

describe("ATTACK 2: declared tools bind against builtinRegistry()", () => {
  it("binds calc: the binding is present, works, and becomes promptFragment", () => {
    const { manifest } = parseSkillFile(CODE_SKILL);
    const { skill, missingTools } = toSwarmSkill(manifest, builtinRegistry());

    expect(missingTools).toEqual([]);
    expect(skill.name).toBe("code");
    expect(skill.capabilities).toEqual(["coding", "math"]);
    // The instructions become the promptFragment.
    expect(skill.promptFragment).toBe(manifest.instructions);

    // The bound tool is present and named calc.
    const bound = (skill.tools ?? []) as Array<{ name: string; run?: (i: string) => unknown }>;
    const calc = bound.find((t) => t.name === "calc");
    expect(calc).toBeDefined();
    // It is the real, working Hades calc tool (invoked via its run interface).
    const res = (calc as { run: (i: string) => { ok: boolean; output: string } }).run("6*7");
    expect(res).toEqual({ ok: true, output: "42" });
  });

  it("a declared-but-unknown tool does NOT silently succeed", () => {
    const bad: SkillManifest = {
      name: "broken",
      description: "declares a tool that does not exist",
      capabilities: [],
      tools: ["nonexistent"],
      instructions: "body",
    };
    // Default behaviour: throws a clear error rather than pretending it bound.
    expect(() => toSwarmSkill(bad, builtinRegistry())).toThrowError(/nonexistent/);

    // With allowMissingTools it reports the miss instead of silently succeeding.
    const { skill, missingTools } = toSwarmSkill(bad, builtinRegistry(), {
      allowMissingTools: true,
    });
    expect(missingTools).toEqual(["nonexistent"]);
    expect(skill.tools ?? []).toEqual([]);
  });
});

/* ================================================================== *
 * ATTACK 3 — LIBRARY LOADS A FOLDER
 * ================================================================== */

describe("ATTACK 3: SkillLibrary loads a folder", () => {
  const MALFORMED = "no frontmatter at all — just prose.";

  function folder() {
    return [
      { path: "skills/research.md", content: RESEARCH_SKILL },
      { path: "skills/code.md", content: CODE_SKILL },
      { path: "skills/writer.md", content: WRITER_SKILL_CRLF },
      { path: "skills/broken.md", content: MALFORMED },
    ];
  }

  it("indexes valid skills, collects the malformed one in errors, never throws", () => {
    const lib = new SkillLibrary();
    let report!: ReturnType<SkillLibrary["loadFiles"]>;
    expect(() => {
      report = lib.loadFiles(folder());
    }).not.toThrow();

    expect(report.loaded.map((l) => l.manifest.name).sort()).toEqual([
      "code",
      "research",
      "writer",
    ]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].path).toBe("skills/broken.md");
    expect(report.errors[0].error).toMatch(/frontmatter/i);
    expect(lib.size()).toBe(3);
  });

  it("search and byCapability are case-insensitive", () => {
    const lib = new SkillLibrary();
    lib.loadFiles(folder());

    // search hits name/description/capabilities/whenToUse, ignoring case.
    expect(lib.search("RESEARCH").map((s) => s.manifest.name)).toContain("research");
    expect(lib.search("Arithmetic").map((s) => s.manifest.name)).toContain("code");
    // byCapability, case-insensitive.
    expect(lib.byCapability("MATH").map((s) => s.manifest.name)).toEqual(["code"]);
    expect(lib.byCapability("writing").map((s) => s.manifest.name)).toEqual(["writer"]);
    expect(lib.byCapability("does-not-exist")).toEqual([]);
  });

  it("resolve merges + dedupes capabilities and reports missing tools + unknown names", () => {
    const lib = new SkillLibrary();
    lib.loadFiles(folder());
    // Add a skill that shares a capability with research and needs a missing tool.
    lib.add({
      name: "extra",
      description: "shares the research capability, wants a missing tool",
      capabilities: ["research", "extra-cap"],
      tools: ["ghost_tool"],
      instructions: "extra body",
    });

    const resolved = lib.resolve(["research", "code", "extra", "nope"], builtinRegistry());

    // Two known + extra resolved; "nope" unknown.
    expect(resolved.skills.map((s) => s.name).sort()).toEqual(["code", "extra", "research"]);
    expect(resolved.unknownSkills).toEqual(["nope"]);

    // Capabilities merged and deduped (research appears in two skills, once here).
    expect(resolved.capabilities).toContain("research");
    expect(resolved.capabilities.filter((c) => c === "research")).toHaveLength(1);
    expect(resolved.capabilities).toEqual(
      expect.arrayContaining(["research", "synthesis", "web", "coding", "math", "extra-cap"]),
    );

    // Missing tools surfaced (ghost_tool), real tools (calc, extract_*) not missing.
    expect(resolved.missingTools).toEqual(["ghost_tool"]);
  });

  it("a duplicate-name load keeps the last definition and warns", () => {
    const lib = new SkillLibrary();
    const v1 = `---\nname: dup\ndescription: first version\ncapabilities: []\ntools: []\n---\nfirst`;
    const v2 = `---\nname: dup\ndescription: second version\ncapabilities: []\ntools: []\n---\nsecond`;
    const report = lib.loadFiles([
      { path: "a.md", content: v1 },
      { path: "b.md", content: v2 },
    ]);

    expect(report.loaded).toHaveLength(2);
    expect(lib.size()).toBe(1); // one name, last wins
    expect(lib.get("dup")!.manifest.description).toBe("second version");
    // The surviving entry carries a collision warning.
    const warnings = lib.get("dup")!.warnings.join(" ");
    expect(warnings).toMatch(/collision/i);
  });
});

/* ================================================================== *
 * ATTACK 4 — MCP SERVER INTEROP (real McpClient <-> McpServer)
 * ================================================================== */

describe("ATTACK 4: a real McpClient interoperates with the Hades McpServer", () => {
  function standUp() {
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server, { serverName: "hades" });
    server.registerToolRegistry(builtinRegistry());
    server.serve();
    const client = new McpClient(pair.client);
    return { server, client };
  }

  it("initialize returns the server name", async () => {
    const { client } = standUp();
    const info = await client.initialize();
    expect(info.serverName).toBe("hades");
  });

  it("listTools advertises calc", async () => {
    const { client } = standUp();
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("calc");
  });

  it("callTool('calc', {input:'6*7'}) returns '42' through the full path", async () => {
    const { client } = standUp();
    await client.initialize();
    const result = await client.callTool("calc", { input: "6*7" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("42");
  });

  it("an unknown tool is a tool-level error (isError), not a crash", async () => {
    const { client } = standUp();
    await client.initialize();
    const result = await client.callTool("no_such_tool", { input: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/unknown tool/i);
  });

  it("an unknown method rejects with McpProtocolError (-32601)", async () => {
    const { client } = standUp();
    await client.initialize();
    await expect(client.request("does/not/exist")).rejects.toMatchObject({
      name: "McpProtocolError",
      code: -32601,
    });
    await expect(client.request("does/not/exist")).rejects.toBeInstanceOf(McpProtocolError);
  });
});

/* ================================================================== *
 * ATTACK 5 — END-TO-END COMPOSE (author -> plug in -> serve out)
 * ================================================================== */

describe("ATTACK 5: author -> plug in -> serve out, one flow", () => {
  it("the same calc works as a bound skill tool locally AND via the MCP client", async () => {
    // One registry used for both the local binding and the remote server.
    const registry = builtinRegistry();

    // Author: load the code SKILL.md declaring calc, into a library.
    const lib = new SkillLibrary();
    lib.loadFiles([{ path: "skills/code.md", content: CODE_SKILL }]);

    // Plug in: resolve it to a SwarmSkill with calc bound from the registry.
    const resolved = lib.resolve(["code"], registry);
    expect(resolved.unknownSkills).toEqual([]);
    expect(resolved.missingTools).toEqual([]);
    const skill = resolved.skills[0];
    const boundCalc = (skill.tools ?? []).find((t) => t.name === "calc") as
      | { run: (i: string) => { ok: boolean; output: string } }
      | undefined;
    expect(boundCalc).toBeDefined();

    // Local invocation of the bound skill tool.
    const local = boundCalc!.run("2+3");
    expect(local).toEqual({ ok: true, output: "5" });

    // Serve out: expose the SAME registry over MCP and call it remotely.
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server, { serverName: "hades" });
    server.registerToolRegistry(registry);
    server.serve();
    const client = new McpClient(pair.client);
    await client.initialize();
    const remote = await client.callTool("calc", { input: "2+3" });

    // Same answer, both paths.
    expect(remote.isError).toBeFalsy();
    expect(remote.content[0]?.text).toBe("5");
    expect(remote.content[0]?.text).toBe(local.output);
  });
});

/* ================================================================== *
 * ATTACK 6 — ROBUSTNESS
 * ================================================================== */

describe("ATTACK 6: robustness — degrade gracefully, never crash", () => {
  it("malformed frontmatter throws a clear, catchable error (no crash)", () => {
    expect(() => parseSkillFile("not a skill file")).toThrowError(/frontmatter/i);
    // Unterminated frontmatter (no closing ---).
    expect(() => parseSkillFile("---\nname: x\ndescription: y")).toThrowError(
      /unterminated|closing/i,
    );
  });

  it("missing required fields are rejected by parse and by validate", () => {
    // Missing name.
    expect(() => parseSkillFile("---\ndescription: y\n---\nbody")).toThrowError(/name/i);
    // Missing description.
    expect(() => parseSkillFile("---\nname: x\n---\nbody")).toThrowError(/description/i);
    // validate flags a partial manifest without throwing.
    const v = validateSkillManifest({ name: "", description: "" } as Partial<SkillManifest>);
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("empty tools/capabilities and a huge instructions body parse fine", () => {
    const huge = "x".repeat(200_000);
    const doc = `---\nname: big\ndescription: a large body\ncapabilities: []\ntools: []\n---\n${huge}`;
    const { manifest } = parseSkillFile(doc);
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.tools).toEqual([]);
    expect(manifest.instructions.length).toBe(huge.length);
    expect(validateSkillManifest(manifest).valid).toBe(true);
  });

  it("validate rejects empty/duplicate list entries without throwing", () => {
    const v = validateSkillManifest({
      name: "n",
      description: "d",
      capabilities: ["a", "a"], // duplicate
      tools: ["", "ok"], // empty entry
    } as Partial<SkillManifest>);
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/duplicate/i);
    expect(v.errors.join(" ")).toMatch(/empty|non-string/i);
  });

  it("a tool name with odd characters binds by exact name (no injection surprise)", () => {
    // A registry-like lookup keyed by an odd tool name; toSwarmSkill must bind by
    // exact string, treating the name as data, not code.
    const odd = 'weird/../$name';
    const fakeRegistry = {
      get: (n: string) =>
        n === odd ? { name: odd, description: "", run: () => ({ ok: true, output: "ok" }) } : undefined,
    };
    const m: SkillManifest = {
      name: "odd",
      description: "declares an odd tool name",
      capabilities: [],
      tools: [odd],
      instructions: "b",
    };
    const { skill, missingTools } = toSwarmSkill(m, fakeRegistry);
    expect(missingTools).toEqual([]);
    expect((skill.tools ?? []).map((t) => t.name)).toEqual([odd]);
  });

  it("the MCP server never lets a throwing tool crash the transport", async () => {
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server);
    server.register({
      name: "boom",
      description: "always throws",
      run: () => {
        throw new Error("kaboom");
      },
    });
    server.serve();
    const client = new McpClient(pair.client);
    await client.initialize();

    const result = await client.callTool("boom", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/kaboom/);

    // The transport survives: a subsequent well-formed call still works.
    server.registerToolRegistry(builtinRegistry());
    const ok = await client.callTool("calc", { input: "1+1" });
    expect(ok.content[0]?.text).toBe("2");
  });

  it("malformed tools/call params yield a protocol error, not a hang", async () => {
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server);
    server.registerToolRegistry(builtinRegistry());
    server.serve();
    const client = new McpClient(pair.client);
    await client.initialize();

    // tools/call with a non-string name is invalid params (-32602).
    await expect(
      client.request("tools/call", { name: 123, arguments: {} }),
    ).rejects.toMatchObject({ name: "McpProtocolError", code: -32602 });
  });
});
