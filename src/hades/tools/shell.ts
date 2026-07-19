/* ------------------------------------------------------------------ *
 * shell — a deny-by-default, allowlist-gated command runner.
 *
 * There is no shell here — literally. `realSpawn` calls `node:child_process
 * .spawn` with `shell: false`, so shell metacharacters (`;`, `|`, `&&`,
 * backticks, `$()`, globs, redirects...) are inert data, not syntax.
 * Everything the caller types is tokenized by a real, hand-written,
 * quote-aware tokenizer (`tokenizeCommandLine`) and passed to the
 * child process as an argv array.
 *
 * Gate order (locked):
 *   1. tokenize the command line (or accept structured {"cmd","args"} JSON)
 *   2. argv[0]'s basename must be in the policy allowlist
 *   3. no arg (including argv[0]) may match a `denyArgPattern`
 *   4. no arg may contain a newline or NUL byte
 *   5. only then: spawn
 *
 * `SpawnLike` is an injected seam so every policy branch is unit
 * testable without touching a real process, while a real spawn
 * integration test proves the seam's default implementation actually
 * enforces timeouts (SIGKILL) and output caps against a live process.
 * ------------------------------------------------------------------ */

import { spawn } from "node:child_process";
import * as path from "node:path";

/* ------------------------------------------------------------------ *
 * Locked structural duplicates (see LOCKED CONTRACT rationale).
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
 * Tokenizer — quote-aware, escape-aware, hand-written.
 *
 * Rules:
 *   - whitespace (space, tab, newline) separates tokens outside quotes
 *   - '...'  single quotes: fully literal, no escapes recognized inside
 *   - "..."  double quotes: backslash escapes \" \\ \$ \` and passes
 *            other backslashes through literally
 *   - outside quotes: backslash escapes the next character literally
 *     (including whitespace, letting you escape a space into a token)
 *   - an unterminated quote is a hard error, not a best-effort guess
 * ------------------------------------------------------------------ */

export function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = line.length;

  function isWhitespace(c: string): boolean {
    return c === " " || c === "\t" || c === "\n" || c === "\r";
  }

  while (i < n) {
    while (i < n && isWhitespace(line[i])) i++;
    if (i >= n) break;

    let token = "";
    let sawAnyChar = false;

    while (i < n && !isWhitespace(line[i])) {
      const c = line[i];
      sawAnyChar = true;

      if (c === "'") {
        const close = line.indexOf("'", i + 1);
        if (close === -1) {
          throw new Error("unterminated single quote");
        }
        token += line.slice(i + 1, close);
        i = close + 1;
        continue;
      }

      if (c === '"') {
        i++;
        let closed = false;
        while (i < n) {
          const d = line[i];
          if (d === '"') {
            closed = true;
            i++;
            break;
          }
          if (d === "\\" && i + 1 < n && ['"', "\\", "$", "`"].includes(line[i + 1])) {
            token += line[i + 1];
            i += 2;
            continue;
          }
          token += d;
          i++;
        }
        if (!closed) {
          throw new Error("unterminated double quote");
        }
        continue;
      }

      if (c === "\\") {
        if (i + 1 >= n) {
          throw new Error("trailing unescaped backslash");
        }
        token += line[i + 1];
        i += 2;
        continue;
      }

      token += c;
      i++;
    }

    if (sawAnyChar) tokens.push(token);
  }

  return tokens;
}

/* ------------------------------------------------------------------ *
 * Spawn seam
 * ------------------------------------------------------------------ */

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface SpawnLike {
  (
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs: number; maxOutputBytes: number }
  ): Promise<SpawnResult>;
}

/** The real implementation: node:child_process spawn with shell:false,
 *  a hard SIGKILL timeout, and streamed byte caps on both streams. */
export function realSpawn(): SpawnLike {
  return (cmd, args, opts) => {
    return new Promise<SpawnResult>((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);

      function appendCapped(
        chunk: Buffer,
        current: string,
        currentBytes: number
      ): { text: string; bytes: number } {
        if (currentBytes >= opts.maxOutputBytes) {
          truncated = true;
          return { text: current, bytes: currentBytes };
        }
        const remaining = opts.maxOutputBytes - currentBytes;
        if (chunk.length > remaining) {
          truncated = true;
          const partial = chunk.subarray(0, remaining);
          return { text: current + partial.toString("utf8"), bytes: currentBytes + partial.length };
        }
        return { text: current + chunk.toString("utf8"), bytes: currentBytes + chunk.length };
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        const next = appendCapped(chunk, stdout, stdoutBytes);
        stdout = next.text;
        stdoutBytes = next.bytes;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const next = appendCapped(chunk, stderr, stderrBytes);
        stderr = next.text;
        stderrBytes = next.bytes;
      });

      function finish(code: number | null): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut, truncated });
      }

      child.on("error", () => {
        finish(null);
      });
      child.on("close", (code) => {
        finish(code);
      });
    });
  };
}

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

