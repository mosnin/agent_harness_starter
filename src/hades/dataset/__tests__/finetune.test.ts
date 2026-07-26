/* ------------------------------------------------------------------ *
 * finetune.test.ts
 *
 * REAL-VS-MOCK POLICY: every model-format fixture below is a REAL file on
 * disk under a real `node:os.tmpdir()` temp directory, sniffed by the REAL
 * `probeLocalModel` — nothing about magic-byte detection is mocked. The
 * ONLY test double in this file is `SpawnPort` (`runFineTune`'s own locked
 * injection seam for "the trainer process" — there is no real local trainer
 * to shell out to in CI, and the whole point of this suite is proving the
 * safety gate never touches it except on the one fully-enabled path). Every
 * `DatasetManifest`/`DatasetAuditReport` fixture is built with the REAL
 * `normalizeSpec`/`DATASET_FORMAT_VERSION` from `../exporter` and REAL
 * `sha256Hex` from `../../styx/certificate` — never an invented shape.
 * ------------------------------------------------------------------ */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { sha256Hex } from "../../styx/certificate";
import { DATASET_FORMAT_VERSION, normalizeSpec, type DatasetManifest } from "../exporter";
import type { DatasetAuditReport } from "../audit";
import {
  probeLocalModel,
  planFineTune,
  runFineTune,
  formatFineTuneOutcome,
  type LocalModelProbe,
  type ProbeIo,
  type FineTunePlan,
  type FineTuneOutcome,
  type SpawnPort,
} from "../finetune";

const LOCAL_MODEL_PATH_ENV_VAR = "HADES_LOCAL_MODEL_PATH";

// ===========================================================================
// Fixtures
// ===========================================================================

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-finetune-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeManifest(overrides: Partial<DatasetManifest> = {}): DatasetManifest {
  const base: DatasetManifest = {
    formatVersion: DATASET_FORMAT_VERSION,
    createdAt: 1_700_000_000_000,
    generator: { name: "hades", phase: 19 },
    specHash: sha256Hex("test-spec"),
    spec: normalizeSpec({}),
    corpus: { genesis: sha256Hex("genesis"), head: sha256Hex("head"), entriesScanned: 10, verifiedOnly: true },
    shards: [],
    counts: { records: 10, train: 9, holdout: 1, skipped: 0, redactions: 0, mockTaintedExcluded: 0, duplicatesDropped: 0 },
    skips: [],
    digest: sha256Hex("test-digest"),
  };
  return {
    ...base,
    ...overrides,
    counts: { ...base.counts, ...(overrides.counts ?? {}) },
  };
}

function fakeAudit(ok: boolean, findings: DatasetAuditReport["findings"] = []): DatasetAuditReport {
  return {
    ok,
    dir: "/fake/dataset",
    formatVersion: 1,
    manifestDigest: "digest",
    recomputedDigest: "digest",
    records: 10,
    shardsChecked: 1,
    certificatesVerified: 0,
    certificatesFailed: 0,
    corpusCrossChecked: false,
    findings,
  };
}

const presentModel: LocalModelProbe = { present: true, path: "/fake/model.gguf", format: "gguf", sizeBytes: 123, reason: "fixture" };
const absentModel: LocalModelProbe = { present: false, format: "unknown", reason: "fixture: no model" };

function spySpawnPort(
  impl: (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>,
): SpawnPort & { calls: { argv: string[]; opts: { cwd: string; timeoutMs: number } }[] } {
  const calls: { argv: string[]; opts: { cwd: string; timeoutMs: number } }[] = [];
  return {
    calls,
    async run(argv, opts) {
      calls.push({ argv, opts });
      return impl(argv, opts);
    },
  };
}

function makeClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function writeSafetensorsFixture(path: string, headerObj: Record<string, unknown> = { __metadata__: { format: "pt" } }): void {
  const headerJson = JSON.stringify(headerObj);
  const headerBuf = Buffer.from(headerJson, "utf8");
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(headerBuf.length), 0);
  writeFileSync(path, Buffer.concat([lenBuf, headerBuf, Buffer.from("tensor-bytes-not-real-weights")]));
}

// ===========================================================================
// probeLocalModel
// ===========================================================================

