/**
 * File system tools — read, write, and list files within allowed directories.
 *
 * Safety: all paths are validated against allowedDirectories before any I/O.
 * Set allowedDirectories in your AgentConfig.sandboxConfig or override the
 * default exports below.
 *
 * For remote sandbox execution, use the Daytona or Modal tools instead.
 * These tools touch the live filesystem of the Next.js server process.
 */

import { z } from "zod";
import { registerTool } from "../registry";

const DEFAULT_MAX_FILE_SIZE = 100_000; // 100 KB

function validatePath(filePath: string, allowedDirs: string[]) {
  if (allowedDirs.length === 0) return; // no restriction
  const normalized = filePath.startsWith("/") ? filePath : `/${filePath}`;
  const allowed = allowedDirs.some((dir) => normalized.startsWith(dir));
  if (!allowed) {
    throw new Error(
      `Path "${filePath}" is outside allowed directories: ${allowedDirs.join(", ")}`
    );
  }
}

export interface FileToolsConfig {
  allowedDirectories?: string[];
  maxFileSizeBytes?: number;
}

export function createFileTools(cfg: FileToolsConfig = {}) {
  const dirs = cfg.allowedDirectories ?? [];
  const maxSize = cfg.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;

  const fileRead = registerTool({
    name: "file_read",
    description: "Read the contents of a file at the given path.",
    category: "files",
    parameters: z.object({
      path: z.string().describe("Absolute or relative file path"),
      encoding: z
        .enum(["utf8", "base64"])
        .default("utf8")
        .describe("Text encoding (use base64 for binary files)"),
    }),
    async execute({ path, encoding }) {
      validatePath(path, dirs);
      const { readFile } = await import("fs/promises");
      const buf = await readFile(path);
      if (buf.length > maxSize) {
        throw new Error(
          `File is ${buf.length} bytes, exceeds limit of ${maxSize} bytes. Read a smaller range.`
        );
      }
      return { path, content: buf.toString(encoding), bytes: buf.length };
    },
  });

  const fileWrite = registerTool({
    name: "file_write",
    description: "Write content to a file, creating parent directories as needed.",
    category: "files",
    parameters: z.object({
      path: z.string().describe("Absolute or relative file path"),
      content: z.string().describe("Content to write"),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
    }),
    async execute({ path, content, encoding }) {
      validatePath(path, dirs);
      const { writeFile, mkdir } = await import("fs/promises");
      const { dirname } = await import("path");
      await mkdir(dirname(path), { recursive: true });
      const buf = Buffer.from(content, encoding);
      if (buf.length > maxSize) {
        throw new Error(`Content is ${buf.length} bytes, exceeds limit of ${maxSize} bytes.`);
      }
      await writeFile(path, buf);
      return { path, bytes: buf.length };
    },
  });

  const fileList = registerTool({
    name: "file_list",
    description: "List files and directories at the given path.",
    category: "files",
    parameters: z.object({
      path: z.string().describe("Directory path to list"),
      recursive: z.boolean().default(false).describe("Recurse into subdirectories"),
    }),
    async execute({ path, recursive }) {
      validatePath(path, dirs);
      const { readdir } = await import("fs/promises");

      async function listDir(dir: string, depth = 0): Promise<string[]> {
        const entries = await readdir(dir, { withFileTypes: true });
        const results: string[] = [];
        for (const entry of entries) {
          const full = `${dir}/${entry.name}`;
          results.push(full);
          if (recursive && depth < 5 && entry.isDirectory()) {
            results.push(...(await listDir(full, depth + 1)));
          }
        }
        return results;
      }

      return { path, entries: await listDir(path) };
    },
  });

  const filePatch = registerTool({
    name: "file_patch",
    description:
      "Apply a unified diff patch to a file. Useful for targeted code edits without rewriting the entire file.",
    category: "files",
    parameters: z.object({
      path: z.string().describe("File to patch"),
      patch: z
        .string()
        .describe("Unified diff patch string (the output of `diff -u original modified`)"),
    }),
    async execute({ path, patch }) {
      validatePath(path, dirs);
      const { readFile, writeFile } = await import("fs/promises");
      const original = await readFile(path, "utf8");

      // Apply patch using a simple unified diff algorithm
      const patched = applyUnifiedDiff(original, patch);
      await writeFile(path, patched, "utf8");
      return { path, success: true };
    },
  });

  return { fileRead, fileWrite, fileList, filePatch };
}

/** Apply a simplified unified diff to a string. */
function applyUnifiedDiff(original: string, patch: string): string {
  const lines = original.split("\n");
  const patchLines = patch.split("\n");
  const result: string[] = [...lines];
  let offset = 0;

  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i];
    if (!line.startsWith("@@")) continue;

    const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;

    const origStart = parseInt(match[1], 10) - 1;
    const origCount = parseInt(match[2] ?? "1", 10);

    const hunk: string[] = [];
    let j = i + 1;
    while (j < patchLines.length && !patchLines[j].startsWith("@@")) {
      hunk.push(patchLines[j]);
      j++;
    }

    const removals = hunk.filter((l) => l.startsWith("-")).map((l) => l.slice(1));
    const additions = hunk.filter((l) => l.startsWith("+")).map((l) => l.slice(1));

    result.splice(origStart + offset, origCount, ...additions);
    offset += additions.length - removals.length;
  }

  return result.join("\n");
}

/** Default file tools — unrestricted (no allowedDirectories). */
export const { fileRead, fileWrite, fileList, filePatch } = createFileTools();
