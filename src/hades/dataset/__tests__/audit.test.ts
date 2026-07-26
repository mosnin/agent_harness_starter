/* ------------------------------------------------------------------ *
 * audit.test.ts
 *
 * REAL-VS-MOCK POLICY: crypto is always real. Every certificate here is
 * issued by a real `CertificateAuthority` (real ed25519 via @noble/ed25519,
 * real sha256 via node:crypto) against a deterministic seed. Every dataset
 * exercised here is produced by the REAL `exportDataset` (`../exporter`)
 * from a REAL `VerifiedTrajectoryCorpus` (`../corpus`) whose entries were
 * admitted through the REAL `admit()` gate. Nothing here mocks
 * `verifyCertificate`, `sha256Hex`, `canonicalTrajectoryJson`,
 * `exportDataset`, or any part of the module under test. Tampering is
 * applied as real byte-level edits to real files on a real temp directory;
 * "attacks" never fabricate a finding — they corrupt bytes and let
 * `auditDataset` discover it.
 * ------------------------------------------------------------------ */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";

import { CertificateAuthority, generatePrivateKeyHex, sha256Hex } from "../../styx/certificate";
import { canonicalTrajectoryJson } from "../../skills/synthesize";
import type { CertificatePayload } from "../../styx/certificate";
import type { GoalTrajectory, ToolEvent } from "../../research/recorder";

import { VerifiedTrajectoryCorpus, type CorpusEntry } from "../corpus";
import type { ExportSpec } from "../exporter";
import { exportDataset, datasetDigest } from "../exporter";

import {
  auditDataset,
  computeStats,
  formatAuditReport,
  formatStatsReport,
  readDatasetRecords,
  type DatasetAuditReport,
  type DatasetStats,
} from "../audit";
import type { TrainingRecord } from "../example";

// ===========================================================================
// Fixture builders
// ===========================================================================

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

const caA = new CertificateAuthority(generatePrivateKeyHex(fixedRng(11)));
const caB = new CertificateAuthority(generatePrivateKeyHex(fixedRng(37)));

function tool(seed: number, overrides: Partial<ToolEvent> = {}): ToolEvent {
  return { tool: "read_file", ok: true, summary: `did step ${seed}`, at: seed, ...overrides };
}

function makeGoal(n: number, overrides: Partial<GoalTrajectory> = {}): GoalTrajectory {
  return {
    goalId: `goal-${n}`,
    objective: `Resolve ticket #${n}: fix the widget renderer`,
    model: "test-model",
    tasks: [
      {
        taskId: `task-${n}-1`,
        description: `Investigate ticket #${n}`,
        capability: "coding",
        tools: [tool(n * 10 + 1), tool(n * 10 + 2, { tool: "edit_file", summary: `patched widget ${n}` })],
        success: true,
        startedAt: 0,
        endedAt: 1,
      },
    ],
    success: true,
    startedAt: 0,
    endedAt: 1,
    ...overrides,
  };
}

function payloadFor(trajectory: GoalTrajectory, overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex(`output-for-${trajectory.goalId}`),
    taskId: trajectory.tasks[0]?.taskId ?? "task-1",
    verifierTier: "T2-genrm",
    ensembleScore: 0.95,
    pCorrect: 0.99,
    epsilon: 0.02,
    traceSha256: sha256Hex(canonicalTrajectoryJson(trajectory)),
    verifierVersions: ["exec-oracle@1.0.0"],
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Admits `n` distinct, real, ed25519-certified trajectories into `corpus`. */
async function admitN(
  corpus: VerifiedTrajectoryCorpus,
  n: number,
  opts: { mock?: boolean; authority?: CertificateAuthority; startAt?: number } = {},
): Promise<CorpusEntry[]> {
  const entries: CorpusEntry[] = [];
  const authority = opts.authority ?? caA;
  const start = opts.startAt ?? 0;
  for (let i = start; i < start + n; i++) {
    const objective = `Resolve ticket #${i}: fix the widget renderer${opts.mock ? " [mock] synthetic fixture" : ""}`;
    const trajectory = makeGoal(i, { objective });
    const payload = payloadFor(trajectory);
    const certificate = await authority.issue(payload);
    const admission = await corpus.admit({ trajectory, certificate });
    if (!admission.ok) {
      throw new Error(`fixture admit failed: ${admission.rejection.code} ${admission.rejection.detail}`);
    }
    entries.push(admission.entry);
  }
  return entries;
}

const tmpRoots: string[] = [];
function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const d = tmpRoots.pop() as string;
    rmSync(d, { recursive: true, force: true });
  }
});

let outDirCounter = 0;

function doExport(
  corpus: VerifiedTrajectoryCorpus,
  root: string,
  specOverrides: Partial<ExportSpec> = {},
): { outDir: string; manifest: any } {
  const outDir = join(root, `out-${outDirCounter++}`);
  const result = exportDataset(
    corpus,
    {
      schema: "tool-trace",
      holdoutFraction: 0.5,
      holdoutSalt: "audit-fixture-salt",
      shardSize: 5,
      filter: {},
      ...specOverrides,
    },
    { outDir },
  );
  return { outDir, manifest: result.manifest as any };
}

