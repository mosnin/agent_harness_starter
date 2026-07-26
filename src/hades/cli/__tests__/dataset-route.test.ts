/**
 * `hades dataset` router integration — the central wiring that makes this
 * cycle's verified-trajectory data flywheel (admit -> encode -> export ->
 * audit -> optional local fine-tune) actually REACHABLE from the terminal.
 *
 * REAL-VS-MOCK POLICY: everything here is real. Real ed25519 signing via the
 * real `CertificateAuthority`, the real `VerifiedTrajectoryCorpus` over real
 * temp directories, the real gzip exporter, the real independent auditor, and
 * — for the spawn port — a real child process (`node -e ...`). Nothing in
 * this file mocks the corpus, the crypto, the filesystem, or the engine. The
 * one thing deliberately NOT exercised is a real trainer binary: this repo
 * ships none, and `runFineTune` abstaining with `"no-trainer"` is the honest
 * outcome that must be asserted rather than papered over.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { HadesCli, HADES_SUBCOMMANDS } from "../cli";
import { defaultDatasetCliDeps, nodeSpawnPort } from "../dataset-deps";
import { VerifiedTrajectoryCorpus } from "../../dataset/corpus";
import { CertificateAuthority, generatePrivateKeyHex, sha256Hex } from "../../styx/certificate";
import { canonicalTrajectoryJson, type VerifiedTrajectory } from "../../skills/synthesize";
import type { GoalTrajectory } from "../../research/recorder";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hades-dataset-route-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ca = new CertificateAuthority(generatePrivateKeyHex((n: number) => new Uint8Array(n).fill(23)));

function goal(n: number, objective = `Configure deploy pipeline ${n}`): GoalTrajectory {
  return {
    goalId: `goal-${n}`,
    objective,
    model: "test-model",
    tasks: [
      {
        taskId: `task-${n}`,
        description: `Load configuration ${n}`,
        capability: "filesystem",
        tools: [{ tool: "read_file", ok: true, summary: `Read config ${n}.`, at: 1_000 + n }],
        success: true,
        startedAt: 900,
        endedAt: 1_100,
      },
    ],
    success: true,
    startedAt: 800,
    endedAt: 1_200,
  };
}

async function verified(n: number, objective?: string): Promise<VerifiedTrajectory> {
  const trajectory = goal(n, objective);
  const certificate = await ca.issue({
    outputSha256: sha256Hex(`delivered output ${n}`),
    taskId: `task-${n}`,
    verifierTier: "T2-genrm",
    ensembleScore: 0.95,
    pCorrect: 0.99,
    epsilon: 0.02,
    traceSha256: sha256Hex(canonicalTrajectoryJson(trajectory)),
    verifierVersions: ["exec-oracle@1.0.0"],
    issuedAt: 1_700_000_000_000 + n,
  });
  return { trajectory, certificate };
}

function cliFor(dataDir: string): HadesCli {
  return new HadesCli({ dataset: () => defaultDatasetCliDeps({ dataDir }) });
}

function shardText(outDir: string): string {
  return readdirSync(outDir)
    .filter((f) => f.endsWith(".jsonl.gz"))
    .map((f) => gunzipSync(readFileSync(join(outDir, f))).toString("utf8"))
    .join("\n");
}

describe("hades dataset — routing", () => {
  it("is a declared subcommand, listed in help, and reachable", async () => {
    expect(HADES_SUBCOMMANDS).toContain("dataset");

    const cli = cliFor(join(dir, "data"));
    const help = await cli.run(["help"]);
    expect(help.code).toBe(0);
    expect(help.lines.join("\n")).toContain("dataset <sub>");

    const res = await cli.run(["dataset", "help"]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Usage: hades dataset <command>");
  });

  it("an unknown dataset subcommand fails with usage, not a crash", async () => {
    const res = await cliFor(join(dir, "data")).run(["dataset", "nope"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain('unknown subcommand "nope"');
  });

  it("builds the dataset deps LAZILY — `hades help` never constructs them", async () => {
    let built = 0;
    const cli = new HadesCli({
      dataset: () => {
        built += 1;
        return defaultDatasetCliDeps({ dataDir: join(dir, "data") });
      },
    });

    await cli.run(["help"]);
    await cli.run(["version"]);
    expect(built).toBe(0);

    await cli.run(["dataset", "help"]);
    expect(built).toBe(1);
  });

  it("caches the deps across subcommands so one process shares ONE corpus", async () => {
    let built = 0;
    const cli = new HadesCli({
      dataset: () => {
        built += 1;
        return defaultDatasetCliDeps({ dataDir: join(dir, "data") });
      },
    });

    await cli.run(["dataset", "stats", "--dir", join(dir, "nope")]);
    await cli.run(["dataset", "help"]);
    await cli.run(["dataset", "stats", "--dir", join(dir, "nope")]);
    expect(built).toBe(1);
  });

  it("never opens (or locks) the corpus for a read-only invocation", async () => {
    const dataDir = join(dir, "data");
    const cli = cliFor(dataDir);
    await cli.run(["dataset", "help"]);
    await cli.run(["help"]);
    expect(existsSync(join(dataDir, "dataset", "corpus"))).toBe(false);
  });
});

describe("hades dataset — the real end-to-end flywheel through the router", () => {
  it("imports only VERIFIED trajectories, then exports/verifies them reproducibly", async () => {
    const dataDir = join(dir, "data");
    const cli = cliFor(dataDir);

    // Two genuinely signed trajectories, plus one whose trajectory was
    // mutated AFTER signing (the certificate no longer binds it).
    const a = await verified(1);
    const b = await verified(2);
    const tamperedObjective = "TAMPERED objective that was never verified";
    const t = await verified(3);
    const tampered: VerifiedTrajectory = {
      trajectory: { ...t.trajectory, objective: tamperedObjective },
      certificate: t.certificate,
    };

    const file = join(dir, "import.json");
    writeFileSync(file, JSON.stringify([a, tampered, b]), "utf8");

    const imported = await cli.run(["dataset", "import", file, "--source", "import", "--json"]);
    // Any rejected item is a non-zero exit — the CI contract.
    expect(imported.code).toBe(1);
    const report = JSON.parse(imported.lines.join("\n")) as {
      accepted: number;
      rejected: number;
      results: { ok: boolean; code?: string }[];
    };
    expect(report.accepted).toBe(2);
    expect(report.rejected).toBe(1);
    expect(report.results[1].ok).toBe(false);
    expect(report.results[1].code).toBe("hash-mismatch");

    // The corpus really landed under the shared data-dir convention.
    expect(existsSync(join(dataDir, "dataset", "corpus", "corpus.jsonl"))).toBe(true);

    const outDir = join(dir, "out");
    const exported = await cli.run(["dataset", "export", "--out", outDir, "--compression", "gzip"]);
    expect(exported.code).toBe(0);
    expect(exported.lines.join("\n")).toContain("records        : 2 ");

    // The unverified trajectory is provably absent from the exported bytes.
    const text = shardText(outDir);
    expect(text).toContain("Configure deploy pipeline 1");
    expect(text).not.toContain(tamperedObjective);

    // The independent audit, including the corpus cross-check, is clean.
    const verify = await cli.run(["dataset", "verify", "--dir", outDir, "--with-corpus"]);
    expect(verify.code).toBe(0);
    expect(verify.lines.join("\n")).toContain("result:               OK");
    expect(verify.lines.join("\n")).toContain("corpus chain verified : true");

    // Stats are computed from the bytes actually on disk.
    const stats = await cli.run(["dataset", "stats", "--dir", outDir, "--json"]);
    expect(stats.code).toBe(0);
    const parsed = JSON.parse(stats.lines.join("\n")) as { stats: { records: number }; manifestCounts: { records: number } };
    expect(parsed.stats.records).toBe(2);
    expect(parsed.manifestCounts.records).toBe(2);

    // Two exports of the same corpus into DIFFERENT directories agree on the
    // digest, and their shard bytes are identical — reproducibility, checked
    // through the CLI's own output and the files it actually wrote.
    const outDir2 = join(dir, "out2");
    const outDir3 = join(dir, "out3");
    const e2 = await cli.run(["dataset", "export", "--out", outDir2, "--compression", "gzip", "--json"]);
    const e3 = await cli.run(["dataset", "export", "--out", outDir3, "--compression", "gzip", "--json"]);
    expect(e2.code).toBe(0);
    expect(e3.code).toBe(0);
    const m2 = JSON.parse(e2.lines.join("\n")) as { manifest: { digest: string } };
    const m3 = JSON.parse(e3.lines.join("\n")) as { manifest: { digest: string } };
    expect(m3.manifest.digest).toBe(m2.manifest.digest);
    const shardsOf = (d: string): Buffer[] =>
      readdirSync(d)
        .filter((f) => f.endsWith(".jsonl.gz"))
        .sort()
        .map((f) => readFileSync(join(d, f)));
    expect(shardsOf(outDir3)).toEqual(shardsOf(outDir2));

    // …and that digest is exactly what the auditor recomputes from bytes.
    const verifyJson = await cli.run(["dataset", "verify", "--dir", outDir2, "--json"]);
    const v = JSON.parse(verifyJson.lines.join("\n")) as { report: { manifestDigest: string; recomputedDigest: string } };
    expect(v.report.recomputedDigest).toBe(m2.manifest.digest);
  });

  it("exits 2 when the dataset's own bytes were tampered with", async () => {
    const dataDir = join(dir, "data");
    const cli = cliFor(dataDir);
    const file = join(dir, "import.json");
    writeFileSync(file, JSON.stringify([await verified(1)]), "utf8");
    expect((await cli.run(["dataset", "import", file])).code).toBe(0);

    const outDir = join(dir, "out");
    expect((await cli.run(["dataset", "export", "--out", outDir])).code).toBe(0);

    // Hand-edit a shard's bytes: the recomputed hash can no longer match.
    const shard = readdirSync(outDir).find((f) => f.endsWith(".jsonl.gz"));
    expect(shard).toBeDefined();
    writeFileSync(join(outDir, shard as string), Buffer.from("not a gzip stream at all"));

    const verify = await cli.run(["dataset", "verify", "--dir", outDir]);
    expect(verify.code).toBe(2);
    expect(verify.lines.join("\n")).toContain("FAILED");
  });

  it("exits 3 when the CORPUS's own hash chain is broken, ahead of the dataset audit", async () => {
    const dataDir = join(dir, "data");
    const cli = cliFor(dataDir);
    const file = join(dir, "import.json");
    writeFileSync(file, JSON.stringify([await verified(1), await verified(2)]), "utf8");
    expect((await cli.run(["dataset", "import", file])).code).toBe(0);

    const outDir = join(dir, "out");
    expect((await cli.run(["dataset", "export", "--out", outDir])).code).toBe(0);

    // Break the corpus chain by deleting its middle record.
    const logPath = join(dataDir, "dataset", "corpus", "corpus.jsonl");
    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
    writeFileSync(logPath, [lines[0], lines[2]].join("\n") + "\n", "utf8");

    // A fresh CLI (fresh process semantics) so nothing is served from an
    // in-memory parse of the pre-tamper file.
    const verify = await cliFor(dataDir).run(["dataset", "verify", "--dir", outDir, "--with-corpus"]);
    expect(verify.code).toBe(3);
    expect(verify.lines.join("\n")).toContain("corpus chain verified : false");
  });

  it("finetune abstains — and spawns nothing — without a model or a trainer", async () => {
    const dataDir = join(dir, "data");
    const cli = cliFor(dataDir);
    const file = join(dir, "import.json");
    writeFileSync(file, JSON.stringify([await verified(1)]), "utf8");
    await cli.run(["dataset", "import", file]);
    const outDir = join(dir, "out");
    await cli.run(["dataset", "export", "--out", outDir]);

    const off = await cli.run(["dataset", "finetune", "--dir", outDir, "--json"]);
    expect(off.code).toBe(0);
    expect(JSON.parse(off.lines.join("\n")).outcome.reason).toBe("flag-not-set");

    const on = await cli.run(["dataset", "finetune", "--dir", outDir, "--enable", "--json"]);
    expect(on.code).toBe(1);
    const outcome = JSON.parse(on.lines.join("\n")).outcome as { status: string; reason: string };
    expect(outcome.status).toBe("abstained");
    expect(outcome.reason).toBe("no-model");
    // No fine-tune metric is ever reported by an abstained run.
    expect(JSON.stringify(outcome)).not.toMatch(/"(loss|accuracy|perplexity)"/);
    expect(existsSync(join(outDir, "finetune"))).toBe(false);
  });

  it("reports a missing dataset directory honestly instead of planning against nothing", async () => {
    const res = await cliFor(join(dir, "data")).run(["dataset", "finetune", "--dir", join(dir, "absent")]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("no readable dataset manifest");
  });
});

describe("defaultDatasetCliDeps — real product wiring", () => {
  it("resolves the dataset roots from the shared HADES_DATA_DIR convention", () => {
    const deps = defaultDatasetCliDeps({ env: { HADES_DATA_DIR: join(dir, "custom") } as unknown as NodeJS.ProcessEnv });
    expect(deps.root).toBe(join(dir, "custom", "dataset", "export"));

    const fallback = defaultDatasetCliDeps({ env: {} as unknown as NodeJS.ProcessEnv });
    expect(fallback.root).toBe(join(".hades", "dataset", "export"));
  });

  it("does not touch disk until a stateful capability is actually used", () => {
    const dataDir = join(dir, "lazy");
    defaultDatasetCliDeps({ dataDir });
    expect(existsSync(join(dataDir, "dataset"))).toBe(false);
  });

  it("binds a real, cached VerifiedTrajectoryCorpus at <dataDir>/dataset/corpus", () => {
    const dataDir = join(dir, "data");
    const deps = defaultDatasetCliDeps({ dataDir });
    const a = deps.corpus();
    const b = deps.corpus();
    expect(a).toBeInstanceOf(VerifiedTrajectoryCorpus);
    expect(b).toBe(a);
    expect(existsSync(join(dataDir, "dataset", "corpus", "corpus.jsonl"))).toBe(true);
    // The default export directory is a SIBLING of the corpus, never the
    // corpus itself — an `--overwrite` export must never be able to land on
    // the ledger it was derived from.
    expect(deps.root).not.toBe(join(dataDir, "dataset", "corpus"));
  });

  it("probes for a real local model by magic bytes, never by assumption", () => {
    const deps = defaultDatasetCliDeps({ dataDir: join(dir, "data") });
    const absent = deps.probeModel(join(dir, "no-such-model.gguf"));
    expect(absent.present).toBe(false);

    const modelPath = join(dir, "model.gguf");
    writeFileSync(modelPath, Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.alloc(64)]));
    const found = deps.probeModel(modelPath);
    expect(found.present).toBe(true);
    expect(found.format).toBe("gguf");

    const notAModel = join(dir, "notes.txt");
    writeFileSync(notAModel, "this is not a model file", "utf8");
    expect(deps.probeModel(notAModel).present).toBe(false);
  });
});

describe("nodeSpawnPort — a real child process, never a simulated one", () => {
  it("runs a real process and reports its real exit code and stdout", async () => {
    const port = nodeSpawnPort();
    const ok = await port.run([process.execPath, "-e", "process.stdout.write('trainer-ran')"], {
      cwd: dir,
      timeoutMs: 30_000,
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("trainer-ran");
    expect(ok.timedOut).toBe(false);
  });

  it("never reports a failing process as a success", async () => {
    const port = nodeSpawnPort();
    const bad = await port.run([process.execPath, "-e", "process.stderr.write('boom'); process.exit(7)"], {
      cwd: dir,
      timeoutMs: 30_000,
    });
    expect(bad.exitCode).toBe(7);
    expect(bad.stderr).toContain("boom");
  });

  it("reports an unstartable trainer as a failure, not a silent no-op", async () => {
    const port = nodeSpawnPort();
    const missing = await port.run([join(dir, "definitely-not-an-executable")], { cwd: dir, timeoutMs: 30_000 });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("spawn failed");
  });

  it("kills an over-budget process and reports timedOut truthfully", async () => {
    const port = nodeSpawnPort();
    const slow = await port.run([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { cwd: dir, timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
    expect(slow.exitCode).not.toBe(0);
  });
});
