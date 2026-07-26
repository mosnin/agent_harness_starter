/* ------------------------------------------------------------------ *
 * dataset-command.test.ts
 *
 * REAL-VS-MOCK POLICY: this suite runs the whole flywheel through REAL
 * modules — a REAL `VerifiedTrajectoryCorpus` on a real temp dir, REAL
 * ed25519 signing (`CertificateAuthority`/`@noble/ed25519` via
 * `../../styx/certificate`), the REAL `exportDataset`/`readManifest`
 * (`../../dataset/exporter`), the REAL `auditDataset`/`readDatasetRecords`
 * (`../../dataset/audit`), and this team's own REAL
 * `probeLocalModel`/`planFineTune`/`runFineTune`
 * (`../../dataset/finetune`). The ONLY test double anywhere in this file is
 * a `SpawnPort` spy for the one "ran" fine-tune scenario — there is no real
 * local trainer to shell out to in CI, and `hades dataset finetune` is
 * documented as never run by CI (see `../dataset-command.ts`'s module docs).
 * `hades dataset stats` reads a small stub `deps.runFineTune` ONLY where a
 * test is exercising CLI flag-parsing/exit-code plumbing in isolation from
 * the (separately, exhaustively tested in `../../dataset/__tests__/
 * finetune.test.ts`) safety gate itself; every such stub is called out at
 * its use site.
 * ------------------------------------------------------------------ */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

import { CertificateAuthority, generatePrivateKeyHex, sha256Hex, canonicalize, type CertificatePayload } from "../../styx/certificate";
import { canonicalTrajectoryJson, type VerifiedTrajectory } from "../../skills/synthesize";
import type { GoalTrajectory, TaskTrajectory, ToolEvent } from "../../research/recorder";
import { VerifiedTrajectoryCorpus } from "../../dataset/corpus";
import { exportDataset, readManifest, type ExportSpec, type DatasetManifest } from "../../dataset/exporter";
import { auditDataset, readDatasetRecords } from "../../dataset/audit";
import { probeLocalModel, planFineTune, runFineTune as realRunFineTune, type FineTuneOutcome, type SpawnPort } from "../../dataset/finetune";

import { runDatasetCommand, datasetHelpLines, type DatasetCliDeps } from "../dataset-command";

// ===========================================================================
// Fixtures — mirrors ../../dataset/__tests__/exporter.test.ts's convention
// ===========================================================================

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}
const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(51)));

function tool(overrides: Partial<ToolEvent> = {}): ToolEvent {
  return { tool: "read_file", ok: true, summary: "Read the config file for this step.", at: 1_000, ...overrides };
}
function task(uniq: string, overrides: Partial<TaskTrajectory> = {}): TaskTrajectory {
  return {
    taskId: `task-${uniq}`,
    description: `Load configuration for ${uniq}`,
    capability: "filesystem",
    tools: [tool()],
    success: true,
    startedAt: 900,
    endedAt: 1_100,
    ...overrides,
  };
}
function goal(uniq: string, overrides: Partial<GoalTrajectory> = {}): GoalTrajectory {
  return {
    goalId: `goal-${uniq}`,
    objective: `Configure the deploy pipeline for ${uniq}`,
    model: "test-model",
    tasks: [task(uniq)],
    success: true,
    startedAt: 800,
    endedAt: 1_200,
    ...overrides,
  };
}
function payloadFor(trajectory: GoalTrajectory, overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex(`output-${trajectory.goalId}`),
    taskId: trajectory.tasks[0]?.taskId ?? "task-1",
    verifierTier: "T2-genrm",
    ensembleScore: 0.95,
    pCorrect: 0.97,
    epsilon: 0.05,
    traceSha256: sha256Hex(canonicalTrajectoryJson(trajectory)),
    verifierVersions: ["exec-oracle@1.0.0"],
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}
async function verifiedFixture(uniq: string, overrides: Partial<GoalTrajectory> = {}): Promise<VerifiedTrajectory> {
  const trajectory = goal(uniq, overrides);
  const payload = payloadFor(trajectory);
  const certificate = await ca.issue(payload);
  return { trajectory, certificate };
}

function flipSignatureByte(sig: string): string {
  const byte = parseInt(sig.slice(0, 2), 16);
  return (byte ^ 0xff).toString(16).padStart(2, "0") + sig.slice(2);
}

// ===========================================================================
// Real-deps wiring
// ===========================================================================

