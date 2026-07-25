/**
 * history.ts — a durable, append-only, hash-chained, cross-process-safe
 * ledger of {@link EvalScorecard}s, each keyed to the real source revision
 * (`scorecard.revision.sha`/`.branch`, populated by `./revision`'s
 * `resolveRevision`) that produced it.
 *
 * ## On-disk format (locked mechanics)
 *
 * `<root>/history.jsonl` is line-oriented: line 1 is a small JSON header
 * (`{"version":1[,"checkpointHash":"<hex>"]}`), every line after that is one
 * `EvalHistoryEntry` as JSON. Appending a new entry is therefore an O(1)
 * write — a single `writeFileSync(path, line, {flag:"a"})` call that never
 * reads or rewrites the entries already on disk — while every WHOLE-FILE
 * rewrite this module ever performs (initial header creation, legacy-file
 * migration, `compact`, recovery-in-place) goes through a tmp-file +
 * `renameSync` so a crash mid-rewrite can only ever leave the untouched
 * previous file or an orphaned `.tmp` sibling, never a half-written target.
 *
 * A file with content but no header line at all is a LEGACY file (implicit
 * version 0): it migrates transparently on the next `append()` (rewritten
 * once, with a proper header, before the new line lands). A header whose
 * `version` is greater than {@link EVAL_HISTORY_VERSION} is a FUTURE format
 * this build does not understand — reading it raises
 * {@link HistoryVersionError} rather than silently misparsing it.
 *
 * ## Chain integrity (locked mechanics)
 *
 * Every entry's `hash` is `sha256Hex(prevHash + canonical(entry))`, where
 * `canonical(entry)` is a fixed-field-order serialization of every field
 * except `hash` itself (the embedded `scorecard` is represented by its own
 * `canonicalizeScorecard` output, so a scorecard mutation and an entry
 * mutation are both caught by the same recompute). The first entry's
 * `prevHash` is {@link EVAL_HISTORY_GENESIS} — or, after {@link
 * EvalHistoryLedger.compact}, the pruned prefix's terminal hash, carried in
 * the header's `checkpointHash` so the remaining chain stays independently
 * verifiable without the pruned bytes. `verifyChain()` recomputes every
 * hash and every `prevHash`/`seq` linkage from scratch — it never trusts a
 * stored value — so reordering, deleting, mutating, or forging any single
 * record is detectable.
 *
 * ## Cross-process safety (locked mechanics)
 *
 * `<root>/.lock` is the mutual-exclusion primitive: `mkdirSync` (never
 * recursive) either succeeds — this process now holds the lock — or throws
 * `EEXIST`, in which case a holder whose recorded pid is no longer alive is
 * reclaimed immediately; otherwise the caller backs off and retries until
 * `lockTimeoutMs` elapses, at which point {@link HistoryLockError} is
 * thrown. Every mutating operation (`append`, `compact`, and the
 * constructor's initial header write) holds this lock for its entire
 * critical section, so two `EvalHistoryLedger` instances over the same
 * `root` — even across real OS processes — always land contiguous `seq`
 * values and a chain that `verifyChain()` accepts.
 *
 * `append()` refuses (throws {@link HistoryScorecardError}, writes nothing)
 * any scorecard that fails the real `verifyScorecard` from `./scorecard` —
 * this ledger never records a self-inconsistent measurement as if it were
 * trustworthy.
 */

import { join } from "node:path";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";

import { sha256Hex } from "../styx/certificate";
import {
  verifyScorecard,
  canonicalizeScorecard,
  type EvalScorecard,
  type EvalMode,
  type ScorecardRevision,
} from "./scorecard";

// ===========================================================================
// Locked public constants + types
// ===========================================================================

export const EVAL_HISTORY_VERSION = 1;

/** `sha256Hex("hades.eval.history.v1")` — the chain root for every ledger
 *  that has never been compacted (see {@link EvalHistoryLedger.compact} for
 *  what replaces this once a prefix has been pruned). */
export const EVAL_HISTORY_GENESIS: string = sha256Hex("hades.eval.history.v1");