describe("probeLocalModel", () => {
  it("reports honestly when no path and no env var are given", () => {
    const r = probeLocalModel({});
    expect(r.present).toBe(false);
    expect(r.format).toBe("unknown");
    expect(r.reason).toContain(LOCAL_MODEL_PATH_ENV_VAR);
  });

  it("reports honestly when path does not exist on disk", () => {
    const r = probeLocalModel({ path: join(root, "does-not-exist.gguf") });
    expect(r.present).toBe(false);
    expect(r.format).toBe("unknown");
    expect(r.reason).toMatch(/no file or directory found/);
  });

  it("detects a REAL gguf file by its magic bytes", () => {
    const path = join(root, "model.gguf");
    const body = Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.alloc(64, 7)]);
    writeFileSync(path, body);
    const r = probeLocalModel({ path });
    expect(r.present).toBe(true);
    expect(r.format).toBe("gguf");
    expect(r.path).toBe(path);
    expect(r.sizeBytes).toBe(body.length);
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it("detects a REAL safetensors file by its length-prefixed JSON header", () => {
    const path = join(root, "model.safetensors");
    writeSafetensorsFixture(path, { weight: { dtype: "F32", shape: [4, 4], data_offsets: [0, 64] } });
    const r = probeLocalModel({ path });
    expect(r.present).toBe(true);
    expect(r.format).toBe("safetensors");
    expect(r.sizeBytes).toBeGreaterThan(0);
  });

  it("detects a REAL peft/LoRA adapter directory", () => {
    const dir = join(root, "adapter");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "adapter_config.json"), JSON.stringify({ peft_type: "LORA", r: 8 }));
    writeFileSync(join(dir, "adapter_model.safetensors"), Buffer.alloc(16, 1));
    const r = probeLocalModel({ path: dir });
    expect(r.present).toBe(true);
    expect(r.format).toBe("peft-dir");
    expect(r.path).toBe(dir);
  });

  it("also accepts adapter_model.bin as the peft weight file", () => {
    const dir = join(root, "adapter-bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "adapter_config.json"), "{}");
    writeFileSync(join(dir, "adapter_model.bin"), Buffer.alloc(8, 2));
    const r = probeLocalModel({ path: dir });
    expect(r.present).toBe(true);
    expect(r.format).toBe("peft-dir");
  });

  it("refuses a directory that does not contain the required peft files (directory-instead-of-file case)", () => {
    const dir = join(root, "plain-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "readme.txt"), "not a model");
    const r = probeLocalModel({ path: dir });
    expect(r.present).toBe(false);
    expect(r.format).toBe("unknown");
    expect(r.reason).toMatch(/adapter_config\.json/);
  });

  it("refuses a file whose bytes match no known model magic (wrong-magic file)", () => {
    const path = join(root, "not-a-model.bin");
    // First 4 bytes are not "GGUF"; the next 4 make the 8-byte LE "header
    // length" astronomically large so the safetensors check also refuses
    // deterministically, regardless of platform endianness quirks.
    writeFileSync(path, Buffer.from([0x58, 0x58, 0x58, 0x58, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00]));
    const r = probeLocalModel({ path });
    expect(r.present).toBe(false);
    expect(r.format).toBe("unknown");
    expect(r.reason).toMatch(/no recognized model magic bytes/);
  });

  it("refuses a real zero-byte file, honestly", () => {
    const path = join(root, "empty.gguf");
    writeFileSync(path, Buffer.alloc(0));
    const r = probeLocalModel({ path });
    expect(r.present).toBe(false);
    expect(r.sizeBytes).toBe(0);
    expect(r.reason).toMatch(/empty \(0 bytes\)/);
  });

  it("reports an honest reason for an unreadable path via an injected ProbeIo (deterministic, no chmod trickery)", () => {
    const io: ProbeIo = {
      existsSync: () => true,
      statSync: () => {
        throw new Error("EACCES: permission denied");
      },
      readdirSync: () => {
        throw new Error("should never be reached");
      },
    };
    const r = probeLocalModel({ path: "/some/blocked/path", io });
    expect(r.present).toBe(false);
    expect(r.reason).toMatch(/unreadable path/);
    expect(r.reason).toContain("EACCES");
  });

  it("falls back to the env var ONLY when no explicit path is given (env-var-only configuration)", () => {
    const path = join(root, "env-model.gguf");
    writeFileSync(path, Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.alloc(4)]));
    const r = probeLocalModel({ env: { ...process.env, [LOCAL_MODEL_PATH_ENV_VAR]: path } });
    expect(r.present).toBe(true);
    expect(r.format).toBe("gguf");
    expect(r.path).toBe(path);
  });

  it("prefers an explicit path over the env var when both are given", () => {
    const envPath = join(root, "env-model-2.gguf");
    writeFileSync(envPath, Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.alloc(4)]));
    const explicitPath = join(root, "does-not-exist-explicit.gguf");
    const r = probeLocalModel({ path: explicitPath, env: { ...process.env, [LOCAL_MODEL_PATH_ENV_VAR]: envPath } });
    expect(r.present).toBe(false);
    expect(r.path).toBe(explicitPath);
  });

  it("never throws on a pathological ProbeIo", () => {
    const io: ProbeIo = {
      existsSync: () => {
        throw new Error("boom");
      },
      statSync: () => {
        throw new Error("unreachable");
      },
      readdirSync: () => {
        throw new Error("unreachable");
      },
    };
    expect(() => probeLocalModel({ path: "/x", io })).not.toThrow();
    expect(probeLocalModel({ path: "/x", io }).present).toBe(false);
  });
});