let corpusRoot: string;
let datasetRoot: string;
let importDir: string;
let corpus: VerifiedTrajectoryCorpus;

beforeEach(() => {
  corpusRoot = mkdtempSync(join(tmpdir(), "hades-dscmd-corpus-"));
  datasetRoot = mkdtempSync(join(tmpdir(), "hades-dscmd-dataset-"));
  importDir = mkdtempSync(join(tmpdir(), "hades-dscmd-import-"));
  corpus = new VerifiedTrajectoryCorpus({ root: corpusRoot });
});

afterEach(() => {
  rmSync(corpusRoot, { recursive: true, force: true });
  rmSync(datasetRoot, { recursive: true, force: true });
  rmSync(importDir, { recursive: true, force: true });
});

function throwingRunFineTune(): DatasetCliDeps["runFineTune"] {
  return async () => {
    throw new Error("deps.runFineTune should not have been called by this test");
  };
}

function buildDeps(overrides: Partial<DatasetCliDeps> = {}): DatasetCliDeps {
  return {
    root: datasetRoot,
    corpus: () => corpus,
    exportDataset: (spec, outDir, overwrite) => exportDataset(corpus, spec, { outDir, overwrite }),
    auditDataset: (dir, opts) => auditDataset(dir, { corpus: opts?.withCorpus ? corpus : undefined }),
    readManifest: (dir) => readManifest(dir),
    readRecords: (dir) => readDatasetRecords(dir),
    probeModel: (path) => probeLocalModel({ path }),
    runFineTune: throwingRunFineTune(),
    ...overrides,
  };
}

/** Admits `n` distinct REAL, ed25519-signed verified trajectories directly
 *  into the corpus (bypassing the CLI's `import` subcommand — used to seed
 *  data for `export`/`stats`/`verify` tests). */
async function seedCorpus(n: number, prefix = "seed"): Promise<void> {
  for (let i = 0; i < n; i++) {
    const vt = await verifiedFixture(`${prefix}${i}`);
    const admission = await corpus.admit(vt, { source: "run" });
    if (!admission.ok) throw new Error(`seedCorpus: unexpected rejection: ${admission.rejection.code} ${admission.rejection.detail}`);
  }
}

function jsonOf(result: { lines: string[] }): Record<string, unknown> {
  return JSON.parse(result.lines.join("\n")) as Record<string, unknown>;
}

// ===========================================================================
// help / router
// ===========================================================================

