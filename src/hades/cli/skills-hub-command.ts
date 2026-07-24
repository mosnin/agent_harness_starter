/**
 * `hades skills hub <sub>` — bidirectional agentskills.io interop for the
 * Hades skill library.
 *
 *   hades skills hub import <dir> [--dry-run] [--force]
 *   hades skills hub export <name> <dir>
 *   hades skills hub check <dir>
 *   hades skills hub help
 *
 * Format conversion and filesystem hardening (path-traversal safety, byte
 * limits, injection quarantine) are entirely `../skills/hub-package`'s job;
 * this module is a thin, pure terminal front end over it — no `process.exit`,
 * no direct stdout writes, terminal-free (`{ code, lines }`) so it
 * unit-tests without a shell, matching the house pattern documented in
 * `./backends-command.ts` (`runBackendsCommand`).
 *
 * INTEGRATION NOTE: wiring the `skills hub` case into `HadesCli`
 * (`src/hades/cli/cli.ts`) is explicitly the central-integration pass's
 * job, not this file's. This module only exports `runSkillsHubCommand` /
 * `SkillsHubDeps`; it never touches `cli.ts`, any barrel, or any other
 * team's files.
 */
import {
  importSkillPackage,
  exportSkillPackage,
  defaultHubFs,
  type HubFs,
  type HubDirEntry,
  type ImportReport,
} from "../skills/hub-package";
import { SkillLibrary } from "../skills/library";

export interface SkillsHubDeps {
  /** The Hades skill library directory `import`/`export` read from and write to. */
  libraryDir: string;
  /** Injectable minimal fs facade (see `HubFs`); defaults to real `node:fs/promises`. */
  fs?: HubFs;
  /** Wrap width for long lines (findings, reasons, warnings); default 100. */
  stdoutWidth?: number;
}

export interface SkillsHubCommandResult {
  code: number;
  lines: string[];
}

const USAGE = [
  "Usage: hades skills hub <command>",
  "",
  "Commands:",
  "  import <dir> [--dry-run] [--force]  Import agentskills.io skill package(s) (SKILL.md) from <dir>",
  "  export <name> <dir>                 Export a Hades skill as an agentskills.io package into <dir>",
  "  check <dir>                         Validate agentskills.io skill package(s) in <dir> without installing",
  "  help                                 Show this help",
  "",
  "`import`/`check` never install a skill whose body is flagged by the",
  "injection scanner — flagged skills are quarantined (reported, not",
  "installed, source files left untouched) and the command exits non-zero.",
];

// ---------------------------------------------------------------------------
// local helpers (own copies, matching the house convention documented in
// backends-command.ts — this file never imports another CLI command
// module's internals)
// ---------------------------------------------------------------------------

function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, "");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Load every `.md` file directly under `libraryDir` into a real `SkillLibrary`. An absent/unreadable directory is treated as an empty library, not an error. */
async function loadLibrary(
  fs: HubFs,
  libraryDir: string
): Promise<{ library: SkillLibrary; errors: Array<{ path: string; error: string }> }> {
  const library = new SkillLibrary();

  let entries: HubDirEntry[];
  try {
    entries = await fs.readdir(libraryDir);
  } catch {
    return { library, errors: [] };
  }

  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const path = `${libraryDir.replace(/[/\\]+$/, "")}/${entry.name}`;
    try {
      const content = await fs.readFile(path, "utf8");
      files.push({ path, content });
    } catch {
      // unreadable file — silently excluded from the library, same as an
      // absent directory; `export` will simply report "no skill named X".
    }
  }

  const report = library.loadFiles(files);
  return { library, errors: report.errors };
}

