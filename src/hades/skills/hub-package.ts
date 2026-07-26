/**
 * hub-package — a hardened importer/exporter between the open agentskills.io
 * package layout (a directory tree containing one or more `SKILL.md` files,
 * agentskills.io/Anthropic frontmatter vocabulary) and Hades' own skill
 * library layout (a flat directory of Hades-format `<name>.md` SKILL.md
 * files, loadable by the real {@link SkillLibrary}).
 *
 * Format conversion is delegated entirely to `./agentskills-compat`
 * ({@link parseAgentSkill}, {@link toHadesManifest}, {@link fromHadesManifest});
 * this module owns everything about touching the filesystem safely:
 *
 *   - path traversal is impossible: a skill's `name` field is validated
 *     before it is ever used to build a destination path (rejecting `..`,
 *     path separators, absolute-path forms, and control characters), and
 *     the source-directory walk refuses to follow any symlink whose real
 *     target resolves outside the source directory ("the symlink jail").
 *   - byte limits are enforced per-file and in aggregate, with exact,
 *     actionable error messages.
 *   - a flagged skill (see {@link scanSkillInstructions}) is QUARANTINED —
 *     reported, never installed, and the source file is never touched or
 *     deleted.
 *   - `dryRun` computes and reports the exact same decisions without
 *     writing or creating anything.
 *   - `force` is the only way to overwrite an existing installed skill, and
 *     every overwrite is recorded explicitly in the report's `warnings`.
 *
 * REAL-VS-MOCK POLICY: all filesystem operations here are real (via
 * {@link HubFs}, injectable only so fault paths — a `readdir` that throws, a
 * `writeFile` that fails — are unit-testable without a real broken
 * filesystem). There is no network access anywhere in this module; fetching
 * a package from agentskills.io itself is out of scope by design.
 */

import * as nodeFsPromises from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  parseAgentSkill,
  toHadesManifest,
  fromHadesManifest,
  type AgentSkillsManifest,
} from "./agentskills-compat";
import { serializeSkillFile, validateSkillManifest, type SkillManifest } from "./skill-file";

// ===========================================================================
// fs facade
// ===========================================================================

/** A single directory entry, matching the shape of `node:fs`'s `Dirent`. */
export interface HubDirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** A single `stat`/`lstat` result, matching the shape of `node:fs`'s `Stats`. */
export interface HubStat {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
}

/**
 * Minimal fs surface the hub package importer/exporter needs, injectable so
 * fault paths (a directory that can't be read, a write that fails partway)
 * are fully testable without touching a real broken filesystem. Defaults to
 * a thin wrapper over `node:fs/promises`.
 */
export interface HubFs {
  readdir(path: string): Promise<HubDirEntry[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<HubStat>;
  /** Resolves symlinks; used both for byte-safe reads and for the symlink jail check. */
  realpath(path: string): Promise<string>;
}

export const defaultHubFs: HubFs = {
  async readdir(path) {
    return (await nodeFsPromises.readdir(path, { withFileTypes: true })) as unknown as HubDirEntry[];
  },
  async readFile(path, encoding) {
    return nodeFsPromises.readFile(path, encoding);
  },
  async writeFile(path, data, encoding) {
    await nodeFsPromises.writeFile(path, data, encoding);
  },
  async mkdir(path, options) {
    await nodeFsPromises.mkdir(path, options);
  },
  async stat(path) {
    return nodeFsPromises.stat(path);
  },
  async realpath(path) {
    return nodeFsPromises.realpath(path);
  },
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===========================================================================
// import report
// ===========================================================================

export interface ImportReport {
  installed: Array<{ name: string; path: string }>;
  skipped: Array<{ path: string; reason: string }>;
  quarantined: Array<{ path: string; findings: string[] }>;
  warnings: string[];
}

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB per SKILL.md
export const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MiB per import run

// ===========================================================================
// scanSkillInstructions — deterministic prompt-injection quarantine scanner
// ===========================================================================

/** System-prompt-override phrasing — jailbreak/override attempts. */
const OVERRIDE_PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)\b/i,
  /\bdisregard\s+(the\s+)?(system\s+prompt|previous\s+instructions|your\s+instructions)\b/i,
  /\byou\s+are\s+now\s+(in\s+)?(developer|debug|unrestricted|jailbreak)\s+mode\b/i,
  /\breveal\s+(your\s+)?(system\s+prompt|hidden\s+instructions)\b/i,
  /\bact\s+as\s+if\s+you\s+have\s+no\s+(restrictions|rules|guidelines)\b/i,
  /\boverride\s+(your\s+)?(system\s+)?instructions\b/i,
  /\bthis\s+is\s+a\s+new\s+system\s+prompt\b/i,
];

