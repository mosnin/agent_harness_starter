/**
 * `WorkspaceFeed` — a durable, resumable, compaction-aware tail of a
 * `WorkspaceStore`'s journal, so a long-lived process (desktop sidecar, TUI)
 * can observe another process's writes shortly after they happen instead of
 * re-reading the whole store on a timer.
 *
 * ## Cursors
 *
 * A feed is opened for a named `consumer`. Its position is a {@link
 * FeedCursor} persisted at `<root>/cursors/<consumer>.json` (atomic
 * tmp-file + rename, mirroring `WorkspaceStore`'s own write discipline).
 * `consumer` is validated with `../state/record`'s `validateKey` — the same
 * rule the store applies to workspace keys — so a hostile consumer name
 * (e.g. `"../../etc/passwd"`) throws instead of ever being joined into a
 * path. Because the cursor lives on disk keyed only by `consumer` + `root`,
 * a second process opening a `WorkspaceFeed` for the same consumer resumes
 * exactly where the first process left off — cursors are not process-local
 * state.
 *
 * ## Delivery
 *
 * `poll()` re-reads the persisted cursor from disk (so it always reflects
 * whatever the durable record says, even if another process advanced it),
 * drains new `WorkspaceChange`s in strict journal order, advances +
 * persists the cursor to match exactly what was delivered, and returns the
 * batch. `peek()` runs the identical computation without persisting the
 * cursor or notifying subscribers — a dry run. Delivery is ordered,
 * gap-free by construction (a batch is only ever built from a contiguous
 * run of `seq`s starting at `cursor.seq + 1`), and a listener that throws
 * is contained — mirrors `createEventHub` in `src/desktop/ui/bridge.ts` —
 * so one bad subscriber can never break another or stop delivery.
 *
 * ## Compaction / corruption self-heal
 *
 * `WorkspaceStore.compact()` collapses history into a single checkpoint
 * entry whose `seq` does not follow the cursor's `seq + 1` — see the
 * "Hash chain" section of `../state/store.ts`'s module doc. A cursor
 * landing inside a compacted or otherwise broken prefix is NEVER silently
 * advanced past a gap: `poll()` detects the discontinuity (a seq jump, a
 * store-reported corruption, or a same-seq/mismatched-hash rewrite),
 * classifies it via {@link WorkspaceFeed.resync}, and delivers a single
 * synthetic `WorkspaceChange` carrying the full current `WorkspaceSnapshot`
 * instead — so a resync never drops changes, it replaces the whole view.
 *
 * ## Watching
 *
 * `start()` always arms an interval fallback (`pollMs`, default 250ms) so
 * delivery keeps working even where `fs.watch` is unavailable (some
 * sandboxes). When `opts.watch !== false` it additionally tries `fs.watch`
 * on `<root>/journal.log`; multiple watch events arriving in a burst are
 * coalesced into a single `poll()` via a pending-timer flag. If `fs.watch`
 * itself throws (unsupported platform/sandbox), that failure is reported
 * through `onError` and the feed degrades honestly to interval-only
 * polling — it never claims to be watching when the handle failed to open.
 * `stop()` clears the interval and closes the watcher; it is idempotent and
 * leaves no live timers/watchers behind.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  watch as fsWatch,
  writeSync,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";

import { WorkspaceCorruptError, type JournalEntry, type WorkspaceSnapshot, type WorkspaceStore } from "./store";
import { validateKey, type ActorKey, type WorkspaceRecord } from "./record";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkspaceChange {
  seq: number;
  at: number;
  actor: ActorKey;
  records: WorkspaceRecord[];
}

export interface FeedCursor {
  consumer: string;
  seq: number;
  head: string;
  updatedAt: number;
}

export interface WorkspaceFeedOptions {
  store: WorkspaceStore;
  root: string;
  consumer: string;
  now?: () => number;
  pollMs?: number;
  batchMax?: number;
  watch?: boolean;
  onError?: (e: Error) => void;
}

export type FeedListener = (batch: WorkspaceChange[]) => void;

export type ResyncReason = "compacted" | "truncated" | "chain-broken" | "none";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 250;

/** Bootstrap sentinel meaning "no journal entry has been observed yet" — deliberately NOT tied to WorkspaceStore's private genesis hash constant, which this module has no access to and should not need to reconstruct. */
const NO_HEAD = "";

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e;
}

