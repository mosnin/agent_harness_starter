/**
 * Modular skills & plugins — Hermes ships skills/plugins as versioned packages
 * with dependencies. This module defines the shared **manifest** and a small,
 * dependency-free semver matcher so Hades modules declare what they need,
 * provide, and require — the foundation for resolution (iter 12) and hot-load
 * (iter 13).
 */

export type ModuleKind = "skill" | "plugin" | "pack";

export interface ModuleManifest {
  name: string;
  /** Semver "x.y.z". */
  version: string;
  kind: ModuleKind;
  description?: string;
  /** name → version range (e.g. "^1.2.0", ">=1.0.0", "*"). */
  dependencies?: Record<string, string>;
  /** Capabilities this module grants. */
  capabilities?: string[];
  /** Named artifacts this module provides (skills, tools, hooks). */
  provides?: string[];
  /** Permissions this module requests (see security phase). */
  permissions?: string[];
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(v: string): SemVer | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 | 0 | 1 comparing a to b. */
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Does `version` satisfy `range`? Supports `*`/`""` (any), exact `x.y.z`,
 * caret `^x.y.z` (compatible: same major, ≥ the floor), tilde `~x.y.z` (same
 * major+minor, ≥ patch), and comparators `>=` `>` `<=` `<`. Deliberately small.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const r = range.trim();
  if (r === "" || r === "*" || r === "latest") return true;

  const cmp = (floor: SemVer) => compareVersions(v, floor);

  if (r.startsWith("^")) {
    const floor = parseVersion(r.slice(1));
    if (!floor) return false;
    return v.major === floor.major && cmp(floor) >= 0;
  }
  if (r.startsWith("~")) {
    const floor = parseVersion(r.slice(1));
    if (!floor) return false;
    return v.major === floor.major && v.minor === floor.minor && cmp(floor) >= 0;
  }
  for (const [op, len] of [[">=", 2], ["<=", 2], [">", 1], ["<", 1]] as const) {
    if (r.startsWith(op)) {
      const bound = parseVersion(r.slice(len));
      if (!bound) return false;
      const c = compareVersions(v, bound);
      return op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c < 0;
    }
  }
  // Bare version → exact match.
  const exact = parseVersion(r);
  return exact ? compareVersions(v, exact) === 0 : false;
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/;

/** Validate a manifest's shape: name, version, kind, and dependency ranges. */
export function validateManifest(m: ModuleManifest): ManifestValidation {
  const errors: string[] = [];
  if (!m.name || !NAME_RE.test(m.name)) errors.push(`invalid module name: ${JSON.stringify(m.name)}`);
  if (!parseVersion(m.version ?? "")) errors.push(`invalid version (want x.y.z): ${JSON.stringify(m.version)}`);
  if (!["skill", "plugin", "pack"].includes(m.kind)) errors.push(`invalid kind: ${JSON.stringify(m.kind)}`);
  for (const [dep, range] of Object.entries(m.dependencies ?? {})) {
    // A range is valid if it's a recognized form; probe with a dummy version.
    if (range !== "*" && range !== "" && range !== "latest" && !isRangeParseable(range)) {
      errors.push(`dependency ${dep} has unparseable range: ${range}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function isRangeParseable(range: string): boolean {
  const r = range.trim();
  const stripped = r.replace(/^(\^|~|>=|<=|>|<)/, "");
  return parseVersion(stripped) !== null;
}
