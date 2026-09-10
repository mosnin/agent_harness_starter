/* ------------------------------------------------------------------ *
 * live-manifest-verify.ts — an INDEPENDENT, byte-level auditor for a
 * published live-showdown run directory (`runs/live-*`), plus an honest
 * readiness summary for the keyed exit lane.
 *
 * This module is deliberately separate from `./showdown-live`'s own
 * `verifyLiveArtifacts`: that function is the *engine's* self-check (it
 * knows about `report.md` / `audit.jsonl` / `result.json` and re-derives
 * V-TPH$ figures). This module is a third-party-style auditor: it only
 * trusts `manifest.json`'s own `files[]` listing and the real `sha256Hex`
 * function, re-hashing the exact bytes on disk. It never assumes which
 * artifact names exist beyond what the manifest itself claims, it refuses
 * to read anything outside the target directory, and it never throws —
 * every failure mode (missing file, bad JSON, a rejecting fs, a hostile
 * path) becomes a named, honest `AuditCheck`.
 *
 * HONESTY CONTRACT: this module does not run a showdown, does not write
 * to any `runs/` directory outside its own tests, and never validates the
 * manifest's `model` field against any allow-list — an unrecognized model
 * name is reported verbatim, not flagged or normalized. It fabricates
 * nothing: every check either re-derives a real fact from the real bytes
 * on disk, or honestly says it could not.
 *
 * Import boundary (locked, shared with ./showdown-verify-command.ts):
 * `../bench/showdown-live` (types/constants/preflight — imported, never
 * redeclared), `../styx/certificate` (`sha256Hex`), node builtins, and
 * this team's own files. No other project module is imported.
 * ------------------------------------------------------------------ */

import { readFile as fsReadFile, readdir as fsReaddir } from "node:fs/promises";
import { basename as pathBasename, isAbsolute, join } from "node:path";
import { sha256Hex } from "../styx/certificate";
import { LIVE_MANIFEST_VERSION, preflightLiveShowdown } from "./showdown-live";
import type { LiveRunManifest } from "./showdown-live";

// ===========================================================================
// Locked contract types
// ===========================================================================

export interface AuditCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ManifestAudit {
  /** true iff every check ok */
  ok: boolean;
  checks: AuditCheck[];
  /** present only when parse+shape passed */
  manifest?: LiveRunManifest;
}

export interface AuditFsDeps {
  readFile(path: string, enc: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

export interface ReadinessReport {
  ready: boolean;
  lines: string[];
}

// ===========================================================================
// Default fs deps (real node:fs/promises)
// ===========================================================================

const defaultAuditFsDeps: AuditFsDeps = {
  readFile: (path, enc) => fsReadFile(path, enc),
  readdir: (path) => fsReaddir(path),
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ===========================================================================
// manifest.json field-by-field shape validation (against the REAL
// LiveRunManifest shape in ./showdown-live — never redeclared, only
// structurally checked here)
// ===========================================================================

/**
 * Validates every field EXCEPT `version` (its own dedicated check, below,
 * so a version bump is caught by the RIGHT named check rather than buried
 * inside a generic shape failure) and `model` non-emptiness (also its own
 * dedicated check, reported verbatim). `version`'s TYPE (must be a number)
 * is still checked here; only the exact-value comparison to
 * `LIVE_MANIFEST_VERSION` lives in the dedicated version check.
 */
function validateManifestShape(obj: Record<string, unknown> | undefined): string[] {
  const errors: string[] = [];
  if (obj === undefined) {
    return ["manifest.json did not parse to a JSON object."];
  }

  if (typeof obj.version !== "number") errors.push("version must be a number.");
  if (obj.mode !== "real") errors.push(`mode must be exactly "real" (got ${JSON.stringify(obj.mode)}).`);
  if (typeof obj.seed !== "number") errors.push("seed must be a number.");
  if (typeof obj.taskCount !== "number") errors.push("taskCount must be a number.");
  if (typeof obj.provider !== "string") errors.push("provider must be a string.");
  if (typeof obj.model !== "string") errors.push("model must be a string.");
  if (typeof obj.nodeVersion !== "string") errors.push("nodeVersion must be a string.");
  if (obj.gitCommit !== undefined && typeof obj.gitCommit !== "string") {
    errors.push("gitCommit, when present, must be a string.");
  }
  if (typeof obj.startedAt !== "number") errors.push("startedAt must be a number.");
  if (typeof obj.finishedAt !== "number") errors.push("finishedAt must be a number.");
  if (typeof obj.wallMs !== "number") errors.push("wallMs must be a number.");

  if (!Array.isArray(obj.files)) {
    errors.push("files must be an array.");
  } else {
    obj.files.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        errors.push(`files[${i}] must be an object.`);
        return;
      }
      if (typeof entry.name !== "string" || entry.name.length === 0) {
        errors.push(`files[${i}].name must be a non-empty string.`);
      }
      if (typeof entry.sha256 !== "string" || entry.sha256.length === 0) {
        errors.push(`files[${i}].sha256 must be a non-empty string.`);
      }
    });
  }

