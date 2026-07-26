/**
 * exporter.ts — turns a verified corpus into a byte-for-byte reproducible,
 * atomically-published on-disk dataset: canonically ordered JSONL shards,
 * deterministic gzip, and a manifest whose `digest` is clock-independent and
 * pins the exact spec, corpus head, and shard hashes it was built from.
 *
 * ## Ordering rule (locked)
 *
 * Every candidate {@link CorpusEntry} — after the {@link ExportFilter}'s
 * non-reality-class fields (`capability`/`model`/`since`/`until`/
 * `minPCorrect`/`maxEpsilon`) have been applied and BEFORE `filter.limit`,
 * `filter.realityClass`, deduplication, or per-record encoding — is sorted by
 * `trajectorySha256` ascending, with `seq` ascending as the tiebreak for the
 * (cryptographically negligible, but never assumed impossible) case of a hash
 * collision. `filter.limit`, when set, then keeps only the first `limit`
 * entries of that canonical order — so which entries are kept is a pure
 * function of the entries themselves, never of admission order, wall-clock
 * time, or which process/instance produced them. Records are then routed
 * into shards in that same order, split-by-split (`train`, `holdout`), so two
 * exports of the same corpus under the same {@link ExportSpec} always produce
 * byte-identical shard files, in any process, on any machine, regardless of
 * the order the underlying trajectories were originally admitted.
 *
 * ## Digest preimage (locked)
 *
 * {@link datasetDigest} hashes exactly: `formatVersion`, `specHash` (itself a
 * hash of the full normalized {@link ExportSpec}, so any spec change already
 * changes the digest), `corpus.genesis`, `corpus.head`, and, for every shard
 * IN MANIFEST ORDER, its `sha256Raw` and `records` count, plus the full
 * `counts` object. It deliberately EXCLUDES `createdAt` (so re-running the
 * same export at a different wall-clock time never changes the digest) and
 * every absolute filesystem path (`outDir` never appears in the manifest at
 * all — {@link ShardDescriptor.file} is always a bare relative filename).
 * `entriesScanned`, `skips`, and `generator` are metadata, not identity, and
 * are likewise excluded — two datasets with the same digest are guaranteed to
 * have the same records in the same shards, nothing more, nothing less.
 *
 * ## Gzip determinism (locked)
 *
 * `node:zlib`'s `gzipSync` is itself already deterministic for a fixed
 * `level` (verified: two calls on identical input at different wall-clock
 * instants byte-for-byte match, because Node's binding never populates the
 * gzip header's MTIME from the system clock) — but this module does not rely
 * on that as an implementation detail of a dependency it does not control.
 * {@link gzipDeterministic} explicitly zeroes the three header bytes RFC 1952
 * §2.3 defines as environment-dependent — MTIME (bytes 4-7, "the most recent
 * modification time of the input file"), XFL (byte 8, an encoder-specific
 * compression-effort hint), and OS (byte 9, the encoding host's OS id) — to
 * fixed values (`0`, `0`, `0xff` "unknown") after every compression, so the
 * output is provably a pure function of the input bytes and the fixed
 * `level`, independent of wall-clock time, host OS, or Node/zlib version
 * quirks in what those bytes happen to default to.
 *
 * ## Atomic publication protocol (locked)
 *
 * Every shard file and `manifest.json` is written into a freshly created
 * SIBLING directory of `outDir` (same parent, so the final step is a same-
 * filesystem rename) — `outDir` is never touched while the dataset is being
 * built. Only once every write has succeeded does {@link exportDataset}
 * publish: if `outDir` does not yet exist, one `renameSync(tmp, outDir)`
 * makes the whole dataset visible atomically; if it exists (`overwrite:
 * true` required — see {@link ExportRefusal} `"dir-exists"` otherwise), the
 * existing directory is first renamed aside, the new one is renamed into
 * place, and the old one is removed only after that succeeds — if the second
 * rename fails, the aside copy is renamed straight back, so `outDir` is
 * self-healingly restored to exactly what it was. Any I/O failure at any
 * stage (`mkdir`, any shard write, the manifest write, or either rename)
 * removes the half-built tmp directory (best-effort) and raises
 * {@link ExportRefusal} with code `"io-failed"` — `outDir` itself is provably
 * never left holding a partial dataset: every byte touching it happens in
 * the single, all-or-nothing final rename.
 *
 * ## Reality classification
 *
 * A `CorpusEntry` carries its reality classification at
 * `entry.provenance.realityClass`, and that is exactly where both this module
 * (for the `mockTaintedExcluded` count) and `./example`'s `encodeExample`
 * (for `ExampleLabel.realityClass`) read it from. `CorpusEntry` is passed to
 * the encoder unmodified.
 */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";

