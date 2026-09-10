import { describe, it, expect } from "vitest";
import { runShowdownLiveCommand } from "../cli/showdown-live-command";
import type { ShowdownLiveCommandDeps } from "../cli/showdown-live-command";
import type { runLiveShowdown, verifyLiveArtifacts } from "../bench/showdown-live";

// ---------------------------------------------------------------------------
// Test harness: a line-capturing `write`, plus stub `run`/`verify` deps so
// this command is exercised with zero real fs / network / provider key.
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<ShowdownLiveCommandDeps> = {}): {
  deps: ShowdownLiveCommandDeps;
  lines: string[];
} {
  const lines: string[] = [];
  const deps: ShowdownLiveCommandDeps = {
    run: (async () => {
      throw new Error("run() stub not configured for this test");
    }) as typeof runLiveShowdown,
    verify: (async () => {
      throw new Error("verify() stub not configured for this test");
    }) as typeof verifyLiveArtifacts,
    env: {},
    write: (line: string) => lines.push(line),
    ...overrides,
  };
  return { deps, lines };
}

function fakeManifest(overrides: Partial<Parameters<typeof runLiveShowdown>[0]> = {}) {
  void overrides;
  return {
    version: 1 as const,
    mode: "real" as const,
    seed: 42,
    taskCount: 6,
    provider: "anthropic",
    model: "claude-sonnet-5",
    nodeVersion: "v99.0.0",
    startedAt: 0,
    finishedAt: 1000,
    wallMs: 1000,
    files: [
      { name: "report.md" as const, sha256: "a".repeat(64) },
      { name: "audit.jsonl" as const, sha256: "b".repeat(64) },
      { name: "result.json" as const, sha256: "c".repeat(64) },
    ],
    vtph: { swarm: 120.5, baseline: 12.25, multiple: 9.84, swarmVerified: 6, baselineVerified: 5 },
  };
}

// ===========================================================================
// help / no-args / unknown subcommand
// ===========================================================================

describe("runShowdownLiveCommand — help & dispatch", () => {
  it("prints usage and exits 0 with no args", async () => {
    const { deps, lines } = makeDeps();
    const code = await runShowdownLiveCommand([], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("Usage: hades showdown live"))).toBe(true);
  });

  it('prints usage and exits 0 on "help"', async () => {
    const { deps, lines } = makeDeps();
    const code = await runShowdownLiveCommand(["help"], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("live-verify"))).toBe(true);
  });

  it('prints usage and exits 0 on "--help" and "-h"', async () => {
    const a = makeDeps();
    expect(await runShowdownLiveCommand(["--help"], a.deps)).toBe(0);
    const b = makeDeps();
    expect(await runShowdownLiveCommand(["-h"], b.deps)).toBe(0);
  });

  it("prints usage and exits 1 on an unknown subcommand", async () => {
    const { deps, lines } = makeDeps();
    const code = await runShowdownLiveCommand(["frobnicate"], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain("Unknown showdown-live command: frobnicate");
    expect(lines.some((l) => l.includes("Usage: hades showdown live"))).toBe(true);
  });
});

// ===========================================================================
// `live` — flag validation matrix
// ===========================================================================