  if (!isPlainObject(obj.vtph)) {
    errors.push("vtph must be an object.");
  } else {
    for (const key of ["swarm", "baseline", "multiple", "swarmVerified", "baselineVerified"] as const) {
      if (typeof obj.vtph[key] !== "number") errors.push(`vtph.${key} must be a number.`);
    }
  }

  return errors;
}

// ===========================================================================
// files[] entry helpers: safe extraction, path-traversal safety (string
// inspection only — never touches the filesystem), duplicate detection
// ===========================================================================

interface RawFileEntry {
  name: unknown;
  sha256: unknown;
}

function extractFileEntries(obj: Record<string, unknown> | undefined): RawFileEntry[] | undefined {
  if (obj === undefined || !Array.isArray(obj.files)) return undefined;
  return obj.files.map((entry): RawFileEntry => {
    if (!isPlainObject(entry)) return { name: undefined, sha256: undefined };
    return { name: entry.name, sha256: entry.sha256 };
  });
}

/**
 * Pure string inspection — no filesystem access — so it can be, and is,
 * proven safe with a spy `readFile` that asserts it is never called for an
 * unsafe name. A name is safe only if it is a non-empty string that is
 * exactly its own basename: no absolute paths, no `..`, no separators
 * (forward OR back slash, so a crafted `..\\escape` on a POSIX host is
 * still caught even though `node:path`'s POSIX `isAbsolute` wouldn't flag
 * a Windows-style absolute path).
 */
function unsafeBasenameReason(name: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0) return "not a non-empty string";
  if (isAbsolute(name)) return "absolute path";
  if (name.includes("/") || name.includes("\\")) return "contains a path separator";
  if (name === "." || name === "..") return 'is a relative-directory token ("." or "..")';
  if (pathBasename(name) !== name) return "does not equal its own basename";
  return undefined;
}

// ===========================================================================
// verifyLiveRunDir
// ===========================================================================

/**
 * Independently, byte-level re-verify a published live-showdown run
 * directory. Never throws: every fallible step (directory listing,
 * manifest read, JSON parse, per-file read) is wrapped so a failure
 * becomes a failed, named `AuditCheck` rather than a thrown error.
 *
 * Checks emitted, in this fixed order (per-file checks are sorted
 * alphabetically by name, so re-ordering `files[]` in the manifest never
 * changes the audit's own check order — order is not integrity):
 *   1. `directory-listing`        — can the directory even be read?
 *   2. `manifest-parses`          — manifest.json exists and is valid JSON
 *   3. `manifest-version`         — version === LIVE_MANIFEST_VERSION
 *   4. `manifest-shape`           — every required field, correct type
 *   5. `model-non-empty`          — model is a non-empty string (verbatim)
 *   6. `files-path-traversal-safe`— every files[] name is a plain basename
 *   7. `files-no-duplicates`      — no repeated files[] name
 *   8. `file-hash:<name>` (×N)    — file exists, sha256Hex matches
 *   9. `no-extra-files`           — nothing in the dir beyond what's listed
 *  10. `no-leftover-tmp`          — no leftover `*.tmp` (interrupted publish)
 */