export interface ShellPolicy {
  /** argv[0] basenames — deny by default, only these may run. */
  allowedCommands: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  denyArgPatterns?: RegExp[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 131_072;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface ParsedCommand {
  cmd: string;
  args: string[];
}

/** Parse the tool's input: either a bare command line (tokenized) or a
 *  structured {"cmd":string,"args":string[]} JSON object. */
function parseShellInput(raw: string): { ok: true; value: ParsedCommand } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: "empty command" };
  }

  // Structured JSON form: only recognized if it actually parses as a
  // JSON object with a string "cmd" — anything else falls through to
  // the tokenizer so a command line that happens to start with "{" but
  // isn't valid JSON (e.g. `echo {foo}`) still works.
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.cmd === "string") {
        if (obj.args !== undefined) {
          if (!Array.isArray(obj.args) || !obj.args.every((a) => typeof a === "string")) {
            return { ok: false, error: "args must be a string array" };
          }
        }
        const args = (obj.args as string[] | undefined) ?? [];
        return { ok: true, value: { cmd: obj.cmd, args } };
      }
    }
  }

  let tokens: string[];
  try {
    tokens = tokenizeCommandLine(raw);
  } catch (err) {
    return { ok: false, error: `tokenize error: ${messageOf(err)}` };
  }
  if (tokens.length === 0) {
    return { ok: false, error: "empty command" };
  }
  return { ok: true, value: { cmd: tokens[0], args: tokens.slice(1) } };
}

function basenameOf(cmd: string): string {
  return path.basename(cmd);
}

const CONTROL_CHAR_RE = /[\n\0]/;

/** Run the locked gate order; returns an error string, or null if the
 *  command passes every check. */
function checkPolicy(policy: ShellPolicy, cmd: string, args: string[]): string | null {
  const base = basenameOf(cmd);
  const allowedSet = new Set(policy.allowedCommands);
  if (!allowedSet.has(base)) {
    return `command not allowed: ${JSON.stringify(base)} (allowlist: ${policy.allowedCommands.join(", ") || "<empty>"})`;
  }

  const allArgs = [cmd, ...args];
  for (const arg of allArgs) {
    if (CONTROL_CHAR_RE.test(arg)) {
      return "arguments may not contain newlines or NUL bytes";
    }
  }

  const denyPatterns = policy.denyArgPatterns ?? [];
  for (const pattern of denyPatterns) {
    for (const arg of allArgs) {
      if (pattern.test(arg)) {
        return `argument matches a denied pattern: ${JSON.stringify(arg)}`;
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

export function createShellTool(
  opts: ToolFactoryOptions & { policy: ShellPolicy; spawn?: SpawnLike; cwd?: string }
): CatalogEntry {
  const doSpawn = opts.spawn ?? realSpawn();
  const timeoutMs = opts.policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.policy.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const tool: Tool = {
    name: "shell",
    description:
      "Run an allowlisted command with no shell interpretation. " +
      'Input: a bare command line, or JSON {"cmd":string,"args":string[]}.',
    run: async (input: string): Promise<ToolResult> => {
      const parsed = parseShellInput(input);
      if (!parsed.ok) {
        return { ok: false, output: JSON.stringify({ mode: "real", error: parsed.error }) };
      }
      const { cmd, args } = parsed.value;

      const violation = checkPolicy(opts.policy, cmd, args);
      if (violation) {
        return {
          ok: false,
          output: JSON.stringify({ mode: "real", cmd, args, error: violation }),
        };
      }

      try {
        const result = await doSpawn(cmd, args, {
          cwd: opts.cwd,
          timeoutMs,
          maxOutputBytes,
        });
        const ok = result.code === 0 && !result.timedOut;
        return {
          ok,
          output: JSON.stringify({
            mode: "real",
            cmd,
            args,
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
            truncated: result.truncated,
          }),
        };
      } catch (err) {
        return {
          ok: false,
          output: JSON.stringify({ mode: "real", cmd, args, error: messageOf(err) }),
        };
      }
    },
  };

  return {
    tool,
    id: "shell",
    category: "system",
    mode: "real",
    requiresNetwork: false,
    requiredEnvKeys: [],
    verifierId: "verify.shell",
  };
}