/** Key/credential exfiltration asks. */
const EXFIL_PATTERNS: RegExp[] = [
  /\b(send|upload|post|exfiltrate|leak|transmit)\b[^\n]{0,80}\b(api[\s_-]?key|secret\s*key|credentials?|passwords?|access\s*token|private\s*key)\b/i,
  /\b(api[\s_-]?key|credentials?|password|access\s*token|private\s*key)\b[^\n]{0,60}\b(to|into)\b[^\n]{0,40}https?:\/\//i,
];

/** Tool names that, if requested via `allowed-tools`, are treated as an escalation ask. */
const ESCALATION_TOOL_NAMES = new Set([
  "shell",
  "bash",
  "sh",
  "exec",
  "powershell",
  "http",
  "curl",
  "wget",
  "fetch",
  "network",
  "socket",
]);

/** A run of 512+ contiguous base64-alphabet characters — an oversized embedded payload. */
const BASE64_BLOB_RE = /[A-Za-z0-9+/]{512,}={0,2}/;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Deterministic injection findings for a parsed skill's body + manifest.
 * Never network, never fuzzy/probabilistic — every finding is a fixed,
 * reviewable rule so `importSkillPackage` behaves identically on every run.
 * A benign skill that merely mentions a sensitive word in prose (e.g. "you
 * can automate this with a shell script") must NOT trigger a finding —
 * `allowed-tools` escalation is checked against the manifest's tool list,
 * never against body prose.
 */
export function scanSkillInstructions(body: string, manifest: AgentSkillsManifest): string[] {
  const findings: string[] = [];

  for (const re of OVERRIDE_PATTERNS) {
    const m = body.match(re);
    if (m) findings.push(`system-prompt-override phrasing detected: "${truncate(m[0], 100)}"`);
  }
  for (const re of EXFIL_PATTERNS) {
    const m = body.match(re);
    if (m) findings.push(`credential exfiltration phrasing detected: "${truncate(m[0], 100)}"`);
  }
  for (const tool of manifest.allowedTools ?? []) {
    const norm = tool.trim().toLowerCase();
    if (ESCALATION_TOOL_NAMES.has(norm)) {
      findings.push(`tool-allowlist escalation: allowed-tools includes "${tool}"`);
    }
  }
  const blob = body.match(BASE64_BLOB_RE);
  if (blob) {
    findings.push(`oversized base64 blob detected in skill body (length=${blob[0].length})`);
  }

  return findings;
}

// ===========================================================================
// path safety
// ===========================================================================

/**
 * A skill `name` is rejected — never used to build a filesystem path — if it
 * could plausibly be a path traversal attempt: empty, containing `..`, any
 * path separator, a Windows drive-letter absolute prefix, a leading `.`, or
 * a control character (including a null byte).
 */
function isUnsafeName(raw: string): boolean {
  if (raw.trim() === "") return true;
  if (raw.includes("..")) return true;
  if (raw.includes("/") || raw.includes("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return true;
  if (raw.startsWith(".")) return true;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F]/.test(raw)) return true;
  return false;
}

/** Turn a (already-validated-safe) skill name into a filesystem-friendly single path segment. */
function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "skill" : s;
}

function isSkillFileName(name: string): boolean {
  return name.toLowerCase() === "skill.md";
}

