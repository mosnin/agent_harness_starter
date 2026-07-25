/**
 * Tests for `src/hades/install/windows.ts` (the pure Windows install
 * planner + the real PowerShell tokenizer/auditor) AND, in the same file
 * (these are the only files this build owns), integration coverage of the
 * real `install.ps1` at the repo root.
 *
 * The planner tests inject `WindowsHostProbe` literals directly -- no
 * filesystem, no child_process, no clock. The tokenizer/auditor tests run
 * unconditionally against the REAL on-disk `install.ps1` bytes, which is
 * what lets the Windows installer be genuinely verified even on a Linux box
 * with no `pwsh`. The `install.ps1` execution tests spawn the REAL `pwsh`
 * when it is on PATH and assert on its REAL stdout/exit code/filesystem
 * effects; when `pwsh` is not available they record an explicit, non-empty
 * `skipReason` and assert *that* -- never a pass that was not observed.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addToUserPath,
  auditInstallPs1,
  buildWindowsInstallPlan,
  cmdShimScript,
  parsePowerShellScript,
  ps1ShimScript,
  removeFromUserPath,
  renderWindowsPlanJson,
  renderWindowsPlanText,
  resolveWindowsTargets,
  type WindowsBlockerCode,
  type WindowsHostProbe,
  type WindowsInstallOptions,
} from "../windows";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * `NodeJS.ProcessEnv` is required (not optional) to declare `NODE_ENV` in
 * this repo's merged global types, so every fixture env goes through this
 * helper instead of a bare object literal.
 */
function mkEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides } as NodeJS.ProcessEnv;
}

function mkProbe(overrides: Partial<WindowsHostProbe> = {}): WindowsHostProbe {
  return {
    userProfile: "C:\\Users\\tester",
    localAppData: "C:\\Users\\tester\\AppData\\Local",
    appData: "C:\\Users\\tester\\AppData\\Roaming",
    env: mkEnv(),
    nodeVersion: "v20.11.0",
    userPath: ["C:\\Windows\\system32", "C:\\Windows"],
    psVersion: "7.4.1",
    executionPolicy: "RemoteSigned",
    isElevated: false,
    ...overrides,
  };
}

function mkOpts(overrides: Partial<WindowsInstallOptions> = {}): WindowsInstallOptions {
  return { version: "0.1.0", repoRoot: "C:\\repo", ...overrides };
}

// ===========================================================================
// resolveWindowsTargets
// ===========================================================================

