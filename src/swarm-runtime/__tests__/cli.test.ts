/**
 * hermes-swarm CLI — flag handling at the real process boundary.
 *
 * `cli.ts` is a pure process shell (it parses `process.argv`, wires a swarm,
 * and calls `process.exit`), so these tests spawn it as a REAL child process
 * — the same way `resource-limits.test.ts` exercises real worker processes —
 * rather than importing it. Everything runs in inline mode with the
 * deterministic planner + DemoExecutor (the spawn env strips the SWARM/OPENAI
 * API keys), so no test ever hits the network.
 *
 * The regression pinned here: `-h`/`--help` used to be pushed onto the
 * positional list, so `hermes-swarm run --help` executed a swarm goal
 * literally named "help" (spawned 3 workers and "verified" them). Help must
 * print usage and exit 0 without building anything; `run` with no goal must
 * print usage and exit non-zero.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const CLI_TS = join(REPO_ROOT, "src", "swarm-runtime", "cli.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** One tsx spawn is ~2s cold; leave generous headroom for a loaded CI box. */
const SPAWN_TIMEOUT_MS = 60_000;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI source through tsx and capture exit code + both streams. */
function runCli(args: string[]): Promise<CliRun> {
  // Strip provider keys AND engine config so `plannerFromEnv` yields the
  // deterministic planner and `resolveRunEngine` can never auto-select a real
  // engine — a test must never depend on (or spend) a real model key.
  const env = { ...process.env };
  delete env.SWARM_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.SWARM_PROVIDER;
  delete env.SWARM_MODEL;
  return new Promise((resolve, reject) => {
    execFile(
      TSX_BIN,
      [CLI_TS, ...args],
      { cwd: REPO_ROOT, env, timeout: SPAWN_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(new Error(`CLI spawn failed (${error.message})\nstderr: ${stderr}`));
          return;
        }
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
      }
    );
  });
}

const looksLikeUsage = (s: string): boolean => s.includes("USAGE") && s.includes("hermes-swarm run");

describe("hermes-swarm CLI — help flags", () => {
  it("--help prints usage and exits 0", async () => {
    const res = await runCli(["--help"]);
    expect(res.code).toBe(0);
    expect(looksLikeUsage(res.stdout)).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("-h prints usage and exits 0", async () => {
    const res = await runCli(["-h"]);
    expect(res.code).toBe(0);
    expect(looksLikeUsage(res.stdout)).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("run --help prints usage and exits 0 WITHOUT executing a goal", async () => {
    const res = await runCli(["run", "--help"]);
    expect(res.code).toBe(0);
    expect(looksLikeUsage(res.stdout)).toBe(true);
    // The regression ran a goal named "help": workers spawned (stderr) and a
    // goal verdict printed (stdout). Neither may ever appear again.
    expect(res.stdout).not.toMatch(/=== goal/);
    expect(res.stderr).not.toMatch(/worker .* spawned/);
    expect(res.stdout + res.stderr).not.toMatch(/verified:/);
  }, SPAWN_TIMEOUT_MS);
});

describe("hermes-swarm CLI — run", () => {
  it("run with no goal prints usage and exits non-zero", async () => {
    const res = await runCli(["run"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/error: provide an objective/);
    expect(looksLikeUsage(res.stdout)).toBe(true);
    expect(res.stderr).not.toMatch(/worker .* spawned/);
  }, SPAWN_TIMEOUT_MS);

  it('run "<real goal>" still executes end-to-end (inline, deterministic)', async () => {
    const res = await runCli(["run", "summarize the fixture repo"]);
    expect(res.code).toBe(0);
    // Workers really ran and results were really verified (progress → stderr)…
    expect(res.stderr).toMatch(/worker .* spawned/);
    expect(res.stderr).toMatch(/verified:/);
    // …and the verdict names the actual objective, not a flag-swallowed one.
    expect(res.stdout).toMatch(/=== goal COMPLETED ===/);
    expect(res.stdout).toContain("summarize the fixture repo");
  }, SPAWN_TIMEOUT_MS);
});