/** A minimal, `createEventHub`-style listener fan-out: a throwing listener never breaks the feed or any other listener. */
function createBatchHub(onError?: (e: Error) => void): {
  dispatch: (batch: WorkspaceChange[]) => void;
  subscribe: (cb: FeedListener) => () => void;
  clear: () => void;
} {
  const listeners = new Set<FeedListener>();
  return {
    dispatch(batch: WorkspaceChange[]) {
      if (batch.length === 0) return;
      for (const cb of listeners) {
        try {
          cb(batch);
        } catch (err) {
          try {
            onError?.(err instanceof Error ? err : new Error(String(err)));
          } catch {
            /* onError itself must never break delivery */
          }
        }
      }
    },
    subscribe(cb: FeedListener) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    clear() {
      listeners.clear();
    },
  };
}

function toWorkspaceChange(e: JournalEntry): WorkspaceChange {
  return { seq: e.seq, at: e.at, actor: e.actor, records: e.records };
}

/**
 * Attribution for a synthetic batch meaning "replace your whole materialized
 * view with this snapshot" — emitted only when a gap-free incremental
 * delivery is impossible (compaction, truncation, or chain corruption).
 *
 * It uses the dedicated non-durable `"draft"` {@link ActorKind} (see
 * `./record.ts`) rather than impersonating a real surface: no journal entry
 * authored this batch, so claiming a `sidecar:`/`cli:` actor would be a
 * fabricated provenance. `draft:` actors can never be persisted by
 * `WorkspaceStore`, which makes the distinction enforced, not merely
 * documented.
 */
const RESYNC_ACTOR: ActorKey = "draft:resync";

function snapshotToChange(snapshot: WorkspaceSnapshot, at: number): WorkspaceChange {
  return { seq: snapshot.journalSeq, at, actor: RESYNC_ACTOR, records: snapshot.records };
}

// ---------------------------------------------------------------------------
// WorkspaceFeed
// ---------------------------------------------------------------------------

export class WorkspaceFeed {
  private readonly store: WorkspaceStore;
  private readonly root: string;
  private readonly consumer: string;
  private readonly nowFn: () => number;
  private readonly pollMs: number;
  private readonly batchMax: number | undefined;
  private readonly watchEnabled: boolean;
  private readonly onErrorCb: ((e: Error) => void) | undefined;

  private readonly cursorsDir: string;
  private readonly cursorPath: string;
  private readonly journalPath: string;

  private readonly hub: ReturnType<typeof createBatchHub>;

  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  private watcher: FSWatcher | undefined;
  private pendingWatchPoll = false;
  private started = false;

