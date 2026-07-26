/* ------------------------------------------------------------------ *
 * file_ops — a root-jailed filesystem tool.
 *
 * This tool really touches disk (mode is always "real"): read, write,
 * append, list, stat, mkdir, delete, all confined to a single root
 * directory handed to the factory. The jail is the whole point of this
 * file, so it is enforced the paranoid way:
 *
 *   1. Resolve the requested path against the root with `node:path`
 *      (so `..` segments collapse) — this alone is NOT trusted.
 *   2. Walk up from the resolved target to the nearest existing
 *      ancestor and take its REAL path (`fs.realpath`), which resolves
 *      symlinks. Verify that real path is inside the REAL path of the
 *      root. This is what actually stops symlink escapes: a symlink
 *      sitting inside the jail that points outside it resolves to an
 *      outside real path and is rejected, even though the *lexical*
 *      path looked fine.
 *   3. Everything reported back to the caller is root-relative — the
 *      absolute host path is never echoed.
 *
 * No tool here ever throws out of `run`: every failure mode — bad
 * JSON, escape attempt, missing file, non-empty directory on delete —
 * comes back as `{ ok: false, output: "..." }`.
 * ------------------------------------------------------------------ */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

/* ------------------------------------------------------------------ *
 * Locked structural duplicates (see LOCKED CONTRACT rationale). These
 * shapes are NOT imported from another team's file — they are
 * duplicated here so this file has no cross-team dependency.
 * ------------------------------------------------------------------ */

export type ToolMode = "real" | "mock";
export type ToolCategory = "web" | "system" | "media" | "data";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; headers: Record<string, string>; text(): Promise<string> }>;

export interface ToolFactoryOptions {
  env?: Record<string, string | undefined>;
  fetchFn?: FetchLike;
  now?: () => number;
}

