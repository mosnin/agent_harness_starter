/**
 * Real behavioral tests for `hades tools` — every subcommand, both exit
 * code paths, the `--json` shape, and column alignment across very
 * different name lengths. `runToolsCommand` is exercised directly
 * against a real `ToolsetManager` over a real `ToolCatalog`; nothing
 * here is mocked.
 */
import { describe, it, expect } from "vitest";
import { runToolsCommand } from "../cli/tools-command";
import { ToolCatalog, type CatalogEntry } from "../tools/catalog";
import { ToolsetManager, InMemoryToolStateStore } from "../tools/manager";
import type { Tool, ToolResult } from "../agent/tools";

function makeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    run: (input: string): ToolResult => ({ ok: true, output: input }),
  };
}

function entry(id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    tool: overrides.tool ?? makeTool(id, `${id} description`),
    category: overrides.category ?? "data",
    mode: overrides.mode ?? "real",
    requiresNetwork: overrides.requiresNetwork ?? false,
    requiredEnvKeys: overrides.requiredEnvKeys ?? [],
    verifierId: overrides.verifierId ?? "default-verifier",
  };
}

function setup() {
  const catalog = new ToolCatalog();
  catalog.add(entry("x", { category: "web", mode: "mock", requiresNetwork: true, requiredEnvKeys: ["X_API_KEY"], verifierId: "web-verifier" }));
  catalog.add(
    entry("a_very_long_tool_name_indeed", {
      category: "system",
      mode: "real",
      verifierId: "sys-verifier",
    })
  );
  const manager = new ToolsetManager(catalog, new InMemoryToolStateStore());
  return { catalog, manager };
}