// ===========================================================================
// planFineTune
// ===========================================================================

describe("planFineTune", () => {
  it("builds a deterministic plan with the real defaults", () => {
    const manifest = fakeManifest({ counts: { records: 10, train: 8, holdout: 2, skipped: 0, redactions: 0, mockTaintedExcluded: 0, duplicatesDropped: 0 } });
    const plan = planFineTune(manifest, presentModel, "/data/my-dataset");
    expect(plan.datasetDir).toBe("/data/my-dataset");
    expect(plan.manifestDigest).toBe(manifest.digest);
    expect(plan.modelPath).toBe(presentModel.path);
    expect(plan.modelFormat).toBe("gguf");
    expect(plan.trainRecords).toBe(8);
    expect(plan.holdoutRecords).toBe(2);
    expect(plan.adapter).toBe("lora");
    expect(plan.cwd).toBe("/data/my-dataset");
    expect(plan.estimatedSteps).toBe(Math.ceil(8 / plan.batchSize) * plan.epochs);
  });

  it("is a pure function: same inputs -> byte-identical argv/plan twice in a row", () => {
    const manifest = fakeManifest();
    const a = planFineTune(manifest, presentModel, "/data/x", { epochs: 5, batchSize: 2, learningRate: 0.001, seed: 7 });
    const b = planFineTune(manifest, presentModel, "/data/x", { epochs: 5, batchSize: 2, learningRate: 0.001, seed: 7 });
    expect(a).toEqual(b);
  });

  it("computes estimatedSteps as ceil(train/batchSize) * epochs, and 0 for an empty dataset", () => {
    const manifest = fakeManifest({ counts: { records: 10, train: 10, holdout: 0, skipped: 0, redactions: 0, mockTaintedExcluded: 0, duplicatesDropped: 0 } });
    const plan = planFineTune(manifest, presentModel, "/d", { epochs: 3, batchSize: 4 });
    expect(plan.estimatedSteps).toBe(Math.ceil(10 / 4) * 3);

    const emptyManifest = fakeManifest({ counts: { records: 0, train: 0, holdout: 0, skipped: 0, redactions: 0, mockTaintedExcluded: 0, duplicatesDropped: 0 } });
    const emptyPlan = planFineTune(emptyManifest, presentModel, "/d");
    expect(emptyPlan.estimatedSteps).toBe(0);
  });

  it("rejects out-of-contract FineTuneOptions rather than silently clamping them", () => {
    const manifest = fakeManifest();
    expect(() => planFineTune(manifest, presentModel, "/d", { epochs: 0 })).toThrow(RangeError);
    expect(() => planFineTune(manifest, presentModel, "/d", { batchSize: -1 })).toThrow(RangeError);
    expect(() => planFineTune(manifest, presentModel, "/d", { learningRate: 0 })).toThrow(RangeError);
    expect(() => planFineTune(manifest, presentModel, "/d", { seed: -1 })).toThrow(RangeError);
    expect(() => planFineTune(manifest, presentModel, "")).toThrow(RangeError);
  });

  it("argv is a plain array — a hostile dataset dir name is carried as ONE literal element, never shell-interpolated", () => {
    const hostile = String.raw`/tmp/hostile-'"; rm -rf /tmp/pwned; echo "gotcha`;
    const manifest = fakeManifest();
    const plan = planFineTune(manifest, presentModel, hostile);

    expect(plan.cwd).toBe(hostile);
    const idx = plan.argv.indexOf("--dataset-dir");
    expect(idx).toBeGreaterThanOrEqual(0);
    // The value immediately follows the flag, byte-for-byte identical to the
    // input — no escaping, no truncation, no splitting on the embedded
    // shell metacharacters.
    expect(plan.argv[idx + 1]).toBe(hostile);
    // And it appears EXACTLY once as a whole argv element (never fused with
    // neighboring flags the way a shell string would fuse it).
    expect(plan.argv.filter((a) => a === hostile)).toHaveLength(1);
  });

  it("never places any dataset RECORD content into argv — only paths/digest/model/hyperparameters", () => {
    const manifest = fakeManifest();
    const plan = planFineTune(manifest, presentModel, "/d/set");
    const allowed = new Set([
      ...plan.argv,
    ]);
    // Every element must be traceable to a known source: a flag literal, the
    // datasetDir, the digest, model path/format, outputDir, "lora", or a
    // stringified hyperparameter. This is a structural sanity check, not a
    // deep parse — its purpose is to catch a future edit that starts folding
    // arbitrary text into argv.
    for (const el of plan.argv) {
      expect(typeof el).toBe("string");
    }
    expect(allowed.has(plan.datasetDir)).toBe(true);
    expect(allowed.has(manifest.digest)).toBe(true);
  });

  it("respects an injected trainerArgv as the base command", () => {
    const manifest = fakeManifest();
    const plan = planFineTune(manifest, presentModel, "/d", { trainerArgv: ["python3", "-m", "my.trainer"] });
    expect(plan.argv.slice(0, 3)).toEqual(["python3", "-m", "my.trainer"]);
    expect(plan.argv).toContain("--dataset-dir");
  });

  it("defaults outputDir under datasetDir but honors an explicit override", () => {
    const manifest = fakeManifest();
    const def = planFineTune(manifest, presentModel, "/d");
    expect(def.outputDir.startsWith("/d")).toBe(true);
    const overridden = planFineTune(manifest, presentModel, "/d", { outputDir: "/somewhere/else" });
    expect(overridden.outputDir).toBe("/somewhere/else");
  });
});

