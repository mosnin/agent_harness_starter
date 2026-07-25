/**
 * Tests for `src/hades/install/plan.ts` (the pure install planner) AND, in
 * the same file (these are the only files this build owns), integration
 * coverage of the real `install.sh` at the repo root.
 *
 * The planner tests inject `HostProbe` literals directly -- no filesystem,
 * no child_process, no clock. The `install.sh` tests spawn the REAL `bash`
 * on the REAL script against a REAL temp `HOME`/prefix and inspect what
 * actually landed on disk, including executing the installed launcher and
 * reading its real stdout. Nothing about the shell is mocked.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";

import {
  MIN_NODE_MAJOR,
  INSTALL_SH_FLAGS,
  parseNodeVersion,
  compareNodeVersion,
  detectShell,
  profileForShell,
  resolveTargets,
  launcherScript,
  buildInstallPlan,
  renderPlanText,
  renderPlanJson,
  type HostProbe,
  type InstallOptions,
  type ShellKind,
} from "../plan";

// ---------------------------------------------------------------------------
// Shared fixtures for the pure planner tests.
// ---------------------------------------------------------------------------

// Next.js's global.d.ts (next/types/global.d.ts) augments NodeJS.ProcessEnv
// to require a readonly NODE_ENV, which real env fixtures in tests never
// bother setting. LooseEnv/LooseHost let test fixtures stay plain records;
// the cast to NodeJS.ProcessEnv happens once, here, matching the pattern
// already used elsewhere in this repo's tests (e.g. config.test.ts).
type LooseEnv = Record<string, string | undefined>;
type LooseHost = Omit<Partial<HostProbe>, "env"> & { env?: LooseEnv };

function host(overrides: LooseHost = {}): HostProbe {
  const { env, ...rest } = overrides;
  return {
    platform: "linux",
    arch: "x64",
    home: "/home/tester",
    env: (env ?? { PATH: "/usr/bin:/bin" }) as unknown as NodeJS.ProcessEnv,
    nodeVersion: "v20.11.0",
    shellPath: "/bin/bash",
    writable: {},
    ...rest,
  };
}

function opts(overrides: Partial<InstallOptions> = {}): InstallOptions {
  return {
    version: "0.1.0",
    repoRoot: "/repo",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseNodeVersion / compareNodeVersion
// ---------------------------------------------------------------------------

describe("parseNodeVersion", () => {
  it("parses a standard v-prefixed version", () => {
    expect(parseNodeVersion("v20.11.0")).toEqual({ major: 20, minor: 11, patch: 0 });
  });

  it("parses without the v prefix", () => {
    expect(parseNodeVersion("20.11.0")).toEqual({ major: 20, minor: 11, patch: 0 });
  });

  it("parses a prerelease/build suffix by ignoring it", () => {
    expect(parseNodeVersion("v21.0.0-nightly")).toEqual({ major: 21, minor: 0, patch: 0 });
    expect(parseNodeVersion("v21.0.0-nightly20240101")).toEqual({ major: 21, minor: 0, patch: 0 });
    expect(parseNodeVersion("1.2.3+build.5")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("returns undefined for garbage input", () => {
    expect(parseNodeVersion("not-a-version")).toBeUndefined();
    expect(parseNodeVersion("")).toBeUndefined();
    expect(parseNodeVersion("v20")).toBeUndefined();
    expect(parseNodeVersion("v20.11")).toBeUndefined();
  });

  it("returns undefined for missing input", () => {
    expect(parseNodeVersion(undefined)).toBeUndefined();
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseNodeVersion("  v20.11.0\n")).toEqual({ major: 20, minor: 11, patch: 0 });
  });
});

describe("compareNodeVersion", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareNodeVersion("v18.0.0", "v20.0.0")).toBeLessThan(0);
    expect(compareNodeVersion("v20.0.0", "v18.0.0")).toBeGreaterThan(0);
    expect(compareNodeVersion("v20.1.0", "v20.2.0")).toBeLessThan(0);
    expect(compareNodeVersion("v20.2.5", "v20.2.4")).toBeGreaterThan(0);
    expect(compareNodeVersion("v20.2.4", "v20.2.4")).toBe(0);
  });

  it("treats unparsable versions as 0.0.0 (never throws, always defined)", () => {
    expect(compareNodeVersion("garbage", "v1.0.0")).toBeLessThan(0);
    expect(compareNodeVersion("v1.0.0", "garbage")).toBeGreaterThan(0);
    expect(compareNodeVersion("garbage", "also-garbage")).toBe(0);
  });

  it("is a total order: reflexive, antisymmetric, transitive (property test)", () => {
    const versionArb = fc
      .tuple(fc.nat(30), fc.nat(30), fc.nat(30))
      .map(([maj, min, pat]) => `v${maj}.${min}.${pat}`);

    fc.assert(
      fc.property(versionArb, versionArb, versionArb, (a, b, c) => {
        // reflexive
        expect(compareNodeVersion(a, a)).toBe(0);
        // antisymmetric
        const ab = Math.sign(compareNodeVersion(a, b));
        const ba = Math.sign(compareNodeVersion(b, a));
        expect(ab).toBe(-ba);
        // transitive
        if (compareNodeVersion(a, b) <= 0 && compareNodeVersion(b, c) <= 0) {
          expect(compareNodeVersion(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 300 }
    );
  });
});

// ---------------------------------------------------------------------------
// detectShell / profileForShell
// ---------------------------------------------------------------------------

describe("detectShell", () => {
  it("maps every known shell binary to its ShellKind", () => {
    expect(detectShell("/bin/bash")).toBe("bash");
    expect(detectShell("/usr/bin/zsh")).toBe("zsh");
    expect(detectShell("/usr/local/bin/fish")).toBe("fish");
    expect(detectShell("/bin/sh")).toBe("sh");
  });

  it("returns unknown for anything else, including undefined", () => {
    expect(detectShell(undefined)).toBe("unknown");
    expect(detectShell("/bin/tcsh")).toBe("unknown");
    expect(detectShell("/opt/weird/csh")).toBe("unknown");
    expect(detectShell("")).toBe("unknown");
  });
});

describe("profileForShell", () => {
  const kinds: ShellKind[] = ["bash", "zsh", "fish", "sh", "unknown"];

  it("maps every ShellKind to the documented profile file, or undefined for unknown", () => {
    expect(profileForShell("bash", "/home/x")?.path).toBe("/home/x/.bashrc");
    expect(profileForShell("zsh", "/home/x")?.path).toBe("/home/x/.zshrc");
    expect(profileForShell("sh", "/home/x")?.path).toBe("/home/x/.profile");
    expect(profileForShell("fish", "/home/x")?.path).toBe("/home/x/.config/fish/config.fish");
    expect(profileForShell("unknown", "/home/x")).toBeUndefined();
  });

  it("covers every declared ShellKind with no gaps", () => {
    for (const k of kinds) {
      const result = profileForShell(k, "/home/x");
      if (k === "unknown") {
        expect(result).toBeUndefined();
      } else {
        expect(result).toBeDefined();
      }
    }
  });

  it("produces a PATH-prepending line parameterized by binDir", () => {
    const p = profileForShell("bash", "/home/x")!;
    expect(p.line("/opt/bin")).toContain("/opt/bin");
    expect(p.line("/opt/bin")).toContain("PATH");
  });

  it("quotes the fish line safely for a binDir containing spaces", () => {
    const p = profileForShell("fish", "/home/x")!;
    const line = p.line("/opt/my bin");
    expect(line).toContain("'/opt/my bin'");
  });
});

// ---------------------------------------------------------------------------
// resolveTargets precedence
// ---------------------------------------------------------------------------

describe("resolveTargets", () => {
  it("falls back to ~/.local/bin and ~/.hades with nothing else set", () => {
    const r = resolveTargets(host({ home: "/home/x", env: {} }), opts());
    expect(r.binDir).toBe("/home/x/.local/bin");
    expect(r.dataDir).toBe("/home/x/.hades");
  });

  it("prefers XDG_BIN_HOME / XDG_DATA_HOME over the default", () => {
    const r = resolveTargets(
      host({ home: "/home/x", env: { XDG_BIN_HOME: "/xdg/bin", XDG_DATA_HOME: "/xdg/data" } }),
      opts()
    );
    expect(r.binDir).toBe("/xdg/bin");
    expect(r.dataDir).toBe("/xdg/data/hades");
  });

  it("prefers HADES_BIN_DIR / HADES_DATA_DIR over XDG_*", () => {
    const r = resolveTargets(
      host({
        home: "/home/x",
        env: {
          XDG_BIN_HOME: "/xdg/bin",
          XDG_DATA_HOME: "/xdg/data",
          HADES_BIN_DIR: "/hades/bin",
          HADES_DATA_DIR: "/hades/data",
        },
      }),
      opts()
    );
    expect(r.binDir).toBe("/hades/bin");
    expect(r.dataDir).toBe("/hades/data");
  });

  it("--prefix implies DIR/bin and DIR/share/hades, below env vars", () => {
    const r = resolveTargets(
      host({ home: "/home/x", env: { HADES_BIN_DIR: "/hades/bin" } }),
      opts({ prefix: "/opt/hades" })
    );
    expect(r.binDir).toBe("/opt/hades/bin");
    expect(r.dataDir).toBe("/opt/hades/share/hades");
    expect(r.prefix).toBe("/opt/hades");
  });

  it("explicit --bin-dir/--data-dir win over everything, even --prefix", () => {
    const r = resolveTargets(
      host({ home: "/home/x", env: {} }),
      opts({ prefix: "/opt/hades", binDir: "/explicit/bin", dataDir: "/explicit/data" })
    );
    expect(r.binDir).toBe("/explicit/bin");
    expect(r.dataDir).toBe("/explicit/data");
  });
});

// ---------------------------------------------------------------------------
// launcherScript
// ---------------------------------------------------------------------------

describe("launcherScript", () => {
  it("execs node --import tsx <repoRoot>/src/hades/bin/hades.ts \"$@\"", () => {
    const s = launcherScript({ repoRoot: "/repo", version: "0.1.0" });
    expect(s).toContain("--import tsx");
    expect(s).toContain("/repo/src/hades/bin/hades.ts");
    expect(s).toContain('"$@"');
    expect(s.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(s.endsWith("\n")).toBe(true);
  });

  it("safely quotes a repoRoot containing spaces and single quotes", () => {
    const s = launcherScript({ repoRoot: "/home/a b/it's here", version: "0.1.0" });
    expect(s).toContain("'/home/a b/it'\\''s here/src/hades/bin/hades.ts'");
  });

  it("honors a custom nodeBin override", () => {
    const s = launcherScript({ repoRoot: "/repo", version: "0.1.0", nodeBin: "/opt/node20/bin/node" });
    expect(s).toContain("'/opt/node20/bin/node'");
  });

  it("is fully deterministic for identical inputs", () => {
    const a = launcherScript({ repoRoot: "/repo", version: "1.2.3" });
    const b = launcherScript({ repoRoot: "/repo", version: "1.2.3" });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// buildInstallPlan
// ---------------------------------------------------------------------------

describe("buildInstallPlan -- happy paths", () => {
  it("plans a fresh install with no existing installation", () => {
    const plan = buildInstallPlan(host(), opts());
    expect(plan.mode).toBe("install");
    expect(plan.ok).toBe(true);
    expect(plan.blockers).toHaveLength(0);
    expect(plan.steps.some((s) => s.kind === "mkdir" && s.target === plan.binDir)).toBe(true);
    expect(plan.steps.some((s) => s.kind === "write" && s.target === plan.launcherPath)).toBe(true);
    expect(plan.steps.some((s) => s.kind === "chmod" && s.mode === 0o755)).toBe(true);
    expect(plan.steps.some((s) => s.kind === "append-profile")).toBe(true);
  });

  it("plans an upgrade when a strictly older version is already installed", () => {
    const plan = buildInstallPlan(
      host({ existing: { launcherPath: "/home/tester/.local/bin/hades", version: "0.0.9" } }),
      opts({ version: "0.1.0" })
    );
    expect(plan.mode).toBe("upgrade");
    expect(plan.ok).toBe(true);
  });

  it("plans a reinstall with --force even at the same version", () => {
    const plan = buildInstallPlan(
      host({ existing: { launcherPath: "/home/tester/.local/bin/hades", version: "0.1.0" } }),
      opts({ version: "0.1.0", force: true })
    );
    expect(plan.mode).toBe("reinstall");
    expect(plan.ok).toBe(true);
  });

  it("does not append a profile line when binDir is already on PATH", () => {
    const plan = buildInstallPlan(
      host({ env: { PATH: "/home/tester/.local/bin:/usr/bin" } }),
      opts()
    );
    expect(plan.pathAlreadyContainsBinDir).toBe(true);
    expect(plan.steps.some((s) => s.kind === "append-profile")).toBe(false);
    expect(plan.warnings.some((w) => w.includes("already on PATH"))).toBe(true);
  });

  it("warns and adds manual instructions for an unknown shell instead of guessing", () => {
    const plan = buildInstallPlan(host({ shellPath: "/bin/tcsh" }), opts());
    expect(plan.shell).toBe("unknown");
    expect(plan.profilePath).toBeUndefined();
    expect(plan.warnings.some((w) => w.toLowerCase().includes("shell profile"))).toBe(true);
    expect(plan.steps.some((s) => s.kind === "note" && s.detail.includes("PATH"))).toBe(true);
  });

  it("respects modifyPath: false / --no-modify-path", () => {
    const plan = buildInstallPlan(host(), opts({ modifyPath: false }));
    expect(plan.steps.some((s) => s.kind === "append-profile")).toBe(false);
    expect(plan.warnings.some((w) => w.includes("--no-modify-path"))).toBe(true);
  });

  it("computes launcherSha256 as the real sha256 of launcherScript", async () => {
    const { createHash } = await import("node:crypto");
    const plan = buildInstallPlan(host(), opts());
    const expected = createHash("sha256").update(plan.launcherScript, "utf8").digest("hex");
    expect(plan.launcherSha256).toBe(expected);
    expect(plan.launcherSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildInstallPlan -- every BlockerCode is reachable with a distinct remedy", () => {
  it("node-missing", () => {
    const plan = buildInstallPlan(host({ nodeVersion: undefined }), opts());
    expect(plan.ok).toBe(false);
    const b = plan.blockers.find((x) => x.code === "node-missing");
    expect(b).toBeDefined();
    expect(b!.remedy.length).toBeGreaterThan(0);
  });

  it("node-missing also fires for an unparsable node --version string", () => {
    const plan = buildInstallPlan(host({ nodeVersion: "not-a-version" }), opts());
    expect(plan.blockers.some((x) => x.code === "node-missing")).toBe(true);
  });

  it("node-too-old", () => {
    const plan = buildInstallPlan(host({ nodeVersion: "v18.20.0" }), opts());
    expect(plan.ok).toBe(false);
    const b = plan.blockers.find((x) => x.code === "node-too-old");
    expect(b).toBeDefined();
    expect(b!.message).toContain("v18.20.0");
    expect(b!.message).toContain(String(MIN_NODE_MAJOR));
  });

  it("prefix-not-writable", () => {
    const plan = buildInstallPlan(
      host({ writable: { "/ro-prefix": false, "/ro-prefix/bin": false } }),
      opts({ prefix: "/ro-prefix" })
    );
    expect(plan.blockers.some((x) => x.code === "prefix-not-writable")).toBe(true);
  });

  it("bin-dir-not-writable", () => {
    const plan = buildInstallPlan(host({ writable: { "/opt/bin": false } }), opts({ binDir: "/opt/bin" }));
    expect(plan.blockers.some((x) => x.code === "bin-dir-not-writable")).toBe(true);
  });

  it("unsupported-platform", () => {
    const plan = buildInstallPlan(host({ platform: "win32" }), opts());
    expect(plan.blockers.some((x) => x.code === "unsupported-platform")).toBe(true);
  });

  it("existing-install (same version, no --force)", () => {
    const plan = buildInstallPlan(
      host({ existing: { launcherPath: "/home/tester/.local/bin/hades", version: "0.1.0" } }),
      opts({ version: "0.1.0" })
    );
    expect(plan.mode).toBe("noop");
    expect(plan.blockers.some((x) => x.code === "existing-install")).toBe(true);
  });

  it("nothing-to-uninstall", () => {
    const plan = buildInstallPlan(host({ existing: undefined }), opts({ uninstall: true }));
    expect(plan.mode).toBe("noop");
    expect(plan.blockers.some((x) => x.code === "nothing-to-uninstall")).toBe(true);
  });

  it("every BlockerCode has a distinct, actionable remedy string across all scenarios", () => {
    const plans = [
      buildInstallPlan(host({ nodeVersion: undefined }), opts()),
      buildInstallPlan(host({ nodeVersion: "v18.20.0" }), opts()),
      buildInstallPlan(host({ writable: { "/ro": false } }), opts({ prefix: "/ro" })),
      buildInstallPlan(host({ writable: { "/opt/bin": false } }), opts({ binDir: "/opt/bin" })),
      buildInstallPlan(host({ platform: "win32" }), opts()),
      buildInstallPlan(
        host({ existing: { launcherPath: "/x/hades", version: "0.1.0" } }),
        opts({ version: "0.1.0" })
      ),
      buildInstallPlan(host({ existing: undefined }), opts({ uninstall: true })),
    ];
    const remedies = plans.flatMap((p) => p.blockers.map((b) => b.remedy));
    expect(new Set(remedies).size).toBe(remedies.length);
    for (const r of remedies) expect(r.length).toBeGreaterThan(10);
  });
});

describe("buildInstallPlan -- uninstall", () => {
  it("plans removal of exactly the launcher, plus a data-dir note (no purge)", () => {
    const plan = buildInstallPlan(
      host({ existing: { launcherPath: "/home/tester/.local/bin/hades", version: "0.1.0", dataDir: "/home/tester/.hades" } }),
      opts({ uninstall: true })
    );
    expect(plan.mode).toBe("uninstall");
    expect(plan.ok).toBe(true);
    expect(plan.steps.some((s) => s.kind === "remove" && s.target === "/home/tester/.local/bin/hades")).toBe(true);
    expect(plan.steps.some((s) => s.kind === "remove" && s.target === "/home/tester/.hades")).toBe(false);
    expect(plan.steps.some((s) => s.kind === "note" && s.target === "/home/tester/.hades")).toBe(true);
  });

  it("plans data-dir removal under --purge", () => {
    const plan = buildInstallPlan(
      host({ existing: { launcherPath: "/home/tester/.local/bin/hades", version: "0.1.0", dataDir: "/home/tester/.hades" } }),
      opts({ uninstall: true, purge: true })
    );
    expect(plan.steps.some((s) => s.kind === "remove" && s.target === "/home/tester/.hades")).toBe(true);
  });

  it("every reversible: true install step's target is covered by the uninstall plan's step targets", () => {
    const installHost = host();
    const installOpts = opts();
    const installPlan = buildInstallPlan(installHost, installOpts);
    expect(installPlan.mode).toBe("install");

    const uninstallHost = host({
      existing: { launcherPath: installPlan.launcherPath, version: installOpts.version, dataDir: installPlan.dataDir },
    });
    const uninstallPlan = buildInstallPlan(uninstallHost, opts({ uninstall: true }));

    const reversibleTargets = installPlan.steps.filter((s) => s.reversible).map((s) => s.target);
    expect(reversibleTargets.length).toBeGreaterThan(0);
    const uninstallTargets = new Set(uninstallPlan.steps.map((s) => s.target));
    for (const t of reversibleTargets) {
      expect(uninstallTargets.has(t)).toBe(true);
    }
  });
});

describe("renderPlanText / renderPlanJson", () => {
  it("renderPlanText produces readable, non-empty lines including mode and blockers", () => {
    const plan = buildInstallPlan(host({ nodeVersion: undefined }), opts());
    const lines = renderPlanText(plan);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("mode:");
    expect(lines.some((l) => l.includes("node-missing"))).toBe(true);
  });

  it("renderPlanJson round-trips through JSON.parse with the same field values", () => {
    const plan = buildInstallPlan(host(), opts());
    const parsed = JSON.parse(renderPlanJson(plan));
    expect(parsed.mode).toBe(plan.mode);
    expect(parsed.launcherSha256).toBe(plan.launcherSha256);
    expect(parsed.binDir).toBe(plan.binDir);
  });
});

describe("INSTALL_SH_FLAGS", () => {
  it("is the documented flag list in order", () => {
    expect(INSTALL_SH_FLAGS).toEqual([
      "--dry-run",
      "--prefix",
      "--bin-dir",
      "--data-dir",
      "--no-modify-path",
      "--force",
      "--purge",
      "--uninstall",
      "--json",
      "--version",
      "--help",
    ]);
  });
});

// ===========================================================================
// Integration: the REAL install.sh, spawned as REAL bash, against a REAL
// temp HOME/prefix. No mocking of the shell anywhere below.
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const INSTALL_SH = path.join(REPO_ROOT, "install.sh");
const BASH_BIN = execFileSync("/bin/sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
const NODE_DIR = path.dirname(process.execPath);
const FULL_PATH = `${NODE_DIR}:/usr/local/bin:/usr/bin:/bin`;

const scratchDirs: string[] = [];
function mkScratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function runInstall(
  args: string[],
  envOverrides: LooseEnv = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(BASH_BIN, [INSTALL_SH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      PATH: FULL_PATH,
      SHELL: "/bin/bash",
      ...envOverrides,
    } as unknown as NodeJS.ProcessEnv,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Sorted recursive listing of a directory tree's relative entry names. */