// ===========================================================================
// findSkillFiles — the symlink-jailed, cycle-safe directory walk
// ===========================================================================

async function findSkillFiles(
  fs: HubFs,
  root: string,
  rootReal: string,
  report: ImportReport
): Promise<string[]> {
  const results: string[] = [];
  const visitedRealDirs = new Set<string>();

  async function walk(current: string): Promise<void> {
    let currentReal: string;
    try {
      currentReal = await fs.realpath(current);
    } catch (err) {
      report.warnings.push(`cannot resolve directory "${current}": ${errMsg(err)}`);
      return;
    }
    if (visitedRealDirs.has(currentReal)) return; // symlink cycle guard
    visitedRealDirs.add(currentReal);

    let entries: HubDirEntry[];
    try {
      entries = await fs.readdir(current);
    } catch (err) {
      report.warnings.push(`cannot read directory "${current}": ${errMsg(err)}`);
      return;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);

      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = await fs.realpath(full);
        } catch (err) {
          report.skipped.push({ path: full, reason: `cannot resolve symlink: ${errMsg(err)}` });
          continue;
        }
        const rel = relative(rootReal, real);
        const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
        if (escapes) {
          report.skipped.push({
            path: full,
            reason: `symlink escapes the package root — refusing to follow it (target: ${real}).`,
          });
          continue;
        }
        let st: HubStat;
        try {
          st = await fs.stat(full);
        } catch (err) {
          report.skipped.push({ path: full, reason: `cannot stat symlink target: ${errMsg(err)}` });
          continue;
        }
        if (st.isDirectory()) {
          await walk(full);
        } else if (st.isFile() && isSkillFileName(entry.name)) {
          results.push(full);
        }
        continue;
      }

      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && isSkillFileName(entry.name)) {
        results.push(full);
      }
    }
  }

  await walk(root);
  return results;
}

// ===========================================================================
// importSkillPackage
// ===========================================================================