export interface Tool {
  name: string;
  description: string;
  run: (input: string) => ToolResult | Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface CatalogEntry {
  tool: Tool;
  id: string;
  category: ToolCategory;
  mode: ToolMode;
  requiresNetwork: boolean;
  requiredEnvKeys: string[];
  verifierId: string;
}

/* ------------------------------------------------------------------ *
 * Input / output shapes
 * ------------------------------------------------------------------ */

type FileOp = "read" | "write" | "append" | "list" | "stat" | "mkdir" | "delete";

interface FileOpsInput {
  op: FileOp;
  path: string;
  content?: string;
  maxBytes?: number;
}

const DEFAULT_MAX_READ_BYTES = 262_144;
const VALID_OPS: readonly FileOp[] = ["read", "write", "append", "list", "stat", "mkdir", "delete"];

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Type guard + validation for the parsed JSON input. Never throws. */
function parseInput(raw: string): { ok: true; value: FileOpsInput } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid json input" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "input must be a json object" };
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.op !== "string" || !VALID_OPS.includes(obj.op as FileOp)) {
    return { ok: false, error: `op must be one of: ${VALID_OPS.join(", ")}` };
  }
  if (typeof obj.path !== "string" || obj.path.length === 0) {
    return { ok: false, error: "path must be a non-empty string" };
  }
  if (obj.content !== undefined && typeof obj.content !== "string") {
    return { ok: false, error: "content must be a string" };
  }
  if (obj.maxBytes !== undefined) {
    if (typeof obj.maxBytes !== "number" || !Number.isFinite(obj.maxBytes) || obj.maxBytes < 0) {
      return { ok: false, error: "maxBytes must be a non-negative finite number" };
    }
  }

  return {
    ok: true,
    value: {
      op: obj.op as FileOp,
      path: obj.path,
      content: obj.content as string | undefined,
      maxBytes: obj.maxBytes as number | undefined,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The jail
 * ------------------------------------------------------------------ */

class JailViolation extends Error {}

/**
 * Resolve `requestedPath` against `root` and verify it — and, for
 * existing targets, its real (symlink-resolved) location — stays
 * inside `root`'s real location. Returns the resolved absolute path
 * (lexically resolved; callers that need the real path of an existing
 * target should use `resolveExistingReal` instead / additionally).
 *
 * Deliberately does NOT decode percent-escapes — a literal `%2e%2e` in
 * the input is just a filename component, not `..`.
 */
async function resolveInJail(root: string, requestedPath: string): Promise<string> {
  // Reject NUL bytes outright — these break every OS path API and are a
  // classic smuggling vector.
  if (requestedPath.includes("\0")) {
    throw new JailViolation("path contains a NUL byte");
  }

  const rootAbs = path.resolve(root);
  // Deliberately NOT `path.resolve(rootAbs, requestedPath)` — that
  // discards `rootAbs` outright when `requestedPath` is absolute
  // (e.g. "/etc/passwd"), which would let an absolute input bypass the
  // root entirely before the containment check ever runs. Instead we
  // normalize the candidate path directly (joining under root for
  // relative input, standalone for absolute input) and let the
  // containment check below — which compares real, symlink-resolved
  // paths, not string prefixes — be the single source of truth for
  // "is this inside the jail". That also defeats the classic
  // "root-prefix cousin directory" bug, where a naive `startsWith(root)`
  // string check would wrongly accept `/tmp/jail-evil` as inside
  // `/tmp/jail`.
  const resolved = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.normalize(path.join(rootAbs, requestedPath));

  const rootReal = await realpathOfExistingAncestor(rootAbs);
  const relFromRoot = path.relative(rootReal, resolved);
  const lexicallyInside =
    relFromRoot === "" || (!relFromRoot.startsWith("..") && !path.isAbsolute(relFromRoot));
  if (!lexicallyInside) {
    throw new JailViolation(`path escapes root: ${requestedPath}`);
  }

  // Now defeat symlink escapes: walk up from `resolved` to the nearest
  // existing ancestor, take ITS real path, and verify that real path is
  // still inside the root's real path. If a symlink anywhere on the
  // existing prefix points outside the jail, its real path will land
  // outside `rootReal` and we reject.
  const existingAncestorReal = await realpathOfExistingAncestor(resolved);
  const relFromRootReal = path.relative(rootReal, existingAncestorReal);
  const reallyInside =
    relFromRootReal === "" ||
    (!relFromRootReal.startsWith("..") && !path.isAbsolute(relFromRootReal));
  if (!reallyInside) {
    throw new JailViolation(`path escapes root via symlink: ${requestedPath}`);
  }

  return resolved;
}

/** Walk up from `target` until an existing path is found, then return
 *  ITS real (symlink-resolved) absolute path. `target` itself need not
 *  exist (e.g. a `write` to a new file) — its nearest existing parent
 *  is what matters for the jail check. */
async function realpathOfExistingAncestor(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding anything that
        // exists — extremely unlikely, but resolve to itself so the
        // caller gets a deterministic (and jail-violating, since it
        // won't match root) answer rather than looping forever.
        return current;
      }
      current = parent;
    }
  }
}

function toRootRelative(root: string, absPath: string): string {
  const rel = path.relative(path.resolve(root), absPath);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

async function doRead(
  absPath: string,
  maxBytes: number
): Promise<{ result: unknown; truncated?: boolean }> {
  const handle = await fs.open(absPath, "r");
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) {
      throw new Error("cannot read: path is a directory");
    }
    const cap = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(cap);
    const { bytesRead } = await handle.read(buffer, 0, cap, 0);
    const truncated = stat.size > bytesRead;
    return {
      result: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: truncated ? true : undefined,
    };
  } finally {
    await handle.close();
  }
}