describe("resolveWindowsTargets", () => {
  it("precedence: explicit option wins over env and %LOCALAPPDATA%", () => {
    const probe = mkProbe({ env: mkEnv({ HADES_INSTALL_DIR: "C:\\FromEnv" }) });
    const { installDir } = resolveWindowsTargets(probe, mkOpts({ installDir: "C:\\FromOption" }));
    expect(installDir).toBe("C:\\FromOption");
  });

  it("precedence: HADES_INSTALL_DIR wins over %LOCALAPPDATA% when no explicit option", () => {
    const probe = mkProbe({ env: mkEnv({ HADES_INSTALL_DIR: "C:\\FromEnv" }) });
    const { installDir } = resolveWindowsTargets(probe, mkOpts());
    expect(installDir).toBe("C:\\FromEnv");
  });

  it("precedence: %LOCALAPPDATA%\\Programs\\Hades is the last-resort default", () => {
    const probe = mkProbe({ localAppData: "C:\\Users\\tester\\AppData\\Local" });
    const { installDir, shimDir } = resolveWindowsTargets(probe, mkOpts());
    expect(installDir).toBe("C:\\Users\\tester\\AppData\\Local\\Programs\\Hades");
    expect(shimDir).toBe("C:\\Users\\tester\\AppData\\Local\\Programs\\Hades\\bin");
  });

  it("a missing %LOCALAPPDATA% (and no override) resolves to '' -- never a bogus guessed path", () => {
    const probe = mkProbe({ localAppData: undefined, env: mkEnv() });
    const { installDir, shimDir } = resolveWindowsTargets(probe, mkOpts());
    expect(installDir).toBe("");
    expect(shimDir).toBe("");
  });

  it("dataDir precedence: explicit option > HADES_DATA_DIR > %APPDATA% > %LOCALAPPDATA% > %USERPROFILE%\\.hades", () => {
    const full = mkProbe();
    expect(resolveWindowsTargets(full, mkOpts({ dataDir: "C:\\Explicit" })).dataDir).toBe("C:\\Explicit");

    const withEnv = mkProbe({ env: mkEnv({ HADES_DATA_DIR: "C:\\FromEnvData" }) });
    expect(resolveWindowsTargets(withEnv, mkOpts()).dataDir).toBe("C:\\FromEnvData");

    const appDataOnly = mkProbe({ localAppData: undefined });
    expect(resolveWindowsTargets(appDataOnly, mkOpts()).dataDir).toBe("C:\\Users\\tester\\AppData\\Roaming\\hades");

    const localAppDataOnly = mkProbe({ appData: undefined });
    expect(resolveWindowsTargets(localAppDataOnly, mkOpts()).dataDir).toBe("C:\\Users\\tester\\AppData\\Local\\hades");

    const neither = mkProbe({ appData: undefined, localAppData: undefined });
    expect(resolveWindowsTargets(neither, mkOpts()).dataDir).toBe("C:\\Users\\tester\\.hades");
  });

  it("spaces and non-ASCII in %USERPROFILE%-derived directories survive round-trip", () => {
    const probe = mkProbe({
      userProfile: "C:\\Users\\José García",
      localAppData: "C:\\Users\\José García\\AppData\\Local",
      appData: "C:\\Users\\José García\\AppData\\Roaming",
    });
    const targets = resolveWindowsTargets(probe, mkOpts());
    expect(targets.installDir).toBe("C:\\Users\\José García\\AppData\\Local\\Programs\\Hades");
    expect(targets.shimDir).toBe("C:\\Users\\José García\\AppData\\Local\\Programs\\Hades\\bin");
    expect(targets.dataDir).toBe("C:\\Users\\José García\\AppData\\Roaming\\hades");
  });

  it("trims a trailing backslash on explicit installDir/dataDir", () => {
    const probe = mkProbe();
    const targets = resolveWindowsTargets(probe, mkOpts({ installDir: "C:\\Custom\\Hades\\", dataDir: "C:\\Custom\\Data\\" }));
    expect(targets.installDir).toBe("C:\\Custom\\Hades");
    expect(targets.dataDir).toBe("C:\\Custom\\Data");
  });
});

// ===========================================================================
// addToUserPath / removeFromUserPath -- PATH surgery
// ===========================================================================

describe("addToUserPath", () => {
  it("is order-preserving and appends at the end", () => {
    const r = addToUserPath(["C:\\A", "C:\\B"], "C:\\C");
    expect(r.changed).toBe(true);
    expect(r.next).toEqual(["C:\\A", "C:\\B", "C:\\C"]);
  });

  it("is idempotent: adding an already-present entry reports changed: false", () => {
    const first = addToUserPath(["C:\\A"], "C:\\Hades\\bin");
    const second = addToUserPath(first.next, "C:\\Hades\\bin");
    expect(second.changed).toBe(false);
    expect(second.next).toEqual(first.next);
  });

  it("treats case and a trailing backslash as the same entry", () => {
    const r = addToUserPath(["C:\\Hades\\bin"], "c:\\hades\\bin\\");
    expect(r.changed).toBe(false);
    expect(r.next).toEqual(["C:\\Hades\\bin"]);
  });

  it("does NOT treat a suffixed sibling directory as the same entry", () => {
    const r = addToUserPath(["C:\\Hades\\bin"], "C:\\Hades\\bin2");
    expect(r.changed).toBe(true);
    expect(r.next).toEqual(["C:\\Hades\\bin", "C:\\Hades\\bin2"]);
  });

  it("drops empty segments (from a stray ';;' or trailing ';') as hygiene, never a silent truncation of real entries", () => {
    const r = addToUserPath(["C:\\A", "", "C:\\B", ""], "C:\\C");
    expect(r.changed).toBe(true);
    expect(r.next).toEqual(["C:\\A", "C:\\B", "C:\\C"]);
  });

  it("cleans up empty segments even when the target dir is already present", () => {
    const r = addToUserPath(["C:\\A", ""], "C:\\A");
    expect(r.changed).toBe(true);
    expect(r.next).toEqual(["C:\\A"]);
  });

  it("handles a ~2000-character PATH without truncating anything (warning is buildWindowsInstallPlan's job)", () => {
    const longEntries = Array.from({ length: 40 }, (_, i) => `C:\\VeryLongPathEntryForPathLengthWarningTestingNumber${i}\\bin`);
    const r = addToUserPath(longEntries, "C:\\Hades\\bin");
    expect(r.next).toEqual([...longEntries, "C:\\Hades\\bin"]);
    expect(r.next.join(";").length).toBeGreaterThan(1900);
  });
});

