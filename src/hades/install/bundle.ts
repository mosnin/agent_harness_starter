/**
 * The portable bundle builder.
 *
 * A "bundle" is a content-addressed, tamper-evident directory tree: every
 * staged file is hashed, every hash is recorded in a manifest
 * (`bundle.json`), and the manifest itself is bound together by a single
 * `rootHash` so that verifying a bundle later never has to trust anything
 * this module said about itself — `verifyBundle` independently recomputes
 * every hash from the bytes actually sitting on disk.
 *
 * Unlike `../install/plan.ts` (which only *decides* what an installer would
 * do, never touching disk), this module does REAL `node:fs` work: it reads
 * real files, writes real files, and hashes real bytes with the REAL
 * `sha256Hex` from `../styx/certificate` (itself a thin, real `node:crypto`
 * wrapper — no home-rolled hashing).
 *
 * ---------------------------------------------------------------------------
 * Canonicalization of `rootHash` (read this before touching the format)
 * ---------------------------------------------------------------------------
 * `rootHash` is `sha256Hex` over a canonical serialization of
 * `entries` (path-sorted first, so directory-read order never matters).
 * Each entry is encoded field-by-field using netstring-style length
 * prefixing — `${byteLength}:${value}` — for every field (`path`, `bytes`,
 * `sha256`, `executable`), concatenated with no delimiter between fields or
 * entries. This is injection-proof by construction: decoding an entry never
 * depends on scanning for a separator character, it depends only on reading
 * a declared byte length and then consuming exactly that many bytes. A
 * filename containing a colon, a newline, or even another entry's entire
 * encoded form embedded verbatim cannot be mistaken for a field boundary,
 * because the length prefix fixes exactly where the field ends regardless
 * of what bytes it contains. Two different entry lists can only encode to
 * the same canonical string if they are the same list in the same order —
 * this is the standard argument for why prefix-free (netstring / bencode
 * style) encodings are uniquely decodable.
 *
 * ---------------------------------------------------------------------------
 * Honesty rules (non-negotiable, enforced structurally, not by convention)
 * ---------------------------------------------------------------------------
 * `nodeRuntime.embedded` is `true` ONLY when a real runtime file was
 * actually copied into the bundle -- checked directly against the built
 * `entries` array right before the manifest is returned, so a bundle
 * claiming `embedded: true` with no corresponding entry is structurally
 * impossible, not just avoided by discipline. Otherwise `embedded` is
 * `false` and `note` names the external `nodeRequirement` the host must
 * satisfy instead.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { sha256Hex } from "../styx/certificate";
import { MIN_NODE_MAJOR } from "./plan";

// ---------------------------------------------------------------------------
// Locked public types
// ---------------------------------------------------------------------------

export const BUNDLE_MANIFEST_VERSION = 1;
export const BUNDLE_MANIFEST_FILE = "bundle.json";

export interface BundleSourceSpec {
  from: string;
  to: string;
  executable?: boolean;
  optional?: boolean;
}

export interface BundleEntry {
  path: string;
  bytes: number;
  sha256: string;
  executable: boolean;
}

export interface NodeRuntimeInfo {
  embedded: boolean;
  version?: string;
  source?: string;
  note: string;
}

export interface BundleManifest {
  version: number;
  name: string;
  hadesVersion: string;
  createdAt: number;
  platform: "any" | NodeJS.Platform;
  arch: string;
  nodeRequirement: string;
  nodeRuntime: NodeRuntimeInfo;
  entries: BundleEntry[];
  rootHash: string;
}

export interface StageInput {
  sourceRoot: string;
  outDir: string;
  include: BundleSourceSpec[];
  hadesVersion: string;
  name?: string;
  platform?: "any" | NodeJS.Platform;
  arch?: string;
  nodeRuntime?: { from: string; version: string };
  now?: () => number;
  maxTotalBytes?: number;
}

export interface BundlePlan {
  outDir: string;
  files: Array<{ from: string; to: string; bytes: number; executable: boolean }>;
  missing: string[];
  refused: Array<{ from: string; reason: string }>;
  totalBytes: number;
}

export interface BundleVerification {
  ok: boolean;
  manifestOk: boolean;
  rootHashOk: boolean;
  missing: string[];
  modified: string[];
  extra: string[];
  checked: number;
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** Sync, streamed, chunked reads -- never buffers a whole file in memory. */
const CHUNK_BYTES = 1024 * 1024; // 1 MiB

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function byPath(a: { path: string } | { to: string }, b: { path: string } | { to: string }): number {
  const ka = "path" in a ? a.path : a.to;
  const kb = "path" in b ? b.path : b.to;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Real sha256 of a file's bytes, computed by streaming fixed-size chunks
 *  through `node:crypto` -- the whole file is never held in memory at once,
 *  regardless of how large it is. */
function hashFileSync(absPath: string): { bytes: number; sha256: string } {
  const hash = createHash("sha256");
  const fd = openSync(absPath, "r");
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let bytes = 0;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally {
    closeSync(fd);
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Streams `src` into `dest` in fixed-size chunks while hashing what was
 *  written, in one pass -- again, never buffers the whole file. */
function copyAndHashSync(srcAbs: string, destAbs: string): { bytes: number; sha256: string } {
  const hash = createHash("sha256");
  const srcFd = openSync(srcAbs, "r");
  const destFd = openSync(destAbs, "w");
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let bytes = 0;
  try {
    for (;;) {
      const n = readSync(srcFd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      writeSync(destFd, buf, 0, n);
      bytes += n;
    }
  } finally {
    closeSync(srcFd);
    closeSync(destFd);
  }
  return { bytes, sha256: hash.digest("hex") };
}

/**
 * Refuses a `to` (bundle-relative destination) that is empty, absolute, or
 * that normalizes outside `outDir` -- via real path resolution, not a naive
 * string prefix check. Backslashes are treated as path separators too so
 * a Windows-authored `--include` spec is judged the same way on any host.
 */
function safeDestination(outDir: string, to: string): { ok: true; abs: string } | { ok: false; reason: string } {
  if (!to || to.length === 0) return { ok: false, reason: "destination is empty" };
  const posixTo = to.split("\\").join("/");
  if (posixTo.startsWith("/") || /^[A-Za-z]:/.test(posixTo)) {
    return { ok: false, reason: `destination "${to}" is absolute` };
  }
  const normalized = path.posix.normalize(posixTo);
  if (normalized === ".." || normalized.startsWith("../")) {
    return { ok: false, reason: `destination "${to}" escapes the bundle root` };
  }
  const outDirAbs = path.resolve(outDir);
  const destAbs = path.resolve(outDirAbs, normalized);
  const rel = path.relative(outDirAbs, destAbs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: `destination "${to}" escapes the bundle root` };
  }
  return { ok: true, abs: destAbs };
}

function runtimeDestPath(platform: "any" | NodeJS.Platform | undefined): string {
  return platform === "win32" ? "runtime/node.exe" : "runtime/node";
}

interface WalkedFile {
  absFrom: string;
  to: string;
  executable: boolean;
  bytes: number;
}

/**
 * Recursively walks a real filesystem entry (file, directory, or symlink)
 * rooted at `absPath`, appending every regular file found to `files`. A
 * symlink is resolved via `realpathSync` (never a string prefix check) and
 * compared against `sourceRealRoot`: a symlink whose real target lands
 * outside `sourceRoot` is refused (recorded in `refused`, never staged); a
 * symlink whose real target lands inside `sourceRoot` is followed and its
 * content is what gets hashed.
 */
function walkFsEntry(
  absPath: string,
  relTo: string,
  forceExecutable: boolean | undefined,
  sourceRealRoot: string,
  files: WalkedFile[],
  refused: Array<{ from: string; reason: string }>,
  topFrom: string,
): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(absPath);
  } catch (err) {
    refused.push({ from: topFrom, reason: `vanished while staging: ${absPath} (${errMessage(err)})` });
    return;
  }

  if (st.isSymbolicLink()) {
    let real: string;
    try {
      real = realpathSync(absPath);
    } catch (err) {
      refused.push({ from: topFrom, reason: `broken symlink: ${absPath} (${errMessage(err)})` });
      return;
    }
    const rel = path.relative(sourceRealRoot, real);
    const escapes = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (escapes) {
      refused.push({ from: topFrom, reason: `symlink escapes sourceRoot: ${absPath} -> ${real}` });
      return;
    }
    let realSt: ReturnType<typeof statSync>;
    try {
      realSt = statSync(real);
    } catch (err) {
      refused.push({ from: topFrom, reason: `broken symlink target: ${real} (${errMessage(err)})` });
      return;
    }
    if (realSt.isDirectory()) {
      for (const child of readdirSync(real).sort()) {
        walkFsEntry(path.join(real, child), `${relTo}/${child}`, forceExecutable, sourceRealRoot, files, refused, topFrom);
      }
      return;
    }
    if (realSt.isFile()) {
      files.push({
        absFrom: real,
        to: relTo,
        executable: forceExecutable === true || (realSt.mode & 0o111) !== 0,
        bytes: realSt.size,
      });
      return;
    }
    refused.push({ from: topFrom, reason: `unsupported symlink target type at ${real}` });
    return;
  }

  if (st.isDirectory()) {
    for (const child of readdirSync(absPath).sort()) {
      walkFsEntry(path.join(absPath, child), `${relTo}/${child}`, forceExecutable, sourceRealRoot, files, refused, topFrom);
    }
    return;
  }

  if (st.isFile()) {
    files.push({
      absFrom: absPath,
      to: relTo,
      executable: forceExecutable === true || (st.mode & 0o111) !== 0,
      bytes: st.size,
    });
    return;
  }

  refused.push({ from: topFrom, reason: `unsupported file type at ${absPath}` });
}

interface InternalPlan {
  plan: BundlePlan;
  missingRequired: string[];
  files: WalkedFile[];
}

/** The single, real, read-only walk shared by `planBundle` and `stageBundle`
 *  -- it never writes anything, it only `lstat`/`stat`/`readdir`/`realpath`s
 *  the real tree rooted at `sourceRoot`. */
function computeInternalPlan(input: StageInput): InternalPlan {
  let sourceRealRoot: string;
  try {
    sourceRealRoot = realpathSync(input.sourceRoot);
  } catch (err) {
    throw new Error(`bundle: sourceRoot does not exist: ${input.sourceRoot} (${errMessage(err)})`);
  }

  const files: WalkedFile[] = [];
  const refused: Array<{ from: string; reason: string }> = [];
  const missing: string[] = [];
  const missingRequired: string[] = [];

  for (const spec of input.include) {
    const destCheck = safeDestination(input.outDir, spec.to);
    if (!destCheck.ok) {
      refused.push({ from: spec.from, reason: destCheck.reason });
      continue;
    }
    const absFrom = path.resolve(input.sourceRoot, spec.from);
    try {
      lstatSync(absFrom);
    } catch {
      if (spec.optional) missing.push(spec.from);
      else missingRequired.push(spec.from);
      continue;
    }
    walkFsEntry(absFrom, spec.to, spec.executable, sourceRealRoot, files, refused, spec.from);
  }

  if (input.nodeRuntime) {
    const runtimeAbs = path.resolve(input.nodeRuntime.from);
    try {
      const st = statSync(runtimeAbs);
      if (!st.isFile()) throw new Error("not a regular file");
      files.push({ absFrom: runtimeAbs, to: runtimeDestPath(input.platform), executable: true, bytes: st.size });
    } catch {
      missing.push(input.nodeRuntime.from);
      missingRequired.push(input.nodeRuntime.from);
    }
  }

  files.sort(byPath);

  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);

  const plan: BundlePlan = {
    outDir: input.outDir,
    files: files.map((f) => ({ from: f.absFrom, to: f.to, bytes: f.bytes, executable: f.executable })),
    missing,
    refused,
    totalBytes,
  };

  return { plan, missingRequired, files };
}

