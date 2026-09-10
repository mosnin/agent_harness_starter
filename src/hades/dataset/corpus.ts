/**
 * corpus.ts — the durable, append-only, hash-chained, cross-process-safe
 * ledger that admits ONLY gate-verified trajectories: the flywheel's
 * foundation. This is the module where the phase checkpoint "an unverified
 * trajectory is provably excluded" lives.
 *
 * ## On-disk format (locked mechanics, mirrors `../eval/history.ts`)
 *
 * `<root>/corpus.jsonl` is line-oriented: line 1 is a small JSON header
 * (`{"version":1[,"checkpointHash":"<hex>"]}`), every line after that is one
 * {@link CorpusEntry} as JSON (via the NaN-safe `./../eval/json-line` codec).
 * Appending an admitted entry is an O(1) operation — a single
 * `writeFileSync(path, line, {flag:"a"})` that never reads or rewrites the
 * bytes already on disk — while every WHOLE-FILE rewrite this module ever
 * performs (initial header creation, legacy-file migration, `compact`,
 * recovery-in-place) goes through a tmp-file + `renameSync`, so a crash
 * mid-rewrite can only ever leave the untouched previous file or an orphaned
 * `.tmp-*` sibling next to it — never a half-written target. A header whose
 * `version` is greater than {@link DATASET_CORPUS_VERSION} is a FUTURE format
 * this build refuses to read (`CorpusVersionError`) rather than silently
 * misparse it; a garbage or structurally-invalid line before the final line
 * is mid-file corruption (`CorpusCorruptionError`); a truncated final line is
 * an ordinary crash tail and is dropped silently on read (recovered).
 *
 * ## Chain integrity (locked mechanics)
 *
 * Every entry's `hash` is `sha256Hex(prevHash + canonicalizeCorpusEntry(entry
 * minus hash))`, where {@link canonicalizeCorpusEntry} is a fixed-field-order
 * serialization of every field except `hash` itself — the embedded
 * `trajectory` is folded in via `canonicalTrajectoryJson` (the same function
 * `../skills/synthesize` uses to bind a certificate to a trajectory) and the
 * embedded `certificate`/`provenance` via this module's own generic stable
 * stringifier, so a mutation of the trajectory, the certificate, or the
 * provenance record is caught by the exact same recompute as a mutation of
 * `seq`/`prevHash`/etc. The first entry's `prevHash` is
 * {@link DATASET_CORPUS_GENESIS} — or, after {@link
 * VerifiedTrajectoryCorpus.compact}, the pruned prefix's terminal hash,
 * carried in the header's `checkpointHash` so the remaining chain stays
 * independently verifiable without the pruned bytes. `verifyChain()`
 * recomputes every hash and every `prevHash`/`seq` linkage from scratch — it
 * never trusts a stored value — so reordering, deleting, mutating, or forging
 * any single record is detectable and reported with a precise `brokenAt` seq.
 *
 * ## Cross-process safety (locked mechanics, identical protocol to
 * `../eval/history.ts`)
 *
 * `<root>/.lock` is the mutual-exclusion primitive: `mkdirSync` (never
 * recursive) either succeeds — this process now holds the lock — or throws
 * `EEXIST`, in which case a holder whose recorded pid is no longer alive is
 * reclaimed immediately; otherwise the caller backs off and retries until
 * `lockTimeoutMs` elapses, at which point {@link CorpusLockError} is thrown.
 * Every mutating operation (`admit`, `compact`, and the constructor's initial
 * header write) holds this lock for its entire file-touching critical
 * section, so two `VerifiedTrajectoryCorpus` instances over the same `root`
 * — even across real OS processes — always land contiguous `seq` values and a
 * chain `verifyChain()` accepts.
 *
 * ## The exclusion guarantee (this module's reason to exist)
 *
 * `admit()` NEVER trusts its caller or the certificate issuer. It (1) runs
 * the real `verifyTrajectoryForSynthesis` gate from `../skills/synthesize`
 * unchanged — signature validity, trace-hash binding, conformal-gate
 * consistency, task success, tool-event non-triviality, and
 * prompt-injection/frontmatter screening; then (2) INDEPENDENTLY recomputes
 * `sha256Hex(canonicalTrajectoryJson(trajectory))` and
 * `sha256Hex(canonicalize(certificate.payload))` from the raw trajectory and
 * certificate objects — never from anything the certificate or its issuer
 * merely claims — and cross-checks the certificate payload's own
 * `outputSha256`/`taskId` bindings; then (3) rejects a repeat
 * `trajectorySha256` as a duplicate without ever appending a row or moving
 * `head()`. There is no code path in this file that writes a `CorpusEntry`
 * whose `label` is anything other than the literal `"verified"`, and no code
 * path writes one at all unless every one of the above checks passed. A
 * rejected trajectory changes nothing observable: not `size()`, not
 * `head()`, not the byte length on disk, and it never appears in `entries()`.
 */

import { join } from "node:path";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
  statSync as nodeStatSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";

