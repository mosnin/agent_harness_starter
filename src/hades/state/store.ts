/**
 * `WorkspaceStore` — the crash-safe, multi-process-safe, hash-chained
 * durable store every surface (CLI process, desktop sidecar process, TUI)
 * opens and mutates concurrently under `<root>/state`. Built entirely on
 * REAL `node:fs`; the only injected non-determinism is the business clock
 * (`opts.now`, defaulting to `Date.now`) used for record `updatedAt` and
 * journal `at` — never called inline elsewhere in this module.
 *
 * ## On-disk layout (locked)
 *
 * ```
 * <root>/manifest.json        { version, createdAt, actor }
 * <root>/domains/<domain>.json  one atomic segment per WorkspaceDomain
 * <root>/journal.log           newline-delimited JournalEntry JSON
 * <root>/.lock/                cross-process lock directory
 * <root>/quarantine/           corrupted files moved aside for forensics
 * ```
 *
 * ## Mutation discipline
 *
 * Every mutating call (`put`, `putMany`, `delete`, `applyRemote`, and the
 * internal side of `compact`) acquires the cross-process lock FIRST
 * ({@link WorkspaceStore.acquireLock}: atomic `mkdirSync` of `<root>/.lock`,
 * bounded retry with real-wall-clock backoff via `Atomics.wait`,
 * `lockTimeoutMs` default 5000ms), then RE-READS whatever segment(s)/journal
 * tail it needs directly off disk from inside the lock — never from an
 * in-memory cache — so a write from another process can never be clobbered
 * by a stale in-process view. Every write is tmp-file + `renameSync` (+
 * `fsyncSync` on the file and its parent directory when `fsync !== false`),
 * the journal entry is appended, and only then is the lock released.
 *
 * A held lock is reclaimed — never unconditionally — only when the pid
 * recorded in it is dead OR the lock directory's mtime exceeds
 * `staleLockMs` (default 30000ms). Read-only accessors (`get`, `list`) do
 * NOT take the lock: every write this module ever performs to a shared
 * file is atomic (tmp + rename), so a concurrent reader always observes
 * either the fully-old or the fully-new file, never a torn one.
 * `snapshot`, `journalSince`, and `verifyChain` DO take the lock, because
 * they read multiple files and need one consistent view across them.
 *
 * ## Corruption
 *
 * A segment or journal file that fails to parse/validate is moved to
 * `<root>/quarantine/<name>.<ts>.<rand>.bad` (bytes preserved), the
 * affected domain is rebuilt by replaying the journal (which is itself
 * self-healing: a single hand-edited/garbage line stops the replay there,
 * quarantines the original journal, and rewrites it with just the valid
 * prefix — a torn FINAL line, the signature of a writer killed mid-append,
 * is instead silently dropped since nothing was ever durably committed for
 * it), and {@link WorkspaceCorruptError} is thrown to the CURRENT caller —
 * never a silently empty store, never a fabricated record. Because the
 * repair already ran before the throw, the very next call against the same
 * store succeeds normally.
 *
 * ## Hash chain
 *
 * Rooted at `sha256Hex("hades.workspace.journal.v1")`. Every entry's
 * `hash = sha256Hex(prevHash + canonicalJson(entryBodyWithoutHash))`,
 * using the real `sha256Hex` from `../styx/certificate` — never
 * reimplemented. `compact()` collapses the whole journal into a single
 * checkpoint entry that carries the FULL current record set (across every
 * domain) as its `records`, re-roots its own `prevHash` at the genesis
 * hash, and keeps the checkpoint's `seq` equal to the last real entry's
 * `seq` it replaces. A cursor from `journalSince(seq)` that lands inside
 * the now-compacted prefix therefore observes a seq JUMP (its next entry's
 * `seq` is not `cursor + 1`) — that gap is precisely what marks an entry as
 * a full-state checkpoint rather than an incremental delta, so a
 * resumability-preserving consumer must treat ANY entry received with
 * `seq !== cursor + 1` as "replace my whole materialized view with this
 * entry's `records`", not "apply as a delta".
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { sha256Hex } from "../styx/certificate";
import {
  WORKSPACE_DOMAINS,
  WORKSPACE_STATE_VERSION,
  DRAFT_ACTOR_KIND,
  actorKey,
  canonicalJson,
  isWorkspaceDomain,
  isDraftActorKey,
  isWorkspaceRecord,
  mergeRecords,
  parseActorKey,
  recordHash,
  tickClock,
  validateKey,
  type ActorId,
  type ActorKey,
  type JsonValue,
  type WorkspaceDomain,
  type WorkspaceRecord,
} from "./record";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkspaceStoreOptions {
  root: string;
  actor: ActorId;
  now?: () => number;
  fsync?: boolean;
  journalMaxEntries?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export interface JournalEntry {
  seq: number;
  at: number;
  actor: ActorKey;
  prevHash: string;
  hash: string;
  records: WorkspaceRecord[];
}

export interface WorkspaceSnapshot {
  version: number;
  head: string;
  journalSeq: number;
  records: WorkspaceRecord[];
}

export interface WorkspaceApplyResult {
  applied: WorkspaceRecord[];
  rejected: Array<{ record: WorkspaceRecord; reason: string }>;
  conflicts: Array<{ key: string; domain: WorkspaceDomain; winner: WorkspaceRecord; loser: WorkspaceRecord; reason: string }>;
}

export class WorkspaceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceLockError";
  }
}

export class WorkspaceCorruptError extends Error {
  readonly quarantinePath: string;
  constructor(message: string, quarantinePath: string) {
    super(message);
    this.name = "WorkspaceCorruptError";
    this.quarantinePath = quarantinePath;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const JOURNAL_GENESIS_SEED = "hades.workspace.journal.v1";
const GENESIS_HASH = sha256Hex(JOURNAL_GENESIS_SEED);

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 30000;

/** Shared sleep primitive for the lock's backoff loop — real wall-clock time, never the injectable business clock. */
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

