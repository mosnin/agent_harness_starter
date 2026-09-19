/**
 * Optional runner for Hades Cut (`cap`) CLI / local MCP tools.
 *
 * The sidecar never shells out unless a write passed Jev. Inject a fake
 * runner in tests. Production uses `HADES_CUT_BIN` or `cap` on PATH.
 */

import { spawn } from "node:child_process";
import type { DesktopAction } from "../../jev/desktop";

export interface CapRunner {
  run(action: DesktopAction, args: Record<string, unknown>): Promise<unknown>;
}

const ACTION_TO_ARGS: Record<DesktopAction, (args: Record<string, unknown>) => string[]> = {
  targets: () => ["targets", "--json"],
  record_status: (args) => ["record", "status", "--json", ...(args.id ? ["--id", String(args.id)] : [])],
  record_start: (args) => [
    "record",
    "start",
    "--json",
    "--detach",
    ...(args.screen ? ["--screen", String(args.screen)] : []),
  ],
  record_stop: (args) => ["record", "stop", "--json", ...(args.id ? ["--id", String(args.id)] : [])],
  project_get: (args) => ["project", "config", "get", String(args.project ?? ""), "--json"],
  project_validate: (args) => ["project", "validate", String(args.project ?? ""), "--json"],
  project_patch: (args) => [
    "project",
    "config",
    "patch",
    String(args.project ?? ""),
    "--json",
    ...(args.expectedRevision ? ["--expected-revision", String(args.expectedRevision)] : []),
    ...(args.dryRun ? ["--dry-run"] : []),
    "--patch-json",
    JSON.stringify(args.patch ?? {}),
  ],
  editor_open: (args) => ["editor", "open", String(args.project ?? ""), "--json"],
  export: (args) => [
    "export",
    String(args.project ?? ""),
    "--json",
    ...(args.output ? ["--output", String(args.output)] : []),
  ],
};

export function createCapRunner(bin = process.env.HADES_CUT_BIN ?? "cap"): CapRunner {
  return {
    run(action, args) {
      return new Promise((resolve, reject) => {
        const argv = ACTION_TO_ARGS[action](args);
        const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          reject(error);
        });
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(stderr.trim() || `${bin} ${argv.join(" ")} exited ${code}`));
            return;
          }
          const text = stdout.trim();
          if (!text) {
            resolve({ ok: true });
            return;
          }
          try {
            resolve(JSON.parse(text) as unknown);
          } catch {
            resolve({ raw: text });
          }
        });
      });
    },
  };
}
