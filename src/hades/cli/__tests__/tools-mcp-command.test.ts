/**
 * `hades tools mcp` — the operator surface for inheriting the MCP tool
 * ecosystem, tested against the real in-repo MCP server
 * (`scripts/mcp-echo-server.mjs`) rather than a fixture.
 *
 * The behaviours worth defending here are the honest ones:
 *  - `add` PROBES before it persists, so an unreachable server is an error and
 *    the mount file stays untouched (no half-mount that fails later at call
 *    time, no entry that looks available but is not).
 *  - `list` never passes its cached listing off as live, and `--probe` — which
 *    does go and look — exits non-zero when a mounted server is dead.
 *  - environment requirements travel as NAMES; no test here can find a value,
 *    because none is ever stored or printed.
 *  - a mount takes effect in the running process AND survives into the next
 *    one, and an unmount removes it from both.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runToolsMcpCommand, parseMcpAddArgs, type ToolsMcpCommandDeps } from "../tools-mcp-command";
import { InMemoryMcpMountStore, JsonFileMcpMountStore } from "../../tools/mcp-catalog";
import { defaultToolCatalog, defaultToolsetManager } from "../../tools/default-catalog";
import { ToolsetManager } from "../../tools/manager";
import { HadesCli } from "../cli";
import { buildHadesCli } from "../build";
import { loadConfig } from "../../config/config";

const ECHO_SERVER = fileURLToPath(new URL("../../../../scripts/mcp-echo-server.mjs", import.meta.url));

function deps(overrides: Partial<ToolsMcpCommandDeps> = {}): ToolsMcpCommandDeps {
  return {
    store: new InMemoryMcpMountStore(),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

/** `add <name> --command <node> -- <echo-server> [extra…]` — the `--` form,
 *  because the extras are themselves flags meant for the server, not for us. */
function addArgs(name: string, extra: string[] = []): string[] {
  return ["add", name, "--command", process.execPath, "--", ECHO_SERVER, ...extra];
}