// ---------------------------------------------------------------------------
// Raw shard/manifest surgery helpers (the "attacker's toolkit")
// ---------------------------------------------------------------------------

function readManifestRaw(outDir: string): any {
  return JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
}
function writeManifestRaw(outDir: string, manifest: any): void {
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest), "utf8");
}
function shardPath(outDir: string, shard: { file: string }): string {
  return join(outDir, shard.file);
}
function readShardLines(outDir: string, shard: { file: string }): string[] {
  const raw = readFileSync(shardPath(outDir, shard));
  return gunzipSync(raw)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}
function writeShardLines(outDir: string, shard: { file: string }, lines: string[]): void {
  const content = lines.join("\n") + "\n";
  writeFileSync(shardPath(outDir, shard), gzipSync(Buffer.from(content, "utf8")));
}
function anyShardWith(manifest: any, records: number): any {
  return manifest.shards.find((s: any) => s.records >= records) ?? manifest.shards[0];
}
function locateRecordLine(
  outDir: string,
  manifest: any,
  trajectorySha256: string,
): { shard: any; lines: string[]; idx: number; record: any } {
  for (const shard of manifest.shards) {
    const lines = readShardLines(outDir, shard);
    for (let i = 0; i < lines.length; i++) {
      const rec = JSON.parse(lines[i]);
      if (rec.trajectorySha256 === trajectorySha256) return { shard, lines, idx: i, record: rec };
    }
  }
  throw new Error(`record for trajectory ${trajectorySha256} not found in any shard under ${outDir}`);
}

function codes(r: DatasetAuditReport): string[] {
  return r.findings.map((f) => f.code);
}

// ===========================================================================
// Shared "clean" fixture: one corpus of 24 real entries, exported fresh per
// test that needs to mutate dataset bytes (export itself is cheap — no
// crypto; only the shared corpus's admission phase pays the crypto cost,
// paid exactly once for the whole suite).
// ===========================================================================

let sharedRoot: string;
let sharedCorpus: VerifiedTrajectoryCorpus;

beforeAll(async () => {
  sharedRoot = mkdtempSync(join(tmpdir(), "hades-audit-shared-"));
  sharedCorpus = new VerifiedTrajectoryCorpus({ root: join(sharedRoot, "corpus") });
  await admitN(sharedCorpus, 24);
}, 60_000);

afterAll(() => {
  rmSync(sharedRoot, { recursive: true, force: true });
});

function sharedExport(specOverrides: Partial<ExportSpec> = {}): { outDir: string; manifest: any } {
  return doExport(sharedCorpus, sharedRoot, specOverrides);
}

// ===========================================================================
// Clean dataset: zero findings
// ===========================================================================

describe("auditDataset — clean dataset", () => {
  it("audits an unmutated real export as ok with zero findings", async () => {
    const { outDir, manifest } = sharedExport();
    const report = await auditDataset(outDir);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.records).toBe(manifest.counts.records);
    expect(report.shardsChecked).toBe(manifest.shards.length);
    expect(report.manifestDigest).toBe(manifest.digest);
    expect(report.recomputedDigest).toBe(manifest.digest);
    expect(report.formatVersion).toBe(manifest.formatVersion);
    expect(report.corpusCrossChecked).toBe(false);
  });

  it("audits clean with the real corpus cross-check enabled too", async () => {
    const { outDir } = sharedExport();
    const report = await auditDataset(outDir, { corpus: sharedCorpus });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.corpusCrossChecked).toBe(true);
    expect(report.certificatesFailed).toBe(0);
    expect(report.certificatesVerified).toBeGreaterThan(0);
    expect(report.certificatesVerified).toBe(report.records);
  });

  it("audits an empty (zero-entry) corpus export clean", async () => {
    const root = freshRoot("hades-audit-empty-");
    const corpus = new VerifiedTrajectoryCorpus({ root: join(root, "corpus") });
    const { outDir, manifest } = doExport(corpus, root);
    expect(manifest.counts.records).toBe(0);
    expect(manifest.shards).toEqual([]);
    const report = await auditDataset(outDir);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.records).toBe(0);
  });

  it("readDatasetRecords returns every record with zero errors on a clean export", () => {
    const { outDir, manifest } = sharedExport();
    const { records, errors } = readDatasetRecords(outDir);
    expect(errors).toEqual([]);
    expect(records.length).toBe(manifest.counts.records);
  });
});

// ===========================================================================
// Attack battery — shard/record-level tampering
// ===========================================================================

