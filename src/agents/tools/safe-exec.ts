/**
 * Safe command executor — prevents shell injection attacks.
 *
 * Uses execFile() (no shell interpolation) with an explicit allowlist,
 * argument validation, and a permanent blocklist of dangerous commands.
 *
 * Extracted from ruflo's @claude-flow/security SafeExecutor and adapted
 * for the agent-harness tool model.
 *
 * @example
 *   import { createSafeExecutor } from "@agent-harness/core/tools";
 *
 *   const exec = createSafeExecutor({
 *     allowlist: ["git", "npm", "node"],
 *   });
 *
 *   const { stdout } = await exec("git", ["status"]);
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Commands that can NEVER be added to an allowlist. */
const PERMANENT_BLOCKLIST = new Set([
  "rm", "dd", "mkfs", "fdisk", "format",
  "kill", "killall", "pkill",
  "reboot", "shutdown", "halt", "poweroff",
  "chmod", "chown",   // too broad to allow safely
  "sudo", "su",
  "wget", "curl",     // use fetch() instead
  "eval", "bash", "sh", "zsh", "fish",
]);

const SHELL_METACHARACTERS = /[;&|`$(){}><\n\r]/;
const NULL_BYTE = /\0/;

export interface SafeExecutorOptions {
  /** Commands that are permitted. Any command not on this list is denied. */
  allowlist: string[];
  /** Maximum allowed length of any single argument. Default: 1000. */
  maxArgLength?: number;
  /** Working directory for executed commands. */
  cwd?: string;
  /** Timeout in milliseconds. Default: 30000. */
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class SafeExecutorError extends Error {
  constructor(
    message: string,
    public readonly code: "COMMAND_NOT_ALLOWED" | "INVALID_ARGUMENT" | "EXECUTION_FAILED" | "PERMANENTLY_BLOCKED"
  ) {
    super(message);
    this.name = "SafeExecutorError";
  }
}

export function createSafeExecutor(options: SafeExecutorOptions) {
  const { allowlist, maxArgLength = 1000, cwd, timeoutMs = 30000 } = options;

  // Validate allowlist at construction time
  for (const cmd of allowlist) {
    if (PERMANENT_BLOCKLIST.has(cmd)) {
      throw new SafeExecutorError(
        `"${cmd}" is on the permanent blocklist and cannot be added to an allowlist.`,
        "PERMANENTLY_BLOCKED"
      );
    }
  }

  const allowSet = new Set(allowlist);

  return async function execute(command: string, args: string[] = []): Promise<ExecResult> {
    // Command allowlist check
    if (!allowSet.has(command)) {
      throw new SafeExecutorError(
        `Command "${command}" is not on the allowlist. Allowed: ${[...allowSet].join(", ")}`,
        "COMMAND_NOT_ALLOWED"
      );
    }

    // Permanent blocklist (defense in depth)
    if (PERMANENT_BLOCKLIST.has(command)) {
      throw new SafeExecutorError(
        `Command "${command}" is permanently blocked.`,
        "PERMANENTLY_BLOCKED"
      );
    }

    // Validate each argument
    for (const arg of args) {
      if (NULL_BYTE.test(arg)) {
        throw new SafeExecutorError(`Argument contains null byte: "${arg.slice(0, 20)}..."`, "INVALID_ARGUMENT");
      }
      if (SHELL_METACHARACTERS.test(arg)) {
        throw new SafeExecutorError(
          `Argument contains shell metacharacters: "${arg.slice(0, 20)}..."`,
          "INVALID_ARGUMENT"
        );
      }
      if (arg.length > maxArgLength) {
        throw new SafeExecutorError(
          `Argument exceeds maximum length of ${maxArgLength}: "${arg.slice(0, 20)}..."`,
          "INVALID_ARGUMENT"
        );
      }
    }

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        shell: false,  // CRITICAL: never set to true
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      throw new SafeExecutorError(
        `Execution failed: ${e.message ?? "unknown error"}`,
        "EXECUTION_FAILED"
      );
    }
  };
}

/** Presets for common use cases */
export const SafeExecutorPresets = {
  /** Git operations only */
  git: () => createSafeExecutor({ allowlist: ["git"] }),
  /** npm/node operations */
  node: () => createSafeExecutor({ allowlist: ["npm", "npx", "node", "tsc"] }),
  /** Read-only filesystem inspection */
  readOnly: () => createSafeExecutor({ allowlist: ["ls", "cat", "find", "grep", "head", "tail", "wc"] }),
};