describe("removeFromUserPath", () => {
  it("removes exactly the matching entry and never a substring match", () => {
    const r = removeFromUserPath(["C:\\Hades\\bin", "C:\\Hades\\bin2"], "C:\\Hades\\bin");
    expect(r.changed).toBe(true);
    expect(r.next).toEqual(["C:\\Hades\\bin2"]);
  });

  it("is idempotent: removing an absent entry a second time reports changed: false", () => {
    const first = removeFromUserPath(["C:\\A", "C:\\Hades\\bin", "C:\\B"], "C:\\Hades\\bin");
    const second = removeFromUserPath(first.next, "C:\\Hades\\bin");
    expect(second.changed).toBe(false);
    expect(second.next).toEqual(first.next);
  });

  it("matches case- and trailing-backslash-insensitively", () => {
    const r = removeFromUserPath(["c:\\hades\\bin\\"], "C:\\Hades\\bin");
    expect(r.changed).toBe(true);
    expect(r.next).toEqual([]);
  });

  it("drops empty segments even with no match, exercising the trailing ';' case", () => {
    const r = removeFromUserPath(["C:\\A", ""], "C:\\NotThere");
    expect(r.changed).toBe(true);
    expect(r.next).toEqual(["C:\\A"]);
  });
});

// ===========================================================================
// Shim golden tests
// ===========================================================================

describe("cmdShimScript", () => {
  const repoRoot = "C:\\Users\\José García\\code\\repo";
  const script = cmdShimScript({ repoRoot, version: "1.2.3-test" });

  it("starts with @echo off", () => {
    expect(script.startsWith("@echo off")).toBe(true);
  });

  it("uses %* (never %1) to forward all arguments", () => {
    expect(script).toContain("%*");
    expect(script).not.toContain("%1");
  });

  it("quotes the repo path (spaces/non-ASCII survive)", () => {
    expect(script).toContain(`"${repoRoot}\\node_modules`);
    expect(script).toContain(`"${repoRoot}\\src\\hades\\bin\\hades.ts"`);
  });

  it("contains the real version string", () => {
    expect(script).toContain("1.2.3-test");
  });
});

describe("ps1ShimScript", () => {
  const repoRoot = "C:\\Users\\José García\\code\\repo";
  const script = ps1ShimScript({ repoRoot, version: "1.2.3-test" });

  it("forwards @args", () => {
    expect(script).toContain("@args");
  });

  it("propagates a non-zero $LASTEXITCODE", () => {
    expect(script).toContain("exit $LASTEXITCODE");
  });

  it("quotes the repo path (spaces/non-ASCII survive)", () => {
    expect(script).toContain(`"${repoRoot}\\node_modules`);
  });

  it("contains the real version string", () => {
    expect(script).toContain("1.2.3-test");
  });
});

// ===========================================================================
// buildWindowsInstallPlan -- blockers, one per WindowsBlockerCode
// ===========================================================================

function codesOf(plan: ReturnType<typeof buildWindowsInstallPlan>): WindowsBlockerCode[] {
  return plan.blockers.map((b) => b.code);
}