import { VerifiedTrajectoryCorpus, type CorpusEntry, type CorpusQuery, type RealityClass } from "./corpus";
import {
  encodeExample,
  canonicalRecordJson,
  type TrainingRecord,
  type EncodeOptions,
  type ExampleSchema,
  type EncodeSkipCode,
} from "./example";
import { sha256Hex } from "../styx/certificate";
import { encodeJsonLine } from "../eval/json-line";

// ===========================================================================
// Locked public constants + spec types
// ===========================================================================

export const DATASET_FORMAT_VERSION = 1;

export interface ExportFilter {
  realityClass?: RealityClass;
  capability?: string;
  model?: string;
  since?: number;
  until?: number;
  minPCorrect?: number;
  maxEpsilon?: number;
  limit?: number;
}

export interface ExportSpec {
  schema: ExampleSchema;
  filter: ExportFilter;
  encode: EncodeOptions;
  shardSize: number;
  compression: "gzip" | "none";
  holdoutFraction: number;
  holdoutSalt?: string;
}

const DEFAULT_SCHEMA: ExampleSchema = "sft-prompt-completion";
const DEFAULT_SHARD_SIZE = 1000;
const DEFAULT_COMPRESSION: "gzip" | "none" = "gzip";
/** Mirrors `./example`'s own `DEFAULT_HOLDOUT_FRACTION` value (not imported —
 *  that constant is private to `./example` — kept numerically identical so a
 *  fully-defaulted `ExportSpec` matches `encodeExample`'s own default split
 *  behavior when no holdout fraction is specified anywhere.) */
const DEFAULT_HOLDOUT_FRACTION = 0.1;

/**
 * Fills every locked default onto a partial spec. `filter.realityClass`
 * defaults to `"real"` — mock-tainted data is EXCLUDED unless the caller
 * explicitly sets `filter.realityClass: "mock-tainted"`. `encode.schema`,
 * `encode.holdoutFraction`, and `encode.holdoutSalt` are always forced to
 * mirror the top-level `schema`/`holdoutFraction`/`holdoutSalt` fields (the
 * top-level fields are the single source of truth), so a normalized spec can
 * never carry an internally inconsistent pair of schema/split settings.
 */
export function normalizeSpec(spec: Partial<ExportSpec>): ExportSpec {
  const schema: ExampleSchema = spec?.schema ?? DEFAULT_SCHEMA;
  const holdoutFraction = spec?.holdoutFraction ?? DEFAULT_HOLDOUT_FRACTION;
  const holdoutSalt = spec?.holdoutSalt;

  const filterIn = spec?.filter ?? {};
  const filter: ExportFilter = {
    realityClass: filterIn.realityClass ?? "real",
    capability: filterIn.capability,
    model: filterIn.model,
    since: filterIn.since,
    until: filterIn.until,
    minPCorrect: filterIn.minPCorrect,
    maxEpsilon: filterIn.maxEpsilon,
    limit: filterIn.limit,
  };

  const encodeIn = spec?.encode ?? ({} as Partial<EncodeOptions>);
  const encode: EncodeOptions = {
    ...encodeIn,
    schema,
    holdoutFraction,
    holdoutSalt,
  };

  return {
    schema,
    filter,
    encode,
    shardSize: spec?.shardSize ?? DEFAULT_SHARD_SIZE,
    compression: spec?.compression ?? DEFAULT_COMPRESSION,
    holdoutFraction,
    holdoutSalt,
  };
}

// ===========================================================================
// Generic canonicalization (sorted keys, RegExp-safe, NaN-safe via encodeJsonLine)
// ===========================================================================

/**
 * Rebuilds `value` with every object's keys sorted lexicographically at
 * every nesting level (arrays keep element order), `undefined` properties
 * dropped, and any `RegExp` (e.g. a caller-supplied `EncodeOptions.redaction`
 * pattern) replaced by a plain `{flags, source}` object — `JSON.stringify`
 * on a bare `RegExp` silently produces `{}`, which would lose information.
 * The result is a plain value with no incidental dependency on the order its
 * fields happened to be constructed in, ready for `encodeJsonLine`.
 */
