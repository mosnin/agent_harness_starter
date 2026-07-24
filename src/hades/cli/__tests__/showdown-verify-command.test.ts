import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "../../styx/certificate";
import { LIVE_MANIFEST_VERSION } from "../../bench/showdown-live";
import type { LiveRunManifest } from "../../bench/showdown-live";
import { runShowdownVerifyCommand, runShowdownReadyCommand } from "../showdown-verify-command";

const REPORT_CONTENT = "# FIXTURE Showdown Report (test fixture, not a real keyed run)\n";
const AUDIT_CONTENT = '{"seq":0,"event":"fixture-record"}\n';
const RESULT_CONTENT = '{"mode":"real","taskCount":1,"fixture":true}\n';

const tempDirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "showdown-verify-command-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFixtureRunDir(overrides: Partial<LiveRunManifest> = {}): Promise<string> {
  const dir = await freshDir();
  await writeFile(join(dir, "report.md"), REPORT_CONTENT, "utf8");
  await writeFile(join(dir, "audit.jsonl"), AUDIT_CONTENT, "utf8");
  await writeFile(join(dir, "result.json"), RESULT_CONTENT, "utf8");

  const manifest: LiveRunManifest = {
    version: LIVE_MANIFEST_VERSION,
    mode: "real",
    seed: 42,
    taskCount: 1,
    provider: "anthropic",
    model: "claude-sonnet-5",
    nodeVersion: process.version,
    startedAt: 1_000,
    finishedAt: 2_000,
    wallMs: 1_000,
    files: [
      { name: "report.md", sha256: sha256Hex(REPORT_CONTENT) },
      { name: "audit.jsonl", sha256: sha256Hex(AUDIT_CONTENT) },
      { name: "result.json", sha256: sha256Hex(RESULT_CONTENT) },
    ],
    vtph: { swarm: 10, baseline: 5, multiple: 2, swarmVerified: 1, baselineVerified: 1 },
    ...overrides,
  };

  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ===========================================================================
// hades showdown verify --dir <path>
// ===========================================================================

describe("runShowdownVerifyCommand", () => {
  it("passes and exits 0 for a pristine fixture given an ABSOLUTE --dir", async () => {
    const dir = await writeFixtureRunDir();
    const result = await runShowdownVerifyCommand(["--dir", dir], { env: {}, cwd: "/some/unrelated/cwd" });
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.startsWith("Overall: PASS"))).toBe(true);
    expect(result.lines.some((l) => l.startsWith("[FAIL]"))).toBe(false);
  });

  it("resolves a RELATIVE --dir against deps.cwd", async () => {
    const dir = await writeFixtureRunDir();
    const cwd = dirname(dir);
    const base = dir.slice(cwd.length + 1);
    const result = await runShowdownVerifyCommand(["--dir", base], { env: {}, cwd });
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.startsWith("Overall: PASS"))).toBe(true);
  });

  it("exits 1 with the failed checks for a tampered fixture", async () => {
    const dir = await writeFixtureRunDir();
    await writeFile(join(dir, "report.md"), "TAMPERED CONTENT", "utf8");

    const result = await runShowdownVerifyCommand(["--dir", dir], { env: {}, cwd: "/irrelevant" });
    expect(result.code).toBe(1);
    expect(result.lines.some((l) => l.startsWith("[FAIL] file-hash:report.md"))).toBe(true);
    expect(result.lines.some((l) => l.startsWith("Overall: FAIL"))).toBe(true);
  });

  it("exits 1 with a usage error when --dir is missing", async () => {
    const result = await runShowdownVerifyCommand([], { env: {}, cwd: "/x" });
    expect(result.code).toBe(1);
    expect(result.lines.join(" ")).toContain("--dir");
  });

  it("exits 1 with a usage error when --dir has no value", async () => {
    const result = await runShowdownVerifyCommand(["--dir"], { env: {}, cwd: "/x" });
    expect(result.code).toBe(1);
    expect(result.lines.join(" ")).toMatch(/--dir requires a value/);
  });

  it("exits 1 on an unexpected trailing argument", async () => {
    const dir = await writeFixtureRunDir();
    const result = await runShowdownVerifyCommand(["--dir", dir, "extra"], { env: {}, cwd: "/x" });
    expect(result.code).toBe(1);
    expect(result.lines.join(" ")).toContain("Unexpected argument");
  });

  it("sanitizes control characters (ANSI escapes, \\r) embedded in manifest fields out of the output", async () => {
    const dir = await writeFixtureRunDir({ model: "claude-sonnet-5\x1b[31m\r-injected" });
    const result = await runShowdownVerifyCommand(["--dir", dir], { env: {}, cwd: "/x" });
    const joined = result.lines.join("\n");
    // eslint-disable-next-line no-control-regex
    expect(joined).not.toMatch(/\x1b/);
    expect(joined).not.toMatch(/\r/);
    // The visible (non-control) characters of the model string still show through.
    expect(joined).toContain("claude-sonnet-5");
    expect(joined).toContain("injected");
  });

  it("uses an injected AuditFsDeps when provided (proving the fs seam is respected)", async () => {
    const dir = await writeFixtureRunDir();
    let readCalls = 0;
    const result = await runShowdownVerifyCommand(["--dir", dir], {
      env: {},
      cwd: "/x",
      fs: {
        readFile: async (path, enc) => {
          readCalls += 1;
          const { readFile } = await import("node:fs/promises");
          return readFile(path, enc);
        },
        readdir: async (path) => {
          const { readdir } = await import("node:fs/promises");
          return readdir(path);
        },
      },
    });
    expect(result.code).toBe(0);
    expect(readCalls).toBeGreaterThan(0);
  });
});

// ===========================================================================
// hades showdown ready
// ===========================================================================

describe("runShowdownReadyCommand", () => {
  it("exits 0 and reports ready when a provider key is present", async () => {
    const result = await runShowdownReadyCommand({ env: { ANTHROPIC_API_KEY: "sk-test-key" }, cwd: "/x" });
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.startsWith("READY"))).toBe(true);
  });

  it("exits 1 and honestly reports NOT ready for a keyless env", async () => {
    const result = await runShowdownReadyCommand({ env: {}, cwd: "/x" });
    expect(result.code).toBe(1);
    expect(result.lines.some((l) => l.startsWith("NOT READY"))).toBe(true);
    expect(result.lines.some((l) => l.includes("UNMET"))).toBe(true);
  });

  it("never fabricates readiness from an env with only irrelevant vars set", async () => {
    const result = await runShowdownReadyCommand({ env: { PATH: "/usr/bin", HOME: "/root" }, cwd: "/x" });
    expect(result.code).toBe(1);
  });
});