describe("buildWindowsInstallPlan -- every blocker is reachable with an actionable remedy", () => {
  it("node-missing", () => {
    const plan = buildWindowsInstallPlan(mkProbe({ nodeVersion: undefined }), mkOpts());
    expect(codesOf(plan)).toContain("node-missing");
    const b = plan.blockers.find((x) => x.code === "node-missing")!;
    expect(b.remedy.length).toBeGreaterThan(0);
    expect(b.remedy).toMatch(/node/i);
  });

  it("node-too-old", () => {
    const plan = buildWindowsInstallPlan(mkProbe({ nodeVersion: "v16.2.0" }), mkOpts());
    expect(codesOf(plan)).toContain("node-too-old");
  });

  it("no-local-appdata", () => {
    const plan = buildWindowsInstallPlan(mkProbe({ localAppData: undefined, env: mkEnv() }), mkOpts());
    expect(codesOf(plan)).toContain("no-local-appdata");
    expect(plan.installDir).toBe("");
  });

  it("install-dir-not-writable (protected root, not elevated)", () => {
    const plan = buildWindowsInstallPlan(mkProbe({ isElevated: false }), mkOpts({ installDir: "C:\\Program Files\\Hades" }));
    expect(codesOf(plan)).toContain("install-dir-not-writable");
  });

  it("execution-policy yields a runnable remedy command and never suggests -ExecutionPolicy Bypass", () => {
    const plan = buildWindowsInstallPlan(mkProbe({ executionPolicy: "Restricted" }), mkOpts());
    expect(codesOf(plan)).toContain("execution-policy");
    const b = plan.blockers.find((x) => x.code === "execution-policy")!;
    expect(b.remedy).toMatch(/Set-ExecutionPolicy/);
    expect(b.remedy.toLowerCase()).not.toContain("bypass");
  });

  it("elevated-refused by default, with a documented HADES_ALLOW_ELEVATED=1 override", () => {
    const refused = buildWindowsInstallPlan(mkProbe({ isElevated: true }), mkOpts());
    expect(codesOf(refused)).toContain("elevated-refused");
    const b = refused.blockers.find((x) => x.code === "elevated-refused")!;
    expect(b.remedy).toMatch(/HADES_ALLOW_ELEVATED/);

    const overridden = buildWindowsInstallPlan(
      mkProbe({ isElevated: true, env: mkEnv({ HADES_ALLOW_ELEVATED: "1" }) }),
      mkOpts()
    );
    expect(codesOf(overridden)).not.toContain("elevated-refused");
  });

  it("nothing-to-uninstall", () => {
    const plan = buildWindowsInstallPlan(mkProbe(), mkOpts({ uninstall: true }));
    expect(codesOf(plan)).toContain("nothing-to-uninstall");
    expect(plan.mode).toBe("noop");
  });

  it("every blocker has a non-empty message and remedy", () => {
    const scenarios: WindowsHostProbe[] = [
      mkProbe({ nodeVersion: undefined }),
      mkProbe({ nodeVersion: "v10.0.0" }),
      mkProbe({ localAppData: undefined, env: mkEnv() }),
      mkProbe({ executionPolicy: "AllSigned" }),
      mkProbe({ isElevated: true }),
    ];
    for (const probe of scenarios) {
      const plan = buildWindowsInstallPlan(probe, mkOpts());
      for (const b of plan.blockers) {
        expect(b.message.length).toBeGreaterThan(0);
        expect(b.remedy.length).toBeGreaterThan(0);
      }
    }
  });
});

// ===========================================================================
// buildWindowsInstallPlan -- mode determination
// ===========================================================================

describe("buildWindowsInstallPlan -- mode determination", () => {
  it("mode: install (shimDir not yet on PATH)", () => {
    const plan = buildWindowsInstallPlan(mkProbe(), mkOpts());
    expect(plan.mode).toBe("install");
    expect(plan.pathAlreadyContainsShimDir).toBe(false);
  });

  it("mode: upgrade (shimDir already on PATH, no --force)", () => {
    const shimDir = "C:\\Users\\tester\\AppData\\Local\\Programs\\Hades\\bin";
    const plan = buildWindowsInstallPlan(mkProbe({ userPath: ["C:\\Windows", shimDir] }), mkOpts());
    expect(plan.mode).toBe("upgrade");
  });

  it("mode: reinstall (shimDir already on PATH, --force)", () => {
    const shimDir = "C:\\Users\\tester\\AppData\\Local\\Programs\\Hades\\bin";
    const plan = buildWindowsInstallPlan(mkProbe({ userPath: ["C:\\Windows", shimDir] }), mkOpts({ force: true }));
    expect(plan.mode).toBe("reinstall");
  });

  it("mode: uninstall removes exactly the created shims plus the PATH entry, and nothing else", () => {
    const shimDir = "C:\\Users\\tester\\AppData\\Local\\Programs\\Hades\\bin";
    const probe = mkProbe({ userPath: ["C:\\Windows", shimDir, "C:\\Other"] });
    const plan = buildWindowsInstallPlan(probe, mkOpts({ uninstall: true }));

    expect(plan.mode).toBe("uninstall");
    expect(plan.ok).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual([
      "remove-cmd-shim",
      "remove-ps1-shim",
      "set-user-path-remove",
      "note-data-dir-preserved",
    ]);
    expect(plan.userPathAfter).toEqual(["C:\\Windows", "C:\\Other"]);
    // Data dir survives without -Purge: no remove step for it.
    expect(plan.steps.find((s) => s.id === "remove-data-dir")).toBeUndefined();
    expect(plan.steps.find((s) => s.id === "note-data-dir-preserved")?.target).toBe(plan.dataDir);
  });

  it("mode: uninstall --purge additionally removes the data directory", () => {
    const shimDir = "C:\\Users\\tester\\AppData\\Local\\Programs\\Hades\\bin";
    const probe = mkProbe({ userPath: [shimDir] });
    const plan = buildWindowsInstallPlan(probe, mkOpts({ uninstall: true, purge: true }));
    expect(plan.steps.map((s) => s.id)).toEqual(["remove-cmd-shim", "remove-ps1-shim", "set-user-path-remove", "remove-data-dir"]);
    expect(plan.steps.find((s) => s.id === "remove-data-dir")?.target).toBe(plan.dataDir);
  });

  it("mode: noop when uninstalling nothing installed", () => {
    const plan = buildWindowsInstallPlan(mkProbe(), mkOpts({ uninstall: true }));
    expect(plan.mode).toBe("noop");
    expect(plan.ok).toBe(false);
  });
});