// ===========================================================================
// runFineTune — the safety gate
// ===========================================================================

describe("runFineTune", () => {
  function goodPlan(overrides: Partial<FineTunePlan> = {}): FineTunePlan {
    const manifest = fakeManifest({ counts: { records: 10, train: 8, holdout: 2, skipped: 0, redactions: 0, mockTaintedExcluded: 0, duplicatesDropped: 0 } });
    return { ...planFineTune(manifest, presentModel, "/data/ds"), ...overrides };
  }

  it("abstains with flag-not-set and NEVER spawns when enabled is false", async () => {
    const plan = goodPlan();
    const spawn = spySpawnPort(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    const outcome = await runFineTune({ enabled: false, plan, model: presentModel, audit: fakeAudit(true), spawn });
    expect(outcome.status).toBe("abstained");
    expect((outcome as { reason: string }).reason).toBe("flag-not-set");
    expect(spawn.calls).toHaveLength(0);
  });

  it("abstains with no-model and NEVER spawns when the model is absent", async () => {
    const plan = goodPlan();
    const spawn = spySpawnPort(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    const outcome = await runFineTune({ enabled: true, plan, model: absentModel, audit: fakeAudit(true), spawn });
    expect(outcome.status).toBe("abstained");
    expect((outcome as { reason: string }).reason).toBe("no-model");
    expect(spawn.calls).toHaveLength(0);
  });

  it("abstains with audit-failed and NEVER spawns when the audit has a fatal finding", async () => {
    const plan = goodPlan();
    const spawn = spySpawnPort(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    const audit = fakeAudit(false, [{ code: "digest-mismatch", severity: "fatal", detail: "tampered" }]);
    const outcome = await runFineTune({ enabled: true, plan, model: presentModel, audit, spawn });
    expect(outcome.status).toBe("abstained");
    expect((outcome as { reason: string }).reason).toBe("audit-failed");
    expect((outcome as { detail: string }).detail).toContain("digest-mismatch");
    expect(spawn.calls).toHaveLength(0);
  });

  it("abstains with empty-dataset and NEVER spawns when there are zero train records", async () => {
    const plan = goodPlan({ trainRecords: 0 });
    const spawn = spySpawnPort(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    const outcome = await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true), spawn });
    expect(outcome.status).toBe("abstained");
    expect((outcome as { reason: string }).reason).toBe("empty-dataset");
    expect(spawn.calls).toHaveLength(0);
  });

  it("returns 'planned' and NEVER spawns when dryRun is true, even with a real spawn port injected", async () => {
    const plan = goodPlan();
    const spawn = spySpawnPort(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    const outcome = await runFineTune({ enabled: true, dryRun: true, plan, model: presentModel, audit: fakeAudit(true), spawn });
    expect(outcome.status).toBe("planned");
    expect(spawn.calls).toHaveLength(0);
  });

  it("abstains with no-trainer (the default spawn port) when every other condition is satisfied", async () => {
    const plan = goodPlan();
    const outcome = await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true) });
    expect(outcome.status).toBe("abstained");
    expect((outcome as { reason: string }).reason).toBe("no-trainer");
  });

  it("ONLY the fully-enabled path spawns, and reports exclusively real observed values", async () => {
    const plan = goodPlan();
    const spawn = spySpawnPort(async () => ({ exitCode: 0, stdout: "epoch 1/3\nepoch 2/3\nepoch 3/3\ndone\n", stderr: "", timedOut: false }));
    const now = makeClock([1_000, 6_500]);
    const outcome = await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true), spawn, now });

    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].argv).toEqual(plan.argv);
    expect(spawn.calls[0].opts.cwd).toBe(plan.cwd);

    expect(outcome.status).toBe("ran");
    const ran = outcome as Extract<FineTuneOutcome, { status: "ran" }>;
    expect(ran.exitCode).toBe(0);
    expect(ran.durationMs).toBe(5_500);
    expect(ran.stdoutTail).toEqual(["epoch 1/3", "epoch 2/3", "epoch 3/3", "done"]);
    expect(ran.stderrTail).toEqual([]);
    expect(ran.checkpointDir).toBe(plan.outputDir);
  });

  it("surfaces a non-zero exit code as failure (no checkpointDir)", async () => {
    const plan = goodPlan();
    const spawn = spySpawnPort(async () => ({ exitCode: 3, stdout: "traceback...\n", stderr: "CUDA OOM\n", timedOut: false }));
    const outcome = await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true), spawn, now: makeClock([0, 10]) });
    const ran = outcome as Extract<FineTuneOutcome, { status: "ran" }>;
    expect(ran.exitCode).toBe(3);
    expect(ran.checkpointDir).toBeNull();
  });

  it("surfaces a timeout as a non-zero exit code even if the port reports exitCode 0 (no fake success)", async () => {
    const plan = goodPlan();
    const spawn = spySpawnPort(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: true }));
    const outcome = await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true), spawn, now: makeClock([0, 999]) });
    const ran = outcome as Extract<FineTuneOutcome, { status: "ran" }>;
    expect(ran.exitCode).not.toBe(0);
    expect(ran.checkpointDir).toBeNull();
  });

  it("surfaces a killed child (negative exit code) as failure", async () => {
    const plan = goodPlan();
    const spawn = spySpawnPort(async () => ({ exitCode: -15, stdout: "", stderr: "terminated: SIGTERM\n", timedOut: false }));
    const outcome = await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true), spawn });
    const ran = outcome as Extract<FineTuneOutcome, { status: "ran" }>;
    expect(ran.exitCode).toBe(-15);
    expect(ran.checkpointDir).toBeNull();
  });

  it("a child that prints garbage is still surfaced honestly (captured verbatim, never hidden, never a fake success)", async () => {
    const garbage = "\u0000\u0001\u0002\uFFFDbinary noise \u0007\u0007 not utf8-safe??";
    const plan = goodPlan();
    const spawn = spySpawnPort(async () => ({ exitCode: 1, stdout: garbage, stderr: "", timedOut: false }));
    const outcome = await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true), spawn });
    const ran = outcome as Extract<FineTuneOutcome, { status: "ran" }>;
    expect(ran.exitCode).toBe(1);
    expect(ran.checkpointDir).toBeNull();
    expect(ran.stdoutTail.join("\n")).toContain(garbage);
  });

  it("catches a rejected spawn.run and surfaces it as a non-zero-exit failure, never an unhandled rejection or a fake success", async () => {
    const plan = goodPlan();
    const spawn: SpawnPort = {
      run: async () => {
        throw new Error("ENOENT: trainer binary not found");
      },
    };
    const outcome = await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true), spawn, now: makeClock([0, 42]) });
    const ran = outcome as Extract<FineTuneOutcome, { status: "ran" }>;
    expect(ran.exitCode).not.toBe(0);
    expect(ran.checkpointDir).toBeNull();
    expect(ran.durationMs).toBe(42);
    expect(ran.stderrTail.join("\n")).toContain("ENOENT");
  });

  it("passes the hostile dataset dir through to the ACTUAL spawn call, unmodified, as a single argv element", async () => {
    const hostile = String.raw`/tmp/hostile $(whoami) & echo pwned`;
    const manifest = fakeManifest({ counts: { records: 5, train: 5, holdout: 0, skipped: 0, redactions: 0, mockTaintedExcluded: 0, duplicatesDropped: 0 } });
    const plan = planFineTune(manifest, presentModel, hostile);
    const spawn = spySpawnPort(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true), spawn });
    expect(spawn.calls[0].argv).toContain(hostile);
    expect(spawn.calls[0].opts.cwd).toBe(hostile);
  });

  it("passes the injected timeoutMs through to the spawn port, defaulting when absent", async () => {
    const plan = goodPlan();
    const spawn = spySpawnPort(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true), spawn, timeoutMs: 12_345 });
    expect(spawn.calls[0].opts.timeoutMs).toBe(12_345);

    const spawn2 = spySpawnPort(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    await runFineTune({ enabled: true, plan, model: presentModel, audit: fakeAudit(true), spawn: spawn2 });
    expect(spawn2.calls[0].opts.timeoutMs).toBeGreaterThan(0);
  });
});