import type { GoalTrajectory, TaskTrajectory, ToolEvent } from "../research/recorder";
import {
  canonicalTrajectoryJson,
  verifyTrajectoryForSynthesis,
  type VerifiedTrajectory,
} from "../skills/synthesize";
import {
  canonicalize,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../styx/certificate";
import { encodeJsonLine, tryDecodeJsonLine } from "../eval/json-line";

// ===========================================================================
// Locked public constants + types
// ===========================================================================

export const DATASET_CORPUS_VERSION = 1;

/** `sha256Hex("hades.dataset.corpus.v1")` — the chain root for every corpus
 *  that has never been compacted (see {@link VerifiedTrajectoryCorpus.compact}
 *  for what replaces this once a prefix has been pruned). */
export const DATASET_CORPUS_GENESIS: string = sha256Hex("hades.dataset.corpus.v1");

export type RealityClass = "real" | "mock-tainted";

export interface CorpusProvenance {
  source: "run" | "bench" | "import";
  runId?: string;
  recordedAt: number;
  realityClass: RealityClass;
  mockMarkers: string[];
}

export interface CorpusEntry {
  seq: number;
  trajectorySha256: string;
  certSha256: string;
  label: "verified";
  trajectory: GoalTrajectory;
  certificate: VerificationCertificate;
  provenance: CorpusProvenance;
  admittedAt: number;
  prevHash: string;
  hash: string;
}

export type CorpusRejectionCode =
  | "unsigned"
  | "bad-signature"
  | "hash-mismatch"
  | "not-emitted"
  | "failed-trajectory"
  | "too-thin"
  | "suspicious-content"
  | "duplicate"
  | "malformed"
  | "cert-payload-mismatch";

export interface CorpusRejection {
  code: CorpusRejectionCode;
  detail: string;
}

export type CorpusAdmission = { ok: true; entry: CorpusEntry } | { ok: false; rejection: CorpusRejection };

export interface CorpusQuery {
  since?: number;
  until?: number;
  capability?: string;
  model?: string;
  realityClass?: RealityClass;
  minPCorrect?: number;
  maxEpsilon?: number;
  limit?: number;
}

export interface CorpusChainVerification {
  ok: boolean;
  entries: number;
  brokenAt: number | null;
  reason?: string;
}

export interface CorpusFsDeps {
  existsSync: typeof import("node:fs").existsSync;
  mkdirSync: typeof import("node:fs").mkdirSync;
  readFileSync: typeof import("node:fs").readFileSync;
  writeFileSync: typeof import("node:fs").writeFileSync;
  renameSync: typeof import("node:fs").renameSync;
  rmSync: typeof import("node:fs").rmSync;
  /** OPTIONAL, and only ever used as a cache-validity probe (see
   *  {@link VerifiedTrajectoryCorpus}'s "Parse cache" note). Omitting it from
   *  an injected dep set is fully supported and simply disables the cache, so
   *  every read re-parses the whole file exactly as it always did — which is
   *  what a fault-injection harness wants. The default (real `node:fs`) dep
   *  set always supplies it. */
  statSync?: typeof import("node:fs").statSync;
}

export interface CorpusOptions {
  root: string;
  fs?: CorpusFsDeps;
  now?: () => number;
  lockTimeoutMs?: number;
}

// ===========================================================================
// Errors
// ===========================================================================

export class CorpusLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusLockError";
  }
}

export class CorpusVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusVersionError";
  }
}

export class CorpusCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusCorruptionError";
  }
}

// ===========================================================================
// Small generic helpers
// ===========================================================================

const DEFAULT_LOCK_TIMEOUT_MS = 5000;

/** Real wall-clock sleep for the lock's backoff loop (never the injectable `now`). */
const SLEEP_SAB = new Int32Array(new SharedArrayBuffer(4));
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_SAB, 0, 0, ms);
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it —
    // still alive. Anything else (ESRCH, etc.) means it is gone.
    return isErrnoException(err) && err.code === "EPERM";
  }
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function tryParseJson(line: string): unknown {
  return tryDecodeJsonLine(line);
}

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * A generic deterministic JSON serialization used ONLY to fold the embedded
 * `certificate` and `provenance` objects into {@link canonicalizeCorpusEntry}:
 * object keys sorted lexicographically at every level, array order
 * preserved, `undefined` properties dropped. Deliberately independent of
 * `canonicalize()` in `../styx/certificate` (which only understands
 * `CertificatePayload`) so this module never has to coerce an embedded
 * `VerificationCertificate` or `CorpusProvenance` into that narrower shape.
 */