// ===========================================================================
// buildWindowsInstallPlan -- PATH mutation behavior & warnings
// ===========================================================================

describe("buildWindowsInstallPlan -- PATH mutation", () => {
  it("adds shimDir to userPathAfter when installing and modifyPath is true (default)", () => {
    const plan = buildWindowsInstallPlan(mkProbe(), mkOpts());
    expect(plan.userPathAfter).toContain(plan.shimDir);
    expect(plan.userPathAfter).toEqual([...mkProbe().userPath, plan.shimDir]);
  });

  it("-NoModifyPath (modifyPath: false) leaves userPathAfter untouched", () => {
    const probe = mkProbe();
    const plan = buildWindowsInstallPlan(probe, mkOpts({ modifyPath: false }));
    expect(plan.userPathAfter).toEqual(probe.userPath);
    expect(plan.steps.find((s) => s.id === "note-path-not-modified")).toBeDefined();
  });

  it("warns (never truncates) when the resulting PATH nears the legacy length limit", () => {
    const longEntries = Array.from({ length: 45 }, (_, i) => `C:\\VeryLongPathEntryForPathLengthWarningTestingNumber${i}\\bin`);
    const probe = mkProbe({ userPath: longEntries });
    const plan = buildWindowsInstallPlan(probe, mkOpts());
    expect(plan.userPathAfter).toEqual([...longEntries, plan.shimDir]);
    expect(plan.warnings.some((w) => /2048/.test(w))).toBe(true);
  });
});

// ===========================================================================
// Rendering
// ===========================================================================

