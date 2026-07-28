import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preflightLiveShowdown,
  runLiveShowdown,
  verifyLiveArtifacts,
  LIVE_MANIFEST_VERSION,
} from "../showdown-live";
import type { LiveShowdownFsDeps } from "../showdown-live";
import { runShowdown, verifyAuditChain } from "../showdown";
import type { ShowdownResult } from "../showdown";
import { sha256Hex } from "../../styx/certificate";

// ---------------------------------------------------------------------------
// Fixture: a GENUINE ShowdownResult from the REAL runShowdown, mode:
// "modeled" (real engine, real hash chain, real verification gate — nothing
// stubbed at this layer). Per the real-vs-mock policy for this suite:
//   - used AS-IS (mode left "modeled") to prove the mode!=="real" refusal.
//   - spread with `mode: "real"` overridden only to synthesize a "this is
//     what a genuine live-mode result looks like" fixture for the mechanics
//     tests below, since actually invoking mode:"real" here would require a
//     live network call to a real provider. The underlying computation —
//     tasks, grading, the swarm engine, the hash chain — is 100% real; only
//     the top-level mode label is swapped for fixture purposes, exactly as
//     the opt-in describe block at the bottom of this file does for a truly
//     live (network-backed) end-to-end run when a real key is available.
// ---------------------------------------------------------------------------
async function buildGenuineModeledResult(opts: { seed: number; taskCount: number }): Promise<ShowdownResult> {
  let c = 0;
  return runShowdown({ mode: "modeled", seed: opts.seed, taskCount: opts.taskCount, now: () => (c += 1) });
}

function relabelAsReal(r: ShowdownResult): ShowdownResult {
  return { ...r, mode: "real" };
}

