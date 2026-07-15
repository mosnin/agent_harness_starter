import { describe, it, expect } from "vitest";
import { buildHadesCli, HADES_VERSION } from "../cli/build";
import { loadConfig } from "../config/config";
import { main } from "../bin/hades";

describe("buildHadesCli", () => {
  it("wires a working CLI from config (in-memory for tests)", async () => {
    const config = loadConfig({ overrides: { model: "claude-opus-4-8" } });
    const cli = buildHadesCli(config, { persist: false });

    const version = await cli.run(["version"]);
    expect(version.lines[0]).toBe(`hades ${HADES_VERSION}`);

    // Default model reflects config.
    const current = await cli.run(["model", "current"]);
    expect(current.lines.join("\n")).toContain("claude-opus-4-8");

    // Built-in catalogs are present.
    expect((await cli.run(["plugins"])).lines.join("\n")).toContain("kanban");
    expect((await cli.run(["skills", "packs"])).lines.join("\n")).toContain("research");
  });

  it("memory round-trips through the built CLI", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });
    await cli.run(["memory", "add", "ship on Fridays"]);
    const search = await cli.run(["memory", "search", "ship"]);
    expect(search.lines.join("\n")).toContain("ship on Fridays");
  });
});

describe("hades bin main()", () => {
  it("runs a subcommand and returns its exit code", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await main(["version"]);
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("hades");
    } finally {
      console.log = orig;
    }
  });

  it("returns a nonzero code for unknown commands", async () => {
    const orig = console.log;
    console.log = () => {};
    try {
      expect(await main(["frobnicate"])).toBe(1);
    } finally {
      console.log = orig;
    }
  });
});