describe("hades tools mcp add", () => {
  it("mounts a real server: probes it, persists it, and reports the inherited ids", async () => {
    const d = deps();
    const res = await runToolsMcpCommand(addArgs("echo"), d);

    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain('Mounted MCP server "echo"');
    expect(text).toContain("hades-echo-mcp 0.1.0");
    expect(text).toContain("mcp.echo.echo");
    expect(text).toContain("mcp.echo.sum");
    expect(text).toContain("mcp.echo.upper");

    const stored = d.store.load();
    expect(stored).toHaveLength(1);
    expect(stored[0].spec.name).toBe("echo");
    expect(stored[0].tools.map((t) => t.name).sort()).toEqual(["echo", "sum", "upper"]);
  });

  it("an unreachable server is an error and NOTHING is persisted", async () => {
    const d = deps();
    const res = await runToolsMcpCommand(["add", "ghost", "--command", "/nonexistent/mcp-server"], d);

    expect(res.code).toBe(1);
    const text = res.lines.join("\n");
    expect(text).toContain('MCP server "ghost"');
    expect(text).toMatch(/ENOENT|could not be started/);
    expect(text).toContain("Nothing was mounted.");
    expect(d.store.load()).toEqual([]);
  });

  it("a server that dies on startup is reported with its own stderr, and not mounted", async () => {
    const d = deps();
    const res = await runToolsMcpCommand(addArgs("crasher", ["--crash"]), d);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("refusing to start (--crash)");
    expect(d.store.load()).toEqual([]);
  });

  it("refuses a second mount under an existing name", async () => {
    const d = deps();
    expect((await runToolsMcpCommand(addArgs("echo"), d)).code).toBe(0);
    const res = await runToolsMcpCommand(addArgs("echo"), d);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("already mounted");
    expect(d.store.load()).toHaveLength(1);
  });

  it("refuses a shell command line instead of quietly mis-splitting it", async () => {
    const res = await runToolsMcpCommand(["add", "x", "--command", "node server.mjs --flag"], deps());
    expect(res.code).toBe(1);
    const text = res.lines.join("\n");
    expect(text).toContain("there is no shell");
    expect(text).toContain("Did you mean");
  });

  it("rejects nonsense argument combinations with a specific reason", async () => {
    const cases: Array<[string[], RegExp]> = [
      [["add"], /Usage/],
      [["add", "x"], /--command .* or --url/],
      [["add", "x", "--command", "node", "--url", "https://e.invalid"], /not both/],
      [["add", "bad name", "--command", "node"], /Invalid server name/],
      [["add", "x", "--command", "node", "--header-env", "A=B"], /only applies to an --url/],
      [["add", "x", "--url", "https://e.invalid", "extra-arg"], /only apply to a --command/],
      [["add", "x", "--url", "ftp://e.invalid"], /http\(s\) endpoint/],
      [["add", "x", "--command", "node", "--bogus"], /Unknown option/],
      [["add", "x", "--command"], /--command needs/],
      [["add", "x", "--command", "node", "--timeout-ms", "nope"], /positive number/],
      [["add", "x", "--url", "https://e.invalid", "--header-env", "malformed"], /Header>=<ENV_VAR/],
    ];
    for (const [args, pattern] of cases) {
      const res = await runToolsMcpCommand(args, deps());
      expect(res.code, args.join(" ")).toBe(1);
      expect(res.lines.join("\n"), args.join(" ")).toMatch(pattern);
    }
  });

  it("--json reports the mount machine-readably", async () => {
    // `--json` goes BEFORE `--`: everything after `--` belongs to the server.
    const res = await runToolsMcpCommand(
      ["add", "echo", "--json", "--command", process.execPath, "--", ECHO_SERVER],
      deps()
    );
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.lines.join("\n")) as { mounted: string; tools: string[] };
    expect(parsed.mounted).toBe("echo");
    // Reported in the server's own listing order; sorted here for the assertion.
    expect([...parsed.tools].sort()).toEqual(["mcp.echo.echo", "mcp.echo.sum", "mcp.echo.upper"]);
  });

  it("everything after `--` is passed to the server verbatim", () => {
    const parsed = parseMcpAddArgs(["srv", "--command", "node", "--", "server.mjs", "--fail-tool"]);
    expect("errorLines" in parsed).toBe(false);
    if ("errorLines" in parsed) return;
    expect(parsed.command).toBe("node");
    expect(parsed.args).toEqual(["server.mjs", "--fail-tool"]);
  });

  it("--requires-env records NAMES only", () => {
    const parsed = parseMcpAddArgs(["srv", "--command", "node", "--requires-env", "A_TOKEN, B_TOKEN"]);
    expect("errorLines" in parsed).toBe(false);
    if ("errorLines" in parsed) return;
    expect(parsed.requiresEnv).toEqual(["A_TOKEN", "B_TOKEN"]);
  });

  it("mounts into the LIVE catalog of the running process, not only the file", async () => {
    const catalog = defaultToolCatalog({ env: {}, offline: true, fileRoot: tmpdir() });
    const d = deps({ catalog });
    expect(catalog.get("mcp.echo.upper")).toBeUndefined();

    await runToolsMcpCommand(addArgs("echo"), d);

    const entry = catalog.get("mcp.echo.upper");
    expect(entry?.source).toBe("mcp:echo");
    // And it is immediately callable, for real, in this process.
    const result = await entry!.tool.run('{"text":"live"}');
    expect(JSON.parse(result.output).text).toBe("LIVE");
  });
});