// ---------------------------------------------------------------------------
// In-memory fake fs — implements the exact LiveShowdownFsDeps surface
// (mkdir / writeFile / rename / readFile) so tests never touch a real disk
// unless explicitly exercising the "real node:fs" round trip.
// ---------------------------------------------------------------------------
function makeFakeFs(): {
  fs: LiveShowdownFsDeps;
  files: Map<string, string>;
  getWriteCount: () => number;
  failRenameTo: (targetPath: string) => void;
} {
  const files = new Map<string, string>();
  let writeCount = 0;
  let renameFailureTarget: string | undefined;

  const fs: LiveShowdownFsDeps = {
    async mkdir() {
      return undefined;
    },
    async writeFile(path: string, data: string) {
      writeCount += 1;
      files.set(path, data);
    },
    async rename(oldPath: string, newPath: string) {
      if (renameFailureTarget !== undefined && newPath === renameFailureTarget) {
        throw new Error(`simulated rename failure writing ${newPath}`);
      }
      const data = files.get(oldPath);
      if (data === undefined) throw new Error(`ENOENT: no such file ${oldPath}`);
      files.delete(oldPath);
      files.set(newPath, data);
    },
    async readFile(path: string) {
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: no such file ${path}`);
      return data;
    },
  };

  return {
    fs,
    files,
    getWriteCount: () => writeCount,
    failRenameTo: (targetPath: string) => {
      renameFailureTarget = targetPath;
    },
  };
}

// ===========================================================================
// preflightLiveShowdown
// ===========================================================================

describe("preflightLiveShowdown", () => {
  it("detects ANTHROPIC_API_KEY first when both are set, never echoing key material", () => {
    const p = preflightLiveShowdown({
      ANTHROPIC_API_KEY: "sk-ant-SENTINEL-abc123",
      OPENAI_API_KEY: "sk-oai-other-key",
    });
    expect(p.ok).toBe(true);
    expect(p.provider).toBe("anthropic");
    expect(p.model).toBe("claude-sonnet-5");
    expect(p.reasons.join(" ")).not.toContain("SENTINEL");
    expect(p.reasons.join(" ")).not.toContain("sk-ant-SENTINEL-abc123");
  });

  it("falls back to OPENAI_API_KEY when ANTHROPIC_API_KEY is absent", () => {
    const p = preflightLiveShowdown({ OPENAI_API_KEY: "sk-oai-SENTINEL-xyz" });
    expect(p.ok).toBe(true);
    expect(p.provider).toBe("openai");
    expect(p.model).toBe("gpt-4o-mini");
    expect(p.reasons.join(" ")).not.toContain("SENTINEL");
  });

  it("reports ok:false and names both env vars by NAME when neither key is set", () => {
    const p = preflightLiveShowdown({});
    expect(p.ok).toBe(false);
    expect(p.provider).toBeUndefined();
    expect(p.reasons.join(" ")).toContain("ANTHROPIC_API_KEY");
    expect(p.reasons.join(" ")).toContain("OPENAI_API_KEY");
  });

  it("treats an empty-string key as absent", () => {
    const p = preflightLiveShowdown({ ANTHROPIC_API_KEY: "" });
    expect(p.ok).toBe(false);
  });
});

// ===========================================================================
// runLiveShowdown — input validation (RangeError contract)
// ===========================================================================

describe("runLiveShowdown — input validation", () => {
  it("throws RangeError for a non-finite seed", async () => {
    await expect(runLiveShowdown({ seed: NaN, outDir: "/x" }, {})).rejects.toThrow(RangeError);
    await expect(runLiveShowdown({ seed: Infinity, outDir: "/x" }, {})).rejects.toThrow(RangeError);
  });

  it("throws RangeError for a non-integer or non-positive taskCount", async () => {
    await expect(runLiveShowdown({ seed: 1, outDir: "/x", taskCount: 1.5 }, {})).rejects.toThrow(RangeError);
    await expect(runLiveShowdown({ seed: 1, outDir: "/x", taskCount: 0 }, {})).rejects.toThrow(RangeError);
    await expect(runLiveShowdown({ seed: 1, outDir: "/x", taskCount: -3 }, {})).rejects.toThrow(RangeError);
  });

  it("throws RangeError when taskCount exceeds the hard cap of 50", async () => {
    await expect(runLiveShowdown({ seed: 1, outDir: "/x", taskCount: 51 }, {})).rejects.toThrow(RangeError);
    await expect(runLiveShowdown({ seed: 1, outDir: "/x", taskCount: 51 }, {})).rejects.toThrow(/50/);
  });

  it("accepts taskCount exactly at the cap (validation-only, no engine call)", async () => {
    // 50 must NOT throw at validation; it's the preflight step that fails
    // next (no key configured here), proving 50 itself cleared the cap.
    let caught: unknown;
    try {
      await runLiveShowdown({ seed: 1, outDir: "/x", taskCount: 50 }, { env: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeInstanceOf(RangeError);
    expect(caught).toBeInstanceOf(Error);
  });

  it("throws RangeError for a non-positive or non-finite maxWallMs", async () => {
    await expect(runLiveShowdown({ seed: 1, outDir: "/x", maxWallMs: 0 }, {})).rejects.toThrow(RangeError);
    await expect(runLiveShowdown({ seed: 1, outDir: "/x", maxWallMs: -10 }, {})).rejects.toThrow(RangeError);
    await expect(runLiveShowdown({ seed: 1, outDir: "/x", maxWallMs: NaN }, {})).rejects.toThrow(RangeError);
  });

  it("throws for an empty outDir", async () => {
    await expect(runLiveShowdown({ seed: 1, outDir: "" }, {})).rejects.toThrow(/outDir/);
    await expect(runLiveShowdown({ seed: 1, outDir: "   " }, {})).rejects.toThrow(/outDir/);
  });

  it("defaults taskCount to 12 when omitted", async () => {
    const genuine = relabelAsReal(await buildGenuineModeledResult({ seed: 3, taskCount: 12 }));
    const { fs } = makeFakeFs();
    let capturedTaskCount: number | undefined;
    const { manifest } = await runLiveShowdown(
      { seed: 3, outDir: "/virtual/default-taskcount" },
      {
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        fs,
        now: () => 0,
        runShowdownFn: async (o) => {
          capturedTaskCount = o.taskCount;
          return genuine;
        },
      }
    );
    expect(capturedTaskCount).toBe(12);
    expect(manifest.taskCount).toBe(12);
  }, 30000);
});

// ===========================================================================
// Preflight-driven refusal — no key, no fallback, no leaked secrets
// ===========================================================================

describe("runLiveShowdown — no-key refusal", () => {
  it("refuses with no key, names both env vars, states no modeled fallback, and writes nothing", async () => {
    const { fs, getWriteCount } = makeFakeFs();
    await expect(
      runLiveShowdown({ seed: 1, outDir: "/out", taskCount: 2 }, { env: {}, fs })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(
      runLiveShowdown({ seed: 1, outDir: "/out", taskCount: 2 }, { env: {}, fs })
    ).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(
      runLiveShowdown({ seed: 1, outDir: "/out", taskCount: 2 }, { env: {}, fs })
    ).rejects.toThrow(/No modeled fallback/i);
    expect(getWriteCount()).toBe(0);
  });

  it("never leaks a sentinel API key value through a thrown error message", async () => {
    const sentinel = "sk-ant-super-secret-SENTINEL-999";
    const { fs, files } = makeFakeFs();
    let caught: unknown;
    try {
      await runLiveShowdown(
        { seed: 1, outDir: "/out", taskCount: 2 },
        {
          env: { ANTHROPIC_API_KEY: sentinel },
          fs,
          runShowdownFn: async () => {
            throw new Error("simulated provider network failure");
          },
        }
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(sentinel);
    expect(Array.from(files.values()).join("\n")).not.toContain(sentinel);
  });
});

// ===========================================================================
// Refusal when the engine returns something dishonest
// ===========================================================================

describe("runLiveShowdown — refuses a dishonest engine result", () => {
  it('refuses when the returned mode !== "real", and writes nothing', async () => {
    const genuineModeled = await buildGenuineModeledResult({ seed: 5, taskCount: 4 });
    const { fs, getWriteCount } = makeFakeFs();
    await expect(
      runLiveShowdown(
        { seed: 5, outDir: "/out", taskCount: 4 },
        { env: { ANTHROPIC_API_KEY: "sk-ant-x" }, fs, runShowdownFn: async () => genuineModeled }
      )
    ).rejects.toThrow(/mode "modeled"/);
    expect(getWriteCount()).toBe(0);
  }, 30000);

  it("refuses when the audit chain is broken, and writes nothing", async () => {
    const genuine = await buildGenuineModeledResult({ seed: 6, taskCount: 4 });
    const tampered: ShowdownResult = {
      ...genuine,
      mode: "real",
      audit: genuine.audit.map((r, i) => (i === 1 ? { ...r, verdict: "TAMPERED" } : r)),
    };
    expect(verifyAuditChain(tampered.audit).ok).toBe(false); // sanity: fixture really is broken
    const { fs, getWriteCount } = makeFakeFs();
    await expect(
      runLiveShowdown(
        { seed: 6, outDir: "/out", taskCount: 4 },
        { env: { ANTHROPIC_API_KEY: "sk-ant-x" }, fs, runShowdownFn: async () => tampered }
      )
    ).rejects.toThrow(/audit chain/i);
    expect(getWriteCount()).toBe(0);
  }, 30000);

  it("wraps and surfaces a runShowdownFn failure honestly, writing nothing", async () => {
    const { fs, getWriteCount } = makeFakeFs();
    await expect(
      runLiveShowdown(
        { seed: 1, outDir: "/out", taskCount: 2 },
        {
          env: { ANTHROPIC_API_KEY: "sk-ant-x" },
          fs,
          runShowdownFn: async () => {
            throw new Error("provider 503");
          },
        }
      )
    ).rejects.toThrow(/provider 503/);
    expect(getWriteCount()).toBe(0);
  });
});

// ===========================================================================
// Wall-clock budget guard — fake clock, breach ⇒ zero writes
// ===========================================================================

describe("runLiveShowdown — wall-clock budget guard", () => {
  it("refuses on breach (fake clock), names elapsed vs budget, and writes nothing", async () => {
    const genuine = relabelAsReal(await buildGenuineModeledResult({ seed: 7, taskCount: 2 }));
    const { fs, getWriteCount } = makeFakeFs();
    let calls = 0;
    const fakeNow = (): number => (calls++ === 0 ? 0 : 10 * 60_000 + 1); // 10min+1ms on a 5min budget
    await expect(
      runLiveShowdown(
        { seed: 7, outDir: "/out", taskCount: 2, maxWallMs: 5 * 60_000 },
        { env: { ANTHROPIC_API_KEY: "sk-ant-x" }, fs, now: fakeNow, runShowdownFn: async () => genuine }
      )
    ).rejects.toThrow(/budget/i);
    expect(getWriteCount()).toBe(0);
  }, 30000);

  it("does not breach when elapsed is within budget", async () => {
    const genuine = relabelAsReal(await buildGenuineModeledResult({ seed: 71, taskCount: 2 }));
    const { fs } = makeFakeFs();
    let calls = 0;
    const fakeNow = (): number => (calls++ === 0 ? 0 : 1000); // 1s elapsed
    await expect(
      runLiveShowdown(
        { seed: 71, outDir: "/virtual/within-budget", taskCount: 2, maxWallMs: 5 * 60_000 },
        { env: { ANTHROPIC_API_KEY: "sk-ant-x" }, fs, now: fakeNow, runShowdownFn: async () => genuine }
      )
    ).resolves.toBeTruthy();
  }, 30000);
});

// ===========================================================================
// Full round trip — fake fs
// ===========================================================================

describe("runLiveShowdown + verifyLiveArtifacts — full round trip (fake fs)", () => {
  it("writes consistent artifacts + manifest, verifies clean with ok:true findings:[]", async () => {
    const genuine = relabelAsReal(await buildGenuineModeledResult({ seed: 42, taskCount: 6 }));
    const { fs } = makeFakeFs();
    const dir = "/virtual/live-out";
    let c = 0;
    const { result, manifest, files } = await runLiveShowdown(
      { seed: 42, outDir: dir, taskCount: 6 },
      {
        env: { ANTHROPIC_API_KEY: "sk-ant-x" },
        fs,
        now: () => (c += 1),
        gitCommit: async () => "deadbeefcafef00d",
        nodeVersion: "v99.0.0",
        runShowdownFn: async () => genuine,
      }
    );

    expect(result.mode).toBe("real");
    expect(manifest.version).toBe(LIVE_MANIFEST_VERSION);
    expect(manifest.mode).toBe("real");
    expect(manifest.provider).toBe("anthropic");
    expect(manifest.model).toBe("claude-sonnet-5");
    expect(manifest.gitCommit).toBe("deadbeefcafef00d");
    expect(manifest.nodeVersion).toBe("v99.0.0");
    expect(manifest.taskCount).toBe(6);
    expect(manifest.seed).toBe(42);
    expect(manifest.files.length).toBe(3);
    expect(files.length).toBe(4); // report.md, audit.jsonl, result.json, manifest.json

    // The trust-adjusted verified-yield figures are copied verbatim from the
    // run's reports into the manifest.
    expect(manifest.vtph.swarmVerifiedYield).toBe(result.swarmReport.verifiedYield);
    expect(manifest.vtph.baselineVerifiedYield).toBe(result.baselineReport.verifiedYield);
    expect(typeof manifest.vtph.swarmVerifiedYield).toBe("number");

    const outcome = await verifyLiveArtifacts(dir, fs);
    expect(outcome.findings).toEqual([]);
    expect(outcome.ok).toBe(true);
  }, 30000);
});

// ===========================================================================
// Full round trip — REAL node:fs temp dir
// ===========================================================================

describe("runLiveShowdown + verifyLiveArtifacts — full round trip (real node:fs)", () => {
  it("writes consistent artifacts + manifest on real disk, verifies clean", async () => {
    const genuine = relabelAsReal(await buildGenuineModeledResult({ seed: 55, taskCount: 4 }));
    const dir = await mkdtemp(join(tmpdir(), "showdown-live-"));
    try {
      let c = 0;
      const { manifest } = await runLiveShowdown(
        { seed: 55, outDir: dir, taskCount: 4 },
        { env: { ANTHROPIC_API_KEY: "sk-ant-x" }, now: () => (c += 1), runShowdownFn: async () => genuine }
      );
      expect(manifest.mode).toBe("real");

      const entries = await readdir(dir);
      expect(entries.sort()).toEqual(["audit.jsonl", "manifest.json", "report.md", "result.json"]);
      expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);

      const outcome = await verifyLiveArtifacts(dir);
      expect(outcome.findings).toEqual([]);
      expect(outcome.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

// ===========================================================================
// Crash safety — manifest.json rename failure
// ===========================================================================

describe("runLiveShowdown — crash safety", () => {
  it("a manifest.json rename failure surfaces honestly and leaves no manifest.json", async () => {
    const genuine = relabelAsReal(await buildGenuineModeledResult({ seed: 8, taskCount: 3 }));
    const dir = "/virtual/crash-out";
    const manifestPath = join(dir, "manifest.json");
    const fake = makeFakeFs();
    fake.failRenameTo(manifestPath);

    await expect(
      runLiveShowdown(
        { seed: 8, outDir: dir, taskCount: 3 },
        { env: { ANTHROPIC_API_KEY: "sk-ant-x" }, fs: fake.fs, now: () => 0, runShowdownFn: async () => genuine }
      )
    ).rejects.toThrow(/manifest\.json/);

    expect(fake.files.has(manifestPath)).toBe(false);
    expect(fake.files.has(join(dir, "report.md"))).toBe(true); // earlier artifacts DID get written
  }, 30000);
});

// ===========================================================================
// verifyLiveArtifacts — adversarial-grade tamper detection matrix
// ===========================================================================

describe("verifyLiveArtifacts — adversarial tamper detection", () => {
  async function freshRoundTrip(
    seed: number,
    taskCount: number
  ): Promise<{ fs: LiveShowdownFsDeps; files: Map<string, string>; dir: string }> {
    const genuine = relabelAsReal(await buildGenuineModeledResult({ seed, taskCount }));
    const { fs, files } = makeFakeFs();
    const dir = `/virtual/tamper-${seed}`;
    let c = 0;
    await runLiveShowdown(
      { seed, outDir: dir, taskCount },
      { env: { ANTHROPIC_API_KEY: "sk-ant-x" }, fs, now: () => (c += 1), runShowdownFn: async () => genuine }
    );
    return { fs, files, dir };
  }

  it("flips one audit verdict in audit.jsonl without recomputing its hash — chain break caught", async () => {
    const { fs, files, dir } = await freshRoundTrip(101, 4);
    const auditPath = join(dir, "audit.jsonl");
    const lines = (files.get(auditPath) ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    const rec = JSON.parse(lines[1]) as { verdict: string };
    rec.verdict = rec.verdict === "TAMPERED" ? "verified" : "TAMPERED";
    lines[1] = JSON.stringify(rec);
    files.set(auditPath, lines.join("\n") + "\n");

    const outcome = await verifyLiveArtifacts(dir, fs);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.some((f) => /hash chain/i.test(f))).toBe(true);
  }, 30000);

  it("edits a usd digit in result.json — sha256 mismatch caught", async () => {
    const { fs, files, dir } = await freshRoundTrip(102, 4);
    const resultPath = join(dir, "result.json");
    const parsed = JSON.parse(files.get(resultPath) ?? "{}") as ShowdownResult;
    parsed.swarmReport.totalUsd = parsed.swarmReport.totalUsd + 999;
    files.set(resultPath, JSON.stringify(parsed, null, 2) + "\n");

    const outcome = await verifyLiveArtifacts(dir, fs);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.some((f) => /sha256 mismatch for result\.json/.test(f))).toBe(true);
  }, 30000);

  it("verifies a PRE-verifiedYield artifact dir clean (backward compat: the field is optional-on-read)", async () => {
    // Simulate a directory published BEFORE the trust-adjusted metric
    // existed: strip verifiedYield from every report in result.json and the
    // yield fields from manifest.vtph, then re-point the manifest's
    // result.json sha256 at the stripped bytes (exactly what an old
    // publisher would have written). live-verify must still pass.
    const { fs, files, dir } = await freshRoundTrip(108, 4);

    const resultPath = join(dir, "result.json");
    const parsed = JSON.parse(files.get(resultPath) ?? "{}") as ShowdownResult;
    delete (parsed.swarmReport as Partial<ShowdownResult["swarmReport"]>).verifiedYield;
    delete (parsed.baselineReport as Partial<ShowdownResult["baselineReport"]>).verifiedYield;
    for (const rep of parsed.comparison.reports) {
      delete (rep as Partial<ShowdownResult["swarmReport"]>).verifiedYield;
    }
    const strippedResultRaw = JSON.stringify(parsed, null, 2) + "\n";
    files.set(resultPath, strippedResultRaw);

    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(files.get(manifestPath) ?? "{}") as {
      files: Array<{ name: string; sha256: string }>;
      vtph: Record<string, number>;
    };
    delete manifest.vtph.swarmVerifiedYield;
    delete manifest.vtph.baselineVerifiedYield;
    const resultEntry = manifest.files.find((f) => f.name === "result.json");
    expect(resultEntry).toBeDefined();
    resultEntry!.sha256 = sha256Hex(strippedResultRaw);
    files.set(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const outcome = await verifyLiveArtifacts(dir, fs);
    expect(outcome.findings).toEqual([]);
    expect(outcome.ok).toBe(true);
  }, 30000);

  it("edits manifest.vtph.swarmVerifiedYield to lie about the yield — caught by the copy-consistency check", async () => {
    const { fs, files, dir } = await freshRoundTrip(109, 4);
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(files.get(manifestPath) ?? "{}") as { vtph: { swarmVerifiedYield: number } };
    manifest.vtph.swarmVerifiedYield = manifest.vtph.swarmVerifiedYield + 1234;
    files.set(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const outcome = await verifyLiveArtifacts(dir, fs);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.some((f) => /swarmVerifiedYield/.test(f))).toBe(true);
  }, 30000);

  it("regenerates manifest.vtph.multiple to lie about the multiple — caught by a fresh compareVtph recomputation", async () => {
    const { fs, files, dir } = await freshRoundTrip(103, 4);
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(files.get(manifestPath) ?? "{}") as { vtph: { multiple: number } };
    manifest.vtph.multiple = manifest.vtph.multiple + 1000; // a lie, internally "consistent" on its own
    files.set(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const outcome = await verifyLiveArtifacts(dir, fs);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.some((f) => /vtph\.multiple/.test(f))).toBe(true);
  }, 30000);

  it("swaps report.md bytes — sha256 mismatch caught", async () => {
    const { fs, files, dir } = await freshRoundTrip(104, 4);
    const reportPath = join(dir, "report.md");
    files.set(reportPath, "# a completely different, tampered report\n");

    const outcome = await verifyLiveArtifacts(dir, fs);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.some((f) => /sha256 mismatch for report\.md/.test(f))).toBe(true);
  }, 30000);

  it("truncates audit.jsonl — record-count mismatch caught", async () => {
    const { fs, files, dir } = await freshRoundTrip(105, 6);
    const auditPath = join(dir, "audit.jsonl");
    const lines = (files.get(auditPath) ?? "").split("\n").filter((l) => l.length > 0);
    const truncated = lines.slice(0, Math.max(1, lines.length - 4));
    files.set(auditPath, truncated.join("\n") + "\n");

    const outcome = await verifyLiveArtifacts(dir, fs);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.some((f) => /audit\.jsonl has \d+ record\(s\)/.test(f))).toBe(true);
  }, 30000);

  it("relabels a modeled result as real inside result.json — mode guard caught", async () => {
    const { fs, files, dir } = await freshRoundTrip(106, 4);
    const resultPath = join(dir, "result.json");
    const parsed = JSON.parse(files.get(resultPath) ?? "{}") as ShowdownResult;
    (parsed as { mode: string }).mode = "modeled"; // pretend it was never actually a live run
    files.set(resultPath, JSON.stringify(parsed, null, 2) + "\n");

    const outcome = await verifyLiveArtifacts(dir, fs);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.some((f) => /result\.json mode is/.test(f))).toBe(true);
  }, 30000);

  it("collects every applicable finding, not just the first, on a multiply-tampered directory", async () => {
    const { fs, files, dir } = await freshRoundTrip(107, 4);
    const reportPath = join(dir, "report.md");
    const resultPath = join(dir, "result.json");
    files.set(reportPath, "# tampered\n");
    const parsed = JSON.parse(files.get(resultPath) ?? "{}") as ShowdownResult;
    parsed.baselineReport.totalUsd += 5;
    files.set(resultPath, JSON.stringify(parsed, null, 2) + "\n");

    const outcome = await verifyLiveArtifacts(dir, fs);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.length).toBeGreaterThanOrEqual(2);
    expect(outcome.findings.some((f) => /sha256 mismatch for report\.md/.test(f))).toBe(true);
    expect(outcome.findings.some((f) => /sha256 mismatch for result\.json/.test(f))).toBe(true);
  }, 30000);

  it("reports one finding per missing file when the directory doesn't exist", async () => {
    const { fs } = makeFakeFs();
    const outcome = await verifyLiveArtifacts("/virtual/nonexistent-dir", fs);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.length).toBe(4);
  });
});

// ===========================================================================
// Opt-in: the ACTUAL keyed live run. Never simulated, never relabeled — the
// injected runShowdownFn is NOT used here; this exercises the real default
// wiring end to end against a real provider. Skipped (with an honest
// message) whenever no real key is configured in this environment.
// ===========================================================================

const hasRealAnthropicKey =
  typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;

describe("runLiveShowdown — real keyed live run (opt-in)", () => {
  if (!hasRealAnthropicKey) {
    it.skip(
      "skipped: ANTHROPIC_API_KEY is not set in this environment — no real, keyed, billed live run was attempted.",
      () => {}
    );
  } else {
    it(
      "runs a genuine live showdown end-to-end against a real provider and verifies cleanly",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "showdown-live-real-"));
        try {
          const { manifest } = await runLiveShowdown({ seed: 1, taskCount: 2, outDir: dir }, {});
          expect(manifest.mode).toBe("real");
          expect(manifest.provider).toBe("anthropic");
          const outcome = await verifyLiveArtifacts(dir);
          expect(outcome.ok).toBe(true);
          expect(outcome.findings).toEqual([]);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      180000
    );
  }
});