export interface EvalHistoryEntry {
  seq: number;
  recordedAtMs: number;
  branch: string | null;
  sha: string;
  mode: EvalMode;
  suiteHash: string;
  scorecard: EvalScorecard;
  note: string | null;
  prevHash: string;
  hash: string;
}

export interface HistoryQuery {
  branch?: string;
  sha?: string;
  mode?: EvalMode;
  sinceMs?: number;
  untilMs?: number;
  suiteHash?: string;
  limit?: number;
}

export interface HistoryChainVerification {
  ok: boolean;
  entries: number;
  brokenAtSeq: number | null;
  reason: string | null;
}

export interface HistoryFsDeps {
  readFileSync: typeof import("node:fs").readFileSync;
  writeFileSync: typeof import("node:fs").writeFileSync;
  renameSync: typeof import("node:fs").renameSync;
  mkdirSync: typeof import("node:fs").mkdirSync;
  existsSync: typeof import("node:fs").existsSync;
  rmSync: typeof import("node:fs").rmSync;
}

export interface EvalHistoryOptions {
  root: string;
  retain?: number;
  fs?: Partial<HistoryFsDeps>;
  now?: () => number;
  lockTimeoutMs?: number;
  pid?: number;
}

// ===========================================================================
// Errors
// ===========================================================================

export class HistoryLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryLockError";
  }
}

export class HistoryVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryVersionError";
  }
}

export class HistoryCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryCorruptionError";
  }
}

export class HistoryScorecardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryScorecardError";
  }
}

// ===========================================================================
// Internal helpers
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
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

interface InternalHeader {
  version: number;
  checkpointHash: string | null;
}

/** A header line carries `version` and NEVER `seq` (every entry always
 *  carries `seq`) — that asymmetry is the discriminator used to tell a
 *  header line from an entry line without any extra on-disk tagging. */
function isHeaderShape(v: unknown): v is { version: number; checkpointHash?: unknown } {
  if (!isPlainRecord(v)) return false;
  if ("seq" in v) return false;
  return typeof v.version === "number" && Number.isInteger(v.version) && v.version >= 0;
}

const EVAL_MODES: ReadonlySet<string> = new Set(["scripted", "keyed-live"]);

function isValidEntryShape(v: unknown): v is EvalHistoryEntry {
  if (!isPlainRecord(v)) return false;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) return false;
  if (typeof v.recordedAtMs !== "number" || !Number.isFinite(v.recordedAtMs)) return false;
  if (v.branch !== null && typeof v.branch !== "string") return false;
  if (typeof v.sha !== "string" || v.sha.length === 0) return false;
  if (typeof v.mode !== "string" || !EVAL_MODES.has(v.mode)) return false;
  if (typeof v.suiteHash !== "string") return false;
  if (v.note !== null && typeof v.note !== "string") return false;
  if (typeof v.prevHash !== "string") return false;
  if (typeof v.hash !== "string") return false;
  if (!isPlainRecord(v.scorecard)) return false;
  const sc = v.scorecard as Record<string, unknown>;
  if (typeof sc.contentHash !== "string" || sc.contentHash.length === 0) return false;
  if (typeof sc.scorecardId !== "string") return false;
  if (typeof sc.version !== "number") return false;
  if (!Array.isArray(sc.outcomes)) return false;
  return true;
}

type EntryFields = Omit<EvalHistoryEntry, "hash">;

/**
 * The LOCKED canonical serialization of every {@link EvalHistoryEntry}
 * field except `hash`, in a fixed field order — mirroring the discipline
 * `../schedule/receipt-ledger.ts` and `../routing/ledger.ts` already use for
 * their own hash chains. `scorecard` is folded in via `canonicalizeScorecard`
 * (its own tamper-evident canonical form) rather than re-implemented here,
 * so a mutated scorecard field and a mutated entry field are both caught by
 * the exact same recompute.
 */
