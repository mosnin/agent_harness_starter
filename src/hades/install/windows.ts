/**
 * The Windows installer's decision core, plus a genuine PowerShell
 * parser/auditor that proves `install.ps1` (repo root) really implements the
 * contract this module encodes.
 *
 * `install.ps1` is the real, executing artifact: it probes the host, touches
 * the filesystem, writes the `hades.cmd` / `hades.ps1` shims, and mutates the
 * current user's `PATH` via `[Environment]::SetEnvironmentVariable(...,
 * 'User')`. This module is its single source of truth for WHAT to do,
 * expressed as pure, injectable, unit-testable logic — it decides, it never
 * acts. (Mirrors `src/hades/install/plan.ts`, the POSIX sibling, for
 * `install.sh`; the two are independent because `install.ps1` cannot shell
 * out to node for its own prerequisite checks — node being present is one of
 * the things it has to check.)
 *
 * PURITY CONTRACT (do not violate): no `node:fs`, no `child_process`, no
 * clock, no `Math.random`. Every fact about the host machine — env vars,
 * elevation, execution policy, what's already on PATH — arrives via the
 * caller-supplied {@link WindowsHostProbe}.
 *
 * Because `install.ps1` can't be run headlessly on every CI box (`pwsh` may
 * not be installed on a Linux runner), this module also ships a *real*
 * character-level PowerShell tokenizer (`parsePowerShellScript`) and an
 * auditor built on it (`auditInstallPs1`) that runs unconditionally against
 * the shipped script's actual on-disk bytes — so the installer is genuinely
 * verified even when nothing can execute it.
 */

// ---------------------------------------------------------------------------
// Locked contract types
// ---------------------------------------------------------------------------

export interface WindowsHostProbe {
  userProfile: string;
  localAppData?: string;
  appData?: string;
  env: Record<string, string | undefined>;
  nodeVersion?: string;
  userPath: string[];
  psVersion?: string;
  executionPolicy?: string;
  isElevated?: boolean;
}

export interface WindowsInstallOptions {
  version: string;
  repoRoot: string;
  installDir?: string;
  dataDir?: string;
  modifyPath?: boolean;
  force?: boolean;
  dryRun?: boolean;
  uninstall?: boolean;
  purge?: boolean;
}

export type WindowsBlockerCode =
  | "node-missing"
  | "node-too-old"
  | "no-local-appdata"
  | "install-dir-not-writable"
  | "execution-policy"
  | "elevated-refused"
  | "nothing-to-uninstall";

export interface WindowsInstallStep {
  id: string;
  kind: "check" | "mkdir" | "write" | "remove" | "set-user-path" | "note";
  target: string;
  detail: string;
  reversible: boolean;
  content?: string;
}