describe("renderWindowsPlanText / renderWindowsPlanJson", () => {
  it("renderWindowsPlanText produces non-empty, readable lines including the mode and blockers", () => {
    const plan = buildWindowsInstallPlan(mkProbe({ nodeVersion: undefined }), mkOpts());
    const lines = renderWindowsPlanText(plan);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("install");
    expect(lines.some((l) => l.includes("node-missing"))).toBe(true);
  });

  it("renderWindowsPlanJson round-trips through JSON.parse with all top-level fields", () => {
    const plan = buildWindowsInstallPlan(mkProbe(), mkOpts());
    const parsed = JSON.parse(renderWindowsPlanJson(plan));
    for (const key of [
      "mode",
      "ok",
      "version",
      "installDir",
      "shimDir",
      "dataDir",
      "cmdShimPath",
      "ps1ShimPath",
      "pathAlreadyContainsShimDir",
      "userPathAfter",
      "steps",
      "blockers",
      "warnings",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.mode).toBe(plan.mode);
  });
});

// ===========================================================================
// parsePowerShellScript -- the real character-level tokenizer
// ===========================================================================

describe("parsePowerShellScript -- tokenizer correctness", () => {
  it("strips # line comments and <# #> block comments (no false keyword matches)", () => {
    const src = [
      "# New-Item should not count here",
      "<# block comment mentions Remove-Item too #>",
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
    ].join("\n");
    const model = parsePowerShellScript(src);
    expect(model.strictModeSet).toBe(true);
    expect(model.errorActionPreference).toBe("Stop");
    expect(model.unguardedMutations).toEqual([]);
    expect(model.dryRunGuardedStatements).toBe(0);
  });

  it("distinguishes single-quoted (no escapes but '') from double-quoted (backtick + \"\") strings, no false positives", () => {
    const src = [
      "$a = 'it''s a test with New-Item inside'",
      "$b = \"she said `\"hi`\" and New-Item too\"",
      "$c = \"double doubled \"\"quote\"\" test\"",
      "Set-StrictMode -Version Latest",
    ].join("\n");
    const model = parsePowerShellScript(src);
    expect(model.strictModeSet).toBe(true);
    expect(model.unguardedMutations).toEqual([]);
  });

  it("handles $(...) subexpressions inside double-quoted strings, including a nested single-quoted string", () => {
    const src = [
      "$x = \"value: $(Get-Something 'inner literal New-Item, not real')\"",
      "Set-StrictMode -Version Latest",
    ].join("\n");
    const model = parsePowerShellScript(src);
    expect(model.strictModeSet).toBe(true);
    expect(model.unguardedMutations).toEqual([]);
  });

  it("handles here-strings (@\"...\"@ and @'...'@) without false keyword matches", () => {
    const src = [
      '$help = @"',
      "Usage: New-Item should not be flagged here.",
      'Multi-line "quotes" are fine too.',
      '"@',
      "$lit = @'",
      "Remove-Item literally in a here-string, no interpolation.",
      "'@",
      "Set-StrictMode -Version Latest",
    ].join("\n");
    const model = parsePowerShellScript(src);
    expect(model.strictModeSet).toBe(true);
    expect(model.unguardedMutations).toEqual([]);
  });

  it("parses param() declarations: types, [switch], and default values", () => {
    const src = ["param(", '    [Parameter()]', '    [string]$Name = "world",', "", "    [switch]$Verbose,", "", "    [int]$Count = 3", ")"].join(
      "\n"
    );
    const model = parsePowerShellScript(src);
    expect(model.params).toEqual([
      { name: "Name", type: "string", isSwitch: false, defaultValue: '"world"' },
      { name: "Verbose", type: "switch", isSwitch: true, defaultValue: undefined },
      { name: "Count", type: "int", isSwitch: false, defaultValue: "3" },
    ]);
  });

  it("finds function names and attributes a mutation to a DryRun guard at any ancestor depth", () => {
    const src = [
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      "function Do-Thing {",
      "    if ($true) {",
      "        if (-not $DryRun) {",
      '            New-Item -ItemType Directory -Path "C:\\x"',
      "        }",
      "    }",
      "}",
      'Remove-Item -LiteralPath "C:\\y"',
    ].join("\n");
    const model = parsePowerShellScript(src);
    expect(model.functions).toEqual(["Do-Thing"]);
    expect(model.dryRunGuardedStatements).toBe(1);
    expect(model.unguardedMutations).toHaveLength(1);
    expect(model.unguardedMutations[0]).toMatch(/^\d+: Remove-Item$/);
  });

  it("extracts every [Environment]::SetEnvironmentVariable scope argument, deduped in order", () => {
    const src = [
      "if (-not $DryRun) {",
      "  [Environment]::SetEnvironmentVariable('Path', $p, 'User')",
      "  [Environment]::SetEnvironmentVariable('Path', $q, 'User')",
      "}",
      "[Environment]::SetEnvironmentVariable('Path', $r, 'Machine')",
    ].join("\n");
    const model = parsePowerShellScript(src);
    expect(model.usesSetEnvironmentVariable).toBe(true);
    expect(model.environmentVariableScopes).toEqual(["User", "Machine"]);
    expect(model.dryRunGuardedStatements).toBe(2);
    expect(model.unguardedMutations).toHaveLength(1);
    expect(model.unguardedMutations[0]).toContain("[Environment]::SetEnvironmentVariable");
  });
});

// ===========================================================================
// auditInstallPs1 -- the REAL install.ps1, and 8 deliberately mutated copies
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const INSTALL_PS1 = path.join(REPO_ROOT, "install.ps1");
const REAL_PS1_SOURCE = readFileSync(INSTALL_PS1, "utf8");

function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error(`test setup error: anchor not found: ${JSON.stringify(needle)}`);
  return text.slice(0, idx).split("\n").length;
}