describe("hades tools list", () => {
  it("defaults to the list subcommand with no args", () => {
    const { manager } = setup();
    const res = runToolsCommand([], { manager });
    expect(res.code).toBe(0);
    expect(res.lines.length).toBeGreaterThan(1);
  });

  it("lists every catalog entry with header and enabled/disabled + real/mock markers", () => {
    const { manager } = setup();
    manager.disable("x");
    const res = runToolsCommand(["list"], { manager });
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("NAME");
    expect(text).toContain("CATEGORY");
    expect(text).toMatch(/x\s+web\s+mock\s+disabled/);
    expect(text).toMatch(/a_very_long_tool_name_indeed\s+system\s+real\s+enabled/);
  });

  it("shows a keys-needed marker for entries with requiredEnvKeys, and '-' otherwise", () => {
    const { manager } = setup();
    const res = runToolsCommand(["list"], { manager });
    const text = res.lines.join("\n");
    expect(text).toContain("needs: X_API_KEY");
    // the system tool has no required keys
    const sysLine = res.lines.find((l) => l.includes("a_very_long_tool_name_indeed"))!;
    expect(sysLine.trim().endsWith("-")).toBe(true);
  });

  it("column alignment: every data row and the header share consistent column start offsets", () => {
    const { manager } = setup();
    const res = runToolsCommand(["list"], { manager });
    // Every non-empty line should start the CATEGORY column at the same
    // character offset since padding is computed from the widest cell.
    const rows = res.lines.filter((l) => l.length > 0);
    expect(rows.length).toBe(3); // header + 2 tools
    const nameColWidth = "a_very_long_tool_name_indeed".length;
    for (const row of rows) {
      // category token starts right after the padded name column + separator
      const afterName = row.slice(nameColWidth);
      expect(afterName.startsWith("  ")).toBe(true);
    }
  });

  it("empty catalog produces a friendly message, not a blank table", () => {
    const catalog = new ToolCatalog();
    const manager = new ToolsetManager(catalog);
    const res = runToolsCommand(["list"], { manager });
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toMatch(/no tools/i);
  });

  it("list --json emits valid JSON matching ToolsetManager.status() shape", () => {
    const { manager } = setup();
    manager.disable("x");
    const res = runToolsCommand(["list", "--json"], { manager });
    expect(res.code).toBe(0);
    expect(res.lines).toHaveLength(1);
    const parsed = JSON.parse(res.lines[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    const x = parsed.find((s: { id: string }) => s.id === "x");
    expect(x).toMatchObject({
      id: "x",
      category: "web",
      mode: "mock",
      enabled: false,
      requiresNetwork: true,
      requiredEnvKeys: ["X_API_KEY"],
      verifierId: "web-verifier",
    });
    expect(typeof x.description).toBe("string");
  });

  it("list --json output is identical in shape to manager.status() directly", () => {
    const { manager } = setup();
    const res = runToolsCommand(["list", "--json"], { manager });
    const parsed = JSON.parse(res.lines[0]);
    expect(parsed).toEqual(manager.status());
  });
});

describe("hades tools enable / disable", () => {
  it("enable <name> succeeds and persists through the manager", () => {
    const { manager } = setup();
    manager.disable("x");
    const res = runToolsCommand(["enable", "x"], { manager });
    expect(res.code).toBe(0);
    expect(res.lines.join(" ")).toMatch(/enabled/i);
    expect(manager.isEnabled("x")).toBe(true);
  });

  it("disable <name> succeeds and persists through the manager", () => {
    const { manager } = setup();
    const res = runToolsCommand(["disable", "x"], { manager });
    expect(res.code).toBe(0);
    expect(res.lines.join(" ")).toMatch(/disabled/i);
    expect(manager.isEnabled("x")).toBe(false);
  });

  it("enable with no name argument returns code 1 with usage", () => {
    const { manager } = setup();
    const res = runToolsCommand(["enable"], { manager });
    expect(res.code).toBe(1);
    expect(res.lines.join(" ")).toMatch(/usage/i);
  });

  it("disable with no name argument returns code 1 with usage", () => {
    const { manager } = setup();
    const res = runToolsCommand(["disable"], { manager });
    expect(res.code).toBe(1);
    expect(res.lines.join(" ")).toMatch(/usage/i);
  });

  it("enable of an unknown tool name returns code 1 with a helpful message", () => {
    const { manager } = setup();
    const res = runToolsCommand(["enable", "does_not_exist"], { manager });
    expect(res.code).toBe(1);
    expect(res.lines.join(" ")).toMatch(/unknown tool/i);
  });

  it("disable of an unknown tool name returns code 1 with a helpful message", () => {
    const { manager } = setup();
    const res = runToolsCommand(["disable", "does_not_exist"], { manager });
    expect(res.code).toBe(1);
    expect(res.lines.join(" ")).toMatch(/unknown tool/i);
  });
});

describe("hades tools info", () => {
  it("info <name> shows full metadata including verifierId and required env keys", () => {
    const { manager } = setup();
    const res = runToolsCommand(["info", "x"], { manager });
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("name:            x");
    expect(text).toContain("category:        web");
    expect(text).toContain("mode:            mock");
    expect(text).toContain("verifierId:      web-verifier");
    expect(text).toContain("requiredEnvKeys: X_API_KEY");
    expect(text).toContain("requiresNetwork: true");
  });

  it("info shows '(none)' for a tool with no required env keys", () => {
    const { manager } = setup();
    const res = runToolsCommand(["info", "a_very_long_tool_name_indeed"], { manager });
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("requiredEnvKeys: (none)");
  });

  it("info with no name argument returns code 1", () => {
    const { manager } = setup();
    const res = runToolsCommand(["info"], { manager });
    expect(res.code).toBe(1);
  });

  it("info of an unknown tool name returns code 1 with a helpful message", () => {
    const { manager } = setup();
    const res = runToolsCommand(["info", "ghost"], { manager });
    expect(res.code).toBe(1);
    expect(res.lines.join(" ")).toMatch(/unknown tool/i);
  });
});

describe("hades tools help / unknown subcommand", () => {
  it("help returns usage with code 0", () => {
    const { manager } = setup();
    const res = runToolsCommand(["help"], { manager });
    expect(res.code).toBe(0);
    expect(res.lines.join(" ")).toMatch(/usage/i);
  });

  it("unknown subcommand returns code 1 with a helpful message", () => {
    const { manager } = setup();
    const res = runToolsCommand(["frobnicate"], { manager });
    expect(res.code).toBe(1);
    expect(res.lines.join(" ")).toMatch(/unknown tools command/i);
  });
});