// ---------------------------------------------------------------------------
// Public: planning
// ---------------------------------------------------------------------------

/** Pure (read-only) plan of what `stageBundle` would do: which real files
 *  would be staged, which optional sources are missing, which specs were
 *  refused for unsafe destinations or escaping symlinks, and the real total
 *  byte count. Never writes anything. */
export function planBundle(input: StageInput): BundlePlan {
  return computeInternalPlan(input).plan;
}

// ---------------------------------------------------------------------------
// Public: rootHash
// ---------------------------------------------------------------------------

function encodeField(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function encodeEntryForHash(e: BundleEntry): string {
  return encodeField(e.path) + encodeField(String(e.bytes)) + encodeField(e.sha256) + encodeField(e.executable ? "1" : "0");
}

/** See the module doc for the canonicalization contract. Sorts a copy of
 *  `entries` by path first, so the result is independent of the order the
 *  caller happens to pass them in. */
export function computeRootHash(entries: BundleEntry[]): string {
  const sorted = [...entries].sort(byPath);
  const body = sorted.map(encodeEntryForHash).join("");
  const canonical = `${BUNDLE_MANIFEST_VERSION}|${sorted.length}|${body}`;
  return sha256Hex(canonical);
}

// ---------------------------------------------------------------------------
// Public: staging (the only function that writes)
// ---------------------------------------------------------------------------

function computeNodeRuntimeInfo(input: StageInput, entries: BundleEntry[]): NodeRuntimeInfo {
  const nodeRequirement = `>=${MIN_NODE_MAJOR}`;
  if (!input.nodeRuntime) {
    return { embedded: false, note: `no embedded node runtime; a system node satisfying ${nodeRequirement} must be available on PATH` };
  }
  const dest = runtimeDestPath(input.platform);
  // Structural check, not a promise: `embedded: true` can only be returned
  // if the runtime file genuinely landed in `entries`.
  const present = entries.some((e) => e.path === dest);
  if (!present) {
    return {
      embedded: false,
      note: `requested embedded node runtime was not staged; a system node satisfying ${nodeRequirement} must be available on PATH`,
    };
  }
  return {
    embedded: true,
    version: input.nodeRuntime.version,
    source: input.nodeRuntime.from,
    note: `embedded node ${input.nodeRuntime.version} runtime copied from ${input.nodeRuntime.from}`,
  };
}

/** Stages a real bundle on disk: copies every planned file (streamed,
 *  hashed as it's written), writes `bundle.json`, and returns the manifest.
 *  `maxTotalBytes` and any non-optional missing source are enforced BEFORE
 *  anything is written -- a violation never leaves a half-staged bundle
 *  behind. */
export function stageBundle(input: StageInput): BundleManifest {
  const { plan, missingRequired, files } = computeInternalPlan(input);

  if (missingRequired.length > 0) {
    throw new Error(`bundle: missing required source(s): ${missingRequired.join(", ")}`);
  }
  if (input.maxTotalBytes !== undefined && plan.totalBytes > input.maxTotalBytes) {
    throw new Error(`bundle: staged size ${plan.totalBytes} bytes exceeds maxTotalBytes ${input.maxTotalBytes} bytes`);
  }

  // Nothing has been written to disk above this line.
  mkdirSync(input.outDir, { recursive: true });

  const entries: BundleEntry[] = [];
  for (const f of files) {
    const destAbs = path.resolve(input.outDir, f.to);
    mkdirSync(path.dirname(destAbs), { recursive: true });
    const { bytes, sha256 } = copyAndHashSync(f.absFrom, destAbs);
    chmodSync(destAbs, f.executable ? 0o755 : 0o644);
    entries.push({ path: f.to, bytes, sha256, executable: f.executable });
  }
  entries.sort(byPath);

  const now = input.now ?? Date.now;
  const nodeRuntime = computeNodeRuntimeInfo(input, entries);

  const manifest: BundleManifest = {
    version: BUNDLE_MANIFEST_VERSION,
    name: input.name ?? "hades",
    hadesVersion: input.hadesVersion,
    createdAt: now(),
    platform: input.platform ?? "any",
    arch: input.arch ?? process.arch,
    nodeRequirement: `>=${MIN_NODE_MAJOR}`,
    nodeRuntime,
    entries,
    rootHash: computeRootHash(entries),
  };

  writeManifest(input.outDir, manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Public: manifest read/write
// ---------------------------------------------------------------------------

export function writeManifest(dir: string, manifest: BundleManifest): void {
  const filePath = path.join(dir, BUNDLE_MANIFEST_FILE);
  writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function readManifest(dir: string): BundleManifest {
  const filePath = path.join(dir, BUNDLE_MANIFEST_FILE);
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as BundleManifest;
}

// ---------------------------------------------------------------------------
// Public: independent verification
// ---------------------------------------------------------------------------

function listBundleFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const child of readdirSync(abs)) {
        walk(path.join(abs, child), rel ? `${rel}/${child}` : child);
      }
      return;
    }
    if (rel !== BUNDLE_MANIFEST_FILE) out.push(rel);
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
}

/**
 * Independently re-derives everything the manifest claims from the bytes
 * actually on disk. A corrupt or unsupported-version `bundle.json` is a
 * diagnosis (`manifestOk: false`), never a thrown exception -- callers
 * (like `hades install verify`) always get a structured answer.
 */
export function verifyBundle(dir: string, opts?: { allowExtra?: boolean }): BundleVerification {
  const allowExtra = opts?.allowExtra === true;

  let manifest: BundleManifest | undefined;
  let manifestOk = true;
  try {
    const parsed = readManifest(dir);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.version !== "number" ||
      !Array.isArray(parsed.entries) ||
      typeof parsed.rootHash !== "string"
    ) {
      manifestOk = false;
    } else if (parsed.version !== BUNDLE_MANIFEST_VERSION) {
      // A version we don't understand cannot be honestly verified against
      // this build's schema -- refuse cleanly rather than guess.
      manifestOk = false;
    } else {
      manifest = parsed;
    }
  } catch {
    manifestOk = false;
  }

  if (!manifestOk || !manifest) {
    return { ok: false, manifestOk: false, rootHashOk: false, missing: [], modified: [], extra: [], checked: 0 };
  }

  const rootHashOk = computeRootHash(manifest.entries) === manifest.rootHash;

  const missing: string[] = [];
  const modified: string[] = [];
  let checked = 0;

  for (const entry of manifest.entries) {
    const abs = path.join(dir, ...entry.path.split("/"));
    if (!existsSync(abs)) {
      missing.push(entry.path);
      continue;
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      missing.push(entry.path);
      continue;
    }
    checked++;
    if (!st.isFile()) {
      modified.push(entry.path);
      continue;
    }
    if (st.size !== entry.bytes) {
      modified.push(entry.path);
      continue;
    }
    const { sha256 } = hashFileSync(abs);
    if (sha256 !== entry.sha256) {
      modified.push(entry.path);
    }
  }

  const manifestPaths = new Set(manifest.entries.map((e) => e.path));
  const extra = listBundleFiles(dir).filter((p) => !manifestPaths.has(p));

  const ok = rootHashOk && missing.length === 0 && modified.length === 0 && (allowExtra || extra.length === 0);

  return { ok, manifestOk: true, rootHashOk, missing, modified, extra, checked };
}