describe("auditDataset — shard/record tampering", () => {
  it("catches an appended forged row (content copied+edited, no id)", async () => {
    const { outDir, manifest } = sharedExport();
    const shard = anyShardWith(manifest, 1);
    const lines = readShardLines(outDir, shard);
    const original = JSON.parse(lines[0]);
    expect(original.id).toBeUndefined(); // real shard lines never carry `id`
    const forged = { ...original, objective: original.objective + " FORGED" };
    lines.push(JSON.stringify(forged));
    writeShardLines(outDir, shard, lines);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("shard-hash-mismatch");
    expect(codes(report)).toContain("count-mismatch");
  });

  it("catches a single-character edit inside a row", async () => {
    const { outDir, manifest } = sharedExport();
    const shard = anyShardWith(manifest, 1);
    const lines = readShardLines(outDir, shard);
    const original = JSON.parse(lines[0]);
    lines[0] = JSON.stringify({ ...original, objective: original.objective + "x" });
    writeShardLines(outDir, shard, lines);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("shard-hash-mismatch");
    // Content-level edits with no embedded `id` field never trigger
    // record-id-mismatch (there is nothing stored to disagree with) — see
    // the dedicated record-id-mismatch test below for that narrower case.
    expect(codes(report)).not.toContain("record-id-mismatch");
  });

  it("catches a deleted row", async () => {
    const { outDir, manifest } = sharedExport();
    const shard = anyShardWith(manifest, 2);
    const lines = readShardLines(outDir, shard);
    lines.pop();
    writeShardLines(outDir, shard, lines);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("shard-hash-mismatch");
    expect(codes(report)).toContain("count-mismatch");
  });

  it("catches a byte-identical duplicated record (recomputed ids collide)", async () => {
    const { outDir, manifest } = sharedExport();
    const shard = anyShardWith(manifest, 1);
    const lines = readShardLines(outDir, shard);
    lines.push(lines[0]);
    writeShardLines(outDir, shard, lines);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("duplicate-record");
    expect(codes(report)).toContain("count-mismatch");
  });

  it("catches an embedded id that disagrees with the recomputed id", async () => {
    const { outDir, manifest } = sharedExport();
    const shard = anyShardWith(manifest, 1);
    const lines = readShardLines(outDir, shard);
    const original = JSON.parse(lines[0]);
    const forgedId = "0".repeat(64);
    lines[0] = JSON.stringify({ ...original, id: forgedId });
    writeShardLines(outDir, shard, lines);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.code === "record-id-mismatch");
    expect(finding).toBeDefined();
    expect(finding?.recordId).toBe(forgedId);
  });

  it("catches split labels swapped between a train row and a holdout row", async () => {
    const { outDir, manifest } = sharedExport();
    const trainShard = manifest.shards.find((s: any) => s.split === "train");
    const holdoutShard = manifest.shards.find((s: any) => s.split === "holdout");
    expect(trainShard).toBeDefined();
    expect(holdoutShard).toBeDefined();

    const trainLines = readShardLines(outDir, trainShard);
    const holdoutLines = readShardLines(outDir, holdoutShard);
    const trainRec = JSON.parse(trainLines[0]);
    const holdoutRec = JSON.parse(holdoutLines[0]);
    expect(trainRec.split).toBe("train");
    expect(holdoutRec.split).toBe("holdout");

    trainLines[0] = JSON.stringify({ ...trainRec, split: "holdout" });
    holdoutLines[0] = JSON.stringify({ ...holdoutRec, split: "train" });
    writeShardLines(outDir, trainShard, trainLines);
    writeShardLines(outDir, holdoutShard, holdoutLines);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    const misassigned = report.findings.filter((f) => f.code === "split-misassigned");
    expect(misassigned.length).toBe(2);
    const trajHashes = misassigned.map((f) => f.trajectorySha256).sort();
    expect(trajHashes).toEqual([trainRec.trajectorySha256, holdoutRec.trajectorySha256].sort());
  });

  it("catches a holdout row duplicated into train under a re-labelled split (split-leak)", async () => {
    const { outDir, manifest } = sharedExport();
    const holdoutShard = manifest.shards.find((s: any) => s.split === "holdout");
    const trainShard = manifest.shards.find((s: any) => s.split === "train");
    expect(holdoutShard).toBeDefined();
    expect(trainShard).toBeDefined();

    const holdoutLines = readShardLines(outDir, holdoutShard);
    const holdoutRec = JSON.parse(holdoutLines[0]);
    const dup = { ...holdoutRec, split: "train" };

    const trainLines = readShardLines(outDir, trainShard);
    trainLines.push(JSON.stringify(dup));
    writeShardLines(outDir, trainShard, trainLines);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    const leak = report.findings.find((f) => f.code === "split-leak");
    expect(leak).toBeDefined();
    expect(leak?.trajectorySha256).toBe(holdoutRec.trajectorySha256);
    expect(codes(report)).toContain("count-mismatch");
  });

  it("catches gzip corruption (garbage bytes) as decompress-failed, not a crash", async () => {
    const { outDir, manifest } = sharedExport();
    const shard = manifest.shards[0];
    writeFileSync(shardPath(outDir, shard), Buffer.from("this is not gzip data at all, just noise"));

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("decompress-failed");
    expect(report.records).toBeLessThan(manifest.counts.records);
  });

  it("catches a zero-byte shard as decompress-failed, not a crash", async () => {
    const { outDir, manifest } = sharedExport();
    const shard = manifest.shards[0];
    writeFileSync(shardPath(outDir, shard), Buffer.alloc(0));

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("decompress-failed");
  });

  it("catches a deleted (claimed-but-absent) shard file as shard-missing, not a crash", async () => {
    const { outDir, manifest } = sharedExport();
    const shard = manifest.shards[0];
    rmSync(shardPath(outDir, shard));

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("shard-missing");
    const finding = report.findings.find((f) => f.code === "shard-missing");
    expect(finding?.shard).toBe(shard.file);
  });
});