  constructor(opts: WorkspaceFeedOptions) {
    if (!opts || typeof opts.root !== "string" || opts.root.length === 0) {
      throw new RangeError("WorkspaceFeedOptions.root must be a non-empty path");
    }
    validateKey(opts.consumer); // throws InvalidKeyError on "/", "..", control chars, etc. — never allows escaping <root>/cursors
    if (opts.batchMax !== undefined && (!Number.isInteger(opts.batchMax) || opts.batchMax < 1)) {
      throw new RangeError("WorkspaceFeedOptions.batchMax must be a positive integer");
    }

    this.store = opts.store;
    this.root = opts.root;
    this.consumer = opts.consumer;
    this.nowFn = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.batchMax = opts.batchMax;
    this.watchEnabled = opts.watch ?? true;
    this.onErrorCb = opts.onError;

    this.cursorsDir = join(this.root, "cursors");
    this.cursorPath = join(this.cursorsDir, `${this.consumer}.json`);
    this.journalPath = join(this.root, "journal.log");

    this.hub = createBatchHub(this.onErrorCb);

    mkdirSync(this.cursorsDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Cursor persistence
  // -------------------------------------------------------------------------

  private emptyCursor(): FeedCursor {
    return { consumer: this.consumer, seq: 0, head: NO_HEAD, updatedAt: this.nowFn() };
  }

  private readCursorFromDisk(): FeedCursor {
    let raw: string;
    try {
      raw = readFileSync(this.cursorPath, "utf8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return this.emptyCursor();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt cursor file is treated as "never synced" — a fresh poll()
      // will simply re-derive a full picture (via the seq/head mismatch path
      // below) rather than crash the consumer.
      return this.emptyCursor();
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { consumer?: unknown }).consumer !== "string" ||
      typeof (parsed as { seq?: unknown }).seq !== "number" ||
      typeof (parsed as { head?: unknown }).head !== "string" ||
      typeof (parsed as { updatedAt?: unknown }).updatedAt !== "number"
    ) {
      return this.emptyCursor();
    }
    const c = parsed as FeedCursor;
    return { consumer: c.consumer, seq: c.seq, head: c.head, updatedAt: c.updatedAt };
  }

  private persistCursor(cursor: FeedCursor): void {
    const tmp = `${this.cursorPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(cursor));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.cursorPath);
  }

  cursor(): FeedCursor {
    return this.readCursorFromDisk();
  }

  reset(seq?: number): void {
    if (seq === undefined) {
      // Skip to "caught up right now": discard any pending backlog.
      const snapshot = this.store.snapshot();
      this.persistCursor({ consumer: this.consumer, seq: snapshot.journalSeq, head: snapshot.head, updatedAt: this.nowFn() });
      return;
    }
    if (!Number.isInteger(seq) || seq < 0) {
      throw new RangeError(`WorkspaceFeed.reset: seq must be a non-negative integer, got ${seq}`);
    }
    if (seq === 0) {
      this.persistCursor({ consumer: this.consumer, seq: 0, head: NO_HEAD, updatedAt: this.nowFn() });
      return;
    }
    const entry = this.probeAt(seq);
    if (!entry) {
      throw new RangeError(
        `WorkspaceFeed.reset: seq ${seq} does not correspond to a surviving journal entry (it may have been compacted away or never existed)`,
      );
    }
    this.persistCursor({ consumer: this.consumer, seq: entry.seq, head: entry.hash, updatedAt: this.nowFn() });
  }

  // -------------------------------------------------------------------------
  // Journal probing helpers
  // -------------------------------------------------------------------------

  /** The single journal entry whose `seq === target`, or `undefined` if it no longer exists as a discrete entry (compacted away, or never existed). */
  private probeAt(target: number): JournalEntry | undefined {
    const entries = this.store.journalSince(Math.max(0, target - 1));
    const first = entries[0];
    return first && first.seq === target ? first : undefined;
  }

  private classifyResync(cursor: FeedCursor): ResyncReason {
    if (cursor.seq === 0) return "none";
    const entry = this.probeAt(cursor.seq);
    if (!entry) {
      // The recorded seq no longer exists as a discrete entry. If the
      // journal's current tail is still >= cursor.seq, it was folded into a
      // checkpoint (compaction); if the tail is now SHORTER than cursor.seq,
      // the journal itself was truncated/rewound out from under us.
      const tailEntries = this.store.journalSince(0);
      const tailSeq = tailEntries.length > 0 ? tailEntries[tailEntries.length - 1].seq : 0;
      return tailSeq < cursor.seq ? "truncated" : "compacted";
    }
    return entry.hash === cursor.head ? "none" : "chain-broken";
  }

  resync(): { reason: ResyncReason; snapshot?: WorkspaceSnapshot } {
    const cursor = this.readCursorFromDisk();
    let reason: ResyncReason;
    try {
      reason = this.classifyResync(cursor);
    } catch (err) {
      if (err instanceof WorkspaceCorruptError) {
        reason = "chain-broken";
      } else {
        throw err;
      }
    }
    const snapshot = this.store.snapshot();
    this.persistCursor({ consumer: this.consumer, seq: snapshot.journalSeq, head: snapshot.head, updatedAt: this.nowFn() });
    return { reason, snapshot };
  }

  // -------------------------------------------------------------------------
  // poll / peek
  // -------------------------------------------------------------------------

  private drain(persist: boolean): WorkspaceChange[] {
    const cursor = this.readCursorFromDisk();

    let entries: JournalEntry[];
    try {
      entries = this.store.journalSince(cursor.seq);
    } catch (err) {
      if (err instanceof WorkspaceCorruptError) {
        this.reportError(err);
        return this.deliverResync(cursor, "chain-broken", persist);
      }
      throw err;
    }

    if (entries.length > 0 && entries[0].seq !== cursor.seq + 1) {
      // A gap: the very next entry does not continue where we left off.
      // Classify precisely (compacted vs. a rewritten/broken chain) rather
      // than assume — see the module doc.
      let reason: ResyncReason;
      try {
        reason = this.classifyResync(cursor);
      } catch (err) {
        reason = err instanceof WorkspaceCorruptError ? "chain-broken" : (() => { throw err; })();
      }
      if (reason === "none") reason = "compacted"; // a jump always means SOMETHING changed underneath us
      return this.deliverResync(cursor, reason, persist);
    }

    if (entries.length === 0) {
      if (cursor.seq === 0) return [];
      // No entries strictly after our seq — but confirm our recorded
      // position still exists, unaltered, in the real chain (catches a
      // same-seq rewrite or a truncation that a plain `> seq` filter can't
      // distinguish from "fully caught up").
      let reason: ResyncReason;
      try {
        reason = this.classifyResync(cursor);
      } catch (err) {
        reason = err instanceof WorkspaceCorruptError ? "chain-broken" : (() => { throw err; })();
      }
      if (reason === "none") return [];
      return this.deliverResync(cursor, reason, persist);
    }

    // Normal, gap-free, contiguous incremental delivery — respect batchMax
    // by stopping BEFORE crossing it, except a single oversized entry is
    // always delivered whole (never split mid-entry, never blocked forever).
    const out: WorkspaceChange[] = [];
    let total = 0;
    let lastSeq = cursor.seq;
    let lastHead = cursor.head;
    for (const e of entries) {
      if (e.seq !== lastSeq + 1) break; // defensive: a mid-stream gap stops delivery here; the next poll() will classify + resync from this point
      if (out.length > 0 && this.batchMax !== undefined && total + e.records.length > this.batchMax) break;
      out.push(toWorkspaceChange(e));
      total += e.records.length;
      lastSeq = e.seq;
      lastHead = e.hash;
      if (this.batchMax !== undefined && total >= this.batchMax) break;
    }

    if (out.length === 0) return [];

    if (persist) {
      this.persistCursor({ consumer: this.consumer, seq: lastSeq, head: lastHead, updatedAt: this.nowFn() });
      this.hub.dispatch(out);
    }
    return out;
  }

  private deliverResync(cursor: FeedCursor, reason: ResyncReason, persist: boolean): WorkspaceChange[] {
    const snapshot = this.store.snapshot();
    if (persist) {
      this.persistCursor({ consumer: this.consumer, seq: snapshot.journalSeq, head: snapshot.head, updatedAt: this.nowFn() });
    }
    if (snapshot.records.length === 0 && snapshot.journalSeq === 0 && cursor.seq === 0) return [];
    const batch = [snapshotToChange(snapshot, this.nowFn())];
    if (persist) this.hub.dispatch(batch);
    return batch;
  }

  poll(): WorkspaceChange[] {
    return this.drain(true);
  }

  peek(): WorkspaceChange[] {
    return this.drain(false);
  }

  subscribe(cb: FeedListener): () => void {
    return this.hub.subscribe(cb);
  }

  private reportError(err: Error): void {
    try {
      this.onErrorCb?.(err);
    } catch {
      /* onError must never break the feed */
    }
  }

  // -------------------------------------------------------------------------
  // start / stop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;

    this.intervalHandle = setInterval(() => {
      try {
        this.poll();
      } catch (err) {
        this.reportError(err instanceof Error ? err : new Error(String(err)));
      }
    }, this.pollMs);
    this.intervalHandle.unref?.();

    if (this.watchEnabled) {
      if (!existsSync(this.journalPath)) {
        // Nothing to watch yet (store hasn't been written to under this
        // root). The interval fallback still covers us once it appears.
      } else {
        try {
          this.watcher = fsWatch(this.journalPath, () => this.scheduleWatchPoll());
          this.watcher.on("error", (err) => {
            this.reportError(err instanceof Error ? err : new Error(String(err)));
            this.teardownWatcher();
          });
          this.watcher.unref?.();
        } catch (err) {
          // fs.watch unavailable in this sandbox/platform: degrade honestly
          // — report it, never claim to be watching, rely on the interval.
          this.watcher = undefined;
          this.reportError(
            new Error(`WorkspaceFeed: fs.watch unavailable, falling back to interval-only polling: ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      }
    }
  }

  private scheduleWatchPoll(): void {
    if (this.pendingWatchPoll) return; // coalesce a burst of fs events into one poll
    this.pendingWatchPoll = true;
    const timer = setTimeout(() => {
      this.pendingWatchPoll = false;
      try {
        this.poll();
      } catch (err) {
        this.reportError(err instanceof Error ? err : new Error(String(err)));
      }
    }, 0);
    timer.unref?.();
  }

  private teardownWatcher(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* already closed */
      }
      this.watcher = undefined;
    }
  }

  stop(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    this.teardownWatcher();
    this.pendingWatchPoll = false;
    this.started = false;
  }
}
