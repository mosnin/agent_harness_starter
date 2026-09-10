/**
 * audit.ts — the independent dataset auditor: re-derives an exported
 * dataset's trustworthiness from bytes alone.
 *
 * ## The one rule this file exists to enforce: TRUST NOTHING, RECOMPUTE EVERYTHING
 *
 * `auditDataset` never believes a single number the manifest claims. Every
 * shard is independently re-hashed TWICE from the bytes actually on disk —
 * `sha256Raw` (the sha256 of the decompressed JSONL text, via `sha256Hex`)
 * AND `sha256Stored` (the raw-byte sha256 of exactly what is stored on disk,
 * gzip or not, via a local `node:crypto` hasher — see "Binary hashing"
 * below) — mirroring `./exporter`'s own dual-hash design so this module
 * catches tampering at either layer (a hand-edited compressed shard, or a
 * shard re-gzipped after its content was altered). Every record's `id` is
 * ALWAYS recomputed with `recordId` (`./example`) — `./exporter` never
 * persists `id` in a shard line in the first place (`canonicalRecordJson`'s
 * own field order excludes it, since it is a pure hash of every other
 * field), so this module's notion of a record's identity is never "trust
 * the stored id", it is "there is no stored id to trust — derive it fresh,
 * every time". `record-id-mismatch` fires in the narrower case where a row
 * DOES carry an explicit `id` (a forged row built from a full record dump,
 * say) that disagrees with that recompute. The dataset's `digest` is
 * recomputed with the exporter's own `datasetDigest`, fed ONLY what this
 * module independently re-derived (recomputed shard hashes/record counts,
 * recomputed split counts, the corpus's actual `head()` when a corpus is
 * supplied) — never what the manifest merely asserts. Every certificate is
 * re-verified with REAL ed25519 (`verifyCertificate`) and its trajectory
 * hash independently re-derived as `sha256Hex(canonicalTrajectoryJson(...))`
 * — the exact recompute `./corpus`'s own `admit()` performs. Nothing here is
 * estimated, sampled, or extrapolated: a report is a report of what this run
 * actually recomputed from the bytes it actually read.
 *
 * `auditDataset` NEVER throws. Every malformed-input class (missing dir,
 * missing/garbage manifest, a future `formatVersion`, a zero-byte or
 * garbage-gzip shard, a claimed-but-absent shard, …) is caught and reported
 * as a typed, `fatal`-severity `AuditFinding` in the returned report instead
 * — the report is the product, not an exception.
 *
 * ## The `specHash` boundary (an honestly-scoped check, not a gap papered over)
 *
 * `./exporter` computes `manifest.specHash` with its own private `specHash()`
 * function (`sha256Hex` of a NaN-safe, RegExp-safe, sorted-key encoding of
 * the full `ExportSpec`) — that function is intentionally NOT part of this
 * module's locked import surface (only `readManifest`, `datasetDigest`,
 * `canonicalManifestJson` are). Re-implementing an approximation of it here
 * would either drift from the real formula (producing FALSE POSITIVES on
 * every clean, untampered dataset — worse than not checking at all) or
 * require importing outside the locked contract. Instead, `spec-hash-mismatch`
 * is scoped to what this module CAN honestly verify without that formula:
 * structural validity (`specHash` must be a well-formed 64-hex-char sha256
 * digest). Content-level tampering of `specHash` — swapping it for another
 * well-formed-looking hex string — is still caught, just under the more
 * general `digest-mismatch` code, because `./exporter`'s `datasetDigest`
 * embeds `specHash` VERBATIM in its own preimage (see `./exporter`'s module
 * doc, "Digest preimage"): any edit to `specHash` that isn't accompanied by a
 * matching re-signed `digest` breaks the digest recompute too. This module
 * would rather report a true finding under a slightly broader code than
 * fabricate a "verified" spec-hash check it cannot actually perform.
 *
 * ## Binary hashing
 *
 * `sha256Hex` (`../styx/certificate`) is UTF-8-string-only and is not safe to
 * use on arbitrary binary (e.g. gzip) bytes — round-tripping them through a
 * JS string is lossy for byte values >= 0x80. This module therefore hashes
 * raw on-disk shard bytes with a small local `node:crypto` helper
 * (`sha256HexBytes`), the same primitive `./exporter` itself uses internally
 * for exactly the same reason, called directly here only for the binary case
 * `sha256Hex`'s signature cannot safely cover.
 *
 * ## The `counts` boundary
 *
 * `./exporter`'s `DatasetCounts` also tracks `skipped`, `mockTaintedExcluded`,
 * and `duplicatesDropped` — entries that were EXCLUDED before ever reaching a
 * shard. Nothing about an excluded entry survives in the exported bytes, so
 * this module cannot independently recompute those three counters from the
 * dataset directory alone (doing so would require re-running the exporter's
 * own candidate-selection logic against the full source corpus, well outside
 * an auditor's job). `count-mismatch` therefore verifies exactly the four
 * counters this module CAN honestly recompute from the bytes on disk —
 * `records`, `train`, `holdout`, `redactions` — and passes the other three
 * through unchanged into the digest recompute (so a mismatch confined to
 * `records`/`train`/`holdout`/`redactions` is still fully caught, including
 * via `digest-mismatch`, since `datasetDigest`'s preimage embeds the whole
 * `counts` object).
 *
 * ## Complexity
 *
 * `auditDataset` is linear in the number of records and shards: every
 * dedup/split/count check uses a `Map`/`Set` keyed by id or trajectory hash
 * (O(1) amortized per record), never an O(n²) nested scan. Corpus
 * cross-checking calls `corpus.entries()` and `corpus.head()` exactly ONCE
 * regardless of dataset size (never `corpus.get()` per record, which would
 * re-read the whole corpus file per call and make the audit O(n·m)), builds
 * an in-memory `Map<trajectorySha256, CorpusEntry>` once, and verifies
 * certificates in fixed-size batches (`CERT_BATCH_SIZE`) via `Promise.all` so
 * memory and concurrency both stay bounded on a >=5000-record dataset.
 *
 * ## Percentile / histogram convention (locked for `computeStats`)
 *
 * Percentiles (`p50`, `p90`) use linear interpolation between the two
 * closest ranks over the SORTED sample (`numpy`'s default `"linear"` method /
 * Excel's `PERCENTILE.INC`): for a 0-indexed sorted array of length n,
 * `p50`'s exact position is `0.5 * (n - 1)`, interpolating between the floor
 * and ceil neighbors by the fractional part. `Histogram.bins` are 10
 * equal-width bins across `[min, max]`; every bin's interval is HALF-OPEN
 * `[lo, hi)` EXCEPT the final bin, which is CLOSED `[lo, hi]` so the maximum
 * value always lands somewhere. When `min === max` (including the 1-record
 * case), there is exactly one bin, `[min, max]` (closed), holding every
 * value. An EMPTY input surfaces `min = max = mean = p50 = p90 = 0` and
 * `bins = []` — never `NaN` — by explicit, documented convention (the
 * `Histogram.mean`/etc. fields are typed as plain `number`, not
 * `number | null`, so 0 is the honest "nothing measured" value here).
 * `TrainingRecord` (`./example`) does not retain the source trajectory's
 * `capability`/`model` provenance, so `byCapability`/`byModel` are always
 * `[]` — this module never guesses those from free text.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";

import { readManifest, datasetDigest, type DatasetManifest, type ShardDescriptor, type ExportIo } from "./exporter";
import { canonicalRecordJson, recordId, assignSplit, type TrainingRecord, type ExampleSchema } from "./example";
import { VerifiedTrajectoryCorpus, type CorpusEntry, type RealityClass } from "./corpus";
import { sha256Hex, verifyCertificate, canonicalize } from "../styx/certificate";
import { canonicalTrajectoryJson } from "../skills/synthesize";
import { tryDecodeJsonLine } from "../eval/json-line";

// keep TS from flagging the read-only re-export of ExampleSchema as unused
// when only referenced inside JSDoc/type positions below.
export type { ExampleSchema };

// ===========================================================================
// Locked public types
// ===========================================================================

export type AuditCode =
  | "manifest-unreadable"
  | "future-format"
  | "shard-missing"
  | "shard-hash-mismatch"
  | "decompress-failed"
  | "record-unparseable"
  | "record-id-mismatch"
  | "schema-violation"
  | "duplicate-record"
  | "split-leak"
  | "split-misassigned"
  | "label-unverified"
  | "label-exceeds-certificate"
  | "cert-signature-invalid"
  | "trace-hash-mismatch"
  | "mock-labelled-real"
  | "count-mismatch"
  | "digest-mismatch"
  | "spec-hash-mismatch"
  | "corpus-head-mismatch"
  | "corpus-membership-missing";

export interface AuditFinding {
  code: AuditCode;
  severity: "fatal" | "warn";
  detail: string;
  shard?: string;
  recordId?: string;
  trajectorySha256?: string;
}

export interface DatasetAuditReport {
  ok: boolean;
  dir: string;
  formatVersion: number;
  manifestDigest: string;
  recomputedDigest: string;
  records: number;
  shardsChecked: number;
  certificatesVerified: number;
  certificatesFailed: number;
  corpusCrossChecked: boolean;
  findings: AuditFinding[];
  durationMs?: number;
}

export interface AuditOptions {
  io?: ExportIo;
  corpus?: VerifiedTrajectoryCorpus;
  verifySignatures?: boolean;
  maxFindings?: number;
  now?: () => number;
}

export interface Histogram {
  bins: { lo: number; hi: number; count: number }[];
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
}

export interface DatasetStats {
  records: number;
  train: number;
  holdout: number;
  bySchema: Record<string, number>;
  byCapability: { key: string; count: number }[];
  byTool: { key: string; count: number }[];
  byModel: { key: string; count: number }[];
  byRealityClass: Record<RealityClass, number>;
  pCorrect: Histogram;
  epsilon: Histogram;
  tokensEstimate: Histogram;
  stepCount: Histogram;
  distinctObjectives: number;
  duplicateRate: number;
  oldestIssuedAt: number | null;
  newestIssuedAt: number | null;
  redactions: number;
}

// ===========================================================================
// Small generic helpers
// ===========================================================================

const MANIFEST_FILE_NAME = "manifest.json";
/** Mirrors `./exporter`'s `DATASET_FORMAT_VERSION` (not imported — that
 *  constant is outside this module's locked import surface; kept numerically
 *  identical so this auditor's "future format" boundary matches the real
 *  exporter's own). */