function sortKeysDeep(value: unknown): unknown {
  if (value instanceof RegExp) return { flags: value.flags, source: value.source };
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sortKeysDeep(v));
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = sortKeysDeep(obj[k]);
  return out;
}

/** `sha256Hex` of the canonical (sorted-key, RegExp-safe, NaN-safe) form of
 *  the full normalized spec. Any change to `schema`, `filter`, `shardSize`,
 *  `holdoutFraction`/`holdoutSalt`, `compression`, or `encode` changes this
 *  hash — and since {@link datasetDigest} embeds `specHash` directly, it
 *  always changes the dataset digest too. */
export function specHash(spec: ExportSpec): string {
  return sha256Hex(encodeJsonLine(sortKeysDeep(spec)));
}

// ===========================================================================
// Manifest types
// ===========================================================================

export interface ShardDescriptor {
  index: number;
  split: "train" | "holdout";
  file: string;
  records: number;
  bytesRaw: number;
  bytesStored: number;
  sha256Raw: string;
  sha256Stored: string;
}

export interface DatasetCounts {
  records: number;
  train: number;
  holdout: number;
  skipped: number;
  redactions: number;
  mockTaintedExcluded: number;
  duplicatesDropped: number;
}

const DATASET_COUNTS_KEY_ORDER: (keyof DatasetCounts)[] = [
  "records",
  "train",
  "holdout",
  "skipped",
  "redactions",
  "mockTaintedExcluded",
  "duplicatesDropped",
];

const ENCODE_SKIP_CODE_ORDER: EncodeSkipCode[] = [
  "empty-steps",
  "empty-objective",
  "over-budget",
  "label-inconsistent",
  "unsafe-content",
  "malformed-entry",
];

export interface DatasetManifest {
  formatVersion: number;
  createdAt: number;
  generator: { name: "hades"; phase: 19 };
  specHash: string;
  spec: ExportSpec;
  corpus: { genesis: string; head: string; entriesScanned: number; verifiedOnly: true };
  shards: ShardDescriptor[];
  counts: DatasetCounts;
  skips: { code: EncodeSkipCode; count: number }[];
  digest: string;
}

/**
 * `sha256Hex` of a deliberately NARROW preimage — see the module header's
 * "Digest preimage" section for the exact field list and the reasoning for
 * excluding `createdAt` and every path. Pure function of its argument: no
 * clock, no I/O, no randomness.
 */
export function datasetDigest(m: Omit<DatasetManifest, "digest">): string {
  const preimage = {
    formatVersion: m.formatVersion,
    specHash: m.specHash,
    corpusGenesis: m.corpus.genesis,
    corpusHead: m.corpus.head,
    shards: m.shards.map((s) => ({ sha256Raw: s.sha256Raw, records: s.records })),
    counts: m.counts,
  };
  return sha256Hex(encodeJsonLine(sortKeysDeep(preimage)));
}

/** Full canonical (sorted-key, NaN-safe) JSON rendering of the whole
 *  manifest, including `digest` — this is exactly the string written to
 *  `manifest.json`, so a byte-for-byte diff of two datasets' manifest files
 *  is meaningful. */
export function canonicalManifestJson(m: DatasetManifest): string {
  return encodeJsonLine(sortKeysDeep(m));
}

// ===========================================================================
// I/O abstraction + errors
// ===========================================================================

export interface ExportIo {
  mkdirSync: typeof nodeMkdirSync;
  writeFileSync: typeof nodeWriteFileSync;
  readFileSync: typeof nodeReadFileSync;
  existsSync: typeof nodeExistsSync;
  renameSync: typeof nodeRenameSync;
  rmSync: typeof nodeRmSync;
  readdirSync: typeof nodeReaddirSync;
}

const defaultIo: ExportIo = {
  mkdirSync: nodeMkdirSync,
  writeFileSync: nodeWriteFileSync,
  readFileSync: nodeReadFileSync,
  existsSync: nodeExistsSync,
  renameSync: nodeRenameSync,
  rmSync: nodeRmSync,
  readdirSync: nodeReaddirSync,
};

export interface ExportOptions {
  outDir: string;
  io?: ExportIo;
  now?: () => number;
  overwrite?: boolean;
}