describe("help + router", () => {
  it("hades dataset help returns exit 0 and never touches the deps seam", async () => {
    const deps = buildDeps({
      corpus: () => {
        throw new Error("help must never open the corpus");
      },
      exportDataset: () => {
        throw new Error("help must never export");
      },
    });
    const r1 = await runDatasetCommand(["help"], deps);
    const r2 = await runDatasetCommand([], deps);
    const r3 = await runDatasetCommand(["--help"], deps);
    const r4 = await runDatasetCommand(["-h"], deps);
    for (const r of [r1, r2, r3, r4]) {
      expect(r.code).toBe(0);
      expect(r.lines.join("\n")).toContain("finetune");
    }
  });

  it("help documents that finetune is off by default, needs a local model, is never run by tests/CI, and never synthesizes a metric", () => {
    const text = datasetHelpLines().join("\n");
    expect(text).toMatch(/OFF BY DEFAULT/i);
    expect(text).toMatch(/--enable/);
    expect(text).toMatch(/local model/i);
    expect(text).toMatch(/never\s+run\s+by\s+this\s+repo's\s+own\s+tests\s+or\s+CI/i);
    expect(text).toMatch(/no\s+loss,\s+accuracy,\s+or\s+perplexity\s+metric\s+is\s+ever\s+synthesized/i);
  });

  it("rejects an unknown subcommand with exit 1 and shows help", async () => {
    const r = await runDatasetCommand(["frobnicate"], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain('unknown subcommand "frobnicate"');
    expect(r.lines.join("\n")).toContain("Usage: hades dataset");
  });

  it("never calls console.* or process.exit, and only reads fs via the documented readFile/fileExists seam", () => {
    const src = readFileSync(new URL("../dataset-command.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/console\.(log|error|warn|info)/);
    expect(src).not.toMatch(/process\.exit\(/);
    // The only two node:fs functions this module may reference directly are
    // the optional deps.readFile/deps.fileExists fallbacks.
    const fsImportLine = src.match(/import\s*\{([^}]*)\}\s*from\s*"node:fs"/);
    expect(fsImportLine).not.toBeNull();
    const names = (fsImportLine as RegExpMatchArray)[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    expect(new Set(names)).toEqual(new Set(["existsSync", "readFileSync"]));
  });

  it("actually never calls console.* during a full run (behavioral spy, not just static)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await seedCorpus(2);
      const deps = buildDeps();
      await runDatasetCommand(["export", "--out", join(datasetRoot, "out1")], deps);
      await runDatasetCommand(["stats", "--dir", join(datasetRoot, "out1")], deps);
      await runDatasetCommand(["verify", "--dir", join(datasetRoot, "out1")], deps);
      await runDatasetCommand(["help"], deps);
      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

// ===========================================================================
// export — flags, validation, human + json
// ===========================================================================

describe("export", () => {
  it("requires --out", async () => {
    const r = await runDatasetCommand(["export"], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/--out DIR is required/);
  });

  it("rejects an unknown flag", async () => {
    const r = await runDatasetCommand(["export", "--out", join(datasetRoot, "o"), "--bogus"], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/unknown flag: --bogus/);
  });

  it("rejects an unexpected positional argument", async () => {
    const r = await runDatasetCommand(["export", "extra", "--out", join(datasetRoot, "o")], buildDeps());
    expect(r.code).toBe(1);
  });

  it("rejects an invalid --schema", async () => {
    const r = await runDatasetCommand(["export", "--out", join(datasetRoot, "o"), "--schema", "not-a-schema"], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/--schema must be one of/);
  });

  it("rejects an invalid --compression", async () => {
    const r = await runDatasetCommand(["export", "--out", join(datasetRoot, "o"), "--compression", "brotli"], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/--compression must be "gzip" or "none"/);
  });

  it("rejects a non-numeric --shard-size", async () => {
    const r = await runDatasetCommand(["export", "--out", join(datasetRoot, "o"), "--shard-size", "lots"], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/--shard-size must be/);
  });

  it("rejects an out-of-range --holdout fraction", async () => {
    const r = await runDatasetCommand(["export", "--out", join(datasetRoot, "o"), "--holdout", "1.5"], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/--holdout must be/);
  });

  it("rejects an out-of-range --min-pcorrect fraction", async () => {
    const r = await runDatasetCommand(["export", "--out", join(datasetRoot, "o"), "--min-pcorrect", "-0.1"], buildDeps());
    expect(r.code).toBe(1);
  });

  it("rejects --since > --until", async () => {
    const r = await runDatasetCommand(
      ["export", "--out", join(datasetRoot, "o"), "--since", "500", "--until", "100"],
      buildDeps(),
    );
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/--since must be <= --until/);
  });

  it("a flag missing its value is a usage error, never a silent drop", async () => {
    const r = await runDatasetCommand(["export", "--out"], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/--out requires a value/);
  });

  it("a duplicated valued flag uses the LAST occurrence", async () => {
    await seedCorpus(2);
    const outA = join(datasetRoot, "dupA");
    const outB = join(datasetRoot, "dupB");
    const r = await runDatasetCommand(["export", "--out", outA, "--out", outB, "--json"], buildDeps());
    expect(r.code).toBe(0);
    const json = jsonOf(r);
    expect(json.outDir).toBe(outB);
    expect(existsSync(outB)).toBe(true);
    expect(existsSync(outA)).toBe(false);
  });

  it("exports real admitted trajectories: human output and --json output both field-check", async () => {
    await seedCorpus(3);
    const out = join(datasetRoot, "human");
    const rHuman = await runDatasetCommand(["export", "--out", out], buildDeps());
    expect(rHuman.code).toBe(0);
    expect(rHuman.lines.join("\n")).toContain("Dataset export");
    expect(rHuman.lines.join("\n")).toContain("digest");

    const out2 = join(datasetRoot, "json");
    const rJson = await runDatasetCommand(["export", "--out", out2, "--json"], buildDeps());
    expect(rJson.code).toBe(0);
    const json = jsonOf(rJson);
    expect(json.outDir).toBe(out2);
    expect(typeof json.bytesWritten).toBe("number");
    const manifest = json.manifest as DatasetManifest;
    expect(manifest.counts.records).toBe(3);
    expect(existsSync(join(out2, "manifest.json"))).toBe(true);
  });

  it("--include-mock switches the filter to mock-tainted instead of real", async () => {
    const vtReal = await verifiedFixture("mixreal");
    const vtMockish = await verifiedFixture("mixmock", { objective: "[mock] synthetic fixture objective" });
    const a1 = await corpus.admit(vtReal, { source: "run" });
    const a2 = await corpus.admit(vtMockish, { source: "run" });
    expect(a1.ok && a2.ok).toBe(true);

    const outReal = join(datasetRoot, "real-only");
    const rReal = await runDatasetCommand(["export", "--out", outReal, "--json"], buildDeps());
    expect((jsonOf(rReal).manifest as DatasetManifest).counts.records).toBe(1);

    const outMock = join(datasetRoot, "mock-only");
    const rMock = await runDatasetCommand(["export", "--out", outMock, "--include-mock", "--json"], buildDeps());
    expect((jsonOf(rMock).manifest as DatasetManifest).counts.records).toBe(1);
  });

  it("--overwrite is required to replace a non-empty existing out dir; export refusal is a usage-level failure (exit 1)", async () => {
    await seedCorpus(1);
    const out = join(datasetRoot, "again");
    const r1 = await runDatasetCommand(["export", "--out", out], buildDeps());
    expect(r1.code).toBe(0);
    const r2 = await runDatasetCommand(["export", "--out", out], buildDeps());
    expect(r2.code).toBe(1);
    expect(r2.lines.join("\n")).toMatch(/export refused/);
    const r3 = await runDatasetCommand(["export", "--out", out, "--overwrite"], buildDeps());
    expect(r3.code).toBe(0);
  });
});

// ===========================================================================
// import
// ===========================================================================

describe("import", () => {
  it("requires a positional file argument", async () => {
    const r = await runDatasetCommand(["import"], buildDeps());
    expect(r.code).toBe(1);
  });

  it("rejects more than one positional argument", async () => {
    const r = await runDatasetCommand(["import", "a.json", "b.json"], buildDeps());
    expect(r.code).toBe(1);
  });

  it("rejects an invalid --source", async () => {
    const file = join(importDir, "one.json");
    writeFileSync(file, JSON.stringify(await verifiedFixture("srcbad")));
    const r = await runDatasetCommand(["import", file, "--source", "carrier-pigeon"], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/--source must be one of/);
  });

  it("reports a clean error for a missing file", async () => {
    const r = await runDatasetCommand(["import", join(importDir, "missing.json")], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/file not found/);
  });

  it("reports a clean error for malformed JSON", async () => {
    const file = join(importDir, "bad.json");
    writeFileSync(file, "{not json");
    const r = await runDatasetCommand(["import", file], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/not valid JSON/);
  });

  it("rejects an empty array with a clean error", async () => {
    const file = join(importDir, "empty.json");
    writeFileSync(file, "[]");
    const r = await runDatasetCommand(["import", file], buildDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/nothing to import/);
  });

  it("admits a REAL single VerifiedTrajectory object (non-array form) using the real corpus, with the requested --source", async () => {
    const vt = await verifiedFixture("single");
    const file = join(importDir, "single.json");
    writeFileSync(file, JSON.stringify(vt));
    const r = await runDatasetCommand(["import", file, "--source", "bench", "--json"], buildDeps());
    expect(r.code).toBe(0);
    const json = jsonOf(r);
    expect(json.accepted).toBe(1);
    expect(json.rejected).toBe(0);
    const trajSha = sha256Hex(canonicalTrajectoryJson(vt.trajectory));
    const entry = corpus.get(trajSha);
    expect(entry).toBeDefined();
    expect(entry?.provenance.source).toBe("bench");
  });

  it("admits a REAL array of VerifiedTrajectory objects, reporting per-item accept/reject codes", async () => {
    const good = await verifiedFixture("arr-good");
    const bad = await verifiedFixture("arr-bad");
    bad.certificate = { ...bad.certificate, signature: flipSignatureByte(bad.certificate.signature) };
    const file = join(importDir, "arr.json");
    writeFileSync(file, JSON.stringify([good, bad]));
    const r = await runDatasetCommand(["import", file, "--json"], buildDeps());
    expect(r.code).toBe(1); // any rejected import -> non-zero
    const json = jsonOf(r);
    expect(json.accepted).toBe(1);
    expect(json.rejected).toBe(1);
    const results = json.results as { ok: boolean; code?: string }[];
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].code).toBe("bad-signature");
  });

  it("rejects a malformed item (not shaped like {trajectory, certificate}) without ever calling corpus.admit", async () => {
    const file = join(importDir, "malformed.json");
    writeFileSync(file, JSON.stringify([{ hello: "world" }]));
    const admitSpy = vi.fn(async () => {
      throw new Error("admit should not be reached for a structurally malformed item");
    });
    const deps = buildDeps({ corpus: () => ({ ...corpus, admit: admitSpy }) as unknown as VerifiedTrajectoryCorpus });
    const r = await runDatasetCommand(["import", file, "--json"], deps);
    expect(r.code).toBe(1);
    const json = jsonOf(r);
    expect((json.results as { code?: string }[])[0].code).toBe("malformed");
    expect(admitSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// stats
// ===========================================================================

describe("stats", () => {
  it("defaults --dir to deps.root", async () => {
    await seedCorpus(2);
    const rootDeps = buildDeps();
    const exported = await runDatasetCommand(["export", "--out", datasetRoot, "--overwrite", "--json"], rootDeps);
    expect(exported.code).toBe(0);
    const r = await runDatasetCommand(["stats"], rootDeps);
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("Dataset statistics");
  });

  it("reports an honest error when the directory has no readable dataset", async () => {
    const r = await runDatasetCommand(["stats", "--dir", join(datasetRoot, "nope")], buildDeps());
    expect(r.code).toBe(1);
  });

  it("reports counts that match the manifest EXACTLY (checkpoint requirement)", async () => {
    await seedCorpus(5);
    const out = join(datasetRoot, "statsdir");
    await runDatasetCommand(["export", "--out", out], buildDeps());
    const manifest = readManifest(out);

    const r = await runDatasetCommand(["stats", "--dir", out, "--json"], buildDeps());
    expect(r.code).toBe(0);
    const json = jsonOf(r);
    const stats = json.stats as { records: number; train: number; holdout: number };
    expect(stats.records).toBe(manifest.counts.records);
    expect(stats.train).toBe(manifest.counts.train);
    expect(stats.holdout).toBe(manifest.counts.holdout);
    expect(json.manifestDigest).toBe(manifest.digest);
  });

  it("rejects an unknown flag and an unexpected positional", async () => {
    const r1 = await runDatasetCommand(["stats", "--nope"], buildDeps());
    expect(r1.code).toBe(1);
    const r2 = await runDatasetCommand(["stats", "extra-arg"], buildDeps());
    expect(r2.code).toBe(1);
  });
});

// ===========================================================================
// verify
// ===========================================================================

describe("verify", () => {
  it("exits 0 on a clean, freshly exported dataset", async () => {
    await seedCorpus(3);
    const out = join(datasetRoot, "clean");
    await runDatasetCommand(["export", "--out", out], buildDeps());
    const r = await runDatasetCommand(["verify", "--dir", out], buildDeps());
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("result:               OK");
  });

  it("exits 2 with the fatal finding rendered on a hand-tampered shard", async () => {
    await seedCorpus(2);
    const out = join(datasetRoot, "tampered");
    const exportResult = await runDatasetCommand(["export", "--out", out, "--json"], buildDeps());
    const manifest = jsonOf(exportResult).manifest as DatasetManifest;
    const shardFile = manifest.shards[0].file;
    // Hand-corrupt the shard's on-disk bytes directly — no re-gzip, no
    // manifest edit: a real bit-for-bit tamper of the published dataset.
    writeFileSync(join(out, shardFile), Buffer.from("not a valid gzip member at all"));

    const r = await runDatasetCommand(["verify", "--dir", out, "--json"], buildDeps());
    expect(r.code).toBe(2);
    const json = jsonOf(r);
    const report = json.report as { ok: boolean; findings: { severity: string; code: string }[] };
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.severity === "fatal")).toBe(true);

    const rHuman = await runDatasetCommand(["verify", "--dir", out], buildDeps());
    expect(rHuman.code).toBe(2);
    expect(rHuman.lines.join("\n")).toMatch(/FATAL/);
    expect(rHuman.lines.join("\n")).toContain("EXIT CODE: 2");
  });

  it("exits 3 when --with-corpus finds the referenced corpus's own chain broken (distinct from an audit FAILURE)", async () => {
    await seedCorpus(2);
    const out = join(datasetRoot, "corpusbroken");
    await runDatasetCommand(["export", "--out", out], buildDeps());

    // Hand-corrupt the corpus's own on-disk hash chain (not the dataset).
    const corpusFile = join(corpusRoot, "corpus.jsonl");
    const lines = readFileSync(corpusFile, "utf8").split("\n").filter((l) => l.length > 0);
    const entry = JSON.parse(lines[1]) as { hash: string };
    entry.hash = "0".repeat(64);
    lines[1] = JSON.stringify(entry);
    writeFileSync(corpusFile, lines.join("\n") + "\n");

    const r = await runDatasetCommand(["verify", "--dir", out, "--with-corpus", "--json"], buildDeps());
    expect(r.code).toBe(3);
    const json = jsonOf(r);
    const chain = json.chain as { ok: boolean };
    expect(chain.ok).toBe(false);

    const rHuman = await runDatasetCommand(["verify", "--dir", out, "--with-corpus"], buildDeps());
    expect(rHuman.code).toBe(3);
    expect(rHuman.lines.join("\n")).toMatch(/corpus chain verified : false/);
  });

  it("rejects an unknown flag", async () => {
    const r = await runDatasetCommand(["verify", "--bogus"], buildDeps());
    expect(r.code).toBe(1);
  });
});

// ===========================================================================
// finetune — CLI flag/exit-code plumbing (the safety gate itself is proven
// exhaustively in ../../dataset/__tests__/finetune.test.ts; here we only
// prove this command module parses flags correctly and maps outcomes to the
// documented exit codes, using a small deterministic stub deps.runFineTune).
// ===========================================================================

describe("finetune (CLI plumbing over a stub deps.runFineTune)", () => {
  function stub(outcome: FineTuneOutcome, spy?: (req: unknown) => void): DatasetCliDeps["runFineTune"] {
    return async (req) => {
      spy?.(req);
      return outcome;
    };
  }

  it("without --enable, defaults enabled=false and maps flag-not-set to exit 0", async () => {
    let captured: { enabled: boolean } | undefined;
    const outcome: FineTuneOutcome = { status: "abstained", reason: "flag-not-set", detail: "off by default" };
    const deps = buildDeps({ runFineTune: stub(outcome, (r) => (captured = r as { enabled: boolean })) });
    const r = await runDatasetCommand(["finetune", "--dir", datasetRoot], deps);
    expect(r.code).toBe(0);
    expect(captured?.enabled).toBe(false);
    expect(r.lines.join("\n")).toContain("ABSTAINED");
  });

  it("--enable without a model maps no-model to exit 1", async () => {
    let captured: { enabled: boolean; modelPath?: string } | undefined;
    const outcome: FineTuneOutcome = { status: "abstained", reason: "no-model", detail: "no model" };
    const deps = buildDeps({ runFineTune: stub(outcome, (r) => (captured = r as typeof captured)) });
    const r = await runDatasetCommand(["finetune", "--enable", "--model", "/no/such/model.gguf"], deps);
    expect(r.code).toBe(1);
    expect(captured?.enabled).toBe(true);
    expect(captured?.modelPath).toBe("/no/such/model.gguf");
  });

  it("--dry-run maps 'planned' to exit 0 and threads dryRun through to deps.runFineTune", async () => {
    let captured: { dryRun: boolean } | undefined;
    const plan = planFineTune(
      { ...readManifestFixture() },
      { present: true, path: "/m.gguf", format: "gguf", reason: "x" },
      datasetRoot,
    );
    const outcome: FineTuneOutcome = { status: "planned", plan };
    const deps = buildDeps({ runFineTune: stub(outcome, (r) => (captured = r as typeof captured)) });
    const r = await runDatasetCommand(["finetune", "--enable", "--dry-run"], deps);
    expect(r.code).toBe(0);
    expect(captured?.dryRun).toBe(true);
    expect(r.lines.join("\n")).toContain("PLANNED");
  });

  it("a 'ran' outcome with exitCode 0 maps to CLI exit 0", async () => {
    const plan = planFineTune(readManifestFixture(), { present: true, path: "/m.gguf", format: "gguf", reason: "x" }, datasetRoot);
    const outcome: FineTuneOutcome = { status: "ran", plan, exitCode: 0, durationMs: 10, stdoutTail: ["ok"], stderrTail: [], checkpointDir: plan.outputDir };
    const deps = buildDeps({ runFineTune: stub(outcome) });
    const r = await runDatasetCommand(["finetune", "--enable", "--json"], deps);
    expect(r.code).toBe(0);
    const json = jsonOf(r);
    expect((json.outcome as FineTuneOutcome).status).toBe("ran");
  });

  it("a 'ran' outcome with a non-zero exitCode maps to CLI exit 1", async () => {
    const plan = planFineTune(readManifestFixture(), { present: true, path: "/m.gguf", format: "gguf", reason: "x" }, datasetRoot);
    const outcome: FineTuneOutcome = { status: "ran", plan, exitCode: 7, durationMs: 10, stdoutTail: [], stderrTail: ["fail"], checkpointDir: null };
    const deps = buildDeps({ runFineTune: stub(outcome) });
    const r = await runDatasetCommand(["finetune", "--enable"], deps);
    expect(r.code).toBe(1);
  });

  it("rejects a non-integer --epochs and an out-of-range (<1) --epochs", async () => {
    const r1 = await runDatasetCommand(["finetune", "--epochs", "abc"], buildDeps());
    expect(r1.code).toBe(1);
    const r2 = await runDatasetCommand(["finetune", "--epochs", "0"], buildDeps());
    expect(r2.code).toBe(1);
  });

  it("rejects an unknown flag and an unexpected positional", async () => {
    const r1 = await runDatasetCommand(["finetune", "--nope"], buildDeps());
    expect(r1.code).toBe(1);
    const r2 = await runDatasetCommand(["finetune", "extra"], buildDeps());
    expect(r2.code).toBe(1);
  });

  it("threads --epochs into opts.epochs", async () => {
    let captured: { opts: { epochs?: number } } | undefined;
    const outcome: FineTuneOutcome = { status: "abstained", reason: "flag-not-set", detail: "x" };
    const deps = buildDeps({ runFineTune: stub(outcome, (r) => (captured = r as typeof captured)) });
    await runDatasetCommand(["finetune", "--epochs", "9"], deps);
    expect(captured?.opts.epochs).toBe(9);
  });
});

function readManifestFixture(): DatasetManifest {
  return {
    formatVersion: 1,
    createdAt: 1,
    generator: { name: "hades", phase: 19 },
    specHash: "spec",
    spec: { schema: "sft-prompt-completion", filter: { realityClass: "real" }, encode: { schema: "sft-prompt-completion" }, shardSize: 1000, compression: "gzip", holdoutFraction: 0.1 },
    corpus: { genesis: "g", head: "h", entriesScanned: 1, verifiedOnly: true },
    shards: [],
    counts: { records: 1, train: 1, holdout: 0, skipped: 0, redactions: 0, mockTaintedExcluded: 0, duplicatesDropped: 0 },
    skips: [],
    digest: "d",
  };
}

// ===========================================================================
// finetune — a real, end-to-end integration slice (no CLI stub): real
// probeLocalModel over a real gguf fixture, a real exported+audited dataset,
// this team's own real planFineTune, and a spy SpawnPort — proving the two
// user-facing halves this team owns actually connect to each other.
// ===========================================================================

describe("finetune (real end-to-end integration through the actual safety gate)", () => {
  it("wires export -> audit -> probe -> plan -> runFineTune for real, and only spawns on the fully-enabled path", async () => {
    await seedCorpus(4);
    const out = join(datasetRoot, "realft");
    await runDatasetCommand(["export", "--out", out], buildDeps());

    const modelPath = join(importDir, "real-model.gguf");
    writeFileSync(modelPath, Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.alloc(32)]));

    const spawnCalls: string[][] = [];
    const spawn: SpawnPort = {
      run: async (argv) => {
        spawnCalls.push(argv);
        return { exitCode: 0, stdout: "training complete\n", stderr: "", timedOut: false };
      },
    };

    const realRunFineTuneDep: DatasetCliDeps["runFineTune"] = async (req) => {
      const manifest = readManifest(req.datasetDir);
      const model = probeLocalModel({ path: req.modelPath });
      const audit = await auditDataset(req.datasetDir);
      const plan = planFineTune(manifest, model, req.datasetDir, req.opts);
      return realRunFineTune({ enabled: req.enabled, dryRun: req.dryRun, plan, model, audit, spawn: req.enabled ? spawn : undefined });
    };

    // Without --enable: real safety gate abstains, and the spy proves NOTHING spawned.
    const abstained = await runDatasetCommand(
      ["finetune", "--dir", out, "--model", modelPath],
      buildDeps({ runFineTune: realRunFineTuneDep }),
    );
    expect(abstained.code).toBe(0);
    expect(abstained.lines.join("\n")).toContain("flag-not-set");
    expect(spawnCalls).toHaveLength(0);

    // Fully enabled: real model present, real clean audit, real train records -> it actually runs.
    const ran = await runDatasetCommand(
      ["finetune", "--dir", out, "--model", modelPath, "--enable", "--json"],
      buildDeps({ runFineTune: realRunFineTuneDep }),
    );
    expect(ran.code).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toContain(out);
    const outcome = jsonOf(ran).outcome as FineTuneOutcome;
    expect(outcome.status).toBe("ran");
  });
});

// ===========================================================================
// End-to-end checkpoint (d): the exclusion + reproducibility guarantees
// ===========================================================================

describe("checkpoint: exclusion + reproducibility, through real modules only", () => {
  it("an UNVERIFIED trajectory (bad signature) is rejected on import, and a subsequent export provably does not contain it", async () => {
    const good = await verifiedFixture("excl-good");
    const badSig = await verifiedFixture("excl-badsig");
    badSig.certificate = { ...badSig.certificate, signature: flipSignatureByte(badSig.certificate.signature) };
    const badTrajSha = sha256Hex(canonicalTrajectoryJson(badSig.trajectory));

    const file = join(importDir, "excl.json");
    writeFileSync(file, JSON.stringify([good, badSig]));
    const importResult = await runDatasetCommand(["import", file, "--json"], buildDeps());
    expect(importResult.code).toBe(1);
    const importJson = jsonOf(importResult);
    expect(importJson.rejected).toBe(1);
    const results = importJson.results as { ok: boolean; code?: string }[];
    expect(results.some((r) => !r.ok && r.code === "bad-signature")).toBe(true);
    expect(corpus.get(badTrajSha)).toBeUndefined();

    const out = join(datasetRoot, "exclusion-check");
    const exportResult = await runDatasetCommand(["export", "--out", out, "--json"], buildDeps());
    expect(exportResult.code).toBe(0);
    const manifest = jsonOf(exportResult).manifest as DatasetManifest;
    expect(manifest.counts.records).toBe(1); // only the good one

    // Byte-level proof: read every shard and confirm the bad trajectory's
    // hash appears nowhere in the exported bytes.
    const allShardText = manifest.shards
      .map((s) => {
        const raw = readFileSync(join(out, s.file));
        return s.file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
      })
      .join("\n");
    expect(allShardText).not.toContain(badTrajSha);
  });

  it("a trajectory mutated AFTER signing is rejected with hash-mismatch, and never reaches an export", async () => {
    const vt = await verifiedFixture("excl-mutated");
    const mutatedTrajSha = sha256Hex(canonicalTrajectoryJson(vt.trajectory));
    // Sign, THEN mutate the trajectory the certificate claims to attest —
    // the certificate's traceSha256 no longer matches.
    const mutated: VerifiedTrajectory = { trajectory: { ...vt.trajectory, objective: "a different objective entirely" }, certificate: vt.certificate };

    const file = join(importDir, "mutated.json");
    writeFileSync(file, JSON.stringify(mutated));
    const r = await runDatasetCommand(["import", file, "--json"], buildDeps());
    expect(r.code).toBe(1);
    const json = jsonOf(r);
    expect((json.results as { code?: string }[])[0].code).toBe("hash-mismatch");
    expect(corpus.get(mutatedTrajSha)).toBeUndefined();
    expect(corpus.size()).toBe(0);
  });

  it("two exports of the same corpus into different dirs produce an IDENTICAL manifest digest (asserted via the CLI's own JSON output)", async () => {
    await seedCorpus(4, "repro");
    const deps = buildDeps();
    const r1 = await runDatasetCommand(["export", "--out", join(datasetRoot, "repro-a"), "--json"], deps);
    const r2 = await runDatasetCommand(["export", "--out", join(datasetRoot, "repro-b"), "--json"], deps);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    const d1 = (jsonOf(r1).manifest as DatasetManifest).digest;
    const d2 = (jsonOf(r2).manifest as DatasetManifest).digest;
    expect(d1).toBeTruthy();
    expect(d1).toBe(d2);
  });
});