export interface ImportSkillPackageOptions {
  fs?: HubFs;
  dryRun?: boolean;
  force?: boolean;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/**
 * Import every `SKILL.md` found under `sourceDir` (recursively — a
 * "package" may be a single directory with one `SKILL.md`, or a collection
 * of subdirectories each with their own) into `targetLibraryDir` as
 * Hades-format `<slug>.md` skill files, loadable by the real
 * {@link SkillLibrary}.
 *
 * Nothing here ever throws for a bad individual file — parse errors, unsafe
 * names, oversized files, and injection findings all land in the returned
 * report instead. The only way this rejects outright is if `sourceDir`
 * itself cannot be resolved at all (returned as a `warnings` entry with an
 * otherwise-empty report).
 */
export async function importSkillPackage(
  sourceDir: string,
  targetLibraryDir: string,
  opts?: ImportSkillPackageOptions
): Promise<ImportReport> {
  const fs = opts?.fs ?? defaultHubFs;
  const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = opts?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const dryRun = opts?.dryRun ?? false;
  const force = opts?.force ?? false;

  const report: ImportReport = { installed: [], skipped: [], quarantined: [], warnings: [] };

  let rootReal: string;
  try {
    rootReal = await fs.realpath(sourceDir);
  } catch (err) {
    report.warnings.push(`cannot resolve source directory "${sourceDir}": ${errMsg(err)}`);
    return report;
  }

  const candidates = await findSkillFiles(fs, sourceDir, rootReal, report);
  const namesThisRun = new Set<string>(); // dedupe within a single import run

  let totalBytes = 0;

  for (const filePath of candidates) {
    let size: number;
    try {
      const st = await fs.stat(filePath);
      size = st.size;
    } catch (err) {
      report.skipped.push({ path: filePath, reason: `stat failed: ${errMsg(err)}` });
      continue;
    }
    if (size > maxFileBytes) {
      report.skipped.push({
        path: filePath,
        reason: `file exceeds maxFileBytes (${size} bytes > ${maxFileBytes} byte limit).`,
      });
      continue;
    }
    if (totalBytes + size > maxTotalBytes) {
      report.skipped.push({
        path: filePath,
        reason: `aggregate import size exceeds maxTotalBytes (${totalBytes + size} bytes > ${maxTotalBytes} byte limit).`,
      });
      continue;
    }
    totalBytes += size;

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err) {
      report.skipped.push({ path: filePath, reason: `read failed: ${errMsg(err)}` });
      continue;
    }

    let parsed: ReturnType<typeof parseAgentSkill>;
    try {
      parsed = parseAgentSkill(content);
    } catch (err) {
      report.skipped.push({ path: filePath, reason: `parse failed: ${errMsg(err)}` });
      continue;
    }
    for (const w of parsed.warnings) report.warnings.push(`${filePath}: ${w}`);

    if (isUnsafeName(parsed.manifest.name)) {
      report.skipped.push({
        path: filePath,
        reason: `unsafe skill name "${parsed.manifest.name}" rejected to prevent path traversal.`,
      });
      continue;
    }

    const findings = scanSkillInstructions(parsed.body, parsed.manifest);
    if (findings.length > 0) {
      report.quarantined.push({ path: filePath, findings });
      continue; // never installed, source file never touched
    }

    const { manifest: hadesManifest, warnings: mapWarnings } = toHadesManifest(parsed.manifest, parsed.body);
    for (const w of mapWarnings) report.warnings.push(`${filePath}: ${w}`);

    const validation = validateSkillManifest(hadesManifest);
    if (!validation.valid) {
      report.skipped.push({ path: filePath, reason: `invalid Hades manifest: ${validation.errors.join("; ")}` });
      continue;
    }

    const fileName = `${slugify(hadesManifest.name)}.md`;
    if (namesThisRun.has(fileName)) {
      report.skipped.push({
        path: filePath,
        reason: `duplicate skill name "${hadesManifest.name}" within this import — the first one wins.`,
      });
      continue;
    }

    const destPath = join(targetLibraryDir, fileName);
    let alreadyExists = false;
    try {
      await fs.stat(destPath);
      alreadyExists = true;
    } catch {
      alreadyExists = false;
    }

    if (alreadyExists && !force) {
      report.skipped.push({
        path: filePath,
        reason: `skill "${hadesManifest.name}" already exists at ${destPath} (use --force to overwrite).`,
      });
      continue;
    }

    const serialized = serializeSkillFile(hadesManifest);

    if (!dryRun) {
      await fs.mkdir(targetLibraryDir, { recursive: true });
      await fs.writeFile(destPath, serialized, "utf8");
    }

    if (alreadyExists && force) {
      report.warnings.push(`overwrote existing skill "${hadesManifest.name}" at ${destPath} (--force).`);
    }

    namesThisRun.add(fileName);
    report.installed.push({ name: hadesManifest.name, path: destPath });
  }

  return report;
}

// ===========================================================================
// exportSkillPackage
// ===========================================================================

/**
 * Export a Hades {@link SkillManifest} as an agentskills.io-format package:
 * a directory named after the (slugified) skill containing a `SKILL.md`.
 * Conversion is delegated to {@link fromHadesManifest}; this function only
 * validates the source manifest and writes the file.
 */
export async function exportSkillPackage(
  manifest: SkillManifest,
  destDir: string,
  opts?: { fs?: HubFs }
): Promise<{ path: string; warnings: string[] }> {
  const fs = opts?.fs ?? defaultHubFs;

  const validation = validateSkillManifest(manifest);
  if (!validation.valid) {
    throw new Error(`cannot export invalid SkillManifest "${manifest.name}": ${validation.errors.join("; ")}`);
  }

  const { content, warnings } = fromHadesManifest(manifest);
  const slug = slugify(manifest.name);
  const pkgDir = join(destDir, slug);
  await fs.mkdir(pkgDir, { recursive: true });
  const path = join(pkgDir, "SKILL.md");
  await fs.writeFile(path, content, "utf8");

  return { path, warnings };
}