export class ExportRefusal extends Error {
  code: "chain-invalid" | "dir-exists" | "bad-spec" | "io-failed" | "future-format";
  constructor(code: ExportRefusal["code"], message: string) {
    super(message);
    this.name = "ExportRefusal";
    this.code = code;
  }
}

export type ExportResult = { manifest: DatasetManifest; outDir: string; bytesWritten: number };

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===========================================================================
// Spec validation ("bad-spec" refusal)
// ===========================================================================

const VALID_SCHEMAS: ReadonlySet<string> = new Set(["sft-prompt-completion", "chat-messages", "tool-trace"]);

function validateSpec(spec: ExportSpec): string[] {
  const problems: string[] = [];
  if (!VALID_SCHEMAS.has(spec.schema)) problems.push(`schema must be one of ${[...VALID_SCHEMAS].join(", ")}`);
  if (!Number.isInteger(spec.shardSize) || spec.shardSize < 1) problems.push("shardSize must be a positive integer");
  if (spec.compression !== "gzip" && spec.compression !== "none") {
    problems.push('compression must be "gzip" or "none"');
  }
  if (!Number.isFinite(spec.holdoutFraction) || spec.holdoutFraction < 0 || spec.holdoutFraction > 1) {
    problems.push("holdoutFraction must be a finite number in [0,1]");
  }
  const f = spec.filter;
  if (f.realityClass !== undefined && f.realityClass !== "real" && f.realityClass !== "mock-tainted") {
    problems.push('filter.realityClass must be "real" or "mock-tainted"');
  }
  if (f.minPCorrect !== undefined && (!Number.isFinite(f.minPCorrect) || f.minPCorrect < 0 || f.minPCorrect > 1)) {
    problems.push("filter.minPCorrect must be a finite number in [0,1]");
  }
  if (f.maxEpsilon !== undefined && (!Number.isFinite(f.maxEpsilon) || f.maxEpsilon < 0)) {
    problems.push("filter.maxEpsilon must be a finite non-negative number");
  }
  if (f.since !== undefined && !Number.isFinite(f.since)) problems.push("filter.since must be a finite number");
  if (f.until !== undefined && !Number.isFinite(f.until)) problems.push("filter.until must be a finite number");
  if (f.since !== undefined && f.until !== undefined && f.since > f.until) {
    problems.push("filter.since must be <= filter.until");
  }
  if (f.limit !== undefined && (!Number.isInteger(f.limit) || f.limit < 0)) {
    problems.push("filter.limit must be a non-negative integer");
  }
  return problems;
}

// ===========================================================================
// Candidate gathering, ordering, and the `./example` shape-bridge
// ===========================================================================

const FULL_QUERY: CorpusQuery = {};

/** Mirrors `VerifiedTrajectoryCorpus`'s own private `matches()` boundary
 *  semantics (inclusive on both ends) for every {@link ExportFilter} field
 *  EXCEPT `realityClass` (handled separately so its exclusions are visibly
 *  counted as `mockTaintedExcluded`) and `limit` (applied after canonical
 *  sorting — see the module header's "Ordering rule"). Applied identically
 *  regardless of whether `source` is a live corpus or a bare entry array, so
 *  the two input forms behave identically for the same underlying data. */
function matchesHardFilter(e: CorpusEntry, f: ExportFilter): boolean {
  if (f.since !== undefined && e.admittedAt < f.since) return false;
  if (f.until !== undefined && e.admittedAt > f.until) return false;
  if (f.capability !== undefined && !e.trajectory.tasks.some((t) => t.capability === f.capability)) return false;
  if (f.model !== undefined && e.trajectory.model !== f.model) return false;
  if (f.minPCorrect !== undefined && e.certificate.payload.pCorrect < f.minPCorrect) return false;
  if (f.maxEpsilon !== undefined && e.certificate.payload.epsilon > f.maxEpsilon) return false;
  return true;
}

function compareEntries(a: CorpusEntry, b: CorpusEntry): number {
  if (a.trajectorySha256 < b.trajectorySha256) return -1;
  if (a.trajectorySha256 > b.trajectorySha256) return 1;
  return a.seq - b.seq;
}

