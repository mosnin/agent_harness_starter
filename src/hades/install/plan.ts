/**
 * The POSIX installer's decision core.
 *
 * `install.sh` (repo root) is the real, executing artifact: it touches the
 * filesystem, spawns `node`, writes the launcher, edits shell profiles. This
 * module is its single source of truth for WHAT to do, expressed as pure,
 * injectable, unit-testable logic — it decides, it never acts.
 *
 * PURITY CONTRACT (do not violate): this file imports nothing but types and
 * `sha256Hex` from `../styx/certificate` (itself a pure `node:crypto` wrapper
 * with no side effects). No `node:fs`, no `node:path`, no `child_process`, no
 * clock, no `Math.random`. Every fact about the host machine — platform,
 * env vars, whether a directory is writable, what's already installed —
 * arrives via the caller-supplied {@link HostProbe}. That is what lets the
 * planner be exercised with zero filesystem access in tests, while
 * `install.sh` remains the only thing that ever actually touches the
 * machine.
 *
 * `install.sh` mirrors these decisions in bash (it cannot safely shell out to
 * `node` to run this module for its prerequisite checks — the whole point of
 * those checks is to work even when `node` is missing, broken, or too old).
 * The two are kept in lockstep by the test suite, which spawns the real
 * script and cross-checks its behavior against `buildInstallPlan` given
 * equivalent inputs.
 */

import { sha256Hex } from "../styx/certificate";

// ---------------------------------------------------------------------------
// Constants & simple types
// ---------------------------------------------------------------------------

/** Oldest major Node.js version the launcher (and `hades` itself) supports. */
export const MIN_NODE_MAJOR = 20;

/** POSIX platforms `install.sh` knows how to install onto. */
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>([
  "linux",
  "darwin",
  "freebsd",
  "openbsd",
]);

export type InstallMode = "install" | "upgrade" | "reinstall" | "uninstall" | "noop";

export type ShellKind = "bash" | "zsh" | "fish" | "sh" | "unknown";

export interface HostProbe {
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Raw `node --version`-style output, e.g. "v20.11.0". Undefined = node not found. */
  nodeVersion?: string;
  /** Path to the user's login shell, e.g. "/bin/zsh" or "/usr/bin/fish". */
  shellPath?: string;
  /** Writability probe results, keyed by the EXACT absolute path checked. */
  writable: Record<string, boolean>;
  /** What (if anything) is already installed, as observed on disk. */
  existing?: { launcherPath?: string; version?: string; dataDir?: string };
}

export interface InstallOptions {
  version: string;
  repoRoot: string;
  prefix?: string;
  binDir?: string;
  dataDir?: string;
  modifyPath?: boolean;
  force?: boolean;
  dryRun?: boolean;
  uninstall?: boolean;
  purge?: boolean;
}

export type InstallStepKind = "check" | "mkdir" | "write" | "chmod" | "remove" | "append-profile" | "note";

export interface InstallStep {
  id: string;
  kind: InstallStepKind;
  target: string;
  detail: string;
  reversible: boolean;
  content?: string;
  mode?: number;
}

export type BlockerCode =
  | "node-missing"
  | "node-too-old"
  | "prefix-not-writable"
  | "bin-dir-not-writable"
  | "unsupported-platform"
  | "existing-install"
  | "nothing-to-uninstall";

export interface InstallBlocker {
  code: BlockerCode;
  message: string;
  remedy: string;
}

export interface InstallPlan {
  mode: InstallMode;
  ok: boolean;
  version: string;
  prefix: string;
  binDir: string;
  dataDir: string;
  launcherPath: string;
  launcherScript: string;
  launcherSha256: string;
  shell: ShellKind;
  profilePath?: string;
  profileLine?: string;
  pathAlreadyContainsBinDir: boolean;
  steps: InstallStep[];
  blockers: InstallBlocker[];
  warnings: string[];
}

/**
 * The exact flag set `install.sh` accepts, in the order documented at the top
 * of the script. A test parses the script's real bytes and asserts equality
 * against this array so the two can never silently drift apart.
 */
export const INSTALL_SH_FLAGS: readonly string[] = [
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
];

// ---------------------------------------------------------------------------
// Tiny pure path helpers (no node:path — see purity contract above)
// ---------------------------------------------------------------------------

function posixJoin(...parts: string[]): string {
  const nonEmpty = parts.filter((p) => p.length > 0);
  if (nonEmpty.length === 0) return "";
  let out = nonEmpty[0];
  for (let i = 1; i < nonEmpty.length; i++) {
    const part = nonEmpty[i];
    const left = out.endsWith("/") ? out.slice(0, -1) : out;
    const right = part.startsWith("/") ? part.slice(1) : part;
    out = right.length > 0 ? `${left}/${right}` : left;
  }
  // Collapse a run of "//" that could arise from an empty segment, but keep a
  // leading "//" (rare, but POSIX permits root "//") untouched beyond that.
  return out.replace(/([^:])\/{2,}/g, "$1/");
}