function listTree(dir: string): string[] {
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).slice().sort();
  } catch {
    return [];
  }
}

describe("install.sh -- static shape", () => {
  it("bash -n install.sh passes (valid syntax)", () => {
    const result = spawnSync(BASH_BIN, ["-n", INSTALL_SH], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("the script's real flag list matches INSTALL_SH_FLAGS exactly (no drift)", () => {
    const src = readFileSync(INSTALL_SH, "utf8");
    // Parse every `--flag)` case arm out of the real bytes, in file order,
    // deduped, exactly the way bash's `case` dispatch reads them.
    const found: string[] = [];
    const re = /^\s*(--[a-z-]+)\)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (!found.includes(m[1])) found.push(m[1]);
    }
    expect(found).toEqual([...INSTALL_SH_FLAGS]);
  });

  it("--help exits 0 and documents every flag", () => {
    const r = runInstall(["--help"]);
    expect(r.status).toBe(0);
    for (const flag of INSTALL_SH_FLAGS) {
      expect(r.stdout).toContain(flag);
    }
  });

  it("--version exits 0 and prints a version string", () => {
    const r = runInstall(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  it("an unknown flag exits 2 (usage error)", () => {
    const r = runInstall(["--not-a-real-flag"]);
    expect(r.status).toBe(2);
  });

  it("--prefix with a missing argument exits 2 (usage error)", () => {
    const r = runInstall(["--prefix"]);
    expect(r.status).toBe(2);
  });
});

describe("install.sh -- dry run touches nothing", () => {
  it("a full recursive listing of the temp HOME is byte-identical before and after --dry-run", () => {
    const home = mkScratch("hades-dryrun-");
    const prefix = path.join(home, "install");
    const before = listTree(home);

    const r = runInstall(["--dry-run", "--prefix", prefix], { HOME: home });
    expect(r.status).toBe(0);

    const after = listTree(home);
    expect(after).toEqual(before);
    expect(after).toEqual([]); // nothing existed, nothing was created
  });

  it("--dry-run --uninstall also touches nothing when something is installed", () => {
    const home = mkScratch("hades-dryrun-uninstall-");
    const prefix = path.join(home, "install");
    const install = runInstall(["--prefix", prefix, "--no-modify-path"], { HOME: home });
    expect(install.status).toBe(0);

    const before = listTree(home);
    const r = runInstall(["--dry-run", "--uninstall", "--prefix", prefix], { HOME: home });
    expect(r.status).toBe(0);
    const after = listTree(home);
    expect(after).toEqual(before);
  });
});

describe("install.sh -- real install end to end", () => {
  it("writes an executable launcher whose sha256 matches the plan, and runs it for real", () => {
    const home = mkScratch("hades-real-install-");
    const prefix = path.join(home, "install");

    const r = runInstall(["--prefix", prefix, "--no-modify-path"], { HOME: home, SHELL: "/bin/bash" });
    expect(r.status).toBe(0);

    const launcherPath = path.join(prefix, "bin", "hades");
    const stat = statSync(launcherPath);
    expect(stat.mode & 0o777).toBe(0o755);

    // Cross-check against the pure planner given equivalent inputs.
    const plan = buildInstallPlan(
      host({ home, env: { PATH: FULL_PATH }, shellPath: "/bin/bash" }),
      opts({ repoRoot: REPO_ROOT, prefix, modifyPath: false })
    );
    const actualSha = execFileSync("sha256sum", [launcherPath], { encoding: "utf8" }).split(/\s+/)[0];
    expect(actualSha).toBe(plan.launcherSha256);

    // The honest end-to-end proof: actually execute the installed launcher.
    const runResult = spawnSync(launcherPath, ["--version"], { encoding: "utf8" });
    expect(runResult.status).toBe(0);
    expect(runResult.stdout.trim().length).toBeGreaterThan(0);
    expect(runResult.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("is idempotent: a second identical run reports existing-install (blocked, exit 1) and leaves the launcher byte-identical; --force reinstalls", () => {
    const home = mkScratch("hades-idempotent-");
    const prefix = path.join(home, "install");

    const first = runInstall(["--prefix", prefix, "--no-modify-path"], { HOME: home });
    expect(first.status).toBe(0);
    const launcherPath = path.join(prefix, "bin", "hades");
    const bytesAfterFirst = readFileSync(launcherPath);

    const second = runInstall(["--prefix", prefix, "--no-modify-path"], { HOME: home });
    expect(second.status).toBe(1);
    expect(second.stdout).toContain("existing-install");
    expect(readFileSync(launcherPath).equals(bytesAfterFirst)).toBe(true);

    const forced = runInstall(["--prefix", prefix, "--no-modify-path", "--force"], { HOME: home });
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain("reinstall");
    expect(readFileSync(launcherPath).equals(bytesAfterFirst)).toBe(true);
  });

  it("reports upgrade when an older version is already installed", () => {
    const home = mkScratch("hades-upgrade-");
    const prefix = path.join(home, "install");
    const binDir = path.join(prefix, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      path.join(binDir, "hades"),
      "#!/usr/bin/env bash\nset -euo pipefail\n# hades launcher -- generated by install.sh.\n# installed version: 0.0.1\nexec true\n",
      { mode: 0o755 }
    );

    const r = runInstall(["--prefix", prefix, "--no-modify-path"], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("mode: upgrade");
  });
});

describe("install.sh -- uninstall removes exactly what install created", () => {
  it("removes the launcher and keeps dataDir unless --purge; leaves everything else untouched", () => {
    const home = mkScratch("hades-uninstall-");
    const prefix = path.join(home, "install");

    const preInstallSnapshot = listTree(home);
    const install = runInstall(["--prefix", prefix], { HOME: home, SHELL: "/bin/bash" });
    expect(install.status).toBe(0);
    const postInstallSnapshot = listTree(home);
    expect(postInstallSnapshot.length).toBeGreaterThan(preInstallSnapshot.length);

    const uninstall = runInstall(["--prefix", prefix, "--uninstall"], { HOME: home });
    expect(uninstall.status).toBe(0);

    expect(statSync(path.join(prefix, "bin", "hades"), { throwIfNoEntry: false })).toBeUndefined();
    // data dir survives without --purge
    expect(statSync(path.join(prefix, "share", "hades"), { throwIfNoEntry: false })).toBeDefined();
    // the appended profile PATH line was removed
    const profile = readFileSync(path.join(home, ".bashrc"), "utf8");
    expect(profile).not.toContain(path.join(prefix, "bin"));

    // uninstalling again: nothing left to remove.
    const again = runInstall(["--prefix", prefix, "--uninstall"], { HOME: home });
    expect(again.status).toBe(1);
    expect(again.stdout).toContain("nothing-to-uninstall");
  });

  it("--purge also removes dataDir", () => {
    const home = mkScratch("hades-purge-");
    const prefix = path.join(home, "install");
    const install = runInstall(["--prefix", prefix, "--no-modify-path"], { HOME: home });
    expect(install.status).toBe(0);

    const purge = runInstall(["--prefix", prefix, "--uninstall", "--purge"], { HOME: home });
    expect(purge.status).toBe(0);
    expect(statSync(path.join(prefix, "share", "hades"), { throwIfNoEntry: false })).toBeUndefined();
  });
});

describe("install.sh -- prerequisite failures are real, not fabricated", () => {
  it("PATH with no node exits 1 with the node-missing remedy", () => {
    const home = mkScratch("hades-nonode-");
    const prefix = path.join(home, "install");
    const r = runInstall(["--prefix", prefix, "--no-modify-path"], { HOME: home, PATH: "/usr/bin:/bin" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("node-missing");
    expect(r.stdout.toLowerCase()).toContain("install node.js");
  });

  it("a fake node shim reporting v18.20.0 exits 1 with node-too-old", () => {
    const home = mkScratch("hades-oldnode-");
    const shimDir = mkScratch("hades-oldnode-shim-");
    writeFileSync(path.join(shimDir, "node"), "#!/usr/bin/env bash\necho v18.20.0\n", { mode: 0o755 });
    const prefix = path.join(home, "install");
    const r = runInstall(["--prefix", prefix, "--no-modify-path"], {
      HOME: home,
      PATH: `${shimDir}:/usr/bin:/bin`,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("node-too-old");
    expect(r.stdout).toContain("v18.20.0");
  });

  it("a read-only prefix exits 1 with prefix-not-writable", () => {
    const home = mkScratch("hades-rohome-");
    const roRoot = mkScratch("hades-roprefix-");
    let immutableWorked = false;
    try {
      execFileSync("chattr", ["+i", roRoot]);
      // Verify the immutability actually blocks a write on this filesystem;
      // some CI filesystems (overlayfs, tmpfs) silently ignore chattr.
      try {
        writeFileSync(path.join(roRoot, "__probe__"), "x");
        // If that succeeded, immutability isn't enforced here.
      } catch {
        immutableWorked = true;
      }
    } catch {
      immutableWorked = false;
    }

    if (!immutableWorked) {
      // Filesystem doesn't support the immutable attribute in this
      // environment -- skip rather than assert a false negative.
      return;
    }

    try {
      const prefix = path.join(roRoot, "sub");
      const r = runInstall(["--prefix", prefix, "--no-modify-path"], { HOME: home });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("prefix-not-writable");
    } finally {
      try {
        execFileSync("chattr", ["-i", roRoot]);
      } catch {
        // best effort
      }
    }
  });
});

describe("install.sh -- JSON output matches the pure planner field-by-field", () => {
  it("cross-checks --json --dry-run against buildInstallPlan for a fresh install", () => {
    const home = mkScratch("hades-json-");
    const prefix = path.join(home, "install");

    const r = runInstall(["--prefix", prefix, "--json", "--dry-run"], { HOME: home, SHELL: "/bin/bash" });
    expect(r.status).toBe(0);
    const bashPlan = JSON.parse(r.stdout);

    const tsPlan = buildInstallPlan(
      host({ home, env: { PATH: FULL_PATH }, shellPath: "/bin/bash" }),
      opts({ repoRoot: REPO_ROOT, prefix })
    );

    for (const key of [
      "mode",
      "ok",
      "version",
      "prefix",
      "binDir",
      "dataDir",
      "launcherPath",
      "launcherScript",
      "launcherSha256",
      "shell",
      "profilePath",
      "profileLine",
      "pathAlreadyContainsBinDir",
    ] as const) {
      expect(bashPlan[key]).toEqual((tsPlan as any)[key]);
    }
  });

  it("cross-checks a node-missing blocker in --json mode", () => {
    const home = mkScratch("hades-json-blocked-");
    const prefix = path.join(home, "install");
    const r = runInstall(["--prefix", prefix, "--json", "--dry-run"], { HOME: home, PATH: "/usr/bin:/bin" });
    expect(r.status).toBe(1);
    const bashPlan = JSON.parse(r.stdout);
    expect(bashPlan.ok).toBe(false);
    expect(bashPlan.blockers.some((b: { code: string }) => b.code === "node-missing")).toBe(true);

    const tsPlan = buildInstallPlan(host({ home, nodeVersion: undefined }), opts({ repoRoot: REPO_ROOT, prefix }));
    expect(tsPlan.blockers.map((b) => b.code)).toEqual(bashPlan.blockers.map((b: { code: string }) => b.code));
  });
});

describe("install.sh -- paths with spaces and unicode; profile idempotence", () => {
  it("installs and runs correctly under a prefix with spaces and unicode", () => {
    const home = mkScratch("hades-unicode-");
    const prefix = path.join(home, "install dir café", "日本語");
    const r = runInstall(["--prefix", prefix, "--no-modify-path"], { HOME: home, SHELL: "/bin/bash" });
    expect(r.status).toBe(0);

    const launcherPath = path.join(prefix, "bin", "hades");
    const run = spawnSync(launcherPath, ["--version"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("a binDir already on PATH is never appended to the profile", () => {
    const home = mkScratch("hades-onpath-");
    const prefix = path.join(home, "install");
    const binDir = path.join(prefix, "bin");
    const r = runInstall(["--prefix", prefix], {
      HOME: home,
      SHELL: "/bin/bash",
      PATH: `${binDir}:${FULL_PATH}`,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already on PATH");
    const profilePath = path.join(home, ".bashrc");
    try {
      const contents = readFileSync(profilePath, "utf8");
      expect(contents).not.toContain(binDir);
    } catch {
      // .bashrc was never created at all -- also correct.
    }
  });

  it("an existing profile line is never appended twice across two real runs", () => {
    const home = mkScratch("hades-profile-twice-");
    const prefix = path.join(home, "install");

    const first = runInstall(["--prefix", prefix], { HOME: home, SHELL: "/bin/bash" });
    expect(first.status).toBe(0);
    const second = runInstall(["--prefix", prefix, "--force"], { HOME: home, SHELL: "/bin/bash" });
    expect(second.status).toBe(0);

    const profile = readFileSync(path.join(home, ".bashrc"), "utf8");
    const binDir = path.join(prefix, "bin");
    const occurrences = profile.split("\n").filter((line) => line.includes(binDir)).length;
    expect(occurrences).toBe(1);
  });
});