function deriveGenesisAndHead(
  source: VerifiedTrajectoryCorpus | readonly CorpusEntry[],
  allEntries: readonly CorpusEntry[],
): { genesis: string; head: string } {
  if (source instanceof VerifiedTrajectoryCorpus) {
    const head = source.head();
    if (allEntries.length === 0) return { genesis: head, head };
    const first = allEntries.reduce((min, e) => (e.seq < min.seq ? e : min), allEntries[0]);
    return { genesis: first.prevHash, head };
  }
  if (allEntries.length === 0) {
    // No corpus instance and no entries at all: nothing to anchor to. Mirror
    // `./corpus`'s own `DATASET_CORPUS_GENESIS = sha256Hex("hades.dataset.corpus.v1")`
    // derivation locally (that constant is outside this module's locked
    // import surface) so an empty-array export still reports a real,
    // well-known anchor rather than an empty string.
    const fallback = sha256Hex("hades.dataset.corpus.v1");
    return { genesis: fallback, head: fallback };
  }
  const first = allEntries.reduce((min, e) => (e.seq < min.seq ? e : min), allEntries[0]);
  const last = allEntries.reduce((max, e) => (e.seq > max.seq ? e : max), allEntries[0]);
  return { genesis: first.prevHash, head: last.hash };
}

// ===========================================================================
// Deterministic gzip
// ===========================================================================

const GZIP_LEVEL = 9;

/**
 * See the module header's "Gzip determinism" section. Bytes 4-7 (MTIME),
 * byte 8 (XFL), and byte 9 (OS) of the RFC 1952 gzip header are overwritten
 * to `0,0,0,0,0,0xff` after compression, unconditionally.
 */
function gzipDeterministic(raw: Buffer): Buffer {
  const out = Buffer.from(gzipSync(raw, { level: GZIP_LEVEL }));
  if (out.length >= 10) {
    out[4] = 0;
    out[5] = 0;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0xff;
  }
  return out;
}

/** `sha256Hex` (from `../styx/certificate`) is UTF-8-string-only and cannot
 *  correctly hash arbitrary binary (e.g. gzip) bytes — encoding them through
 *  a JS string and back is lossy for byte values >= 0x80. This is the same
 *  primitive `../styx/certificate.ts` itself uses internally, called
 *  directly here only for the binary case that helper's signature cannot
 *  safely cover. */
function sha256HexBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ===========================================================================
// exportDataset
// ===========================================================================

const MANIFEST_FILENAME = "manifest.json";