function stableStringifyGeneric(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    if (out === undefined) {
      throw new TypeError(`stableStringifyGeneric: unserializable value of type ${typeof value}`);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringifyGeneric(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringifyGeneric(obj[k])).join(",") + "}";
}

/**
 * The LOCKED canonical serialization of every {@link CorpusEntry} field
 * except `hash`, in a fixed field order. `trajectory` is folded in via
 * `canonicalTrajectoryJson` (the exact function a certificate's
 * `traceSha256` is bound to) rather than reimplemented here, so a mutated
 * trajectory and a mutated entry field are both caught by the same recompute.
 */
export function canonicalizeCorpusEntry(e: Omit<CorpusEntry, "hash">): string {
  const parts = [
    '"seq":' + JSON.stringify(e.seq),
    '"trajectorySha256":' + JSON.stringify(e.trajectorySha256),
    '"certSha256":' + JSON.stringify(e.certSha256),
    '"label":' + JSON.stringify(e.label),
    '"trajectory":' + canonicalTrajectoryJson(e.trajectory),
    '"certificate":' + stableStringifyGeneric(e.certificate),
    '"provenance":' + stableStringifyGeneric(e.provenance),
    '"admittedAt":' + JSON.stringify(e.admittedAt),
    '"prevHash":' + JSON.stringify(e.prevHash),
  ];
  return "{" + parts.join(",") + "}";
}

function computeEntryHash(e: Omit<CorpusEntry, "hash">): string {
  return sha256Hex(e.prevHash + canonicalizeCorpusEntry(e));
}

// ===========================================================================
// Mock-taint detection
// ===========================================================================

/** Case-insensitive match of the repo's honest `[mock]` label convention
 *  (see `../tools/fetch-extract.ts`, `../tools/web-search.ts`, `../tools/http.ts`,
 *  `../tools/image-gen.ts`, `../tools/tts.ts`, `../tools/vision.ts`,
 *  `../tools/verifiers.ts`). Markers are reported normalized to lowercase. */
const MOCK_MARKER_RE = /\[mock\]/gi;

// Bounds keep the scan TOTAL: a pathological `output` value (very deep
// nesting, or a very wide array/object) can never blow the call stack (the
// traversal is iterative, not recursive) and can never run unboundedly long
// or unboundedly memory-hungry (depth, total-node, per-node-fanout, and
// per-string-length caps all bail out early rather than exhaustively walk
// adversarial input). Detection past these bounds is simply not attempted —
// this function's contract is "find real markers", not "prove their total
// absence in an unbounded adversarial blob".
const MAX_SCAN_DEPTH = 24;
const MAX_SCAN_NODES = 4000;
const MAX_CHILDREN_PER_NODE = 500;
const MAX_STRING_SCAN_LEN = 20_000;

function scanStringForMockMarkers(s: unknown, found: Set<string>): void {
  if (typeof s !== "string" || s.length === 0) return;
  const slice = s.length > MAX_STRING_SCAN_LEN ? s.slice(0, MAX_STRING_SCAN_LEN) : s;
  const matches = slice.match(MOCK_MARKER_RE);
  if (matches) {
    for (const m of matches) found.add(m.toLowerCase());
  }
}

/** Iterative (never recursive) bounded-depth/size scan of an arbitrary tool
 *  `output` value — which may be a bare string, or the nested
 *  objects/arrays real tools like `fetch_extract`/`web_search` emit. */
function scanValueForMockMarkers(root: unknown, found: Set<string>): void {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= MAX_SCAN_NODES) return;
    const frame = stack.pop();
    if (frame === undefined) break;
    visited++;
    const { value, depth } = frame;
    if (typeof value === "string") {
      scanStringForMockMarkers(value, found);
      continue;
    }
    if (depth >= MAX_SCAN_DEPTH) continue;
    if (Array.isArray(value)) {
      const n = Math.min(value.length, MAX_CHILDREN_PER_NODE);
      for (let i = 0; i < n; i++) stack.push({ value: value[i], depth: depth + 1 });
      continue;
    }
    if (value !== null && typeof value === "object") {
      const keys = Object.keys(value as Record<string, unknown>).slice(0, MAX_CHILDREN_PER_NODE);
      for (const k of keys) stack.push({ value: (value as Record<string, unknown>)[k], depth: depth + 1 });
    }
  }
}

/**
 * Scan a {@link GoalTrajectory}'s `objective`/task `description`/tool
 * `summary`/tool `output` text for the repo's honest `[mock]` label
 * convention. Returns the distinct markers found (currently always `["[mock]"]`
 * when any is found — the array shape allows the convention to grow without
 * an API change); an empty array means nothing scanned looked mock-tainted.
 * Bounded-depth/size (see the `MAX_SCAN_*` constants above): safe to call on
 * a pathological trajectory without risking a stack overflow.
 */
export function detectMockMarkers(t: GoalTrajectory): string[] {
  const found = new Set<string>();
  if (t === null || typeof t !== "object") return [];

  scanStringForMockMarkers(t.objective, found);

  const tasks: TaskTrajectory[] = Array.isArray(t.tasks) ? t.tasks : [];
  for (const task of tasks) {
    if (task === null || typeof task !== "object") continue;
    scanStringForMockMarkers(task.description, found);
    const tools: ToolEvent[] = Array.isArray(task.tools) ? task.tools : [];
    for (const tool of tools) {
      if (tool === null || typeof tool !== "object") continue;
      scanStringForMockMarkers(tool.summary, found);
      scanValueForMockMarkers(tool.output, found);
    }
  }

  return [...found].sort();
}

