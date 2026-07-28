/**
 * `hades install <sub>` -- the terminal surface over T1's real installer
 * planner (`../install/plan.ts`) and this team's real portable bundle
 * builder (`../install/bundle.ts`).
 *
 *   hades install plan [--prefix D] [--bin-dir D] [--data-dir D] [--json]
 *   hades install bundle --out DIR [--include FROM:TO[:optional|:executable]] [--json]
 *   hades install verify <bundleDir> [--json] [--allow-extra]
 *   hades install doctor [--json]
 *   hades install help
 *
 * Terminal-free (returns `{ code, lines }`), matching every other surface in
 * `src/hades/cli/*`: no `process.exit`, no direct stdout/stderr writes, no
 * ambient `Date.now()`/`process.env` reads inside the command bodies -- all
 * of that arrives via injected `InstallCommandDeps`. `probeHost` is the one
 * function in this file allowed to read the real machine (platform, real
 * `process.version`, real env, real writability, a real existing-launcher
 * scan); `runInstallCommand` and every `cmd*` helper below it are pure
 * functions of whatever `HostProbe` they're handed, so `doctor`'s output is
 * always directly derivable from the injected probe in tests.
 *
 * Exit codes: 0 ok, 1 blocked/tampered, 2 usage.
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CliResult } from "./cli";
import {
  MIN_NODE_MAJOR,
  buildInstallPlan,
  parseNodeVersion,
  renderPlanJson,
  renderPlanText,
  resolveTargets,
  type HostProbe,
  type InstallOptions,
  type InstallPlan,
} from "../install/plan";
import {
  DEFAULT_BUNDLE_INCLUDES,
  bundleLaunchers,
  stageBundle,
  verifyBundle,
  type BundleManifest,
  type BundleSourceSpec,
  type BundleVerification,
} from "../install/bundle";

export type { HostProbe, InstallPlan };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InstallCommandDeps {
  repoRoot: string;
  version: string;
  env: Record<string, string | undefined>;
  host?: HostProbe;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// defaultInstallDeps / probeHost
// ---------------------------------------------------------------------------

function readPackageVersion(repoRoot: string): string {
  try {
    const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    /* no readable package.json at repoRoot -- fall through to the honest default */
  }
  return "0.0.0";
}

/** Env-driven defaults for `hades install`, mirroring `defaultStateDeps` /
 *  `defaultScheduleDeps`: `repoRoot` honors `HADES_REPO_ROOT`, else the
 *  process's real working directory (the convention `npm run hades` and the
 *  `hades` launcher both invoke from); `version` is read from the real
 *  `package.json` at that root rather than a hardcoded, easily-stale
 *  literal duplicated here. */
export function defaultInstallDeps(env: Record<string, string | undefined> = process.env): InstallCommandDeps {
  const repoRoot = env.HADES_REPO_ROOT ?? process.cwd();
  return { repoRoot, version: readPackageVersion(repoRoot), env };
}

/** Walks up from `dir` to the nearest existing ancestor and checks THAT
 *  ancestor's writability -- a directory that doesn't exist yet is
 *  "writable" exactly when whatever `mkdir -p` would need to create it is
 *  writable. Never assumes; always a real `accessSync` against a real,
 *  existing path. */