function posixDirname(p: string): string {
  const trimmed = p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

/**
 * POSIX single-quote a shell word: wrap in single quotes, escaping any
 * embedded single quote as `'\''`. Safe for spaces, unicode, and any other
 * byte a filesystem path can contain. `install.sh` reproduces this exact
 * escaping in bash so generated launcher bytes match precisely.
 */
function shQuote(word: string): string {
  return `'${word.split("'").join("'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Node / semver-ish version parsing
// ---------------------------------------------------------------------------

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseNodeVersion(raw: string | undefined): { major: number; minor: number; patch: number } | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const m = VERSION_RE.exec(trimmed);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Total-order comparator over version-ish strings ("v20.11.0", "1.2.3-rc.1",
 * ...). Unparsable input sorts as `0.0.0` (lowest), so the comparator is
 * always defined and always consistent — never throws, never returns NaN.
 */
export function compareNodeVersion(a: string, b: string): number {
  const pa = parseNodeVersion(a) ?? { major: 0, minor: 0, patch: 0 };
  const pb = parseNodeVersion(b) ?? { major: 0, minor: 0, patch: 0 };
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Shell detection & shell profile mapping
// ---------------------------------------------------------------------------

export function detectShell(shellPath: string | undefined): ShellKind {
  if (!shellPath) return "unknown";
  const base = shellPath.split("/").pop() ?? "";
  switch (base) {
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "fish":
      return "fish";
    case "sh":
      return "sh";
    default:
      return "unknown";
  }
}

export function profileForShell(
  shell: ShellKind,
  home: string
): { path: string; line: (binDir: string) => string } | undefined {
  switch (shell) {
    case "bash":
      return { path: posixJoin(home, ".bashrc"), line: (binDir) => `export PATH="${binDir}:$PATH"` };
    case "zsh":
      return { path: posixJoin(home, ".zshrc"), line: (binDir) => `export PATH="${binDir}:$PATH"` };
    case "sh":
      return { path: posixJoin(home, ".profile"), line: (binDir) => `export PATH="${binDir}:$PATH"` };
    case "fish":
      return {
        path: posixJoin(home, ".config", "fish", "config.fish"),
        line: (binDir) => `set -gx PATH ${shQuote(binDir)} $PATH`,
      };
    case "unknown":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Resolves `{prefix, binDir, dataDir}` honoring, in precedence order:
 * explicit option > `HADES_BIN_DIR`/`HADES_DATA_DIR` > `XDG_BIN_HOME`/
 * `XDG_DATA_HOME` > `~/.local/bin` and `~/.hades`. `--prefix DIR` is a
 * shorthand tier between "explicit --bin-dir/--data-dir" and the env-var
 * tiers: it means `DIR/bin` and `DIR/share/hades` unless overridden more
 * specifically.
 */
export function resolveTargets(
  host: HostProbe,
  options: InstallOptions
): { prefix: string; binDir: string; dataDir: string } {
  const env = host.env;
  const prefixOpt = options.prefix && options.prefix.length > 0 ? options.prefix : undefined;

  const binDir =
    options.binDir ??
    (prefixOpt ? posixJoin(prefixOpt, "bin") : undefined) ??
    env.HADES_BIN_DIR ??
    env.XDG_BIN_HOME ??
    posixJoin(host.home, ".local", "bin");

  const dataDir =
    options.dataDir ??
    (prefixOpt ? posixJoin(prefixOpt, "share", "hades") : undefined) ??
    env.HADES_DATA_DIR ??
    (env.XDG_DATA_HOME ? posixJoin(env.XDG_DATA_HOME, "hades") : undefined) ??
    posixJoin(host.home, ".hades");

  const prefix = prefixOpt ?? posixDirname(binDir);

  return { prefix, binDir, dataDir };
}

// ---------------------------------------------------------------------------
// Launcher script generation
// ---------------------------------------------------------------------------

/**
 * The exact bytes written to `<binDir>/hades`. `install.sh` reproduces this
 * byte-for-byte in bash so `launcherSha256` (computed here via the real
 * `sha256Hex`) matches the sha256 of the file the script actually writes.
 */
export function launcherScript(opts: { repoRoot: string; version: string; nodeBin?: string }): string {
  const nodeBin = opts.nodeBin && opts.nodeBin.length > 0 ? opts.nodeBin : "node";
  const hadesEntry = posixJoin(opts.repoRoot, "src", "hades", "bin", "hades.ts");
  return (
    "#!/usr/bin/env bash\n" +
    "set -euo pipefail\n" +
    "# hades launcher -- generated by install.sh. Do not edit; re-run install.sh instead.\n" +
    `# installed version: ${opts.version}\n` +
    `export HADES_INSTALL_VERSION=${shQuote(opts.version)}\n` +
    `exec ${shQuote(nodeBin)} --import tsx ${shQuote(hadesEntry)} "$@"\n`
  );
}