// ---------------------------------------------------------------------------
// Public: cross-platform launchers
// ---------------------------------------------------------------------------

const PREFERRED_ENTRY_POINTS: readonly string[] = ["bin/hades.mjs", "bin/hades.cjs", "bin/hades.js", "bin/hades.ts"];

function findEntryPointPath(manifest: BundleManifest): string {
  for (const candidate of PREFERRED_ENTRY_POINTS) {
    if (manifest.entries.some((e) => e.path === candidate)) return candidate;
  }
  const inBin = manifest.entries.find((e) => e.path.startsWith("bin/"));
  if (inBin) return inBin.path;
  if (manifest.entries.length > 0) return manifest.entries[0].path;
  return "bin/hades.js";
}

/** Generates the two launcher scripts a staged bundle ships alongside
 *  `bundle.json`: a POSIX `hades` (bash) and a Windows `hades.cmd` (batch).
 *  Both resolve the bundle's own directory at runtime (`$BASH_SOURCE`/
 *  `%~dp0`) so the bundle is relocatable, both name `nodeRequirement`, and
 *  both exec the same entry point resolved from the manifest's own
 *  `entries` (never a hardcoded guess). */
export function bundleLaunchers(manifest: BundleManifest): { hades: string; "hades.cmd": string } {
  const entry = findEntryPointPath(manifest);
  const needsTsx = entry.endsWith(".ts");
  const nodeRequirement = manifest.nodeRequirement;
  const winEntry = entry.split("/").join("\\");

  const posixNodeInvocation = needsTsx ? 'node --import tsx "$ENTRY" "$@"' : 'node "$ENTRY" "$@"';
  const hades =
    "#!/usr/bin/env bash\n" +
    "set -euo pipefail\n" +
    "# hades portable bundle launcher -- generated by bundle.ts. Do not edit.\n" +
    `# bundle: ${manifest.name} ${manifest.hadesVersion}\n` +
    `# requires: node ${nodeRequirement}\n` +
    'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n' +
    `ENTRY="$DIR/${entry}"\n` +
    `${posixNodeInvocation}\n`;

  const winNodeInvocation = needsTsx ? 'node --import tsx "%ENTRY%" %*' : 'node "%ENTRY%" %*';
  const hadesCmd =
    "@echo off\r\n" +
    "setlocal\r\n" +
    "rem hades portable bundle launcher -- generated by bundle.ts. Do not edit.\r\n" +
    `rem bundle: ${manifest.name} ${manifest.hadesVersion}\r\n` +
    `rem requires: node ${nodeRequirement}\r\n` +
    'set "DIR=%~dp0"\r\n' +
    `set "ENTRY=%DIR%${winEntry}"\r\n` +
    `${winNodeInvocation}\r\n`;

  return { hades, "hades.cmd": hadesCmd };
}

// ---------------------------------------------------------------------------
// Public: default include set for a real hades CLI bundle
// ---------------------------------------------------------------------------

/** The default `include` set for `hades install bundle` when the caller
 *  doesn't pass any explicit `--include` flags -- the CLI entry point plus
 *  the manifest files a portable checkout needs to make sense of itself.
 *  Every `from` here is a real, repo-relative path (verified against the
 *  actual repository in this build's own tests). `tsconfig.json` is marked
 *  optional since a downstream fork may not ship one under that exact name. */
export const DEFAULT_BUNDLE_INCLUDES: readonly BundleSourceSpec[] = [
  { from: "src/hades/bin/hades.ts", to: "bin/hades.ts" },
  { from: "package.json", to: "package.json" },
  { from: "tsconfig.json", to: "tsconfig.json", optional: true },
];