export function exportDataset(
  source: VerifiedTrajectoryCorpus | readonly CorpusEntry[],
  specPartial: Partial<ExportSpec>,
  opts: ExportOptions,
): ExportResult {
  if (!opts || typeof opts.outDir !== "string" || opts.outDir.length === 0) {
    throw new ExportRefusal("bad-spec", "ExportOptions.outDir must be a non-empty string");
  }
  const io = opts.io ?? defaultIo;
  const now = opts.now ?? Date.now;

  const spec = normalizeSpec(specPartial);
  const problems = validateSpec(spec);
  if (problems.length > 0) {
    throw new ExportRefusal("bad-spec", `invalid ExportSpec: ${problems.join("; ")}`);
  }

  // A corrupt corpus can never produce a dataset.
  if (source instanceof VerifiedTrajectoryCorpus) {
    const verdict = source.verifyChain();
    if (!verdict.ok) {
      throw new ExportRefusal(
        "chain-invalid",
        `corpus chain verification failed${verdict.brokenAt !== null ? ` at seq ${verdict.brokenAt}` : ""}${
          verdict.reason ? ` (${verdict.reason})` : ""
        }`,
      );
    }
  }

  let outDirExists = false;
  let outDirNonEmpty = false;
  try {
    outDirExists = io.existsSync(opts.outDir);
    if (outDirExists) {
      const listing = io.readdirSync(opts.outDir);
      outDirNonEmpty = Array.isArray(listing) && listing.length > 0;
    }
  } catch (err) {
    throw new ExportRefusal("io-failed", `failed to inspect outDir "${opts.outDir}": ${describeErr(err)}`);
  }
  if (outDirNonEmpty && opts.overwrite !== true) {
    throw new ExportRefusal(
      "dir-exists",
      `outDir "${opts.outDir}" already exists and is non-empty; pass overwrite:true to replace it`,
    );
  }

  // ---- gather, order, and process candidates --------------------------
  const allEntries: CorpusEntry[] =
    source instanceof VerifiedTrajectoryCorpus ? source.entries(FULL_QUERY) : [...source];

  const { genesis, head } = deriveGenesisAndHead(source, allEntries);

  const hardFiltered = allEntries.filter((e) => matchesHardFilter(e, spec.filter));
  const sorted = [...hardFiltered].sort(compareEntries);
  const limited = spec.filter.limit !== undefined ? sorted.slice(0, spec.filter.limit) : sorted;
  const entriesScanned = limited.length;

  const effectiveRealityClass: RealityClass = spec.filter.realityClass ?? "real";
  const seenTrajectorySha = new Set<string>();
  const skipCounts = new Map<EncodeSkipCode, number>();

  let recordsCount = 0;
  let trainCount = 0;
  let holdoutCount = 0;
  let skippedCount = 0;
  let redactionsSum = 0;
  let mockTaintedExcludedCount = 0;
  let duplicatesDroppedCount = 0;

  // Bounded-memory shard buffers: at most `shardSize` encoded lines live in
  // memory at once per split, never the full record set.
  const trainBuf: string[] = [];
  const holdoutBuf: string[] = [];
  let trainIdx = 0;
  let holdoutIdx = 0;
  const trainShards: ShardDescriptor[] = [];
  const holdoutShards: ShardDescriptor[] = [];
  let bytesWritten = 0;

  let tmpDir: string | null = null;

  function shardFileName(split: "train" | "holdout", index: number): string {
    const base = `${split}-${String(index).padStart(3, "0")}.jsonl`;
    return spec.compression === "gzip" ? `${base}.gz` : base;
  }

  function flushShard(split: "train" | "holdout"): void {
    const buf = split === "train" ? trainBuf : holdoutBuf;
    if (buf.length === 0) return;
    const index = split === "train" ? trainIdx++ : holdoutIdx++;
    const content = buf.join("\n") + "\n";
    const records = buf.length;
    buf.length = 0;

    const bytesRaw = Buffer.byteLength(content, "utf8");
    const sha256Raw = sha256Hex(content);
    const storedBuf: Buffer =
      spec.compression === "gzip" ? gzipDeterministic(Buffer.from(content, "utf8")) : Buffer.from(content, "utf8");
    const bytesStored = storedBuf.length;
    const sha256Stored = sha256HexBytes(storedBuf);

    const file = shardFileName(split, index);
    if (tmpDir === null) throw new Error("internal: flushShard called before tmpDir was created");
    io.writeFileSync(join(tmpDir, file), storedBuf);
    bytesWritten += bytesStored;

    const descriptor: ShardDescriptor = { index, split, file, records, bytesRaw, bytesStored, sha256Raw, sha256Stored };
    (split === "train" ? trainShards : holdoutShards).push(descriptor);
  }

  function pushRecord(record: TrainingRecord): void {
    const line = canonicalRecordJson(record);
    const buf = record.split === "train" ? trainBuf : holdoutBuf;
    buf.push(line);
    if (buf.length >= spec.shardSize) flushShard(record.split);
  }

  // ---- build in a sibling tmp dir --------------------------------------
  // Created BEFORE processing entries: `pushRecord`/`flushShard` write each
  // shard to `tmpDir` as soon as it fills, so `tmpDir` must already exist —
  // this is exactly what keeps memory bounded (see the module header).
  const parent = dirname(opts.outDir);
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  tmpDir = join(parent, `.hades-dataset-tmp-${suffix}`);

  try {
    io.mkdirSync(tmpDir, { recursive: true });

    for (const entry of limited) {
      if (entry.provenance.realityClass !== effectiveRealityClass) {
        mockTaintedExcludedCount++;
        continue;
      }
      if (seenTrajectorySha.has(entry.trajectorySha256)) {
        duplicatesDroppedCount++;
        continue;
      }
      seenTrajectorySha.add(entry.trajectorySha256);

      const result = encodeExample(entry, spec.encode);
      if (!result.ok) {
        skippedCount++;
        skipCounts.set(result.skip.code, (skipCounts.get(result.skip.code) ?? 0) + 1);
        continue;
      }

      pushRecord(result.record);
      recordsCount++;
      redactionsSum += result.record.redactions;
      if (result.record.split === "train") trainCount++;
      else holdoutCount++;
    }

    flushShard("train");
    flushShard("holdout");

    const counts: DatasetCounts = {
      records: recordsCount,
      train: trainCount,
      holdout: holdoutCount,
      skipped: skippedCount,
      redactions: redactionsSum,
      mockTaintedExcluded: mockTaintedExcludedCount,
      duplicatesDropped: duplicatesDroppedCount,
    };
    const skips = ENCODE_SKIP_CODE_ORDER.filter((c) => skipCounts.has(c)).map((c) => ({
      code: c,
      count: skipCounts.get(c) as number,
    }));

    const manifestWithoutDigest: Omit<DatasetManifest, "digest"> = {
      formatVersion: DATASET_FORMAT_VERSION,
      createdAt: now(),
      generator: { name: "hades", phase: 19 },
      specHash: specHash(spec),
      spec,
      corpus: { genesis, head, entriesScanned, verifiedOnly: true },
      shards: [...trainShards, ...holdoutShards],
      counts,
      skips,
    };
    const digest = datasetDigest(manifestWithoutDigest);
    const manifest: DatasetManifest = { ...manifestWithoutDigest, digest };

    const manifestJson = canonicalManifestJson(manifest);
    io.writeFileSync(join(tmpDir, MANIFEST_FILENAME), manifestJson, "utf8");
    bytesWritten += Buffer.byteLength(manifestJson, "utf8");

    publish(io, opts.outDir, tmpDir, outDirExists);

    return { manifest, outDir: opts.outDir, bytesWritten };
  } catch (err) {
    try {
      io.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup only */
    }
    if (err instanceof ExportRefusal) throw err;
    throw new ExportRefusal("io-failed", `export of "${opts.outDir}" failed: ${describeErr(err)}`);
  }
}