// ===========================================================================
// Corpus-entry shape validation (for reading untrusted on-disk lines)
// ===========================================================================

const REALITY_CLASSES: ReadonlySet<string> = new Set(["real", "mock-tainted"]);
const PROVENANCE_SOURCES: ReadonlySet<string> = new Set(["run", "bench", "import"]);

function isValidTrajectoryShape(v: unknown): v is GoalTrajectory {
  if (!isPlainRecord(v)) return false;
  if (typeof v.goalId !== "string" || v.goalId.length === 0) return false;
  if (typeof v.objective !== "string") return false;
  if (!Array.isArray(v.tasks)) return false;
  if (typeof v.success !== "boolean") return false;
  if (typeof v.startedAt !== "number" || !Number.isFinite(v.startedAt)) return false;
  return true;
}

function isValidCertificateShape(v: unknown): v is VerificationCertificate {
  if (!isPlainRecord(v)) return false;
  if (!isPlainRecord(v.payload)) return false;
  if (typeof v.signature !== "string" || v.signature.length === 0) return false;
  if (typeof v.publicKey !== "string" || v.publicKey.length === 0) return false;
  return true;
}

function isValidProvenanceShape(v: unknown): v is CorpusProvenance {
  if (!isPlainRecord(v)) return false;
  if (typeof v.source !== "string" || !PROVENANCE_SOURCES.has(v.source)) return false;
  if (v.runId !== undefined && typeof v.runId !== "string") return false;
  if (typeof v.recordedAt !== "number" || !Number.isFinite(v.recordedAt)) return false;
  if (typeof v.realityClass !== "string" || !REALITY_CLASSES.has(v.realityClass)) return false;
  if (!Array.isArray(v.mockMarkers) || !v.mockMarkers.every((m) => typeof m === "string")) return false;
  return true;
}

function isValidEntryShape(v: unknown): v is CorpusEntry {
  if (!isPlainRecord(v)) return false;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) return false;
  if (typeof v.trajectorySha256 !== "string" || !HEX64_RE.test(v.trajectorySha256)) return false;
  if (typeof v.certSha256 !== "string" || !HEX64_RE.test(v.certSha256)) return false;
  if (v.label !== "verified") return false;
  if (!isValidTrajectoryShape(v.trajectory)) return false;
  if (!isValidCertificateShape(v.certificate)) return false;
  if (!isValidProvenanceShape(v.provenance)) return false;
  if (typeof v.admittedAt !== "number" || !Number.isFinite(v.admittedAt)) return false;
  if (typeof v.prevHash !== "string") return false;
  if (typeof v.hash !== "string") return false;
  return true;
}

/** A header line carries `version` and NEVER `seq` (every entry always
 *  carries `seq`) — that asymmetry tells a header line from an entry line
 *  without any extra on-disk tagging, mirroring `../eval/history.ts`. */
function isHeaderShape(v: unknown): v is { version: number; checkpointHash?: unknown } {
  if (!isPlainRecord(v)) return false;
  if ("seq" in v) return false;
  return typeof v.version === "number" && Number.isInteger(v.version) && v.version >= 0;
}

interface InternalHeader {
  version: number;
  checkpointHash: string | null;
}

/** The parsed view of the log file: what every read path works against. */
interface ParsedState {
  header: InternalHeader;
  entries: CorpusEntry[];
  hadHeaderLine: boolean;
}

// ===========================================================================
// VerifiedTrajectoryCorpus
// ===========================================================================

/**
 * ## Parse cache (why admitting N trajectories is linear, not quadratic)
 *
 * Every read path needs the parsed log. Re-reading and re-JSON-parsing the
 * entire file on every call makes `admit` O(file) — and since each entry
 * embeds a whole trajectory plus its certificate, admitting N trajectories
 * costs O(N^2) BYTES parsed. Measured on this repo before this cache existed:
 * 500 sequential admissions took 5.3s of which 5.2s was re-parsing, and the
 * cost of the 500th admission was ~4x the cost of the 100th — a corpus with
 * tens of thousands of verified trajectories (exactly what a working flywheel
 * produces) would have become unusable.
 *
 * So a parsed state is cached, and reused ONLY while the file's inode, size,
 * and mtime are all unchanged from the moment it was parsed. Any append (this
 * process's or another's), any `compact` rewrite, and any external edit moves
 * at least one of the three and forces a full re-parse. `admit` additionally
 * advances the cache in place with the entry it just appended — the one case
 * where the new state is known exactly without reading anything.
 *
 * Two deliberate limits keep this from weakening any guarantee:
 *   - `verifyChain()` always re-reads the bytes (`readState(true)`). Tamper
 *     detection is never answered from memory.
 *   - An injected {@link CorpusFsDeps} without a `statSync` disables the
 *     cache completely, restoring the original always-reparse behavior for
 *     fault-injection harnesses.
 *
 * The one thing a caller must not do is MUTATE an entry object handed back by
 * `entries()`/`get()`: those are the cached objects, not fresh copies. No
 * caller in this repo does, and the alternative (deep-cloning every
 * trajectory on every read) would cost more than the cache saves.
 */