// ===========================================================================
// Attack battery — manifest-level tampering
// ===========================================================================

describe("auditDataset — manifest tampering", () => {
  it("catches an edited digest", async () => {
    const { outDir } = sharedExport();
    const manifest = readManifestRaw(outDir);
    manifest.digest = manifest.digest.startsWith("f") ? "0" + manifest.digest.slice(1) : "f" + manifest.digest.slice(1);
    writeManifestRaw(outDir, manifest);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("digest-mismatch");
  });

  it("catches specHash corrupted to well-formed-but-wrong hex (via digest-mismatch)", async () => {
    const { outDir } = sharedExport();
    const manifest = readManifestRaw(outDir);
    manifest.specHash = manifest.specHash.startsWith("a") ? "b" + manifest.specHash.slice(1) : "a" + manifest.specHash.slice(1);
    writeManifestRaw(outDir, manifest);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    // specHash is embedded verbatim in the digest preimage (`../exporter`'s
    // module doc), so an isolated specHash edit breaks the overall digest.
    expect(codes(report)).toContain("digest-mismatch");
  });

  it("catches specHash corrupted to structurally-invalid garbage", async () => {
    const { outDir } = sharedExport();
    const manifest = readManifestRaw(outDir);
    manifest.specHash = "not-a-sha256-digest";
    writeManifestRaw(outDir, manifest);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("spec-hash-mismatch");
  });

  it("catches edited counts (records)", async () => {
    const { outDir } = sharedExport();
    const manifest = readManifestRaw(outDir);
    manifest.counts.records += 1;
    writeManifestRaw(outDir, manifest);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("count-mismatch");
    // NOT digest-mismatch, and that is the correct behavior: the recomputed
    // digest is built from the counters this module INDEPENDENTLY re-derived
    // from the bytes on disk (records/train/holdout/redactions), which are
    // still the true ones, so it necessarily equals the untouched stored
    // digest. The tamper is caught exactly once, by the check that can
    // actually see it. An attacker who also re-derives `digest` over the
    // edited counts is caught by digest-mismatch instead — that is the
    // "catches an edited digest" case below.
    expect(codes(report)).not.toContain("digest-mismatch");
    // The recompute is reported, so the mismatch is inspectable rather than
    // merely asserted.
    expect(report.recomputedDigest).toBe(report.manifestDigest);
  });

  it("catches counts edited AND digest re-derived over them", async () => {
    const { outDir } = sharedExport();
    const manifest = readManifestRaw(outDir);
    manifest.counts.records += 1;
    const { digest: _stale, ...rest } = manifest;
    manifest.digest = datasetDigest(rest);
    writeManifestRaw(outDir, manifest);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("count-mismatch");
    expect(codes(report)).toContain("digest-mismatch");
    expect(report.recomputedDigest).not.toBe(report.manifestDigest);
  });

  it("catches an edited corpus.head, via digest-mismatch even without a corpus supplied", async () => {
    const { outDir } = sharedExport();
    const manifest = readManifestRaw(outDir);
    manifest.corpus.head = sha256Hex("a completely different, bogus corpus head");
    writeManifestRaw(outDir, manifest);

    const report = await auditDataset(outDir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("digest-mismatch");
  });

  it("catches an edited corpus.head specifically as corpus-head-mismatch when a real corpus is supplied", async () => {
    const { outDir } = sharedExport();
    const manifest = readManifestRaw(outDir);
    manifest.corpus.head = sha256Hex("a completely different, bogus corpus head");
    writeManifestRaw(outDir, manifest);

    const report = await auditDataset(outDir, { corpus: sharedCorpus });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("corpus-head-mismatch");
  });

  it("never throws on an empty directory", async () => {
    const root = freshRoot("hades-audit-edge-");
    const report = await auditDataset(root);
    expect(report.ok).toBe(false);
    expect(report.findings.length).toBe(1);
    expect(report.findings[0].code).toBe("manifest-unreadable");
  });

  it("never throws on a directory that does not exist at all", async () => {
    const report = await auditDataset(join(tmpdir(), "hades-audit-does-not-exist-xyz-12345"));
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe("manifest-unreadable");
  });

  it("never throws on a manifest that is valid JSON but the wrong shape", async () => {
    const root = freshRoot("hades-audit-badshape-");
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ hello: "world" }), "utf8");
    const report = await auditDataset(root);
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe("manifest-unreadable");
  });

  it("never throws on a manifest that is not valid JSON at all", async () => {
    const root = freshRoot("hades-audit-badjson-");
    writeFileSync(join(root, "manifest.json"), "{not json at all", "utf8");
    const report = await auditDataset(root);
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe("manifest-unreadable");
  });

  it("never throws on a future formatVersion", async () => {
    const root = freshRoot("hades-audit-future-");
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ formatVersion: 999 }), "utf8");
    const report = await auditDataset(root);
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe("future-format");
    expect(report.formatVersion).toBe(999);
  });
});

// ===========================================================================
// Corpus cross-check
// ===========================================================================