export async function verifyLiveRunDir(dir: string, deps: AuditFsDeps = defaultAuditFsDeps): Promise<ManifestAudit> {
  const checks: AuditCheck[] = [];

  // -- 1. directory listing ---------------------------------------------
  let dirEntries: string[] | undefined;
  try {
    dirEntries = await deps.readdir(dir);
    checks.push({
      name: "directory-listing",
      ok: true,
      detail: `${dir} lists ${dirEntries.length} entr${dirEntries.length === 1 ? "y" : "ies"}.`,
    });
  } catch (err) {
    checks.push({ name: "directory-listing", ok: false, detail: `could not list ${dir}: ${errMsg(err)}` });
  }

  // -- 2. manifest.json read + parse ------------------------------------
  const manifestPath = join(dir, "manifest.json");
  let manifestRaw: string | undefined;
  try {
    manifestRaw = await deps.readFile(manifestPath, "utf8");
  } catch (err) {
    checks.push({ name: "manifest-parses", ok: false, detail: `manifest.json could not be read: ${errMsg(err)}` });
  }

  let obj: Record<string, unknown> | undefined;
  if (manifestRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(manifestRaw);
      if (isPlainObject(parsed)) {
        obj = parsed;
        checks.push({ name: "manifest-parses", ok: true, detail: "manifest.json exists and parsed as a valid JSON object." });
      } else {
        checks.push({
          name: "manifest-parses",
          ok: false,
          detail: `manifest.json parsed but is not a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed}).`,
        });
      }
    } catch (err) {
      checks.push({ name: "manifest-parses", ok: false, detail: `manifest.json is not valid JSON: ${errMsg(err)}` });
    }
  }

  // -- 3. version ----------------------------------------------------------
  const versionOk = obj !== undefined && obj.version === LIVE_MANIFEST_VERSION;
  checks.push({
    name: "manifest-version",
    ok: versionOk,
    detail:
      obj === undefined
        ? `version is unavailable (manifest.json did not parse to a JSON object); expected ${LIVE_MANIFEST_VERSION}.`
        : versionOk
          ? `version is ${LIVE_MANIFEST_VERSION}, matching LIVE_MANIFEST_VERSION.`
          : `version is ${JSON.stringify(obj.version)}, expected ${LIVE_MANIFEST_VERSION}.`,
  });

  // -- 4. full field shape --------------------------------------------------
  const shapeErrors = validateManifestShape(obj);
  const shapeOk = shapeErrors.length === 0;
  checks.push({
    name: "manifest-shape",
    ok: shapeOk,
    detail: shapeOk
      ? "every required LiveRunManifest field is present with the correct type."
      : shapeErrors.join(" "),
  });

  // -- 5. model, reported verbatim, never validated against any list -------
  const modelOk = obj !== undefined && typeof obj.model === "string" && obj.model.length > 0;
  checks.push({
    name: "model-non-empty",
    ok: modelOk,
    detail: modelOk
      ? `model: ${String(obj!.model)}`
      : `model field is missing or not a non-empty string (got ${obj !== undefined ? JSON.stringify(obj.model) : "n/a"}).`,
  });

  // -- files[] processing: traversal safety, duplicates, per-file hashes ---
  const rawEntries = extractFileEntries(obj);

  const unsafeEntries: Array<{ name: unknown; reason: string }> = [];
  const safeNames: string[] = [];
  if (rawEntries !== undefined) {
    for (const entry of rawEntries) {
      const reason = unsafeBasenameReason(entry.name);
      if (reason !== undefined) {
        unsafeEntries.push({ name: entry.name, reason });
      } else {
        safeNames.push(entry.name as string);
      }
    }
  }

  // -- 6. path-traversal safety — string inspection ONLY, no fs access -----
  checks.push({
    name: "files-path-traversal-safe",
    ok: rawEntries !== undefined && unsafeEntries.length === 0,
    detail:
      rawEntries === undefined
        ? "cannot verify: manifest.json's files[] array is missing or invalid."
        : unsafeEntries.length === 0
          ? `all ${rawEntries.length} files[] entr${rawEntries.length === 1 ? "y names" : "ies name"} a safe plain basename.`
          : `unsafe files[] entr${unsafeEntries.length === 1 ? "y" : "ies"} rejected without reading: ` +
            unsafeEntries.map((u) => `${JSON.stringify(u.name)} (${u.reason})`).join(", ") +
            ".",
  });

  // -- 7. duplicate names ----------------------------------------------------
  const nameCounts = new Map<string, number>();
  if (rawEntries !== undefined) {
    for (const entry of rawEntries) {
      if (typeof entry.name === "string") {
        nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
      }
    }
  }
  const duplicateNames = [...nameCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name).sort();
  checks.push({
    name: "files-no-duplicates",
    ok: rawEntries !== undefined && duplicateNames.length === 0,
    detail:
      rawEntries === undefined
        ? "cannot verify: manifest.json's files[] array is missing or invalid."
        : duplicateNames.length === 0
          ? "no duplicate files[] entries."
          : `duplicate files[] entr${duplicateNames.length === 1 ? "y" : "ies"}: ${duplicateNames.join(", ")}.`,
  });

  // -- 8. per-file existence + sha256 (only for SAFE, UNIQUE names — never
  //       attempts to read an unsafe or already-flagged-duplicate name) ----
  const sha256ByName = new Map<string, unknown>();
  if (rawEntries !== undefined) {
    for (const entry of rawEntries) {
      if (typeof entry.name === "string" && !sha256ByName.has(entry.name)) {
        sha256ByName.set(entry.name, entry.sha256);
      }
    }
  }
  const uniqueSafeNames = [...new Set(safeNames)].sort();
  for (const name of uniqueSafeNames) {
    const expected = sha256ByName.get(name);
    if (typeof expected !== "string" || expected.length === 0) {
      checks.push({
        name: `file-hash:${name}`,
        ok: false,
        detail: `manifest.json's sha256 for ${name} is not a non-empty string.`,
      });
      continue;
    }
    try {
      const content = await deps.readFile(join(dir, name), "utf8");
      const actual = sha256Hex(content);
      checks.push({
        name: `file-hash:${name}`,
        ok: actual === expected,
        detail:
          actual === expected
            ? `${name} exists and its sha256 (${actual}) matches manifest.json.`
            : `sha256 mismatch for ${name}: manifest.json says ${expected}, actual file content hashes to ${actual}.`,
      });
    } catch (err) {
      checks.push({
        name: `file-hash:${name}`,
        ok: false,
        detail: `${name} is listed in manifest.json but could not be read: ${errMsg(err)}`,
      });
    }
  }

  // -- 9 & 10. extra files / leftover *.tmp ---------------------------------
  if (dirEntries === undefined) {
    checks.push({
      name: "no-extra-files",
      ok: false,
      detail: "cannot verify: the run-dir's contents could not be listed.",
    });
    checks.push({
      name: "no-leftover-tmp",
      ok: false,
      detail: "cannot verify: the run-dir's contents could not be listed.",
    });
  } else {
    const tmpEntries = dirEntries.filter((e) => e.endsWith(".tmp")).sort();
    checks.push({
      name: "no-leftover-tmp",
      ok: tmpEntries.length === 0,
      detail:
        tmpEntries.length === 0
          ? "no leftover *.tmp files (an interrupted publish would leave one)."
          : `leftover *.tmp file(s) found — an interrupted publish: ${tmpEntries.join(", ")}.`,
    });

    if (rawEntries === undefined) {
      checks.push({
        name: "no-extra-files",
        ok: false,
        detail: "cannot verify: manifest.json's files[] array is missing or invalid, so the expected file set is unknown.",
      });
    } else {
      const listed = new Set(uniqueSafeNames);
      const extras = dirEntries
        .filter((e) => e !== "manifest.json")
        .filter((e) => !e.startsWith("."))
        .filter((e) => !e.endsWith(".tmp"))
        .filter((e) => !listed.has(e))
        .sort();
      checks.push({
        name: "no-extra-files",
        ok: extras.length === 0,
        detail:
          extras.length === 0
            ? "no extra files beyond manifest.json, dotfiles, and the manifest's listed files."
            : `unlisted extra file(s) found: ${extras.join(", ")}.`,
      });
    }
  }

  const ok = checks.every((c) => c.ok);
  const manifest =
    manifestRaw !== undefined && obj !== undefined && shapeOk ? (obj as unknown as LiveRunManifest) : undefined;

  return manifest === undefined ? { ok, checks } : { ok, checks, manifest };
}

