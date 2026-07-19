import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildHadesCli, HADES_VERSION } from "../cli/build";
import { loadConfig } from "../config/config";
import { main } from "../bin/hades";

describe("buildHadesCli", () => {
  it("wires a working CLI from config (in-memory for tests)", async () => {
    const config = loadConfig({ overrides: { model: "claude-opus-4-1" } });
    const cli = buildHadesCli(config, { persist: false });

    const version = await cli.run(["version"]);
    expect(version.lines[0]).toBe(`hades ${HADES_VERSION}`);

    // Default model reflects config.
    const current = await cli.run(["model", "current"]);
    expect(current.lines.join("\n")).toContain("claude-opus-4-1");

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

  it("wires the STYX write-guard: contradicting adds are quarantined, flagged, resolvable", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });
    await cli.run(["memory", "add", "the default region is eu-west"]);
    const add = await cli.run(["memory", "add", "the default region is us-east"]);
    expect(add.code).toBe(1);
    expect(add.lines[0]).toContain("Quarantined");

    const flags = await cli.run(["memory", "flags", "--json"]);
    const parsed = JSON.parse(flags.lines.join("\n")) as Array<{ id: string; fact: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].fact).toBe("the default region is us-east");

    const resolve = await cli.run(["memory", "flags", "resolve", parsed[0].id, "supersede"]);
    expect(resolve.code).toBe(0);
    const search = await cli.run(["memory", "search", "default region"]);
    const out = search.lines.join("\n");
    expect(out).toContain("us-east");
    expect(out).not.toContain("eu-west");
  });

  it("quarantine flags persist across separately-built CLIs (fresh-process simulation)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hades-build-"));
    try {
      const config = loadConfig({ overrides: { dataDir } });

      const cli1 = buildHadesCli(config);
      await cli1.run(["memory", "add", "the default branch is main"]);
      const add = await cli1.run(["memory", "add", "the default branch is trunk"]);
      expect(add.code).toBe(1);
      expect(add.lines[0]).toContain("Quarantined");

      // A second build from the same config simulates a fresh `hades` process.
      const cli2 = buildHadesCli(config);
      const listed = await cli2.run(["memory", "flags", "--json"]);
      const flags = JSON.parse(listed.lines.join("\n")) as Array<{ id: string; fact: string; resolution: string | null }>;
      expect(flags).toHaveLength(1);
      expect(flags[0].fact).toBe("the default branch is trunk");
      expect(flags[0].resolution).toBeNull();

      const resolved = await cli2.run(["memory", "flags", "resolve", flags[0].id, "accept-new"]);
      expect(resolved.code).toBe(0);

      // A third process sees the resolution AND the durably-accepted fact.
      const cli3 = buildHadesCli(config);
      const after = JSON.parse((await cli3.run(["memory", "flags", "--json"])).lines.join("\n")) as Array<{ resolution: string | null }>;
      expect(after[0].resolution).toBe("accept-new");
      const search = await cli3.run(["memory", "search", "default branch"]);
      expect(search.lines.join("\n")).toContain("trunk");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("wires session summarize honestly in extractive mode (no LLM configured)", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });
    // No sessions recorded in a fresh build — the command is reachable and honest.
    const missing = await cli.run(["memory", "summarize", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.lines[0]).toBe("No such session: nope");
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
