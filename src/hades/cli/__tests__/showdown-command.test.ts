import { describe, it, expect, afterEach } from "vitest";
import { runShowdownCommand } from "../showdown-command";
import type { ShowdownCommandDeps, ShowdownCommandFsDeps } from "../showdown-command";

// ---------------------------------------------------------------------------
// A trivial in-memory fake fs — proves `run --out` / `verify` work purely
// through the injected seam, no real disk I/O in these tests.
// ---------------------------------------------------------------------------

function makeFakeFs(): ShowdownCommandFsDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async mkdir() {
      return undefined;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async rename(oldPath, newPath) {
      if (!files.has(oldPath)) throw new Error(`ENOENT: no such file '${oldPath}'`);
      files.set(newPath, files.get(oldPath)!);
      files.delete(oldPath);
    },
    async readFile(path) {
      const v = files.get(path);
      if (v === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      return v;
    },
  };
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

// ===========================================================================
// help / dispatch
// ===========================================================================

describe("runShowdownCommand — dispatch", () => {
  it("prints usage with no args", async () => {
    const res = await runShowdownCommand([], {});
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toMatch(/Usage: hades showdown/);
  });

  it("prints usage for help/--help/-h", async () => {
    for (const arg of ["help", "--help", "-h"]) {
      const res = await runShowdownCommand([arg], {});
      expect(res.code).toBe(0);
      expect(res.lines.join("\n")).toMatch(/Usage: hades showdown/);
    }
  });

  it("rejects an unknown subcommand", async () => {
    const res = await runShowdownCommand(["frobnicate"], {});
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toMatch(/Unknown showdown command/);
  });
});

// ===========================================================================
// run
// ===========================================================================

describe("runShowdownCommand — run", () => {
  it("runs a small modeled suite by default and prints the scoreboard", async () => {
    let c = 0;
    const deps: ShowdownCommandDeps = { now: () => (c += 1) };
    const res = await runShowdownCommand(["run", "--tasks", "8", "--seed", "3"], deps);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toMatch(/SHOWDOWN — mode: MODELED/);
    expect(text).toMatch(/Swarm \(verification-gated\)/);
    expect(text).toMatch(/Baseline \(self-trusting single agent\)/);
  }, 30000);

  it("rejects an invalid --mode", async () => {
    const res = await runShowdownCommand(["run", "--mode", "quick"], {});
    expect(res.code).toBe(1);
    expect(res.lines[0]).toMatch(/Invalid --mode/);
  });

  it("rejects a non-positive-integer --tasks", async () => {
    const res = await runShowdownCommand(["run", "--tasks", "0"], {});
    expect(res.code).toBe(1);
    expect(res.lines[0]).toMatch(/Invalid --tasks/);
    const res2 = await runShowdownCommand(["run", "--tasks", "abc"], {});
    expect(res2.code).toBe(1);
  });

  it("rejects a non-integer --seed", async () => {
    const res = await runShowdownCommand(["run", "--seed", "3.5"], {});
    expect(res.code).toBe(1);
    expect(res.lines[0]).toMatch(/Invalid --seed/);
  });

  it("defaults --seed to 42 and --tasks to 200 when omitted (reproducible)", async () => {
    let c1 = 0;
    const r1 = await runShowdownCommand(["run"], { now: () => (c1 += 1) });
    let c2 = 0;
    const r2 = await runShowdownCommand(["run"], { now: () => (c2 += 1) });
    expect(r1.code).toBe(0);
    expect(r1.lines).toEqual(r2.lines); // seed=42 both times => identical report
  }, 60000);

  it("mode real without a provider key fails fast and names the missing env var", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const res = await runShowdownCommand(["run", "--mode", "real", "--tasks", "4"], {});
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toMatch(/ANTHROPIC_API_KEY/);
    expect(res.lines.join("\n")).toMatch(/OPENAI_API_KEY/);
  });

  it("streams progress lines to deps.stdout separately from the returned report", async () => {
    const streamed: string[] = [];
    let c = 0;
    const res = await runShowdownCommand(["run", "--tasks", "4", "--seed", "1"], {
      now: () => (c += 1),
      stdout: (l) => streamed.push(l),
    });
    expect(res.code).toBe(0);
    expect(streamed.some((l) => l.includes("task-runs complete"))).toBe(true);
    expect(streamed.some((l) => l.includes("SHOWDOWN"))).toBe(true);
  }, 30000);

  it("--out writes report.md, audit.jsonl, result.json through the injected fs and reports the paths", async () => {
    const fs = makeFakeFs();
    let c = 0;
    const res = await runShowdownCommand(["run", "--tasks", "6", "--seed", "2", "--out", "/tmp/showdown-demo"], {
      now: () => (c += 1),
      fs,
    });
    expect(res.code).toBe(0);
    expect(fs.files.has("/tmp/showdown-demo/report.md")).toBe(true);
    expect(fs.files.has("/tmp/showdown-demo/audit.jsonl")).toBe(true);
    expect(fs.files.has("/tmp/showdown-demo/result.json")).toBe(true);
    // No leftover .tmp entries (atomic rename completed).
    expect([...fs.files.keys()].some((k) => k.endsWith(".tmp"))).toBe(false);
    expect(res.lines.join("\n")).toMatch(/Artifacts written/);
    expect(res.lines.join("\n")).toContain("/tmp/showdown-demo/report.md");
  }, 30000);
});

