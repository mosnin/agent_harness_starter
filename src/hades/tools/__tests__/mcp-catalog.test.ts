/**
 * Inherited MCP tools as first-class catalog entries.
 *
 * The claim under test is the strategic one from `.plans/HADES_BEYOND_HERMES.md`
 * Phase 1: a tool from a foreign MCP server should be indistinguishable from a
 * builtin AT THE CALL SITE — same catalog, same enable/disable, same
 * `Tool.run(input)`, same STYX provenance — while remaining perfectly
 * distinguishable AT THE TRUST SITE (`source`, and a verifier id that says
 * out loud that nothing here is verified).
 *
 * Every call in the end-to-end sections spawns the real
 * `scripts/mcp-echo-server.mjs` and asserts on ITS answers. Where a test needs
 * an unreachable server it uses a genuinely nonexistent command, so the honest
 * error is produced by the real failure path rather than by a stub.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryMcpMountStore,
  JsonFileMcpMountStore,
  MCP_UNVERIFIED_VERIFIER_ID,
  describeInputSchema,
  isValidMcpServerName,
  mcpCatalogEntries,
  mcpToolId,
  parseMcpToolInput,
  planMcpEntries,
  validateMountRecord,
  type McpMountRecord,
} from "../mcp-catalog";
import { mcpSwarmTools } from "../mcp-swarm-tools";
import { ToolBox, ToolRunner } from "../../../swarm-runtime/worker/toolbox";
import { defaultToolCatalog, defaultToolsetManager, DEFAULT_CATALOG_TOOL_IDS } from "../default-catalog";
import { toolVerifiers } from "../verifiers";
import { execEnabledRegistry } from "../../exec/index";
import { runExecCommand } from "../../cli/exec-command";
import type { McpStdioServerSpec } from "../../mcp/mount";

const ECHO_SERVER = fileURLToPath(new URL("../../../../scripts/mcp-echo-server.mjs", import.meta.url));

function echoSpec(name = "echo", extraArgs: string[] = []): McpStdioServerSpec {
  return { name, transport: "stdio", command: process.execPath, args: [ECHO_SERVER, ...extraArgs] };
}

/** A mount record matching what `hades tools mcp add` persists for the echo server. */
function echoRecord(name = "echo", extraArgs: string[] = []): McpMountRecord {
  return {
    spec: echoSpec(name, extraArgs),
    mountedAt: 1_700_000_000_000,
    server: { name: "hades-echo-mcp", version: "0.1.0" },
    tools: [
      {
        name: "echo",
        description: "Return the given text verbatim.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      {
        name: "sum",
        description: "Add two numbers and return the total.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
      {
        name: "upper",
        description: "Uppercase the given text.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Ids: a foreign server can never shadow a builtin
 * ------------------------------------------------------------------ */

describe("mcpToolId namespacing", () => {
  it("namespaces every mounted tool under mcp.<server>.<tool>", () => {
    expect(mcpToolId("github", "create_issue")).toBe("mcp.github.create_issue");
  });

  it("a server cannot claim a builtin id, whatever it calls its tool", () => {
    for (const builtin of DEFAULT_CATALOG_TOOL_IDS) {
      expect(mcpToolId("evil", builtin)).toBe(`mcp.evil.${builtin}`);
      expect(mcpToolId("evil", builtin)).not.toBe(builtin);
    }
  });

  it("sanitizes characters the catalog id charset forbids", () => {
    expect(mcpToolId("srv", "weird name/with:stuff")).toBe("mcp.srv.weird_name_with_stuff");
  });

  it("refuses names that cannot be represented at all", () => {
    expect(mcpToolId("srv", "")).toBeUndefined();
    expect(mcpToolId("srv", "///")).toBeUndefined();
    expect(mcpToolId("bad server", "x")).toBeUndefined();
    expect(mcpToolId("srv", "x".repeat(300))).toBeUndefined();
  });

  it("server names are validated conservatively (no dots, which the namespace uses)", () => {
    expect(isValidMcpServerName("github")).toBe(true);
    expect(isValidMcpServerName("my-server_2")).toBe(true);
    expect(isValidMcpServerName("has.dot")).toBe(false);
    expect(isValidMcpServerName("-leading")).toBe(false);
    expect(isValidMcpServerName("")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Entry metadata: honest by construction
 * ------------------------------------------------------------------ */

describe("planMcpEntries", () => {
  it("marks every inherited tool real, sourced, and explicitly unverified", () => {
    const { entries, skipped } = planMcpEntries(echoRecord());
    expect(skipped).toEqual([]);
    expect(entries.map((e) => e.id)).toEqual(["mcp.echo.echo", "mcp.echo.sum", "mcp.echo.upper"]);
    for (const entry of entries) {
      // No mock mode exists for someone else's tool: it dispatches for real or
      // it reports an error. There is no third option to hide in.
      expect(entry.mode).toBe("real");
      expect(entry.source).toBe("mcp:echo");
      expect(entry.verifierId).toBe(MCP_UNVERIFIED_VERIFIER_ID);
      expect(entry.requiresNetwork).toBe(false); // stdio: a local subprocess
      expect(entry.tool.name).toBe(entry.id);
      expect(entry.tool.description).toContain("[mcp:echo]");
    }
  });

  it("the unverified sentinel is deliberately NOT a registered STYX verifier", () => {
    // If this ever starts resolving, someone has quietly attached a calibrated
    // verifier to arbitrary third-party output — which is exactly the kind of
    // borrowed number this codebase forbids.
    expect(toolVerifiers().get(MCP_UNVERIFIED_VERIFIER_ID)).toBeUndefined();
  });

  it("an http mount declares its network use and its env requirements BY NAME", () => {
    const record: McpMountRecord = {
      spec: {
        name: "hosted",
        transport: "http",
        url: "https://example.invalid/mcp",
        headerEnv: { Authorization: "ACME_TOKEN" },
        requiresEnv: ["ACME_REGION"],
      },
      mountedAt: 1,
      tools: [{ name: "search", description: "Search." }],
    };
    const [entry] = planMcpEntries(record).entries;
    expect(entry.requiresNetwork).toBe(true);
    expect(entry.requiredEnvKeys).toEqual(["ACME_REGION", "ACME_TOKEN"]);
    // Names only — a value must never reach an entry's metadata.
    expect(JSON.stringify(entry.requiredEnvKeys)).not.toContain("https://");
  });

  it("skips (and reports) a tool whose sanitized name would steal another's id", () => {
    const record: McpMountRecord = {
      spec: echoSpec("srv"),
      mountedAt: 1,
      tools: [{ name: "a b" }, { name: "a/b" }],
    };
    const { entries, skipped } = planMcpEntries(record);
    expect(entries.map((e) => e.id)).toEqual(["mcp.srv.a_b"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].name).toBe("a/b");
    expect(skipped[0].reason).toContain("already-claimed");
  });

  it("skips (and reports) a tool with an unrepresentable name", () => {
    const record: McpMountRecord = { spec: echoSpec("srv"), mountedAt: 1, tools: [{ name: "///" }] };
    const { entries, skipped } = planMcpEntries(record);
    expect(entries).toEqual([]);
    expect(skipped[0].reason).toContain("cannot be represented");
  });
});

/* ------------------------------------------------------------------ *
 * Input mapping: convenient, but never invisible
 * ------------------------------------------------------------------ */

describe("parseMcpToolInput", () => {
  const oneString = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
  const twoArgs = {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  };

  it("empty input means no arguments", () => {
    expect(parseMcpToolInput("", oneString)).toEqual({ ok: true, args: {}, shape: "empty" });
  });

  it("a JSON object is passed through as the arguments", () => {
    expect(parseMcpToolInput('{"text":"hi"}', oneString)).toEqual({
      ok: true,
      args: { text: "hi" },
      shape: "json",
    });
  });

  it("bare text is wrapped ONLY for a single required string arg — and the shape says so", () => {
    const parsed = parseMcpToolInput("hello there", oneString);
    expect(parsed).toEqual({ ok: true, args: { text: "hello there" }, shape: "wrapped:text" });
  });

  it("bare text for a multi-argument tool is an error, not a guess", () => {
    const parsed = parseMcpToolInput("19 and 23", twoArgs);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("a: number");
    expect(parsed.error).toContain("b: number");
  });

  it("malformed JSON is reported with the expected shape", () => {
    const parsed = parseMcpToolInput('{"text":', oneString);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("not valid JSON");
  });

  it("describeInputSchema marks optional properties", () => {
    expect(
      describeInputSchema({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a"],
      })
    ).toBe("{ a: string, b?: number }");
  });
});

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

describe("mount persistence", () => {
  it("round-trips through the JSON file store", () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-mcp-store-"));
    const path = join(dir, "nested", "mcp-servers.json");
    const store = new JsonFileMcpMountStore(path);
    expect(store.load()).toEqual([]);

    store.save([echoRecord()]);
    expect(new JsonFileMcpMountStore(path).load()).toEqual([echoRecord()]);

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { version: number; servers: unknown[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.servers).toHaveLength(1);
  });

  it("a corrupt or truncated mount file degrades to no mounts, never a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-mcp-store-"));
    const path = join(dir, "mcp-servers.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '{"version":1,"servers":[{"spec":{"name":"half"', "utf8");
    expect(new JsonFileMcpMountStore(path).load()).toEqual([]);
  });

  it("drops individual records this build could not reconnect to, keeping the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-mcp-store-"));
    const path = join(dir, "mcp-servers.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        servers: [
          { spec: { name: "future", transport: "carrier-pigeon" }, tools: [] },
          { spec: { name: "bad name", transport: "stdio", command: "x" }, tools: [] },
          echoRecord(),
        ],
      }),
      "utf8"
    );
    const loaded = new JsonFileMcpMountStore(path).load();
    expect(loaded.map((r) => r.spec.name)).toEqual(["echo"]);
  });

  it("validateMountRecord rejects a spec with no way to connect", () => {
    expect(validateMountRecord({ spec: { name: "x", transport: "stdio" }, tools: [] })).toBeUndefined();
    expect(validateMountRecord({ spec: { name: "x", transport: "http" }, tools: [] })).toBeUndefined();
    expect(validateMountRecord(null)).toBeUndefined();
  });

  it("the in-memory store hands out copies, so callers cannot mutate it by reference", () => {
    const store = new InMemoryMcpMountStore([echoRecord()]);
    const loaded = store.load();
    loaded[0].spec.name = "hijacked";
    expect(store.load()[0].spec.name).toBe("echo");
  });
});

/* ------------------------------------------------------------------ *
 * The catalog: mounted tools standing next to the builtins
 * ------------------------------------------------------------------ */

describe("defaultToolCatalog with MCP mounts", () => {
  it("adds mounted tools alongside the shipped nine, without disturbing them", () => {
    const catalog = defaultToolCatalog({
      env: {},
      offline: true,
      fileRoot: tmpdir(),
      mcpServers: [echoRecord()],
    });
    expect(catalog.list().map((e) => e.id)).toEqual([
      ...DEFAULT_CATALOG_TOOL_IDS,
      "mcp.echo.echo",
      "mcp.echo.sum",
      "mcp.echo.upper",
    ].sort());
  });

  it("building the catalog spawns nothing — an unreachable server is not even contacted", () => {
    const record: McpMountRecord = {
      spec: { name: "ghost", transport: "stdio", command: "/nonexistent/mcp", args: [] },
      mountedAt: 1,
      tools: [{ name: "t" }],
    };
    // If construction dialled out, this would throw or hang; it must not.
    const catalog = defaultToolCatalog({ env: {}, offline: true, fileRoot: tmpdir(), mcpServers: [record] });
    expect(catalog.get("mcp.ghost.t")?.mode).toBe("real");
  });

  it("two servers claiming the same mount name is a loud conflict, not a silent winner", () => {
    expect(() =>
      defaultToolCatalog({
        env: {},
        offline: true,
        fileRoot: tmpdir(),
        mcpServers: [echoRecord("dup"), echoRecord("dup")],
      })
    ).toThrow(/duplicate tool id/);
  });

  it("reads mounts from a state file, and status() reports each tool's source", () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-mcp-cat-"));
    const statePath = join(dir, "mcp-servers.json");
    new JsonFileMcpMountStore(statePath).save([echoRecord()]);

    const manager = defaultToolsetManager({
      env: {},
      offline: true,
      fileRoot: dir,
      mcpStatePath: statePath,
    });
    const status = manager.status();
    const mounted = status.find((s) => s.id === "mcp.echo.upper");
    expect(mounted?.source).toBe("mcp:echo");
    expect(status.find((s) => s.id === "shell")?.source).toBe("builtin");
  });

  it("an inherited tool can be disabled like any other, and then leaves the registry", () => {
    const manager = defaultToolsetManager({
      env: {},
      offline: true,
      fileRoot: tmpdir(),
      mcpServers: [echoRecord()],
    });
    expect(manager.buildRegistry().names()).toContain("mcp.echo.upper");
    expect(manager.disable("mcp.echo.upper")).toBe(true);
    expect(manager.buildRegistry().names()).not.toContain("mcp.echo.upper");
    expect(manager.buildRegistry().names()).toContain("mcp.echo.sum");
  });
});

/* ------------------------------------------------------------------ *
 * End to end: a real server, through the real registry
 * ------------------------------------------------------------------ */

describe("calling an inherited tool end to end", () => {
  it("dispatches through the catalog registry to the real server process", async () => {
    const manager = defaultToolsetManager({
      env: {},
      offline: true,
      fileRoot: tmpdir(),
      mcpServers: [echoRecord()],
    });
    const registry = manager.buildRegistry();

    const result = await registry.run({ tool: "mcp.echo.upper", input: '{"text":"inherited"}' });
    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.output) as Record<string, unknown>;
    expect(payload).toMatchObject({
      mode: "real",
      source: "mcp:echo",
      server: "echo",
      tool: "upper",
      argShape: "json",
      ok: true,
      isError: false,
      text: "INHERITED",
    });
  });

  it("accepts bare text for a single-string-argument tool and declares the wrapping", async () => {
    const [entry] = planMcpEntries(echoRecord()).entries;
    const result = await entry.tool.run("plain text input");
    const payload = JSON.parse(result.output) as Record<string, unknown>;
    expect(payload.argShape).toBe("wrapped:text");
    expect(payload.text).toBe("plain text input");
  });

  it("a tool-level failure from the server surfaces as ok:false carrying isError", async () => {
    const [entry] = planMcpEntries(echoRecord("failing", ["--fail-tool"])).entries;
    const result = await entry.tool.run('{"text":"x"}');
    expect(result.ok).toBe(false);
    const payload = JSON.parse(result.output) as Record<string, unknown>;
    expect(payload.isError).toBe(true);
    expect(payload.mode).toBe("real");
    expect(String(payload.text)).toContain("deliberately failed");
  });

  it("an unreachable server yields an honest error — and never invented content", async () => {
    const record: McpMountRecord = {
      spec: { name: "ghost", transport: "stdio", command: "/nonexistent/mcp-server", args: [] },
      mountedAt: 1,
      tools: [{ name: "anything", inputSchema: { type: "object", properties: {} } }],
    };
    const [entry] = planMcpEntries(record).entries;
    const result = await entry.tool.run("{}");

    expect(result.ok).toBe(false);
    const payload = JSON.parse(result.output) as Record<string, unknown>;
    expect(payload.mode).toBe("real"); // never relabelled as a mock
    expect(payload).not.toHaveProperty("text");
    expect(payload).not.toHaveProperty("content");
    expect(String(payload.error)).toContain('MCP server "ghost"');
    expect(String(payload.error)).toMatch(/ENOENT|could not be started/);
  });

  it("swarm workers can call an inherited tool, and the call is recorded as evidence", async () => {
    const box = new ToolBox(mcpSwarmTools([echoRecord()]));
    const runner = new ToolRunner(box);

    expect(box.list().map((t) => t.name)).toEqual(["mcp.echo.echo", "mcp.echo.sum", "mcp.echo.upper"]);

    const output = (await runner.call("mcp.echo.sum", { a: 19, b: 23 })) as { text: string };
    expect(output.text).toBe("42");
    // ToolRunner's record is the swarm's evidence trail: an inherited tool
    // leaves the same auditable footprint as any other.
    expect(runner.records).toHaveLength(1);
    expect(runner.records[0]).toMatchObject({ tool: "mcp.echo.sum", ok: true });
  });

  it("an unreachable server THROWS for the swarm, so no successful record is left behind", async () => {
    const record: McpMountRecord = {
      spec: { name: "ghost", transport: "stdio", command: "/nonexistent/mcp-server", args: [] },
      mountedAt: 1,
      tools: [{ name: "anything" }],
    };
    const runner = new ToolRunner(new ToolBox(mcpSwarmTools([record])));
    await expect(runner.call("mcp.ghost.anything", {})).rejects.toThrow(/MCP server "ghost"/);
    expect(runner.records[0]).toMatchObject({ tool: "mcp.ghost.anything", ok: false });
  });

  it("`hades exec` calls inherited tools and the STYX provenance chain still verifies", async () => {
    const manager = defaultToolsetManager({
      env: {},
      offline: true,
      fileRoot: tmpdir(),
      mcpServers: [echoRecord()],
    });
    const registry = execEnabledRegistry(manager.buildRegistry());
    const program = [
      'const up = await tools.call("mcp.echo.upper", JSON.stringify({ text: "inherited" }));',
      'const sum = await tools.call("mcp.echo.sum", JSON.stringify({ a: 19, b: 23 }));',
      "return JSON.parse(up.output).text + \"|\" + JSON.parse(sum.output).text;",
    ].join("\n");

    const result = await runExecCommand(["run", program], { registry });
    const text = result.lines.join("\n");

    expect(result.code).toBe(0);
    expect(text).toContain("INHERITED|42");
    expect(text).toContain("rpc calls:   2");
    // The whole point: breadth inherited over MCP is still auditable work.
    expect(text).toMatch(/trace chain: VERIFIED \(2 records, re-walked from genesis\)/);
  }, 30_000);
});
