/**
 * Source discovery: find real Hermes/OpenClaw installs across platforms.
 *
 * Two halves, deliberately separated:
 *
 *  - {@link FsProbe} is the only seam onto a filesystem. {@link discoverSources}
 *    is PURE over it -- no `node:fs`, no clock, no direct `process.env`
 *    reads inside the discovery/scoring logic itself (every environment
 *    fact arrives via {@link DiscoveryOptions.env}). This is what makes it
 *    testable with an in-memory tree and safe to fuzz with adversarial
 *    inputs (symlink loops, huge directories, EACCES) without touching a
 *    real disk.
 *  - {@link nodeFsProbe} is the ONE place in this file (and, by convention
 *    of this build, in this whole team's files) allowed to import
 *    `node:fs`. It wraps every real syscall in a try/catch and downgrades
 *    every failure to the documented "not present" / `undefined` return
 *    rather than throwing, so a real EACCES, ELOOP, or ENOENT surfaces to
 *    `discoverSources` exactly the same way a simulated one does from the
 *    in-memory probe used in tests.
 *
 * {@link SOURCE_LAYOUTS} is a declarative table: every place a Hermes or
 * OpenClaw install is believed to live, across platforms, env-var
 * overrides, XDG, and legacy pre-rename directory names, each with its own
 * required/optional evidence markers and a `provenance` string explaining
 * *why* that path is believed real. `discoverSources` scores every
 * applicable (layout, root) pair independently -- it is not first-match-wins:
 * a root that happens to satisfy both a Hermes layout and an OpenClaw
 * layout, or two different layouts of the same vendor, is reported as
 * multiple {@link DiscoveredSource} entries, each with its own evidence and
 * confidence.
 */

import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import * as fs from "node:fs";

import type { ArtifactKind, MigrateVendor } from "./ir";

// ---------------------------------------------------------------------------
// FsProbe -- the filesystem seam
// ---------------------------------------------------------------------------

export interface FsProbe {
  exists(p: string): boolean;
  isDir(p: string): boolean;
  readDir(p: string): string[];
  stat(p: string): { size: number; mtimeMs: number; mode: number; isSymlink: boolean } | undefined;
  readFile(p: string, maxBytes?: number): string | undefined;
  readBytes(p: string, maxBytes: number): Uint8Array | undefined;
  realpath(p: string): string | undefined;
}

/** Default cap on bytes read by {@link FsProbe.readFile} when no per-call `maxBytes` is given. */
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * The real, `node:fs`-backed {@link FsProbe}. Every method independently
 * catches its own failures and returns the documented "absent" value
 * (`false`, `[]`, or `undefined`) instead of throwing -- callers (chiefly
 * {@link discoverSources}) never need a try/catch around a probe call to
 * stay alive, whether the failure is ENOENT, EACCES, ELOOP, or anything
 * else `node:fs` can raise.
 *
 * `readFile` decodes as UTF-8 (which never throws even on invalid byte
 * sequences -- invalid sequences become U+FFFD) and strips a leading BOM
 * (U+FEFF) if present; CRLF line endings are preserved verbatim (not an
 * error condition, just data).
 */