function fsyncPath(p: string): void {
  const fd = openSync(p, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dirPath: string): void {
  try {
    const fd = openSync(dirPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Opening a directory for fsync is not supported on every platform;
    // this is best-effort durability, not correctness-critical.
  }
}

function toJsonClockLocal(c: WorkspaceRecord["clock"]): { [k: string]: JsonValue } {
  const out: { [k: string]: JsonValue } = {};
  for (const k of Object.keys(c)) out[k] = c[k];
  return out;
}

function recordAsJson(r: WorkspaceRecord): { [k: string]: JsonValue } {
  return {
    domain: r.domain,
    key: r.key,
    rev: r.rev,
    clock: toJsonClockLocal(r.clock),
    updatedAt: r.updatedAt,
    actor: r.actor,
    deleted: r.deleted,
    hash: r.hash,
    value: r.value,
  };
}

function journalEntryBodyJson(e: Omit<JournalEntry, "hash">): { [k: string]: JsonValue } {
  return {
    seq: e.seq,
    at: e.at,
    actor: e.actor,
    prevHash: e.prevHash,
    records: e.records.map(recordAsJson),
  };
}

function isJournalEntryShape(v: unknown): v is JournalEntry {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 1) return false;
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return false;
  if (typeof e.actor !== "string" || !parseActorKey(e.actor)) return false;
  if (typeof e.prevHash !== "string") return false;
  if (typeof e.hash !== "string") return false;
  if (!Array.isArray(e.records)) return false;
  for (const r of e.records) {
    if (!isWorkspaceRecord(r)) return false;
  }
  return true;
}

function byDomainThenKey(a: WorkspaceRecord, b: WorkspaceRecord): number {
  if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function recordHashOf(r: WorkspaceRecord): string {
  return recordHash({
    domain: r.domain,
    key: r.key,
    rev: r.rev,
    clock: r.clock,
    updatedAt: r.updatedAt,
    actor: r.actor,
    deleted: r.deleted,
    value: r.value,
  });
}

// ---------------------------------------------------------------------------
// WorkspaceStore
// ---------------------------------------------------------------------------

export class WorkspaceStore {
  private readonly root: string;
  private readonly actor: ActorId;
  private readonly actorK: ActorKey;
  private readonly nowFn: () => number;
  private readonly fsync: boolean;
  private readonly journalMaxEntries: number | undefined;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  private readonly domainsDir: string;
  private readonly journalPath: string;
  private readonly lockDir: string;
  private readonly quarantineDir: string;
  private readonly manifestPath: string;

  private closed = false;

  constructor(opts: WorkspaceStoreOptions) {
    if (!opts || typeof opts.root !== "string" || opts.root.length === 0) {
      throw new RangeError("WorkspaceStoreOptions.root must be a non-empty path");
    }
    if (!opts.actor || typeof opts.actor.id !== "string" || opts.actor.id.length === 0 || !parseActorKey(`${opts.actor.kind}:${opts.actor.id}`)) {
      throw new RangeError("WorkspaceStoreOptions.actor must be a valid ActorId");
    }
    // `draft:` is the explicitly NON-durable placeholder kind (see
    // `./record.ts`): an unmaterialized mirror draft or a synthetic feed
    // resync batch. A store writing under it would put un-attributable
    // records into the shared journal, so it is refused up front.
    if (isDraftActorKey(actorKey(opts.actor))) {
      throw new RangeError(
        `WorkspaceStoreOptions.actor must be a durable actor kind — "${DRAFT_ACTOR_KIND}" is a non-persistable placeholder`,
      );
    }

    this.root = opts.root;
    this.actor = opts.actor;
    this.actorK = actorKey(opts.actor);
    this.nowFn = opts.now ?? Date.now;
    this.fsync = opts.fsync ?? true;
    this.journalMaxEntries = opts.journalMaxEntries;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS;

    this.domainsDir = join(this.root, "domains");
    this.journalPath = join(this.root, "journal.log");
    this.lockDir = join(this.root, ".lock");
    this.quarantineDir = join(this.root, "quarantine");
    this.manifestPath = join(this.root, "manifest.json");

    mkdirSync(this.domainsDir, { recursive: true });

    const release = this.acquireLock();
    try {
      if (!existsSync(this.manifestPath)) {
        const manifest = { version: WORKSPACE_STATE_VERSION, createdAt: this.nowFn(), actor: this.actorK };
        this.atomicWriteFile(this.manifestPath, JSON.stringify(manifest, null, 0));
      }
      if (!existsSync(this.journalPath)) {
        writeFileSync(this.journalPath, "", "utf8");
      }
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // Identity (read-only)
  // -------------------------------------------------------------------------

  /**
   * The store's configured root directory. A real accessor rather than a
   * reflection read of the private field: `src/desktop/core/state-service.ts`
   * needs the REAL root for its `WorkspaceStatusView`, and reaching through
   * TypeScript's compile-time-only `private` would silently break the day a
   * field is renamed.
   */
  get rootPath(): string {
    return this.root;
  }

  /** This store instance's actor identity, as the `"<kind>:<id>"` key stamped on every record it writes. */
  get actorKeyId(): ActorKey {
    return this.actorK;
  }

  /** This store instance's actor identity, structured. Returns a copy so a caller cannot mutate the store's own identity. */
  get actorId(): ActorId {
    return { kind: this.actor.kind, id: this.actor.id };
  }

  // -------------------------------------------------------------------------
  // Locking
  // -------------------------------------------------------------------------

  private acquireLock(): () => void {
    const startedAt = Date.now();
    let attempt = 0;
    for (;;) {
      try {
        mkdirSync(this.lockDir);
        const holder = { pid: process.pid, acquiredAt: Date.now(), actor: this.actorK };
        try {
          writeFileSync(join(this.lockDir, "holder.json"), JSON.stringify(holder), "utf8");
        } catch {
          // Best-effort diagnostics only; the mkdirSync above is what
          // actually establishes exclusivity.
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            rmSync(this.lockDir, { recursive: true, force: true });
          } catch {
            /* already gone */
          }
        };
      } catch (err) {
        if (!isErrnoException(err) || err.code !== "EEXIST") throw err;
        if (this.tryReclaimStaleLock()) continue; // reclaimed — retry mkdir immediately
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new WorkspaceLockError(
            `timed out acquiring workspace lock at "${this.lockDir}" after ${this.lockTimeoutMs}ms`,
          );
        }
        const backoffMs = Math.min(100, 4 * 2 ** attempt) + Math.floor(Math.random() * 8);
        attempt++;
        sleepSyncMs(backoffMs);
      }
    }
  }

  /** Reclaims (removes) a held lock ONLY if its pid is dead or it has exceeded `staleLockMs`. Returns true if reclaimed. */
  private tryReclaimStaleLock(): boolean {
    let pid: number | undefined;
    try {
      const raw = readFileSync(join(this.lockDir, "holder.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && typeof (parsed as { pid?: unknown }).pid === "number") {
        pid = (parsed as { pid: number }).pid;
      }
    } catch {
      // Missing or garbage holder file (hostile/corrupt lock dir) — fall
      // back to mtime-based staleness only.
    }

    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.lockDir).mtimeMs;
    } catch {
      // Lock directory vanished between our failed mkdir and now (another
      // process released or reclaimed it already) — let the caller retry.
      return true;
    }

    const deadPid = pid !== undefined && !isPidAlive(pid);
    const expiredByAge = Date.now() - mtimeMs >= this.staleLockMs;
    if (!deadPid && !expiredByAge) return false; // genuinely still held

    try {
      rmSync(this.lockDir, { recursive: true, force: true });
    } catch {
      /* raced with the real holder releasing it, or another reclaimer — fine either way */
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Atomic file helpers
  // -------------------------------------------------------------------------

  private atomicWriteFile(path: string, body: string): void {
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    writeFileSync(tmp, body, "utf8");
    if (this.fsync) fsyncPath(tmp);
    renameSync(tmp, path);
    if (this.fsync) fsyncDir(dirname(path));
  }

  private segmentPath(domain: WorkspaceDomain): string {
    return join(this.domainsDir, `${domain}.json`);
  }

  private writeSegmentAtomic(domain: WorkspaceDomain, map: Map<string, WorkspaceRecord>): void {
    const records = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const body = JSON.stringify({ version: WORKSPACE_STATE_VERSION, records });
    this.atomicWriteFile(this.segmentPath(domain), body);
  }

  private quarantineFile(path: string, baseName: string): string {
    mkdirSync(this.quarantineDir, { recursive: true });
    const dest = join(this.quarantineDir, `${baseName}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.bad`);
    try {
      renameSync(path, dest);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return dest; // already moved by a racing recovery
      throw err;
    }
    return dest;
  }

  // -------------------------------------------------------------------------
  // Domain segment reads (self-healing)
  // -------------------------------------------------------------------------

  private tryParseSegment(raw: string, domain: WorkspaceDomain): Map<string, WorkspaceRecord> | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
    const obj = json as { version?: unknown; records?: unknown };
    if (obj.version !== WORKSPACE_STATE_VERSION) return null;
    if (!Array.isArray(obj.records)) return null;

    const map = new Map<string, WorkspaceRecord>();
    for (const r of obj.records) {
      if (!isWorkspaceRecord(r)) return null;
      if (r.domain !== domain) return null;
      if (!r.deleted && recordHashOf(r) !== r.hash) return null;
      if (map.has(r.key)) return null; // duplicate key is itself a corruption signal
      map.set(r.key, r);
    }
    return map;
  }

  private tryReadDomainOnce(domain: WorkspaceDomain): { ok: true; map: Map<string, WorkspaceRecord> } | { ok: false } {
    const path = this.segmentPath(domain);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return { ok: true, map: new Map() };
      throw err;
    }
    const parsed = this.tryParseSegment(raw, domain);
    return parsed ? { ok: true, map: parsed } : { ok: false };
  }

  /**
   * Reads a domain's segment, self-healing on any corruption. `lockHeld`
   * MUST be `true` iff the caller already holds the cross-process lock
   * (every mutating method, plus `snapshot`/`compact`). Callers that do
   * NOT hold the lock (`get`, `list`) pass `false`: the common case (a
   * valid segment) never touches the lock at all, and only on an actual
   * corruption finding does this method acquire the lock itself, re-verify
   * under it (a concurrent writer may have already fixed things while the
   * lock was being acquired), and only then perform the quarantine +
   * rebuild-from-journal + rewrite — so a lock-free recovery write can
   * never race a concurrent locked writer's own atomic rename.
   */
  private readDomain(domain: WorkspaceDomain, lockHeld: boolean): Map<string, WorkspaceRecord> {
    const first = this.tryReadDomainOnce(domain);
    if (first.ok) return first.map;

    if (lockHeld) return this.recoverDomain(domain);

    const release = this.acquireLock();
    try {
      const retry = this.tryReadDomainOnce(domain);
      if (retry.ok) return retry.map; // a concurrent writer already fixed it
      return this.recoverDomain(domain);
    } finally {
      release();
    }
  }

  /** Assumes the lock is already held (directly, or freshly acquired by `readDomain`). */
  private recoverDomain(domain: WorkspaceDomain): Map<string, WorkspaceRecord> {
    const path = this.segmentPath(domain);
    const quarantinePath = this.quarantineFile(path, `${domain}.json`);
    const rebuilt = this.rebuildDomainFromJournal(domain);
    this.writeSegmentAtomic(domain, rebuilt);
    throw new WorkspaceCorruptError(
      `workspace domain segment "${domain}" was corrupt; quarantined to ${quarantinePath} and rebuilt ${rebuilt.size} record(s) from the journal`,
      quarantinePath,
    );
  }

  private rebuildDomainFromJournal(domain: WorkspaceDomain): Map<string, WorkspaceRecord> {
    const { entries } = this.readJournalEntriesRecovering();
    const map = new Map<string, WorkspaceRecord>();
    for (const entry of entries) {
      for (const rec of entry.records) {
        if (rec.domain === domain) map.set(rec.key, rec);
      }
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Journal reads (self-healing) and appends
  // -------------------------------------------------------------------------

  /**
   * Tolerant journal reader: parses every line, silently drops a torn
   * FINAL line (writer killed mid-append — nothing durable was lost), and
   * on any OTHER invalid line quarantines the original file, rewrites it
   * with just the valid prefix, and reports the corruption instead of
   * throwing directly (callers decide whether/how to surface it).
   */
  private readJournalEntriesRecovering(): { entries: JournalEntry[]; corrupt?: { path: string; reason: string } } {
    let raw: string;
    try {
      raw = readFileSync(this.journalPath, "utf8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return { entries: [] };
      throw err;
    }
    if (raw.length === 0) return { entries: [] };

    let lines = raw.split("\n");
    if (lines[lines.length - 1] === "") lines = lines.slice(0, -1);
    if (lines.length === 0) return { entries: [] };

    const entries: JournalEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      if (line.trim() === "") {
        if (isLast) break;
        continue;
      }
      let parsed: unknown;
      let shapeOk = true;
      try {
        parsed = JSON.parse(line);
      } catch {
        shapeOk = false;
      }
      if (shapeOk && !isJournalEntryShape(parsed)) shapeOk = false;

      if (!shapeOk) {
        if (isLast) {
          // Torn trailing write (writer killed mid-append): nothing durable
          // was ever committed for it, so just drop it. This method is only
          // ever invoked while the lock is held (see the class doc), so it
          // is safe to physically truncate the file back to the valid
          // prefix here too — that guarantees the NEXT append lands after a
          // real newline instead of concatenating onto torn bytes.
          this.rewriteJournalFile(entries);
          break;
        }
        const quarantinePath = this.quarantineFile(this.journalPath, "journal.log");
        this.rewriteJournalFile(entries);
        return {
          entries,
          corrupt: { path: quarantinePath, reason: `journal.log line ${i + 1} is not a well-formed journal entry` },
        };
      }
      entries.push(parsed as JournalEntry);
    }
    return { entries };
  }

  private throwCorrupt(entries: JournalEntry[], corrupt: { path: string; reason: string }): never {
    throw new WorkspaceCorruptError(
      `workspace journal was corrupt (${corrupt.reason}); quarantined to ${corrupt.path} and rebuilt from the surviving valid prefix (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`,
      corrupt.path,
    );
  }

  private readJournalTailOrThrow(): { seq: number; hash: string } {
    const { entries, corrupt } = this.readJournalEntriesRecovering();
    if (corrupt) this.throwCorrupt(entries, corrupt);
    const last = entries[entries.length - 1];
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS_HASH };
  }

  private rewriteJournalFile(entries: JournalEntry[]): void {
    const body = entries.length === 0 ? "" : entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    this.atomicWriteFile(this.journalPath, body);
  }

  private buildJournalEntry(tail: { seq: number; hash: string }, records: WorkspaceRecord[]): JournalEntry {
    const seq = tail.seq + 1;
    const prevHash = tail.hash;
    const body: Omit<JournalEntry, "hash"> = { seq, at: this.nowFn(), actor: this.actorK, prevHash, records };
    const hash = sha256Hex(prevHash + canonicalJson(journalEntryBodyJson(body)));
    return { ...body, hash };
  }

  private appendJournalLine(entry: JournalEntry): void {
    const line = JSON.stringify(entry) + "\n";
    const fd = openSync(this.journalPath, "a");
    try {
      writeSync(fd, line);
      if (this.fsync) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private maybeAutoCompact(): void {
    if (this.journalMaxEntries === undefined) return;
    const { entries, corrupt } = this.readJournalEntriesRecovering();
    if (corrupt) return; // leave corruption for the next explicit read to surface honestly
    if (entries.length > this.journalMaxEntries) {
      this.compactLocked();
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new Error("WorkspaceStore is closed");
  }

  close(): void {
    this.closed = true;
  }

  // -------------------------------------------------------------------------
  // Mutating API
  // -------------------------------------------------------------------------

  put(domain: WorkspaceDomain, key: string, value: JsonValue): WorkspaceRecord {
    this.assertOpen();
    const release = this.acquireLock();
    try {
      if (!isWorkspaceDomain(domain)) throw new RangeError(`put: invalid domain ${JSON.stringify(domain)}`);
      validateKey(key);
      canonicalJson(value); // validates the value is a strict JsonValue; throws CanonicalJsonError otherwise

      const tail = this.readJournalTailOrThrow();
      const map = this.readDomain(domain, true);
      const prior = map.get(key);
      const clock = tickClock(prior?.clock ?? {}, this.actorK);
      const rev = (prior?.rev ?? 0) + 1;
      const at = this.nowFn();
      const body: Omit<WorkspaceRecord, "hash"> = {
        domain,
        key,
        rev,
        clock,
        updatedAt: at,
        actor: this.actorK,
        deleted: false,
        value,
      };
      const record: WorkspaceRecord = { ...body, hash: recordHash(body) };

      map.set(key, record);
      this.writeSegmentAtomic(domain, map);
      this.appendJournalLine(this.buildJournalEntry(tail, [record]));
      this.maybeAutoCompact();
      return record;
    } finally {
      release();
    }
  }

  putMany(entries: Array<{ domain: WorkspaceDomain; key: string; value: JsonValue }>): WorkspaceRecord[] {
    this.assertOpen();
    if (entries.length === 0) return [];
    const release = this.acquireLock();
    try {
      // Validate every entry BEFORE touching any state — all-or-nothing.
      for (const e of entries) {
        if (!isWorkspaceDomain(e.domain)) throw new RangeError(`putMany: invalid domain ${JSON.stringify(e.domain)}`);
        validateKey(e.key);
        canonicalJson(e.value);
      }

      const tail = this.readJournalTailOrThrow();
      const domainMaps = new Map<WorkspaceDomain, Map<string, WorkspaceRecord>>();
      const results: WorkspaceRecord[] = [];
      const at = this.nowFn();

      for (const e of entries) {
        let map = domainMaps.get(e.domain);
        if (!map) {
          map = this.readDomain(e.domain, true);
          domainMaps.set(e.domain, map);
        }
        const prior = map.get(e.key);
        const clock = tickClock(prior?.clock ?? {}, this.actorK);
        const rev = (prior?.rev ?? 0) + 1;
        const body: Omit<WorkspaceRecord, "hash"> = {
          domain: e.domain,
          key: e.key,
          rev,
          clock,
          updatedAt: at,
          actor: this.actorK,
          deleted: false,
          value: e.value,
        };
        const record: WorkspaceRecord = { ...body, hash: recordHash(body) };
        map.set(e.key, record);
        results.push(record);
      }

      for (const [domain, map] of domainMaps) this.writeSegmentAtomic(domain, map);
      this.appendJournalLine(this.buildJournalEntry(tail, results));
      this.maybeAutoCompact();
      return results;
    } finally {
      release();
    }
  }

  delete(domain: WorkspaceDomain, key: string): WorkspaceRecord | null {
    this.assertOpen();
    const release = this.acquireLock();
    try {
      if (!isWorkspaceDomain(domain)) throw new RangeError(`delete: invalid domain ${JSON.stringify(domain)}`);
      validateKey(key);

      const tail = this.readJournalTailOrThrow();
      const map = this.readDomain(domain, true);
      const prior = map.get(key);
      if (!prior || prior.deleted) return null; // nothing to delete — no-op, no write

      const clock = tickClock(prior.clock, this.actorK);
      const rev = prior.rev + 1;
      const at = this.nowFn();
      const record: WorkspaceRecord = {
        domain,
        key,
        rev,
        clock,
        updatedAt: at,
        actor: this.actorK,
        deleted: true,
        hash: "",
        value: null,
      };

      map.set(key, record);
      this.writeSegmentAtomic(domain, map);
      this.appendJournalLine(this.buildJournalEntry(tail, [record]));
      this.maybeAutoCompact();
      return record;
    } finally {
      release();
    }
  }

  applyRemote(records: WorkspaceRecord[]): WorkspaceApplyResult {
    this.assertOpen();
    const applied: WorkspaceRecord[] = [];
    const rejected: WorkspaceApplyResult["rejected"] = [];
    const conflicts: WorkspaceApplyResult["conflicts"] = [];

    const candidates: WorkspaceRecord[] = [];
    for (const r of records) {
      if (!isWorkspaceRecord(r)) {
        // Shape validation already covers a tombstone's hash/value invariants
        // (deleted => hash === "" && value === null), so nothing further to
        // check for a tombstone once this passes.
        rejected.push({ record: r, reason: "not a structurally valid workspace record" });
        continue;
      }
      if (isDraftActorKey(r.actor)) {
        // An unmaterialized `draft:` placeholder (an InMemoryMirror draft
        // that was never rewrapped under a real ActorId, or a synthetic feed
        // resync batch) must never enter the durable journal — its clock key
        // is not a real causal participant, so persisting it would poison
        // every future vector-clock comparison against this key.
        rejected.push({
          record: r,
          reason: `actor "${r.actor}" is the non-persistable "${DRAFT_ACTOR_KIND}" placeholder kind — materialize it under a real ActorId first`,
        });
        continue;
      }
      if (!r.deleted) {
        const expected = recordHashOf(r);
        if (expected !== r.hash) {
          rejected.push({ record: r, reason: `hash mismatch: expected ${expected}, got ${r.hash}` });
          continue;
        }
      }
      candidates.push(r);
    }
    if (candidates.length === 0) return { applied, rejected, conflicts };

    const release = this.acquireLock();
    try {
      const tail = this.readJournalTailOrThrow();
      const domainMaps = new Map<WorkspaceDomain, Map<string, WorkspaceRecord>>();
      const journalRecords: WorkspaceRecord[] = [];

      for (const remote of candidates) {
        let map = domainMaps.get(remote.domain);
        if (!map) {
          map = this.readDomain(remote.domain, true);
          domainMaps.set(remote.domain, map);
        }
        const local = map.get(remote.key);
        if (!local) {
          const clone = structuredClone(remote);
          map.set(remote.key, clone);
          applied.push(clone);
          journalRecords.push(clone);
          continue;
        }

        const { winner, reason } = mergeRecords(local, remote);
        if (winner === local) {
          continue; // local already dominates or is identical — no-op
        }
        const stored = winner === remote ? structuredClone(remote) : winner;
        map.set(remote.key, stored);
        applied.push(stored);
        journalRecords.push(stored);
        if (reason === "concurrent-tiebreak") {
          conflicts.push({ key: remote.key, domain: remote.domain, winner: stored, loser: local, reason });
        }
      }

      if (journalRecords.length > 0) {
        for (const [domain, map] of domainMaps) this.writeSegmentAtomic(domain, map);
        this.appendJournalLine(this.buildJournalEntry(tail, journalRecords));
        this.maybeAutoCompact();
      }
      return { applied, rejected, conflicts };
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // Read-only API
  // -------------------------------------------------------------------------

  get(domain: WorkspaceDomain, key: string): WorkspaceRecord | undefined {
    this.assertOpen();
    if (!isWorkspaceDomain(domain)) throw new RangeError(`get: invalid domain ${JSON.stringify(domain)}`);
    const map = this.readDomain(domain, false);
    return map.get(key);
  }

  list(domain: WorkspaceDomain, opts: { prefix?: string; includeDeleted?: boolean } = {}): WorkspaceRecord[] {
    this.assertOpen();
    if (!isWorkspaceDomain(domain)) throw new RangeError(`list: invalid domain ${JSON.stringify(domain)}`);
    const map = this.readDomain(domain, false);
    let arr = [...map.values()];
    if (!opts.includeDeleted) arr = arr.filter((r) => !r.deleted);
    if (opts.prefix !== undefined) arr = arr.filter((r) => r.key.startsWith(opts.prefix!));
    arr.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return arr;
  }

  snapshot(): WorkspaceSnapshot {
    this.assertOpen();
    const release = this.acquireLock();
    try {
      const records: WorkspaceRecord[] = [];
      for (const domain of WORKSPACE_DOMAINS) {
        const map = this.readDomain(domain, true);
        records.push(...map.values());
      }
      records.sort(byDomainThenKey);
      const tail = this.readJournalTailOrThrow();
      return { version: WORKSPACE_STATE_VERSION, head: tail.hash, journalSeq: tail.seq, records };
    } finally {
      release();
    }
  }

  journalSince(seq: number): JournalEntry[] {
    this.assertOpen();
    const release = this.acquireLock();
    try {
      const { entries, corrupt } = this.readJournalEntriesRecovering();
      if (corrupt) this.throwCorrupt(entries, corrupt);
      return entries.filter((e) => e.seq > seq);
    } finally {
      release();
    }
  }

  verifyChain(): { ok: boolean; brokenAt?: number; reason?: string } {
    this.assertOpen();
    const release = this.acquireLock();
    try {
      const { entries, corrupt } = this.readJournalEntriesRecovering();
      if (corrupt) {
        const brokenAt = entries.length > 0 ? entries[entries.length - 1].seq + 1 : 1;
        return { ok: false, brokenAt, reason: corrupt.reason };
      }
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const expectedPrevHash = i === 0 ? GENESIS_HASH : entries[i - 1].hash;
        if (e.prevHash !== expectedPrevHash) {
          return { ok: false, brokenAt: e.seq, reason: `prevHash mismatch at seq ${e.seq}` };
        }
        const recomputed = sha256Hex(
          e.prevHash + canonicalJson(journalEntryBodyJson({ seq: e.seq, at: e.at, actor: e.actor, prevHash: e.prevHash, records: e.records })),
        );
        if (recomputed !== e.hash) {
          return { ok: false, brokenAt: e.seq, reason: `hash mismatch at seq ${e.seq}` };
        }
        if (i > 0 && e.seq !== entries[i - 1].seq + 1) {
          return {
            ok: false,
            brokenAt: e.seq,
            reason: `seq is not contiguous with previous entry (expected ${entries[i - 1].seq + 1}, got ${e.seq})`,
          };
        }
      }
      return { ok: true };
    } finally {
      release();
    }
  }

  compact(): { before: number; after: number } {
    this.assertOpen();
    const release = this.acquireLock();
    try {
      return this.compactLocked();
    } finally {
      release();
    }
  }

  /** Assumes the caller already holds the lock. */
  private compactLocked(): { before: number; after: number } {
    const { entries, corrupt } = this.readJournalEntriesRecovering();
    if (corrupt) this.throwCorrupt(entries, corrupt);
    const before = entries.length;
    if (before === 0) return { before: 0, after: 0 };

    const allRecords: WorkspaceRecord[] = [];
    for (const domain of WORKSPACE_DOMAINS) {
      const map = this.readDomain(domain, true);
      allRecords.push(...map.values());
    }
    allRecords.sort(byDomainThenKey);

    const last = entries[entries.length - 1];
    const body: Omit<JournalEntry, "hash"> = {
      seq: last.seq,
      at: this.nowFn(),
      actor: this.actorK,
      prevHash: GENESIS_HASH,
      records: allRecords,
    };
    const hash = sha256Hex(GENESIS_HASH + canonicalJson(journalEntryBodyJson(body)));
    const checkpoint: JournalEntry = { ...body, hash };

    this.rewriteJournalFile([checkpoint]);
    return { before, after: 1 };
  }
}