describe("auditDataset — corpus cross-check", () => {
  it("reports corpus-membership-missing for every record when audited against an unrelated corpus", async () => {
    const { outDir, manifest } = sharedExport();
    const otherRoot = freshRoot("hades-audit-other-corpus-");
    const otherCorpus = new VerifiedTrajectoryCorpus({ root: join(otherRoot, "corpus") });

    const report = await auditDataset(outDir, { corpus: otherCorpus });
    expect(report.ok).toBe(false);
    const missing = report.findings.filter((f) => f.code === "corpus-membership-missing");
    expect(missing.length).toBe(manifest.counts.records);
  });

  it("catches a certificate re-signed with a SECOND real key (signature/publicKey mismatch)", async () => {
    const root = freshRoot("hades-audit-resign-");
    const corpus = new VerifiedTrajectoryCorpus({ root: join(root, "corpus") });
    const entries = await admitN(corpus, 2);
    const { outDir } = doExport(corpus, root);

    const target = entries[0];
    const forgedByB = await caB.issue(target.certificate.payload);
    const corpusFile = join(root, "corpus", "corpus.jsonl");
    const rawLines = readFileSync(corpusFile, "utf8").split("\n").filter((l) => l.length > 0);
    const newLines = rawLines.map((line) => {
      const parsed = JSON.parse(line);
      if (parsed && parsed.trajectorySha256 === target.trajectorySha256) {
        // Keep the ORIGINAL publicKey (caA's) but splice in caB's signature
        // over the same payload — a self-inconsistent forged certificate.
        parsed.certificate = { ...parsed.certificate, signature: forgedByB.signature };
      }
      return JSON.stringify(parsed);
    });
    writeFileSync(corpusFile, newLines.join("\n") + "\n", "utf8");

    const mutatedCorpus = new VerifiedTrajectoryCorpus({ root: join(root, "corpus") });
    const report = await auditDataset(outDir, { corpus: mutatedCorpus });
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.code === "cert-signature-invalid");
    expect(finding).toBeDefined();
    expect(finding?.trajectorySha256).toBe(target.trajectorySha256);
    expect(report.certificatesFailed).toBeGreaterThanOrEqual(1);
  });

  it("catches a trajectory mutated post-hoc in the corpus (trace-hash-mismatch)", async () => {
    const root = freshRoot("hades-audit-tracehash-");
    const corpus = new VerifiedTrajectoryCorpus({ root: join(root, "corpus") });
    const entries = await admitN(corpus, 2);
    const { outDir } = doExport(corpus, root);

    const target = entries[0];
    const corpusFile = join(root, "corpus", "corpus.jsonl");
    const rawLines = readFileSync(corpusFile, "utf8").split("\n").filter((l) => l.length > 0);
    const newLines = rawLines.map((line) => {
      const parsed = JSON.parse(line);
      if (parsed && parsed.trajectorySha256 === target.trajectorySha256) {
        parsed.trajectory = { ...parsed.trajectory, objective: parsed.trajectory.objective + " (mutated post-hoc)" };
      }
      return JSON.stringify(parsed);
    });
    writeFileSync(corpusFile, newLines.join("\n") + "\n", "utf8");

    const mutatedCorpus = new VerifiedTrajectoryCorpus({ root: join(root, "corpus") });
    const report = await auditDataset(outDir, { corpus: mutatedCorpus });
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.code === "trace-hash-mismatch");
    expect(finding).toBeDefined();
    expect(finding?.trajectorySha256).toBe(target.trajectorySha256);
  });

  it("catches a record's label.pCorrect raised above its certificate's payload", async () => {
    const root = freshRoot("hades-audit-pcorrect-");
    const corpus = new VerifiedTrajectoryCorpus({ root: join(root, "corpus") });
    const entries = await admitN(corpus, 2);
    const { outDir, manifest } = doExport(corpus, root);

    const target = entries[0];
    const { shard, lines, idx, record } = locateRecordLine(outDir, manifest, target.trajectorySha256);
    expect(record.label.pCorrect).toBeCloseTo(target.certificate.payload.pCorrect, 10);
    record.label.pCorrect = Math.min(1, target.certificate.payload.pCorrect + 0.02);
    lines[idx] = JSON.stringify(record);
    writeShardLines(outDir, shard, lines);

    const report = await auditDataset(outDir, { corpus });
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.code === "label-exceeds-certificate");
    expect(finding).toBeDefined();
    expect(finding?.trajectorySha256).toBe(target.trajectorySha256);
  });

  it("catches a mock-tainted record re-labelled as real", async () => {
    const root = freshRoot("hades-audit-mocktaint-");
    const corpus = new VerifiedTrajectoryCorpus({ root: join(root, "corpus") });
    const entries = await admitN(corpus, 2, { mock: true });
    expect(entries.every((e) => e.provenance.realityClass === "mock-tainted")).toBe(true);

    const { outDir, manifest } = doExport(corpus, root, { filter: { realityClass: "mock-tainted" } });
    expect(manifest.counts.records).toBeGreaterThan(0);

    const target = entries[0];
    const { shard, lines, idx, record } = locateRecordLine(outDir, manifest, target.trajectorySha256);
    expect(record.label.realityClass).toBe("mock-tainted");
    record.label.realityClass = "real";
    lines[idx] = JSON.stringify(record);
    writeShardLines(outDir, shard, lines);

    const report = await auditDataset(outDir, { corpus });
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.code === "mock-labelled-real");
    expect(finding).toBeDefined();
    expect(finding?.trajectorySha256).toBe(target.trajectorySha256);
  });

  it("catches a record label.certSha256 that does not correspond to the corpus certificate", async () => {
    const root = freshRoot("hades-audit-certsha-");
    const corpus = new VerifiedTrajectoryCorpus({ root: join(root, "corpus") });
    const entries = await admitN(corpus, 2);
    const { outDir, manifest } = doExport(corpus, root);

    const target = entries[0];
    const { shard, lines, idx, record } = locateRecordLine(outDir, manifest, target.trajectorySha256);
    record.label.certSha256 = sha256Hex("a certSha256 that corresponds to nothing");
    lines[idx] = JSON.stringify(record);
    writeShardLines(outDir, shard, lines);

    const report = await auditDataset(outDir, { corpus });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("label-unverified");
  });

  it("verifySignatures:false skips cert-signature-invalid/trace-hash-mismatch but not membership", async () => {
    const { outDir } = sharedExport();
    const otherRoot = freshRoot("hades-audit-noverify-");
    const otherCorpus = new VerifiedTrajectoryCorpus({ root: join(otherRoot, "corpus") });

    const report = await auditDataset(outDir, { corpus: otherCorpus, verifySignatures: false });
    expect(report.certificatesVerified).toBe(0);
    expect(report.certificatesFailed).toBe(0);
    expect(codes(report)).toContain("corpus-membership-missing");
  });
});