const AUDIT_SUPPORTED_FORMAT_VERSION = 1;
const DEFAULT_MAX_FINDINGS = 5000;
const CERT_BATCH_SIZE = 64;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const LABEL_TOLERANCE = 1e-9;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Raw-byte sha256, hex-encoded. See the module header's "Binary hashing". */
function sha256HexBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Default `ExportIo`: real filesystem access, used only when the caller
 *  does not inject one. Mirrors `./exporter`'s own default IO shape exactly
 *  so this auditor and the exporter agree on what "the filesystem" means. */
const REAL_IO: ExportIo = {
  mkdirSync: nodeMkdirSync,
  writeFileSync: nodeWriteFileSync,
  readFileSync: nodeReadFileSync,
  existsSync: nodeExistsSync,
  renameSync: nodeRenameSync,
  rmSync: nodeRmSync,
  readdirSync: nodeReaddirSync,
};

// ===========================================================================
// Shape validation — never trust a parsed JSON value's TypeScript type
// ===========================================================================

function isValidShardDescriptor(v: unknown): v is ShardDescriptor {
  if (!isPlainObject(v)) return false;
  if (typeof v.index !== "number" || !Number.isInteger(v.index) || v.index < 0) return false;
  if (v.split !== "train" && v.split !== "holdout") return false;
  if (typeof v.file !== "string" || v.file.length === 0) return false;
  if (typeof v.records !== "number" || !Number.isInteger(v.records) || v.records < 0) return false;
  if (typeof v.bytesRaw !== "number" || !Number.isFinite(v.bytesRaw) || v.bytesRaw < 0) return false;
  if (typeof v.bytesStored !== "number" || !Number.isFinite(v.bytesStored) || v.bytesStored < 0) return false;
  if (typeof v.sha256Raw !== "string") return false;
  if (typeof v.sha256Stored !== "string") return false;
  return true;
}

const DATASET_COUNTS_KEYS = [
  "records",
  "train",
  "holdout",
  "skipped",
  "redactions",
  "mockTaintedExcluded",
  "duplicatesDropped",
] as const;

function isValidCounts(v: unknown): v is DatasetManifest["counts"] {
  if (!isPlainObject(v)) return false;
  for (const k of DATASET_COUNTS_KEYS) {
    if (typeof v[k] !== "number" || !Number.isFinite(v[k])) return false;
  }
  return true;
}