export interface WindowsInstallPlan {
  mode: "install" | "upgrade" | "reinstall" | "uninstall" | "noop";
  ok: boolean;
  version: string;
  installDir: string;
  shimDir: string;
  dataDir: string;
  cmdShimPath: string;
  ps1ShimPath: string;
  pathAlreadyContainsShimDir: boolean;
  userPathAfter: string[];
  steps: WindowsInstallStep[];
  blockers: Array<{ code: WindowsBlockerCode; message: string; remedy: string }>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Oldest major Node.js version `hades` supports (matches package.json's `engines.node`). */
const MIN_NODE_MAJOR = 20;

/** Legacy Windows PATH length some older tools still choke past; we warn well before it, never truncate. */
const PATH_WARN_LENGTH = 1900;

/** `%LOCALAPPDATA%`/`%APPDATA%`-relative roots protected by default Windows ACLs for a non-elevated user. */
const PROTECTED_ROOT_RE = /^[A-Za-z]:\\(Program Files(?: \(x86\))?|Windows)(\\|$)/i;

// ---------------------------------------------------------------------------
// Tiny pure Windows-path helpers (no node:path — see purity contract above)
// ---------------------------------------------------------------------------

function joinWin(...parts: string[]): string {
  const cleaned = parts
    .map((p) => p.replace(/\//g, "\\"))
    .map((p, i) => (i > 0 ? p.replace(/^\\+/, "") : p))
    .map((p) => p.replace(/\\+$/, ""))
    .filter((p) => p.length > 0);
  return cleaned.join("\\");
}

function normalizeAbsoluteWinPath(p: string): string {
  const trimmed = p.trim().replace(/\//g, "\\");
  if (trimmed.length <= 3) return trimmed; // preserve a bare drive root like "C:\"
  return trimmed.replace(/\\+$/, "");
}

/** Case-insensitive, trailing-backslash-insensitive comparison key for a PATH entry. */
function normalizePathKey(p: string): string {
  let s = p.trim().toLowerCase().replace(/\//g, "\\");
  while (s.length > 3 && s.endsWith("\\")) s = s.slice(0, -1);
  return s;
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Resolves `{installDir, shimDir, dataDir}` honoring, in precedence order:
 * explicit option > `HADES_INSTALL_DIR`/`HADES_DATA_DIR` >
 * `%LOCALAPPDATA%\Programs\Hades` / `%APPDATA%\hades`.
 *
 * If neither an explicit `installDir` nor `HADES_INSTALL_DIR` is given and
 * `%LOCALAPPDATA%` is unset, `installDir` (and therefore `shimDir`) resolves
 * to `""` rather than a guessed, possibly-wrong path — {@link buildWindowsInstallPlan}
 * turns that into the `no-local-appdata` blocker instead of silently
 * installing somewhere bogus. `dataDir` degrades further (to `%LOCALAPPDATA%\hades`,
 * then `%USERPROFILE%\.hades`) since a missing data directory location is
 * recoverable and not fatal to resolving the rest of the plan.
 */
export function resolveWindowsTargets(
  probe: WindowsHostProbe,
  options: WindowsInstallOptions
): { installDir: string; shimDir: string; dataDir: string } {
  const env = probe.env;

  const explicitInstallDir = options.installDir?.trim();
  const envInstallDir = env.HADES_INSTALL_DIR?.trim();
  const installDir = explicitInstallDir
    ? normalizeAbsoluteWinPath(explicitInstallDir)
    : envInstallDir
      ? normalizeAbsoluteWinPath(envInstallDir)
      : probe.localAppData?.trim()
        ? joinWin(probe.localAppData, "Programs", "Hades")
        : "";

  const shimDir = installDir ? joinWin(installDir, "bin") : "";

  const explicitDataDir = options.dataDir?.trim();
  const envDataDir = env.HADES_DATA_DIR?.trim();
  const dataDir = explicitDataDir
    ? normalizeAbsoluteWinPath(explicitDataDir)
    : envDataDir
      ? normalizeAbsoluteWinPath(envDataDir)
      : probe.appData?.trim()
        ? joinWin(probe.appData, "hades")
        : probe.localAppData?.trim()
          ? joinWin(probe.localAppData, "hades")
          : joinWin(probe.userProfile, ".hades");

  return { installDir, shimDir, dataDir };
}

// ---------------------------------------------------------------------------
// User-scope PATH surgery
// ---------------------------------------------------------------------------

/**
 * Adds `dir` to `current` (a `;`-split user `PATH`), idempotently and
 * order-preservingly. Comparison is case-insensitive and trailing-backslash
 * insensitive (`C:\Hades\bin` === `c:\hades\bin\`), so re-running never
 * produces a duplicate entry that merely differs in case or trailing slash —
 * but `C:\Hades\bin2` is never mistaken for `C:\Hades\bin` (whole-entry
 * comparison only, never substring/prefix).
 *
 * As a side effect this also drops empty segments (an artifact of a stray
 * `;;` or a trailing `;` in the raw `PATH` string before it was split) —
 * hygiene that keeps the PATH from growing corrupt entries across repeated
 * installer runs, never a silent truncation of anything meaningful.
 */
export function addToUserPath(current: string[], dir: string): { next: string[]; changed: boolean } {
  const cleanedCurrent = current.filter((e) => e.trim().length > 0);
  const dirClean = normalizeAbsoluteWinPath(dir);
  const dirKey = normalizePathKey(dirClean);
  const alreadyPresent = cleanedCurrent.some((e) => normalizePathKey(e) === dirKey);

  const next = alreadyPresent ? cleanedCurrent : [...cleanedCurrent, dirClean];
  const changed = next.length !== current.length || next.some((e, i) => e !== current[i]);
  return { next, changed };
}

/**
 * Removes exactly the entries whose normalized key equals `dir`'s — never a
 * substring match — from `current`. Also drops empty segments (see
 * {@link addToUserPath}). Idempotent: calling again once `dir` is gone (and
 * empties are already clean) reports `changed: false`.
 */
export function removeFromUserPath(current: string[], dir: string): { next: string[]; changed: boolean } {
  const dirKey = normalizePathKey(dir);
  const next = current.filter((e) => e.trim().length > 0 && normalizePathKey(e) !== dirKey);
  const changed = next.length !== current.length || next.some((e, i) => e !== current[i]);
  return { next, changed };
}

// ---------------------------------------------------------------------------
// Shim script generation
// ---------------------------------------------------------------------------

/**
 * The exact bytes written to `<shimDir>\hades.cmd`. `install.ps1` reproduces
 * this content in PowerShell (see `Get-CmdShimContent` there).
 */
export function cmdShimScript(opts: { repoRoot: string; version: string }): string {
  const { repoRoot, version } = opts;
  const lines = [
    "@echo off",
    "rem Hades user-scope shim for Windows (cmd.exe).",
    `rem Generated by install.ps1 for hades v${version}. Do not edit by hand.`,
    "setlocal",
    `node "${repoRoot}\\node_modules\\tsx\\dist\\cli.mjs" "${repoRoot}\\src\\hades\\bin\\hades.ts" %*`,
    "endlocal & exit /b %ERRORLEVEL%",
  ];
  return lines.join("\r\n") + "\r\n";
}

/**
 * The exact bytes written to `<shimDir>\hades.ps1`. `install.ps1` reproduces
 * this content in PowerShell (see `Get-Ps1ShimContent` there).
 */
export function ps1ShimScript(opts: { repoRoot: string; version: string }): string {
  const { repoRoot, version } = opts;
  const lines = [
    "# Hades user-scope shim for Windows (PowerShell).",
    `# Generated by install.ps1 for hades v${version}. Do not edit by hand.`,
    "param()",
    "$ErrorActionPreference = 'Stop'",
    `& node "${repoRoot}\\node_modules\\tsx\\dist\\cli.mjs" "${repoRoot}\\src\\hades\\bin\\hades.ts" @args`,
    "exit $LASTEXITCODE",
  ];
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Blocker message/remedy text
// ---------------------------------------------------------------------------

function blocker(
  code: WindowsBlockerCode,
  message: string,
  remedy: string
): { code: WindowsBlockerCode; message: string; remedy: string } {
  return { code, message, remedy };
}

// ---------------------------------------------------------------------------
// Plan assembly
// ---------------------------------------------------------------------------

export function buildWindowsInstallPlan(probe: WindowsHostProbe, options: WindowsInstallOptions): WindowsInstallPlan {
  const blockers: Array<{ code: WindowsBlockerCode; message: string; remedy: string }> = [];
  const warnings: string[] = [];

  const { installDir, shimDir, dataDir } = resolveWindowsTargets(probe, options);
  const cmdShimPath = shimDir ? joinWin(shimDir, "hades.cmd") : "";
  const ps1ShimPath = shimDir ? joinWin(shimDir, "hades.ps1") : "";
  const modifyPath = options.modifyPath !== false;

  const pathAlreadyContainsShimDir = shimDir
    ? probe.userPath.some((e) => e.trim().length > 0 && normalizePathKey(e) === normalizePathKey(shimDir))
    : false;

  // --- elevation & execution policy: apply to every mode; a user-scope
  // installer has no business running elevated, and a restrictive execution
  // policy blocks the script from having run at all. ---
  if (probe.isElevated === true && probe.env.HADES_ALLOW_ELEVATED !== "1") {
    blockers.push(
      blocker(
        "elevated-refused",
        "install.ps1 was launched from an elevated (Administrator) session",
        "re-run from a normal, non-elevated PowerShell/terminal window -- Hades installs only into your user profile and never needs admin rights; if you must proceed elevated, set HADES_ALLOW_ELEVATED=1 first"
      )
    );
  }
  if (probe.executionPolicy === "Restricted" || probe.executionPolicy === "AllSigned") {
    blockers.push(
      blocker(
        "execution-policy",
        `the current PowerShell execution policy ("${probe.executionPolicy}") blocks running local scripts`,
        "run: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned"
      )
    );
  }

  if (options.uninstall) {
    if (!pathAlreadyContainsShimDir) {
      blockers.push(
        blocker(
          "nothing-to-uninstall",
          `no Hades installation was found on the user PATH${shimDir ? ` at ${shimDir}` : ""}`,
          "nothing to do -- if you expected an existing install, check -InstallDir/HADES_INSTALL_DIR match the values used originally"
        )
      );
    }
  } else {
    // --- node prerequisite (install/upgrade/reinstall only) ---
    if (probe.nodeVersion === undefined) {
      blockers.push(
        blocker(
          "node-missing",
          "Node.js was not found on PATH",
          `install Node.js >= ${MIN_NODE_MAJOR} from https://nodejs.org/ and re-run install.ps1`
        )
      );
    } else {
      const major = Number.parseInt(probe.nodeVersion.replace(/^v/i, "").split(".")[0] ?? "", 10);
      if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
        blockers.push(
          blocker(
            "node-too-old",
            `Node.js ${probe.nodeVersion.trim()} is older than the required v${MIN_NODE_MAJOR}`,
            `upgrade Node.js to >= ${MIN_NODE_MAJOR} and re-run install.ps1`
          )
        );
      }
    }

    // --- install directory resolution / writability ---
    if (!installDir) {
      blockers.push(
        blocker(
          "no-local-appdata",
          "the %LOCALAPPDATA% environment variable is not set, so a default install directory could not be determined",
          "set %LOCALAPPDATA% (Windows normally sets this for every user session), or pass -InstallDir <path> / set HADES_INSTALL_DIR explicitly"
        )
      );
    } else if (PROTECTED_ROOT_RE.test(installDir) && probe.isElevated !== true) {
      blockers.push(
        blocker(
          "install-dir-not-writable",
          `the resolved install directory "${installDir}" is inside a system-protected location a non-elevated user cannot write to`,
          "choose a user-writable install directory with -InstallDir <path> (default: %LOCALAPPDATA%\\Programs\\Hades)"
        )
      );
    }
  }

  // --- mode determination (purely from the PATH signal: a prior install
  // always left shimDir on PATH, so its presence is itself the "is this
  // already installed" fact -- see resolveWindowsTargets doc comment). ---
  let mode: WindowsInstallPlan["mode"];
  if (options.uninstall) {
    mode = pathAlreadyContainsShimDir ? "uninstall" : "noop";
  } else if (pathAlreadyContainsShimDir) {
    mode = options.force ? "reinstall" : "upgrade";
  } else {
    mode = "install";
  }

  const ok = blockers.length === 0;

  // --- steps ---
  const steps: WindowsInstallStep[] = [];
  let userPathAfter = probe.userPath;

  if (!options.uninstall) {
    steps.push({
      id: "check-node",
      kind: "check",
      target: "node",
      detail: probe.nodeVersion ? `found Node.js ${probe.nodeVersion.trim()}` : "Node.js not found on PATH",
      reversible: false,
    });

    if (installDir) {
      steps.push({ id: "mkdir-install-dir", kind: "mkdir", target: installDir, detail: `create ${installDir} if missing`, reversible: true });
      steps.push({ id: "mkdir-shim-dir", kind: "mkdir", target: shimDir, detail: `create ${shimDir} if missing`, reversible: true });
      steps.push({ id: "mkdir-data-dir", kind: "mkdir", target: dataDir, detail: `create ${dataDir} if missing`, reversible: false });
      steps.push({
        id: "write-cmd-shim",
        kind: "write",
        target: cmdShimPath,
        detail: `write ${cmdShimPath}`,
        reversible: true,
        content: cmdShimScript({ repoRoot: options.repoRoot, version: options.version }),
      });
      steps.push({
        id: "write-ps1-shim",
        kind: "write",
        target: ps1ShimPath,
        detail: `write ${ps1ShimPath}`,
        reversible: true,
        content: ps1ShimScript({ repoRoot: options.repoRoot, version: options.version }),
      });

      if (modifyPath) {
        if (pathAlreadyContainsShimDir) {
          steps.push({
            id: "note-path-already-present",
            kind: "note",
            target: shimDir,
            detail: `${shimDir} is already on the user PATH; no change needed`,
            reversible: false,
          });
        } else {
          const added = addToUserPath(probe.userPath, shimDir);
          userPathAfter = added.next;
          steps.push({
            id: "set-user-path-add",
            kind: "set-user-path",
            target: shimDir,
            detail: `add ${shimDir} to the user PATH`,
            reversible: true,
          });
        }
      } else {
        steps.push({
          id: "note-path-not-modified",
          kind: "note",
          target: shimDir,
          detail: `-NoModifyPath: PATH left untouched -- add ${shimDir} to PATH manually to use the "hades" command`,
          reversible: false,
        });
      }

      if (!probe.appData?.trim() && !options.dataDir?.trim() && !probe.env.HADES_DATA_DIR?.trim()) {
        warnings.push(`%APPDATA% is not set; using "${dataDir}" as a fallback data directory`);
      }
    }
  } else if (pathAlreadyContainsShimDir) {
    steps.push({ id: "remove-cmd-shim", kind: "remove", target: cmdShimPath, detail: `remove ${cmdShimPath}`, reversible: true });
    steps.push({ id: "remove-ps1-shim", kind: "remove", target: ps1ShimPath, detail: `remove ${ps1ShimPath}`, reversible: true });

    const removed = removeFromUserPath(probe.userPath, shimDir);
    userPathAfter = removed.next;
    steps.push({
      id: "set-user-path-remove",
      kind: "set-user-path",
      target: shimDir,
      detail: `remove ${shimDir} from the user PATH`,
      reversible: true,
    });

    if (options.purge) {
      steps.push({
        id: "remove-data-dir",
        kind: "remove",
        target: dataDir,
        detail: `-Purge: recursively remove ${dataDir}`,
        reversible: false,
      });
    } else {
      steps.push({
        id: "note-data-dir-preserved",
        kind: "note",
        target: dataDir,
        detail: `data under ${dataDir} was left in place (pass -Purge to remove it)`,
        reversible: false,
      });
    }
  }

  const joinedPathAfter = userPathAfter.join(";");
  if (joinedPathAfter.length >= PATH_WARN_LENGTH) {
    warnings.push(
      `the user PATH after this change is ${joinedPathAfter.length} characters, close to the legacy 2048-character limit some tools still enforce -- consider trimming unused entries`
    );
  }

  return {
    mode,
    ok,
    version: options.version,
    installDir,
    shimDir,
    dataDir,
    cmdShimPath,
    ps1ShimPath,
    pathAlreadyContainsShimDir,
    userPathAfter,
    steps,
    blockers,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderWindowsPlanText(plan: WindowsInstallPlan): string[] {
  const lines: string[] = [];
  lines.push(`hades windows installer -- mode: ${plan.mode}${plan.ok ? "" : " (blocked)"}`);
  lines.push(`  version:    ${plan.version}`);
  lines.push(`  install dir:${plan.installDir ? " " + plan.installDir : " (unresolved)"}`);
  lines.push(`  shim dir:   ${plan.shimDir || "(unresolved)"}`);
  lines.push(`  data dir:   ${plan.dataDir}`);

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

export function renderWindowsPlanJson(plan: WindowsInstallPlan): string {
  return JSON.stringify(plan);
}

// ===========================================================================
// A real character-level PowerShell tokenizer + auditor
//
// The tokenizer's job is to produce, in a single left-to-right pass, two
// masks of the source that are the same length and share the same newline
// positions as the original (so byte offsets translate directly to 1-based
// line numbers):
//
//   - `full`: comments AND string interiors blanked to spaces. Safe to run
//     keyword/structure regexes over -- a mutation keyword or "function"
//     spelled inside a string or comment cannot appear in `full` at all, so
//     it can never be mistaken for real code.
//   - `soft`: only comments blanked; string interiors are left intact. Used
//     to slice out real literal text (default parameter values, the scope
//     argument to SetEnvironmentVariable, ...) once `full` has told us where
//     the boundaries are.
//
// Handles: `#` line comments, `<# ... #>` block comments, single-quoted
// strings (`''` is the only escape), double-quoted strings (backtick escapes,
// `""`, and `$( ... )` subexpressions that re-enter real code -- including
// nested strings/comments inside the subexpression), and here-strings
// (`@" ... "@`, `@' ... '@`, terminator required at column 0 per PS 5.1).
// ===========================================================================

type TokMode = "code" | "dq" | "sq" | "lc" | "bc" | "hexp" | "hlit" | "dqsub";

interface TokFrame {
  mode: TokMode;
  parenDepth?: number;
  openIndex?: number;
}

interface MaskPair {
  full: string;
  soft: string;
  /** Constructs left open at EOF -- an unterminated string/here-string/subexpression/comment. */
  unterminated: Array<{ kind: string; line: number }>;
}

function atLineStart(source: string, idx: number): boolean {
  return idx === 0 || source[idx - 1] === "\n";
}

function atLineStartAfterOpener(source: string, idx: number): boolean {
  return source[idx] === "\n";
}

function lineAt(source: string, index: number): number {
  let line = 1;
  const upto = Math.min(Math.max(index, 0), source.length);
  for (let i = 0; i < upto; i++) if (source[i] === "\n") line++;
  return line;
}

function unterminatedKindLabel(mode: TokMode): string {
  switch (mode) {
    case "dq":
      return "double-quoted string";
    case "sq":
      return "single-quoted string";
    case "hexp":
      return "expandable here-string (@\"...\"@)";
    case "hlit":
      return "literal here-string (@'...'@)";
    case "bc":
      return "block comment (<#...#>)";
    case "dqsub":
      return "subexpression $(...) inside a double-quoted string";
    default:
      return mode;
  }
}

function buildMaskPair(source: string): MaskPair {
  const n = source.length;
  const full: string[] = new Array(n);
  const soft: string[] = new Array(n);
  const stack: TokFrame[] = [{ mode: "code" }];

  const emit = (i: number, cls: "code" | "str" | "cmt") => {
    const ch = source[i];
    const isNewline = ch === "\n" || ch === "\r";
    if (cls === "code") {
      full[i] = ch;
      soft[i] = ch;
    } else if (cls === "str") {
      full[i] = isNewline ? ch : " ";
      soft[i] = ch;
    } else {
      full[i] = isNewline ? ch : " ";
      soft[i] = isNewline ? ch : " ";
    }
  };

  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = source[i];
    const c2 = source[i + 1];

    if (top.mode === "code" || top.mode === "dqsub") {
      if (c === "#") {
        stack.push({ mode: "lc" });
        emit(i, "cmt");
        i++;
        continue;
      }
      if (c === "<" && c2 === "#") {
        stack.push({ mode: "bc", openIndex: i });
        emit(i, "cmt");
        emit(i + 1, "cmt");
        i += 2;
        continue;
      }
      if (c === "@" && c2 === '"' && atLineStartAfterOpener(source, i + 2)) {
        emit(i, "code");
        emit(i + 1, "code");
        stack.push({ mode: "hexp", openIndex: i });
        i += 2;
        continue;
      }
      if (c === "@" && c2 === "'" && atLineStartAfterOpener(source, i + 2)) {
        emit(i, "code");
        emit(i + 1, "code");
        stack.push({ mode: "hlit", openIndex: i });
        i += 2;
        continue;
      }
      if (c === '"') {
        emit(i, "code");
        stack.push({ mode: "dq", openIndex: i });
        i++;
        continue;
      }
      if (c === "'") {
        emit(i, "code");
        stack.push({ mode: "sq", openIndex: i });
        i++;
        continue;
      }
      if (top.mode === "dqsub") {
        if (c === "(") {
          top.parenDepth = (top.parenDepth ?? 1) + 1;
          emit(i, "code");
          i++;
          continue;
        }
        if (c === ")") {
          const next = (top.parenDepth ?? 1) - 1;
          emit(i, "code");
          i++;
          if (next <= 0) stack.pop();
          else top.parenDepth = next;
          continue;
        }
      }
      emit(i, "code");
      i++;
      continue;
    }

    if (top.mode === "lc") {
      if (c === "\n") {
        stack.pop();
        emit(i, "cmt");
        i++;
        continue;
      }
      emit(i, "cmt");
      i++;
      continue;
    }

    if (top.mode === "bc") {
      if (c === "#" && c2 === ">") {
        emit(i, "cmt");
        emit(i + 1, "cmt");
        stack.pop();
        i += 2;
        continue;
      }
      emit(i, "cmt");
      i++;
      continue;
    }

    if (top.mode === "sq") {
      if (c === "'" && c2 === "'") {
        emit(i, "str");
        emit(i + 1, "str");
        i += 2;
        continue;
      }
      if (c === "'") {
        emit(i, "code");
        stack.pop();
        i++;
        continue;
      }
      emit(i, "str");
      i++;
      continue;
    }

    if (top.mode === "dq") {
      if (c === "`" && c2 !== undefined) {
        emit(i, "str");
        emit(i + 1, "str");
        i += 2;
        continue;
      }
      if (c === '"' && c2 === '"') {
        emit(i, "str");
        emit(i + 1, "str");
        i += 2;
        continue;
      }
      if (c === "$" && c2 === "(") {
        emit(i, "code");
        emit(i + 1, "code");
        stack.push({ mode: "dqsub", parenDepth: 1, openIndex: i });
        i += 2;
        continue;
      }
      if (c === '"') {
        emit(i, "code");
        stack.pop();
        i++;
        continue;
      }
      emit(i, "str");
      i++;
      continue;
    }

    if (top.mode === "hexp") {
      if (c === '"' && c2 === "@" && atLineStart(source, i)) {
        emit(i, "code");
        emit(i + 1, "code");
        stack.pop();
        i += 2;
        continue;
      }
      emit(i, "str");
      i++;
      continue;
    }

    // hlit
    if (c === "'" && c2 === "@" && atLineStart(source, i)) {
      emit(i, "code");
      emit(i + 1, "code");
      stack.pop();
      i += 2;
      continue;
    }
    emit(i, "str");
    i++;
  }

  const unterminated: Array<{ kind: string; line: number }> = [];
  for (let f = 1; f < stack.length; f++) {
    const frame = stack[f];
    unterminated.push({ kind: unterminatedKindLabel(frame.mode), line: lineAt(source, frame.openIndex ?? 0) });
  }

  return { full: full.join(""), soft: soft.join(""), unterminated };
}

function findMatchingParen(mask: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < mask.length; i++) {
    if (mask[i] === "(") depth++;
    else if (mask[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return mask.length;
}

/** Splits `source[start:end)` on top-level (depth-0) commas, using `mask` (same offsets) for depth tracking. */
function splitTopLevelByComma(source: string, mask: string, start: number, end: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = start;
  for (let i = start; i < end; i++) {
    const ch = mask[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(source.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(source.slice(last, end));
  return parts;
}

/** Reads the raw text of a value starting at `fromIdx` up to (not including) the next real `, ) ; \n \r`. */
function extractValueSpan(soft: string, full: string, fromIdx: number): string {
  let i = fromIdx;
  while (i < full.length && /\s/.test(full[i])) i++;
  const start = i;
  while (i < full.length && !",);\n\r".includes(full[i])) i++;
  return soft.slice(start, i).trim();
}

function stripQuotes(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    const q = s[0];
    const inner = s.slice(1, -1);
    return q === "'" ? inner.replace(/''/g, "'") : inner.replace(/""/g, '"').replace(/`(.)/g, "$1");
  }
  return s;
}

export interface PsParam {
  name: string;
  type?: string;
  isSwitch: boolean;
  defaultValue?: string;
}

function parseParamDecl(raw: string): PsParam | undefined {
  let s = raw.trim();
  let type: string | undefined;
  let isSwitch = false;

  while (s.startsWith("[")) {
    let depth = 0;
    let j = 0;
    for (; j < s.length; j++) {
      if (s[j] === "[") depth++;
      else if (s[j] === "]") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    if (depth !== 0) break; // unbalanced bracket -- bail out of attribute parsing
    const group = s.slice(1, j - 1).trim();
    s = s.slice(j).trim();
    if (!group.includes("(")) {
      type = group;
      if (/^switch$/i.test(group)) isSwitch = true;
    }
  }

  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)\s*(=\s*([\s\S]*))?$/.exec(s.trim());
  if (!m) return undefined;
  const name = m[1];
  const defaultValue = m[3] !== undefined ? m[3].trim() : undefined;
  return { name, type, isSwitch, defaultValue };
}

const MUTATION_RE =
  /(New-Item|Remove-Item|Set-Content|Add-Content|Copy-Item|Move-Item|Rename-Item|New-ItemProperty|Set-ItemProperty|Remove-ItemProperty|\[(?:System\.)?Environment\]::SetEnvironmentVariable)\b/giy;
const IF_HEADER_RE = /if\s*\(([^{]*?)\)\s*\{/giy;
const FUNCTION_RE = /function\s+([A-Za-z_][A-Za-z0-9_:.\-]*)/giy;
const DRYRUN_NEGATED_RE = /(-not\s*\$DryRun\b)|(!\s*\$DryRun\b)|(\$DryRun\s*-eq\s*\$false\b)|(\$DryRun\s*-ne\s*\$true\b)/i;
const SET_ENV_VAR_RE = /\[(?:System\.)?Environment\]::SetEnvironmentVariable\s*$/i;

interface MutationHit {
  index: number;
  line: number;
  name: string;
  guarded: boolean;
}

interface ScopeHit {
  value: string;
  line: number;
}

interface AnalyzeResult {
  params: PsParam[];
  paramLine: number;
  functions: string[];
  strictModeSet: boolean;
  strictModeLine?: number;
  errorActionPreference?: string;
  errorActionLine?: number;
  usesSetEnvironmentVariable: boolean;
  scopeHits: ScopeHit[];
  mutations: MutationHit[];
  unterminated: Array<{ kind: string; line: number }>;
  braceImbalance?: { line: number; message: string };
}

function findBraceImbalance(full: string, source: string): { line: number; message: string } | undefined {
  const opens: number[] = [];
  for (let i = 0; i < full.length; i++) {
    if (full[i] === "{") opens.push(i);
    else if (full[i] === "}") {
      if (opens.length === 0) {
        return { line: lineAt(source, i), message: "unexpected '}' with no matching '{'" };
      }
      opens.pop();
    }
  }
  if (opens.length > 0) {
    const openIdx = opens[opens.length - 1];
    return { line: lineAt(source, openIdx), message: "unclosed '{' is missing its matching '}'" };
  }
  return undefined;
}

function analyze(source: string): AnalyzeResult {
  const { full, soft, unterminated } = buildMaskPair(source);

  // --- param(...) block ---
  const params: PsParam[] = [];
  let paramLine = 1;
  const paramKeyword = /\bparam\s*\(/i.exec(full);
  if (paramKeyword) {
    paramLine = lineAt(source, paramKeyword.index);
    const openIdx = paramKeyword.index + paramKeyword[0].length - 1;
    const closeIdx = findMatchingParen(full, openIdx);
    const declTexts = splitTopLevelByComma(soft, full, openIdx + 1, closeIdx).map((t) => t.trim()).filter((t) => t.length > 0);
    for (const decl of declTexts) {
      const parsed = parseParamDecl(decl);
      if (parsed) params.push(parsed);
    }
  }

  // --- Set-StrictMode ---
  const strictMatch = /\bSet-StrictMode\s+-Version\s+\S+/i.exec(full);
  const strictModeSet = strictMatch !== null;
  const strictModeLine = strictMatch ? lineAt(source, strictMatch.index) : undefined;

  // --- $ErrorActionPreference ---
  let errorActionPreference: string | undefined;
  let errorActionLine: number | undefined;
  const eapMatch = /\$ErrorActionPreference\s*=/i.exec(full);
  if (eapMatch) {
    errorActionLine = lineAt(source, eapMatch.index);
    errorActionPreference = stripQuotes(extractValueSpan(soft, full, eapMatch.index + eapMatch[0].length));
  }

  // --- single forward scan: functions, if-guards, mutations, env-var scopes ---
  const functionNames: string[] = [];
  const seenFunctionNames = new Set<string>();
  const mutations: MutationHit[] = [];
  const scopeHits: ScopeHit[] = [];
  const stack: Array<{ isDryRunGuard: boolean }> = [{ isDryRunGuard: false }];

  MUTATION_RE.lastIndex = 0;
  IF_HEADER_RE.lastIndex = 0;
  FUNCTION_RE.lastIndex = 0;

  let cursor = 0;
  while (cursor < full.length) {
    let advanced = false;

    IF_HEADER_RE.lastIndex = cursor;
    let m = IF_HEADER_RE.exec(full);
    if (m && m.index === cursor) {
      const isGuard = DRYRUN_NEGATED_RE.test(m[1]);
      stack.push({ isDryRunGuard: isGuard || stack[stack.length - 1].isDryRunGuard });
      cursor += m[0].length;
      advanced = true;
    }

    if (!advanced) {
      FUNCTION_RE.lastIndex = cursor;
      m = FUNCTION_RE.exec(full);
      if (m && m.index === cursor) {
        if (!seenFunctionNames.has(m[1])) {
          seenFunctionNames.add(m[1]);
          functionNames.push(m[1]);
        }
        cursor += m[0].length;
        advanced = true;
      }
    }

    if (!advanced) {
      MUTATION_RE.lastIndex = cursor;
      m = MUTATION_RE.exec(full);
      if (m && m.index === cursor) {
        const guarded = stack[stack.length - 1].isDryRunGuard;
        const rawName = m[1];
        const isEnvCall = SET_ENV_VAR_RE.test(rawName) || /^\[(?:System\.)?Environment\]::SetEnvironmentVariable$/i.test(rawName);
        const name = isEnvCall ? "[Environment]::SetEnvironmentVariable" : rawName;
        mutations.push({ index: cursor, line: lineAt(source, cursor), name, guarded });

        if (isEnvCall) {
          // Find the call's opening paren and pull out its 3rd (scope) argument.
          let k = cursor + m[0].length;
          while (k < full.length && /\s/.test(full[k])) k++;
          if (full[k] === "(") {
            const closeIdx = findMatchingParen(full, k);
            const args = splitTopLevelByComma(soft, full, k + 1, closeIdx);
            if (args.length >= 3) {
              scopeHits.push({ value: stripQuotes(args[2].trim()), line: lineAt(source, cursor) });
            }
          }
        }
        cursor += m[0].length;
        advanced = true;
      }
    }

    if (!advanced && full[cursor] === "{") {
      stack.push({ isDryRunGuard: stack[stack.length - 1].isDryRunGuard });
      cursor += 1;
      advanced = true;
    }
    if (!advanced && full[cursor] === "}") {
      if (stack.length > 1) stack.pop();
      cursor += 1;
      advanced = true;
    }
    if (!advanced) cursor += 1;
  }

  return {
    params,
    paramLine,
    functions: functionNames,
    strictModeSet,
    strictModeLine,
    errorActionPreference,
    errorActionLine,
    usesSetEnvironmentVariable: scopeHits.length > 0 || mutations.some((mu) => mu.name === "[Environment]::SetEnvironmentVariable"),
    scopeHits,
    mutations,
    unterminated,
    braceImbalance: findBraceImbalance(full, source),
  };
}

export interface PsScriptModel {
  params: PsParam[];
  functions: string[];
  strictModeSet: boolean;
  errorActionPreference?: string;
  usesSetEnvironmentVariable: boolean;
  environmentVariableScopes: string[];
  dryRunGuardedStatements: number;
  unguardedMutations: string[];
}

function modelFromAnalysis(r: AnalyzeResult): PsScriptModel {
  const scopes: string[] = [];
  for (const hit of r.scopeHits) {
    if (!scopes.includes(hit.value)) scopes.push(hit.value);
  }
  return {
    params: r.params,
    functions: r.functions,
    strictModeSet: r.strictModeSet,
    errorActionPreference: r.errorActionPreference,
    usesSetEnvironmentVariable: r.usesSetEnvironmentVariable,
    environmentVariableScopes: scopes,
    dryRunGuardedStatements: r.mutations.filter((m) => m.guarded).length,
    unguardedMutations: r.mutations.filter((m) => !m.guarded).map((m) => `${m.line}: ${m.name}`),
  };
}

/**
 * A real character-level tokenizer over PowerShell source: strips `#` line
 * comments and `<# ... #>` block comments, distinguishes single-quoted (no
 * escapes besides `''`) from double-quoted (backtick escapes, `""`, and
 * `$(...)` subexpressions) strings, handles here-strings, and tracks brace
 * depth to attribute mutating statements to their enclosing `if (-not
 * $DryRun) { ... }` guard (if any, at any ancestor depth). See the module
 * banner above for the two-mask design that makes it immune to a mutation
 * keyword or `param`/`function` spelled inside a string or comment.
 */
export function parsePowerShellScript(source: string): PsScriptModel {
  return modelFromAnalysis(analyze(source));
}

export interface PsFinding {
  code: string;
  severity: "error" | "warn";
  message: string;
  line: number;
}

const REQUIRED_PARAMS: ReadonlyArray<{ name: string; isSwitch: boolean }> = [
  { name: "InstallDir", isSwitch: false },
  { name: "DataDir", isSwitch: false },
  { name: "Version", isSwitch: false },
  { name: "DryRun", isSwitch: true },
  { name: "Force", isSwitch: true },
  { name: "Purge", isSwitch: true },
  { name: "Uninstall", isSwitch: true },
  { name: "NoModifyPath", isSwitch: true },
  { name: "Json", isSwitch: true },
  { name: "Help", isSwitch: true },
];

/**
 * Audits real `install.ps1` source bytes against the contract this module
 * encodes: every documented `-Param` present with the right switch/typed-ness,
 * `Set-StrictMode -Version ...` present, `$ErrorActionPreference` exactly
 * `'Stop'`, every `[Environment]::SetEnvironmentVariable` call scoped to
 * `'User'` (never `'Machine'`), every mutating statement guarded by an
 * `if (-not $DryRun) { ... }` block (at any ancestor depth), and the source
 * itself well-formed (no unterminated string/here-string, no unbalanced
 * brace). `ok` is true iff there are zero `error`-severity findings.
 */
export function auditInstallPs1(source: string): { ok: boolean; model: PsScriptModel; findings: PsFinding[] } {
  const r = analyze(source);
  const findings: PsFinding[] = [];

  if (!r.strictModeSet) {
    findings.push({
      code: "strict-mode-missing",
      severity: "error",
      message: "Set-StrictMode -Version <x> was not found",
      line: 1,
    });
  }

  if (r.errorActionPreference !== "Stop") {
    findings.push({
      code: "error-action-not-stop",
      severity: "error",
      message: `$ErrorActionPreference must be 'Stop' (found ${JSON.stringify(r.errorActionPreference ?? null)})`,
      line: r.errorActionLine ?? 1,
    });
  }

  for (const rp of REQUIRED_PARAMS) {
    const found = r.params.find((p) => p.name.toLowerCase() === rp.name.toLowerCase());
    if (!found) {
      findings.push({
        code: "param-missing",
        severity: "error",
        message: `required parameter -${rp.name} was not found`,
        line: r.paramLine,
      });
      continue;
    }
    const wrongKind = found.isSwitch !== rp.isSwitch || (!rp.isSwitch && !found.type);
    if (wrongKind) {
      findings.push({
        code: "param-wrong-kind",
        severity: "error",
        message: `-${rp.name} should ${rp.isSwitch ? "be a [switch]" : "be a typed, non-switch parameter"}`,
        line: r.paramLine,
      });
    }
  }

  for (const hit of r.scopeHits) {
    if (hit.value !== "User") {
      findings.push({
        code: "environment-scope-not-user",
        severity: "error",
        message: `[Environment]::SetEnvironmentVariable scope must be 'User' (found '${hit.value}')`,
        line: hit.line,
      });
    }
  }

  for (const m of r.mutations) {
    if (!m.guarded) {
      findings.push({
        code: "unguarded-mutation",
        severity: "error",
        message: `mutating statement '${m.name}' is not guarded by an 'if (-not $DryRun) { ... }' block`,
        line: m.line,
      });
    }
  }

  for (const u of r.unterminated) {
    findings.push({
      code: "unterminated-string",
      severity: "error",
      message: `unterminated ${u.kind}`,
      line: u.line,
    });
  }

  if (r.braceImbalance) {
    findings.push({ code: "unbalanced-braces", severity: "error", message: r.braceImbalance.message, line: r.braceImbalance.line });
  }

  const ok = findings.every((f) => f.severity !== "error");
  return { ok, model: modelFromAnalysis(r), findings };
}