describe("runShowdownLiveCommand live — flag validation", () => {
  it("rejects a non-integer --tasks value with usage + exit 1", async () => {
    const { deps, lines } = makeDeps();
    const code = await runShowdownLiveCommand(["live", "--tasks", "abc", "--out", "/o"], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain('Invalid --tasks value: "abc"');
    expect(lines.some((l) => l.includes("Usage: hades showdown live"))).toBe(true);
  });

  it("rejects a zero/negative --tasks value", async () => {
    const { deps, lines } = makeDeps();
    const code = await runShowdownLiveCommand(["live", "--tasks", "0", "--out", "/o"], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain("Invalid --tasks");
  });

  it("rejects a non-integer --seed value", async () => {
    const { deps, lines } = makeDeps();
    const code = await runShowdownLiveCommand(["live", "--seed", "not-a-number", "--out", "/o"], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain('Invalid --seed value: "not-a-number"');
  });

  it("rejects a non-positive --max-wall-ms value", async () => {
    const { deps, lines } = makeDeps();
    const code = await runShowdownLiveCommand(["live", "--max-wall-ms", "-5", "--out", "/o"], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain("Invalid --max-wall-ms");
  });

  it("requires --out and prints usage + exit 1 when missing", async () => {
    const { deps, lines } = makeDeps();
    const code = await runShowdownLiveCommand(["live", "--tasks", "5"], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain("Missing required --out");
    expect(lines.some((l) => l.includes("Usage: hades showdown live"))).toBe(true);
  });
});

// ===========================================================================
// `live` — success path
// ===========================================================================

describe("runShowdownLiveCommand live — success path", () => {
  it("runs, prints the V-TPH$ summary and artifact list, exits 0", async () => {
    let capturedOpts: unknown;
    let capturedDeps: unknown;
    const manifest = fakeManifest();
    const { deps, lines } = makeDeps({
      env: { ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" },
      run: (async (opts, runDeps) => {
        capturedOpts = opts;
        capturedDeps = runDeps;
        return {
          result: {} as never,
          manifest,
          files: ["/o/report.md", "/o/audit.jsonl", "/o/result.json", "/o/manifest.json"],
        };
      }) as typeof runLiveShowdown,
    });

    const code = await runShowdownLiveCommand(["live", "--tasks", "6", "--seed", "42", "--out", "/o"], deps);

    expect(code).toBe(0);
    expect(capturedOpts).toMatchObject({ seed: 42, taskCount: 6, outDir: "/o" });
    expect(capturedDeps).toMatchObject({ env: { ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" } });
    expect(lines.some((l) => l.includes("mode=real"))).toBe(true);
    expect(lines.some((l) => l.includes("V-TPH$"))).toBe(true);
    expect(lines.some((l) => l.includes("9.84x"))).toBe(true);
    expect(lines.some((l) => l.includes("/o/manifest.json"))).toBe(true);
  });

  it("defaults --seed and passes undefined --tasks/--max-wall-ms through to run()", async () => {
    let capturedOpts: unknown;
    const { deps } = makeDeps({
      run: (async (opts) => {
        capturedOpts = opts;
        return { result: {} as never, manifest: fakeManifest(), files: [] };
      }) as typeof runLiveShowdown,
    });
    await runShowdownLiveCommand(["live", "--out", "/o"], deps);
    expect(capturedOpts).toMatchObject({ seed: 42, outDir: "/o" });
    expect((capturedOpts as { taskCount?: number }).taskCount).toBeUndefined();
    expect((capturedOpts as { maxWallMs?: number }).maxWallMs).toBeUndefined();
  });
});

// ===========================================================================
// `live` — refusal path (no key / engine throws)
// ===========================================================================

describe("runShowdownLiveCommand live — refusal path", () => {
  it("relays the refusal message from run() and exits 1, never leaking a sentinel key", async () => {
    const sentinel = "sk-ant-SENTINEL-should-never-appear";
    const { deps, lines } = makeDeps({
      env: { ANTHROPIC_API_KEY: sentinel },
      run: (async () => {
        throw new Error(
          "runLiveShowdown: refusing to run a live showdown — ANTHROPIC_API_KEY is not set. " +
            "OPENAI_API_KEY is not set. No modeled fallback occurred."
        );
      }) as typeof runLiveShowdown,
    });
    const code = await runShowdownLiveCommand(["live", "--out", "/o"], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain("ANTHROPIC_API_KEY");
    expect(lines[0]).toContain("No modeled fallback");
    expect(lines.join("\n")).not.toContain(sentinel);
  });
});

// ===========================================================================
// `live-verify`
// ===========================================================================

describe("runShowdownLiveCommand live-verify", () => {
  it("requires a <dir> argument", async () => {
    const { deps, lines } = makeDeps();
    const code = await runShowdownLiveCommand(["live-verify"], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain("Usage: hades showdown live-verify <dir>");
  });

  it("exits 0 and reports OK when verify() returns ok:true", async () => {
    let capturedDir: string | undefined;
    const { deps, lines } = makeDeps({
      verify: (async (dir) => {
        capturedDir = dir;
        return { ok: true, findings: [] };
      }) as typeof verifyLiveArtifacts,
    });
    const code = await runShowdownLiveCommand(["live-verify", "/some/dir"], deps);
    expect(code).toBe(0);
    expect(capturedDir).toBe("/some/dir");
    expect(lines[0]).toContain("verified OK");
  });

  it("exits 1 and lists every finding when verify() returns ok:false", async () => {
    const { deps, lines } = makeDeps({
      verify: (async () => ({
        ok: false,
        findings: ["sha256 mismatch for report.md: ...", "audit chain broken at record 3"],
      })) as typeof verifyLiveArtifacts,
    });
    const code = await runShowdownLiveCommand(["live-verify", "/some/dir"], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain("FAILED");
    expect(lines.some((l) => l.includes("sha256 mismatch for report.md"))).toBe(true);
    expect(lines.some((l) => l.includes("audit chain broken at record 3"))).toBe(true);
  });

  it("exits 1 and reports honestly when verify() itself throws", async () => {
    const { deps, lines } = makeDeps({
      verify: (async () => {
        throw new Error("ENOENT: directory does not exist");
      }) as typeof verifyLiveArtifacts,
    });
    const code = await runShowdownLiveCommand(["live-verify", "/nope"], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain("ENOENT");
  });
});
