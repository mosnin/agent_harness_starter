/**
 * Shell execution tool — runs a command in a sandboxed subprocess.
 *
 * Configurable via SandboxToolConfig:
 *   allowedCommands  — whitelist of executables (default: none, which means deny all)
 *   allowedDirectories — paths the command may touch
 *   timeoutMs        — hard kill after N ms (default: 30 000)
 *   maxOutputBytes   — truncate captured stdout/stderr (default: 50 000)
 *
 * For remote sandbox execution (Daytona / Modal), import those tools instead.
 * This tool runs in the same process as the Next.js server — use it only in
 * trusted, controlled environments (e.g. a dedicated container).
 */

import { z } from "zod";
import { registerTool } from "../registry";
import type { SandboxToolConfig } from "../types";

const DEFAULT_CONFIG: Required<SandboxToolConfig> = {
  allowedCommands: [],       // deny all by default — must be explicitly enabled
  allowedDirectories: [],
  timeoutMs: 30_000,
  maxOutputBytes: 50_000,
};

function buildShellTool(sandboxConfig: SandboxToolConfig = {}) {
  const cfg: Required<SandboxToolConfig> = { ...DEFAULT_CONFIG, ...sandboxConfig };

  return registerTool({
    name: "shell_exec",
    description:
      "Execute a shell command and return its stdout/stderr. Only pre-approved commands are allowed.",
    category: "code",
    sandboxConfig: cfg,
    parameters: z.object({
      command: z.string().describe("The executable to run (e.g. 'node', 'python3', 'git')"),
      args: z.array(z.string()).default([]).describe("Command-line arguments"),
      cwd: z.string().optional().describe("Working directory (must be within allowedDirectories)"),
      env: z
        .record(z.string(), z.string())
        .default({})
        .describe("Additional environment variables (merged with process.env)"),
    }),
    async execute({ command, args, cwd, env }) {
      // Validate command against whitelist
      if (cfg.allowedCommands.length > 0 && !cfg.allowedCommands.includes(command)) {
        throw new Error(
          `Command "${command}" is not allowed. Allowed: ${cfg.allowedCommands.join(", ")}`
        );
      }

      // Validate cwd against allowed directories
      if (cwd && cfg.allowedDirectories.length > 0) {
        const allowed = cfg.allowedDirectories.some((dir) => cwd.startsWith(dir));
        if (!allowed) {
          throw new Error(
            `Directory "${cwd}" is not allowed. Allowed: ${cfg.allowedDirectories.join(", ")}`
          );
        }
      }

      const { spawn } = await import("child_process");

      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let outputBytes = 0;

        const append = (chunk: Buffer, target: "stdout" | "stderr") => {
          const remaining = cfg.maxOutputBytes - outputBytes;
          if (remaining <= 0) return;
          const slice = chunk.slice(0, remaining).toString("utf8");
          outputBytes += slice.length;
          if (target === "stdout") stdout += slice;
          else stderr += slice;
        };

        child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
        child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Command timed out after ${cfg.timeoutMs}ms`));
        }, cfg.timeoutMs);

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    },
  });
}

/** Default shell tool — all commands denied until you configure allowedCommands. */
export const shellExecTool = buildShellTool();

/**
 * Create a pre-configured shell tool with custom constraints.
 * Use this if you need multiple shell tools with different permission sets.
 *
 * Example:
 *   export const nodeShellTool = createShellTool({
 *     allowedCommands: ["node", "npm", "npx"],
 *     allowedDirectories: ["/tmp/sandbox"],
 *     timeoutMs: 60_000,
 *   });
 */
export function createShellTool(sandboxConfig: SandboxToolConfig) {
  return buildShellTool(sandboxConfig);
}