function probeWritable(dir: string): boolean {
  let target = dir;
  for (;;) {
    if (existsSync(target)) {
      try {
        accessSync(target, fsConstants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const parent = dirname(target);
    if (parent === target) return false; // reached the filesystem root without an existing ancestor
    target = parent;
  }
}

/** The one place in this file that reads the real machine: real platform,
 *  real arch, real `process.version`, the real home directory, the real
 *  writability of the resolved bin/data dirs, and a real scan for an
 *  existing launcher (parsing the real `HADES_INSTALL_VERSION=` line
 *  `plan.ts`'s `launcherScript` writes, rather than guessing). */
export function probeHost(env: Record<string, string | undefined>): HostProbe {
  const home = homedir();
  const platform = process.platform;
  const arch = process.arch;
  const nodeVersion = process.version;
  const shellPath = env.SHELL;

  const { binDir, dataDir } = resolveTargets(
    { platform, arch, home, env, nodeVersion, shellPath, writable: {} },
    { version: "", repoRoot: "" },
  );

  const writable: Record<string, boolean> = {
    [binDir]: probeWritable(binDir),
    [dataDir]: probeWritable(dataDir),
  };

  const launcherPath = join(binDir, "hades");
  let existing: HostProbe["existing"];
  if (existsSync(launcherPath)) {
    let version: string | undefined;
    try {
      const content = readFileSync(launcherPath, "utf8");
      const m = /HADES_INSTALL_VERSION=(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(content);
      version = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
    } catch {
      version = undefined;
    }
    existing = { launcherPath, version, dataDir: existsSync(dataDir) ? dataDir : undefined };
  }

  return { platform, arch, home, env, nodeVersion, shellPath, writable, existing };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const INSTALL_USAGE: string[] = [
  "Usage: hades install <command>",
  "",
  "Commands:",
  "  plan [--prefix D] [--bin-dir D] [--data-dir D] [--json]",
  "      Render T1's real install plan for this machine (no writes).",
  "  bundle --out DIR [--include FROM:TO[:optional|:executable]]... [--json]",
  "      Stage a portable, hashed bundle (+ hades / hades.cmd launchers) at DIR.",
  "      Repeat --include to override the default file set; each value is",
  "      FROM:TO, optionally suffixed with :optional or :executable.",
  "  verify <bundleDir> [--json] [--allow-extra]",
  "      Independently re-hash a staged bundle against its own manifest.",
  "  doctor [--json]",
  "      Diagnose this machine's install readiness (node, PATH, writability,",
  "      existing launcher, existing data dir).",
  "  help",
  "      Show this help.",
];

// ---------------------------------------------------------------------------
// Small local helpers (own copies -- see module doc / state-command.ts)
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractBoolFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, rest: args };
  return { present: true, rest: [...args.slice(0, idx), ...args.slice(idx + 1)] };
}

function extractValueFlag(args: string[], flag: string): { present: boolean; value: string | undefined; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, value: undefined, rest: args };
  const value = args[idx + 1];
  const rest = value === undefined ? [...args.slice(0, idx), ...args.slice(idx + 1)] : [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { present: true, value, rest };
}

function parseIncludeFlag(raw: string): { spec?: BundleSourceSpec; error?: string } {
  const firstColon = raw.indexOf(":");
  if (firstColon <= 0) return { error: `invalid --include value "${raw}" (expected FROM:TO)` };
  const from = raw.slice(0, firstColon);
  const rest = raw.slice(firstColon + 1);
  const lastColon = rest.lastIndexOf(":");
  let to = rest;
  let modifier: string | undefined;
  if (lastColon !== -1) {
    const maybeModifier = rest.slice(lastColon + 1);
    if (maybeModifier === "optional" || maybeModifier === "executable") {
      modifier = maybeModifier;
      to = rest.slice(0, lastColon);
    }
  }
  if (to.length === 0) return { error: `invalid --include value "${raw}" (expected FROM:TO)` };
  const spec: BundleSourceSpec = { from, to };
  if (modifier === "optional") spec.optional = true;
  if (modifier === "executable") spec.executable = true;
  return { spec };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function cmdPlan(args: string[], deps: InstallCommandDeps): CliResult {
  let rest = args;
  const jsonFlag = extractBoolFlag(rest, "--json");
  rest = jsonFlag.rest;
  const prefixFlag = extractValueFlag(rest, "--prefix");
  rest = prefixFlag.rest;
  const binDirFlag = extractValueFlag(rest, "--bin-dir");
  rest = binDirFlag.rest;
  const dataDirFlag = extractValueFlag(rest, "--data-dir");
  rest = dataDirFlag.rest;

  if ((prefixFlag.present && prefixFlag.value === undefined) || (binDirFlag.present && binDirFlag.value === undefined) || (dataDirFlag.present && dataDirFlag.value === undefined)) {
    return { code: 2, lines: ["--prefix/--bin-dir/--data-dir require a value", "Usage: hades install plan [--prefix D] [--bin-dir D] [--data-dir D] [--json]"] };
  }
  if (rest.length > 0) {
    return { code: 2, lines: [`Unknown argument: ${rest[0]}`, "Usage: hades install plan [--prefix D] [--bin-dir D] [--data-dir D] [--json]"] };
  }

  const host = deps.host ?? probeHost(deps.env);
  const options: InstallOptions = {
    version: deps.version,
    repoRoot: deps.repoRoot,
    prefix: prefixFlag.value,
    binDir: binDirFlag.value,
    dataDir: dataDirFlag.value,
  };

  let plan: InstallPlan;
  try {
    plan = buildInstallPlan(host, options);
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }

  if (jsonFlag.present) return { code: plan.ok ? 0 : 1, lines: [renderPlanJson(plan)] };
  return { code: plan.ok ? 0 : 1, lines: renderPlanText(plan) };
}

// ---------------------------------------------------------------------------
// bundle
// ---------------------------------------------------------------------------

function cmdBundle(args: string[], deps: InstallCommandDeps): CliResult {
  let rest = args;
  const jsonFlag = extractBoolFlag(rest, "--json");
  rest = jsonFlag.rest;
  const outFlag = extractValueFlag(rest, "--out");
  rest = outFlag.rest;

  const includeSpecs: BundleSourceSpec[] = [];
  for (;;) {
    const flag = extractValueFlag(rest, "--include");
    if (!flag.present) break;
    rest = flag.rest;
    if (flag.value === undefined) {
      return { code: 2, lines: ["--include requires a value", ...INSTALL_USAGE] };
    }
    const parsed = parseIncludeFlag(flag.value);
    if (parsed.error || !parsed.spec) {
      return { code: 2, lines: [parsed.error ?? "invalid --include value", ...INSTALL_USAGE] };
    }
    includeSpecs.push(parsed.spec);
  }

  if (rest.length > 0) {
    return { code: 2, lines: [`Unknown argument: ${rest[0]}`, ...INSTALL_USAGE] };
  }
  if (!outFlag.present || outFlag.value === undefined) {
    return { code: 2, lines: ["--out is required", "Usage: hades install bundle --out DIR [--include FROM:TO] [--json]"] };
  }

  const outDir = outFlag.value;
  const include = includeSpecs.length > 0 ? includeSpecs : [...DEFAULT_BUNDLE_INCLUDES];
  const now = deps.now ?? Date.now;

  let manifest: BundleManifest;
  try {
    manifest = stageBundle({ sourceRoot: deps.repoRoot, outDir, include, hadesVersion: deps.version, now });
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }

  try {
    const launchers = bundleLaunchers(manifest);
    writeFileSync(join(outDir, "hades"), launchers.hades, { mode: 0o755 });
    writeFileSync(join(outDir, "hades.cmd"), launchers["hades.cmd"]);
  } catch (err) {
    return { code: 1, lines: [`bundle staged, but writing launchers failed: ${errMessage(err)}`] };
  }

  if (jsonFlag.present) return { code: 0, lines: [JSON.stringify(manifest, null, 2)] };

  const lines = [
    `Staged bundle "${manifest.name}" ${manifest.hadesVersion} at ${outDir}`,
    `  entries:      ${manifest.entries.length}`,
    `  root hash:    ${manifest.rootHash}`,
    `  node runtime: ${manifest.nodeRuntime.embedded ? `embedded (${manifest.nodeRuntime.version})` : "external"} -- ${manifest.nodeRuntime.note}`,
    `  launchers:    hades, hades.cmd`,
  ];
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

function cmdVerify(args: string[]): CliResult {
  let rest = args;
  const jsonFlag = extractBoolFlag(rest, "--json");
  rest = jsonFlag.rest;
  const allowExtraFlag = extractBoolFlag(rest, "--allow-extra");
  rest = allowExtraFlag.rest;

  const [bundleDir, ...extra] = rest;
  if (extra.length > 0) {
    return { code: 2, lines: [`Unknown argument: ${extra[0]}`, "Usage: hades install verify <bundleDir> [--json] [--allow-extra]"] };
  }
  if (!bundleDir) {
    return { code: 2, lines: ["bundleDir is required", "Usage: hades install verify <bundleDir> [--json] [--allow-extra]"] };
  }

  let result: BundleVerification;
  try {
    result = verifyBundle(bundleDir, { allowExtra: allowExtraFlag.present });
  } catch (err) {
    return { code: 1, lines: [errMessage(err)] };
  }

  if (jsonFlag.present) return { code: result.ok ? 0 : 1, lines: [JSON.stringify(result, null, 2)] };

  const lines: string[] = [
    `bundle:    ${bundleDir}`,
    `manifest:  ${result.manifestOk ? "OK" : "INVALID"}`,
    `root hash: ${result.rootHashOk ? "OK" : "MISMATCH"}`,
    `checked:   ${result.checked}`,
  ];
  if (result.missing.length > 0) {
    lines.push("missing:");
    for (const p of result.missing) lines.push(`  - ${p}`);
  }
  if (result.modified.length > 0) {
    lines.push("modified:");
    for (const p of result.modified) lines.push(`  - ${p}`);
  }
  if (result.extra.length > 0) {
    lines.push(`extra${allowExtraFlag.present ? " (allowed)" : ""}:`);
    for (const p of result.extra) lines.push(`  - ${p}`);
  }
  lines.push(result.ok ? "VERIFIED" : "TAMPERED");
  return { code: result.ok ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function cmdDoctor(args: string[], deps: InstallCommandDeps): CliResult {
  const jsonFlag = extractBoolFlag(args, "--json");
  if (jsonFlag.rest.length > 0) {
    return { code: 2, lines: [`Unknown argument: ${jsonFlag.rest[0]}`, "Usage: hades install doctor [--json]"] };
  }

  const host = deps.host ?? probeHost(deps.env);
  const { binDir, dataDir } = resolveTargets(host, { version: deps.version, repoRoot: deps.repoRoot });

  const parsedNode = parseNodeVersion(host.nodeVersion);
  const nodeOk = host.nodeVersion !== undefined && parsedNode !== undefined && parsedNode.major >= MIN_NODE_MAJOR;

  const pathEntries = (host.env.PATH ?? "").split(":").filter((p) => p.length > 0);
  const binDirOnPath = pathEntries.includes(binDir);

  const binDirWritable = host.writable[binDir] !== false;
  const dataDirWritable = host.writable[dataDir] !== false;

  const existingLauncher = host.existing?.launcherPath;
  const existingVersion = host.existing?.version;
  const existingDataDir = host.existing?.dataDir;

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: "node",
      ok: nodeOk,
      detail: host.nodeVersion ? `node ${host.nodeVersion.trim()} (requires >= v${MIN_NODE_MAJOR})` : `node not found on PATH (requires >= v${MIN_NODE_MAJOR})`,
    },
    { name: "platform", ok: true, detail: `${host.platform}/${host.arch}` },
    { name: "bin-dir", ok: binDirWritable, detail: `${binDir} ${binDirWritable ? "is writable" : "is NOT writable"}` },
    { name: "data-dir", ok: dataDirWritable, detail: `${dataDir} ${dataDirWritable ? "is writable" : "is NOT writable"}` },
    { name: "path", ok: binDirOnPath, detail: binDirOnPath ? `${binDir} is on PATH` : `${binDir} is NOT on PATH` },
    {
      name: "existing-launcher",
      ok: true,
      detail: existingLauncher ? `found existing launcher at ${existingLauncher} (version ${existingVersion ?? "unknown"})` : "no existing launcher found",
    },
    {
      name: "existing-data",
      ok: true,
      detail: existingDataDir ? `found existing data dir at ${existingDataDir}` : "no existing data dir found",
    },
  ];

  const ok = checks.every((c) => c.ok);

  if (jsonFlag.present) {
    return { code: ok ? 0 : 1, lines: [JSON.stringify({ ok, binDir, dataDir, checks }, null, 2)] };
  }

  const lines = [`hades install doctor -- ${ok ? "OK" : "ISSUES FOUND"}`, ...checks.map((c) => `  [${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`)];
  return { code: ok ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export function runInstallCommand(args: string[], deps: InstallCommandDeps): CliResult {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: INSTALL_USAGE };
  }

  switch (sub) {
    case "plan":
      return cmdPlan(rest, deps);
    case "bundle":
      return cmdBundle(rest, deps);
    case "verify":
      return cmdVerify(rest);
    case "doctor":
      return cmdDoctor(rest, deps);
    default:
      return { code: 2, lines: [`Unknown install command: ${sub}`, ...INSTALL_USAGE] };
  }
}