function isValidManifestShape(v: unknown): v is DatasetManifest {
  if (!isPlainObject(v)) return false;
  if (typeof v.formatVersion !== "number" || !Number.isInteger(v.formatVersion) || v.formatVersion < 0) return false;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return false;
  if (!isPlainObject(v.generator) || v.generator.name !== "hades" || typeof v.generator.phase !== "number") {
    return false;
  }
  if (typeof v.specHash !== "string" || v.specHash.length === 0) return false;
  if (!isPlainObject(v.spec)) return false;
  const spec = v.spec;
  if (typeof spec.holdoutFraction !== "number" || !Number.isFinite(spec.holdoutFraction)) return false;
  if (spec.holdoutSalt !== undefined && typeof spec.holdoutSalt !== "string") return false;
  if (typeof spec.schema !== "string") return false;
  if (spec.compression !== "gzip" && spec.compression !== "none") return false;
  if (!isPlainObject(v.corpus)) return false;
  const corpus = v.corpus;
  if (typeof corpus.genesis !== "string" || typeof corpus.head !== "string") return false;
  if (typeof corpus.entriesScanned !== "number" || !Number.isFinite(corpus.entriesScanned)) return false;
  if (corpus.verifiedOnly !== true) return false;
  if (!Array.isArray(v.shards) || !v.shards.every(isValidShardDescriptor)) return false;
  if (!isValidCounts(v.counts)) return false;
  if (!Array.isArray(v.skips)) return false;
  for (const sk of v.skips) {
    if (!isPlainObject(sk) || typeof sk.code !== "string" || typeof sk.count !== "number") return false;
  }
  if (typeof v.digest !== "string" || v.digest.length === 0) return false;
  return true;
}

const SCHEMAS: ReadonlySet<string> = new Set(["sft-prompt-completion", "chat-messages", "tool-trace"]);
const SPLITS: ReadonlySet<string> = new Set(["train", "holdout"]);
const REALITY_CLASSES: ReadonlySet<string> = new Set(["real", "mock-tainted"]);

function isValidLabelShape(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (v.verified !== true) return false;
  if (typeof v.certSha256 !== "string" || v.certSha256.length === 0) return false;
  if (typeof v.pCorrect !== "number" || !Number.isFinite(v.pCorrect) || v.pCorrect < 0 || v.pCorrect > 1) return false;
  if (typeof v.epsilon !== "number" || !Number.isFinite(v.epsilon) || v.epsilon < 0) return false;
  if (typeof v.verifierTier !== "string" || v.verifierTier.length === 0) return false;
  if (!Array.isArray(v.verifierVersions) || !v.verifierVersions.every((x) => typeof x === "string")) return false;
  if (typeof v.realityClass !== "string" || !REALITY_CLASSES.has(v.realityClass)) return false;
  if (typeof v.issuedAt !== "number" || !Number.isFinite(v.issuedAt)) return false;
  return true;
}

/**
 * Returns `null` when `v` is a structurally valid `TrainingRecord`, else a
 * human-readable reason. Never throws.
 *
 * `id` is deliberately NOT required: `./exporter`'s `pushRecord` writes each
 * shard line as `canonicalRecordJson(record)`, and `canonicalRecordJson`'s
 * own `RECORD_KEY_ORDER` (`./example`) EXCLUDES `id` by design (`id` is a
 * pure hash of every OTHER field, so persisting it would be redundant, and
 * `recordId()` zeroes whatever `id` it is given before hashing anyway). A
 * genuine on-disk row therefore never carries an `id` field at all — this
 * module always derives it fresh via `recordId()` (see `processShard`) and
 * only raises `record-id-mismatch` in the narrower case where a row
 * (forged or otherwise) DOES carry an explicit `id` that disagrees with the
 * recompute.
 */
function validateRecordShape(v: unknown): string | null {
  if (!isPlainObject(v)) return "record is not an object";
  if (v.id !== undefined && (typeof v.id !== "string" || v.id.length === 0)) {
    return "id is present but not a non-empty string";
  }
  if (typeof v.schemaVersion !== "number") return "schemaVersion missing/invalid";
  if (typeof v.schema !== "string" || !SCHEMAS.has(v.schema)) return "schema missing/invalid";
  if (typeof v.trajectorySha256 !== "string" || !HEX64_RE.test(v.trajectorySha256)) {
    return "trajectorySha256 is not a 64-char hex sha256";
  }
  if (typeof v.objective !== "string") return "objective missing/invalid";
  if (v.schema === "chat-messages" && !Array.isArray(v.messages)) return "chat-messages record missing messages[]";
  if (v.schema === "sft-prompt-completion" && (typeof v.prompt !== "string" || typeof v.completion !== "string")) {
    return "sft-prompt-completion record missing prompt/completion";
  }
  if (v.schema === "tool-trace" && (!Array.isArray(v.steps) || typeof v.prompt !== "string")) {
    return "tool-trace record missing steps[]/prompt";
  }
  if (!isValidLabelShape(v.label)) return "label missing/invalid";
  if (typeof v.split !== "string" || !SPLITS.has(v.split)) return "split missing/invalid";
  if (typeof v.charCount !== "number" || v.charCount < 0) return "charCount missing/invalid";
  if (typeof v.tokensEstimate !== "number" || v.tokensEstimate < 0) return "tokensEstimate missing/invalid";
  if (typeof v.truncated !== "boolean") return "truncated missing/invalid";
  if (typeof v.redactions !== "number" || v.redactions < 0) return "redactions missing/invalid";
  return null;
}

// ===========================================================================
// Finding ordering / capping
// ===========================================================================

function compareFindings(a: AuditFinding, b: AuditFinding): number {
  const shardCmp = (a.shard ?? "").localeCompare(b.shard ?? "");
  if (shardCmp !== 0) return shardCmp;
  const recCmp = (a.recordId ?? "").localeCompare(b.recordId ?? "");
  if (recCmp !== 0) return recCmp;
  return a.code.localeCompare(b.code);
}

function clampMaxFindings(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_MAX_FINDINGS;
  return Math.max(0, Math.floor(n));
}

/** Caps `sorted` at `maxFindings`, honestly annotating the LAST retained
 *  finding's `detail` with how many more were suppressed rather than
 *  silently pretending the list is complete. */
function capFindings(sorted: readonly AuditFinding[], maxFindings: number): AuditFinding[] {
  if (sorted.length <= maxFindings) return sorted.slice();
  const capped = sorted.slice(0, maxFindings);
  if (capped.length > 0) {
    const suppressed = sorted.length - capped.length;
    const last = capped[capped.length - 1];
    capped[capped.length - 1] = {
      ...last,
      detail: `${last.detail} [+${suppressed} more finding(s) suppressed; maxFindings=${maxFindings}]`,
    };
  }
  return capped;
}

// ===========================================================================
// Manifest loading (defensive — see module header)
// ===========================================================================