// ===========================================================================
// verify
// ===========================================================================

describe("runShowdownCommand — verify", () => {
  async function writeGoodAuditLog(): Promise<ShowdownCommandFsDeps & { files: Map<string, string> }> {
    const fs = makeFakeFs();
    let c = 0;
    const runRes = await runShowdownCommand(["run", "--tasks", "5", "--seed", "9", "--out", "/data/run1"], {
      now: () => (c += 1),
      fs,
    });
    expect(runRes.code).toBe(0);
    return fs;
  }

  it("requires a directory argument", async () => {
    const res = await runShowdownCommand(["verify"], {});
    expect(res.code).toBe(1);
    expect(res.lines[0]).toMatch(/Usage: hades showdown verify/);
  });

  it("verifies a genuinely valid audit.jsonl", async () => {
    const fs = await writeGoodAuditLog();
    const res = await runShowdownCommand(["verify", "/data/run1"], { fs });
    expect(res.code).toBe(0);
    expect(res.lines[0]).toMatch(/Audit chain OK/);
    expect(res.lines[0]).toMatch(/10 record/); // 5 tasks * 2 lanes
  }, 30000);

  it("reports a missing audit.jsonl honestly", async () => {
    const fs = makeFakeFs();
    const res = await runShowdownCommand(["verify", "/nowhere"], { fs });
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toMatch(/Could not read/);
  });

  it("catches a truncated (malformed-JSON) audit.jsonl", async () => {
    const fs = await writeGoodAuditLog();
    const original = fs.files.get("/data/run1/audit.jsonl")!;
    const lines = original.split("\n").filter((l) => l.length > 0);
    // Truncate mid-record, simulating a crash during a non-atomic write.
    const truncated = [...lines.slice(0, -1), lines[lines.length - 1].slice(0, 20)].join("\n");
    fs.files.set("/data/run1/audit.jsonl", truncated);

    const res = await runShowdownCommand(["verify", "/data/run1"], { fs });
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toMatch(/truncated or malformed/);
  }, 30000);

  it("catches a reordered audit.jsonl", async () => {
    const fs = await writeGoodAuditLog();
    const original = fs.files.get("/data/run1/audit.jsonl")!;
    const lines = original.split("\n").filter((l) => l.length > 0);
    [lines[0], lines[1]] = [lines[1], lines[0]];
    fs.files.set("/data/run1/audit.jsonl", lines.join("\n") + "\n");

    const res = await runShowdownCommand(["verify", "/data/run1"], { fs });
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toMatch(/Audit chain verification FAILED/);
  }, 30000);

  it("catches a single tampered field (value changed, hash left stale)", async () => {
    const fs = await writeGoodAuditLog();
    const original = fs.files.get("/data/run1/audit.jsonl")!;
    const lines = original.split("\n").filter((l) => l.length > 0);
    const rec = JSON.parse(lines[2]);
    rec.usd = rec.usd + 1;
    lines[2] = JSON.stringify(rec);
    fs.files.set("/data/run1/audit.jsonl", lines.join("\n") + "\n");

    const res = await runShowdownCommand(["verify", "/data/run1"], { fs });
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toMatch(/record 2/);
  }, 30000);
});
