/**
 * Central-integration tests: the shipped default catalog, the ToolsetManager
 * the product actually constructs, the CLI wiring, and — the money test —
 * every default tool's GENUINE output passing its own registered STYX
 * verifier (tool <-> verifier contract agreement, exercised end-to-end
 * against real tool runs, not hand-built fixtures).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultToolCatalog,
  defaultToolsetManager,
  DEFAULT_CATALOG_TOOL_IDS,
  DEFAULT_SHELL_ALLOWED_COMMANDS,
} from "../default-catalog";
import { toolVerifiers, calibrationTable } from "../verifiers";
import { runToolchainBench } from "../chain-bench";
import { execEnabledRegistry } from "../../exec/index";
import { HadesCli } from "../../cli/cli";
import { buildHadesCli } from "../../cli/build";
import { loadConfig } from "../../config/config";

function offlineManagerIn(dir?: string) {
  return defaultToolsetManager({
    env: {},
    offline: true,
    fileRoot: dir ?? mkdtempSync(join(tmpdir(), "hades-catalog-")),
    statePath: dir ? join(dir, "state", "tools.json") : undefined,
  });
}

describe("defaultToolCatalog", () => {
  it("contains exactly the nine shipped tools, name-sorted", () => {
    const catalog = defaultToolCatalog({ env: {}, offline: true, fileRoot: tmpdir() });
    expect(catalog.list().map((e) => e.id)).toEqual([...DEFAULT_CATALOG_TOOL_IDS]);
  });

  it("every entry's verifierId is registered in toolVerifiers() AND calibrationTable()", () => {
    const catalog = defaultToolCatalog({ env: {}, offline: true, fileRoot: tmpdir() });
    const verifiers = toolVerifiers();
    const table = calibrationTable();
    for (const entry of catalog.list()) {
      const v = verifiers.get(entry.verifierId);
      expect(v, entry.id).toBeDefined();
      expect(v?.toolName, entry.id).toBe(entry.id);
      expect(table[entry.verifierId], entry.id).toBeDefined();
    }
  });

  it("offline: network tools are honestly mock; file_ops and shell stay real", () => {
    const catalog = defaultToolCatalog({ env: {}, offline: true, fileRoot: tmpdir() });
    const modes = Object.fromEntries(catalog.list().map((e) => [e.id, e.mode]));
    expect(modes).toEqual({
      browser: "mock",
      fetch_extract: "mock",
      file_ops: "real",
      http_request: "mock",
      image_gen: "mock",
      shell: "real",
      tts: "mock",
      vision_describe: "mock",
      web_search: "mock",
    });
  });

  it("with a transport + keys, key-gated tools flip to real (mode matrix through the central assembly)", () => {
    const fakeFetch = async () => ({ status: 200, headers: {}, text: async () => "{}" });
    const catalog = defaultToolCatalog({
      env: {
        BRAVE_SEARCH_API_KEY: "k",
        OPENAI_API_KEY: "k",
        ELEVENLABS_API_KEY: "k",
        ANTHROPIC_API_KEY: "k",
      },
      fetchFn: fakeFetch,
      fileRoot: tmpdir(),
      // browser's gate is an on-disk Chromium, not an env key; force the
      // probe true here so this mode-matrix test is deterministic on any
      // machine (the REAL probe + REAL browse are exercised end-to-end in
      // src/hades/browser/__tests__/integration.test.ts).
      probeChromium: () => true,
    });
    for (const entry of catalog.list()) {
      expect(entry.mode, entry.id).toBe("real");
    }
  });

  it("the default shell allowlist contains no interpreters or mutating commands", () => {
    for (const banned of ["node", "python3", "sh", "bash", "rm", "mv", "chmod", "curl", "wget"]) {
      expect(DEFAULT_SHELL_ALLOWED_COMMANDS).not.toContain(banned);
    }
  });
});

describe("tool <-> verifier contract agreement (genuine runs, no fixtures)", () => {
  it("every offline tool's real output passes its own registered verifier", async () => {
    const root = mkdtempSync(join(tmpdir(), "hades-verify-"));
    const catalog = defaultToolCatalog({ env: {}, offline: true, fileRoot: root });
    const verifiers = toolVerifiers();

    const inputs: Record<string, string[]> = {
      browser: [JSON.stringify({ op: "browse", url: "https://example.com/docs" })],
      web_search: ["styx verification"],
      fetch_extract: ["https://example.com/docs"],
      http_request: [JSON.stringify({ method: "GET", url: "https://example.com" })],
      image_gen: ["a swirling deterministic pattern"],
      tts: ["hello hades"],
      vision_describe: [Buffer.alloc(64, 0x07).toString("base64")],
      file_ops: [
        JSON.stringify({ op: "write", path: "notes/a.txt", content: "hello" }),
        JSON.stringify({ op: "read", path: "notes/a.txt" }),
      ],
      shell: [JSON.stringify({ cmd: "echo", args: ["catalog-integration"] })],
    };

    for (const entry of catalog.list()) {
      const verifier = verifiers.get(entry.verifierId);
      expect(verifier, entry.id).toBeDefined();
      for (const input of inputs[entry.id]) {
        const result = await entry.tool.run(input);
        expect(result.ok, `${entry.id} run(${input})`).toBe(true);
        const verdict = verifier!.verify(input, result);
        expect(verdict.reasons, `${entry.id} verifier reasons`).toEqual([]);
        expect(verdict.passed, `${entry.id} verifier verdict`).toBe(true);
        expect(verdict.confidence).toBeGreaterThan(0);
      }
    }
  });
});

describe("defaultToolsetManager persistence + registry assembly", () => {
  it("enable/disable state survives a fresh manager over the same state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-toolset-"));
    const m1 = offlineManagerIn(dir);
    expect(m1.isEnabled("web_search")).toBe(true);
    expect(m1.disable("web_search")).toBe(true);
    expect(m1.getLastSaveError()).toBeUndefined();
    // Real file on disk, real JSON.
    const persisted = JSON.parse(readFileSync(join(dir, "state", "tools.json"), "utf8"));
    expect(persisted.web_search).toBe(false);

    const m2 = offlineManagerIn(dir);
    expect(m2.isEnabled("web_search")).toBe(false);
    expect(m2.isEnabled("tts")).toBe(true);
  });

  it("buildRegistry layers enabled catalog tools over the 8 builtins with no collisions", () => {
    const manager = offlineManagerIn();
    manager.disable("tts");
    const registry = manager.buildRegistry();
    const names = registry.names();
    expect(names).toContain("calc"); // builtin survives
    expect(names).toContain("web_search");
    expect(names).not.toContain("tts");
    expect(names.length).toBe(8 + DEFAULT_CATALOG_TOOL_IDS.length - 1);
  });
});

describe("Phase 2 checkpoint through the PRODUCT wiring (not a fixture registry)", () => {
  it("runToolchainBench passes over execEnabledRegistry(defaultToolsetManager().buildRegistry())", async () => {
    const manager = offlineManagerIn();
    const registry = execEnabledRegistry(manager.buildRegistry());
    const bench = await runToolchainBench(registry);
    expect(bench.programTurns).toBe(1);
    expect(bench.toolCallCount).toBeGreaterThanOrEqual(3);
    expect(bench.steps.length).toBeGreaterThanOrEqual(3);
    for (const step of bench.steps) expect(step.outputBytes).toBeGreaterThan(0);
    expect(bench.allVerified).toBe(true);
    expect(bench.ensembleScore).toBeGreaterThan(0.5);
  }, 30_000);
});

describe("CLI wiring: hades tools + hades exec over the toolset", () => {
  it("routes `hades tools` list/disable/info through an injected manager", async () => {
    const cli = new HadesCli({ toolset: offlineManagerIn() });
    const list = await cli.run(["tools", "list"]);
    expect(list.code).toBe(0);
    expect(list.lines.join("\n")).toContain("web_search");

    const disable = await cli.run(["tools", "disable", "web_search"]);
    expect(disable.code).toBe(0);

    const json = await cli.run(["tools", "list", "--json"]);
    const status = JSON.parse(json.lines.join("\n")) as Array<{ id: string; enabled: boolean }>;
    expect(status.find((s) => s.id === "web_search")?.enabled).toBe(false);

    const info = await cli.run(["tools", "info", "shell"]);
    expect(info.code).toBe(0);
    expect(info.lines.join("\n")).toContain("verify.shell");
  });

  it("`hades tools` without a configured toolset fails cleanly", async () => {
    const cli = new HadesCli({});
    const res = await cli.run(["tools", "list"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("not configured");
  });

  it("help advertises the tools subcommand", async () => {
    const help = await new HadesCli({}).run(["help"]);
    expect(help.lines.join("\n")).toContain("tools <sub>");
  });

  it("`hades exec run` can call a catalog tool through the toolset-built registry", async () => {
    const cli = new HadesCli({ toolset: offlineManagerIn() });
    const res = await cli.run([
      "exec",
      "run",
      'const r = await tools.call("web_search", "hades"); return JSON.parse(r.output).mode;',
    ]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("result:      mock");
    expect(text).toContain("rpc calls:   1");
  }, 30_000);

  it("buildHadesCli wires the toolset by default (persist off => in-memory state)", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });
    const res = await cli.run(["tools", "list"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("fetch_extract");
  });
});