function renderImportReport(report: ImportReport, dryRun: boolean, width: number, verb: "import" | "check"): string[] {
  const lines: string[] = [];

  if (report.installed.length === 0 && report.skipped.length === 0 && report.quarantined.length === 0) {
    lines.push("No agentskills.io skill packages (SKILL.md) found.");
    return lines;
  }

  const label = dryRun ? (verb === "check" ? "would install" : "would install (--dry-run)") : "installed";
  if (report.installed.length > 0) {
    lines.push(`${label}: ${report.installed.length}`);
    for (const it of report.installed) lines.push(`  + ${sanitize(it.name)} -> ${sanitize(it.path)}`);
  } else {
    lines.push(`${label}: 0`);
  }

  if (report.quarantined.length > 0) {
    lines.push("", `quarantined: ${report.quarantined.length} (NOT installed — review required)`);
    for (const q of report.quarantined) {
      lines.push(`  ! ${sanitize(q.path)}`);
      for (const f of q.findings) lines.push(`      - ${truncate(sanitize(f), width)}`);
    }
  }

  if (report.skipped.length > 0) {
    lines.push("", `skipped: ${report.skipped.length}`);
    for (const s of report.skipped) lines.push(`  - ${sanitize(s.path)}: ${truncate(sanitize(s.reason), width)}`);
  }

  if (report.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const w of report.warnings) lines.push(`  * ${truncate(sanitize(w), width)}`);
  }

  return lines;
}

function reportExitCode(report: ImportReport): number {
  if (report.quarantined.length > 0) return 1;
  return report.installed.length > 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// runSkillsHubCommand
// ---------------------------------------------------------------------------

export async function runSkillsHubCommand(args: string[], deps: SkillsHubDeps): Promise<SkillsHubCommandResult> {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }

  const fs = deps.fs ?? defaultHubFs;
  const width = deps.stdoutWidth !== undefined && deps.stdoutWidth > 20 ? deps.stdoutWidth : 100;

  if (sub === "import") {
    const dir = rest[0];
    const usage = "Usage: hades skills hub import <dir> [--dry-run] [--force]";
    if (!dir) return { code: 1, lines: [usage] };

    const flags = rest.slice(1);
    const dryRun = flags.includes("--dry-run");
    const force = flags.includes("--force");
    const unknown = flags.filter((f) => f !== "--dry-run" && f !== "--force");
    if (unknown.length > 0) {
      return { code: 1, lines: [`Unknown flag: ${sanitize(unknown[0])}`, usage] };
    }

    let report: ImportReport;
    try {
      report = await importSkillPackage(dir, deps.libraryDir, { fs, dryRun, force });
    } catch (err) {
      return { code: 1, lines: [`import failed: ${errMsg(err)}`] };
    }

    return { code: reportExitCode(report), lines: renderImportReport(report, dryRun, width, "import") };
  }

  if (sub === "export") {
    const name = rest[0];
    const dir = rest[1];
    const usage = "Usage: hades skills hub export <name> <dir>";
    if (!name || !dir) return { code: 1, lines: [usage] };

    const { library, errors } = await loadLibrary(fs, deps.libraryDir);
    const entry = library.get(name);
    if (!entry) {
      const lines = [`No skill named "${sanitize(name)}" found in ${sanitize(deps.libraryDir)}.`];
      if (errors.length > 0) {
        lines.push("", `${errors.length} file(s) in the library failed to load:`);
        for (const e of errors) lines.push(`  ${sanitize(e.path)}: ${sanitize(e.error)}`);
      }
      return { code: 1, lines };
    }

    try {
      const result = await exportSkillPackage(entry.manifest, dir, { fs });
      const lines = [`Exported "${sanitize(entry.manifest.name)}" -> ${sanitize(result.path)}`];
      for (const w of result.warnings) lines.push(`  warning: ${truncate(sanitize(w), width)}`);
      return { code: 0, lines };
    } catch (err) {
      return { code: 1, lines: [`export failed: ${errMsg(err)}`] };
    }
  }

  if (sub === "check") {
    const dir = rest[0];
    const usage = "Usage: hades skills hub check <dir>";
    if (!dir) return { code: 1, lines: [usage] };

    let report: ImportReport;
    try {
      report = await importSkillPackage(dir, deps.libraryDir, { fs, dryRun: true });
    } catch (err) {
      return { code: 1, lines: [`check failed: ${errMsg(err)}`] };
    }

    return { code: reportExitCode(report), lines: renderImportReport(report, true, width, "check") };
  }

  return { code: 1, lines: [`Unknown skills hub command: ${sanitize(sub)}`, "Run `hades skills hub help` for usage."] };
}
