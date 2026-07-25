/**
 * `hades install` router integration.
 *
 * The installer planner + portable-bundle builder (`src/hades/install/**`)
 * and its command surface (`../install-command.ts`) shipped a cycle earlier
 * but were never reachable: `cli.ts` had no route, so `hades install` fell
 * through to "Unknown command". These tests exist so that cannot regress —
 * they drive the REAL `HadesCli` with a REAL host probe against real temp
 * directories.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HadesCli } from "../cli";
import { defaultInstallDeps, type InstallCommandDeps } from "../install-command";

let tmpDirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function depsFor(): InstallCommandDeps {
  const root = freshDir("hades-install-route-");
  return { ...defaultInstallDeps({ ...process.env, HADES_REPO_ROOT: root }), repoRoot: root, version: "0.1.0" };
}

describe("hades install — routing", () => {
  it("is listed in help and reachable as a subcommand", async () => {
    const cli = new HadesCli({ install: () => depsFor() });
    const help = await cli.run(["help"]);
    expect(help.lines.join("\n")).toContain("install <sub>");

    const res = await cli.run(["install", "help"]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toContain("hades install");
  });

  it("routes `install plan --json` to the real planner", async () => {
    const cli = new HadesCli({ install: () => depsFor() });
    const res = await cli.run(["install", "plan", "--json", "--prefix", freshDir("hades-install-prefix-")]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.lines.join("\n")) as { steps?: unknown[]; binDir?: string; launcherSha256?: string };
    expect(Array.isArray(parsed.steps)).toBe(true);
    expect(parsed.binDir).toContain("bin");
    // A REAL sha256 of the launcher it would write, not a placeholder.
    expect(parsed.launcherSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds its deps lazily and caches them", async () => {
    let built = 0;
    const cli = new HadesCli({
      install: () => {
        built++;
        return depsFor();
      },
    });
    await cli.run(["help"]);
    expect(built).toBe(0);
    await cli.run(["install", "doctor"]);
    await cli.run(["install", "doctor"]);
    expect(built).toBe(1);
  });
});