// ---------------------------------------------------------------------------
// Blocker message/remedy text
//
// Kept as small literal templates so `install.sh` can reproduce identical
// text in bash without ever invoking node (the prerequisite checks below are
// exactly the checks that must work when node is absent or broken).
// ---------------------------------------------------------------------------

function blocker(code: BlockerCode, message: string, remedy: string): InstallBlocker {
  return { code, message, remedy };
}

// ---------------------------------------------------------------------------
// Plan assembly
// ---------------------------------------------------------------------------

export function buildInstallPlan(host: HostProbe, options: InstallOptions): InstallPlan {
  const blockers: InstallBlocker[] = [];
  const warnings: string[] = [];

  const { prefix, binDir, dataDir } = resolveTargets(host, options);
  const launcherPath = posixJoin(binDir, "hades");
  const shell = detectShell(host.shellPath);
  const profile = profileForShell(shell, host.home);
  const modifyPath = options.modifyPath !== false;

  const pathEntries = (host.env.PATH ?? "").split(":").filter((p) => p.length > 0);
  const pathAlreadyContainsBinDir = pathEntries.includes(binDir);

  const script = launcherScript({ repoRoot: options.repoRoot, version: options.version });
  const launcherSha256 = sha256Hex(script);

  // --- platform ---
  if (!SUPPORTED_PLATFORMS.has(host.platform)) {
    blockers.push(
      blocker(
        "unsupported-platform",
        `platform ${host.platform} is not supported by install.sh`,
        `install manually: run "node --import tsx src/hades/bin/hades.ts" from the repo, or use a supported POSIX platform (linux, darwin, freebsd, openbsd)`
      )
    );
  }

  // --- node prerequisite ---
  const parsedNode = parseNodeVersion(host.nodeVersion);
  if (host.nodeVersion === undefined || parsedNode === undefined) {
    blockers.push(
      blocker(
        "node-missing",
        "node was not found on PATH",
        "install Node.js >= 20 (e.g. via nvm or your OS package manager) and re-run install.sh"
      )
    );
  } else if (parsedNode.major < MIN_NODE_MAJOR) {
    blockers.push(
      blocker(
        "node-too-old",
        `node ${host.nodeVersion.trim()} is older than the required v${MIN_NODE_MAJOR}`,
        "upgrade Node.js to >= 20 (e.g. via nvm install 20) and re-run install.sh"
      )
    );
  }

  // --- writability ---
  if (options.prefix && host.writable[options.prefix] === false) {
    blockers.push(
      blocker(
        "prefix-not-writable",
        `prefix ${options.prefix} is not writable`,
        "choose a writable --prefix, fix permissions on the directory, or re-run with sudo"
      )
    );
  }
  if (host.writable[binDir] === false) {
    blockers.push(
      blocker(
        "bin-dir-not-writable",
        `bin directory ${binDir} is not writable`,
        "choose a writable --bin-dir, fix permissions on the directory, or re-run with sudo"
      )
    );
  }

  // --- mode determination ---
  let mode: InstallMode;
  const existing = host.existing;

  if (options.uninstall) {
    if (!existing || !existing.launcherPath) {
      mode = "noop";
      blockers.push(
        blocker(
          "nothing-to-uninstall",
          "no hades installation was found to uninstall",
          "nothing to do -- install first with install.sh, or pass --prefix/--bin-dir matching the existing install"
        )
      );
    } else {
      mode = "uninstall";
    }
  } else if (!existing || !existing.launcherPath) {
    mode = "install";
  } else if (options.force) {
    mode = "reinstall";
  } else if (existing.version !== undefined && compareNodeVersion(existing.version, options.version) < 0) {
    mode = "upgrade";
  } else {
    // Same version already installed (or a downgrade attempted) without
    // --force: nothing changes, and the blocker explains why.
    mode = "noop";
    blockers.push(
      blocker(
        "existing-install",
        `hades ${existing.version ?? "(unknown version)"} is already installed at ${existing.launcherPath}`,
        "use --force to reinstall, or bump the version being installed"
      )
    );
  }

  const ok = blockers.length === 0;

  // --- steps ---
  const steps: InstallStep[] = [];

  if (ok && (mode === "install" || mode === "upgrade" || mode === "reinstall")) {
    steps.push({
      id: "check-node",
      kind: "check",
      target: "node",
      detail: `node ${(host.nodeVersion ?? "").trim()} satisfies >= v${MIN_NODE_MAJOR}`,
      reversible: false,
    });
    steps.push({
      id: "check-platform",
      kind: "check",
      target: host.platform,
      detail: `platform ${host.platform} is supported`,
      reversible: false,
    });
    steps.push({
      id: "mkdir-bin-dir",
      kind: "mkdir",
      target: binDir,
      detail: `create ${binDir} if missing`,
      reversible: false,
    });
    steps.push({
      id: "mkdir-data-dir",
      kind: "mkdir",
      target: dataDir,
      detail: `create ${dataDir} if missing`,
      reversible: false,
    });
    steps.push({
      id: "write-launcher",
      kind: "write",
      target: launcherPath,
      detail: `write launcher script to ${launcherPath}`,
      reversible: true,
      content: script,
    });
    steps.push({
      id: "chmod-launcher",
      kind: "chmod",
      target: launcherPath,
      detail: `make ${launcherPath} executable`,
      reversible: false,
      mode: 0o755,
    });

    if (modifyPath) {
      if (pathAlreadyContainsBinDir) {
        warnings.push(`${binDir} is already on PATH; shell profile left untouched`);
      } else if (!profile) {
        warnings.push(
          `could not detect a supported shell profile for ${host.shellPath ?? "(unknown shell)"}; add ${binDir} to PATH manually`
        );
        steps.push({
          id: "note-manual-path",
          kind: "note",
          target: binDir,
          detail: `unknown shell -- add this to your shell profile manually: export PATH="${binDir}:$PATH"`,
          reversible: false,
        });
      } else {
        steps.push({
          id: "append-profile",
          kind: "append-profile",
          target: profile.path,
          detail: `append PATH export for ${binDir} to ${profile.path} (only if not already present)`,
          reversible: true,
          content: profile.line(binDir),
        });
      }
    } else {
      warnings.push("--no-modify-path: shell profile left untouched");
    }
  }

  if (mode === "uninstall" && existing?.launcherPath) {
    steps.push({
      id: "remove-launcher",
      kind: "remove",
      target: existing.launcherPath,
      detail: `remove launcher script ${existing.launcherPath}`,
      reversible: false,
    });
    if (profile) {
      steps.push({
        id: "remove-profile-line",
        kind: "remove",
        target: profile.path,
        detail: `remove the PATH export line for ${binDir} from ${profile.path}, if present (leaves the rest of the file untouched)`,
        reversible: false,
        content: profile.line(binDir),
      });
    }
    if (options.purge) {
      const purgeDataDir = existing.dataDir ?? dataDir;
      steps.push({
        id: "remove-data-dir",
        kind: "remove",
        target: purgeDataDir,
        detail: `--purge: recursively remove ${purgeDataDir}`,
        reversible: false,
      });
    } else {
      steps.push({
        id: "note-data-dir-kept",
        kind: "note",
        target: existing.dataDir ?? dataDir,
        detail: `data under ${existing.dataDir ?? dataDir} was left in place (pass --purge to remove it)`,
        reversible: false,
      });
    }
  }

  return {
    mode,
    ok,
    version: options.version,
    prefix,
    binDir,
    dataDir,
    launcherPath,
    launcherScript: script,
    launcherSha256,
    shell,
    profilePath: profile?.path,
    profileLine: profile ? profile.line(binDir) : undefined,
    pathAlreadyContainsBinDir,
    steps,
    blockers,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderPlanText(plan: InstallPlan): string[] {
  const lines: string[] = [];
  lines.push(`hades installer -- mode: ${plan.mode}${plan.ok ? "" : " (blocked)"}`);
  lines.push(`  version:   ${plan.version}`);
  lines.push(`  prefix:    ${plan.prefix}`);
  lines.push(`  bin dir:   ${plan.binDir}`);
  lines.push(`  data dir:  ${plan.dataDir}`);
  lines.push(`  launcher:  ${plan.launcherPath}`);
  lines.push(`  sha256:    ${plan.launcherSha256}`);
  lines.push(`  shell:     ${plan.shell}${plan.profilePath ? ` (${plan.profilePath})` : ""}`);

  if (plan.blockers.length > 0) {
    lines.push("blockers:");
    for (const b of plan.blockers) {
      lines.push(`  - [${b.code}] ${b.message}`);
      lines.push(`    remedy: ${b.remedy}`);
    }
  }

  if (plan.steps.length > 0) {
    lines.push("steps:");
    for (const s of plan.steps) {
      lines.push(`  - (${s.kind}) ${s.detail}`);
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of plan.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines;
}

export function renderPlanJson(plan: InstallPlan): string {
  return JSON.stringify(plan);
}
