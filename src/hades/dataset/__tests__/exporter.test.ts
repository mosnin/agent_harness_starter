/* ------------------------------------------------------------------ *
 * exporter.test.ts
 *
 * REAL-VS-MOCK POLICY: sha256 is always real (`sha256Hex`/`createHash` via
 * `node:crypto`); gzip is always real `node:zlib`. Certificates on entries
 * built directly (bypassing `VerifiedTrajectoryCorpus.admit`) carry
 * FABRICATED signature/publicKey hex strings — this is legitimate and
 * necessary: `exportDataset` on a raw `CorpusEntry[]` never verifies
 * signatures (only `VerifiedTrajectoryCorpus.verifyChain()` does chain-hash
 * verification, and that path is exercised separately below with a REAL
 * `CertificateAuthority`, mirroring `corpus.test.ts`). No pCorrect, epsilon,
 * digest, or hash value asserted on below is fabricated — every expectation
 * is either computed independently the same way the module under test does,
 * or read back from a real gzip/JSON round-trip.
 * ------------------------------------------------------------------ */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  canonicalize,
  type CertificatePayload,
  type VerificationCertificate,
} from "../../styx/certificate";
import { canonicalTrajectoryJson, type VerifiedTrajectory } from "../../skills/synthesize";
import type { GoalTrajectory, TaskTrajectory, ToolEvent } from "../../research/recorder";
import {
  VerifiedTrajectoryCorpus,
  DATASET_CORPUS_GENESIS,
  type CorpusEntry,
  type CorpusProvenance,
} from "../corpus";
import type { TrainingRecord } from "../example";
import {
  DATASET_FORMAT_VERSION,
  normalizeSpec,
  specHash,
  datasetDigest,
  canonicalManifestJson,
  exportDataset,
  readManifest,
  formatExportReport,
  ExportRefusal,
  type ExportSpec,
  type ExportIo,
  type DatasetManifest,
  type ExportResult,
} from "../exporter";

// ===========================================================================
// Fixtures
// ===========================================================================

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}
const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(21)));

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

/** Builds a well-shaped `CorpusEntry` directly, without going through
 *  `VerifiedTrajectoryCorpus.admit()` — fast (no real ed25519 signing) and
 *  sufficient for every test that does not specifically exercise
 *  chain-hash verification (see the "VerifiedTrajectoryCorpus source"
 *  describe block below for that). `hash`/`prevHash` are a simple, real,
 *  deterministic sha256 chain (not `canonicalizeCorpusEntry`'s exact
 *  formula — `exportDataset` never recomputes those for an array source). */
function makeEntry(opts: {
  seq: number;
  prevHash: string;
  uniq?: string;
  trajectoryOverrides?: Partial<GoalTrajectory>;
  payloadOverrides?: Partial<CertificatePayload>;
  provenanceOverrides?: Partial<CorpusProvenance>;
  admittedAt?: number;
}): CorpusEntry {
  const uniq = opts.uniq ?? `e${opts.seq}`;
  const trajectory = goal(uniq, opts.trajectoryOverrides);
  const trajectorySha256 = sha256Hex(canonicalTrajectoryJson(trajectory));
  const payload = payloadFor(trajectory, { traceSha256: trajectorySha256, ...opts.payloadOverrides });
  const certificate: VerificationCertificate = {
    payload,
    signature: "ab".repeat(32),
    publicKey: "cd".repeat(32),
  };
  const certSha256 = sha256Hex(canonicalize(payload));
  const provenance: CorpusProvenance = {
    source: "run",
    recordedAt: opts.admittedAt ?? 1_700_000_000_000 + opts.seq,
    realityClass: "real",
    mockMarkers: [],
    ...opts.provenanceOverrides,
  };
  const hash = sha256Hex(`fake-chain-hash|${opts.seq}|${trajectorySha256}`);
  return {
    seq: opts.seq,
    trajectorySha256,
    certSha256,
    label: "verified",
    trajectory,
    certificate,
    provenance,
    admittedAt: opts.admittedAt ?? 1_700_000_000_000 + opts.seq,
    prevHash: opts.prevHash,
    hash,
  };
}

/** A chain of `n` entries with real (fabricated-cert) linkage from `genesis`. */
function buildChain(n: number, opts: { genesis?: string; uniqPrefix?: string; mockEvery?: number } = {}): CorpusEntry[] {
  const genesis = opts.genesis ?? sha256Hex("test-chain-genesis");
  const entries: CorpusEntry[] = [];
  let prevHash = genesis;
  for (let i = 0; i < n; i++) {
    const uniq = `${opts.uniqPrefix ?? "c"}${i}`;
    const isMock = opts.mockEvery !== undefined && i % opts.mockEvery === 0 && i > 0;
    const e = makeEntry({
      seq: i,
      prevHash,
      uniq,
      provenanceOverrides: isMock ? { realityClass: "mock-tainted", mockMarkers: ["[mock]"] } : {},
    });
    entries.push(e);
    prevHash = e.hash;
  }
  return entries;
}