describe("hades tools mcp list", () => {
  it("says so plainly when nothing is mounted", async () => {
    const res = await runToolsMcpCommand(["list"], deps());
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("No MCP servers are mounted.");
  });

  it("prints the mount and labels the tool count as cached, not live", async () => {
    const d = deps();
    await runToolsMcpCommand(addArgs("echo"), d);
    const res = await runToolsMcpCommand(["list"], d);

    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("NAME");
    expect(text).toMatch(/echo\s+stdio/);
    expect(text).toContain("not a live count");
    expect(text).toContain("--probe");
  });

  it("--probe actually reconnects and reports a reachable server", async () => {
    const d = deps();
    await runToolsMcpCommand(addArgs("echo"), d);
    const res = await runToolsMcpCommand(["list", "--probe"], d);

    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("echo: reachable, 3 tools");
  });

  it("--probe exits non-zero when a mounted server has since died", async () => {
    const d = deps();
    await runToolsMcpCommand(addArgs("echo"), d);
    // Rewrite the stored command to something that no longer exists: exactly
    // what a moved/uninstalled server looks like on the next run.
    const records = d.store.load();
    (records[0].spec as { command: string }).command = "/nonexistent/mcp-server";
    d.store.save(records);

    const res = await runToolsMcpCommand(["list", "--probe"], d);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("UNREACHABLE");
  });

  it("reports INHERITED/ADVERTISED, never the advertised count alone", async () => {
    // The echo server advertises three representable names, so the plain form
    // is right here. The interesting case is below; this pins the plain form so
    // the two cannot silently converge.
    const d = deps();
    await runToolsMcpCommand(addArgs("echo"), d);
    const res = await runToolsMcpCommand(["list"], d);
    const text = res.lines.join("\n");
    expect(text).toContain("SKIPPED");
    expect(text).toMatch(/^echo\s+stdio\s+.*\s3\s+0\s+\S+$/m);
  });

  it("never claims a tool count the catalog could not actually inherit", async () => {
    // A server advertising names the catalog id charset cannot represent. `add`
    // was always honest about this at mount time and then threw the skip list
    // away, so the DURABLE surface reported 4 usable tools where 2 existed —
    // while `hades tools list` showed 2. Two answers to one question.
    const d = deps();
    await runToolsMcpCommand(addArgs("odd"), d);
    const records = d.store.load();
    records[0].tools = [
      { name: "alpha", description: "a" },
      { name: "bad/name", description: "b" },
      { name: "bad:name", description: "c" },
    ];
    d.store.save(records);

    const res = await runToolsMcpCommand(["list"], d);
    const text = res.lines.join("\n");
    // 2 inherited of 3 advertised: `bad/name` and `bad:name` both sanitize to
    // `mcp.odd.bad_name`, so the second collides and is skipped.
    expect(text).toMatch(/^odd\s+stdio\s+.*\s2\/3\s+1\s+\S+$/m);
    expect(text).toContain("Advertised but NOT inherited");
    expect(text).toContain("bad:name");

    const json = JSON.parse(
      (await runToolsMcpCommand(["list", "--json"], d)).lines.join("\n")
    ) as Array<{ advertisedToolCount: number; inheritedToolCount: number; skippedTools: unknown[] }>;
    expect(json[0].advertisedToolCount).toBe(3);
    expect(json[0].inheritedToolCount).toBe(2);
    expect(json[0].skippedTools).toHaveLength(1);
  });

  it("--probe KEEPS the cache caveat — it is needed most where a contradiction can appear", async () => {
    const d = deps();
    await runToolsMcpCommand(addArgs("echo"), d);
    const res = await runToolsMcpCommand(["list", "--probe"], d);
    // This caveat used to be inside the `if (!probe)` early return: removed in
    // exactly the mode that can print a stale number beside a live one.
    expect(res.lines.join("\n")).toContain("not a live count");
  });

  it("--probe DETECTS drift and exits non-zero instead of reporting success", async () => {
    // The live server is fine — it is the CACHE that is wrong. `--probe` is
    // documented as the command that actually reconnects, so observing the
    // disagreement and exiting 0 would be the stale number wearing a live badge
    // while `hades tools list` kept offering a tool the server no longer has.
    const d = deps();
    await runToolsMcpCommand(addArgs("echo"), d);
    const records = d.store.load();
    records[0].tools = [...records[0].tools, { name: "ghost", description: "gone upstream" }];
    d.store.save(records);

    const res = await runToolsMcpCommand(["list", "--probe"], d);
    expect(res.code).toBe(1);
    const text = res.lines.join("\n");
    expect(text).toContain("echo: reachable, 3 tools");
    expect(text).toContain("DRIFT");
    expect(text).toContain("ghost");
    expect(text).toContain("re-mount to reconcile");
  });

  it("--probe stays green and silent about drift when the cache matches the server", async () => {
    const d = deps();
    await runToolsMcpCommand(addArgs("echo"), d);
    const res = await runToolsMcpCommand(["list", "--probe"], d);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).not.toContain("DRIFT");
  });

  it("reports unmet environment requirements by NAME", async () => {
    const d = deps({ mount: { env: {} } });
    await runToolsMcpCommand(
      ["add", "echo", "--requires-env", "ACME_MCP_TOKEN", "--command", process.execPath, "--", ECHO_SERVER],
      {
        ...d,
        // The mount itself needs the variable set to get through its own probe.
        mount: { env: { ACME_MCP_TOKEN: "set-for-the-probe" } },
      }
    );
    const res = await runToolsMcpCommand(["list"], d);
    const text = res.lines.join("\n");
    expect(text).toContain("Unmet environment requirements");
    expect(text).toContain("ACME_MCP_TOKEN");
    expect(text).not.toContain("set-for-the-probe");
  });

  it("--json exposes the mounts, their cached tools and their unmet requirements", async () => {
    const d = deps({ mount: { env: {} } });
    await runToolsMcpCommand(addArgs("echo"), d);
    const res = await runToolsMcpCommand(["list", "--json"], d);
    const parsed = JSON.parse(res.lines.join("\n")) as Array<{
      name: string;
      transport: string;
      cachedTools: string[];
      unmetEnv: string[];
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: "echo", transport: "stdio", unmetEnv: [] });
    expect(parsed[0].cachedTools.sort()).toEqual(["echo", "sum", "upper"]);
  });
});

