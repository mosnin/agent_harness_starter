/**
 * Real behavioral tests for the tool catalog: registration validation,
 * name-sorted listing, category filtering, and hostile-id rejection.
 * Nothing here is mocked — `ToolCatalog` and `isValidToolId` run for real.
 */
import { describe, it, expect } from "vitest";
import { ToolCatalog, isValidToolId, type CatalogEntry } from "../catalog";
import type { Tool, ToolResult } from "../../agent/tools";

function makeTool(name: string, description = `${name} tool`): Tool {
  return {
    name,
    description,
    run: (input: string): ToolResult => ({ ok: true, output: input }),
  };
}

function entry(id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    tool: overrides.tool ?? makeTool(id),
    category: overrides.category ?? "data",
    mode: overrides.mode ?? "real",
    requiresNetwork: overrides.requiresNetwork ?? false,
    requiredEnvKeys: overrides.requiredEnvKeys ?? [],
    verifierId: overrides.verifierId ?? "default-verifier",
  };
}

describe("isValidToolId", () => {
  it("accepts simple alphanumeric ids and ids with . _ -", () => {
    expect(isValidToolId("weather")).toBe(true);
    expect(isValidToolId("http_get")).toBe(true);
    expect(isValidToolId("http-get")).toBe(true);
    expect(isValidToolId("v2.tool")).toBe(true);
    expect(isValidToolId("a")).toBe(true);
  });

  it("rejects empty and absurdly long ids", () => {
    expect(isValidToolId("")).toBe(false);
    expect(isValidToolId("x".repeat(129))).toBe(false);
    expect(isValidToolId("x".repeat(500))).toBe(false);
    expect(isValidToolId("x".repeat(128))).toBe(true);
  });

  it("rejects path separators", () => {
    expect(isValidToolId("../etc/passwd")).toBe(false);
    expect(isValidToolId("a/b")).toBe(false);
    expect(isValidToolId("a\\b")).toBe(false);
    expect(isValidToolId("/root")).toBe(false);
  });

  it("rejects unicode and whitespace", () => {
    expect(isValidToolId("tool™")).toBe(false);
    expect(isValidToolId("😀tool")).toBe(false);
    expect(isValidToolId("tool name")).toBe(false);
    expect(isValidToolId(" tool")).toBe(false);
    expect(isValidToolId("tool\n")).toBe(false);
  });

  it("rejects ids that start with punctuation", () => {
    expect(isValidToolId(".hidden")).toBe(false);
    expect(isValidToolId("-flag")).toBe(false);
    expect(isValidToolId("_private")).toBe(false);
  });
});

describe("ToolCatalog.add", () => {
  it("registers a valid entry and makes it retrievable by id", () => {
    const catalog = new ToolCatalog();
    const e = entry("weather");
    catalog.add(e);
    expect(catalog.get("weather")).toBe(e);
  });

  it("throws on duplicate id", () => {
    const catalog = new ToolCatalog();
    catalog.add(entry("weather"));
    expect(() => catalog.add(entry("weather"))).toThrow(/duplicate/i);
  });

  it("throws when entry.id does not match tool.name", () => {
    const catalog = new ToolCatalog();
    const mismatched = entry("weather", { tool: makeTool("forecast") });
    expect(() => catalog.add(mismatched)).toThrow(/does not match/i);
  });

  it("throws on hostile ids: path separators", () => {
    const catalog = new ToolCatalog();
    expect(() => catalog.add(entry("../escape", { tool: makeTool("../escape") }))).toThrow(
      /invalid tool id/i
    );
  });

  it("throws on hostile ids: unicode", () => {
    const catalog = new ToolCatalog();
    expect(() => catalog.add(entry("tool™", { tool: makeTool("tool™") }))).toThrow(
      /invalid tool id/i
    );
  });

  it("throws on hostile ids: 500-char name", () => {
    const catalog = new ToolCatalog();
    const longId = "a".repeat(500);
    expect(() => catalog.add(entry(longId, { tool: makeTool(longId) }))).toThrow(
      /invalid tool id/i
    );
  });

  it("throws on empty id", () => {
    const catalog = new ToolCatalog();
    expect(() => catalog.add(entry("", { tool: makeTool("") }))).toThrow(/invalid tool id/i);
  });

  it("does not mutate catalog state when add throws (duplicate stays the original)", () => {
    const catalog = new ToolCatalog();
    const original = entry("weather", { mode: "real" });
    catalog.add(original);
    const impostor = entry("weather", { mode: "mock" });
    expect(() => catalog.add(impostor)).toThrow();
    expect(catalog.get("weather")).toBe(original);
    expect(catalog.get("weather")?.mode).toBe("real");
  });
});

describe("ToolCatalog.list", () => {
  it("returns entries sorted by name regardless of insertion order", () => {
    const catalog = new ToolCatalog();
    catalog.add(entry("zeta"));
    catalog.add(entry("alpha"));
    catalog.add(entry("mid"));
    expect(catalog.list().map((e) => e.id)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("returns an empty array for an empty catalog", () => {
    const catalog = new ToolCatalog();
    expect(catalog.list()).toEqual([]);
  });

  it("returned array is a fresh copy each call (safe to mutate)", () => {
    const catalog = new ToolCatalog();
    catalog.add(entry("a"));
    const first = catalog.list();
    first.push(entry("b"));
    expect(catalog.list()).toHaveLength(1);
  });
});

describe("ToolCatalog.byCategory", () => {
  it("filters to only the requested category, sorted by name", () => {
    const catalog = new ToolCatalog();
    catalog.add(entry("web_b", { category: "web" }));
    catalog.add(entry("data_a", { category: "data" }));
    catalog.add(entry("web_a", { category: "web" }));
    catalog.add(entry("sys_a", { category: "system" }));

    expect(catalog.byCategory("web").map((e) => e.id)).toEqual(["web_a", "web_b"]);
    expect(catalog.byCategory("data").map((e) => e.id)).toEqual(["data_a"]);
    expect(catalog.byCategory("system").map((e) => e.id)).toEqual(["sys_a"]);
    expect(catalog.byCategory("media")).toEqual([]);
  });
});

describe("ToolCatalog.get", () => {
  it("returns undefined for an id never registered", () => {
    const catalog = new ToolCatalog();
    expect(catalog.get("nope")).toBeUndefined();
  });
});