async function doWrite(absPath: string, content: string): Promise<{ result: unknown }> {
  // Atomic write: write to a sibling tmp file, fsync, then rename over
  // the target. Leaves no tmp file behind on either success or failure.
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpName = `.tmp-${path.basename(absPath)}-${crypto.randomBytes(8).toString("hex")}`;
  const tmpPath = path.join(dir, tmpName);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, "w");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  return { result: { bytesWritten: Buffer.byteLength(content, "utf8") } };
}

async function doAppend(absPath: string, content: string): Promise<{ result: unknown }> {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  const handle = await fs.open(absPath, "a");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { result: { bytesAppended: Buffer.byteLength(content, "utf8") } };
}

async function doList(absPath: string): Promise<{ result: unknown }> {
  const entries = await fs.readdir(absPath, { withFileTypes: true });
  const items = entries
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { result: items };
}

async function doStat(absPath: string): Promise<{ result: unknown }> {
  const stat = await fs.lstat(absPath);
  return {
    result: {
      type: stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    },
  };
}

async function doMkdir(absPath: string): Promise<{ result: unknown }> {
  await fs.mkdir(absPath, { recursive: true });
  return { result: { created: true } };
}

async function doDelete(absPath: string): Promise<{ result: unknown }> {
  const stat = await fs.lstat(absPath);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(absPath);
    if (entries.length > 0) {
      throw new Error("refusing to delete a non-empty directory");
    }
    await fs.rmdir(absPath);
  } else {
    await fs.unlink(absPath);
  }
  return { result: { deleted: true } };
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

export function createFileOpsTool(opts: ToolFactoryOptions & { root: string }): CatalogEntry {
  const root = path.resolve(opts.root);

  const tool: Tool = {
    name: "file_ops",
    description:
      "Read, write, append, list, stat, mkdir, or delete files/directories within a jailed root. " +
      'Input JSON: {"op":"read|write|append|list|stat|mkdir|delete","path":string,"content"?:string,"maxBytes"?:number}',
    run: async (input: string): Promise<ToolResult> => {
      const parsed = parseInput(input);
      if (!parsed.ok) {
        return { ok: false, output: JSON.stringify({ mode: "real", error: parsed.error }) };
      }
      const { op, path: reqPath, content, maxBytes } = parsed.value;

      let absPath: string;
      try {
        absPath = await resolveInJail(root, reqPath);
      } catch (err) {
        return {
          ok: false,
          output: JSON.stringify({ mode: "real", op, error: messageOf(err) }),
        };
      }

      try {
        let outcome: { result: unknown; truncated?: boolean };
        switch (op) {
          case "read":
            outcome = await doRead(absPath, maxBytes ?? DEFAULT_MAX_READ_BYTES);
            break;
          case "write":
            outcome = await doWrite(absPath, content ?? "");
            break;
          case "append":
            outcome = await doAppend(absPath, content ?? "");
            break;
          case "list":
            outcome = await doList(absPath);
            break;
          case "stat":
            outcome = await doStat(absPath);
            break;
          case "mkdir":
            outcome = await doMkdir(absPath);
            break;
          case "delete":
            outcome = await doDelete(absPath);
            break;
        }

        const payload: Record<string, unknown> = {
          mode: "real",
          op,
          path: toRootRelative(root, absPath),
          result: outcome.result,
        };
        if (outcome.truncated) payload.truncated = true;
        return { ok: true, output: JSON.stringify(payload) };
      } catch (err) {
        return {
          ok: false,
          output: JSON.stringify({
            mode: "real",
            op,
            path: toRootRelative(root, absPath),
            error: messageOf(err),
          }),
        };
      }
    },
  };

  return {
    tool,
    id: "file_ops",
    category: "system",
    mode: "real",
    requiresNetwork: false,
    requiredEnvKeys: [],
    verifierId: "verify.file_ops",
  };
}

/* Re-exported for tests that want to construct a scratch jail directly. */
export const __internal = {
  resolveInJail,
  realpathOfExistingAncestor,
  DEFAULT_MAX_READ_BYTES,
};