// ===========================================================================
// renderManifestAudit
// ===========================================================================

/** Plain-text rendering — no ANSI — PASS/FAIL per check, honest overall verdict. */
export function renderManifestAudit(a: ManifestAudit): string[] {
  const lines: string[] = a.checks.map((c) => `[${c.ok ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}`);
  const failed = a.checks.filter((c) => !c.ok).length;
  lines.push(
    a.ok
      ? `Overall: PASS — all ${a.checks.length} check(s) passed; this run-dir's manifest is byte-verified.`
      : `Overall: FAIL — ${failed} of ${a.checks.length} check(s) failed.`
  );
  return lines;
}

// ===========================================================================
// livePreflightSummary — an honest wrapper over the REAL preflightLiveShowdown
// ===========================================================================

const CLOSE_GATE_COMMAND = "hades showdown live --out runs/live-001";

/**
 * A thin, honest wrapper over the REAL `preflightLiveShowdown` (imported,
 * never reimplemented). When a live-run-capable key is present, names the
 * provider/model that WOULD run and the exact command that closes the
 * gate. When not, repeats `preflightLiveShowdown`'s own reasons VERBATIM
 * (no paraphrasing) and states plainly that the gate remains UNMET — it
 * never claims a key exists when it does not.
 */
export function livePreflightSummary(env: Record<string, string | undefined>): ReadinessReport {
  const preflight = preflightLiveShowdown(env);

  if (preflight.ok && preflight.provider !== undefined && preflight.model !== undefined) {
    return {
      ready: true,
      lines: [
        `READY — a live, keyed showdown would run against provider=${preflight.provider} model=${preflight.model}.`,
        ...preflight.reasons,
        `Command that closes the gate: ${CLOSE_GATE_COMMAND}`,
      ],
    };
  }

  return {
    ready: false,
    lines: [
      "NOT READY — no live-run-capable provider key was detected in this environment.",
      ...preflight.reasons,
      "The live-showdown gate remains UNMET: no keyed run can happen until one of the env vars above is set.",
    ],
  };
}