/**
 * The single all-or-nothing publication step. `outDir` is only ever touched
 * here, and only by `renameSync` (see the module header's "Atomic
 * publication protocol"). Throws on any I/O failure; on failure after an
 * existing `outDir` has already been renamed aside, restores it before
 * throwing so `outDir` is never left missing or partial.
 */
function publish(io: ExportIo, outDir: string, tmpDir: string, outDirExists: boolean): void {
  if (!outDirExists) {
    try {
      io.renameSync(tmpDir, outDir);
    } catch (err) {
      throw new ExportRefusal("io-failed", `failed to publish dataset to "${outDir}": ${describeErr(err)}`);
    }
    return;
  }

  const backupDir = `${outDir}.hades-dataset-old-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    io.renameSync(outDir, backupDir);
  } catch (err) {
    throw new ExportRefusal(
      "io-failed",
      `failed to move existing outDir "${outDir}" aside for overwrite: ${describeErr(err)}`,
    );
  }

  try {
    io.renameSync(tmpDir, outDir);
  } catch (err) {
    try {
      io.renameSync(backupDir, outDir);
    } catch {
      /* best-effort restore; the original error below is the one that matters */
    }
    throw new ExportRefusal(
      "io-failed",
      `failed to publish new dataset to "${outDir}" (restored previous contents): ${describeErr(err)}`,
    );
  }

  try {
    io.rmSync(backupDir, { recursive: true, force: true });
  } catch {
    /* the new dataset is already published; leftover backup dir is cosmetic */
  }
}

// ===========================================================================
// readManifest
// ===========================================================================

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validateManifestShape(v: Record<string, unknown>): string | null {
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return "createdAt missing/invalid";
  if (!isPlainRecord(v.generator) || v.generator.name !== "hades" || typeof v.generator.phase !== "number") {
    return "generator missing/invalid";
  }
  if (typeof v.specHash !== "string" || v.specHash.length === 0) return "specHash missing/invalid";
  if (!isPlainRecord(v.spec)) return "spec missing/invalid";
  const corpus = v.corpus;
  if (
    !isPlainRecord(corpus) ||
    typeof corpus.genesis !== "string" ||
    typeof corpus.head !== "string" ||
    typeof corpus.entriesScanned !== "number" ||
    corpus.verifiedOnly !== true
  ) {
    return "corpus missing/invalid";
  }
  if (!Array.isArray(v.shards)) return "shards missing/invalid";
  for (const s of v.shards) {
    if (
      !isPlainRecord(s) ||
      typeof s.index !== "number" ||
      (s.split !== "train" && s.split !== "holdout") ||
      typeof s.file !== "string" ||
      typeof s.records !== "number" ||
      typeof s.bytesRaw !== "number" ||
      typeof s.bytesStored !== "number" ||
      typeof s.sha256Raw !== "string" ||
      typeof s.sha256Stored !== "string"
    ) {
      return "a shard descriptor is missing/invalid fields";
    }
  }
  if (!isPlainRecord(v.counts)) return "counts missing/invalid";
  for (const k of DATASET_COUNTS_KEY_ORDER) {
    if (typeof (v.counts as Record<string, unknown>)[k] !== "number") return `counts.${k} missing/invalid`;
  }
  if (!Array.isArray(v.skips)) return "skips missing/invalid";
  for (const sk of v.skips) {
    if (!isPlainRecord(sk) || typeof sk.code !== "string" || typeof sk.count !== "number") {
      return "a skip entry is missing/invalid fields";
    }
  }
  if (typeof v.digest !== "string" || v.digest.length === 0) return "digest missing/invalid";
  return null;
}

/**
 * Reads and validates `<dir>/manifest.json`. A `formatVersion` newer than
 * {@link DATASET_FORMAT_VERSION} is refused (`"future-format"`) rather than
 * silently misparsed. Anything else wrong — missing file, malformed JSON
 * (a truncated write), a structurally invalid manifest, or a stored `digest`
 * that does not match the recomputed one (tampering or corruption) — is
 * refused as `"io-failed"`.
 */
export function readManifest(dir: string, io: ExportIo = defaultIo): DatasetManifest {
  const manifestPath = join(dir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = io.readFileSync(manifestPath, "utf8") as string;
  } catch (err) {
    throw new ExportRefusal("io-failed", `could not read manifest at "${manifestPath}": ${describeErr(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ExportRefusal(
      "io-failed",
      `manifest at "${manifestPath}" is not valid JSON (corrupt or truncated): ${describeErr(err)}`,
    );
  }

  if (!isPlainRecord(parsed) || typeof parsed.formatVersion !== "number" || !Number.isInteger(parsed.formatVersion)) {
    throw new ExportRefusal("io-failed", `manifest at "${manifestPath}" is missing a valid integer "formatVersion"`);
  }
  if (parsed.formatVersion > DATASET_FORMAT_VERSION) {
    throw new ExportRefusal(
      "future-format",
      `manifest at "${manifestPath}" is format version ${parsed.formatVersion}, which this build (understands up to ${DATASET_FORMAT_VERSION}) refuses to read`,
    );
  }

  const shapeError = validateManifestShape(parsed);
  if (shapeError !== null) {
    throw new ExportRefusal("io-failed", `manifest at "${manifestPath}" is structurally invalid: ${shapeError}`);
  }

  const manifest = parsed as unknown as DatasetManifest;
  const { digest, ...rest } = manifest;
  const recomputed = datasetDigest(rest);
  if (recomputed !== digest) {
    throw new ExportRefusal(
      "io-failed",
      `manifest at "${manifestPath}" has digest "${digest}" but recomputes to "${recomputed}" — corrupt or hand-edited`,
    );
  }

  return manifest;
}

// ===========================================================================
// formatExportReport
// ===========================================================================

const REPORT_LABEL_WIDTH = 16;

function row(label: string, value: string): string {
  return `${label.padEnd(REPORT_LABEL_WIDTH)}: ${value}`;
}

/** Aligned plain-ASCII lines describing an {@link ExportResult}, suitable for
 *  direct terminal output — no color codes, no HTML, no trailing whitespace. */
export function formatExportReport(r: ExportResult): string[] {
  const m = r.manifest;
  return [
    "Dataset export",
    row("out dir", r.outDir),
    row("format version", String(m.formatVersion)),
    row("spec hash", m.specHash),
    row("digest", m.digest),
    row("corpus genesis", m.corpus.genesis),
    row("corpus head", m.corpus.head),
    row("entries scanned", String(m.corpus.entriesScanned)),
    row("records", `${m.counts.records} (train=${m.counts.train}, holdout=${m.counts.holdout})`),
    row("skipped", String(m.counts.skipped)),
    row("mock excluded", String(m.counts.mockTaintedExcluded)),
    row("duplicates", String(m.counts.duplicatesDropped)),
    row("redactions", String(m.counts.redactions)),
    row("shards", String(m.shards.length)),
    row("bytes written", String(r.bytesWritten)),
  ];
}