interface ManifestLoad {
  ok: true;
  manifest: DatasetManifest;
}
interface ManifestLoadFail {
  ok: false;
  finding: AuditFinding;
  claimedFormatVersion: number;
}

function loadAndValidateManifest(dir: string, io: ExportIo): ManifestLoad | ManifestLoadFail {
  const manifestPath = join(dir, MANIFEST_FILE_NAME);

  if (!io.existsSync(manifestPath)) {
    return {
      ok: false,
      claimedFormatVersion: 0,
      finding: { code: "manifest-unreadable", severity: "fatal", detail: `no ${MANIFEST_FILE_NAME} found at "${manifestPath}"` },
    };
  }

  let text: string;
  try {
    text = (io.readFileSync(manifestPath) as Buffer).toString("utf8");
  } catch (err) {
    return {
      ok: false,
      claimedFormatVersion: 0,
      finding: { code: "manifest-unreadable", severity: "fatal", detail: `failed to read "${manifestPath}": ${errMsg(err)}` },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      claimedFormatVersion: 0,
      finding: { code: "manifest-unreadable", severity: "fatal", detail: `"${manifestPath}" is not valid JSON: ${errMsg(err)}` },
    };
  }

  if (!isPlainObject(raw) || typeof raw.formatVersion !== "number" || !Number.isFinite(raw.formatVersion)) {
    return {
      ok: false,
      claimedFormatVersion: 0,
      finding: {
        code: "manifest-unreadable",
        severity: "fatal",
        detail: `"${manifestPath}" is valid JSON but not a recognizable dataset manifest (missing/invalid formatVersion)`,
      },
    };
  }

  const claimedFormatVersion = raw.formatVersion;
  if (claimedFormatVersion > AUDIT_SUPPORTED_FORMAT_VERSION) {
    return {
      ok: false,
      claimedFormatVersion,
      finding: {
        code: "future-format",
        severity: "fatal",
        detail: `manifest declares formatVersion ${claimedFormatVersion}; this build understands up to ${AUDIT_SUPPORTED_FORMAT_VERSION} and refuses to misparse it`,
      },
    };
  }

  if (!isValidManifestShape(raw)) {
    return {
      ok: false,
      claimedFormatVersion,
      finding: {
        code: "manifest-unreadable",
        severity: "fatal",
        detail: `"${manifestPath}" failed dataset manifest shape validation`,
      },
    };
  }

  let manifest: DatasetManifest = raw;
  // Best-effort: also exercise the real `readManifest` (which additionally
  // verifies the digest internally) and prefer its parse when it also
  // independently validates. A thrown `ExportRefusal` here — including one
  // caused by a genuinely tampered digest — is NOT treated as
  // "unreadable": this function's own parse above is already authoritative,
  // and tampering is exactly what the rest of this module's independent
  // recompute is for.
  try {
    const viaReal = readManifest(dir, io);
    if (isValidManifestShape(viaReal)) manifest = viaReal;
  } catch {
    /* fall back to the manifest this function already validated itself */
  }

  return { ok: true, manifest };
}

// ===========================================================================
// Per-shard processing
// ===========================================================================

interface ShardProcessResult {
  descriptor: ShardDescriptor;
  records: TrainingRecord[];
  findings: AuditFinding[];
}

function emptyDescriptor(shard: ShardDescriptor): ShardDescriptor {
  return {
    index: shard.index,
    split: shard.split,
    file: shard.file,
    records: 0,
    bytesRaw: 0,
    bytesStored: 0,
    sha256Raw: "",
    sha256Stored: "",
  };
}

function processShard(
  dir: string,
  io: ExportIo,
  shard: ShardDescriptor,
  compression: "gzip" | "none",
): ShardProcessResult {
  const findings: AuditFinding[] = [];
  const shardPath = join(dir, shard.file);

  if (!io.existsSync(shardPath)) {
    findings.push({
      code: "shard-missing",
      severity: "fatal",
      shard: shard.file,
      detail: `declared shard file "${shard.file}" is missing at "${shardPath}"`,
    });
    return { descriptor: emptyDescriptor(shard), records: [], findings };
  }

  let raw: Buffer;
  try {
    raw = io.readFileSync(shardPath) as Buffer;
  } catch (err) {
    findings.push({
      code: "shard-missing",
      severity: "fatal",
      shard: shard.file,
      detail: `failed to read "${shardPath}": ${errMsg(err)}`,
    });
    return { descriptor: emptyDescriptor(shard), records: [], findings };
  }

  const bytesStored = raw.length;
  const recomputedSha256Stored = sha256HexBytes(raw);

  let text: string;
  if (compression === "gzip") {
    try {
      text = gunzipSync(raw).toString("utf8");
    } catch (err) {
      findings.push({
        code: "decompress-failed",
        severity: "fatal",
        shard: shard.file,
        detail: `gunzip failed for "${shardPath}" (${bytesStored} byte${bytesStored === 1 ? "" : "s"} on disk): ${errMsg(err)}`,
      });
      return {
        descriptor: { ...emptyDescriptor(shard), bytesStored, sha256Stored: recomputedSha256Stored },
        records: [],
        findings,
      };
    }
  } else {
    text = raw.toString("utf8");
  }

  const bytesRaw = Buffer.byteLength(text, "utf8");
  const recomputedSha256Raw = sha256Hex(text);

  if (recomputedSha256Raw !== shard.sha256Raw || recomputedSha256Stored !== shard.sha256Stored) {
    findings.push({
      code: "shard-hash-mismatch",
      severity: "fatal",
      shard: shard.file,
      detail:
        `recomputed hash(es) for "${shard.file}" do not match the manifest: ` +
        `sha256Raw manifest=${shard.sha256Raw || "<empty>"} recomputed=${recomputedSha256Raw}; ` +
        `sha256Stored manifest=${shard.sha256Stored || "<empty>"} recomputed=${recomputedSha256Stored}`,
    });
  }

  const lines = text.length === 0 ? [] : text.split("\n").filter((l) => l.length > 0);
  const records: TrainingRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const decoded = tryDecodeJsonLine(lines[i]);
    if (decoded === undefined) {
      findings.push({
        code: "record-unparseable",
        severity: "fatal",
        shard: shard.file,
        detail: `line ${i + 1} in "${shard.file}" is not parseable JSON`,
      });
      continue;
    }
    const shapeError = validateRecordShape(decoded);
    if (shapeError !== null) {
      findings.push({
        code: "schema-violation",
        severity: "fatal",
        shard: shard.file,
        recordId: isPlainObject(decoded) && typeof decoded.id === "string" ? decoded.id : undefined,
        detail: `line ${i + 1} in "${shard.file}" failed schema validation: ${shapeError}`,
      });
      continue;
    }

    const decodedObj = decoded as Record<string, unknown>;
    const withoutId = { ...decodedObj, id: "" } as unknown as TrainingRecord;
    const claimedId = typeof decodedObj.id === "string" && decodedObj.id.length > 0 ? decodedObj.id : undefined;
    let computedId: string;
    try {
      computedId = recordId(withoutId);
    } catch (err) {
      findings.push({
        code: "schema-violation",
        severity: "fatal",
        shard: shard.file,
        recordId: claimedId,
        detail: `line ${i + 1} in "${shard.file}" could not recompute a record id from its content: ${errMsg(err)}`,
      });
      continue;
    }
    if (claimedId !== undefined && claimedId !== computedId) {
      findings.push({
        code: "record-id-mismatch",
        severity: "fatal",
        shard: shard.file,
        recordId: claimedId,
        detail: `line ${i + 1} in "${shard.file}" carries an embedded id ${claimedId} that does not match the recomputed id ${computedId} for this row's content`,
      });
    }
    records.push({ ...withoutId, id: computedId });
  }

  return {
    descriptor: {
      index: shard.index,
      split: shard.split,
      file: shard.file,
      records: records.length,
      bytesRaw,
      bytesStored,
      sha256Raw: recomputedSha256Raw,
      sha256Stored: recomputedSha256Stored,
    },
    records,
    findings,
  };
}