export class VerifiedTrajectoryCorpus {
  private readonly root: string;
  private readonly nowFn: () => number;
  private readonly lockTimeoutMs: number;
  private readonly pid: number;
  private readonly fs: CorpusFsDeps;

  private readonly logPath: string;
  private readonly lockDir: string;

  /** The cache-validity probe — see the "Parse cache" section of this class's
   *  doc comment. `undefined` disables the cache entirely (every read
   *  re-parses the whole file), which is exactly what an injected
   *  {@link CorpusFsDeps} without a `statSync` gets. */
  private readonly statSync: CorpusFsDeps["statSync"];
  private stateCache?: { state: ParsedState; size: number; mtimeMs: number; ino: number };

  constructor(opts: CorpusOptions) {
    if (!opts || typeof opts.root !== "string" || opts.root.length === 0) {
      throw new RangeError("CorpusOptions.root must be a non-empty path");
    }
    if (opts.lockTimeoutMs !== undefined && (!Number.isFinite(opts.lockTimeoutMs) || opts.lockTimeoutMs < 0)) {
      throw new RangeError("CorpusOptions.lockTimeoutMs must be a non-negative number");
    }

    this.root = opts.root;
    this.nowFn = opts.now ?? Date.now;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.pid = process.pid;
    this.fs = {
      existsSync: opts.fs?.existsSync ?? nodeExistsSync,
      mkdirSync: opts.fs?.mkdirSync ?? nodeMkdirSync,
      readFileSync: opts.fs?.readFileSync ?? nodeReadFileSync,
      writeFileSync: opts.fs?.writeFileSync ?? nodeWriteFileSync,
      renameSync: opts.fs?.renameSync ?? nodeRenameSync,
      rmSync: opts.fs?.rmSync ?? nodeRmSync,
    };
    // The cache is enabled ONLY when this instance is talking to a filesystem
    // it can also cheaply stat. An injected dep set that does not supply
    // `statSync` (every fault-injection harness in the tests) keeps the
    // original always-reparse behavior byte for byte.
    this.statSync = opts.fs === undefined ? nodeStatSync : opts.fs.statSync;

    this.logPath = join(this.root, "corpus.jsonl");
    this.lockDir = join(this.root, ".lock");

    this.fs.mkdirSync(this.root, { recursive: true });

    const release = this.acquireLock();
    try {
      if (!this.fs.existsSync(this.logPath)) {
        this.atomicRewrite({ version: DATASET_CORPUS_VERSION, checkpointHash: null }, []);
      }
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // Locking (identical protocol to ../eval/history.ts)
  // -------------------------------------------------------------------------

  private acquireLock(): () => void {
    const startedAt = Date.now();
    let attempt = 0;
    for (;;) {
      try {
        this.fs.mkdirSync(this.lockDir);
        try {
          this.fs.writeFileSync(
            join(this.lockDir, "holder.json"),
            JSON.stringify({ pid: this.pid, acquiredAt: Date.now() }),
            "utf8",
          );
        } catch {
          // Best-effort diagnostics only; the mkdirSync above already
          // established exclusivity.
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            this.fs.rmSync(this.lockDir, { recursive: true, force: true });
          } catch {
            /* already gone */
          }
        };
      } catch (err) {
        if (!isErrnoException(err) || err.code !== "EEXIST") throw err;
        if (this.tryReclaimStaleLock()) continue; // reclaimed — retry mkdir immediately
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new CorpusLockError(
            `timed out acquiring corpus lock at "${this.lockDir}" after ${this.lockTimeoutMs}ms`,
          );
        }
        const backoffMs = Math.min(100, 4 * 2 ** attempt) + Math.floor(Math.random() * 8);
        attempt++;
        sleepSyncMs(backoffMs);
      }
    }
  }