describe("auditInstallPs1 -- the real install.ps1", () => {
  const result = auditInstallPs1(REAL_PS1_SOURCE);

  it("passes its own audit with zero findings", () => {
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("every documented -Param is present with the correct switch/typed-ness", () => {
    const byName = new Map(result.model.params.map((p) => [p.name, p]));
    expect(byName.get("InstallDir")?.isSwitch).toBe(false);
    expect(byName.get("InstallDir")?.type).toBe("string");
    expect(byName.get("DataDir")?.isSwitch).toBe(false);
    expect(byName.get("DataDir")?.type).toBe("string");
    expect(byName.get("Version")?.isSwitch).toBe(false);
    expect(byName.get("Version")?.type).toBe("string");
    for (const sw of ["DryRun", "Force", "Purge", "Uninstall", "NoModifyPath", "Json", "Help"]) {
      expect(byName.get(sw)?.isSwitch).toBe(true);
    }
  });

  it("Set-StrictMode is set and $ErrorActionPreference is exactly 'Stop'", () => {
    expect(result.model.strictModeSet).toBe(true);
    expect(result.model.errorActionPreference).toBe("Stop");
  });

  it("environmentVariableScopes is exactly ['User']", () => {
    expect(result.model.usesSetEnvironmentVariable).toBe(true);
    expect(result.model.environmentVariableScopes).toEqual(["User"]);
  });

  it("unguardedMutations is empty -- every mutating statement is DryRun-guarded", () => {
    expect(result.model.unguardedMutations).toEqual([]);
    expect(result.model.dryRunGuardedStatements).toBeGreaterThan(0);
  });
});

describe("auditInstallPs1 -- the auditor has teeth (8 deliberately mutated copies)", () => {
  it("1. dropped Set-StrictMode -> strict-mode-missing at line 1", () => {
    const mutated = REAL_PS1_SOURCE.replace("Set-StrictMode -Version Latest\n", "");
    const { ok, findings } = auditInstallPs1(mutated);
    expect(ok).toBe(false);
    expect(findings).toContainEqual(expect.objectContaining({ code: "strict-mode-missing", severity: "error", line: 1 }));
  });

  it("2. 'Machine' scope -> environment-scope-not-user at the exact call's line", () => {
    const anchor = "[Environment]::SetEnvironmentVariable('Path', ($UserPathAfter -join ';'), 'User')";
    const mutated = REAL_PS1_SOURCE.replace(anchor, anchor.replace("'User'", "'Machine'"));
    expect(mutated).not.toBe(REAL_PS1_SOURCE);
    const expectedLine = lineOf(mutated, "'Machine')");
    const { ok, findings } = auditInstallPs1(mutated);
    expect(ok).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "environment-scope-not-user", severity: "error", line: expectedLine })
    );
  });

  it("3. a mutation outside the DryRun guard -> unguarded-mutation at its line", () => {
    const injected = 'Remove-Item -LiteralPath "$env:TEMP\\hades-injected-marker" -Force -ErrorAction SilentlyContinue';
    const mutated = REAL_PS1_SOURCE.replace("$ErrorActionPreference = 'Stop'\n", `$ErrorActionPreference = 'Stop'\n${injected}\n`);
    expect(mutated).not.toBe(REAL_PS1_SOURCE);
    const expectedLine = lineOf(mutated, injected);
    const { ok, findings } = auditInstallPs1(mutated);
    expect(ok).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "unguarded-mutation", severity: "error", line: expectedLine })
    );
  });

  it("4. a removed param (-Force) -> param-missing at the param( line", () => {
    const mutated = REAL_PS1_SOURCE.replace("    [switch]$Force,\n", "");
    expect(mutated).not.toBe(REAL_PS1_SOURCE);
    const expectedLine = lineOf(mutated, "param(\n");
    const { ok, findings } = auditInstallPs1(mutated);
    expect(ok).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "param-missing", severity: "error", line: expectedLine, message: expect.stringContaining("-Force") })
    );
  });

  it("5. an unterminated string -> unterminated-string at the opening quote's line", () => {
    const mutated = REAL_PS1_SOURCE.replace('"(dry run: no changes were made)"', '"(dry run: no changes were made)');
    expect(mutated).not.toBe(REAL_PS1_SOURCE);
    const expectedLine = lineOf(mutated, '"(dry run: no changes were made)');
    const { ok, findings } = auditInstallPs1(mutated);
    expect(ok).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "unterminated-string", severity: "error", line: expectedLine })
    );
  });

  it("6. an unbalanced brace -> unbalanced-braces at the unclosed '{' line", () => {
    const mutated = REAL_PS1_SOURCE.replace("if ($Help) {\n    Show-Usage\n    exit 0\n}\n", "if ($Help) {\n    Show-Usage\n    exit 0\n");
    expect(mutated).not.toBe(REAL_PS1_SOURCE);
    const expectedLine = lineOf(mutated, "if ($Help) {");
    const { ok, findings } = auditInstallPs1(mutated);
    expect(ok).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "unbalanced-braces", severity: "error", line: expectedLine })
    );
    // The missing brace must not corrupt DryRun-guard attribution for the rest of the file.
    expect(findings.some((f) => f.code === "unguarded-mutation")).toBe(false);
  });

  it("7. false-positive resistance: a mutation keyword inside a # comment is NOT flagged", () => {
    const injected = "# reminder: New-Item calls happen further down, all guarded by DryRun";
    const mutated = REAL_PS1_SOURCE.replace("$ErrorActionPreference = 'Stop'\n", `$ErrorActionPreference = 'Stop'\n${injected}\n`);
    expect(mutated).not.toBe(REAL_PS1_SOURCE);
    const { ok, findings } = auditInstallPs1(mutated);
    expect(ok).toBe(true);
    expect(findings).toEqual([]);
  });

  it("8. false-positive resistance: a mutation keyword inside a single-quoted string is NOT flagged", () => {
    const injected = "$__testMarker = 'New-Item is mentioned here but not really called'";
    const mutated = REAL_PS1_SOURCE.replace("$ErrorActionPreference = 'Stop'\n", `$ErrorActionPreference = 'Stop'\n${injected}\n`);
    expect(mutated).not.toBe(REAL_PS1_SOURCE);
    const { ok, findings } = auditInstallPs1(mutated);
    expect(ok).toBe(true);
    expect(findings).toEqual([]);
  });
});