// ===========================================================================
// formatFineTuneOutcome
// ===========================================================================

describe("formatFineTuneOutcome", () => {
  function goodPlan(): FineTunePlan {
    return planFineTune(fakeManifest({ counts: { records: 10, train: 8, holdout: 2, skipped: 0, redactions: 0, mockTaintedExcluded: 0, duplicatesDropped: 0 } }), presentModel, "/data/ds");
  }

  it("formats an abstained outcome without any fabricated metric field", () => {
    const lines = formatFineTuneOutcome({ status: "abstained", reason: "no-model", detail: "no model here", plan: goodPlan() });
    const text = lines.join("\n");
    expect(text).toContain("ABSTAINED");
    expect(text).toContain("no-model");
    expect(text.toLowerCase()).not.toMatch(/loss\s*[:=]|accuracy\s*[:=]|perplexity\s*[:=]/);
  });

  it("formats a planned outcome", () => {
    const lines = formatFineTuneOutcome({ status: "planned", plan: goodPlan() });
    const text = lines.join("\n");
    expect(text).toContain("PLANNED");
    expect(text).toContain("dry run");
  });

  it("formats a ran outcome with exit code, duration, checkpoint dir, and captured tails — nothing synthesized", () => {
    const plan = goodPlan();
    const outcome: FineTuneOutcome = {
      status: "ran",
      plan,
      exitCode: 0,
      durationMs: 4200,
      stdoutTail: ["line one", "line two"],
      stderrTail: [],
      checkpointDir: plan.outputDir,
    };
    const lines = formatFineTuneOutcome(outcome);
    const text = lines.join("\n");
    expect(text).toContain("exitCode=0");
    expect(text).toContain("4200ms");
    expect(text).toContain(plan.outputDir);
    expect(text).toContain("line one");
    expect(text.toLowerCase()).not.toMatch(/loss\s*[:=]|accuracy\s*[:=]|perplexity\s*[:=]/);
    expect(text).toMatch(/no loss, accuracy, or perplexity is ever synthesized/);
  });

  it("formats a failed ran outcome with checkpointDir null, honestly", () => {
    const plan = goodPlan();
    const outcome: FineTuneOutcome = {
      status: "ran",
      plan,
      exitCode: 1,
      durationMs: 10,
      stdoutTail: [],
      stderrTail: ["boom"],
      checkpointDir: null,
    };
    const text = formatFineTuneOutcome(outcome).join("\n");
    expect(text).toContain("exitCode=1");
    expect(text).toMatch(/none — the run did not complete successfully/);
    expect(text).toContain("boom");
  });
});