// ===========================================================================
// auditDataset
// ===========================================================================

function baseReport(
  dir: string,
  formatVersion: number,
  corpusCrossChecked: boolean,
  findings: AuditFinding[],
  maxFindings: number,
  startedAt: number,
  nowFn: () => number,
  extra: Partial<Omit<DatasetAuditReport, "dir" | "formatVersion" | "corpusCrossChecked" | "findings" | "ok" | "durationMs">> = {},
): DatasetAuditReport {
  const ok = findings.every((f) => f.severity !== "fatal");
  const sorted = [...findings].sort(compareFindings);
  const capped = capFindings(sorted, maxFindings);
  return {
    ok,
    dir,
    formatVersion,
    manifestDigest: "",
    recomputedDigest: "",
    records: 0,
    shardsChecked: 0,
    certificatesVerified: 0,
    certificatesFailed: 0,
    corpusCrossChecked,
    ...extra,
    findings: capped,
    durationMs: nowFn() - startedAt,
  };
}

/**
 * Re-derive a dataset's trustworthiness from bytes alone. See the module
 * header for the full "trust nothing, recompute everything" contract. Never
 * throws — every failure mode is a typed `fatal` `AuditFinding` in the
 * returned report.
 */
export async function auditDataset(dir: string, opts: AuditOptions = {}): Promise<DatasetAuditReport> {
  const nowFn = opts.now ?? Date.now;
  const startedAt = nowFn();
  const io = opts.io ?? REAL_IO;
  const maxFindings = clampMaxFindings(opts.maxFindings);
  const corpusCrossChecked = opts.corpus !== undefined;

  if (typeof dir !== "string" || dir.length === 0) {
    return baseReport(
      String(dir ?? ""),
      0,
      corpusCrossChecked,
      [{ code: "manifest-unreadable", severity: "fatal", detail: "dataset directory path is empty/invalid" }],
      maxFindings,
      startedAt,
      nowFn,
    );
  }

  if (!io.existsSync(dir)) {
    return baseReport(
      dir,
      0,
      corpusCrossChecked,
      [{ code: "manifest-unreadable", severity: "fatal", detail: `dataset directory "${dir}" does not exist` }],
      maxFindings,
      startedAt,
      nowFn,
    );
  }

  const loaded = loadAndValidateManifest(dir, io);
  if (!loaded.ok) {
    return baseReport(dir, loaded.claimedFormatVersion, corpusCrossChecked, [loaded.finding], maxFindings, startedAt, nowFn);
  }
  const manifest = loaded.manifest;
  const findings: AuditFinding[] = [];

  if (!HEX64_RE.test(manifest.specHash)) {
    findings.push({
      code: "spec-hash-mismatch",
      severity: "fatal",
      detail: `manifest.specHash "${manifest.specHash}" is not a well-formed sha256 hex digest (see module header's "The specHash boundary")`,
    });
  }

  // -------------------------------------------------------------------------
  // Per-shard: hash, decompress, decode, shape-validate.
  // -------------------------------------------------------------------------
  const recomputedShards: ShardDescriptor[] = [];
  const allEntries: { shardFile: string; record: TrainingRecord }[] = [];
  for (const shard of manifest.shards) {
    const result = processShard(dir, io, shard, manifest.spec.compression);
    findings.push(...result.findings);
    recomputedShards.push(result.descriptor);
    for (const record of result.records) allEntries.push({ shardFile: shard.file, record });
  }

  // -------------------------------------------------------------------------
  // Cross-record: id recompute, dedup, split recompute, split-leak, counts.
  // -------------------------------------------------------------------------
  const seenIds = new Map<string, string>();
  const trajSplits = new Map<string, Set<"train" | "holdout">>();
  let trainCount = 0;
  let holdoutCount = 0;
  let redactionsSum = 0;

  for (const { shardFile, record } of allEntries) {
    const priorShard = seenIds.get(record.id);
    if (priorShard !== undefined) {
      findings.push({
        code: "duplicate-record",
        severity: "fatal",
        shard: shardFile,
        recordId: record.id,
        detail: `record id ${record.id} appears more than once (first seen in shard "${priorShard}")`,
      });
    } else {
      seenIds.set(record.id, shardFile);
    }

    // `record.id` is already the recomputed value (see `processShard`) —
    // `record-id-mismatch` is raised there, against whatever `id` the raw
    // line actually claimed, if any.

    const recomputedSplit = assignSplit(record.trajectorySha256, manifest.spec.holdoutFraction, manifest.spec.holdoutSalt);
    if (recomputedSplit !== record.split) {
      findings.push({
        code: "split-misassigned",
        severity: "fatal",
        shard: shardFile,
        recordId: record.id,
        trajectorySha256: record.trajectorySha256,
        detail: `recomputed split "${recomputedSplit}" (holdoutFraction=${manifest.spec.holdoutFraction}, holdoutSalt=${JSON.stringify(manifest.spec.holdoutSalt ?? "")}) does not match the record's declared split "${record.split}"`,
      });
    }

    if (record.split === "train") trainCount++;
    else if (record.split === "holdout") holdoutCount++;
    redactionsSum += record.redactions;

    let set = trajSplits.get(record.trajectorySha256);
    if (set === undefined) {
      set = new Set();
      trajSplits.set(record.trajectorySha256, set);
    }
    set.add(record.split);
  }

  for (const [traj, set] of trajSplits) {
    if (set.size > 1) {
      findings.push({
        code: "split-leak",
        severity: "fatal",
        trajectorySha256: traj,
        detail: `trajectory ${traj} has records in BOTH the train and holdout splits — the holdout guarantee is contaminated`,
      });
    }
  }

  const recomputedRecordsCount = allEntries.length;
  if (
    recomputedRecordsCount !== manifest.counts.records ||
    trainCount !== manifest.counts.train ||
    holdoutCount !== manifest.counts.holdout ||
    redactionsSum !== manifest.counts.redactions
  ) {
    findings.push({
      code: "count-mismatch",
      severity: "fatal",
      detail:
        `manifest declares {records:${manifest.counts.records}, train:${manifest.counts.train}, holdout:${manifest.counts.holdout}, redactions:${manifest.counts.redactions}} ` +
        `but the recomputed values from the bytes on disk are {records:${recomputedRecordsCount}, train:${trainCount}, holdout:${holdoutCount}, redactions:${redactionsSum}} ` +
        `(skipped/mockTaintedExcluded/duplicatesDropped are not independently verifiable from an exported dataset alone — see module header's "The counts boundary")`,
    });
  }

  // -------------------------------------------------------------------------
  // Corpus cross-check (optional): membership, signature, trace hash, label
  // consistency, reality-class consistency, corpus head pin.
  // -------------------------------------------------------------------------
  let certificatesVerified = 0;
  let certificatesFailed = 0;
  let recomputedCorpusHead = manifest.corpus.head;

  if (opts.corpus !== undefined) {
    const corpus = opts.corpus;
    const corpusEntries = corpus.entries(); // O(m) — called exactly once
    const corpusByTraj = new Map<string, CorpusEntry>(corpusEntries.map((e) => [e.trajectorySha256, e]));
    recomputedCorpusHead = corpus.head(); // O(m) — called exactly once

    if (recomputedCorpusHead !== manifest.corpus.head) {
      findings.push({
        code: "corpus-head-mismatch",
        severity: "fatal",
        detail: `manifest pins corpus.head ${manifest.corpus.head || "<empty>"} but the supplied corpus's actual head is ${recomputedCorpusHead}`,
      });
    }

    const verifySignatures = opts.verifySignatures !== false;

    for (let i = 0; i < allEntries.length; i += CERT_BATCH_SIZE) {
      const batch = allEntries.slice(i, i + CERT_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async ({ shardFile, record }): Promise<{ findings: AuditFinding[]; verified: boolean; attempted: boolean }> => {
          const out: AuditFinding[] = [];
          const entry = corpusByTraj.get(record.trajectorySha256);
          if (entry === undefined) {
            out.push({
              code: "corpus-membership-missing",
              severity: "fatal",
              shard: shardFile,
              recordId: record.id,
              trajectorySha256: record.trajectorySha256,
              detail: `trajectory ${record.trajectorySha256} referenced by record ${record.id} was not found in the supplied corpus`,
            });
            return { findings: out, verified: false, attempted: false };
          }

          if (record.label.realityClass === "real" && entry.provenance.realityClass === "mock-tainted") {
            out.push({
              code: "mock-labelled-real",
              severity: "fatal",
              shard: shardFile,
              recordId: record.id,
              trajectorySha256: record.trajectorySha256,
              detail: `record labels realityClass "real" but the corpus's provenance for this trajectory is "mock-tainted" (markers: ${entry.provenance.mockMarkers.join(", ") || "none"})`,
            });
          }

          let recomputedCertSha256: string | null = null;
          try {
            recomputedCertSha256 = sha256Hex(canonicalize(entry.certificate.payload));
          } catch {
            recomputedCertSha256 = null;
          }
          if (record.label.certSha256 !== entry.certSha256 && record.label.certSha256 !== recomputedCertSha256) {
            out.push({
              code: "label-unverified",
              severity: "fatal",
              shard: shardFile,
              recordId: record.id,
              trajectorySha256: record.trajectorySha256,
              detail: `record label certSha256 ${record.label.certSha256} does not correspond to the corpus entry's certificate (expected ${entry.certSha256})`,
            });
          }

          if (record.label.pCorrect > entry.certificate.payload.pCorrect + LABEL_TOLERANCE) {
            out.push({
              code: "label-exceeds-certificate",
              severity: "fatal",
              shard: shardFile,
              recordId: record.id,
              trajectorySha256: record.trajectorySha256,
              detail: `record label pCorrect ${record.label.pCorrect} exceeds the certificate's payload pCorrect ${entry.certificate.payload.pCorrect}`,
            });
          } else if (record.label.epsilon < entry.certificate.payload.epsilon - LABEL_TOLERANCE) {
            out.push({
              code: "label-exceeds-certificate",
              severity: "fatal",
              shard: shardFile,
              recordId: record.id,
              trajectorySha256: record.trajectorySha256,
              detail: `record label epsilon ${record.label.epsilon} claims a tighter bound than the certificate's payload epsilon ${entry.certificate.payload.epsilon}`,
            });
          }

          if (!verifySignatures) return { findings: out, verified: false, attempted: false };

          let sigOk = false;
          try {
            sigOk = await verifyCertificate(entry.certificate);
          } catch {
            sigOk = false;
          }
          if (!sigOk) {
            out.push({
              code: "cert-signature-invalid",
              severity: "fatal",
              shard: shardFile,
              recordId: record.id,
              trajectorySha256: record.trajectorySha256,
              detail: `ed25519 signature on the certificate for trajectory ${record.trajectorySha256} does not verify against its embedded public key`,
            });
            return { findings: out, verified: false, attempted: true };
          }

          let recomputedTrajHash = "";
          try {
            recomputedTrajHash = sha256Hex(canonicalTrajectoryJson(entry.trajectory));
          } catch (err) {
            out.push({
              code: "trace-hash-mismatch",
              severity: "fatal",
              shard: shardFile,
              recordId: record.id,
              trajectorySha256: record.trajectorySha256,
              detail: `failed to recompute the trajectory hash for cross-check: ${errMsg(err)}`,
            });
            return { findings: out, verified: false, attempted: true };
          }
          if (recomputedTrajHash !== record.trajectorySha256) {
            out.push({
              code: "trace-hash-mismatch",
              severity: "fatal",
              shard: shardFile,
              recordId: record.id,
              trajectorySha256: record.trajectorySha256,
              detail: `independently recomputed sha256Hex(canonicalTrajectoryJson(trajectory)) (${recomputedTrajHash}) does not equal the record's trajectorySha256 (${record.trajectorySha256})`,
            });
            return { findings: out, verified: false, attempted: true };
          }
          return { findings: out, verified: true, attempted: true };
        }),
      );
      for (const res of batchResults) {
        for (const f of res.findings) findings.push(f);
        if (res.attempted) {
          if (res.verified) certificatesVerified++;
          else certificatesFailed++;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Manifest-level: digest recompute.
  // -------------------------------------------------------------------------
  const { digest: manifestDigest, ...manifestRest } = manifest;
  const candidateManifest: Omit<DatasetManifest, "digest"> = {
    ...manifestRest,
    shards: recomputedShards,
    counts: {
      ...manifest.counts,
      records: recomputedRecordsCount,
      train: trainCount,
      holdout: holdoutCount,
      redactions: redactionsSum,
    },
    corpus: { ...manifest.corpus, head: recomputedCorpusHead },
  };
  let recomputedDigest = "";
  try {
    recomputedDigest = datasetDigest(candidateManifest);
  } catch (err) {
    findings.push({ code: "digest-mismatch", severity: "fatal", detail: `failed to recompute dataset digest: ${errMsg(err)}` });
  }
  if (recomputedDigest !== "" && recomputedDigest !== manifestDigest) {
    findings.push({
      code: "digest-mismatch",
      severity: "fatal",
      detail: `manifest declares digest ${manifestDigest || "<empty>"} but the recomputed digest from the bytes actually on disk is ${recomputedDigest}`,
    });
  }

  return baseReport(dir, manifest.formatVersion, corpusCrossChecked, findings, maxFindings, startedAt, nowFn, {
    manifestDigest,
    recomputedDigest,
    records: allEntries.length,
    shardsChecked: manifest.shards.length,
    certificatesVerified,
    certificatesFailed,
  });
}

// ===========================================================================
// readDatasetRecords — the lighter read path `hades dataset stats` uses
// ===========================================================================

/**
 * Reads and decodes every record in the dataset at `dir`, recomputing each
 * shard's hash and re-validating each record's shape along the way (same
 * "trust nothing" per-shard pipeline `auditDataset` uses), WITHOUT the
 * cross-record dedup/split/corpus cross-checks — a lighter pass suited to
 * feeding {@link computeStats}. Never throws.
 */
export function readDatasetRecords(dir: string, opts: { io?: ExportIo } = {}): { records: TrainingRecord[]; errors: AuditFinding[] } {
  const io = opts.io ?? REAL_IO;
  const errors: AuditFinding[] = [];

  if (typeof dir !== "string" || dir.length === 0 || !io.existsSync(dir)) {
    errors.push({ code: "manifest-unreadable", severity: "fatal", detail: `dataset directory "${String(dir)}" does not exist` });
    return { records: [], errors };
  }

  const loaded = loadAndValidateManifest(dir, io);
  if (!loaded.ok) {
    errors.push(loaded.finding);
    return { records: [], errors };
  }

  const records: TrainingRecord[] = [];
  for (const shard of loaded.manifest.shards) {
    const result = processShard(dir, io, shard, loaded.manifest.spec.compression);
    errors.push(...result.findings);
    records.push(...result.records);
  }
  return { records, errors: [...errors].sort(compareFindings) };
}

// ===========================================================================
// computeStats
// ===========================================================================

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

const HISTOGRAM_BIN_COUNT = 10;

function buildHistogram(valuesIn: readonly number[]): Histogram {
  const values = valuesIn.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (values.length === 0) return { bins: [], min: 0, max: 0, mean: 0, p50: 0, p90: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);

  const bins: Histogram["bins"] = [];
  if (min === max) {
    bins.push({ lo: min, hi: max, count: sorted.length });
  } else {
    const width = (max - min) / HISTOGRAM_BIN_COUNT;
    const counts = new Array<number>(HISTOGRAM_BIN_COUNT).fill(0);
    for (const v of sorted) {
      let idx = Math.floor((v - min) / width);
      if (idx >= HISTOGRAM_BIN_COUNT) idx = HISTOGRAM_BIN_COUNT - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    }
    for (let i = 0; i < HISTOGRAM_BIN_COUNT; i++) {
      const lo = min + i * width;
      const hi = i === HISTOGRAM_BIN_COUNT - 1 ? max : min + (i + 1) * width;
      bins.push({ lo, hi, count: counts[i] });
    }
  }
  return { bins, min, max, mean, p50, p90 };
}

/**
 * Compute honest, non-extrapolated dataset statistics from the records in
 * front of it — nothing here samples or estimates except `tokensEstimate`,
 * which is a copy of the ALREADY-estimate-labelled field `./example` writes
 * onto every record (see {@link formatStatsReport}, which labels it
 * explicitly). `byTool`/`stepCount` are derived only from schemas that carry
 * a STRUCTURED step/message list (`tool-trace`'s `steps[]`, `chat-messages`'
 * `role: "tool"` messages); `sft-prompt-completion` records contribute
 * nothing to either, rather than having their free-text `completion` parsed.
 * `byCapability`/`byModel` are always `[]` — see the module header.
 */
export function computeStats(records: readonly TrainingRecord[]): DatasetStats {
  // `Array.isArray`'s TS signature narrows to `any[]`, not `T[]` — the
  // explicit annotation here keeps every downstream field typed instead of
  // silently degrading to `any` for the rest of this function.
  const list: readonly TrainingRecord[] = Array.isArray(records) ? records : [];

  let train = 0;
  let holdout = 0;
  const bySchema: Record<string, number> = {};
  const byToolCounts = new Map<string, number>();
  const byRealityClass: Record<RealityClass, number> = { real: 0, "mock-tainted": 0 };
  const pCorrectValues: number[] = [];
  const epsilonValues: number[] = [];
  const tokensValues: number[] = [];
  const stepCountValues: number[] = [];
  const objectives = new Set<string>();
  const trajectories = new Set<string>();
  let redactions = 0;
  let oldestIssuedAt: number | null = null;
  let newestIssuedAt: number | null = null;

  for (const r of list) {
    if (r.split === "train") train++;
    else if (r.split === "holdout") holdout++;

    bySchema[r.schema] = (bySchema[r.schema] ?? 0) + 1;

    if (r.label.realityClass === "real" || r.label.realityClass === "mock-tainted") {
      byRealityClass[r.label.realityClass] = (byRealityClass[r.label.realityClass] ?? 0) + 1;
    }

    pCorrectValues.push(r.label.pCorrect);
    epsilonValues.push(r.label.epsilon);
    tokensValues.push(r.tokensEstimate);

    if (r.schema === "tool-trace" && Array.isArray(r.steps)) {
      stepCountValues.push(r.steps.length);
      for (const step of r.steps) {
        byToolCounts.set(step.tool, (byToolCounts.get(step.tool) ?? 0) + 1);
      }
    } else if (r.schema === "chat-messages" && Array.isArray(r.messages)) {
      const toolMessages = r.messages.filter((m) => m.role === "tool");
      stepCountValues.push(toolMessages.length);
      for (const m of toolMessages) {
        if (typeof m.name === "string" && m.name.length > 0) {
          byToolCounts.set(m.name, (byToolCounts.get(m.name) ?? 0) + 1);
        }
      }
    }
    // sft-prompt-completion: no structurally-reliable step/tool signal — skip.

    objectives.add(r.objective);
    trajectories.add(r.trajectorySha256);
    redactions += r.redactions;

    if (oldestIssuedAt === null || r.label.issuedAt < oldestIssuedAt) oldestIssuedAt = r.label.issuedAt;
    if (newestIssuedAt === null || r.label.issuedAt > newestIssuedAt) newestIssuedAt = r.label.issuedAt;
  }

  const byTool = [...byToolCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const duplicateRate = list.length === 0 ? 0 : (list.length - trajectories.size) / list.length;

  return {
    records: list.length,
    train,
    holdout,
    bySchema,
    byCapability: [],
    byTool,
    byModel: [],
    byRealityClass,
    pCorrect: buildHistogram(pCorrectValues),
    epsilon: buildHistogram(epsilonValues),
    tokensEstimate: buildHistogram(tokensValues),
    stepCount: buildHistogram(stepCountValues),
    distinctObjectives: objectives.size,
    duplicateRate,
    oldestIssuedAt,
    newestIssuedAt,
    redactions,
  };
}

// ===========================================================================
// Formatters — plain ASCII, stable widths, no ANSI/HTML
// ===========================================================================

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(4);
}

export function formatAuditReport(r: DatasetAuditReport): string[] {
  const lines: string[] = [];
  lines.push(`Dataset audit: ${r.dir}`);
  lines.push(`  result:               ${r.ok ? "OK" : "FAILED"}`);
  lines.push(`  formatVersion:        ${r.formatVersion}`);
  lines.push(`  manifest digest:      ${r.manifestDigest || "<none>"}`);
  lines.push(`  recomputed digest:    ${r.recomputedDigest || "<none>"}`);
  lines.push(`  records:              ${r.records}`);
  lines.push(`  shards checked:       ${r.shardsChecked}`);
  lines.push(`  corpus cross-checked: ${r.corpusCrossChecked ? "yes" : "no"}`);
  if (r.corpusCrossChecked) {
    lines.push(`  certificates ok:      ${r.certificatesVerified}`);
    lines.push(`  certificates failed:  ${r.certificatesFailed}`);
  }
  if (r.durationMs !== undefined) lines.push(`  duration:             ${r.durationMs}ms`);
  lines.push("");

  const fatal = r.findings.filter((f) => f.severity === "fatal");
  const warn = r.findings.filter((f) => f.severity === "warn");

  const renderGroup = (label: string, items: AuditFinding[]): void => {
    lines.push(`${label} (${items.length}):`);
    if (items.length === 0) {
      lines.push("  (none)");
      lines.push("");
      return;
    }
    const codeWidth = Math.max(4, ...items.map((f) => f.code.length));
    const shardWidth = Math.max(5, ...items.map((f) => (f.shard ?? "").length));
    const recWidth = Math.max(6, ...items.map((f) => (f.recordId ?? "").length));
    for (const f of items) {
      lines.push(
        `  ${padRight(f.code, codeWidth)}  ${padRight(f.shard ?? "-", shardWidth)}  ${padRight(f.recordId ?? "-", recWidth)}  ${f.detail}`,
      );
    }
    lines.push("");
  };

  renderGroup("FATAL", fatal);
  renderGroup("WARN", warn);

  return lines;
}

export function formatStatsReport(s: DatasetStats): string[] {
  const lines: string[] = [];
  lines.push("Dataset statistics");
  lines.push(`  records:             ${s.records}`);
  lines.push(`  train / holdout:     ${s.train} / ${s.holdout}`);
  lines.push(`  distinct objectives: ${s.distinctObjectives}`);
  lines.push(`  duplicate rate:      ${(s.duplicateRate * 100).toFixed(2)}%`);
  lines.push(`  redactions:          ${s.redactions}`);
  lines.push(`  issuedAt range:      ${s.oldestIssuedAt ?? "n/a"} .. ${s.newestIssuedAt ?? "n/a"}`);
  lines.push("");

  lines.push("By schema:");
  const schemaKeys = Object.keys(s.bySchema).sort();
  if (schemaKeys.length === 0) lines.push("  (none)");
  for (const k of schemaKeys) lines.push(`  ${padRight(k, 24)} ${s.bySchema[k]}`);
  lines.push("");

  lines.push("By reality class:");
  for (const k of Object.keys(s.byRealityClass).sort()) {
    lines.push(`  ${padRight(k, 24)} ${s.byRealityClass[k as RealityClass]}`);
  }
  lines.push("");

  lines.push("By tool (structured schemas only):");
  if (s.byTool.length === 0) lines.push("  (none)");
  for (const { key, count } of s.byTool.slice(0, 20)) lines.push(`  ${padRight(key, 24)} ${count}`);
  lines.push("");

  const renderHistogram = (label: string, h: Histogram): void => {
    lines.push(`${label}:`);
    lines.push(
      `  min=${fmtNum(h.min)} max=${fmtNum(h.max)} mean=${fmtNum(h.mean)} p50=${fmtNum(h.p50)} p90=${fmtNum(h.p90)}`,
    );
    if (h.bins.length === 0) {
      lines.push("  (no data)");
    } else {
      const maxCount = Math.max(1, ...h.bins.map((b) => b.count));
      for (const b of h.bins) {
        const barWidth = Math.round((b.count / maxCount) * 30);
        lines.push(
          `  [${padLeft(fmtNum(b.lo), 10)}, ${padLeft(fmtNum(b.hi), 10)}] ${padLeft(String(b.count), 6)} ${"#".repeat(barWidth)}`,
        );
      }
    }
    lines.push("");
  };

  renderHistogram("pCorrect", s.pCorrect);
  renderHistogram("epsilon", s.epsilon);
  renderHistogram("tokensEstimate (ESTIMATE — heuristic char-count/4, not a real tokenizer)", s.tokensEstimate);
  renderHistogram("stepCount", s.stepCount);

  return lines;
}