// ===========================================================================
// Deterministic ordering + maxFindings capping
// ===========================================================================

describe("auditDataset — ordering and capping", () => {
  it("produces findings in stable (shard, recordId, code) order across repeated runs", async () => {
    const { outDir, manifest } = sharedExport();
    const manifestRaw = readManifestRaw(outDir);
    manifestRaw.counts.records += 5;
    writeManifestRaw(outDir, manifestRaw);
    for (const shard of manifest.shards.slice(0, 2)) {
      const lines = readShardLines(outDir, shard);
      const rec = JSON.parse(lines[0]);
      lines[0] = JSON.stringify({ ...rec, objective: rec.objective + " tampered" });
      writeShardLines(outDir, shard, lines);
    }

    const [reportA, reportB] = await Promise.all([auditDataset(outDir), auditDataset(outDir)]);
    expect(reportA.findings.length).toBeGreaterThan(1);
    expect(reportA.findings).toEqual(reportB.findings);

    for (let i = 1; i < reportA.findings.length; i++) {
      const prev = reportA.findings[i - 1];
      const cur = reportA.findings[i];
      const key = (f: (typeof reportA.findings)[number]) => `${f.shard ?? ""}\u0000${f.recordId ?? ""}\u0000${f.code}`;
      expect(key(prev) <= key(cur)).toBe(true);
    }
  });

  it("honestly caps findings at maxFindings and annotates the truncation", async () => {
    const { outDir, manifest } = sharedExport();
    // Tamper every shard so there is at least one finding per shard.
    for (const shard of manifest.shards) {
      const lines = readShardLines(outDir, shard);
      const rec = JSON.parse(lines[0]);
      lines[0] = JSON.stringify({ ...rec, objective: rec.objective + " tampered" });
      writeShardLines(outDir, shard, lines);
    }

    const full = await auditDataset(outDir);
    expect(full.findings.length).toBeGreaterThan(2);

    const capped = await auditDataset(outDir, { maxFindings: 2 });
    expect(capped.findings.length).toBe(2);
    expect(capped.findings[1].detail).toMatch(/more finding\(s\) suppressed; maxFindings=2/);
    // ok reflects the FULL finding set, not just the visible capped slice.
    expect(capped.ok).toBe(false);
  });

  it("maxFindings:0 returns no findings but still reports ok:false honestly", async () => {
    const { outDir, manifest } = sharedExport();
    const shard = manifest.shards[0];
    rmSync(shardPath(outDir, shard));

    const report = await auditDataset(outDir, { maxFindings: 0 });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(false);
  });
});

// ===========================================================================
// Performance sanity (>=5000 records, no quadratic blowup)
// ===========================================================================

describe("auditDataset — performance sanity", () => {
  it("audits a >=5000-record dataset without quadratic blowup", async () => {
    const root = freshRoot("hades-audit-perf-");
    const corpus = new VerifiedTrajectoryCorpus({ root: join(root, "corpus") });
    const N = 5_000;
    await admitN(corpus, N);
    const { outDir, manifest } = doExport(corpus, root, { shardSize: 500 });
    expect(manifest.counts.records).toBe(N);

    const startedAt = Date.now();
    const report = await auditDataset(outDir);
    const wallMs = Date.now() - startedAt;

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.records).toBe(N);
    // Generous ceiling: this is a sanity bound against O(n^2) blowup, not a
    // tight perf assertion — a linear-time audit of 5000 records (hashing,
    // JSON decode, Map-based dedup) should complete in low single-digit
    // seconds on ordinary hardware, nowhere near this ceiling.
    expect(wallMs).toBeLessThan(60_000);
  }, 300_000);
});