export function nodeFsProbe(opts?: { maxFileBytes?: number }): FsProbe {
  const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  function readCapped(p: string, cap: number): Buffer | undefined {
    let fd: number;
    try {
      fd = fs.openSync(p, "r");
    } catch {
      return undefined;
    }
    try {
      const st = fs.fstatSync(fd);
      const readLen = Math.max(0, Math.min(st.size, cap));
      const buf = Buffer.alloc(readLen);
      if (readLen > 0) fs.readSync(fd, buf, 0, readLen, 0);
      return buf;
    } catch {
      return undefined;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed / nothing we can do
      }
    }
  }

  return {
    exists(p) {
      try {
        fs.lstatSync(p);
        return true;
      } catch {
        return false;
      }
    },
    isDir(p) {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    readDir(p) {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
    stat(p) {
      try {
        const lst = fs.lstatSync(p);
        const isSymlink = lst.isSymbolicLink();
        let target = lst;
        if (isSymlink) {
          try {
            target = fs.statSync(p);
          } catch {
            // dangling symlink: report the link's own stat, still flagged as a symlink
            target = lst;
          }
        }
        return { size: target.size, mtimeMs: target.mtimeMs, mode: target.mode, isSymlink };
      } catch {
        return undefined;
      }
    },
    readFile(p, maxBytes) {
      const buf = readCapped(p, maxBytes ?? maxFileBytes);
      if (buf === undefined) return undefined;
      let text = buf.toString("utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return text;
    },
    readBytes(p, maxBytes) {
      const buf = readCapped(p, maxBytes);
      if (buf === undefined) return undefined;
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    realpath(p) {
      try {
        return fs.realpathSync(p);
      } catch {
        return undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Declarative layout table
// ---------------------------------------------------------------------------

/** One piece of evidence a layout expects at a fixed path relative to its root. */
export interface SourceLayoutMarker {
  /** Path relative to the candidate root, forward-slash separated regardless of platform. */
  relPath: string;
  /** Whether this marker is expected to be a file or a directory. */
  type: "file" | "dir";
  /** Human-readable reason this marker is evidence for the layout (surfaced verbatim in `evidence`/comments). */
  why: string;
}

/** The environment variable / convention a root template's first path segment resolves against. */
type TemplateVar =
  | "HOME"
  | "HERMES_HOME"
  | "OPENCLAW_HOME"
  | "XDG_CONFIG_HOME"
  | "XDG_DATA_HOME"
  | "APPDATA"
  | "LOCALAPPDATA";

export interface SourceLayoutRootSpec {
  /** `"*"` applies on every platform; otherwise restricted to one `NodeJS.Platform`. */
  platform: NodeJS.Platform | "*";
  /**
   * `"$VAR"` or `"$VAR/literal/segments..."`. `$VAR` is resolved via
   * {@link resolveTemplateVar}; remaining segments are joined with the
   * platform-appropriate separator. If `$VAR` has no value and no documented
   * fallback (namely `$HERMES_HOME` / `$OPENCLAW_HOME`), this root spec does
   * not apply and is skipped entirely (not even added to `searched`) --
   * distinct from the variable being set to a path that doesn't exist on
   * disk, which *is* searched and reported in `skipped`.
   */
  template: string;
  /** Why this path is believed to be a real install location for this vendor/layout. */
  provenance: string;
}

/** How to read a layout's version string once its root has matched. */
export interface SourceLayoutVersionMarker {
  relPath: string;
  kind: "text" | "json";
  /** Required when `kind === "json"`: the top-level key holding the version string. */
  jsonKey?: string;
}

/** Maps a relative path under a matched root to the {@link ArtifactKind} it inventories as. */
export interface SourceLayoutArtifactRule {
  relPath: string;
  kind: ArtifactKind;
  /** If true, `relPath` is a directory walked recursively; every file under it becomes one inventory entry. */
  recursive?: boolean;
}

export interface SourceLayout {
  vendor: MigrateVendor;
  /** Stable identifier, e.g. `"hermes-dotfile"`. */
  id: string;
  displayName: string;
  roots: SourceLayoutRootSpec[];
  requiredMarkers: SourceLayoutMarker[];
  optionalMarkers: SourceLayoutMarker[];
  versionMarker?: SourceLayoutVersionMarker;
  artifactRules: SourceLayoutArtifactRule[];
}

const HERMES_MARKERS = {
  required: [
    { relPath: "config.json", type: "file", why: "config.json is Hermes' primary configuration file, written by every supported version" },
  ] satisfies SourceLayoutMarker[],
  optional: [
    { relPath: "memory", type: "dir", why: "memory/ holds Hermes' long-term memory store" },
    { relPath: "sessions", type: "dir", why: "sessions/ holds saved Hermes session transcripts" },
    { relPath: "skills", type: "dir", why: "skills/ holds installed Hermes skill packages" },
    { relPath: "model.json", type: "file", why: "model.json records the active Hermes model selection" },
    { relPath: ".hermes-version", type: "file", why: ".hermes-version records the installed Hermes CLI version" },
  ] satisfies SourceLayoutMarker[],
  versionMarker: { relPath: ".hermes-version", kind: "text" } satisfies SourceLayoutVersionMarker,
  artifactRules: [
    { relPath: "config.json", kind: "config" },
    { relPath: "model.json", kind: "model" },
    { relPath: "memory", kind: "memory", recursive: true },
    { relPath: "sessions", kind: "session", recursive: true },
    { relPath: "skills", kind: "skill", recursive: true },
    { relPath: "context", kind: "context-file", recursive: true },
    { relPath: "secrets", kind: "secret", recursive: true },
    { relPath: "tool-state", kind: "tool-state", recursive: true },
  ] satisfies SourceLayoutArtifactRule[],
};

const OPENCLAW_MARKERS = {
  required: [
    { relPath: "openclaw.json", type: "file", why: "openclaw.json is OpenClaw's primary configuration file, written by every supported version" },
  ] satisfies SourceLayoutMarker[],
  optional: [
    { relPath: "memory", type: "dir", why: "memory/ holds OpenClaw's long-term memory store" },
    { relPath: "sessions", type: "dir", why: "sessions/ holds saved OpenClaw session transcripts" },
    { relPath: "skills", type: "dir", why: "skills/ holds installed OpenClaw skill packages" },
    { relPath: "model.json", type: "file", why: "model.json records the active OpenClaw model selection" },
    { relPath: ".openclaw-version", type: "file", why: ".openclaw-version records the installed OpenClaw version" },
  ] satisfies SourceLayoutMarker[],
  versionMarker: { relPath: ".openclaw-version", kind: "text" } satisfies SourceLayoutVersionMarker,
  artifactRules: [
    { relPath: "openclaw.json", kind: "config" },
    { relPath: "model.json", kind: "model" },
    { relPath: "memory", kind: "memory", recursive: true },
    { relPath: "sessions", kind: "session", recursive: true },
    { relPath: "skills", kind: "skill", recursive: true },
    { relPath: "context", kind: "context-file", recursive: true },
    { relPath: "secrets", kind: "secret", recursive: true },
    { relPath: "tool-state", kind: "tool-state", recursive: true },
  ] satisfies SourceLayoutArtifactRule[],
};

/**
 * The full declarative source-layout table. Every entry is exercised by a
 * parity test in `__tests__/discovery.test.ts` (one in-memory fixture per
 * `id`), so adding a new layout here without a matching fixture fails CI.
 */
export const SOURCE_LAYOUTS: readonly SourceLayout[] = Object.freeze([
  {
    vendor: "hermes",
    id: "hermes-env-home",
    displayName: "Hermes ($HERMES_HOME override)",
    roots: [
      {
        platform: "*",
        template: "$HERMES_HOME",
        provenance:
          "HERMES_HOME is Hermes' documented, highest-priority override for relocating its home directory -- if set, Hermes always uses exactly this path.",
      },
    ],
    requiredMarkers: HERMES_MARKERS.required,
    optionalMarkers: HERMES_MARKERS.optional,
    versionMarker: HERMES_MARKERS.versionMarker,
    artifactRules: HERMES_MARKERS.artifactRules,
  },
  {
    vendor: "hermes",
    id: "hermes-xdg",
    displayName: "Hermes (XDG, Linux)",
    roots: [
      {
        platform: "linux",
        template: "$XDG_CONFIG_HOME/hermes",
        provenance:
          "On Linux, Hermes follows the XDG Base Directory spec and stores config/state under $XDG_CONFIG_HOME/hermes (defaulting to ~/.config/hermes).",
      },
    ],
    requiredMarkers: HERMES_MARKERS.required,
    optionalMarkers: HERMES_MARKERS.optional,
    versionMarker: HERMES_MARKERS.versionMarker,
    artifactRules: HERMES_MARKERS.artifactRules,
  },
  {
    vendor: "hermes",
    id: "hermes-dotfile",
    displayName: "Hermes (~/.hermes)",
    roots: [
      {
        platform: "*",
        template: "$HOME/.hermes",
        provenance: "~/.hermes is Hermes' default home directory when no HERMES_HOME override and no XDG variables apply.",
      },
    ],
    requiredMarkers: HERMES_MARKERS.required,
    optionalMarkers: HERMES_MARKERS.optional,
    versionMarker: HERMES_MARKERS.versionMarker,
    artifactRules: HERMES_MARKERS.artifactRules,
  },
  {
    vendor: "hermes",
    id: "hermes-macos-appsupport",
    displayName: "Hermes (macOS Application Support)",
    roots: [
      {
        platform: "darwin",
        template: "$HOME/Library/Application Support/Hermes",
        provenance: "macOS app-bundle builds of Hermes follow Apple convention and store state under ~/Library/Application Support/Hermes.",
      },
    ],
    requiredMarkers: HERMES_MARKERS.required,
    optionalMarkers: HERMES_MARKERS.optional,
    versionMarker: HERMES_MARKERS.versionMarker,
    artifactRules: HERMES_MARKERS.artifactRules,
  },
  {
    vendor: "hermes",
    id: "hermes-windows-appdata",
    displayName: "Hermes (Windows %APPDATA%)",
    roots: [
      {
        platform: "win32",
        template: "$APPDATA/Hermes",
        provenance: "Windows builds of Hermes store state under %APPDATA%\\Hermes per the standard per-user application-data convention.",
      },
    ],
    requiredMarkers: HERMES_MARKERS.required,
    optionalMarkers: HERMES_MARKERS.optional,
    versionMarker: HERMES_MARKERS.versionMarker,
    artifactRules: HERMES_MARKERS.artifactRules,
  },
  {
    vendor: "openclaw",
    id: "openclaw-env-home",
    displayName: "OpenClaw ($OPENCLAW_HOME override)",
    roots: [
      {
        platform: "*",
        template: "$OPENCLAW_HOME",
        provenance: "OPENCLAW_HOME is OpenClaw's documented override for relocating its home directory.",
      },
    ],
    requiredMarkers: OPENCLAW_MARKERS.required,
    optionalMarkers: OPENCLAW_MARKERS.optional,
    versionMarker: OPENCLAW_MARKERS.versionMarker,
    artifactRules: OPENCLAW_MARKERS.artifactRules,
  },
  {
    vendor: "openclaw",
    id: "openclaw-xdg",
    displayName: "OpenClaw (XDG, Linux)",
    roots: [
      {
        platform: "linux",
        template: "$XDG_CONFIG_HOME/openclaw",
        provenance: "On Linux, OpenClaw follows the XDG Base Directory spec and stores config/state under $XDG_CONFIG_HOME/openclaw.",
      },
    ],
    requiredMarkers: OPENCLAW_MARKERS.required,
    optionalMarkers: OPENCLAW_MARKERS.optional,
    versionMarker: OPENCLAW_MARKERS.versionMarker,
    artifactRules: OPENCLAW_MARKERS.artifactRules,
  },
  {
    vendor: "openclaw",
    id: "openclaw-dotfile",
    displayName: "OpenClaw (~/.openclaw)",
    roots: [
      {
        platform: "*",
        template: "$HOME/.openclaw",
        provenance: "~/.openclaw is OpenClaw's default home directory when no OPENCLAW_HOME override and no XDG variables apply.",
      },
    ],
    requiredMarkers: OPENCLAW_MARKERS.required,
    optionalMarkers: OPENCLAW_MARKERS.optional,
    versionMarker: OPENCLAW_MARKERS.versionMarker,
    artifactRules: OPENCLAW_MARKERS.artifactRules,
  },
  {
    vendor: "openclaw",
    id: "openclaw-macos-appsupport",
    displayName: "OpenClaw (macOS Application Support)",
    roots: [
      {
        platform: "darwin",
        template: "$HOME/Library/Application Support/OpenClaw",
        provenance: "macOS app-bundle builds of OpenClaw follow Apple convention and store state under ~/Library/Application Support/OpenClaw.",
      },
    ],
    requiredMarkers: OPENCLAW_MARKERS.required,
    optionalMarkers: OPENCLAW_MARKERS.optional,
    versionMarker: OPENCLAW_MARKERS.versionMarker,
    artifactRules: OPENCLAW_MARKERS.artifactRules,
  },
  {
    vendor: "openclaw",
    id: "openclaw-windows-appdata",
    displayName: "OpenClaw (Windows %APPDATA%)",
    roots: [
      {
        platform: "win32",
        template: "$APPDATA/OpenClaw",
        provenance: "Windows builds of OpenClaw store state under %APPDATA%\\OpenClaw per the standard per-user application-data convention.",
      },
    ],
    requiredMarkers: OPENCLAW_MARKERS.required,
    optionalMarkers: OPENCLAW_MARKERS.optional,
    versionMarker: OPENCLAW_MARKERS.versionMarker,
    artifactRules: OPENCLAW_MARKERS.artifactRules,
  },
  {
    vendor: "openclaw",
    id: "openclaw-legacy-clawdbot",
    displayName: "OpenClaw legacy (~/.clawdbot)",
    roots: [
      {
        platform: "*",
        template: "$HOME/.clawdbot",
        provenance: "~/.clawdbot is the legacy home directory used by pre-rename builds of OpenClaw, under its original project name.",
      },
    ],
    requiredMarkers: [
      { relPath: "clawdbot.json", type: "file", why: "clawdbot.json is the legacy pre-rename configuration file" },
    ],
    optionalMarkers: [
      { relPath: "memory.json", type: "file", why: "legacy builds stored memory as one flat memory.json file rather than a memory/ directory" },
      { relPath: "history", type: "dir", why: "history/ holds legacy session transcripts (later renamed to sessions/)" },
      { relPath: "plugins", type: "dir", why: "plugins/ holds legacy skill-equivalent packages (later renamed to skills/)" },
    ],
    artifactRules: [
      { relPath: "clawdbot.json", kind: "config" },
      { relPath: "memory.json", kind: "memory" },
      { relPath: "history", kind: "session", recursive: true },
      { relPath: "plugins", kind: "skill", recursive: true },
    ],
  },
  {
    vendor: "openclaw",
    id: "openclaw-legacy-moltbot",
    displayName: "OpenClaw legacy (~/.moltbot)",
    roots: [
      {
        platform: "*",
        template: "$HOME/.moltbot",
        provenance: "~/.moltbot is a second legacy home directory OpenClaw used briefly between the clawdbot and openclaw renames.",
      },
    ],
    requiredMarkers: [
      { relPath: "moltbot.json", type: "file", why: "moltbot.json is the interim-rename configuration file" },
    ],
    optionalMarkers: [
      { relPath: "state.json", type: "file", why: "state.json recorded miscellaneous runtime/tool state in this interim build" },
      { relPath: "logs", type: "dir", why: "logs/ holds this interim build's session logs" },
      { relPath: "addons", type: "dir", why: "addons/ holds this interim build's skill-equivalent addon packages" },
    ],
    artifactRules: [
      { relPath: "moltbot.json", kind: "config" },
      { relPath: "state.json", kind: "tool-state" },
      { relPath: "logs", kind: "session", recursive: true },
      { relPath: "addons", kind: "skill", recursive: true },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveryOptions {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  explicitRoots?: Array<{ root: string; vendor?: MigrateVendor }>;
  maxDepth?: number;
}

export interface DiscoveredSource {
  vendor: MigrateVendor;
  root: string;
  layout: string;
  confidence: number;
  version?: string;
  evidence: string[];
  inventory: Array<{ kind: ArtifactKind; path: string; bytes: number }>;
  warnings: string[];
}

/** Default recursion depth for artifact-inventory walks (overridable via `DiscoveryOptions.maxDepth`). */
const DEFAULT_MAX_WALK_DEPTH = 8;
/** Total (across all artifact rules of one source) file-entry cap for inventory walks. */
const MAX_WALK_ENTRIES = 5000;

function resolveTemplateVar(name: TemplateVar, ctx: { home: string; env: Record<string, string | undefined> }): string | undefined {
  switch (name) {
    case "HOME":
      return ctx.home;
    case "HERMES_HOME":
      return ctx.env.HERMES_HOME || undefined;
    case "OPENCLAW_HOME":
      return ctx.env.OPENCLAW_HOME || undefined;
    case "XDG_CONFIG_HOME":
      return ctx.env.XDG_CONFIG_HOME || joinPlatform("linux", ctx.home, ".config");
    case "XDG_DATA_HOME":
      return ctx.env.XDG_DATA_HOME || joinPlatform("linux", ctx.home, ".local", "share");
    case "APPDATA":
      return ctx.env.APPDATA || joinPlatform("win32", ctx.home, "AppData", "Roaming");
    case "LOCALAPPDATA":
      return ctx.env.LOCALAPPDATA || joinPlatform("win32", ctx.home, "AppData", "Local");
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}

function joinPlatform(platform: NodeJS.Platform, ...segments: string[]): string {
  const impl = platform === "win32" ? pathWin32 : pathPosix;
  return impl.join(...segments);
}

/** Resolves a `"$VAR/segments"` template to an absolute path, or `undefined` if the variable is unset with no fallback. */
function resolveTemplate(template: string, platform: NodeJS.Platform, ctx: { home: string; env: Record<string, string | undefined> }): string | undefined {
  const parts = template.split("/");
  const varToken = parts[0];
  if (!varToken.startsWith("$")) {
    throw new Error(`resolveTemplate: malformed template "${template}" (must start with "$VAR")`);
  }
  const varName = varToken.slice(1) as TemplateVar;
  const base = resolveTemplateVar(varName, ctx);
  if (base === undefined) return undefined;
  const rest = parts.slice(1);
  return rest.length ? joinPlatform(platform, base, ...rest) : base;
}

function safeStat(probe: FsProbe, p: string): ReturnType<FsProbe["stat"]> {
  try {
    return probe.stat(p);
  } catch {
    return undefined;
  }
}

function safeIsDir(probe: FsProbe, p: string): boolean {
  try {
    return probe.isDir(p);
  } catch {
    return false;
  }
}

function safeExists(probe: FsProbe, p: string): boolean {
  try {
    return probe.exists(p);
  } catch {
    return false;
  }
}

function safeReadDir(probe: FsProbe, p: string): { ok: true; entries: string[] } | { ok: false } {
  try {
    return { ok: true, entries: probe.readDir(p) };
  } catch {
    return { ok: false };
  }
}

function safeRealpath(probe: FsProbe, p: string): string | undefined {
  try {
    return probe.realpath(p);
  } catch {
    return undefined;
  }
}

function safeReadFile(probe: FsProbe, p: string, maxBytes?: number): string | undefined {
  try {
    return probe.readFile(p, maxBytes);
  } catch {
    return undefined;
  }
}

/** exists / is-directory / broken-symlink checks for a candidate root. */
function probeRootStatus(probe: FsProbe, root: string): { ok: true; empty: boolean } | { ok: false; reason: string } {
  if (!safeExists(probe, root)) return { ok: false, reason: "path does not exist" };
  if (!safeIsDir(probe, root)) {
    return { ok: false, reason: "path exists but is not a directory (a file sits where a directory root was expected)" };
  }
  const st = safeStat(probe, root);
  if (st?.isSymlink) {
    const real = safeRealpath(probe, root);
    if (!real) return { ok: false, reason: "symlink target could not be resolved (broken symlink or loop)" };
  }
  const dir = safeReadDir(probe, root);
  if (!dir.ok) return { ok: false, reason: "directory could not be read (permission denied or transient I/O error)" };
  return { ok: true, empty: dir.entries.length === 0 };
}

interface MarkerEval {
  present: Map<string, boolean>;
  evidence: string[];
  warnings: string[];
}

function evaluateMarkers(probe: FsProbe, root: string, layout: SourceLayout, platform: NodeJS.Platform): MarkerEval {
  const present = new Map<string, boolean>();
  const evidence: string[] = [];
  const warnings: string[] = [];
  for (const m of [...layout.requiredMarkers, ...layout.optionalMarkers]) {
    const abs = joinPlatform(platform, root, ...m.relPath.split("/"));
    if (!safeExists(probe, abs)) {
      present.set(m.relPath, false);
      continue;
    }
    const isDirActual = safeIsDir(probe, abs);
    if (m.type === "dir" && !isDirActual) {
      present.set(m.relPath, false);
      warnings.push(`expected a directory at "${m.relPath}" but found a file -- marker not counted`);
      continue;
    }
    if (m.type === "file" && isDirActual) {
      present.set(m.relPath, false);
      warnings.push(`expected a file at "${m.relPath}" but found a directory -- marker not counted`);
      continue;
    }
    present.set(m.relPath, true);
    evidence.push(m.why);
  }
  return { present, evidence, warnings };
}

function readVersionMarker(probe: FsProbe, root: string, marker: SourceLayoutVersionMarker, platform: NodeJS.Platform, warnings: string[]): string | undefined {
  const abs = joinPlatform(platform, root, ...marker.relPath.split("/"));
  const text = safeReadFile(probe, abs, 4096);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (marker.kind === "text") return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && marker.jsonKey) {
      const v = (parsed as Record<string, unknown>)[marker.jsonKey];
      if (typeof v === "string") return v;
    }
    warnings.push(`version marker "${marker.relPath}" did not contain the expected JSON key "${marker.jsonKey ?? ""}"`);
    return undefined;
  } catch {
    warnings.push(`version marker "${marker.relPath}" could not be parsed as JSON`);
    return undefined;
  }
}

/**
 * Bounded, loop-safe recursive walk used to build inventory entries for one
 * recursive {@link SourceLayoutArtifactRule}. Depth-limited by `maxDepth`,
 * entry-limited (across the whole source, via the shared `budget`) by
 * {@link MAX_WALK_ENTRIES}, and defended against symlink cycles (via
 * `visitedRealpaths`, shared across all rules of one source) and symlinks
 * that escape the source root (recorded but not followed).
 */
function walkForInventory(
  probe: FsProbe,
  rootAbs: string,
  rootRealForEscapeCheck: string,
  startRelPath: string,
  kind: ArtifactKind,
  platform: NodeJS.Platform,
  maxDepth: number,
  budget: { remaining: number },
  visitedRealpaths: Set<string>,
  warnings: string[],
): Array<{ kind: ArtifactKind; path: string; bytes: number }> {
  const out: Array<{ kind: ArtifactKind; path: string; bytes: number }> = [];
  const startAbs = joinPlatform(platform, rootAbs, ...startRelPath.split("/"));

  type StackEntry = { abs: string; rel: string; depth: number };
  const stack: StackEntry[] = [{ abs: startAbs, rel: startRelPath, depth: 0 }];

  while (stack.length > 0) {
    if (budget.remaining <= 0) {
      warnings.push(`inventory scan truncated at ${MAX_WALK_ENTRIES} total entries (starting from "${startRelPath}")`);
      break;
    }
    const cur = stack.pop()!;
    const st = safeStat(probe, cur.abs);
    if (!st) continue;

    // The path actually used to read this node's contents/children. Starts as
    // the node's own path but is switched to the resolved target below when
    // the node is a symlink -- critical for loop detection: without this, a
    // symlink pointing at an ancestor directory would be re-descended via an
    // ever-growing literal path (".../loop/loop/loop/...") that never
    // re-triggers the `visitedRealpaths` check, instead only ever getting
    // caught (if at all) by the depth cap. Resolving first means the *next*
    // encounter of the same symlink resolves to the same real path we
    // already recorded, so the loop check actually fires.
    let effectiveAbs = cur.abs;

    if (st.isSymlink) {
      const real = safeRealpath(probe, cur.abs);
      if (!real) {
        warnings.push(`broken symlink, skipping: "${cur.rel}"`);
        continue;
      }
      if (visitedRealpaths.has(real)) {
        warnings.push(`symlink loop detected, not following: "${cur.rel}"`);
        continue;
      }
      if (!real.startsWith(rootRealForEscapeCheck)) {
        warnings.push(`symlink escapes the source root, not followed: "${cur.rel}" -> "${real}"`);
        budget.remaining -= 1;
        out.push({ kind, path: cur.abs, bytes: st.size });
        continue;
      }
      visitedRealpaths.add(real);
      effectiveAbs = real;
    }

    const isDir = safeIsDir(probe, effectiveAbs);
    if (isDir) {
      if (cur.depth >= maxDepth) {
        warnings.push(`max walk depth ${maxDepth} reached, not descending into: "${cur.rel}"`);
        continue;
      }
      const dir = safeReadDir(probe, effectiveAbs);
      if (!dir.ok) {
        warnings.push(`unreadable directory, skipping: "${cur.rel}"`);
        continue;
      }
      for (const child of dir.entries) {
        if (budget.remaining <= 0) break;
        stack.push({ abs: joinPlatform(platform, effectiveAbs, child), rel: `${cur.rel}/${child}`, depth: cur.depth + 1 });
      }
    } else {
      budget.remaining -= 1;
      out.push({ kind, path: effectiveAbs, bytes: st.size });
    }
  }
  return out;
}

/** Builds the two conventional candidate paths for Hades' own dataDir, for self-reference detection. */
function hadesSelfCandidates(opts: DiscoveryOptions): Set<string> {
  const out = new Set<string>();
  const envDataDir = opts.env.HADES_DATA_DIR;
  if (envDataDir && (envDataDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(envDataDir) || envDataDir.startsWith("\\\\"))) {
    out.add(envDataDir);
  }
  out.add(joinPlatform(opts.platform, opts.home, ".hades"));
  return out;
}

/**
 * Locate real Hermes/OpenClaw installs. Scores every applicable
 * `(layout, root)` pair from {@link SOURCE_LAYOUTS} plus `opts.explicitRoots`
 * independently -- never first-match-wins -- so a root satisfying multiple
 * layouts (including different vendors) yields multiple entries in
 * `sources`, each flagged in `warnings` about the overlap. Never throws:
 * every filesystem irregularity (missing path, non-directory, broken/looping
 * symlink, unreadable directory, empty root, depth bomb, oversized
 * directory) is downgraded to an entry in `skipped` and/or a per-source
 * `warnings` string.
 */
export function discoverSources(
  probe: FsProbe,
  opts: DiscoveryOptions,
): { sources: DiscoveredSource[]; searched: string[]; skipped: Array<{ path: string; reason: string }> } {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_WALK_DEPTH;
  const ctx = { home: opts.home, env: opts.env };

  const attempts: Array<{ layout: SourceLayout; root: string }> = [];
  const seenPairs = new Set<string>();

  for (const layout of SOURCE_LAYOUTS) {
    for (const rootSpec of layout.roots) {
      if (rootSpec.platform !== "*" && rootSpec.platform !== opts.platform) continue;
      const resolved = resolveTemplate(rootSpec.template, opts.platform, ctx);
      if (resolved === undefined) continue;
      const key = `${layout.id}\u0000${resolved}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      attempts.push({ layout, root: resolved });
    }
  }
  for (const ex of opts.explicitRoots ?? []) {
    const layouts = ex.vendor ? SOURCE_LAYOUTS.filter((l) => l.vendor === ex.vendor) : SOURCE_LAYOUTS;
    for (const layout of layouts) {
      const key = `${layout.id}\u0000${ex.root}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      attempts.push({ layout, root: ex.root });
    }
  }

  const searchedSet = new Set<string>();
  const skipped: Array<{ path: string; reason: string }> = [];
  const sources: DiscoveredSource[] = [];

  const rootStatus = new Map<string, ReturnType<typeof probeRootStatus>>();
  const rootMatchedAnyLayout = new Set<string>();

  for (const { layout, root } of attempts) {
    searchedSet.add(root);

    let status = rootStatus.get(root);
    if (!status) {
      status = probeRootStatus(probe, root);
      rootStatus.set(root, status);
      if (!status.ok) skipped.push({ path: root, reason: status.reason });
    }
    if (!status.ok) continue;

    const { present, evidence, warnings: markerWarnings } = evaluateMarkers(probe, root, layout, opts.platform);
    const requiredHits = layout.requiredMarkers.filter((m) => present.get(m.relPath)).length;
    if (requiredHits < layout.requiredMarkers.length) continue;

    rootMatchedAnyLayout.add(root);

    const optionalHits = layout.optionalMarkers.filter((m) => present.get(m.relPath)).length;
    const optionalTotal = layout.optionalMarkers.length || 1;
    const rawConfidence =
      layout.requiredMarkers.length > 0
        ? 0.5 + 0.5 * (optionalHits / optionalTotal)
        : 0.3 + 0.7 * (optionalHits / optionalTotal);
    const confidence = Math.min(1, Math.max(0, rawConfidence));

    const warnings = [...markerWarnings];
    const version = layout.versionMarker ? readVersionMarker(probe, root, layout.versionMarker, opts.platform, warnings) : undefined;

    const rootReal = safeRealpath(probe, root) ?? root;
    const budget = { remaining: MAX_WALK_ENTRIES };
    const visited = new Set<string>([rootReal]);
    const inventory: Array<{ kind: ArtifactKind; path: string; bytes: number }> = [];

    for (const rule of layout.artifactRules) {
      if (budget.remaining <= 0) break;
      const ruleAbs = joinPlatform(opts.platform, root, ...rule.relPath.split("/"));
      const st = safeStat(probe, ruleAbs);
      if (!st) continue;

      if (!rule.recursive) {
        budget.remaining -= 1;
        inventory.push({ kind: rule.kind, path: ruleAbs, bytes: st.size });
        continue;
      }
      const found = walkForInventory(probe, root, rootReal, rule.relPath, rule.kind, opts.platform, maxDepth, budget, visited, warnings);
      inventory.push(...found);
    }

    const selfCandidates = hadesSelfCandidates(opts);
    if (selfCandidates.has(root) || selfCandidates.has(rootReal)) {
      warnings.push(
        "REFUSE: this path is Hades' own live dataDir (self-reference) -- do not use Hades' own running state as a migration source or destination",
      );
    }

    sources.push({ vendor: layout.vendor, root, layout: layout.id, confidence, version, evidence, inventory, warnings });
  }

  // Roots that exist and were searched but never matched any layout: report why.
  for (const [root, status] of rootStatus) {
    if (rootMatchedAnyLayout.has(root)) continue;
    if (!status.ok) continue; // already reported with its specific reason above
    skipped.push({
      path: root,
      reason: status.empty ? "root exists but is empty (no artifacts found)" : "root exists but does not match required markers for any known layout",
    });
  }

  // Cross-vendor / cross-layout overlap: a root matched by more than one distinct vendor.
  const vendorsByRoot = new Map<string, Set<MigrateVendor>>();
  for (const s of sources) {
    const set = vendorsByRoot.get(s.root) ?? new Set<MigrateVendor>();
    set.add(s.vendor);
    vendorsByRoot.set(s.root, set);
  }
  for (const s of sources) {
    const vendors = vendorsByRoot.get(s.root)!;
    if (vendors.size > 1) {
      const others = [...vendors].filter((v) => v !== s.vendor).sort();
      const msg = `this root also matched a different vendor's layout (${others.join(", ")}) -- treat merges from this root with care`;
      if (!s.warnings.includes(msg)) s.warnings.push(msg);
    }
  }
  const layoutsByRoot = new Map<string, Set<string>>();
  for (const s of sources) {
    const set = layoutsByRoot.get(s.root) ?? new Set<string>();
    set.add(s.layout);
    layoutsByRoot.set(s.root, set);
  }
  for (const s of sources) {
    const layouts = layoutsByRoot.get(s.root)!;
    if (layouts.size > 1) {
      const others = [...layouts].filter((l) => l !== s.layout).sort();
      const msg = `this root also matched other layout(s) of the same vendor (${others.join(", ")})`;
      if (!s.warnings.includes(msg)) s.warnings.push(msg);
    }
  }

  return { sources, searched: [...searchedSet].sort(), skipped };
}