function canonicalizeEntryFields(e: EntryFields): string {
  const parts = [
    '"seq":' + JSON.stringify(e.seq),
    '"recordedAtMs":' + JSON.stringify(e.recordedAtMs),
    '"branch":' + JSON.stringify(e.branch),
    '"sha":' + JSON.stringify(e.sha),
    '"mode":' + JSON.stringify(e.mode),
    '"suiteHash":' + JSON.stringify(e.suiteHash),
    '"note":' + JSON.stringify(e.note),
    '"prevHash":' + JSON.stringify(e.prevHash),
    '"scorecard":' + JSON.stringify(canonicalizeScorecard(e.scorecard)),
  ];
  return "{" + parts.join(",") + "}";
}

function computeEntryHash(e: EntryFields): string {
  return sha256Hex(e.prevHash + canonicalizeEntryFields(e));
}

// ===========================================================================
// EvalHistoryLedger
// ===========================================================================

export class EvalHistoryLedger {
  private readonly root: string;
  private readonly retain: number | undefined;
  private readonly nowFn: () => number;
  private readonly lockTimeoutMs: number;
  private readonly pid: number;
  private readonly fs: HistoryFsDeps;

  private readonly logPath: string;
  private readonly lockDir: string;

  constructor(opts: EvalHistoryOptions) {
    if (!opts || typeof opts.root !== "string" || opts.root.length === 0) {
      throw new RangeError("EvalHistoryOptions.root must be a non-empty path");
    }
    if (opts.retain !== undefined && (!Number.isInteger(opts.retain) || opts.retain < 0)) {
      throw new RangeError("EvalHistoryOptions.retain must be a non-negative integer");
    }
    if (opts.lockTimeoutMs !== undefined && (!Number.isFinite(opts.lockTimeoutMs) || opts.lockTimeoutMs < 0)) {
      throw new RangeError("EvalHistoryOptions.lockTimeoutMs must be a non-negative number");
    }

    this.root = opts.root;
    this.retain = opts.retain;
    this.nowFn = opts.now ?? Date.now;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.pid = opts.pid ?? process.pid;
    this.fs = {
      readFileSync: opts.fs?.readFileSync ?? nodeReadFileSync,
      writeFileSync: opts.fs?.writeFileSync ?? nodeWriteFileSync,
      renameSync: opts.fs?.renameSync ?? nodeRenameSync,
      mkdirSync: opts.fs?.mkdirSync ?? nodeMkdirSync,
      existsSync: opts.fs?.existsSync ?? nodeExistsSync,
      rmSync: opts.fs?.rmSync ?? nodeRmSync,
    };

    this.logPath = join(this.root, "history.jsonl");
    this.lockDir = join(this.root, ".lock");

    this.fs.mkdirSync(this.root, { recursive: true });

    const release = this.acquireLock();
    try {
      if (!this.fs.existsSync(this.logPath)) {
        this.atomicRewrite({ version: EVAL_HISTORY_VERSION, checkpointHash: null }, []);
      }
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // Locking
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
          throw new HistoryLockError(
            `timed out acquiring history lock at "${this.lockDir}" after ${this.lockTimeoutMs}ms`,
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
   *  taken by timing out via `lockTimeoutMs`, so a merely-fresh hostile
   *  lock directory can never be silently stolen. */
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
  // Atomic whole-file rewrite (header creation, migration, compaction,
  // recovery) — vs. `appendEntryLine`'s O(1) line append for the hot path.
  // -------------------------------------------------------------------------

  private atomicRewrite(header: InternalHeader, entries: readonly EvalHistoryEntry[]): void {
    const headerObj: { version: number; checkpointHash?: string } = { version: EVAL_HISTORY_VERSION };
    if (header.checkpointHash !== null) headerObj.checkpointHash = header.checkpointHash;
    const lines = [JSON.stringify(headerObj), ...entries.map((e) => JSON.stringify(e))];
    const body = lines.join("\n") + "\n";

    const tmp = `${this.logPath}.tmp-${this.pid}-${Math.random().toString(36).slice(2, 10)}`;
    this.fs.writeFileSync(tmp, body, "utf8");
    this.fs.renameSync(tmp, this.logPath);
  }

  private appendEntryLine(e: EvalHistoryEntry): void {
    this.fs.writeFileSync(this.logPath, JSON.stringify(e) + "\n", { encoding: "utf8", flag: "a" });
  }

  // -------------------------------------------------------------------------
  // Reading + parsing (never throws on a merely-shorter file; throws
  // HistoryVersionError on a future format, HistoryCorruptionError on
  // non-tail corruption)
  // -------------------------------------------------------------------------

  private readState(): { header: InternalHeader; entries: EvalHistoryEntry[]; raw: string; hadHeaderLine: boolean } {
    const empty = (raw: string): { header: InternalHeader; entries: EvalHistoryEntry[]; raw: string; hadHeaderLine: boolean } => ({
      header: { version: EVAL_HISTORY_VERSION, checkpointHash: null },
      entries: [],
      raw,
      hadHeaderLine: false,
    });

    if (!this.fs.existsSync(this.logPath)) return empty("");

    const raw = this.fs.readFileSync(this.logPath, "utf8") as string;
    const lines = raw.length === 0 ? [] : raw.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) return empty(raw);

    let header: InternalHeader;
    let entryLines: string[];
    let hadHeaderLine = false;

    const first = tryParseJson(lines[0]);
    if (first !== undefined && isHeaderShape(first)) {
      if (first.version > EVAL_HISTORY_VERSION) {
        throw new HistoryVersionError(
          `history file at "${this.logPath}" is version ${first.version}, which this build (understands up to version ${EVAL_HISTORY_VERSION}) refuses to read rather than silently misparse`,
        );
      }
      header = {
        version: EVAL_HISTORY_VERSION,
        checkpointHash: typeof first.checkpointHash === "string" ? first.checkpointHash : null,
      };
      entryLines = lines.slice(1);
      hadHeaderLine = true;
    } else {
      // Legacy file: content with no header line at all (implicit version 0).
      header = { version: EVAL_HISTORY_VERSION, checkpointHash: null };
      entryLines = lines;
    }

    const entries: EvalHistoryEntry[] = [];
    for (let i = 0; i < entryLines.length; i++) {
      const isLast = i === entryLines.length - 1;
      const parsed = tryParseJson(entryLines[i]);
      if (parsed === undefined || !isValidEntryShape(parsed)) {
        if (isLast) break; // partially-written / truncated final record: drop silently, recover the rest
        const lineNo = hadHeaderLine ? i + 2 : i + 1;
        throw new HistoryCorruptionError(
          `history file at "${this.logPath}" has an unparsable or malformed record at line ${lineNo}, before the final line — this is not a recoverable crash-tail, it is mid-file corruption`,
        );
      }
      entries.push(parsed);
    }

    return { header, entries, raw, hadHeaderLine };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  append(scorecard: EvalScorecard, meta?: { note?: string; branch?: string | null }): EvalHistoryEntry {
    const verification = verifyScorecard(scorecard);
    if (!verification.ok) {
      throw new HistoryScorecardError(
        `refusing to append a scorecard that fails verifyScorecard: ${verification.reason ?? "unknown"}`,
      );
    }

    const release = this.acquireLock();
    try {
      let state = this.readState();
      if (!state.hadHeaderLine) {
        // Legacy file (content, no header) or a freshly-empty file — either
        // way, normalize to the canonical header format before appending.
        this.atomicRewrite(state.header, state.entries);
        state = this.readState();
      }

      const prevHash =
        state.entries.length > 0
          ? state.entries[state.entries.length - 1].hash
          : (state.header.checkpointHash ?? EVAL_HISTORY_GENESIS);
      const seq = state.entries.length > 0 ? state.entries[state.entries.length - 1].seq + 1 : 0;

      const revision: ScorecardRevision = scorecard.revision;
      const sha = revision.sha;
      const branch = meta && meta.branch !== undefined ? meta.branch : revision.branch;
      const note = meta?.note ?? null;
      const recordedAtMs = this.nowFn();

      const fields: EntryFields = {
        seq,
        recordedAtMs,
        branch,
        sha,
        mode: scorecard.mode,
        suiteHash: scorecard.suiteHash,
        scorecard,
        note,
        prevHash,
      };
      const hash = computeEntryHash(fields);
      const entry: EvalHistoryEntry = { ...fields, hash };

      this.appendEntryLine(entry);

      if (this.retain !== undefined) {
        const totalNow = state.entries.length + 1;
        if (totalNow > this.retain) {
          this.compactLocked(this.retain);
        }
      }

      return entry;
    } finally {
      release();
    }
  }

  entries(q: HistoryQuery = {}): EvalHistoryEntry[] {
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 0)) {
      throw new RangeError("HistoryQuery.limit must be a non-negative integer");
    }
    const state = this.readState();
    const filtered = state.entries.filter((e) => this.matches(e, q));
    if (q.limit !== undefined && q.limit < filtered.length) {
      return filtered.slice(filtered.length - q.limit);
    }
    return filtered;
  }

  private matches(e: EvalHistoryEntry, q: HistoryQuery): boolean {
    if (q.branch !== undefined && e.branch !== q.branch) return false;
    if (q.sha !== undefined && e.sha !== q.sha) return false;
    if (q.mode !== undefined && e.mode !== q.mode) return false;
    if (q.suiteHash !== undefined && e.suiteHash !== q.suiteHash) return false;
    if (q.sinceMs !== undefined && e.recordedAtMs < q.sinceMs) return false;
    if (q.untilMs !== undefined && e.recordedAtMs > q.untilMs) return false;
    return true;
  }

  latest(q: HistoryQuery = {}): EvalHistoryEntry | null {
    const filtered = this.entries({ ...q, limit: undefined });
    return filtered.length > 0 ? filtered[filtered.length - 1] : null;
  }

  bySha(sha: string): EvalHistoryEntry[] {
    return this.entries({ sha });
  }

  verifyChain(): HistoryChainVerification {
    const state = this.readState();
    let expectedPrev = state.header.checkpointHash ?? EVAL_HISTORY_GENESIS;
    let expectedSeq: number | null = null;

    for (let i = 0; i < state.entries.length; i++) {
      const e = state.entries[i];
      if (expectedSeq !== null && e.seq !== expectedSeq + 1) {
        return { ok: false, entries: i, brokenAtSeq: e.seq, reason: "seq-gap" };
      }
      expectedSeq = e.seq;

      if (e.prevHash !== expectedPrev) {
        return { ok: false, entries: i, brokenAtSeq: e.seq, reason: "prev-hash-mismatch" };
      }

      const { hash, ...rest } = e;
      if (computeEntryHash(rest) !== hash) {
        return { ok: false, entries: i, brokenAtSeq: e.seq, reason: "hash-mismatch" };
      }
      expectedPrev = hash;
    }

    return { ok: true, entries: state.entries.length, brokenAtSeq: null, reason: null };
  }

  compact(keep: number): { removed: number; checkpointHash: string } {
    if (!Number.isInteger(keep) || keep < 0) {
      throw new RangeError("compact(keep) requires a non-negative integer");
    }
    const release = this.acquireLock();
    try {
      return this.compactLocked(keep);
    } finally {
      release();
    }
  }

  /** Assumes the caller already holds the lock. */
  private compactLocked(keep: number): { removed: number; checkpointHash: string } {
    const state = this.readState();
    if (keep >= state.entries.length) {
      return { removed: 0, checkpointHash: state.header.checkpointHash ?? EVAL_HISTORY_GENESIS };
    }
    const cutIndex = state.entries.length - keep;
    const pruned = state.entries.slice(0, cutIndex);
    const retained = state.entries.slice(cutIndex);
    const checkpointHash = pruned[pruned.length - 1].hash;

    this.atomicRewrite({ version: EVAL_HISTORY_VERSION, checkpointHash }, retained);
    return { removed: pruned.length, checkpointHash };
  }

  stats(): { entries: number; branches: string[]; firstMs: number | null; lastMs: number | null; bytes: number; version: number } {
    const state = this.readState();
    const branches = [...new Set(state.entries.map((e) => e.branch).filter((b): b is string => b !== null))].sort();
    const firstMs = state.entries.length > 0 ? state.entries[0].recordedAtMs : null;
    const lastMs = state.entries.length > 0 ? state.entries[state.entries.length - 1].recordedAtMs : null;
    const bytes = Buffer.byteLength(state.raw, "utf8");
    return { entries: state.entries.length, branches, firstMs, lastMs, bytes, version: EVAL_HISTORY_VERSION };
  }
}