  /** Reclaims (removes) a held lock ONLY when its recorded pid is no longer
   *  alive. A lock whose holder cannot be identified (missing/garbage
   *  `holder.json`) is never auto-reclaimed by liveness — it can only be
   *  taken by timing out via `lockTimeoutMs`. */
  private tryReclaimStaleLock(): boolean {
    let pid: number | undefined;
    try {
      const raw = this.fs.readFileSync(join(this.lockDir, "holder.json"), "utf8") as string;
      const parsed: unknown = JSON.parse(raw);
      if (isPlainRecord(parsed) && typeof parsed.pid === "number") pid = parsed.pid;
    } catch {
      // Missing or garbage holder file — cannot attribute the lock.
    }
    if (pid === undefined || isPidAlive(pid)) return false;

    try {
      this.fs.rmSync(this.lockDir, { recursive: true, force: true });
    } catch {
      /* raced with the real holder releasing it, or another reclaimer — fine either way */
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Atomic whole-file rewrite vs. O(1) line append
  // -------------------------------------------------------------------------

  private atomicRewrite(header: InternalHeader, entries: readonly CorpusEntry[]): void {
    const headerObj: { version: number; checkpointHash?: string } = { version: DATASET_CORPUS_VERSION };
    if (header.checkpointHash !== null) headerObj.checkpointHash = header.checkpointHash;
    const lines = [encodeJsonLine(headerObj), ...entries.map((e) => encodeJsonLine(e))];
    const body = lines.join("\n") + "\n";

    const tmp = `${this.logPath}.tmp-${this.pid}-${Math.random().toString(36).slice(2, 10)}`;
    this.fs.writeFileSync(tmp, body, "utf8");
    this.fs.renameSync(tmp, this.logPath);
    // A rewrite replaces the file (new inode); nothing parsed before it is
    // still a description of what is on disk.
    this.stateCache = undefined;
  }

  /**
   * O(1) append. `state` is the parsed view this append was computed
   * against (always freshly obtained under the lock by the sole caller,
   * `admit`): when it is still the cached state, the cache is advanced in
   * place — the appended entry is pushed and the cache is re-bound to the
   * file's new identity — so a subsequent `admit` in this process does not
   * have to re-read and re-parse the whole log. That is what keeps admitting
   * N trajectories linear instead of quadratic. If anything is off (no
   * cache, a different state object, an unanswerable stat), the cache is
   * dropped and the next read re-parses from disk.
   */
  private appendEntryLine(e: CorpusEntry, state: ParsedState): void {
    this.fs.writeFileSync(this.logPath, encodeJsonLine(e) + "\n", { encoding: "utf8", flag: "a" });
    if (this.stateCache !== undefined && this.stateCache.state === state) {
      state.entries.push(e);
      this.rememberState(state);
    } else {
      this.stateCache = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Reading + parsing
  // -------------------------------------------------------------------------

  /** Cheap file-identity probe used only to decide whether {@link
   *  stateCache} is still valid. `undefined` means "cannot tell" (no
   *  `statSync` dep, or the file is gone), which always forces a full
   *  re-parse — the cache never survives an unanswerable question. */
  private probeFile(): { size: number; mtimeMs: number; ino: number } | undefined {
    const stat = this.statSync;
    if (stat === undefined) return undefined;
    try {
      const s = stat(this.logPath);
      return { size: s.size, mtimeMs: s.mtimeMs, ino: Number(s.ino) };
    } catch {
      return undefined;
    }
  }

  /**
   * Parsed view of the log. Served from {@link stateCache} only when the file
   * on disk is byte-for-byte the same file this instance last parsed — same
   * inode, same size, same mtime. ANY change (this process appending, another
   * process appending, a `compact` rewrite, an external edit) moves at least
   * one of those three and forces a full re-parse.
   *
   * `force: true` bypasses the cache entirely and always re-reads the bytes;
   * {@link verifyChain} uses it so that tamper detection is never served from
   * memory.
   */
  private readState(force = false): ParsedState {
    if (!force) {
      const cached = this.stateCache;
      if (cached !== undefined) {
        const probe = this.probeFile();
        if (probe !== undefined && probe.size === cached.size && probe.mtimeMs === cached.mtimeMs && probe.ino === cached.ino) {
          return cached.state;
        }
      }
    }
    const state = this.parseStateFromDisk();
    this.rememberState(state);
    return state;
  }

  /** Binds `state` to the file's CURRENT identity, or drops the cache when
   *  that identity cannot be established. */
  private rememberState(state: ParsedState): void {
    const probe = this.probeFile();
    this.stateCache = probe !== undefined ? { state, ...probe } : undefined;
  }

  private parseStateFromDisk(): ParsedState {
    const empty = (): ParsedState => ({
      header: { version: DATASET_CORPUS_VERSION, checkpointHash: null },
      entries: [],
      hadHeaderLine: false,
    });

    if (!this.fs.existsSync(this.logPath)) return empty();

    const raw = this.fs.readFileSync(this.logPath, "utf8") as string;
    const lines = raw.length === 0 ? [] : raw.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) return empty();

    let header: InternalHeader;
    let entryLines: string[];
    let hadHeaderLine = false;

    const first = tryParseJson(lines[0]);
    if (first !== undefined && isHeaderShape(first)) {
      if (first.version > DATASET_CORPUS_VERSION) {
        throw new CorpusVersionError(
          `corpus file at "${this.logPath}" is version ${first.version}, which this build (understands up to version ${DATASET_CORPUS_VERSION}) refuses to read rather than silently misparse`,
        );
      }
      header = {
        version: DATASET_CORPUS_VERSION,
        checkpointHash: typeof first.checkpointHash === "string" ? first.checkpointHash : null,
      };
      entryLines = lines.slice(1);
      hadHeaderLine = true;
    } else {
      // Legacy/foreign file: content with no header line at all.
      header = { version: DATASET_CORPUS_VERSION, checkpointHash: null };
      entryLines = lines;
    }

    const entries: CorpusEntry[] = [];
    for (let i = 0; i < entryLines.length; i++) {
      const isLast = i === entryLines.length - 1;
      const parsed = tryParseJson(entryLines[i]);
      if (parsed === undefined || !isValidEntryShape(parsed)) {
        if (isLast) break; // partially-written / truncated final record: drop silently, recover the rest
        const lineNo = hadHeaderLine ? i + 2 : i + 1;
        throw new CorpusCorruptionError(
          `corpus file at "${this.logPath}" has an unparsable or malformed record at line ${lineNo}, before the final line — this is not a recoverable crash-tail, it is mid-file corruption`,
        );
      }
      entries.push(parsed);
    }

    return { header, entries, hadHeaderLine };
  }

  // -------------------------------------------------------------------------
  // admit() — the exclusion guarantee
  // -------------------------------------------------------------------------

  async admit(
    vt: VerifiedTrajectory,
    p?: { source?: CorpusProvenance["source"]; runId?: string; recordedAt?: number },
  ): Promise<CorpusAdmission> {
    // (1) Run the REAL synthesis gate, unchanged. This alone already checks:
    // unsigned / bad-signature / hash-mismatch / not-emitted /
    // failed-trajectory / too-thin / suspicious-content.
    let verdict: { ok: true } | { ok: false; rejection: { code: CorpusRejectionCode; detail: string } };
    try {
      verdict = await verifyTrajectoryForSynthesis(vt);
    } catch (err) {
      return { ok: false, rejection: { code: "malformed", detail: `verifyTrajectoryForSynthesis threw: ${String(err)}` } };
    }
    if (!verdict.ok) {
      return { ok: false, rejection: verdict.rejection };
    }

    const { trajectory, certificate } = vt;

    // (2) INDEPENDENTLY recompute both hashes from the raw objects — never
    // trust that verifyTrajectoryForSynthesis's boolean was computed the way
    // we assume, and never trust anything the certificate merely claims.
    let trajectorySha256: string;
    let certSha256: string;
    try {
      trajectorySha256 = sha256Hex(canonicalTrajectoryJson(trajectory));
      certSha256 = sha256Hex(canonicalize(certificate.payload));
    } catch (err) {
      return {
        ok: false,
        rejection: {
          code: "malformed",
          detail: `independent re-verification could not canonicalize the trajectory or certificate payload: ${String(err)}`,
        },
      };
    }

    const claimedTraceSha256 =
      typeof certificate.payload.traceSha256 === "string" ? certificate.payload.traceSha256.toLowerCase() : "";
    if (trajectorySha256 !== claimedTraceSha256) {
      return {
        ok: false,
        rejection: {
          code: "hash-mismatch",
          detail: `independently recomputed trajectory hash (${trajectorySha256}) does not equal certificate payload traceSha256 (${claimedTraceSha256 || "<missing>"}).`,
        },
      };
    }

    const outputSha256Rejection = validateCertPayloadBinding(certificate.payload, trajectory);
    if (outputSha256Rejection !== null) {
      return { ok: false, rejection: outputSha256Rejection };
    }

    // (3) Everything from here touches shared on-disk state — hold the lock
    // for the whole critical section so two processes never assign the same
    // seq or race the duplicate check.
    const release = this.acquireLock();
    try {
      let state = this.readState();
      if (!state.hadHeaderLine) {
        this.atomicRewrite(state.header, state.entries);
        state = this.readState();
      }

      const duplicate = state.entries.find((e) => e.trajectorySha256 === trajectorySha256);
      if (duplicate !== undefined) {
        return {
          ok: false,
          rejection: {
            code: "duplicate",
            detail: `trajectory ${trajectorySha256} was already admitted at seq ${duplicate.seq}.`,
          },
        };
      }

      const prevHash =
        state.entries.length > 0
          ? state.entries[state.entries.length - 1].hash
          : (state.header.checkpointHash ?? DATASET_CORPUS_GENESIS);
      const seq = state.entries.length > 0 ? state.entries[state.entries.length - 1].seq + 1 : 0;

      const mockMarkers = detectMockMarkers(trajectory);
      const realityClass: RealityClass = mockMarkers.length > 0 ? "mock-tainted" : "real";
      const admittedAt = this.nowFn();
      const provenance: CorpusProvenance = {
        source: p?.source ?? "run",
        runId: p?.runId,
        recordedAt: p?.recordedAt ?? admittedAt,
        realityClass,
        mockMarkers,
      };

      const fields: Omit<CorpusEntry, "hash"> = {
        seq,
        trajectorySha256,
        certSha256,
        label: "verified",
        trajectory,
        certificate,
        provenance,
        admittedAt,
        prevHash,
      };
      const hash = computeEntryHash(fields);
      const entry: CorpusEntry = { ...fields, hash };

      this.appendEntryLine(entry, state);
      return { ok: true, entry };
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // Read-only queries
  // -------------------------------------------------------------------------

  entries(q: CorpusQuery = {}): CorpusEntry[] {
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 0)) {
      throw new RangeError("CorpusQuery.limit must be a non-negative integer");
    }
    const state = this.readState();
    const filtered = state.entries.filter((e) => this.matches(e, q));
    if (q.limit !== undefined && q.limit < filtered.length) {
      return filtered.slice(filtered.length - q.limit);
    }
    return filtered;
  }

  private matches(e: CorpusEntry, q: CorpusQuery): boolean {
    // Boundary-inclusive on both ends: since <= admittedAt <= until.
    if (q.since !== undefined && e.admittedAt < q.since) return false;
    if (q.until !== undefined && e.admittedAt > q.until) return false;
    if (q.capability !== undefined && !e.trajectory.tasks.some((t) => t.capability === q.capability)) return false;
    if (q.model !== undefined && e.trajectory.model !== q.model) return false;
    if (q.realityClass !== undefined && e.provenance.realityClass !== q.realityClass) return false;
    // Boundary-inclusive: minPCorrect <= pCorrect, epsilon <= maxEpsilon.
    if (q.minPCorrect !== undefined && e.certificate.payload.pCorrect < q.minPCorrect) return false;
    if (q.maxEpsilon !== undefined && e.certificate.payload.epsilon > q.maxEpsilon) return false;
    return true;
  }

  get(trajectorySha256: string): CorpusEntry | undefined {
    const state = this.readState();
    return state.entries.find((e) => e.trajectorySha256 === trajectorySha256);
  }

  size(): number {
    return this.readState().entries.length;
  }

  head(): string {
    const state = this.readState();
    return state.entries.length > 0
      ? state.entries[state.entries.length - 1].hash
      : (state.header.checkpointHash ?? DATASET_CORPUS_GENESIS);
  }

  verifyChain(): CorpusChainVerification {
    // Always from the BYTES, never from the in-memory parse cache: this is
    // the tamper-detection path, and it must answer "what is on disk right
    // now", not "what did this process last parse".
    const state = this.readState(true);
    let expectedPrev = state.header.checkpointHash ?? DATASET_CORPUS_GENESIS;
    let expectedSeq: number | null = null;

    for (let i = 0; i < state.entries.length; i++) {
      const e = state.entries[i];
      if (expectedSeq !== null && e.seq !== expectedSeq + 1) {
        return { ok: false, entries: i, brokenAt: e.seq, reason: "seq-gap" };
      }
      expectedSeq = e.seq;

      if (e.prevHash !== expectedPrev) {
        return { ok: false, entries: i, brokenAt: e.seq, reason: "prev-hash-mismatch" };
      }

      const { hash, ...rest } = e;
      if (computeEntryHash(rest) !== hash) {
        return { ok: false, entries: i, brokenAt: e.seq, reason: "hash-mismatch" };
      }
      expectedPrev = hash;
    }

    return { ok: true, entries: state.entries.length, brokenAt: null };
  }

  // -------------------------------------------------------------------------
  // compact() — prune the prefix, keep the suffix independently verifiable
  // -------------------------------------------------------------------------

  compact(keepFromSeq: number): { pruned: number; checkpointHash: string } {
    if (!Number.isInteger(keepFromSeq) || keepFromSeq < 0) {
      throw new RangeError("compact(keepFromSeq) requires a non-negative integer");
    }
    const release = this.acquireLock();
    try {
      const state = this.readState();
      const cutIndex = state.entries.findIndex((e) => e.seq >= keepFromSeq);
      const idx = cutIndex === -1 ? state.entries.length : cutIndex;
      const pruned = state.entries.slice(0, idx);
      const retained = state.entries.slice(idx);

      if (pruned.length === 0) {
        return { pruned: 0, checkpointHash: state.header.checkpointHash ?? DATASET_CORPUS_GENESIS };
      }

      const checkpointHash = pruned[pruned.length - 1].hash;
      this.atomicRewrite({ version: DATASET_CORPUS_VERSION, checkpointHash }, retained);
      return { pruned: pruned.length, checkpointHash };
    } finally {
      release();
    }
  }
}

// ===========================================================================
// admit() helper: certificate-payload <-> trajectory binding cross-check
// ===========================================================================

function validateCertPayloadBinding(
  payload: CertificatePayload,
  trajectory: GoalTrajectory,
): { code: CorpusRejectionCode; detail: string } | null {
  const outputSha256 = payload.outputSha256;
  if (typeof outputSha256 !== "string" || !HEX64_RE.test(outputSha256.toLowerCase())) {
    return {
      code: "cert-payload-mismatch",
      detail: `certificate payload outputSha256 is missing or is not a well-formed sha256 hex string: ${JSON.stringify(outputSha256)}.`,
    };
  }

  const taskId = payload.taskId;
  if (typeof taskId !== "string" || taskId.trim() === "") {
    return {
      code: "cert-payload-mismatch",
      detail: "certificate payload taskId is missing or empty.",
    };
  }

  const tasks = Array.isArray(trajectory.tasks) ? trajectory.tasks : [];
  if (!tasks.some((t) => t.taskId === taskId)) {
    return {
      code: "cert-payload-mismatch",
      detail: `certificate payload taskId (${JSON.stringify(taskId)}) does not correspond to any task in the trajectory.`,
    };
  }

  return null;
}
