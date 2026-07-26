/**
 * `hades state` router integration — the central wiring that makes Teams
 * 1-3's workspace stack actually REACHABLE from the terminal.
 *
 * These drive the real `HadesCli` (and, for the deps factories, the real
 * `buildHadesCli`) against real temp directories: no mocked store, no mocked
 * fs. What they protect is exactly what "central integration" means here —
 * the subcommand is routed, the deps factory is lazy, the store the CLI
 * opens is the SHARED `<dataDir>/state` root, and the engine adapters are
 * bound to the SAME memory/session stores every other subcommand uses.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HadesCli } from "../cli";
import { buildHadesCli } from "../build";
import { loadConfig } from "../../config/config";
import { workspaceRoot } from "../../state/wiring";
import { InMemoryMemoryStore } from "../../memory/store";
import { InMemorySessionStore } from "../../memory/session-store";
import type { StateCommandDeps } from "../state-command";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hades-state-route-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function depsFor(root: string): StateCommandDeps {
  return { root, actor: { kind: "cli", id: "route-test" } };
}

describe("hades state — routing", () => {
  it("is listed in help and reachable as a subcommand", async () => {
    const cli = new HadesCli({ state: () => depsFor(join(dir, "state")) });
    const help = await cli.run(["help"]);
    expect(help.code).toBe(0);
    expect(help.lines.join("\n")).toContain("state <sub>");

    const res = await cli.run(["state", "help"]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Usage: hades state <command>");
  });

  it("routes a real write and reads it back through the router", async () => {
    const root = join(dir, "state");
    const cli = new HadesCli({ state: () => depsFor(root) });

    const set = await cli.run(["state", "set", "memory", "routed", '{"ok":true}']);
    expect(set.code).toBe(0);
    expect(set.lines.join("")).toContain("Set memory/routed (rev 1)");

    const get = await cli.run(["state", "get", "memory", "routed", "--json"]);
    expect(get.code).toBe(0);
    const record = JSON.parse(get.lines.join("\n")) as { key: string; actor: string; value: unknown };
    expect(record.key).toBe("routed");
    expect(record.actor).toBe("cli:route-test");
    expect(record.value).toEqual({ ok: true });

    // Really on disk, in the shared layout — not an in-process illusion.
    expect(existsSync(join(root, "journal.log"))).toBe(true);
    expect(existsSync(join(root, "domains", "memory.json"))).toBe(true);
  });

  it("only calls the deps factory when a state subcommand actually runs, and caches it", async () => {
    let calls = 0;
    const cli = new HadesCli({
      state: () => {
        calls += 1;
        return depsFor(join(dir, "state"));
      },
    });

    await cli.run(["help"]);
    await cli.run(["version"]);
    expect(calls).toBe(0);

    await cli.run(["state", "status"]);
    await cli.run(["state", "status"]);
    expect(calls).toBe(1);
  });

  it("reports an unknown state subcommand with usage, not a crash", async () => {
    const cli = new HadesCli({ state: () => depsFor(join(dir, "state")) });
    const res = await cli.run(["state", "frobnicate"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Unknown state command: frobnicate");
  });
});

describe("buildHadesCli — state deps", () => {
  it("binds the workspace to the shared root and the REAL memory/session stores", async () => {
    const config = loadConfig({ env: { HADES_DATA_DIR: dir } });
    const memory = new InMemoryMemoryStore();
    const sessions = new InMemorySessionStore();
    const cli = buildHadesCli(config, { persist: true, memory, sessions });

    // A real fact in the real engine store...
    memory.add({ fact: "the sky is blue", source: "unit-test" });
    const session = sessions.create({ title: "routed session" });
    sessions.append(session.id, { role: "user", content: "hello from the engine" });

    // ...must be exported by `hades state export` into the shared store.
    const exported = await cli.run(["state", "export"]);
    expect(exported.code).toBe(0);

    const root = workspaceRoot(dir);
    expect(existsSync(join(root, "journal.log"))).toBe(true);

    const facts = await cli.run(["state", "list", "memory", "--json"]);
    expect(facts.code).toBe(0);
    expect(facts.lines.join("\n")).toContain("the sky is blue");

    const sessionRecords = await cli.run(["state", "list", "sessions", "--json"]);
    expect(sessionRecords.code).toBe(0);
    expect(sessionRecords.lines.join("\n")).toContain("hello from the engine");

    // The status the CLI reports must be the same store, chain intact.
    const doctor = await cli.run(["state", "doctor", "--json"]);
    const health = JSON.parse(doctor.lines.join("\n")) as { ok: boolean; chain: { ok: boolean } };
    expect(health.chain.ok).toBe(true);
    expect(health.ok).toBe(true);
  });

  it("keeps a non-persisting build out of the user's data dir", async () => {
    const config = loadConfig({ env: { HADES_DATA_DIR: dir } });
    const cli = buildHadesCli(config, { persist: false });
    const res = await cli.run(["state", "set", "config", "locale", '"en"']);
    expect(res.code).toBe(0);
    // Nothing was written into the configured data dir's workspace root.
    expect(existsSync(join(workspaceRoot(dir), "journal.log"))).toBe(false);
  });
});