// ===========================================================================
// Integration: the REAL install.ps1, spawned via the REAL pwsh when present.
// Real-vs-mock policy: if pwsh resolves, we execute it for real and assert
// on real output. If it does not, we record an explicit, non-empty
// skipReason and assert THAT -- never a pass we did not observe.
// ===========================================================================

function resolvePwsh(): { bin: string } | { skipReason: string } {
  const probe = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? ["pwsh"] : ["-v", "pwsh"], {
    encoding: "utf8",
    shell: process.platform !== "win32",
  });
  if (probe.status === 0 && probe.stdout.trim().length > 0) {
    return { bin: probe.stdout.trim().split(/\r?\n/)[0] };
  }
  return { skipReason: "pwsh was not found on PATH in this environment -- real-execution coverage was skipped, not faked" };
}

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

function listTree(dir: string): string[] {
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).slice().sort();
  } catch {
    return [];
  }
}

describe("install.ps1 -- real pwsh execution (honest skip when pwsh is unavailable)", () => {
  const resolved = resolvePwsh();

  it("records why real execution was or was not exercised", () => {
    if ("skipReason" in resolved) {
      expect(resolved.skipReason.length).toBeGreaterThan(0);
      expect(resolved.skipReason).toMatch(/pwsh/i);
    } else {
      expect(resolved.bin.length).toBeGreaterThan(0);
    }
  });

  it("pwsh -DryRun -Json exits 0, prints parseable JSON, and touches nothing on disk", () => {
    if ("skipReason" in resolved) {
      // Honest skip: no pwsh available on this box. Nothing was executed,
      // and nothing is asserted about behavior that was never observed.
      expect(resolved.skipReason).toContain("pwsh was not found");
      return;
    }

    const scratch = mkScratch("hades-ps1-dryrun-");
    const before = listTree(scratch);
    const result = spawnSync(
      resolved.bin,
      ["-NoProfile", "-NoLogo", "-File", INSTALL_PS1, "-DryRun", "-Json", "-InstallDir", path.join(scratch, "install")],
      { encoding: "utf8", cwd: REPO_ROOT }
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.mode).toBe("install");
    expect(parsed.installDir).toBe(path.join(scratch, "install"));
    const after = listTree(scratch);
    expect(after).toEqual(before);
  });
});