async function verifiedFixture(uniq: string, overrides: Partial<GoalTrajectory> = {}): Promise<VerifiedTrajectory> {
  const trajectory = goal(uniq, overrides);
  const payload = payloadFor(trajectory);
  const certificate = await ca.issue(payload);
  return { trajectory, certificate };
}

const realIo: ExportIo = {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  rmSync,
  readdirSync,
};

function faultyIo(cfg: { failMkdir?: boolean; failWriteCall?: number; failRenameCall?: number }): ExportIo {
  let writeCalls = 0;
  let renameCalls = 0;
  return {
    mkdirSync: ((...args: unknown[]) => {
      if (cfg.failMkdir) throw new Error("injected mkdir failure");
      return (mkdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof mkdirSync,
    writeFileSync: ((...args: unknown[]) => {
      writeCalls++;
      if (cfg.failWriteCall === writeCalls) throw new Error(`injected write failure #${writeCalls}`);
      return (writeFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof writeFileSync,
    readFileSync,
    existsSync,
    renameSync: ((...args: unknown[]) => {
      renameCalls++;
      if (cfg.failRenameCall === renameCalls) throw new Error(`injected rename failure #${renameCalls}`);
      return (renameSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof renameSync,
    rmSync,
    readdirSync,
  };
}

function countingIo(): { io: ExportIo; writeCalls: { path: string; bytes: number }[] } {
  const writeCalls: { path: string; bytes: number }[] = [];
  const io: ExportIo = {
    ...realIo,
    writeFileSync: ((...args: unknown[]) => {
      const [path, data] = args as [string, string | Buffer];
      const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
      writeCalls.push({ path: String(path), bytes });
      return (writeFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof writeFileSync,
  };
  return { io, writeCalls };
}

function readShardText(dir: string, file: string): string {
  const raw = readFileSync(join(dir, file));
  return file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
}

function readShardRecords(dir: string, file: string): TrainingRecord[] {
  const text = readShardText(dir, file);
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines.map((l) => JSON.parse(l) as TrainingRecord);
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-exporter-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// normalizeSpec
// ===========================================================================

describe("normalizeSpec", () => {
  it("defaults filter.realityClass to 'real' (mock-tainted excluded by default)", () => {
    const spec = normalizeSpec({});
    expect(spec.filter.realityClass).toBe("real");
  });

  it("honors an explicit filter.realityClass of 'mock-tainted'", () => {
    const spec = normalizeSpec({ filter: { realityClass: "mock-tainted" } });
    expect(spec.filter.realityClass).toBe("mock-tainted");
  });

  it("fills schema, shardSize, compression, holdoutFraction defaults", () => {
    const spec = normalizeSpec({});
    expect(spec.schema).toBe("sft-prompt-completion");
    expect(spec.shardSize).toBeGreaterThan(0);
    expect(spec.compression).toBe("gzip");
    expect(spec.holdoutFraction).toBeCloseTo(0.1);
  });

  it("forces encode.schema/holdoutFraction/holdoutSalt to mirror the top-level fields", () => {
    const spec = normalizeSpec({
      schema: "chat-messages",
      holdoutFraction: 0.25,
      holdoutSalt: "salt-x",
      encode: { schema: "tool-trace", holdoutFraction: 0.9 } as unknown as ExportSpec["encode"],
    });
    expect(spec.encode.schema).toBe("chat-messages");
    expect(spec.encode.holdoutFraction).toBe(0.25);
    expect(spec.encode.holdoutSalt).toBe("salt-x");
  });

  it("preserves an explicit filter.limit/capability/model/since/until/minPCorrect/maxEpsilon", () => {
    const spec = normalizeSpec({
      filter: { capability: "web", model: "m1", since: 1, until: 2, minPCorrect: 0.5, maxEpsilon: 0.2, limit: 7 },
    });
    expect(spec.filter).toMatchObject({
      capability: "web",
      model: "m1",
      since: 1,
      until: 2,
      minPCorrect: 0.5,
      maxEpsilon: 0.2,
      limit: 7,
    });
  });
});

// ===========================================================================
// specHash / datasetDigest / canonicalManifestJson — pure canonicalization
// ===========================================================================

describe("specHash", () => {
  it("is deterministic for the same normalized spec", () => {
    const spec = normalizeSpec({ shardSize: 50 });
    expect(specHash(spec)).toBe(specHash(normalizeSpec({ shardSize: 50 })));
  });

  it("is independent of object key construction order", () => {
    const a: ExportSpec = normalizeSpec({ shardSize: 10, compression: "none" });
    const b: ExportSpec = {
      compression: a.compression,
      shardSize: a.shardSize,
      filter: a.filter,
      encode: a.encode,
      holdoutFraction: a.holdoutFraction,
      holdoutSalt: a.holdoutSalt,
      schema: a.schema,
    };
    expect(specHash(a)).toBe(specHash(b));
  });

  it("changes when a RegExp-bearing redaction pattern's source changes", () => {
    const base = normalizeSpec({ encode: { schema: "sft-prompt-completion", redaction: { replacement: "[R]", redactHomePaths: false, patterns: [{ name: "x", re: /abc/g }] } } });
    const changed = normalizeSpec({ encode: { schema: "sft-prompt-completion", redaction: { replacement: "[R]", redactHomePaths: false, patterns: [{ name: "x", re: /xyz/g }] } } });
    expect(specHash(base)).not.toBe(specHash(changed));
  });

  for (const [label, mutate] of [
    ["schema", (s: Partial<ExportSpec>) => ({ ...s, schema: "chat-messages" as const })],
    ["filter", (s: Partial<ExportSpec>) => ({ ...s, filter: { capability: "web" } })],
    ["shardSize", (s: Partial<ExportSpec>) => ({ ...s, shardSize: 42 })],
    ["compression", (s: Partial<ExportSpec>) => ({ ...s, compression: "none" as const })],
    ["holdoutFraction", (s: Partial<ExportSpec>) => ({ ...s, holdoutFraction: 0.33 })],
    ["holdoutSalt", (s: Partial<ExportSpec>) => ({ ...s, holdoutSalt: "different-salt" })],
    [
      "encode option (maxSteps)",
      (s: Partial<ExportSpec>) => ({ ...s, encode: { schema: "sft-prompt-completion" as const, maxSteps: 3 } }),
    ],
  ] as const) {
    it(`changes when ${label} changes (spec sensitivity)`, () => {
      const base = normalizeSpec({});
      const mutated = normalizeSpec(mutate({}));
      expect(specHash(mutated)).not.toBe(specHash(base));
    });
  }
});

describe("datasetDigest", () => {
  function baseManifestWithoutDigest(overrides: Partial<Omit<DatasetManifest, "digest">> = {}): Omit<DatasetManifest, "digest"> {
    const spec = normalizeSpec({});
    return {
      formatVersion: DATASET_FORMAT_VERSION,
      createdAt: 111,
      generator: { name: "hades", phase: 19 },
      specHash: specHash(spec),
      spec,
      corpus: { genesis: "g".repeat(64), head: "h".repeat(64), entriesScanned: 3, verifiedOnly: true },
      shards: [
        { index: 0, split: "train", file: "train-000.jsonl.gz", records: 2, bytesRaw: 10, bytesStored: 8, sha256Raw: "a".repeat(64), sha256Stored: "b".repeat(64) },
      ],
      counts: { records: 2, train: 2, holdout: 0, skipped: 0, redactions: 0, mockTaintedExcluded: 0, duplicatesDropped: 0 },
      skips: [],
      ...overrides,
    };
  }

  it("is unaffected by createdAt", () => {
    const a = baseManifestWithoutDigest({ createdAt: 1 });
    const b = baseManifestWithoutDigest({ createdAt: 999_999_999 });
    expect(datasetDigest(a)).toBe(datasetDigest(b));
  });

  it("changes when a shard's sha256Raw changes", () => {
    const a = baseManifestWithoutDigest();
    const b = baseManifestWithoutDigest({ shards: [{ ...a.shards[0], sha256Raw: "c".repeat(64) }] });
    expect(datasetDigest(a)).not.toBe(datasetDigest(b));
  });

  it("changes when specHash changes", () => {
    const a = baseManifestWithoutDigest();
    const b = baseManifestWithoutDigest({ specHash: "z".repeat(64) });
    expect(datasetDigest(a)).not.toBe(datasetDigest(b));
  });

  it("changes when counts change", () => {
    const a = baseManifestWithoutDigest();
    const b = baseManifestWithoutDigest({ counts: { ...a.counts, skipped: 5 } });
    expect(datasetDigest(a)).not.toBe(datasetDigest(b));
  });

  it("never contains any obviously-path-shaped substring for a POSIX-style outDir", () => {
    const m = baseManifestWithoutDigest();
    const d = datasetDigest(m);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonicalManifestJson", () => {
  it("round-trips through JSON.parse and is stable across field-order permutations", () => {
    const spec = normalizeSpec({});
    const withoutDigest = {
      formatVersion: DATASET_FORMAT_VERSION,
      createdAt: 1,
      generator: { phase: 19 as const, name: "hades" as const },
      specHash: specHash(spec),
      spec,
      corpus: { head: "h".repeat(64), genesis: "g".repeat(64), verifiedOnly: true as const, entriesScanned: 0 },
      shards: [],
      counts: { duplicatesDropped: 0, records: 0, train: 0, holdout: 0, skipped: 0, redactions: 0, mockTaintedExcluded: 0 },
      skips: [],
    };
    const digest = datasetDigest(withoutDigest);
    const manifest: DatasetManifest = { ...withoutDigest, digest };
    const json = canonicalManifestJson(manifest);
    expect(JSON.parse(json)).toEqual(JSON.parse(canonicalManifestJson(manifest)));
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

// ===========================================================================
// exportDataset — raw CorpusEntry[] source: basic behavior
// ===========================================================================

describe("exportDataset — basic export from a raw entry array", () => {
  it("exports train/holdout shards whose decompressed content matches the entries, gzip by default", () => {
    const entries = buildChain(6);
    const outDir = join(root, "ds1");
    const result = exportDataset(entries, { shardSize: 100, holdoutFraction: 0 }, { outDir, io: realIo, now: () => 555 });

    expect(result.manifest.formatVersion).toBe(DATASET_FORMAT_VERSION);
    expect(result.manifest.counts.records).toBe(6);
    expect(result.manifest.counts.train).toBe(6);
    expect(result.manifest.counts.holdout).toBe(0);
    expect(result.manifest.shards).toHaveLength(1);
    expect(result.manifest.shards[0].file).toBe("train-000.jsonl.gz");

    const records = readShardRecords(outDir, "train-000.jsonl.gz");
    expect(records).toHaveLength(6);
    const gotIds = new Set(records.map((r) => r.trajectorySha256));
    for (const e of entries) expect(gotIds.has(e.trajectorySha256)).toBe(true);

    // Canonical ordering: ascending trajectorySha256.
    const sortedHashes = [...entries.map((e) => e.trajectorySha256)].sort();
    expect(records.map((r) => r.trajectorySha256)).toEqual(sortedHashes);

    expect(existsSync(join(outDir, "manifest.json"))).toBe(true);
  });

  it("writes uncompressed shards when compression is 'none'", () => {
    const entries = buildChain(3);
    const outDir = join(root, "ds-none");
    const result = exportDataset(entries, { compression: "none", holdoutFraction: 0 }, { outDir, io: realIo });
    const file = result.manifest.shards[0].file;
    expect(file.endsWith(".gz")).toBe(false);
    const raw = readFileSync(join(outDir, file), "utf8");
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(3);
    expect(result.manifest.shards[0].sha256Raw).toBe(result.manifest.shards[0].sha256Stored);
  });

  it("splits records into train/holdout shards by holdoutFraction=1 (all holdout)", () => {
    const entries = buildChain(4);
    const outDir = join(root, "ds-holdout");
    const result = exportDataset(entries, { holdoutFraction: 1 }, { outDir, io: realIo });
    expect(result.manifest.counts.train).toBe(0);
    expect(result.manifest.counts.holdout).toBe(4);
    expect(result.manifest.shards.every((s) => s.split === "holdout")).toBe(true);
  });
});

// ===========================================================================
// (f) exclusion visibility + (e) empty/degenerate
// ===========================================================================

describe("exclusion visibility and degenerate corpora", () => {
  it("excludes mock-tainted entries by default and counts them, honestly", () => {
    const entries = buildChain(10, { mockEvery: 3 }); // seq 3,6,9 are mock-tainted -> 3 excluded, 7 real
    const outDir = join(root, "ds-mock");
    const result = exportDataset(entries, { holdoutFraction: 0 }, { outDir, io: realIo });
    expect(result.manifest.counts.mockTaintedExcluded).toBe(3);
    expect(result.manifest.counts.records).toBe(7);
    const sum =
      result.manifest.counts.records +
      result.manifest.counts.skipped +
      result.manifest.counts.mockTaintedExcluded +
      result.manifest.counts.duplicatesDropped;
    expect(sum).toBe(result.manifest.corpus.entriesScanned);
  });

  it("includes mock-tainted entries when explicitly requested", () => {
    const entries = buildChain(5, { mockEvery: 2 });
    const outDir = join(root, "ds-mock-included");
    const result = exportDataset(entries, { filter: { realityClass: "mock-tainted" } }, { outDir, io: realIo });
    expect(result.manifest.counts.records).toBeGreaterThan(0);
    const records = result.manifest.shards.flatMap((s) => readShardRecords(outDir, s.file));
    expect(records.every((r) => r.label.realityClass === "mock-tainted")).toBe(true);
  });

  it("drops exact-duplicate trajectorySha256 entries and counts them", () => {
    const a = makeEntry({ seq: 0, prevHash: DATASET_CORPUS_GENESIS, uniq: "dup" });
    const b = { ...a, seq: 1 }; // identical trajectory -> identical trajectorySha256
    const outDir = join(root, "ds-dup");
    const result = exportDataset([a, b], {}, { outDir, io: realIo });
    expect(result.manifest.counts.duplicatesDropped).toBe(1);
    expect(result.manifest.counts.records).toBe(1);
  });

  it("counts encodeExample skips (e.g. empty objective) honestly and sums to entriesScanned", () => {
    const good = makeEntry({ seq: 0, prevHash: DATASET_CORPUS_GENESIS, uniq: "good" });
    const bad = makeEntry({
      seq: 1,
      prevHash: DATASET_CORPUS_GENESIS,
      uniq: "bad",
      trajectoryOverrides: { objective: "   " },
    });
    const outDir = join(root, "ds-skip");
    const result = exportDataset([good, bad], {}, { outDir, io: realIo });
    expect(result.manifest.counts.skipped).toBe(1);
    expect(result.manifest.skips).toEqual([{ code: "empty-objective", count: 1 }]);
    const sum =
      result.manifest.counts.records +
      result.manifest.counts.skipped +
      result.manifest.counts.mockTaintedExcluded +
      result.manifest.counts.duplicatesDropped;
    expect(sum).toBe(result.manifest.corpus.entriesScanned);
  });

  it("produces a VALID zero-shard manifest with a real digest for an empty selection", () => {
    const outDir = join(root, "ds-empty");
    const result = exportDataset([], {}, { outDir, io: realIo });
    expect(result.manifest.shards).toEqual([]);
    expect(result.manifest.counts.records).toBe(0);
    expect(result.manifest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(outDir, "manifest.json"))).toBe(true);
  });

  it("produces a valid zero-shard manifest when every entry is filtered out", () => {
    const entries = buildChain(4, { mockEvery: 1 }).map((e) => ({
      ...e,
      provenance: { ...e.provenance, realityClass: "mock-tainted" as const, mockMarkers: ["[mock]"] },
    }));
    const outDir = join(root, "ds-all-filtered");
    const result = exportDataset(entries, {}, { outDir, io: realIo });
    expect(result.manifest.shards).toEqual([]);
    expect(result.manifest.counts.mockTaintedExcluded).toBe(4);
    expect(result.manifest.counts.records).toBe(0);
  });
});

// ===========================================================================
// (a) Reproducibility
// ===========================================================================

describe("reproducibility", () => {
  it("produces an identical digest across different injected clocks (createdAt differs, digest does not)", () => {
    const entries = buildChain(9);
    const r1 = exportDataset(entries, { shardSize: 4 }, { outDir: join(root, "clockA"), io: realIo, now: () => 1 });
    const r2 = exportDataset(entries, { shardSize: 4 }, { outDir: join(root, "clockB"), io: realIo, now: () => 999_999 });
    expect(r1.manifest.createdAt).not.toBe(r2.manifest.createdAt);
    expect(r1.manifest.digest).toBe(r2.manifest.digest);
    expect(r1.manifest.shards.map((s) => s.sha256Raw)).toEqual(r2.manifest.shards.map((s) => s.sha256Raw));
    expect(r1.manifest.shards.map((s) => s.sha256Stored)).toEqual(r2.manifest.shards.map((s) => s.sha256Stored));
  });

  it("produces an identical digest regardless of input array (admission) order", () => {
    const entries = buildChain(9);
    const shuffled = [entries[4], entries[0], entries[8], entries[1], entries[7], entries[2], entries[6], entries[3], entries[5]];
    const r1 = exportDataset(entries, { shardSize: 4 }, { outDir: join(root, "orderA"), io: realIo });
    const r2 = exportDataset(shuffled, { shardSize: 4 }, { outDir: join(root, "orderB"), io: realIo });
    expect(r1.manifest.digest).toBe(r2.manifest.digest);
    expect(r1.manifest.shards).toEqual(r2.manifest.shards);
  });

  it("produces identical digest and shard bytes regardless of outDir", () => {
    const entries = buildChain(7);
    const r1 = exportDataset(entries, {}, { outDir: join(root, "deep", "nested", "out1"), io: realIo });
    const r2 = exportDataset(entries, {}, { outDir: join(root, "out2"), io: realIo });
    expect(r1.manifest.digest).toBe(r2.manifest.digest);
    for (let i = 0; i < r1.manifest.shards.length; i++) {
      const s1 = r1.manifest.shards[i];
      const s2 = r2.manifest.shards[i];
      const b1 = readFileSync(join(r1.outDir, s1.file));
      const b2 = readFileSync(join(r2.outDir, s2.file));
      expect(b1.equals(b2)).toBe(true);
    }
  });

  it("produces an identical digest from a freshly (independently) constructed but equal entry set", () => {
    const entriesA = buildChain(5, { uniqPrefix: "fresh" });
    const entriesB = buildChain(5, { uniqPrefix: "fresh" }); // independently built, same content
    const r1 = exportDataset(entriesA, {}, { outDir: join(root, "freshA"), io: realIo });
    const r2 = exportDataset(entriesB, {}, { outDir: join(root, "freshB"), io: realIo });
    expect(r1.manifest.digest).toBe(r2.manifest.digest);
  });

  it("exact shard rollover: an exact multiple of shardSize yields no short final shard", () => {
    const entries = buildChain(8);
    const outDir = join(root, "exact-multiple");
    const result = exportDataset(entries, { shardSize: 4, holdoutFraction: 0 }, { outDir, io: realIo });
    expect(result.manifest.shards).toHaveLength(2);
    expect(result.manifest.shards.every((s) => s.records === 4)).toBe(true);
  });

  it("exact shard rollover: a non-multiple yields a short final shard", () => {
    const entries = buildChain(10);
    const outDir = join(root, "short-final");
    const result = exportDataset(entries, { shardSize: 4, holdoutFraction: 0 }, { outDir, io: realIo });
    expect(result.manifest.shards.map((s) => s.records)).toEqual([4, 4, 2]);
  });
});

// ===========================================================================
// (c) Atomicity + dir-exists / overwrite
// ===========================================================================

describe("atomic publication", () => {
  it("refuses with 'dir-exists' when outDir already exists and is non-empty, without overwrite", () => {
    const outDir = join(root, "existing");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "sentinel.txt"), "keep me", "utf8");
    expect(() => exportDataset(buildChain(2), {}, { outDir, io: realIo })).toThrow(ExportRefusal);
    try {
      exportDataset(buildChain(2), {}, { outDir, io: realIo });
    } catch (err) {
      expect(err).toBeInstanceOf(ExportRefusal);
      expect((err as ExportRefusal).code).toBe("dir-exists");
    }
    expect(readFileSync(join(outDir, "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("publishes into an existing but EMPTY outDir without requiring overwrite", () => {
    const outDir = join(root, "empty-existing");
    mkdirSync(outDir, { recursive: true });
    const result = exportDataset(buildChain(2), {}, { outDir, io: realIo });
    expect(result.manifest.counts.records).toBe(2);
  });

  it("overwrite:true atomically replaces a previous dataset's contents", () => {
    const outDir = join(root, "overwrite-me");
    const first = exportDataset(buildChain(3, { uniqPrefix: "first" }), { holdoutFraction: 0 }, { outDir, io: realIo });
    const second = exportDataset(
      buildChain(5, { uniqPrefix: "second" }),
      { holdoutFraction: 0 },
      { outDir, io: realIo, overwrite: true },
    );
    expect(second.manifest.counts.records).toBe(5);
    expect(second.manifest.digest).not.toBe(first.manifest.digest);
    const onDisk = readManifest(outDir, realIo);
    expect(onDisk.digest).toBe(second.manifest.digest);
  });

  it("without overwrite:true, refuses and leaves the previous dataset fully intact", () => {
    const outDir = join(root, "no-overwrite");
    const first = exportDataset(buildChain(3), {}, { outDir, io: realIo });
    expect(() => exportDataset(buildChain(4), {}, { outDir, io: realIo })).toThrow(ExportRefusal);
    const onDisk = readManifest(outDir, realIo);
    expect(onDisk.digest).toBe(first.manifest.digest);
  });

  it("io failure at mkdir raises io-failed and never creates outDir", () => {
    const outDir = join(root, "fail-mkdir");
    const io = faultyIo({ failMkdir: true });
    expect(() => exportDataset(buildChain(2), {}, { outDir, io })).toThrow(ExportRefusal);
    expect(existsSync(outDir)).toBe(false);
  });

  it("io failure at the FIRST shard write raises io-failed and never creates outDir", () => {
    const outDir = join(root, "fail-first-shard");
    const io = faultyIo({ failWriteCall: 1 });
    expect(() => exportDataset(buildChain(6), { shardSize: 1, holdoutFraction: 0 }, { outDir, io })).toThrow(ExportRefusal);
    expect(existsSync(outDir)).toBe(false);
  });

  it("io failure at the LAST shard write raises io-failed and never creates outDir", () => {
    const outDir = join(root, "fail-last-shard");
    // Discover the real shard count first (dry run into a throwaway dir).
    const probe = exportDataset(buildChain(6), { shardSize: 1, holdoutFraction: 0 }, { outDir: join(root, "probe1"), io: realIo });
    const shardCount = probe.manifest.shards.length;
    const io = faultyIo({ failWriteCall: shardCount });
    expect(() => exportDataset(buildChain(6), { shardSize: 1, holdoutFraction: 0 }, { outDir, io })).toThrow(ExportRefusal);
    expect(existsSync(outDir)).toBe(false);
  });

  it("io failure at the manifest write raises io-failed and never creates outDir", () => {
    const outDir = join(root, "fail-manifest");
    const probe = exportDataset(buildChain(4), { shardSize: 1, holdoutFraction: 0 }, { outDir: join(root, "probe2"), io: realIo });
    const manifestWriteCall = probe.manifest.shards.length + 1;
    const io = faultyIo({ failWriteCall: manifestWriteCall });
    expect(() => exportDataset(buildChain(4), { shardSize: 1, holdoutFraction: 0 }, { outDir, io })).toThrow(ExportRefusal);
    expect(existsSync(outDir)).toBe(false);
  });

  it("io failure at rename (fresh outDir) raises io-failed and outDir stays absent", () => {
    const outDir = join(root, "fail-rename-fresh");
    const io = faultyIo({ failRenameCall: 1 });
    expect(() => exportDataset(buildChain(2), {}, { outDir, io })).toThrow(ExportRefusal);
    expect(existsSync(outDir)).toBe(false);
  });

  it("io failure at rename during overwrite rolls back to the previous dataset intact", () => {
    const outDir = join(root, "fail-rename-overwrite");
    const first = exportDataset(buildChain(3, { uniqPrefix: "keep" }), {}, { outDir, io: realIo });
    const io = faultyIo({ failRenameCall: 2 }); // 1st rename (outDir->backup) succeeds, 2nd (tmp->outDir) fails
    expect(() => exportDataset(buildChain(4, { uniqPrefix: "new" }), {}, { outDir, io, overwrite: true })).toThrow(ExportRefusal);
    expect(existsSync(outDir)).toBe(true);
    const onDisk = readManifest(outDir, realIo);
    expect(onDisk.digest).toBe(first.manifest.digest);
  });

  it("throws ExportRefusal with code 'bad-spec' for an invalid spec (shardSize<=0)", () => {
    const outDir = join(root, "bad-spec");
    expect(() => exportDataset(buildChain(1), { shardSize: 0 }, { outDir, io: realIo })).toThrow(ExportRefusal);
    try {
      exportDataset(buildChain(1), { shardSize: -5 }, { outDir, io: realIo });
    } catch (err) {
      expect((err as ExportRefusal).code).toBe("bad-spec");
    }
  });

  it("throws ExportRefusal with code 'bad-spec' for holdoutFraction out of [0,1]", () => {
    const outDir = join(root, "bad-spec-2");
    expect(() => exportDataset(buildChain(1), { holdoutFraction: 1.5 }, { outDir, io: realIo })).toThrow(ExportRefusal);
  });
});

// ===========================================================================
// (d) Scale + bounded memory
// ===========================================================================

describe("scale + bounded memory", () => {
  it("exports >=5000 entries shard-by-shard without materializing a single giant write", () => {
    const N = 5001;
    const entries = buildChain(N, { uniqPrefix: "scale" });
    const outDir = join(root, "scale-1");
    const { io, writeCalls } = countingIo();
    const shardSize = 500;
    const result = exportDataset(entries, { shardSize, holdoutFraction: 0 }, { outDir, io });

    expect(result.manifest.counts.records).toBe(N);
    const expectedShards = Math.ceil(N / shardSize);
    expect(result.manifest.shards).toHaveLength(expectedShards);
    expect(result.manifest.shards.map((s) => s.records)).toEqual([
      ...Array.from({ length: expectedShards - 1 }, () => shardSize),
      N % shardSize,
    ]);

    // One writeFileSync call per shard file + one for manifest.json — never a
    // single call carrying (close to) the whole dataset's worth of records.
    const shardWrites = writeCalls.filter((c) => c.path.includes(".jsonl"));
    expect(shardWrites).toHaveLength(expectedShards);
    // Every shard write is bounded roughly by shardSize records worth of
    // bytes, not by the full corpus — a crude but real proxy for "did not
    // buffer everything": the biggest single write is a small fraction of
    // the total bytes across all shard writes.
    const totalShardBytes = shardWrites.reduce((sum, c) => sum + c.bytes, 0);
    const maxSingleWrite = Math.max(...shardWrites.map((c) => c.bytes));
    expect(maxSingleWrite).toBeLessThan(totalShardBytes / (expectedShards - 2));
  }, 30_000);

  it("shard rollover is exact at the shardSize boundary even with mock-tainted entries interleaved", () => {
    const entries = buildChain(20, { mockEvery: 4 }); // 5 excluded (seq 4,8,12,16, and... every 4th, i>0) -> seq 4,8,12,16 = 4 excluded
    const outDir = join(root, "scale-interleave");
    const result = exportDataset(entries, { shardSize: 3, holdoutFraction: 0 }, { outDir, io: realIo });
    const totalRecords = result.manifest.shards.reduce((s, sh) => s + sh.records, 0);
    expect(totalRecords).toBe(result.manifest.counts.records);
    expect(result.manifest.shards.every((s) => s.records <= 3)).toBe(true);
  });
});

// ===========================================================================
// VerifiedTrajectoryCorpus source — chain verification + genesis/head
// ===========================================================================

describe("exportDataset — VerifiedTrajectoryCorpus source", () => {
  it("exports from a real corpus; genesis/head match the corpus's own chain", async () => {
    const corpusRoot = mkdtempSync(join(tmpdir(), "hades-exporter-corpus-"));
    try {
      const corpus = new VerifiedTrajectoryCorpus({ root: corpusRoot });
      for (let i = 0; i < 4; i++) {
        const vt = await verifiedFixture(`real-${i}`);
        const admitted = await corpus.admit(vt);
        if (!admitted.ok) throw new Error("fixture admission failed");
      }
      const outDir = join(root, "from-corpus");
      const result = exportDataset(corpus, { holdoutFraction: 0 }, { outDir, io: realIo });
      expect(result.manifest.counts.records).toBe(4);
      expect(result.manifest.corpus.genesis).toBe(DATASET_CORPUS_GENESIS);
      expect(result.manifest.corpus.head).toBe(corpus.head());
    } finally {
      rmSync(corpusRoot, { recursive: true, force: true });
    }
  });

  it("refuses with 'chain-invalid' when the corpus's chain has been corrupted", async () => {
    const corpusRoot = mkdtempSync(join(tmpdir(), "hades-exporter-corrupt-"));
    try {
      const corpus = new VerifiedTrajectoryCorpus({ root: corpusRoot });
      const vt = await verifiedFixture("corruptme");
      const admitted = await corpus.admit(vt);
      if (!admitted.ok) throw new Error("fixture admission failed");

      // Corrupt the on-disk chain: flip the stored hash of the single entry.
      const logPath = join(corpusRoot, "corpus.jsonl");
      const lines = readFileSync(logPath, "utf8").split("\n");
      const entryLineIdx = lines.findIndex((l) => l.includes('"seq":0'));
      const parsed = JSON.parse(lines[entryLineIdx]);
      parsed.hash = "0".repeat(64);
      lines[entryLineIdx] = JSON.stringify(parsed);
      writeFileSync(logPath, lines.join("\n"), "utf8");

      const outDir = join(root, "from-corrupt-corpus");
      expect(() => exportDataset(corpus, {}, { outDir, io: realIo })).toThrow(ExportRefusal);
      try {
        exportDataset(corpus, {}, { outDir, io: realIo });
      } catch (err) {
        expect((err as ExportRefusal).code).toBe("chain-invalid");
      }
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(corpusRoot, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// (g) readManifest — forward-compat refusal + corruption
// ===========================================================================

describe("readManifest", () => {
  it("round-trips a freshly exported manifest", () => {
    const outDir = join(root, "rm-roundtrip");
    const result = exportDataset(buildChain(3), {}, { outDir, io: realIo });
    const back = readManifest(outDir, realIo);
    expect(back).toEqual(result.manifest);
  });

  it("refuses a manifest with a newer formatVersion as 'future-format'", () => {
    const outDir = join(root, "rm-future");
    const result = exportDataset(buildChain(2), {}, { outDir, io: realIo });
    const tampered = { ...result.manifest, formatVersion: DATASET_FORMAT_VERSION + 1 };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(tampered), "utf8");
    expect(() => readManifest(outDir, realIo)).toThrow(ExportRefusal);
    try {
      readManifest(outDir, realIo);
    } catch (err) {
      expect((err as ExportRefusal).code).toBe("future-format");
    }
  });

  it("raises a typed error for a truncated/corrupt manifest.json", () => {
    const outDir = join(root, "rm-corrupt");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "manifest.json"), '{"formatVersion":1,"createdAt":', "utf8"); // truncated
    expect(() => readManifest(outDir, realIo)).toThrow(ExportRefusal);
    try {
      readManifest(outDir, realIo);
    } catch (err) {
      expect((err as ExportRefusal).code).toBe("io-failed");
    }
  });

  it("raises a typed error for a missing manifest.json", () => {
    const outDir = join(root, "rm-missing");
    mkdirSync(outDir, { recursive: true });
    expect(() => readManifest(outDir, realIo)).toThrow(ExportRefusal);
  });

  it("raises a typed error when the stored digest does not match the recomputed one", () => {
    const outDir = join(root, "rm-tampered-digest");
    const result = exportDataset(buildChain(2), {}, { outDir, io: realIo });
    const tampered = { ...result.manifest, counts: { ...result.manifest.counts, skipped: 999 } };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(tampered), "utf8");
    expect(() => readManifest(outDir, realIo)).toThrow(ExportRefusal);
    try {
      readManifest(outDir, realIo);
    } catch (err) {
      expect((err as ExportRefusal).code).toBe("io-failed");
    }
  });
});

// ===========================================================================
// (h) formatExportReport
// ===========================================================================

describe("formatExportReport", () => {
  it("produces aligned, plain-ASCII, HTML/color-free lines", () => {
    const outDir = join(root, "report");
    const result: ExportResult = exportDataset(buildChain(3), {}, { outDir, io: realIo });
    const lines = formatExportReport(result);
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/\x1b\[/); // no ANSI escape codes
      expect(line).not.toMatch(/<[^>]+>/); // no HTML tags
      expect(Array.from(line).every((ch) => ch.charCodeAt(0) < 128)).toBe(true); // plain ASCII
    }
    const labelLines = lines.filter((l) => l.includes(": "));
    const colonPositions = new Set(labelLines.map((l) => l.indexOf(": ")));
    expect(colonPositions.size).toBe(1); // aligned: the ": " separator lands at the same column everywhere
  });

  it("is width-stable regardless of dataset size", () => {
    const smallOut = join(root, "report-small");
    const bigOut = join(root, "report-big");
    const small = exportDataset(buildChain(1), {}, { outDir: smallOut, io: realIo });
    const big = exportDataset(buildChain(30), {}, { outDir: bigOut, io: realIo });
    const smallLines = formatExportReport(small);
    const bigLines = formatExportReport(big);
    expect(smallLines.length).toBe(bigLines.length);
  });
});