describe("hades tools mcp remove", () => {
  it("unmounts from the file and from the live catalog", async () => {
    const catalog = defaultToolCatalog({ env: {}, offline: true, fileRoot: tmpdir() });
    const d = deps({ catalog });
    await runToolsMcpCommand(addArgs("echo"), d);
    expect(catalog.get("mcp.echo.sum")).toBeDefined();

    const res = await runToolsMcpCommand(["remove", "echo"], d);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("Unmounted MCP server \"echo\"");
    expect(d.store.load()).toEqual([]);
    expect(catalog.get("mcp.echo.sum")).toBeUndefined();
  });

  it("removing something that was never mounted is an error, not a no-op success", async () => {
    const res = await runToolsMcpCommand(["remove", "nope"], deps());
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("No MCP server named");
  });

  it("remove with no name shows usage", async () => {
    const res = await runToolsMcpCommand(["remove"], deps());
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("Usage");
  });
});

describe("hades tools mcp help / unknown", () => {
  it("help documents add/list/remove and the no-shell rule", async () => {
    const res = await runToolsMcpCommand([], deps());
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("add <name> --command");
    expect(text).toContain("list [--json] [--probe]");
    expect(text).toContain("remove <name>");
    expect(text).toContain("never a silent mock");
  });

  it("an unknown subcommand is refused", async () => {
    const res = await runToolsMcpCommand(["frobnicate"], deps());
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("Unknown tools mcp command");
  });
});

describe("mounts across the CLI and across processes", () => {
  it("`hades tools mcp add` then `hades tools list` shows the inherited tools with their source", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });

    const added = await cli.run(["tools", "mcp", "add", "echo", "--command", process.execPath, ECHO_SERVER]);
    expect(added.code).toBe(0);

    const listed = await cli.run(["tools", "list"]);
    expect(listed.code).toBe(0);
    const text = listed.lines.join("\n");
    expect(text).toContain("SOURCE");
    expect(text).toMatch(/mcp\.echo\.upper\s+data\s+real\s+enabled\s+mcp:echo/);
    expect(text).toMatch(/shell\s+system\s+real\s+enabled\s+builtin/);

    const info = await cli.run(["tools", "info", "mcp.echo.upper"]);
    expect(info.lines.join("\n")).toContain("source:          mcp:echo");
    expect(info.lines.join("\n")).toContain("verifierId:      unverified.mcp-inherited");
  });

  it("`hades exec` runs a program against an inherited tool through the CLI wiring", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });
    await cli.run(["tools", "mcp", "add", "echo", "--command", process.execPath, ECHO_SERVER]);

    const res = await cli.run([
      "exec",
      "run",
      'const r = await tools.call("mcp.echo.echo", JSON.stringify({ text: "through the cli" })); return JSON.parse(r.output).text;',
    ]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("result:      through the cli");
    expect(text).toContain("trace chain: VERIFIED");
  }, 30_000);

  it("a mount written by one process is honoured by the next one's catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-mcp-cli-"));
    const statePath = join(dir, "mcp-servers.json");

    // Process A: mount, persisting to a real file.
    const first = await runToolsMcpCommand(addArgs("echo"), {
      store: new JsonFileMcpMountStore(statePath),
    });
    expect(first.code).toBe(0);

    // Process B: a brand new catalog built from that file alone.
    const manager: ToolsetManager = defaultToolsetManager({
      env: {},
      offline: true,
      fileRoot: dir,
      mcpStatePath: statePath,
    });
    expect(manager.status().map((s) => s.id)).toContain("mcp.echo.upper");

    const result = await manager.buildRegistry().run({
      tool: "mcp.echo.upper",
      input: '{"text":"across processes"}',
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output).text).toBe("ACROSS PROCESSES");
  });

  it("a build without MCP mounts configured says so instead of pretending to mount", async () => {
    const cli = new HadesCli({ toolset: defaultToolsetManager({ env: {}, offline: true, fileRoot: tmpdir() }) });
    const res = await cli.run(["tools", "mcp", "list"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("not configured in this build");
  });

  it("`hades tools help` advertises the mcp subsurface", async () => {
    const cli = buildHadesCli(loadConfig(), { persist: false });
    const res = await cli.run(["tools", "help"]);
    expect(res.lines.join("\n")).toContain("mcp <command>");
  });
});