// ===========================================================================
// formatAuditReport
// ===========================================================================

describe("formatAuditReport", () => {
  it("renders plain ASCII with FATAL/WARN sections and no ANSI/HTML", async () => {
    const { outDir } = sharedExport();
    const manifest = readManifestRaw(outDir);
    manifest.digest = sha256Hex("bogus");
    writeManifestRaw(outDir, manifest);

    const report = await auditDataset(outDir);
    const lines = formatAuditReport(report);
    const text = lines.join("\n");
    expect(text).toContain("FATAL");
    expect(text).toContain("WARN");
    expect(text).toContain(outDir);
    expect(text).not.toMatch(/\x1b\[/);
    expect(text).not.toMatch(/<[a-zA-Z][^>]*>/);
  });

  it("shows zero findings on a clean report", async () => {
    const { outDir } = sharedExport();
    const report = await auditDataset(outDir);
    const lines = formatAuditReport(report);
    expect(lines.join("\n")).toContain("result:               OK");
  });
});

// ===========================================================================
// computeStats — hand-computed expectations
// ===========================================================================

function makeStatsRecord(overrides: Partial<TrainingRecord> = {}, idSeed = Math.random()): TrainingRecord {
  const base: TrainingRecord = {
    id: sha256Hex(`id-${idSeed}`),
    schemaVersion: 1,
    schema: "tool-trace",
    trajectorySha256: sha256Hex(`traj-${idSeed}`),
    objective: `objective ${idSeed}`,
    prompt: `objective ${idSeed}`,
    steps: [{ index: 0, tool: "read_file", ok: true, summary: "ok", repeat: 1 }],
    label: {
      verified: true,
      certSha256: sha256Hex(`cert-${idSeed}`),
      pCorrect: 0.9,
      epsilon: 0.05,
      verifierTier: "T2-genrm",
      verifierVersions: ["v1"],
      realityClass: "real",
      issuedAt: 1000,
    },
    split: "train",
    charCount: 10,
    tokensEstimate: 3,
    truncated: false,
    redactions: 0,
  };
  return { ...base, ...overrides, label: { ...base.label, ...(overrides.label ?? {}) } };
}

describe("computeStats", () => {
  it("returns all-zero/empty statistics for zero records, never NaN", () => {
    const s: DatasetStats = computeStats([]);
    expect(s.records).toBe(0);
    expect(s.train).toBe(0);
    expect(s.holdout).toBe(0);
    expect(s.bySchema).toEqual({});
    expect(s.byCapability).toEqual([]);
    expect(s.byTool).toEqual([]);
    expect(s.byModel).toEqual([]);
    expect(s.byRealityClass).toEqual({ real: 0, "mock-tainted": 0 });
    expect(s.distinctObjectives).toBe(0);
    expect(s.duplicateRate).toBe(0);
    expect(s.oldestIssuedAt).toBeNull();
    expect(s.newestIssuedAt).toBeNull();
    expect(s.redactions).toBe(0);
    for (const h of [s.pCorrect, s.epsilon, s.tokensEstimate, s.stepCount]) {
      expect(h.bins).toEqual([]);
      expect(h.min).toBe(0);
      expect(h.max).toBe(0);
      expect(h.mean).toBe(0);
      expect(h.p50).toBe(0);
      expect(h.p90).toBe(0);
      expect(Number.isNaN(h.mean)).toBe(false);
    }
  });

  it("handles exactly one record: single closed bin, all stats equal that value", () => {
    const r = makeStatsRecord({ tokensEstimate: 42 }, 1);
    const s = computeStats([r]);
    expect(s.records).toBe(1);
    expect(s.tokensEstimate.bins).toEqual([{ lo: 42, hi: 42, count: 1 }]);
    expect(s.tokensEstimate.min).toBe(42);
    expect(s.tokensEstimate.max).toBe(42);
    expect(s.tokensEstimate.mean).toBe(42);
    expect(s.tokensEstimate.p50).toBe(42);
    expect(s.tokensEstimate.p90).toBe(42);
  });

  it("matches hand-computed percentiles/bins/mean for tokensEstimate = [1..10]", () => {
    const records = Array.from({ length: 10 }, (_, i) => makeStatsRecord({ tokensEstimate: i + 1 }, i));
    const s = computeStats(records);
    const h = s.tokensEstimate;
    expect(h.min).toBe(1);
    expect(h.max).toBe(10);
    expect(h.mean).toBeCloseTo(5.5, 10);
    // Linear interpolation between closest ranks: p50 idx = 0.5*9 = 4.5 -> between sorted[4]=5, sorted[5]=6.
    expect(h.p50).toBeCloseTo(5.5, 10);
    // p90 idx = 0.9*9 = 8.1 -> between sorted[8]=9, sorted[9]=10, frac 0.1.
    expect(h.p90).toBeCloseTo(9.1, 10);
    expect(h.bins.length).toBe(10);
    expect(h.bins.every((b) => b.count === 1)).toBe(true);
    expect(h.bins[0].lo).toBe(1);
    expect(h.bins[0].hi).toBeCloseTo(1.9, 10);
    expect(h.bins[h.bins.length - 1].hi).toBe(10); // final bin is closed at max
    expect(h.bins.reduce((sum, b) => sum + b.count, 0)).toBe(10);
  });

  it("computes distinctObjectives and duplicateRate against distinct trajectorySha256", () => {
    const traj = sha256Hex("shared-trajectory");
    const r1 = makeStatsRecord({ trajectorySha256: traj, objective: "same objective text", split: "train" }, 1);
    const r2 = makeStatsRecord({ trajectorySha256: traj, objective: "same objective text", split: "holdout" }, 2);
    const r3 = makeStatsRecord({ objective: "a different objective" }, 3);
    const s = computeStats([r1, r2, r3]);
    expect(s.records).toBe(3);
    // r1 and r3 are train (makeStatsRecord's default split), r2 is holdout.
    expect(s.train).toBe(2);
    expect(s.holdout).toBe(1);
    expect(s.train + s.holdout).toBe(s.records);
    expect(s.distinctObjectives).toBe(2);
    // 3 records, 2 distinct trajectories -> duplicateRate = (3-2)/3.
    expect(s.duplicateRate).toBeCloseTo(1 / 3, 10);
  });

  it("aggregates byTool from tool-trace steps[] and chat-messages tool-role messages only", () => {
    const toolTrace = makeStatsRecord(
      {
        schema: "tool-trace",
        steps: [
          { index: 0, tool: "grep", ok: true, summary: "s", repeat: 1 },
          { index: 1, tool: "edit_file", ok: true, summary: "s", repeat: 1 },
        ],
      },
      1,
    );
    const chat = makeStatsRecord(
      {
        schema: "chat-messages",
        steps: undefined,
        prompt: undefined,
        messages: [
          { role: "user", content: "go" },
          { role: "tool", name: "grep", content: "found it" },
        ],
      },
      2,
    );
    const sft = makeStatsRecord(
      { schema: "sft-prompt-completion", steps: undefined, prompt: "p", completion: "- grep (ok): x" },
      3,
    );
    const s = computeStats([toolTrace, chat, sft]);
    const byTool = Object.fromEntries(s.byTool.map((t) => [t.key, t.count]));
    expect(byTool.grep).toBe(2); // one from tool-trace, one from chat-messages
    expect(byTool.edit_file).toBe(1);
    expect(Object.keys(byTool).length).toBe(2); // sft-prompt-completion contributes nothing
    expect(s.byCapability).toEqual([]);
    expect(s.byModel).toEqual([]);
  });

  it("tracks oldest/newest issuedAt and total redactions", () => {
    const r1 = makeStatsRecord({ label: { issuedAt: 500 } as any, redactions: 2 }, 1);
    const r2 = makeStatsRecord({ label: { issuedAt: 1500 } as any, redactions: 3 }, 2);
    const s = computeStats([r1, r2]);
    expect(s.oldestIssuedAt).toBe(500);
    expect(s.newestIssuedAt).toBe(1500);
    expect(s.redactions).toBe(5);
  });

  it("tallies byRealityClass exhaustively over both known classes", () => {
    const r1 = makeStatsRecord({ label: { realityClass: "real" } as any }, 1);
    const r2 = makeStatsRecord({ label: { realityClass: "mock-tainted" } as any }, 2);
    const s = computeStats([r1, r2]);
    expect(s.byRealityClass).toEqual({ real: 1, "mock-tainted": 1 });
  });
});

// ===========================================================================
// computeStats against a REAL exported dataset (end-to-end sanity)
// ===========================================================================

describe("computeStats + readDatasetRecords — end to end", () => {
  it("computes stats over a real exported dataset that sum consistently", async () => {
    const { outDir, manifest } = sharedExport();
    const { records, errors } = readDatasetRecords(outDir);
    expect(errors).toEqual([]);
    const stats = computeStats(records);
    expect(stats.records).toBe(manifest.counts.records);
    expect(stats.train + stats.holdout).toBe(stats.records);
    expect(stats.train).toBe(manifest.counts.train);
    expect(stats.holdout).toBe(manifest.counts.holdout);
    expect(stats.redactions).toBe(manifest.counts.redactions);
    expect(stats.bySchema["tool-trace"]).toBe(stats.records);
  });
});

// ===========================================================================
// formatStatsReport
// ===========================================================================

describe("formatStatsReport", () => {
  it("renders plain ASCII, labels tokensEstimate as an estimate, no ANSI/HTML", () => {
    const records = Array.from({ length: 5 }, (_, i) => makeStatsRecord({ tokensEstimate: i + 1 }, i));
    const s = computeStats(records);
    const lines = formatStatsReport(s);
    const text = lines.join("\n");
    expect(text).toContain("Dataset statistics");
    expect(text).toContain("ESTIMATE");
    expect(text).not.toMatch(/\x1b\[/);
    expect(text).not.toMatch(/<[a-zA-Z][^>]*>/);
  });

  it("handles the zero-record case without throwing or emitting NaN text", () => {
    const s = computeStats([]);
    const lines = formatStatsReport(s);
    const text = lines.join("\n");
    expect(text).not.toMatch(/NaN/);
  });
});
